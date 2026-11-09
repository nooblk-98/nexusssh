import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { prepareVpn, type VpnRoute } from "../../packages/ssh-core/vpn.js";

// A stand-in gateway that counts profile uploads and can forget its tunnels,
// as the real gateway does after a restart.
let puts = 0;
let dnsRequests = 0;
const connectRequests: { id: string; target: string }[] = [];
let dnsStatuses: number[] = [],
  connectStatuses: number[] = [];
let setupStatus = 204,
  dnsStatus = 200,
  connectStatus = 200;
beforeEach(() => {
  puts = 0;
  dnsRequests = 0;
  connectRequests.length = 0;
  dnsStatuses = [];
  connectStatuses = [];
  setupStatus = 204;
  dnsStatus = 200;
  connectStatus = 200;
});
const tunnels = new Set<string>();
const server = http.createServer((req, res) => {
  const id = req.headers["x-nexus-tunnel"] as string;
  if (req.method === "PUT" && req.url === "/tunnels") {
    puts++;
    req.resume();
    req.on("end", () => {
      if (setupStatus !== 204)
        return void res
          .writeHead(setupStatus)
          .end("fixture-private-gateway-body");
      tunnels.add(id);
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/resolve")) {
    dnsRequests++;
    if (!tunnels.has(id)) return void res.writeHead(404).end();
    const status = dnsStatuses.shift() ?? dnsStatus;
    if (status !== 200)
      return void res.writeHead(status).end("fixture-private-dns-body");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(["10.0.0.5"]));
    return;
  }
  res.writeHead(404).end();
});
server.on("connect", (req, socket: net.Socket) => {
  const id = req.headers["x-nexus-tunnel"] as string;
  connectRequests.push({ id, target: req.url! });
  const status = tunnels.has(id)
    ? (connectStatuses.shift() ?? connectStatus)
    : 404;
  socket.end(
    `HTTP/1.1 ${status} Fixture\r\n\r\n` +
      (status === 200 ? "SSH-2.0-fixture\r\n" : ""),
  );
});
let gateway: { url: string; secret: string };
const route = (id: string): VpnRoute => ({
  id,
  config: {
    privateKey: "k",
    addresses: ["10.13.13.2/32"],
    dns: [],
    mtu: 1420,
    listenPort: 0,
    peers: [],
  } as any,
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  gateway = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secret: "s",
  };
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("VPN gateway client", () => {
  it("completes the first dial when the peer becomes ready after a VPN timeout", async () => {
    const tunnel = await prepareVpn(route("cold-dial"), gateway);
    connectStatuses = [502, 200];
    const socket = await tunnel.dial("10.0.0.5", 22);
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("SSH-2.0-fixture\r\n");
    expect(connectRequests).toHaveLength(2);
    expect(connectRequests[0]).toEqual(connectRequests[1]);
    // Keep the same device alive so its in-progress handshake can finish.
    expect(puts).toBe(1);
  });
  it("retries private DNS once when the peer is still warming up", async () => {
    const tunnel = await prepareVpn(route("cold-dns"), gateway);
    dnsStatuses = [502, 200];
    await expect(tunnel.resolve("db.internal")).resolves.toEqual(["10.0.0.5"]);
    expect(dnsRequests).toBe(2);
    expect(puts).toBe(1);
  });
  it("bounds retries for a persistently unreachable peer", async () => {
    const tunnel = await prepareVpn(route("offline-peer"), gateway);
    dnsStatus = connectStatus = 502;
    await expect(tunnel.resolve("db.internal")).rejects.toMatchObject({
      reason: "dns",
    });
    await expect(tunnel.dial("10.0.0.5", 22)).rejects.toMatchObject({
      reason: "connect",
    });
    expect(dnsRequests).toBe(2);
    expect(connectRequests).toHaveLength(2);
    expect(puts).toBe(1);
  });
  it("still allows bounded warm-up after recovering a forgotten tunnel", async () => {
    const tunnel = await prepareVpn(route("restarted-cold-peer"), gateway);
    tunnels.clear();
    dnsStatuses = [502, 200];
    await expect(tunnel.resolve("db.internal")).resolves.toEqual(["10.0.0.5"]);
    expect(dnsRequests).toBe(3);
    tunnels.clear();
    connectStatuses = [502, 200];
    const socket = await tunnel.dial("10.0.0.5", 22);
    socket.destroy();
    expect(connectRequests).toHaveLength(3);
    expect(puts).toBe(3);
  });
  it("does not retry policy, authentication or profile-conflict failures", async () => {
    const tunnel = await prepareVpn(route("no-retry-policy"), gateway);
    for (const status of [400, 401, 403, 409, 500, 503]) {
      connectRequests.length = 0;
      dnsRequests = 0;
      dnsStatus = connectStatus = status;
      await expect(tunnel.resolve("db.internal")).rejects.toThrow();
      await expect(tunnel.dial("10.0.0.5", 22)).rejects.toThrow();
      expect(connectRequests).toHaveLength(1);
      expect(dnsRequests).toBe(1);
    }
    expect(puts).toBe(1);
  });
  it("uploads a profile once for repeated and concurrent preparation", async () => {
    puts = 0;
    const vpn = route("profile-a");
    await Promise.all([
      prepareVpn(vpn, gateway),
      prepareVpn(vpn, gateway),
      prepareVpn(vpn, gateway),
    ]);
    await prepareVpn(vpn, gateway);
    expect(puts).toBe(1);
  });
  it("prepares again and retries when the gateway has lost the tunnel", async () => {
    const tunnel = await prepareVpn(route("profile-b"), gateway);
    tunnels.clear();
    puts = 0;
    await expect(tunnel.resolve("db.internal")).resolves.toEqual(["10.0.0.5"]);
    expect(puts).toBe(1);
    tunnels.clear();
    const socket = await tunnel.dial("10.0.0.5", 22);
    socket.destroy();
    expect(puts).toBe(2);
  });
  it("does not cache a failed preparation", async () => {
    const offline = { url: "http://127.0.0.1:1", secret: "s" };
    await expect(prepareVpn(route("profile-c"), offline)).rejects.toThrow(
      "VPN gateway is unavailable",
    );
    await expect(prepareVpn(route("profile-c"), offline)).rejects.toThrow(
      "VPN gateway is unavailable",
    );
  });
  it("classifies gateway authentication and active-profile conflicts without echoing bodies", async () => {
    for (const [status, reason] of [
      [401, "authentication"],
      [409, "in_use"],
      [400, "setup"],
    ] as const) {
      setupStatus = status;
      const error = await prepareVpn(route("setup-" + status), gateway).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({ reason });
      expect(String(error)).not.toContain("fixture-private-gateway-body");
    }
  });
  it("classifies DNS, destination policy and connection failures separately", async () => {
    const tunnel = await prepareVpn(route("distinct-errors"), gateway);
    dnsStatus = 502;
    await expect(tunnel.resolve("private.example.test")).rejects.toMatchObject({
      reason: "dns",
    });
    for (const [status, reason] of [
      [403, "allowed_ips"],
      [401, "authentication"],
      [502, "connect"],
    ] as const) {
      connectStatus = status;
      await expect(tunnel.dial("10.0.0.5", 443)).rejects.toMatchObject({
        reason,
      });
    }
  });
});
