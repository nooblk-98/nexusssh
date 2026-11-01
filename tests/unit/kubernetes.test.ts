import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  kubeconfigContexts,
  parseKubeconfig,
  type ClusterConnection,
} from "../../packages/kubernetes/kubeconfig.js";
import { kubernetesRequest } from "../../packages/kubernetes/client.js";
import {
  resourcePath,
  summarizeResource,
} from "../../packages/kubernetes/resources.js";

const config = () => ({
  apiVersion: "v1",
  kind: "Config",
  "current-context": "development",
  clusters: [
    { name: "api", cluster: { server: "https://cluster.example.test:6443" } },
  ],
  users: [{ name: "reader", user: { token: "fixture-token" } }],
  contexts: [
    {
      name: "development",
      context: { cluster: "api", user: "reader", namespace: "apps" },
    },
    {
      name: "production",
      context: { cluster: "api", user: "reader", namespace: "production" },
    },
  ],
});

describe("kubeconfig import", () => {
  it("selects the requested context and previews only non-secret metadata", () => {
    const source = JSON.stringify(config());
    expect(parseKubeconfig(source)).toMatchObject({
      context: "development",
      namespace: "apps",
      token: "fixture-token",
    });
    expect(parseKubeconfig(source, "production").namespace).toBe("production");
    expect(JSON.stringify(kubeconfigContexts(source))).not.toContain(
      "fixture-token",
    );
    expect(kubeconfigContexts(source).contexts).toHaveLength(2);
  });
  it("reads YAML and defaults a single context to the default namespace", () => {
    const source =
      "apiVersion: v1\nkind: Config\nclusters:\n- name: api\n  cluster:\n    server: https://cluster.example.test\nusers:\n- name: reader\n  user:\n    token: fixture-token\ncontexts:\n- name: only\n  context:\n    cluster: api\n    user: reader\n";
    expect(parseKubeconfig(source)).toMatchObject({
      context: "only",
      namespace: "default",
    });
  });
  it.each([
    "exec",
    "auth-provider",
    "tokenFile",
    "client-key",
    "client-certificate",
    "as",
  ])("rejects credential plugin/file/impersonation field %s", (field) => {
    const data = config();
    Object.assign(data.users[0].user, {
      [field]: field === "exec" ? { command: "do-not-execute" } : "do-not-read",
    });
    expect(() => parseKubeconfig(JSON.stringify(data))).toThrow(
      /not supported/,
    );
  });
  it.each([
    "http://cluster.example.test",
    "https://user:secret@cluster.example.test",
    "https://cluster.example.test?token=secret",
    "https://cluster.example.test/#secret",
  ])("rejects unsafe endpoint %s", (server) => {
    const data = config();
    data.clusters[0].cluster.server = server;
    expect(() => parseKubeconfig(JSON.stringify(data))).toThrow(/HTTPS URL/);
  });
  it("rejects disabled TLS, file CAs, proxy URLs, and malformed inline credentials", () => {
    for (const patch of [
      { "insecure-skip-tls-verify": true },
      { "certificate-authority": "/etc/secret" },
      { "proxy-url": "http://proxy.invalid" },
      { "certificate-authority-data": "not-base64!" },
      {
        "certificate-authority-data":
          Buffer.from("not a certificate").toString("base64"),
      },
    ]) {
      const data = config();
      Object.assign(data.clusters[0].cluster, patch);
      expect(() => parseKubeconfig(JSON.stringify(data))).toThrow();
    }
    const data = config();
    data.users[0].user.token = "token\r\nInjected: secret";
    expect(() => parseKubeconfig(JSON.stringify(data))).toThrow(/bearer token/);
  });
  it("rejects duplicate entries, aliases, custom tags, ambiguous/missing contexts, and oversized files", () => {
    const duplicate = config();
    duplicate.users.push(duplicate.users[0]);
    expect(() => parseKubeconfig(JSON.stringify(duplicate))).toThrow(
      /uniquely named/,
    );
    expect(() => parseKubeconfig("a: &a secret\nb: *a")).toThrow(
      /Invalid kubeconfig/,
    );
    expect(() => parseKubeconfig("!!js/function secret")).toThrow(
      /Invalid kubeconfig/,
    );
    const ambiguous = config();
    delete (ambiguous as any)["current-context"];
    expect(() => parseKubeconfig(JSON.stringify(ambiguous))).toThrow(
      /Choose a context/,
    );
    expect(() => parseKubeconfig(JSON.stringify(config()), "missing")).toThrow(
      /Choose a context/,
    );
    expect(() => parseKubeconfig("x".repeat(256 * 1024 + 1))).toThrow(/256 KB/);
  });
});

describe("Kubernetes resource boundaries", () => {
  it("builds paginated, scoped resource paths without treating cursors as URL parameters", () => {
    const path = resourcePath(
      "pods",
      "production",
      "opaque&token=do-not-inject",
    );
    const url = new URL(path, "https://cluster.example.test");
    expect(url.pathname).toBe("/api/v1/namespaces/production/pods");
    expect(url.searchParams.get("continue")).toBe("opaque&token=do-not-inject");
    expect(url.searchParams.has("token")).toBe(false);
    expect(resourcePath("deployments", "*")).toBe(
      "/apis/apps/v1/deployments?limit=100",
    );
    expect(resourcePath("nodes", "ignored")).toBe("/api/v1/nodes?limit=100");
  });
  it("returns bounded pod summaries without environment variables or credential-bearing specs", () => {
    const summary = summarizeResource("pods", {
      metadata: { name: "api-1", namespace: "apps", uid: "pod-1" },
      spec: {
        nodeName: "worker-1",
        containers: [
          {
            name: "api",
            image: "app:v1",
            env: [{ name: "SECRET", value: "do-not-expose" }],
          },
        ],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "api",
            ready: false,
            restartCount: 3,
            state: { waiting: { reason: "CrashLoopBackOff" } },
          },
        ],
      },
    });
    expect(summary).toMatchObject({
      name: "api-1",
      ready: "0/1",
      status: "CrashLoopBackOff",
      restarts: 3,
      containers: [{ name: "api", image: "app:v1" }],
    });
    expect(JSON.stringify(summary)).not.toContain("do-not-expose");
  });
});

describe("direct Kubernetes HTTPS transport", () => {
  let directory: string,
    cert: string,
    key: string,
    server: Server,
    endpoint: string;
  const seen: { url: string; authorization?: string }[] = [];
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "nexus-kubernetes-"));
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
    server = createServer(
      { cert, key, ca: cert, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        seen.push({ url: req.url!, authorization: req.headers.authorization });
        if (req.url === "/redirect")
          return void res
            .writeHead(302, { location: "https://elsewhere.invalid/steal" })
            .end();
        if (req.url === "/forbidden")
          return void res.writeHead(403).end("fixture-secret-do-not-echo");
        if (req.url === "/large") return void res.end("x".repeat(300_000));
        if (req.url === "/huge")
          return void res.end("x".repeat(3 * 1024 * 1024));
        if (req.url === "/invalid")
          return void res.end("private-invalid-json-secret");
        if (req.url === "/logs")
          return void res.end("2026-11-01 app started\n");
        if (req.url === "/certificate" && !(req.socket as TLSSocket).authorized)
          return void res.writeHead(403).end();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ gitVersion: "v1.34.0" }));
      },
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes("nexus-kubernetes-")
    )
      rmSync(directory, { recursive: true, force: true });
  });
  const connection = (): ClusterConnection => ({
    server: endpoint,
    context: "fixture",
    namespace: "default",
    authentication: "token",
    token: "fixture-token",
    ca: cert,
  });
  it("verifies TLS and sends the bearer token to the pinned API address", async () => {
    await expect(
      kubernetesRequest(connection(), "/version", ["127.0.0.1/32"]),
    ).resolves.toEqual({ gitVersion: "v1.34.0" });
    expect(seen.at(-1)).toEqual({
      url: "/version",
      authorization: "Bearer fixture-token",
    });
  });
  it("supports a verified TLS server-name override and an API base path", async () => {
    await kubernetesRequest(
      {
        ...connection(),
        server: endpoint + "/proxy/clusters/local",
        tlsServerName: "cluster.example.test",
      },
      "/version",
      ["127.0.0.1/32"],
    );
    expect(seen.at(-1)?.url).toBe("/proxy/clusters/local/version");
  });
  it("authenticates with an embedded client certificate and key", async () => {
    const data = config();
    data.clusters[0].cluster.server = endpoint;
    Object.assign(data.clusters[0].cluster, {
      "certificate-authority-data": Buffer.from(cert).toString("base64"),
    });
    (data.users[0] as any).user = {
      "client-certificate-data": Buffer.from(cert).toString("base64"),
      "client-key-data": Buffer.from(key).toString("base64"),
    };
    const parsed = parseKubeconfig(JSON.stringify(data));
    await expect(
      kubernetesRequest(parsed, "/certificate", ["127.0.0.1/32"]),
    ).resolves.toHaveProperty("gitVersion");
    expect(seen.at(-1)?.authorization).toBeUndefined();
  });
  it("rejects untrusted certificates, hostname mismatches, and disallowed/metadata destinations", async () => {
    await expect(
      kubernetesRequest({ ...connection(), ca: undefined }, "/version", [
        "127.0.0.1/32",
      ]),
    ).rejects.toThrow(/TLS certificates/);
    await expect(
      kubernetesRequest(
        { ...connection(), tlsServerName: "wrong.invalid" },
        "/version",
        ["127.0.0.1/32"],
      ),
    ).rejects.toThrow(/TLS certificates/);
    await expect(
      kubernetesRequest(connection(), "/version", ["10.0.0.0/8"]),
    ).rejects.toThrow(/KUBERNETES_ALLOWED_CIDRS/);
    await expect(
      kubernetesRequest(
        { ...connection(), server: "https://169.254.169.254" },
        "/version",
        ["0.0.0.0/0"],
      ),
    ).rejects.toThrow(/KUBERNETES_ALLOWED_CIDRS/);
  });
  it("does not follow redirects or return remote error bodies", async () => {
    const before = seen.length;
    await expect(
      kubernetesRequest(connection(), "/redirect", ["127.0.0.1/32"]),
    ).rejects.toThrow(/redirected/);
    expect(seen.length).toBe(before + 1);
    await expect(
      kubernetesRequest(connection(), "/forbidden", ["127.0.0.1/32"]),
    ).rejects.toThrow(
      "The kubeconfig identity does not have permission for this Kubernetes resource.",
    );
    await expect(
      kubernetesRequest(connection(), "/invalid", ["127.0.0.1/32"]),
    ).rejects.toThrow("The Kubernetes API returned invalid JSON.");
  });
  it("reads logs and clips oversized log responses at the output bound", async () => {
    await expect(
      kubernetesRequest(connection(), "/logs", ["127.0.0.1/32"], true),
    ).resolves.toMatchObject({
      content: "2026-11-01 app started\n",
      truncated: false,
    });
    const clipped = await kubernetesRequest(
      connection(),
      "/large",
      ["127.0.0.1/32"],
      true,
    );
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(clipped.content)).toBe(256 * 1024);
    await expect(
      kubernetesRequest(connection(), "/huge", ["127.0.0.1/32"]),
    ).rejects.toThrow(/too large/);
  });
});
