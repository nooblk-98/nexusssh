import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
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
  });
  afterAll(async () => {
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
