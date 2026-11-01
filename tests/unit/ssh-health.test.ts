import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  sshHealthState,
  SSH_HEALTH_STALE_MS,
} from "../../packages/shared/ssh-health.js";
import { VpnError } from "../../packages/ssh-core/vpn.js";

const fixture = vi.hoisted(() => ({
  db: undefined as unknown as PrismaClient,
  scan: vi.fn(),
  add: vi.fn(),
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
vi.mock("bullmq", () => ({
  Queue: class {
    add = fixture.add;
  },
  Worker: class {},
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: { SSH_HEALTH_CONCURRENCY: 4 },
  redisConnection: {},
}));
vi.mock("../../packages/ssh-core/index.js", () => ({
  scanHostKey: fixture.scan,
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  authorize: vi.fn(),
  connection: vi.fn(async () => ({})),
  sshLimits: vi.fn(async () => ({
    cidrs: ["192.0.2.0/24"],
    connectTimeout: 10000,
    outputLimit: 1000,
  })),
}));

import {
  runHealthCheck,
  finishCheck,
  healthFailureCategory,
  enqueuePeriodicHealth,
} from "../../apps/api/src/health.js";
import { markSshReachable } from "../../apps/api/src/connection-health.js";

let directory: string,
  org: string,
  serverId: string,
  identityId: string,
  checkId: string;
beforeAll(async () => {
  const root = resolve("data");
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(join(root, "ssh-health-"));
  writeFileSync(join(directory, "test.db"), "");
  const url = `file:../../../data/${basename(directory)}/test.db`;
  const result = spawnSync(
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
  expect(result.status, result.stdout + result.stderr).toBe(0);
  fixture.db = new PrismaClient({ datasources: { db: { url } } });
  org = (
    await fixture.db.organization.create({ data: { name: "Health fixture" } })
  ).id;
  identityId = (
    await fixture.db.sSHIdentity.create({
      data: {
        organizationId: org,
        name: "Fixture",
        kind: "password",
        encryptedSecret: "fixture",
      },
    })
  ).id;
  serverId = (
    await fixture.db.server.create({
      data: {
        organizationId: org,
        name: "Host",
        host: "192.0.2.5",
        port: 22,
        username: "fixture",
        identityId,
        fingerprint: "SHA256:known",
      },
    })
  ).id;
});
beforeEach(async () => {
  fixture.scan.mockReset().mockResolvedValue("SHA256:known");
  fixture.add.mockReset().mockResolvedValue({});
  await fixture.db.healthBatch.deleteMany();
  await fixture.db.server.deleteMany({ where: { id: { not: serverId } } });
  checkId = randomUUID();
  await fixture.db.server.update({
    where: { id: serverId },
    data: {
      host: "192.0.2.5",
      status: "unreachable",
      healthFailureCategory: "route",
      lastCheckedAt: new Date(),
      latestHealthCheckId: checkId,
    },
  });
  await fixture.db.healthBatch.create({
    data: {
      organizationId: org,
      principalId: "system",
      expiresAt: new Date(Date.now() + 60000),
      checks: { create: { id: checkId, organizationId: org, serverId } },
    },
  });
});
afterAll(async () => {
  await fixture.db?.$disconnect();
  if (
    directory &&
    resolve(directory).startsWith(resolve("data") + sep) &&
    basename(directory).startsWith("ssh-health-")
  )
    rmSync(directory, { recursive: true, force: true });
});

describe("SSH status evidence", () => {
  it("normalizes legacy route/policy failures as unknown, preserving real network failures and freshness", () => {
    const row = { status: "unreachable", lastCheckedAt: new Date() };
    for (const healthFailureCategory of [
      "route",
      "policy",
      "permission_changed",
      "dns",
      "configuration",
      "queue_unavailable",
    ])
      expect(sshHealthState({ ...row, healthFailureCategory })).toBe("unknown");
    expect(sshHealthState({ ...row, healthFailureCategory: "network" })).toBe(
      "unreachable",
    );
    expect(sshHealthState({ ...row, status: "reachable" })).toBe("reachable");
    expect(
      sshHealthState(
        { ...row, status: "reachable" },
        Date.now() + SSH_HEALTH_STALE_MS + 1000,
      ),
    ).toBe("unknown");
    expect(
      healthFailureCategory(
        new VpnError("VPN connection timed out", "connect"),
      ),
    ).toBe("route");
    expect(
      healthFailureCategory(
        new Error(
          "SSH destination is outside the configured allowlist (192.0.2.5)",
        ),
      ),
    ).toBe("policy");
  });
  it("records an unavailable VPN check without marking the destination offline", async () => {
    fixture.scan.mockRejectedValue(
      new VpnError("VPN connection failed", "connect"),
    );
    await runHealthCheck(checkId);
    expect(
      await fixture.db.server.findUnique({ where: { id: serverId } }),
    ).toMatchObject({ status: "unknown", healthFailureCategory: "route" });
    expect(fixture.scan).toHaveBeenCalledTimes(1);
  });
  it("retries a transient handshake failure and never trusts or changes the observed host key", async () => {
    fixture.scan
      .mockRejectedValueOnce(new Error("Timed out while waiting for handshake"))
      .mockResolvedValueOnce("SHA256:changed");
    await runHealthCheck(checkId);
    expect(fixture.scan).toHaveBeenCalledTimes(2);
    expect(
      await fixture.db.server.findUnique({ where: { id: serverId } }),
    ).toMatchObject({
      status: "reachable",
      healthFailureCategory: null,
      fingerprint: "SHA256:known",
    });
    expect(
      await fixture.db.healthCheck.findUnique({ where: { id: checkId } }),
    ).toMatchObject({ status: "reachable", fingerprintComparison: "mismatch" });
  });
  it("shows unreachable only after a repeated network failure", async () => {
    fixture.scan.mockRejectedValue(
      new Error("connect ECONNREFUSED 192.0.2.5:22"),
    );
    await runHealthCheck(checkId);
    expect(fixture.scan).toHaveBeenCalledTimes(2);
    expect(
      await fixture.db.server.findUnique({ where: { id: serverId } }),
    ).toMatchObject({
      status: "unreachable",
      healthFailureCategory: "network",
    });
  });
  it("does not let a late probe overwrite a newer authenticated connection or a changed endpoint", async () => {
    await markSshReachable(org, serverId, { host: "192.0.2.5", port: 22 });
    await finishCheck(
      checkId,
      "unreachable",
      "network",
      null,
      null,
      "192.0.2.5",
      22,
    );
    expect(
      await fixture.db.server.findUnique({ where: { id: serverId } }),
    ).toMatchObject({
      status: "reachable",
      latestHealthCheckId: null,
      healthFailureCategory: null,
    });
    await fixture.db.server.update({
      where: { id: serverId },
      data: { host: "192.0.2.6", status: "unknown" },
    });
    await markSshReachable(org, serverId, { host: "192.0.2.5", port: 22 });
    expect(
      (await fixture.db.server.findUniqueOrThrow({ where: { id: serverId } }))
        .status,
    ).toBe("unknown");
    await markSshReachable("other-workspace", serverId, {
      host: "192.0.2.6",
      port: 22,
    });
    expect(
      (await fixture.db.server.findUniqueOrThrow({ where: { id: serverId } }))
        .status,
    ).toBe("unknown");
  });
  it("rechecks recent failed hosts promptly while leaving fresh successful checks alone", async () => {
    await fixture.db.healthBatch.updateMany({ data: { status: "completed" } });
    await fixture.db.server.update({
      where: { id: serverId },
      data: {
        lastCheckedAt: new Date(Date.now() - 120000),
        status: "unreachable",
        healthFailureCategory: "network",
      },
    });
    await fixture.db.server.create({
      data: {
        organizationId: org,
        name: "Healthy peer",
        host: "192.0.2.6",
        username: "fixture",
        identityId,
        status: "reachable",
        lastCheckedAt: new Date(),
      },
    });
    await enqueuePeriodicHealth();
    const checks = await fixture.db.healthCheck.findMany({
      where: { status: "queued", id: { not: checkId } },
    });
    expect(checks.map((check) => check.serverId)).toEqual([serverId]);
    expect(fixture.add).toHaveBeenCalledTimes(1);
  });
});
