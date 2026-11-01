import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { createServer as createGateway } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { fingerprint } from "../../packages/ssh-core/index.js";
import type { KubernetesNetwork } from "../../packages/kubernetes/network.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { kubernetesExec } from "../../packages/kubernetes/exec.js";
import { kubernetesRequest } from "../../packages/kubernetes/client.js";
import type { ClusterConnection } from "../../packages/kubernetes/kubeconfig.js";

describe("verified Kubernetes REST mutations and pod WebSocket transport", () => {
  let directory = "",
    cert = "",
    key = "",
    endpoint = "",
    server: Server,
    sockets: WebSocketServer;
  let gateway: ReturnType<typeof createGateway>, jump: ssh2.Server;
  let gatewayURL = "",
    jumpPort = 0,
    jumpFingerprint = "";
  const forwards: string[] = [],
    connects: string[] = [];
  const lookups: string[] = [];
  const openSockets = new Set<Socket>();
  const sshClients = new Set<ssh2.Connection>();
  const track = (socket: Socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    return socket;
  };
  const network = (vpn = true, bastion = false): KubernetesNetwork => ({
    ...(vpn
      ? {
          vpn: {
            id: "k8s-route-fixture",
            config: {
              privateKey: "test-private",
              addresses: ["10.77.0.2/32"],
              dns: ["10.77.0.1"],
              mtu: 1420,
              peers: [],
            },
          },
        }
      : {}),
    ...(bastion
      ? {
          bastion: {
            host: vpn ? "10.77.0.6" : "127.0.0.1",
            port: jumpPort,
            username: "jump",
            fingerprint: jumpFingerprint,
            fileRoot: "/home",
            credential: { password: "fixture-jump-password" },
          },
        }
      : {}),
    sshLimits: {
      cidrs: ["127.0.0.1/32", "10.77.0.6/32"],
      connectTimeout: 1500,
      outputLimit: 262144,
      vpnGateway: { url: gatewayURL, secret: "fixture-gateway-secret" },
    },
  });
  const privateConnection = (): ClusterConnection => ({
    ...connection(),
    server: connection().server.replace("127.0.0.1", "cluster.internal.test"),
  });
  const seen: {
    path: string;
    host?: string;
    authorization?: string;
    protocol?: string;
    method?: string;
    body?: string;
    contentType?: string;
  }[] = [];
  const connection = (): ClusterConnection => ({
    server: endpoint + "/proxy/local",
    context: "fixture",
    namespace: "apps",
    authentication: "token",
    token: "fixture-token",
    ca: cert,
    tlsServerName: "cluster.example.test",
  });
  const args = (mode = "ok") => ({
    namespace: "apps",
    pod: "api-1",
    container: "api",
    command: [mode, "space and & ? ; symbols"],
    timeoutMs: 3000,
  });
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "nexus-k8s-exec-"));
    const openssl =
      process.platform === "win32"
        ? "C:/Program Files/Git/usr/bin/openssl.exe"
        : "openssl";
    execFileSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=cluster.example.test",
        "-addext",
        "subjectAltName=DNS:cluster.example.test,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    cert = readFileSync(join(directory, "cert.pem"), "utf8");
    key = readFileSync(join(directory, "key.pem"), "utf8");
    server = createServer({ cert, key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          path: req.url!,
          host: req.headers.host,
          authorization: req.headers.authorization,
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          contentType: req.headers["content-type"],
        });
        res.setHeader("Content-Type", "application/json");
        res.end('{"kind":"Scale","spec":{"replicas":3}}');
      });
    });
    sockets = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has("v5.channel.k8s.io")
          ? "v5.channel.k8s.io"
          : "v4.channel.k8s.io",
    });
    server.on("upgrade", (req, socket, head) => {
      seen.push({
        path: req.url!,
        host: req.headers.host,
        authorization: req.headers.authorization,
        protocol: req.headers["sec-websocket-protocol"],
      });
      const mode = new URL(
        req.url!,
        "https://fixture.test",
      ).searchParams.getAll("command")[0];
      if (mode === "denied") {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (mode === "redirect") {
        socket.end(
          "HTTP/1.1 302 Found\r\nLocation: https://evil.invalid\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const send = (channel: number, data: string) =>
          ws.send(Buffer.concat([Buffer.from([channel]), Buffer.from(data)]));
        if (mode === "wait") return;
        if (mode === "lost") {
          ws.close();
          return;
        }
        send(1, mode === "large" ? "x".repeat(300_000) : "stdout\n");
        send(2, "stderr\n");
        send(
          3,
          JSON.stringify(
            mode === "nonzero"
              ? {
                  status: "Failure",
                  reason: "NonZeroExitCode",
                  details: { causes: [{ reason: "ExitCode", message: "7" }] },
                }
              : { status: "Success" },
          ),
        );
        ws.close();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hostKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const parsed = ssh2.utils.parseKey(hostKey);
    if (parsed instanceof Error || Array.isArray(parsed))
      throw new Error("Invalid fixture SSH key");
    jumpFingerprint = fingerprint(parsed.getPublicSSH());
    jump = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      sshClients.add(client);
      client.once("close", () => sshClients.delete(client));
      client.on("error", () => {});
      client.on("authentication", (ctx) =>
        ctx.method === "password" &&
        ctx.username === "jump" &&
        ctx.password === "fixture-jump-password"
          ? ctx.accept()
          : ctx.reject(),
      );
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          lookups.push(info.command);
          const stream = accept();
          const addresses: Record<string, string> = {
            "getent ahosts 'bastion-private.invalid'": "10.77.0.5",
            "getent ahosts 'bastion-metadata.invalid'": "169.254.169.254",
            "getent ahosts 'bastion-outside.invalid'": "203.0.113.9",
          };
          const address = addresses[info.command];
          if (!address) {
            stream.stderr.write("fixture-private-error-never-return");
            stream.exit(2);
            stream.end();
            return;
          }
          stream.write(`${address} STREAM fixture\n${address} DGRAM fixture\n`);
          stream.exit(0);
          stream.end();
        });
      });
      client.on("ready", () =>
        client.on("tcpip", (accept, reject, info) => {
          forwards.push(`${info.destIP}:${info.destPort}`);
          if (
            !["127.0.0.1", "10.77.0.5"].includes(info.destIP) ||
            info.destPort !== (server.address() as AddressInfo).port
          ) {
            reject();
            return;
          }
          const outbound = track(
            tcpConnect({ host: "127.0.0.1", port: info.destPort }),
          );
          outbound.on("connect", () => {
            const channel = accept();
            if (!channel) return outbound.destroy();
            channel.pipe(outbound).pipe(channel);
            channel.on("error", () => outbound.destroy());
            channel.on("close", () => outbound.destroy());
            outbound.on("close", () => channel.destroy());
          });
          outbound.on("error", () => {
            reject();
            outbound.destroy();
          });
        }),
      );
    });
    await new Promise<void>((done) => jump.listen(0, "127.0.0.1", done));
    jumpPort = (jump.address() as AddressInfo).port;
    gateway = createGateway((req, res) => {
      if (req.headers["x-nexus-internal"] !== "fixture-gateway-secret")
        return void res.writeHead(401).end();
      if (req.method === "PUT" && req.url === "/tunnels") {
        req.resume();
        req.on("end", () => res.writeHead(204).end());
        return;
      }
      const host = new URL(req.url!, "http://fixture.test").searchParams.get(
        "host",
      );
      if (host === "vpn-dns-failure.invalid")
        return void res.writeHead(502).end("fixture-private-gateway-error");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          host === "cluster.internal.test"
            ? "10.77.0.5"
            : host === "vpn-outside.invalid"
              ? "10.77.0.7"
              : host === "metadata.internal.test"
                ? "169.254.169.254"
                : host,
        ]),
      );
    });
    gateway.on("connect", (req, raw, head) => {
      const socket = track(raw as Socket);
      connects.push(req.url!);
      const [address, port] = req.url!.split(":");
      if (
        req.headers["x-nexus-internal"] !== "fixture-gateway-secret" ||
        !["10.77.0.5", "10.77.0.6"].includes(address)
      )
        return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      const outbound = track(
        tcpConnect({ host: "127.0.0.1", port: Number(port) }),
      );
      outbound.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) outbound.write(head);
        socket.pipe(outbound).pipe(socket);
      });
      outbound.on("error", () => socket.destroy());
      socket.on("error", () => outbound.destroy());
      socket.on("close", () => outbound.destroy());
      outbound.on("close", () => socket.destroy());
    });
    await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
    gatewayURL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const socket of openSockets) socket.destroy();
    for (const client of sshClients) client.end();
    await new Promise<void>((done) => gateway?.close(() => done()));
    await new Promise<void>((done) => jump?.close(() => done()));
    for (const socket of sockets?.clients || []) socket.terminate();
    await new Promise<void>((done) => sockets?.close(() => done()));
    await new Promise<void>((done) => server?.close(() => done()));
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes("nexus-k8s-exec-")
    )
      rmSync(directory, { recursive: true, force: true });
  });
  it("sends method/body/content type to the verified pinned endpoint with its API base path", async () => {
    await expect(
      kubernetesRequest(
        connection(),
        "/apis/apps/v1/namespaces/apps/deployments/api/scale",
        ["127.0.0.1/32"],
        false,
        {
          method: "PATCH",
          body: '{"spec":{"replicas":3}}',
          contentType: "application/merge-patch+json",
        },
      ),
    ).resolves.toMatchObject({ spec: { replicas: 3 } });
    expect(seen.at(-1)).toMatchObject({
      path: "/proxy/local/apis/apps/v1/namespaces/apps/deployments/api/scale",
      method: "PATCH",
      authorization: "Bearer fixture-token",
      body: '{"spec":{"replicas":3}}',
      contentType: "application/merge-patch+json",
    });
  });
  it("routes verified HTTPS reads and pod WebSockets through the saved WireGuard gateway", async () => {
    const route = network();
    await expect(
      kubernetesRequest(
        privateConnection(),
        "/version",
        ["10.77.0.5/32"],
        false,
        { route },
      ),
    ).resolves.toHaveProperty("kind", "Scale");
    expect(connects.at(-1)).toBe(
      `10.77.0.5:${(server.address() as AddressInfo).port}`,
    );
    expect(seen.at(-1)?.host).toContain("cluster.internal.test");
    expect(
      await kubernetesExec(
        privateConnection(),
        args(),
        ["10.77.0.5/32"],
        undefined,
        route,
      ),
    ).toMatchObject({ exitCode: 0, stdout: "stdout\n" });
  });
  it("routes API calls through a verified SSH bastion, including a bastion reached through WireGuard", async () => {
    await kubernetesRequest(connection(), "/version", ["127.0.0.1/32"], false, {
      route: network(false, true),
    });
    expect(forwards.at(-1)).toBe(
      `127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const route = network(true, true),
      count = connects.length;
    await kubernetesRequest(
      privateConnection(),
      "/version",
      ["10.77.0.5/32"],
      false,
      { route },
    );
    expect(connects.slice(count)).toEqual([`10.77.0.6:${jumpPort}`]);
    expect(forwards.at(-1)).toBe(
      `10.77.0.5:${(server.address() as AddressInfo).port}`,
    );
    expect(
      await kubernetesExec(
        privateConnection(),
        args(),
        ["10.77.0.5/32"],
        undefined,
        route,
      ),
    ).toMatchObject({ exitCode: 0 });
  });
  it("uses bastion DNS for private API hostnames while preserving Host, TLS and WebSockets", async () => {
    const connectionThroughBastion = {
      ...privateConnection(),
      server: privateConnection().server.replace(
        "cluster.internal.test",
        "bastion-private.invalid",
      ),
    };
    await kubernetesRequest(
      connectionThroughBastion,
      "/version",
      ["10.77.0.5/32"],
      false,
      { route: network(false, true) },
    );
    expect(lookups.at(-1)).toBe("getent ahosts 'bastion-private.invalid'");
    expect(forwards.at(-1)).toBe(
      `10.77.0.5:${(server.address() as AddressInfo).port}`,
    );
    expect(seen.at(-1)?.host).toContain("bastion-private.invalid");
    expect(
      await kubernetesExec(
        connectionThroughBastion,
        { ...args(), timeoutMs: 10000 },
        ["10.77.0.5/32"],
        undefined,
        network(false, true),
      ),
    ).toMatchObject({ exitCode: 0 });
  });
  it("blocks metadata and disallowed IPs returned by bastion DNS without returning remote stderr", async () => {
    const count = forwards.length;
    for (const [host, pattern, cidrs] of [
      ["bastion-metadata.invalid", /metadata/, ["0.0.0.0/0"]],
      [
        "bastion-outside.invalid",
        /203\.0\.113\.9.*KUBERNETES_ALLOWED_CIDRS/,
        ["10.77.0.5/32"],
      ],
      [
        "bastion-missing.invalid",
        /bastion could not resolve/,
        ["10.77.0.5/32"],
      ],
    ] as const) {
      await expect(
        kubernetesRequest(
          {
            ...privateConnection(),
            server: privateConnection().server.replace(
              "cluster.internal.test",
              host,
            ),
          },
          "/version",
          [...cidrs],
          false,
          { route: network(false, true) },
        ),
      ).rejects.toThrow(pattern);
    }
    expect(forwards).toHaveLength(count);
  });
  it("distinguishes WireGuard AllowedIPs and DNS failures without exposing gateway responses", async () => {
    const reads = seen.length;
    await expect(
      kubernetesRequest(
        {
          ...privateConnection(),
          server: privateConnection().server.replace(
            "cluster.internal.test",
            "vpn-outside.invalid",
          ),
        },
        "/version",
        ["10.77.0.7/32"],
        false,
        { route: network() },
      ),
    ).rejects.toThrow(/WireGuard profile's AllowedIPs/);
    const error = await kubernetesRequest(
      {
        ...privateConnection(),
        server: privateConnection().server.replace(
          "cluster.internal.test",
          "vpn-dns-failure.invalid",
        ),
      },
      "/version",
      ["10.77.0.5/32"],
      false,
      { route: network() },
    ).catch((error: unknown) => error);
    expect(String(error)).toMatch(/DNS lookup through WireGuard failed/);
    expect(String(error)).not.toContain("fixture-private-gateway-error");
    expect(seen).toHaveLength(reads);
  });
  it("identifies SSH authentication and forwarding failures separately", async () => {
    const route = network(false, true);
    route.bastion!.credential.password = "wrong-fixture-password";
    await expect(
      kubernetesRequest(connection(), "/version", ["127.0.0.1/32"], false, {
        route,
      }),
    ).rejects.toThrow(/Bastion SSH authentication failed/);
    const target = new URL(connection().server);
    target.port = String((server.address() as AddressInfo).port + 1);
    await expect(
      kubernetesRequest(
        { ...connection(), server: target.toString().replace(/\/$/, "") },
        "/version",
        ["127.0.0.1/32"],
        false,
        { route: network(false, true) },
      ),
    ).rejects.toThrow(/bastion connected but could not forward/);
  });
  it("enforces target and bastion allowlists, host keys and TLS without direct fallback", async () => {
    const before = connects.length;
    await expect(
      kubernetesRequest(
        {
          ...privateConnection(),
          server: privateConnection().server.replace(
            "cluster.internal.test",
            "metadata.internal.test",
          ),
        },
        "/version",
        ["0.0.0.0/0"],
        false,
        { route: network() },
      ),
    ).rejects.toThrow(/metadata/);
    expect(connects).toHaveLength(before);
    const denied = network(true, true);
    denied.sshLimits.cidrs = ["127.0.0.1/32"];
    await expect(
      kubernetesRequest(
        privateConnection(),
        "/version",
        ["10.77.0.5/32"],
        false,
        { route: denied },
      ),
    ).rejects.toThrow(/SSH destination allowlist/);
    expect(connects).toHaveLength(before);
    const wrongKey = network(false, true);
    wrongKey.bastion!.fingerprint = "SHA256:wrong";
    await expect(
      kubernetesRequest(connection(), "/version", ["127.0.0.1/32"], false, {
        route: wrongKey,
      }),
    ).rejects.toThrow(/host key/);
    const reads = seen.length;
    await expect(
      kubernetesRequest(
        { ...privateConnection(), tlsServerName: "wrong.invalid" },
        "/version",
        ["10.77.0.5/32"],
        false,
        { route: network() },
      ),
    ).rejects.toThrow(/TLS certificates/);
    expect(seen).toHaveLength(reads);
  });
  it("preserves argv, original Host/TLS identity, namespace, container and base path", async () => {
    expect(
      await kubernetesExec(connection(), args(), ["127.0.0.1/32"]),
    ).toEqual({
      stdout: "stdout\n",
      stderr: "stderr\n",
      exitCode: 0,
      truncated: false,
    });
    const request = seen.at(-1)!;
    expect(request.host).toBe(new URL(endpoint).host);
    expect(request.authorization).toBe("Bearer fixture-token");
    const url = new URL(request.path, endpoint);
    expect(url.pathname).toBe(
      "/proxy/local/api/v1/namespaces/apps/pods/api-1/exec",
    );
    expect(url.searchParams.getAll("command")).toEqual(args().command);
    expect(url.searchParams.get("stdin")).toBe("false");
    expect(url.searchParams.get("tty")).toBe("false");
    expect(url.searchParams.get("container")).toBe("api");
    expect(request.protocol).toContain("v5.channel.k8s.io");
  });
  it("returns nonzero exit status and bounds combined output", async () => {
    expect(
      await kubernetesExec(connection(), args("nonzero"), ["127.0.0.1/32"]),
    ).toMatchObject({ exitCode: 7 });
    const result = await kubernetesExec(connection(), args("large"), [
      "127.0.0.1/32",
    ]);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(256 * 1024);
  });
  it("reports unknown outcome for missing status, cancellation and timeout", async () => {
    await expect(
      kubernetesExec(connection(), args("lost"), ["127.0.0.1/32"]),
    ).rejects.toThrow(/without an exit status/);
    await expect(
      kubernetesExec(connection(), { ...args("wait"), timeoutMs: 150 }, [
        "127.0.0.1/32",
      ]),
    ).rejects.toThrow(/interrupted/);
    const cancellation = new AbortController();
    const pending = kubernetesExec(
      connection(),
      args("wait"),
      ["127.0.0.1/32"],
      cancellation.signal,
    );
    setTimeout(() => cancellation.abort(), 100);
    await expect(pending).rejects.toThrow(/interrupted/);
  });
  it("rejects denied upgrades/redirects, untrusted TLS and disallowed destinations", async () => {
    await expect(
      kubernetesExec(connection(), args("denied"), ["127.0.0.1/32"]),
    ).rejects.toThrow(/403/);
    await expect(
      kubernetesExec(connection(), args("redirect"), ["127.0.0.1/32"]),
    ).rejects.toThrow(/302/);
    await expect(
      kubernetesExec({ ...connection(), ca: undefined }, args(), [
        "127.0.0.1/32",
      ]),
    ).rejects.toThrow(/connection failed/);
    await expect(
      kubernetesExec(
        { ...connection(), tlsServerName: "evil.invalid" },
        args(),
        ["127.0.0.1/32"],
      ),
    ).rejects.toThrow(/connection failed/);
    await expect(
      kubernetesExec(connection(), args(), ["10.0.0.0/8"]),
    ).rejects.toThrow(/ALLOWED_CIDRS/);
  });
});
