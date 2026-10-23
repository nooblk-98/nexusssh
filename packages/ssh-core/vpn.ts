import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { WireGuardConfig } from "../shared/wireguard.js";
export type VpnRoute = { id: string; config: WireGuardConfig };
export type VpnGateway = { url: string; secret: string };
// The gateway keeps an idle tunnel for five minutes and every use refreshes it, so a
// tunnel this process prepared recently can be reused without uploading the profile
// again. A gateway restart is handled by preparing again when it reports the tunnel gone.
const PREPARED_MS = 60_000;
const prepared = new Map<string, { expires: number; ready: Promise<void> }>();
export async function prepareVpn(vpn: VpnRoute, gateway?: VpnGateway) {
  if (!gateway) throw new Error("VPN gateway is not configured");
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
        if (!r.ok)
          throw new Error("VPN gateway could not initialize this profile");
      },
      () => {
        throw new Error("VPN gateway is unavailable");
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
    return fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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
        request.destroy(new Error("VPN connection timed out")),
      );
      request.on("error", () =>
        reject(new Error("VPN gateway is unavailable")),
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
        await ensure(true);
        r = await lookup(host);
      }
      if (r.status === 409)
        throw new Error(
          "VPN connection requires closing existing sessions before using an updated profile",
        );
      if (!r.ok)
        throw new Error("VPN DNS lookup failed; check the profile DNS servers");
      return r.json();
    },
    async dial(address: string, port: number): Promise<Socket> {
      let result = await connect(address, port);
      if (result.status === 404) {
        await ensure(true);
        result = await connect(address, port);
      }
      if (!result.socket)
        throw new Error(
          "VPN connection failed; check the peer, AllowedIPs and destination",
        );
      return result.socket;
    },
  };
}
