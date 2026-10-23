import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { WireGuardConfig } from "../shared/wireguard.js";
export type VpnRoute = { id: string; config: WireGuardConfig };
export type VpnGateway = { url: string; secret: string };
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
  const r = await fetch(new URL("/tunnels", gateway.url), {
    method: "PUT",
    headers,
    body: JSON.stringify(vpn.config),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("VPN gateway could not initialize this profile");
  return {
    async resolve(host: string): Promise<string[]> {
      const url = new URL("/resolve", gateway.url);
      url.searchParams.set("host", host);
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 409)
        throw new Error(
          "VPN connection requires closing existing sessions before using an updated profile",
        );
      if (!r.ok)
        throw new Error("VPN DNS lookup failed; check the profile DNS servers");
      return r.json();
    },
    dial(address: string, port: number): Promise<Socket> {
      return new Promise((resolve, reject) => {
        const endpoint = new URL(gateway.url);
        const target = `${address.includes(":") ? `[${address}]` : address}:${port}`;
        const request = (endpoint.protocol === "https:" ? https : http).request(
          {
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            method: "CONNECT",
            path: target,
            headers: { ...headers, host: target },
            agent: false,
          },
        );
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
            reject(
              new Error(
                "VPN connection failed; check the peer, AllowedIPs and destination",
              ),
            );
            return;
          }
          if (head.length) socket.unshift(head);
          resolve(socket);
        });
        request.end();
      });
    },
  };
}
