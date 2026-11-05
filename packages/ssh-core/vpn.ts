import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { WireGuardConfig } from "../shared/wireguard.js";
export type VpnRoute = { id: string; config: WireGuardConfig };
export type VpnGateway = { url: string; secret: string };
export class VpnError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "setup"
      | "authentication"
      | "in_use"
      | "dns"
      | "allowed_ips"
      | "connect"
      | "unavailable",
  ) {
    super(message);
  }
}
// The gateway keeps an idle tunnel for five minutes and every use refreshes it, so a
// tunnel this process prepared recently can be reused without uploading the profile
// again. A gateway restart is handled by preparing again when it reports the tunnel gone.
const PREPARED_MS = 60_000;
const prepared = new Map<string, { expires: number; ready: Promise<void> }>();
export async function prepareVpn(vpn: VpnRoute, gateway?: VpnGateway) {
  if (!gateway) throw new VpnError("VPN gateway is not configured", "setup");
  const id = createHash("sha256")
    .update(vpn.id + JSON.stringify(vpn.config))
    .digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-nexus-internal": gateway.secret,
    "x-nexus-tunnel": id,
    "x-nexus-profile": createHash("sha256").update(vpn.id).digest("hex"),
  };
  const key = gateway.url + "\0" + id;
  const ensure = (force = false) => {
    const cached = prepared.get(key);
    if (!force && cached && cached.expires > Date.now()) return cached.ready;
    // Concurrent callers share one request; a failure is never cached.
    const ready = fetch(new URL("/tunnels", gateway.url), {
      method: "PUT",
      headers,
      body: JSON.stringify(vpn.config),
      signal: AbortSignal.timeout(15000),
    }).then(
      (r) => {
        if (r.status === 401)
          throw new VpnError(
            "VPN gateway rejected application authentication",
            "authentication",
          );
        if (r.status === 409)
          throw new VpnError(
            "VPN connection requires closing existing sessions before using an updated profile",
            "in_use",
          );
        if (!r.ok)
          throw new VpnError(
            "VPN gateway could not initialize this profile",
            "setup",
          );
      },
      () => {
        throw new VpnError("VPN gateway is unavailable", "unavailable");
      },
    );
    prepared.set(key, { expires: Date.now() + PREPARED_MS, ready });
    ready.catch(() => {
      if (prepared.get(key)?.ready === ready) prepared.delete(key);
    });
    return ready;
  };
  await ensure();
  const lookup = (host: string) => {
    const url = new URL("/resolve", gateway.url);
    url.searchParams.set("host", host);
    return fetch(url, { headers, signal: AbortSignal.timeout(15000) }).catch(
      () => {
        throw new VpnError(
          "VPN DNS lookup failed; check the gateway and profile DNS servers",
          "dns",
        );
      },
    );
  };
  const connect = (address: string, port: number) =>
    new Promise<{ status: number; socket?: Socket }>((resolve, reject) => {
      const endpoint = new URL(gateway.url);
      const target = `${address.includes(":") ? `[${address}]` : address}:${port}`;
      const request = (endpoint.protocol === "https:" ? https : http).request({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: "CONNECT",
        path: target,
        headers: { ...headers, host: target },
        agent: false,
      });
      request.setTimeout(20000, () =>
        request.destroy(new VpnError("VPN connection timed out", "connect")),
      );
      request.on("error", (error) =>
        reject(
          error instanceof VpnError
            ? error
            : new VpnError("VPN gateway is unavailable", "unavailable"),
        ),
      );
      request.on("connect", (response, socket, head) => {
        request.setTimeout(0);
        if (response.statusCode !== 200) {
          socket.destroy();
          resolve({ status: response.statusCode || 0 });
          return;
        }
        if (head.length) socket.unshift(head);
        resolve({ status: 200, socket });
      });
      request.end();
    });
  return {
    async resolve(host: string): Promise<string[]> {
      let r = await lookup(host);
      if (r.status === 404) {
        await r.body?.cancel();
        await ensure(true);
        r = await lookup(host);
      }
      // Device initialization does not imply a completed peer handshake. Let
      // the existing WireGuard device finish warming up before surfacing a
      // transient DNS timeout. The gateway bounds each lookup to ten seconds.
      if (r.status === 502) {
        await r.body?.cancel();
        r = await lookup(host);
      }
      if (r.status === 409)
        throw new VpnError(
          "VPN connection requires closing existing sessions before using an updated profile",
          "in_use",
        );
      if (r.status === 401)
        throw new VpnError(
          "VPN gateway rejected application authentication",
          "authentication",
        );
      if (!r.ok)
        throw new VpnError(
          "VPN DNS lookup failed; check the profile DNS servers",
          "dns",
        );
      try {
        const addresses: unknown = await r.json();
        if (
          !Array.isArray(addresses) ||
          !addresses.length ||
          addresses.length > 64 ||
          addresses.some((value) => typeof value !== "string")
        )
          throw new Error();
        return addresses as string[];
      } catch {
        throw new VpnError(
          "VPN DNS lookup failed; the gateway returned an invalid address list",
          "dns",
        );
      }
    },
    async dial(address: string, port: number): Promise<Socket> {
      let result = await connect(address, port);
      if (result.status === 404) {
        await ensure(true);
        result = await connect(address, port);
      }
      // A cold peer can take longer than the gateway's 15-second TCP budget.
      // Retry only a failed VPN dial, once, retaining its in-flight handshake.
      // Never replay SSH authentication/commands or retry policy/setup errors.
      if (result.status === 502) result = await connect(address, port);
      if (result.status === 401)
        throw new VpnError(
          "VPN gateway rejected application authentication",
          "authentication",
        );
      if (result.status === 403)
        throw new VpnError(
          "VPN destination is outside WireGuard AllowedIPs",
          "allowed_ips",
        );
      if (result.status === 409)
        throw new VpnError(
          "VPN connection requires closing existing sessions before using an updated profile",
          "in_use",
        );
      if (!result.socket)
        throw new VpnError(
          "VPN connection failed; check the peer, AllowedIPs and destination",
          "connect",
        );
      return result.socket;
    },
  };
}
