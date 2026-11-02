import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { db } from "../../../packages/database/index.js";
import { config, redisConnection } from "../../../packages/shared/config.js";
import { scanHostKey } from "../../../packages/ssh-core/index.js";
import { VpnError } from "../../../packages/ssh-core/vpn.js";
import {
  SSH_HEALTH_STALE_MS,
  SSH_HEALTH_RETRY_MS,
} from "../../../packages/shared/ssh-health.js";
import { authorize, connection, sshLimits } from "./domain.js";
import {
  effectiveAgentScopes,
  type Principal,
} from "../../../packages/policy-engine/index.js";

const MAX_ACTIVE_BATCHES = 2;
export const healthQueue = new Queue("nexus-ssh-health", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 3600, count: 1000 },
  },
});

export async function enqueueHealthBatch(
  org: string,
  principalId: string,
  serverIds: string[],
) {
  const ids = [...new Set(serverIds)];
  if (ids.length > 100)
    throw new BadRequestException("Select at most 100 servers");
  const checks = ids.map((serverId) => ({
    id: randomUUID(),
    serverId,
    organizationId: org,
  }));
  const batch = await db.$transaction(async (tx) => {
    const active = await tx.healthBatch.count({
      where: {
        organizationId: org,
        status: { in: ["queued", "running"] },
        expiresAt: { gt: new Date() },
      },
    });
    if (active >= MAX_ACTIVE_BATCHES)
      throw new BadRequestException(
        "Too many active health batches for this workspace",
      );
    const existing = await tx.server.count({
      where: { id: { in: ids }, organizationId: org, archived: false },
    });
    if (existing !== ids.length)
      throw new NotFoundException("Server unavailable");
    const row = await tx.healthBatch.create({
      data: {
        organizationId: org,
        principalId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        status: checks.length ? "queued" : "completed",
        checks: { create: checks },
      },
    });
    for (const check of checks)
      await tx.server.update({
        where: { id: check.serverId },
        data: { latestHealthCheckId: check.id },
      });
    return row;
  });
  for (const check of checks) {
    try {
      await healthQueue.add(
        "check",
        { checkId: check.id },
        { jobId: check.id, priority: 10 },
      );
    } catch {
      await finishCheck(check.id, "unknown", "queue_unavailable", null, null);
    }
  }
  return {
    batchId: batch.id,
    serverIds: ids,
    status: checks.length ? "queued" : "completed",
  };
}

export function healthFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (error instanceof VpnError || /vpn|bastion/.test(message)) return "route";
  if (
    /allowlist|metadata|cidr|not allowed|blocked|private address/.test(message)
  )
    return "policy";
  if (
    /authentication|fingerprint|verification failed|identity unavailable|effective identity|permission denied/.test(
      message,
    )
  )
    return "configuration";
  if (/enotfound|dns|getaddrinfo/.test(message)) return "dns";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (
    /refused|reset|unreachable|network|no host key|handshake|connection lost|socket closed/.test(
      message,
    )
  )
    return "network";
  return "connection_failed";
}

export async function finishCheck(
  checkId: string,
  status: string,
  failureCategory: string | null,
  observedFingerprint: string | null,
  fingerprintComparison: string | null,
  checkedHost?: string,
  checkedPort?: number,
) {
  await db.$transaction(async (tx) => {
    const check = await tx.healthCheck.findUnique({ where: { id: checkId } });
    if (!check || check.status !== "queued") return;
    const checkedAt = new Date();
    await tx.healthCheck.update({
      where: { id: checkId },
      data: {
        status,
        failureCategory,
        observedFingerprint,
        fingerprintComparison,
        checkedAt,
        checkedHost,
        checkedPort,
      },
    });
    await tx.server.updateMany({
      where: {
        id: check.serverId,
        organizationId: check.organizationId,
        latestHealthCheckId: checkId,
        ...(checkedHost && checkedPort
          ? { host: checkedHost, port: checkedPort }
          : {}),
      },
      data: {
        status,
        healthFailureCategory: failureCategory,
        lastCheckedAt: checkedAt,
      },
    });
    const remaining = await tx.healthCheck.count({
      where: { batchId: check.batchId, status: "queued" },
    });
    await tx.healthBatch.update({
      where: { id: check.batchId },
      data: { status: remaining ? "running" : "completed" },
    });
  });
}

export async function runHealthCheck(checkId: string) {
  const check = await db.healthCheck.findUnique({
    where: { id: checkId },
    include: { batch: true },
  });
  if (!check || check.status !== "queued") return;
  const server = await db.server.findFirst({
    where: {
      id: check.serverId,
      organizationId: check.organizationId,
      archived: false,
    },
    select: { host: true, port: true, fingerprint: true },
  });
  if (!server || check.batch.expiresAt < new Date())
    return finishCheck(check.id, "unknown", "unavailable", null, null);
  try {
    if (check.batch.principalId !== "system") {
      const agent = await db.agent.findFirst({
        where: {
          id: check.batch.principalId,
          organizationId: check.organizationId,
          revoked: false,
          owner: { disabled: false },
        },
        include: {
          owner: true,
          tokens: { where: { revoked: false, expiresAt: { gt: new Date() } } },
        },
      });
      const user = agent
        ? null
        : await db.user.findFirst({
            where: {
              id: check.batch.principalId,
              organizationId: check.organizationId,
              disabled: false,
            },
          });
      if (!agent && !user)
        return finishCheck(
          check.id,
          "unknown",
          "permission_changed",
          null,
          null,
        );
      const principal: Principal = agent
        ? {
            id: agent.id,
            organizationId: check.organizationId,
            kind: "agent",
            role: agent.level,
            scopes: [
              ...new Set(
                agent.tokens.flatMap((token) =>
                  effectiveAgentScopes(
                    agent.level,
                    JSON.parse(token.scopes),
                    agent.owner.role,
                  ),
                ),
              ),
            ],
          }
        : {
            id: user!.id,
            organizationId: check.organizationId,
            kind: "user",
            role: user!.role,
            scopes: [],
          };
      try {
        await authorize(principal, check.serverId, "server_test_connection");
      } catch {
        return finishCheck(
          check.id,
          "unknown",
          "permission_changed",
          null,
          null,
        );
      }
    }
    const route = await connection(
      check.serverId,
      check.organizationId,
      undefined,
      false,
    );
    const limits = await sshLimits(check.organizationId);
    let observed: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        observed = await scanHostKey(
          server.host,
          server.port,
          { ...limits, connectTimeout: Math.min(limits.connectTimeout, 15000) },
          { vpn: route.vpn, bastion: route.bastion },
        );
        break;
      } catch (error) {
        if (
          attempt ||
          !["network", "timeout"].includes(healthFailureCategory(error))
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!observed) throw new Error("No host key received");
    await finishCheck(
      check.id,
      "reachable",
      null,
      observed,
      !server.fingerprint
        ? "untrusted"
        : server.fingerprint === observed
          ? "match"
          : "mismatch",
      server.host,
      server.port,
    );
  } catch (error) {
    const category = healthFailureCategory(error);
    await finishCheck(
      check.id,
      ["network", "timeout"].includes(category) ? "unreachable" : "unknown",
      category,
      null,
      null,
      server.host,
      server.port,
    );
  }
}
export function startHealthWorker() {
  const worker = new Worker(
    "nexus-ssh-health",
    (job) => runHealthCheck(job.data.checkId),
    {
      connection: redisConnection,
      concurrency: config.SSH_HEALTH_CONCURRENCY,
      lockDuration: 30000,
      maxStalledCount: 0,
    },
  );
  worker.on("error", (error) =>
    console.error("Health worker unavailable:", error.name),
  );
  return worker;
}

export async function enqueuePeriodicHealth() {
  const staleBefore = new Date(Date.now() - SSH_HEALTH_STALE_MS);
  const retryBefore = new Date(Date.now() - SSH_HEALTH_RETRY_MS);
  const orgs = await db.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    if (
      await db.healthBatch.count({
        where: {
          organizationId: org.id,
          status: { in: ["queued", "running"] },
          expiresAt: { gt: new Date() },
        },
      })
    )
      continue;
    const servers = await db.server.findMany({
      where: {
        organizationId: org.id,
        archived: false,
        OR: [
          { lastCheckedAt: null },
          {
            status: { in: ["unknown", "unreachable"] },
            lastCheckedAt: { lt: retryBefore },
          },
          { lastCheckedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true },
      orderBy: { lastCheckedAt: "asc" },
      take: 100,
    });
    if (!servers.length) continue;
    try {
      await enqueueHealthBatch(
        org.id,
        "system",
        servers.map((server) => server.id),
      );
    } catch (error) {
      if (!(error instanceof BadRequestException))
        console.error(
          "Periodic health enqueue failed:",
          error instanceof Error ? error.name : "unknown",
        );
    }
  }
}
