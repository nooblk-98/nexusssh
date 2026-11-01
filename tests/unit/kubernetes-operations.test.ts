import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { hash, seal, unseal } from "../../packages/shared/crypto.js";
import type { Request } from "express";
import type { Principal } from "../../packages/policy-engine/index.js";
import { kubernetesOperations } from "../../packages/kubernetes/policy.js";
const fixture = vi.hoisted(() => ({
  db: undefined as unknown as PrismaClient,
  request: vi.fn(),
  exec: vi.fn(),
  key: "ab".repeat(32),
}));
vi.mock("../../packages/database/index.js", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = (fixture.db as any)[key];
        return typeof value === "function" ? value.bind(fixture.db) : value;
      },
    },
  ),
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: {
    ENCRYPTION_KEY: fixture.key,
    MCP_AUTH_ISSUER: "issuer",
    KUBERNETES_ALLOWED_CIDRS: "127.0.0.1/32",
    AUDIT_RETENTION_DAYS: 90,
    SSH_ALLOWED_CIDRS: "127.0.0.1/32",
    SSH_CONNECT_TIMEOUT: 1000,
    SSH_OUTPUT_LIMIT: 262144,
    VPN_GATEWAY_URL: "http://127.0.0.1:3003",
    INTERNAL_SECRET: "fixture-gateway-secret",
  },
  mcpAudience: "audience",
  mcpEndpoint: () => "https://fixture.test/mcp",
  publicOrigin: () => "https://fixture.test",
}));
// These tests exercise the real controller, auth and database without starting
// unrelated SSH queues, health workers or SFTP sessions.
vi.mock("../../apps/api/src/domain.js", () => ({ audit: vi.fn() }));
vi.mock("../../apps/api/src/health.js", () => ({
  enqueueHealthBatch: vi.fn(),
}));
vi.mock("../../apps/api/src/sftp.js", () => ({ closeSftp: vi.fn() }));
vi.mock("../../packages/kubernetes/client.js", async (original) => ({
  ...(await original<typeof import("../../packages/kubernetes/client.js")>()),
  kubernetesRequest: fixture.request,
}));
vi.mock("../../packages/kubernetes/exec.js", () => ({
  kubernetesExec: fixture.exec,
}));
import {
  kubernetesOperation,
  kubernetesApprovalStatus,
  kubernetesApprovals,
  recoverKubernetesExecutions,
  expireKubernetesResults,
} from "../../apps/api/src/kubernetes-operations.js";
import { AppController } from "../../apps/api/src/controller.js";
import { KubernetesController } from "../../apps/api/src/kubernetes.js";
import { kubernetesRoute } from "../../apps/api/src/kubernetes-route.js";
import { VpnController } from "../../apps/api/src/vpn.js";
import { authenticate } from "../../apps/api/src/auth.js";
import {
  authorize,
  serverVisibility,
} from "../../apps/api/src/server-access.js";
import {
  administratorAgentScopes,
  isAgentAdministrator,
} from "../../packages/policy-engine/index.js";

describe("Kubernetes MCP grants, approvals and execution with SQLite", () => {
  let directory = "",
    org = "",
    owner = "",
    agent = "",
    token = "",
    cluster = "",
    otherCluster = "";
  let p: Principal;
  const controller = new AppController();
  const clusterController = new KubernetesController();
  const machineReq = (path: string, method = "POST") =>
    ({
      headers: { authorization: "Bearer fixture-management-token" },
      cookies: {},
      method,
      originalUrl: "/api/" + path,
    }) as unknown as Request;
  async function managementToken() {
    await db().agent.update({
      where: { id: agent },
      data: { level: "custom" },
    });
    await db().agentToken.update({
      where: { id: token },
      data: {
        tokenHash: hash("fixture-management-token"),
        scopes: JSON.stringify([...kubernetesOperations, "workspace_manage"]),
      },
    });
  }
  const importedConfig = () =>
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "uploaded",
      clusters: [{ name: "api", cluster: { server: "https://fixture.test" } }],
      users: [{ name: "agent", user: { token: "uploaded-cluster-secret" } }],
      contexts: [
        {
          name: "uploaded",
          context: { cluster: "api", user: "agent", namespace: "apps" },
        },
      ],
    });
  const req = () =>
    ({
      headers: {},
      cookies: { nexus_session: "fixture-session" },
      method: "POST",
      originalUrl: "/api/agents",
    }) as unknown as Request;
  const db = () => fixture.db;
  async function routeFixtures() {
    const vpnId = randomUUID(),
      identityId = randomUUID();
    await db().vpnProfile.create({
      data: {
        id: vpnId,
        organizationId: org,
        name: "Routing VPN",
        summary: "{}",
        encryptedConfig: seal(
          {
            privateKey: "fixture-vpn-secret",
            addresses: ["10.77.0.2/32"],
            dns: ["10.77.0.1"],
            mtu: 1420,
            peers: [],
          },
          fixture.key,
          `${org}:vpn:${vpnId}`,
        ),
      },
    });
    await db().sSHIdentity.create({
      data: {
        id: identityId,
        organizationId: org,
        name: "Jump identity",
        kind: "password",
        encryptedSecret: seal(
          { password: "fixture-bastion-password" },
          fixture.key,
          `${org}:${identityId}`,
        ),
      },
    });
    const bastion = await db().server.create({
      data: {
        organizationId: org,
        name: "Jump server",
        host: "127.0.0.1",
        port: 2200 + (await db().server.count()),
        username: "jump",
        identityId,
        vpnProfileId: vpnId,
        fingerprint: "SHA256:fixture",
        overrides: JSON.stringify({
          identityId,
          username: "jump",
          vpnProfileId: vpnId,
        }),
      },
    });
    return { vpnId, identityId, bastionId: bastion.id };
  }
  const call = (
    op: string,
    args: unknown = {},
    principal = p,
    signal?: AbortSignal,
  ) => kubernetesOperation(principal, op, args, signal);
  const args = () => ({
    clusterId: cluster,
    command: ["scale", "deploy/api", "--replicas=2"],
  });
  async function approved(op = "kubernetes_execute", value = args()) {
    const pending = await call(op, value);
    expect(pending.status).toBe("approval_required");
    await db().kubernetesApproval.update({
      where: { id: pending.approvalId },
      data: { status: "approved", decidedBy: owner },
    });
    return { ...value, approvalId: pending.approvalId };
  }
  beforeAll(async () => {
    const root = resolve("data");
    mkdirSync(root, { recursive: true });
    directory = mkdtempSync(join(root, "kubernetes-mcp-"));
    writeFileSync(join(directory, "test.db"), "");
    const url = `file:../../../data/${basename(directory)}/test.db`;
    const migrated = spawnSync(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema",
        "packages/database/prisma/schema.prisma",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url },
        timeout: 30000,
      },
    );
    expect(migrated.status, migrated.stdout + migrated.stderr).toBe(0);
    fixture.db = new PrismaClient({ datasources: { db: { url } } });
    org = (await db().organization.create({ data: { name: "Fixture" } })).id;
    owner = (
      await db().user.create({
        data: {
          organizationId: org,
          email: "fixture@example.test",
          name: "Owner",
          role: "owner",
          passwordHash: "fixture",
        },
      })
    ).id;
    await db().webSession.create({
      data: {
        userId: owner,
        tokenHash: hash("fixture-session"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    agent = (
      await db().agent.create({
        data: {
          organizationId: org,
          ownerId: owner,
          name: "Agent",
          level: "custom",
        },
      })
    ).id;
    token = (
      await db().agentToken.create({
        data: {
          agentId: agent,
          tokenHash: "fixture-hash",
          issuer: "issuer",
          audience: "audience",
          scopes: JSON.stringify(kubernetesOperations),
          expiresAt: new Date(Date.now() + 3600000),
        },
      })
    ).id;
    for (const name of ["Allowed", "Unassigned"]) {
      const id = randomUUID();
      await db().kubernetesCluster.create({
        data: {
          id,
          organizationId: org,
          name,
          server: "https://fixture.test",
          context: "fixture",
          authentication: "token",
          encryptedConfig: seal(
            {
              server: "https://fixture.test",
              context: "fixture",
              namespace: "apps",
              authentication: "token",
              token: "cluster-secret",
            },
            fixture.key,
            `${org}:kubernetes:${id}`,
          ),
        },
      });
      if (name === "Allowed") cluster = id;
      else otherCluster = id;
    }
    await db().kubernetesAgentPermission.create({
      data: {
        agentId: agent,
        clusterId: cluster,
        operations: JSON.stringify(kubernetesOperations),
      },
    });
    p = {
      id: agent,
      organizationId: org,
      kind: "agent",
      role: "custom",
      tokenId: token,
      scopes: [...kubernetesOperations],
    };
  });
  beforeEach(async () => {
    fixture.request
      .mockReset()
      .mockResolvedValue({ kind: "Scale", spec: { replicas: 2 } });
    fixture.exec.mockReset().mockResolvedValue({
      stdout: "uid=1000\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await db().auditEvent.deleteMany();
    await db().kubernetesExecution.deleteMany();
    await db().kubernetesApproval.deleteMany();
    await db().agent.update({
      where: { id: agent },
      data: {
        revoked: false,
        level: "custom",
        maxCallsPerMinute: null,
        maxCallsPerDay: null,
      },
    });
    await db().user.update({ where: { id: owner }, data: { disabled: false } });
    await db().agentToken.update({
      where: { id: token },
      data: {
        revoked: false,
        scopes: JSON.stringify(kubernetesOperations),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await db().kubernetesAgentPermission.deleteMany({
      where: { agentId: agent, clusterId: { not: cluster } },
    });
    await db().kubernetesAgentPermission.upsert({
      where: { agentId_clusterId: { agentId: agent, clusterId: cluster } },
      create: {
        agentId: agent,
        clusterId: cluster,
        operations: JSON.stringify(kubernetesOperations),
      },
      update: { operations: JSON.stringify(kubernetesOperations) },
    });
  });
  afterAll(async () => {
    await fixture.db?.$disconnect();
    if (
      directory &&
      resolve(directory).startsWith(resolve("data") + sep) &&
      basename(directory).startsWith("kubernetes-mcp-")
    )
      rmSync(directory, { recursive: true, force: true });
  });
  it("lists only granted clusters and never returns kubeconfig credentials", async () => {
    const result = await call("kubernetes_clusters_list");
    expect(result.clusters.map((c: any) => c.id)).toEqual([cluster]);
    expect(JSON.stringify(result)).not.toMatch(
      /cluster-secret|encryptedConfig|authentication/,
    );
    await expect(
      call("kubernetes_cluster_check", { clusterId: otherCluster }),
    ).rejects.toThrow(/grant/);
    await expect(
      call(
        "kubernetes_cluster_check",
        { clusterId: cluster },
        { ...p, organizationId: randomUUID() },
      ),
    ).rejects.toThrow();
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("never executes before approval, encrypts exact args, consumes once, and encrypts results", async () => {
    const pending = await call("kubernetes_execute", args());
    const row = await db().kubernetesApproval.findUniqueOrThrow({
      where: { id: pending.approvalId },
    });
    expect(row.encryptedArguments).not.toContain("replicas");
    expect(
      unseal(
        row.encryptedArguments,
        fixture.key,
        `${org}:kubernetes-approval:${row.id}`,
      ),
    ).toMatchObject(args());
    expect(fixture.request).not.toHaveBeenCalled();
    await expect(
      call("kubernetes_execute", { ...args(), approvalId: row.id }),
    ).rejects.toThrow(/Approval/);
    await db().kubernetesApproval.update({
      where: { id: row.id },
      data: { status: "approved" },
    });
    const result = await call("kubernetes_execute", {
      ...args(),
      approvalId: row.id,
    });
    expect(result.status).toBe("completed");
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.request.mock.calls[0][4]).toMatchObject({
      method: "PATCH",
      body: '{"spec":{"replicas":2}}',
    });
    await expect(
      call("kubernetes_execute", { ...args(), approvalId: row.id }),
    ).rejects.toThrow(/consumed/);
    const saved = await db().kubernetesExecution.findUniqueOrThrow({
      where: { id: result.executionId },
    });
    expect(saved.encryptedResult).not.toContain("replicas");
    expect(
      await call("kubernetes_execution_status", { executionId: saved.id }),
    ).toMatchObject({ status: "completed", result: { spec: { replicas: 2 } } });
  });
  it("offers scoped resource pages, version checks and bounded previous-container logs", async () => {
    fixture.request.mockResolvedValueOnce({
      items: [
        {
          metadata: { name: "api", namespace: "apps" },
          spec: { containers: [{ name: "api" }] },
          status: { phase: "Running" },
        },
      ],
      metadata: { continue: "opaque&cursor=1" },
    });
    expect(
      await call("kubernetes_resources_list", {
        clusterId: cluster,
        resource: "pods",
        namespace: "apps",
        cursor: "page&token=1",
      }),
    ).toMatchObject({
      items: [{ name: "api", namespace: "apps", status: "Running" }],
      nextCursor: "opaque&cursor=1",
    });
    expect(fixture.request.mock.calls.at(-1)?.[1]).toBe(
      "/api/v1/namespaces/apps/pods?limit=100&continue=page%26token%3D1",
    );
    fixture.request.mockResolvedValueOnce({
      content: "previous logs",
      truncated: false,
    });
    await call("kubernetes_pod_logs", {
      clusterId: cluster,
      namespace: "apps",
      pod: "api",
      container: "api",
      previous: true,
      lines: 50,
    });
    expect(fixture.request.mock.calls.at(-1)?.[1]).toContain(
      "/pods/api/log?container=api&tailLines=50&previous=true&timestamps=true&limitBytes=262144",
    );
    fixture.request.mockResolvedValueOnce({ gitVersion: "v1.34.0" });
    expect(
      await call("kubernetes_cluster_check", { clusterId: cluster }),
    ).toMatchObject({ version: "v1.34.0" });
  });
  it("rejects changed command, target, timeout, token, expired grant and rotated kubeconfig", async () => {
    const value = await approved();
    for (const changes of [
      { command: ["delete", "deploy/api"] },
      { clusterId: otherCluster },
      { timeoutMs: 10000 },
    ])
      await expect(
        call("kubernetes_execute", { ...value, ...changes }),
      ).rejects.toThrow();
    const second = await db().agentToken.create({
      data: {
        agentId: agent,
        tokenHash: randomUUID(),
        issuer: "issuer",
        audience: "audience",
        scopes: JSON.stringify(kubernetesOperations),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await expect(
      call("kubernetes_execute", value, { ...p, tokenId: second.id }),
    ).rejects.toThrow(/Approval/);
    await db().kubernetesApproval.update({
      where: { id: value.approvalId },
      data: { expiresAt: new Date(0) },
    });
    expect((await kubernetesApprovalStatus(p, value.approvalId)).status).toBe(
      "expired",
    );
    await expect(call("kubernetes_execute", value)).rejects.toThrow(/Approval/);
    const rotated = await approved();
    const row = await db().kubernetesCluster.findUniqueOrThrow({
      where: { id: cluster },
    });
    const secret = unseal(
      row.encryptedConfig,
      fixture.key,
      `${org}:kubernetes:${cluster}`,
    );
    await db().kubernetesCluster.update({
      where: { id: cluster },
      data: {
        encryptedConfig: seal(
          secret,
          fixture.key,
          `${org}:kubernetes:${cluster}`,
        ),
      },
    });
    await expect(call("kubernetes_execute", rotated)).rejects.toThrow(
      /Approval/,
    );
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("rechecks live token, grants, agent role and owner before effects", async () => {
    const value = await approved();
    await db().agentToken.update({
      where: { id: token },
      data: { revoked: true },
    });
    await expect(call("kubernetes_execute", value)).rejects.toThrow();
    await db().agentToken.update({
      where: { id: token },
      data: { revoked: false },
    });
    await db().kubernetesAgentPermission.deleteMany({
      where: { agentId: agent },
    });
    await expect(call("kubernetes_execute", value)).rejects.toThrow(/grant/);
    await db().kubernetesAgentPermission.create({
      data: {
        agentId: agent,
        clusterId: cluster,
        operations: JSON.stringify(kubernetesOperations),
      },
    });
    await db().agent.update({
      where: { id: agent },
      data: { level: "viewer" },
    });
    await expect(call("kubernetes_execute", value)).rejects.toThrow();
    await db().agent.update({
      where: { id: agent },
      data: { level: "custom" },
    });
    await db().user.update({ where: { id: owner }, data: { disabled: true } });
    await expect(call("kubernetes_execute", value)).rejects.toThrow();
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("only admits one concurrent use of an approval", async () => {
    const value = await approved();
    const results = await Promise.allSettled([
      call("kubernetes_execute", value),
      call("kubernetes_execute", value),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });
  it("withholds results when an agent's access is revoked during execution", async () => {
    const value = await approved();
    fixture.request.mockImplementationOnce(async () => {
      await db().kubernetesAgentPermission.deleteMany({
        where: { agentId: agent },
      });
      return { privateResult: "do-not-return-after-revocation" };
    });
    await expect(call("kubernetes_execute", value)).rejects.toThrow(/grant/);
    const execution = await db().kubernetesExecution.findFirstOrThrow({
      where: { principalId: agent },
    });
    expect(execution.status).toBe("completed");
    await expect(
      call("kubernetes_execution_status", { executionId: execution.id }),
    ).rejects.toThrow(/grant/);
  });
  it("supports approved pod argv and marks interrupted commands without replaying", async () => {
    const value: any = {
      clusterId: cluster,
      namespace: "apps",
      pod: "api-1",
      container: "api",
      command: ["sh", "-lc", "id"],
    };
    const approvedArgs = await approved("kubernetes_pod_exec", value);
    expect(await call("kubernetes_pod_exec", approvedArgs)).toMatchObject({
      status: "completed",
      result: { stdout: "uid=1000\n", exitCode: 0 },
    });
    expect(fixture.exec.mock.calls[0][1].command).toEqual(value.command);
    const retry = await approved("kubernetes_pod_exec", value);
    fixture.exec.mockRejectedValueOnce(new Error("timeout"));
    expect(await call("kubernetes_pod_exec", retry)).toMatchObject({
      status: "interrupted",
    });
    await expect(call("kubernetes_pod_exec", retry)).rejects.toThrow(
      /consumed/,
    );
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });
  it("budgets Kubernetes calls together with other MCP calls and strips expired results", async () => {
    await db().agent.update({
      where: { id: agent },
      data: { maxCallsPerMinute: 1 },
    });
    await call("kubernetes_clusters_list");
    await expect(call("kubernetes_clusters_list")).rejects.toThrow(/limit/);
    await db().agent.update({
      where: { id: agent },
      data: { maxCallsPerMinute: null },
    });
    const result = await call("kubernetes_execute", await approved());
    await db().kubernetesExecution.update({
      where: { id: result.executionId },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (
        await call("kubernetes_execution_status", {
          executionId: result.executionId,
        })
      ).result,
    ).toBeNull();
    await expireKubernetesResults();
    expect(
      (
        await db().kubernetesExecution.findUniqueOrThrow({
          where: { id: result.executionId },
        })
      ).encryptedResult,
    ).toBeNull();
    await db().kubernetesExecution.update({
      where: { id: result.executionId },
      data: { status: "running" },
    });
    await recoverKubernetesExecutions();
    expect(
      (
        await db().kubernetesExecution.findUniqueOrThrow({
          where: { id: result.executionId },
        })
      ).status,
    ).toBe("interrupted");
  });
  it("hides command arguments from management agents and other tenants", async () => {
    await approved();
    expect(await kubernetesApprovals(p)).toEqual([]);
    expect(
      await kubernetesApprovals({
        ...p,
        kind: "user",
        id: owner,
        role: "owner",
      }),
    ).toHaveLength(1);
    expect(
      await kubernetesApprovals({
        ...p,
        kind: "user",
        id: owner,
        role: "owner",
        organizationId: randomUUID(),
      }),
    ).toEqual([]);
  });
  it("lets management agents submit kubeconfigs without exporting credentials or receiving cluster grants", async () => {
    await managementToken();
    const created = await clusterController.create(
      machineReq("kubernetes/clusters"),
      { name: "MCP imported", kubeconfig: importedConfig() },
    );
    expect(created).toMatchObject({
      name: "MCP imported",
      context: "uploaded",
      namespace: "apps",
      authentication: "token",
    });
    expect(JSON.stringify(created)).not.toMatch(
      /uploaded-cluster-secret|encryptedConfig|kubeconfig|certificate|privateKey/,
    );
    const stored = await db().kubernetesCluster.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.organizationId).toBe(org);
    expect(stored.encryptedConfig).not.toContain("uploaded-cluster-secret");
    expect(
      unseal(
        stored.encryptedConfig,
        fixture.key,
        `${org}:kubernetes:${created.id}`,
      ),
    ).toMatchObject({ token: "uploaded-cluster-secret" });
    expect(
      await db().kubernetesAgentPermission.count({
        where: { clusterId: created.id },
      }),
    ).toBe(0);
    await expect(
      call("kubernetes_cluster_check", { clusterId: created.id }),
    ).rejects.toThrow(/grant/);
    await expect(
      clusterController.list(machineReq("kubernetes/clusters", "GET")),
    ).rejects.toThrow(/Human/);
    await expect(
      clusterController.update(
        machineReq(`kubernetes/clusters/${created.id}`, "PATCH"),
        created.id,
        { kubeconfig: importedConfig() },
      ),
    ).rejects.toThrow(/Human/);
    await expect(
      clusterController.remove(
        machineReq(`kubernetes/clusters/${created.id}`, "DELETE"),
        created.id,
      ),
    ).rejects.toThrow(/Human/);
    const logs = await db().auditEvent.findMany({
      where: { principalId: agent },
    });
    expect(
      logs.some((event) => event.action === "mcp:kubernetes_cluster_create"),
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(
      /uploaded-cluster-secret|encryptedConfig/,
    );
  });
  it("requires explicit workspace management for config submission and does not echo rejected configs", async () => {
    const value = { name: "Denied", kubeconfig: importedConfig() };
    await expect(
      clusterController.create(machineReq("kubernetes/clusters"), value),
    ).rejects.toThrow(/Workspace management/);
    await managementToken();
    await db().agentToken.update({
      where: { id: token },
      data: { scopes: JSON.stringify(kubernetesOperations) },
    });
    await expect(
      clusterController.create(machineReq("kubernetes/clusters"), value),
    ).rejects.toThrow(/Workspace management/);
    await managementToken();
    const invalid = JSON.parse(importedConfig());
    invalid.users[0].user.exec = { command: "uploaded-cluster-secret" };
    let failure: unknown;
    try {
      await clusterController.create(machineReq("kubernetes/clusters"), {
        name: "Bad config",
        kubeconfig: JSON.stringify(invalid),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("uploaded-cluster-secret");
    expect(
      await db().kubernetesCluster.count({ where: { name: "Bad config" } }),
    ).toBe(0);
  });
  it("accepts SSH private keys/passwords through MCP and returns only identity metadata", async () => {
    await managementToken();
    const passphrase = "disposable-key-passphrase";
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: {
        type: "pkcs1",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase,
      },
    });
    const key = await controller.identity(machineReq("identities"), {
      name: "MCP key",
      kind: "key",
      privateKey,
      passphrase,
    });
    expect(Object.keys(key).sort()).toEqual(["id", "name"]);
    const saved = await db().sSHIdentity.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(
      unseal(saved.encryptedSecret, fixture.key, `${org}:${key.id}`),
    ).toEqual({ privateKey, passphrase });
    const password = await controller.identity(machineReq("identities"), {
      name: "MCP password",
      kind: "password",
      password: "disposable-ssh-password",
    });
    const list = await controller.identities(machineReq("identities", "GET"));
    expect(list.some((identity) => identity.id === key.id)).toBe(true);
    expect(list.some((identity) => identity.id === password.id)).toBe(true);
    const output = JSON.stringify({ key, password, list });
    for (const secret of [
      privateKey,
      passphrase,
      "disposable-ssh-password",
      "encryptedSecret",
      "privateKey",
      "passphrase",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(
      list.every(
        (identity) =>
          !("password" in identity) &&
          !("privateKey" in identity) &&
          !("encryptedSecret" in identity) &&
          !("passphrase" in identity),
      ),
    ).toBe(true);
  });
  it("saves cluster VPN/bastion selections, inherits the bastion VPN, and routes every MCP operation", async () => {
    const refs = await routeFixtures();
    const created = await clusterController.create(req(), {
      name: "Routed cluster",
      kubeconfig: importedConfig(),
      bastionId: refs.bastionId,
    });
    expect(created).toMatchObject({
      vpnProfileId: null,
      bastionId: refs.bastionId,
    });
    expect(JSON.stringify(created)).not.toMatch(
      /fixture-vpn-secret|fixture-bastion-password|encrypted/,
    );
    const stored = await db().kubernetesCluster.findUniqueOrThrow({
      where: { id: created.id },
    });
    const route = await kubernetesRoute(org, stored);
    expect(route.network).toMatchObject({
      vpn: { id: refs.vpnId },
      bastion: {
        host: "127.0.0.1",
        username: "jump",
        fingerprint: "SHA256:fixture",
      },
      sshLimits: { cidrs: ["127.0.0.1/32"] },
    });
    await db().kubernetesAgentPermission.create({
      data: {
        agentId: agent,
        clusterId: created.id,
        operations: JSON.stringify(kubernetesOperations),
      },
    });
    await call("kubernetes_cluster_check", { clusterId: created.id });
    expect(fixture.request.mock.calls.at(-1)?.[4].route).toMatchObject({
      vpn: { id: refs.vpnId },
      bastion: { host: "127.0.0.1" },
    });
    fixture.request.mockResolvedValueOnce({ items: [], metadata: {} });
    await call("kubernetes_resources_list", {
      clusterId: created.id,
      resource: "pods",
    });
    expect(fixture.request.mock.calls.at(-1)?.[4].route.vpn.id).toBe(
      refs.vpnId,
    );
    await call("kubernetes_pod_logs", {
      clusterId: created.id,
      namespace: "apps",
      pod: "api",
      container: "api",
    });
    expect(fixture.request.mock.calls.at(-1)?.[4].route.vpn.id).toBe(
      refs.vpnId,
    );
    const command = { clusterId: created.id, command: ["get", "pods"] };
    await call(
      "kubernetes_execute",
      await approved("kubernetes_execute", command),
    );
    expect(fixture.request.mock.calls.at(-1)?.[4].route.bastion.host).toBe(
      "127.0.0.1",
    );
    const pod: any = {
      clusterId: created.id,
      namespace: "apps",
      pod: "api",
      container: "api",
      command: ["id"],
    };
    await call(
      "kubernetes_pod_exec",
      await approved("kubernetes_pod_exec", pod),
    );
    expect(fixture.exec.mock.calls.at(-1)?.[4]).toMatchObject({
      vpn: { id: refs.vpnId },
      bastion: { host: "127.0.0.1" },
    });
  });
  it("invalidates pending approvals when routes, VPN configs or bastion credentials change", async () => {
    const refs = await routeFixtures();
    const created = await clusterController.create(req(), {
      name: "Rotating route",
      kubeconfig: importedConfig(),
      bastionId: refs.bastionId,
      vpnProfileId: refs.vpnId,
    });
    await db().kubernetesAgentPermission.create({
      data: {
        agentId: agent,
        clusterId: created.id,
        operations: JSON.stringify(kubernetesOperations),
      },
    });
    const original = (
      await db().kubernetesCluster.findUniqueOrThrow({
        where: { id: created.id },
      })
    ).encryptedConfig;
    const command = { clusterId: created.id, command: ["get", "pods"] };
    const first = await approved("kubernetes_execute", command);
    await controller.rotateIdentity(req(), refs.identityId, {
      name: "Rotated jump identity",
      kind: "password",
      password: "rotated-bastion-password",
    });
    await expect(call("kubernetes_execute", first)).rejects.toThrow(/Approval/);
    const second = await approved("kubernetes_execute", command);
    const vpn = await db().vpnProfile.findUniqueOrThrow({
      where: { id: refs.vpnId },
    });
    const value = unseal<any>(
      vpn.encryptedConfig,
      fixture.key,
      `${org}:vpn:${refs.vpnId}`,
    );
    await db().vpnProfile.update({
      where: { id: refs.vpnId },
      data: {
        encryptedConfig: seal(
          { ...value, mtu: 1400 },
          fixture.key,
          `${org}:vpn:${refs.vpnId}`,
        ),
      },
    });
    await expect(call("kubernetes_execute", second)).rejects.toThrow(
      /Approval/,
    );
    const third = await approved("kubernetes_execute", command);
    await clusterController.update(req(), created.id, { bastionId: null });
    expect(
      (
        await db().kubernetesCluster.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).encryptedConfig,
    ).toBe(original);
    await expect(call("kubernetes_execute", third)).rejects.toThrow(/Approval/);
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("rejects unavailable, nested, foreign and conflicting routes and protects active profile routes", async () => {
    const refs = await routeFixtures();
    const input = { name: "Restricted route", kubeconfig: importedConfig() };
    await expect(
      clusterController.create(req(), { ...input, vpnProfileId: randomUUID() }),
    ).rejects.toThrow(/VPN profile unavailable/);
    await expect(
      clusterController.create(req(), { ...input, bastionId: randomUUID() }),
    ).rejects.toThrow(/Bastion unavailable/);
    const other = await routeFixtures();
    await expect(
      clusterController.create(req(), {
        ...input,
        bastionId: refs.bastionId,
        vpnProfileId: other.vpnId,
      }),
    ).rejects.toThrow(/Conflicting VPN/);
    await db().server.update({
      where: { id: refs.bastionId },
      data: { bastionId: other.bastionId },
    });
    await expect(
      clusterController.create(req(), { ...input, bastionId: refs.bastionId }),
    ).rejects.toThrow(/Bastion unavailable/);
    await db().server.update({
      where: { id: refs.bastionId },
      data: { bastionId: null, archived: true },
    });
    await expect(
      clusterController.create(req(), { ...input, bastionId: refs.bastionId }),
    ).rejects.toThrow(/Bastion unavailable/);
    const created = await clusterController.create(req(), {
      ...input,
      vpnProfileId: refs.vpnId,
    });
    await db().kubernetesExecution.create({
      data: {
        organizationId: org,
        principalId: agent,
        clusterId: created.id,
        operation: "kubernetes_execute",
        status: "running",
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await expect(
      clusterController.update(req(), created.id, { vpnProfileId: null }),
    ).rejects.toThrow(/Wait for active Kubernetes/);
    await expect(new VpnController().remove(req(), refs.vpnId)).rejects.toThrow(
      /Kubernetes clusters/,
    );
    await expect(
      db().vpnProfile.delete({ where: { id: refs.vpnId } }),
    ).rejects.toThrow();
    const foreignOrg = await db().organization.create({
      data: { name: "Foreign" },
    });
    const foreignVpn = await db().vpnProfile.create({
      data: {
        organizationId: foreignOrg.id,
        name: "Foreign",
        summary: "{}",
        encryptedConfig: "never-decrypt-foreign",
      },
    });
    await expect(
      clusterController.create(req(), {
        ...input,
        vpnProfileId: foreignVpn.id,
      }),
    ).rejects.toThrow(/VPN profile unavailable/);
  });
  it("creates explicit cluster-only agents and rejects invalid roles and foreign grants", async () => {
    const value = {
      name: "Cluster agent",
      level: "custom",
      serverIds: [],
      operations: [],
      clusterIds: [cluster],
      clusterOperations: [...kubernetesOperations],
    };
    const created = await controller.createAgent(req(), value);
    const grants = await db().kubernetesAgentPermission.findMany({
      where: { agentId: created.agent.id },
    });
    expect(grants.map((g) => g.clusterId)).toEqual([cluster]);
    const issued = await db().agentToken.findFirstOrThrow({
      where: { agentId: created.agent.id },
    });
    expect(JSON.parse(issued.scopes)).toEqual(kubernetesOperations);
    expect(
      (await controller.agents(req())).find((a) => a.id === created.agent.id)
        ?.clusterPermissions,
    ).toHaveLength(1);
    await expect(
      controller.createAgent(req(), { ...value, level: "viewer" }),
    ).rejects.toThrow(/Invalid option/);
    await expect(
      controller.createAgent(req(), { ...value, clusterIds: [randomUUID()] }),
    ).rejects.toThrow(/Cluster unavailable/);
    await expect(
      controller.createAgent(req(), { ...value, clusterOperations: [] }),
    ).rejects.toThrow(/Choose Kubernetes/);
    const legacy = await controller.createAgent(req(), {
      name: "Legacy",
      serverIds: [],
      operations: [],
    });
    expect(
      await db().kubernetesAgentPermission.count({
        where: { agentId: legacy.agent.id },
      }),
    ).toBe(0);
  });
  it("enables every Administrator permission without custom fields, including future resources", async () => {
    const created = await controller.createAgent(req(), {
      name: "All access",
      level: "administrator",
      workspaceManagement: false,
      operations: [],
      clusterIds: [],
      clusterOperations: [],
    });
    const tokenRow = await db().agentToken.findFirstOrThrow({
      where: { agentId: created.agent.id },
    });
    expect(new Set(JSON.parse(tokenRow.scopes))).toEqual(
      new Set(administratorAgentScopes),
    );
    expect(
      await db().agentPermission.count({
        where: { agentId: created.agent.id },
      }),
    ).toBe(0);
    expect(
      await db().kubernetesAgentPermission.count({
        where: { agentId: created.agent.id },
      }),
    ).toBe(0);
    const authReq = {
      headers: { authorization: "Bearer " + created.token },
      method: "POST",
      originalUrl: "/api/operations/servers_list",
    } as Request;
    const principal = await authenticate(authReq);
    expect(isAgentAdministrator(principal)).toBe(true);
    const refs = await routeFixtures();
    const added = await clusterController.create(req(), {
      name: "Future admin cluster",
      kubeconfig: importedConfig(),
    });
    await expect(
      authorize(principal, refs.bastionId, "ssh_execute"),
    ).resolves.toHaveProperty("id", refs.bastionId);
    expect(
      await db().server.findMany({
        where: serverVisibility(principal),
        select: { id: true },
      }),
    ).toContainEqual({ id: refs.bastionId });
    expect(
      (await call("kubernetes_clusters_list", {}, principal)).clusters.some(
        (row: any) => row.id === added.id,
      ),
    ).toBe(true);
    await call("kubernetes_cluster_check", { clusterId: added.id }, principal);
    expect(
      (
        await call(
          "kubernetes_execute",
          { clusterId: added.id, command: ["get", "pods"] },
          principal,
        )
      ).status,
    ).toBe("approval_required");
    await expect(
      authorize(
        { ...principal, organizationId: randomUUID() },
        refs.bastionId,
        "ssh_execute",
      ),
    ).rejects.toThrow(/unavailable/);
    await expect(
      authorize(principal, refs.bastionId, "terminal"),
    ).rejects.toThrow();
    const metadata = await controller.identities({
      ...authReq,
      method: "GET",
      originalUrl: "/api/identities",
    } as Request);
    expect(metadata.length).toBeGreaterThan(0);
    expect(JSON.stringify(metadata)).not.toMatch(
      /encryptedSecret|privateKey|fixture-bastion-password/,
    );
    await expect(
      controller.agentGrant(req(), created.agent.id, {
        serverId: refs.bastionId,
        operations: ["system_info"],
      }),
    ).rejects.toThrow(/Choose Custom/);
  });
  it("keeps Administrator automatic on save and removes implicit access immediately on downgrade", async () => {
    const created = await controller.createAgent(req(), {
      name: "Role change",
      level: "administrator",
    });
    const authReq = {
      headers: { authorization: "Bearer " + created.token },
      method: "POST",
      originalUrl: "/api/operations/kubernetes_clusters_list",
    } as Request;
    await controller.agentAccess(req(), created.agent.id, {
      level: "administrator",
      workspaceManagement: false,
      operations: [],
      serverIds: [],
    });
    expect(isAgentAdministrator(await authenticate(authReq))).toBe(true);
    const refs = await routeFixtures();
    await controller.agentAccess(req(), created.agent.id, {
      level: "custom",
      serverIds: [refs.bastionId],
      operations: ["system_info"],
      clusterIds: [cluster],
      clusterOperations: [
        "kubernetes_clusters_list",
        "kubernetes_cluster_check",
      ],
      workspaceManagement: false,
    });
    const principal = await authenticate(authReq);
    expect(isAgentAdministrator(principal)).toBe(false);
    await expect(
      authorize(principal, refs.bastionId, "system_info"),
    ).resolves.toBeDefined();
    await expect(
      authorize(principal, refs.bastionId, "ssh_execute"),
    ).rejects.toThrow();
    const list = await call("kubernetes_clusters_list", {}, principal);
    expect(list.clusters.map((row: any) => row.id)).toEqual([cluster]);
    await expect(
      call("kubernetes_cluster_check", { clusterId: otherCluster }, principal),
    ).rejects.toThrow(/grant/);
    await expect(
      controller.identities({
        ...authReq,
        method: "GET",
        originalUrl: "/api/identities",
      } as Request),
    ).rejects.toThrow(/Workspace management/);
    await expect(
      controller.createAgent(req(), { name: "No operator", level: "operator" }),
    ).rejects.toThrow(/Invalid option/);
  });
  it("lets Custom explicitly enable workspace management without granting all resources or promotion rights", async () => {
    const created = await controller.createAgent(req(), {
      name: "Custom manager",
      level: "custom",
      workspaceManagement: true,
    });
    const authReq = {
      headers: { authorization: "Bearer " + created.token },
      method: "GET",
      originalUrl: "/api/identities",
    } as Request;
    expect((await controller.identities(authReq)).length).toBeGreaterThan(0);
    const principal = await authenticate({
      ...authReq,
      originalUrl: "/api/operations/servers_list",
      method: "POST",
    } as Request);
    expect(isAgentAdministrator(principal)).toBe(false);
    const refs = await routeFixtures();
    await expect(
      authorize(principal, refs.bastionId, "ssh_execute"),
    ).rejects.toThrow(/not granted/);
    const updateReq = {
      ...authReq,
      method: "PATCH",
      originalUrl: `/api/agents/${created.agent.id}/access`,
    } as Request;
    await expect(
      controller.agentAccess(updateReq, created.agent.id, {
        level: "administrator",
      }),
    ).rejects.toThrow(/Human/);
    await expect(
      controller.createAgent(
        { ...authReq, method: "POST", originalUrl: "/api/agents" } as Request,
        { name: "Escalation", level: "administrator" },
      ),
    ).rejects.toThrow(/Human/);
  });
  it("revalidates administrator owners, scopes and revocation for automatic access", async () => {
    const created = await controller.createAgent(req(), {
      name: "Revalidated admin",
      level: "administrator",
    });
    const authReq = {
      headers: { authorization: "Bearer " + created.token },
      method: "POST",
      originalUrl: "/api/operations/kubernetes_cluster_check",
    } as Request;
    const principal = await authenticate(authReq);
    await db().user.update({
      where: { id: owner },
      data: { role: "operator" },
    });
    await expect(authenticate(authReq)).rejects.toThrow(/administrator owner/);
    await expect(
      call("kubernetes_cluster_check", { clusterId: cluster }, principal),
    ).rejects.toThrow();
    await db().user.update({ where: { id: owner }, data: { role: "owner" } });
    await controller.revoke(req(), created.agent.id);
    await expect(authenticate(authReq)).rejects.toThrow(/revoked/);
  });
  it("rechecks automatic Administrator access when queued SSH batches start", async () => {
    const created = await controller.createAgent(req(), {
      name: "Queued admin",
      level: "administrator",
    });
    const issued = await db().agentToken.findFirstOrThrow({
      where: { agentId: created.agent.id },
    });
    const refs = await routeFixtures();
    const batch = await db().batchDispatch.create({
      data: {
        organizationId: org,
        principalId: created.agent.id,
        status: "released",
      },
    });
    await db().backgroundTask.create({
      data: {
        organizationId: org,
        principalId: created.agent.id,
        serverId: refs.bastionId,
        operation: "ssh_execute",
        encryptedArguments: "encrypted-fixture",
        tokenId: issued.id,
        batchId: batch.id,
        status: "running",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const internalReq = {
      headers: { "x-nexus-internal": "fixture-gateway-secret" },
    } as unknown as Request;
    await expect(controller.startBatch(internalReq, batch.id)).resolves.toEqual(
      { started: true },
    );
    await db().batchDispatch.update({
      where: { id: batch.id },
      data: { status: "released" },
    });
    await controller.agentAccess(req(), created.agent.id, {
      level: "custom",
      serverIds: [],
      operations: ["ssh_execute", "ssh_execute_many"],
      clusterIds: [],
      clusterOperations: [],
    });
    await expect(controller.startBatch(internalReq, batch.id)).rejects.toThrow(
      /grant was removed/,
    );
    expect(
      (await db().batchDispatch.findUniqueOrThrow({ where: { id: batch.id } }))
        .status,
    ).toBe("released");
  });
  it("preserves per-token cluster scopes on legacy SSH updates and replaces explicit cluster access", async () => {
    const narrow = await db().agentToken.create({
      data: {
        agentId: agent,
        tokenHash: randomUUID(),
        issuer: "issuer",
        audience: "audience",
        scopes: JSON.stringify(["kubernetes_clusters_list"]),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const legacy = {
      level: "custom",
      serverIds: [],
      operations: ["system_info"],
    };
    await controller.agentAccess(req(), agent, legacy);
    expect(
      JSON.parse(
        (await db().agentToken.findUniqueOrThrow({ where: { id: narrow.id } }))
          .scopes,
      ),
    ).toEqual(["system_info", "kubernetes_clusters_list"]);
    expect(
      await db().kubernetesAgentPermission.count({ where: { agentId: agent } }),
    ).toBe(1);
    await expect(
      controller.agentAccess(req(), agent, { ...legacy, clusterIds: [] }),
    ).rejects.toThrow(/both/);
    await controller.agentAccess(req(), agent, {
      ...legacy,
      clusterIds: [],
      clusterOperations: [],
    });
    expect(
      await db().kubernetesAgentPermission.count({ where: { agentId: agent } }),
    ).toBe(0);
    expect(
      JSON.parse(
        (await db().agentToken.findUniqueOrThrow({ where: { id: token } }))
          .scopes,
      ),
    ).toEqual(["system_info"]);
  });
  it("shows cluster approvals in the existing queue and only accepts human decisions", async () => {
    const pending = await call("kubernetes_execute", args());
    const queue = await controller.approvals(req());
    expect(queue.find((row) => row.id === pending.approvalId)).toMatchObject({
      cluster: { name: "Allowed" },
      args: args(),
    });
    await controller.decide(req(), pending.approvalId, {
      decision: "approved",
    });
    await expect(
      controller.decide(req(), pending.approvalId, { decision: "rejected" }),
    ).rejects.toThrow(/unavailable/);
    const second = await call("kubernetes_execute", args());
    await db().agent.update({
      where: { id: agent },
      data: { level: "administrator" },
    });
    await db().agentToken.update({
      where: { id: token },
      data: {
        tokenHash: hash("fixture-management-token"),
        scopes: JSON.stringify([...kubernetesOperations, "workspace_manage"]),
      },
    });
    const machineReq = {
      headers: { authorization: "Bearer fixture-management-token" },
      method: "POST",
      originalUrl: `/api/approvals/${second.approvalId}`,
    } as Request;
    await expect(
      controller.decide(machineReq, second.approvalId, {
        decision: "approved",
      }),
    ).rejects.toThrow(/Human/);
    expect(
      (
        await db().kubernetesApproval.findUniqueOrThrow({
          where: { id: second.approvalId },
        })
      ).status,
    ).toBe("pending");
    const updatedReq = {
      ...machineReq,
      method: "PATCH",
      originalUrl: `/api/agents/${agent}/access`,
    } as Request;
    await expect(
      controller.agentAccess(updatedReq, agent, {
        level: "administrator",
        serverIds: [],
        operations: [],
        clusterIds: [otherCluster],
        clusterOperations: kubernetesOperations,
      }),
    ).rejects.toThrow(/Human/);
  });
});
