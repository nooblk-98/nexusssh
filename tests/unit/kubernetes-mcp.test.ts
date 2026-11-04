import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { kubernetesOperations } from "../../packages/kubernetes/policy.js";
let api: Server, child: ChildProcess, client: Client;
const received: { path: string; args: any }[] = [];
const clusterId = "c074ce87-e874-4e60-bbd6-ea6dc51c4ff9";
beforeAll(async () => {
  api = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (
      req.headers.authorization !== "Bearer fixture-mcp-token" ||
      ((req.url?.startsWith("/api/operations/") ||
        req.url === "/api/internal/auth") &&
        req.headers["x-nexus-internal"] !== "a".repeat(64))
    )
      return void res.writeHead(401).end("{}");
    if (req.url === "/api/internal/auth") return void res.end("{}");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const args = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ path: req.url!, args });
      if (["/api/kubernetes/clusters", "/api/identities"].includes(req.url!))
        return void res.end(JSON.stringify({ id: clusterId, name: args.name }));
      res.end(
        JSON.stringify(
          req.url!.endsWith("kubernetes_clusters_list")
            ? { clusters: [{ id: clusterId, name: "Fixture" }] }
            : {
                  status: "completed",
                  result: { stdout: "uid=1000", stderr: "", exitCode: 0 },
                },
        ),
      );
    });
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const reserve = createServer();
  await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>((done) => reserve.close(() => done()));
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  child = spawn(process.execPath, ["--import", "tsx", "apps/mcp/src/main.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "file:unused.db",
      REDIS_URL: "redis://127.0.0.1:6379",
      ENCRYPTION_KEY: "ab".repeat(32),
      SESSION_SECRET: "s".repeat(64),
      INTERNAL_SECRET: "a".repeat(64),
      SETUP_TOKEN: "t".repeat(64),
      APP_URL: base,
      MCP_PUBLIC_URL: base + "/mcp",
      MCP_AUTH_ISSUER: base,
      SSH_ALLOWED_CIDRS: "127.0.0.1/32",
      MCP_PORT: String(port),
      INTERNAL_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      SECRETS_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (value) => (logs += value.toString()));
  child.stderr?.on("data", (value) => (logs += value.toString()));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  expect(ready, logs).toBe(true);
  client = new Client({ name: "kubernetes-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer fixture-mcp-token" } },
    }),
  );
});
it("forwards write-only SSH and Kubernetes credential submissions through management tools", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools.some((tool) => tool.name === "kubernetes_cluster_create")).toBe(
    true,
  );
  const kubeconfig = "private-uploaded-kubeconfig-text";
  const routing = {
    groupId: "6f10fcb6-ae11-442a-b872-df1595118588",
    vpnProfileId: "8f6975c2-4c71-41ea-9532-7a5e552e6279",
    bastionId: "237b731e-9d63-42ea-9b47-0241277f3383",
  };
  const result: any = await client.callTool({
    name: "kubernetes_cluster_create",
    arguments: { name: "Imported", kubeconfig, ...routing },
  });
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toEqual({ id: clusterId, name: "Imported" });
  expect(JSON.stringify(result)).not.toContain(kubeconfig);
  expect(received.at(-1)).toEqual({
    path: "/api/kubernetes/clusters",
    args: { name: "Imported", kubeconfig, ...routing },
  });
  const identity: any = await client.callTool({
    name: "identity_create",
    arguments: {
      name: "Key",
      kind: "key",
      privateKey: "private-uploaded-ssh-key",
    },
  });
  expect(identity.structuredContent).toEqual({ id: clusterId, name: "Key" });
  expect(JSON.stringify(identity)).not.toContain("private-uploaded-ssh-key");
});
afterAll(async () => {
  await client?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    child.kill();
    await exited;
  }
  api?.closeAllConnections();
  await new Promise<void>((done) => api?.close(() => done()));
});
it("advertises direct Kubernetes tools and forwards both command forms with the original bearer token", async () => {
  const tools = (await client.listTools()).tools;
  expect(
    kubernetesOperations.every((op) => tools.some((tool) => tool.name === op)),
  ).toBe(true);
  expect(
    tools.find((tool) => tool.name === "kubernetes_pod_exec")?.annotations
      ?.readOnlyHint,
  ).toBe(false);
  const list: any = await client.callTool({
    name: "kubernetes_clusters_list",
    arguments: {},
  });
  expect(list.structuredContent.clusters[0].id).toBe(clusterId);
  for (const [name, args] of [
    [
      "kubernetes_execute",
      { clusterId, command: ["get", "pods", "-n", "apps"] },
    ],
    [
      "kubernetes_pod_exec",
      {
        clusterId,
        namespace: "apps",
        pod: "api-1",
        container: "api",
        command: ["sh", "-lc", "id"],
      },
    ],
  ] as const) {
    const completed: any = await client.callTool({name, arguments: args});
    expect(completed.isError).toBe(false);
    expect(completed.structuredContent).toMatchObject({
      status: "completed",
      result: { exitCode: 0 },
    });
    expect(received.at(-1)).toMatchObject({
      path: "/api/operations/" + name,
      args: { ...args, timeoutMs: 30000 },
    });
  }
  const before = received.length;
  const invalid: any = await client.callTool({
    name: "kubernetes_pod_exec",
    arguments: { clusterId, command: ["id"] },
  });
  expect(invalid.isError).toBe(true);
  expect(received).toHaveLength(before);
});
