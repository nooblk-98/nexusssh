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
import { randomUUID } from "node:crypto";
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
  const req = () =>
    ({
      headers: {},
      cookies: { nexus_session: "fixture-session" },
      method: "POST",
      originalUrl: "/api/agents",
    }) as unknown as Request;
  const db = () => fixture.db;
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
          level: "operator",
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
      role: "operator",
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
        level: "operator",
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
      data: { level: "operator" },
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
  it("creates explicit cluster-only agents and rejects invalid/foreign/viewer grants", async () => {
    const value = {
      name: "Cluster agent",
      level: "operator",
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
    ).rejects.toThrow(/Viewer/);
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
      level: "operator",
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
