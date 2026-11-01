import { authorize, serverVisibility } from "./server-access.js";
export { authorize, serverVisibility } from "./server-access.js";
import { kubernetesOperation, kubernetesApprovalStatus } from "./kubernetes-operations.js";
import { kubernetesOperations } from "../../../packages/kubernetes/policy.js";
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { reserveAgentCall, reserveAgentCalls } from "./agent-quota.js";
import { resolveSettings, numericMetadata } from "./metadata.js";
import { db } from "../../../packages/database/index.js";
import { config, redisConnection } from "../../../packages/shared/config.js";
import {
  canonical,
  hash,
  seal,
  unseal,
} from "../../../packages/shared/crypto.js";
import {
  parseOperation,
  executionArgs,
  batchApprovalPayload,
  completedBatchResult,
  batchTokenAllowed,
} from "../../../packages/shared/operations.js";
import {
  effectiveAgentScopes,
  needsApproval,
  type Principal,
} from "../../../packages/policy-engine/index.js";
import {
  connectionFailures,
  scanHostKey,
  type Connection,
} from "../../../packages/ssh-core/index.js";
export const queue = new Queue("nexus-ssh", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 3600, count: 1000 },
  },
});
export const events = new QueueEvents("nexus-ssh", {
  connection: redisConnection,
});
export const batchQueue = new Queue("nexus-ssh-batch", {
  connection: redisConnection,
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 3600, count: 1000 } },
});
export const batchEvents = new QueueEvents("nexus-ssh-batch", { connection: redisConnection });
export async function audit(
  p: Principal,
  action: string,
  status: string,
  serverId?: string,
  correlationId: string = randomUUID(),
) {
  await db.auditEvent.create({
    data: {
      organizationId: p.organizationId,
      principalId: p.id,
      action,
      status,
      serverId,
      correlationId,
    },
  });
}
export async function listServers(p: Principal) {
  const servers = await db.server.findMany({
    where: serverVisibility(p),
    include: {
      group: true,
      tags: true,
      vpnProfile: { select: { id: true, name: true } },
      bastion: { select: { id: true, name: true } },
    },
    orderBy: [{ favorite: "desc" }, { name: "asc" }],
    take: 500,
  });
  return Promise.all(servers.map(async (server) => ({ ...numericMetadata(server), effectiveSettings: await resolveSettings(server.id, p.organizationId) })));
}
export async function listServersPage(p: Principal, q: {
  folder?: string | null; tag?: string; search?: string; fields?: string; cursor?: string;
}) {
  const allowed = ["effectiveSettings", "vcpu", "ramBytes", "diskBytes", "os", "role", "id", "name", "host", "port", "username", "groupId", "environment", "description", "icon", "favorite", "archived", "createdAt", "updatedAt", "status", "lastCheckedAt", "healthFailureCategory", "healthStale", "group", "tags", "vpnProfile", "bastion", "identity"];
  const fields = q.fields?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fields?.some((f) => !allowed.includes(f)))
    throw new BadRequestException("Invalid fields selection");
  const page = await db.server.findMany({
    where: {
      AND: [serverVisibility(p)],
      ...(q.folder !== undefined ? { groupId: q.folder } : {}),
      ...(q.tag ? { tags: { some: { name: q.tag } } } : {}),
      ...(q.search ? { OR: ["name", "host", "description"].map((field) => ({ [field]: { contains: q.search } })) } : {}),
      ...(q.cursor ? { id: { gt: q.cursor } } : {}),
    },
    include: { group: true, tags: true, vpnProfile: { select: { id: true, name: true } }, bastion: { select: { id: true, name: true } }, identity: { select: { id: true, name: true } } },
    orderBy: { id: "asc" }, take: 101,
  });
  return {
    servers: await Promise.all(page.slice(0, 100).map(async (s) => {
      const row = { ...numericMetadata(s), effectiveSettings: await resolveSettings(s.id, p.organizationId) };
      return fields ? Object.fromEntries(fields.map((f) => [f, row[f as keyof typeof row]])) : row;
    })),
    nextCursor: page.length > 100 ? page[99].id : null,
  };
}
// Optional webhook (Slack, Discord, Teams or any JSON endpoint) told about
// new approval requests so they are not left waiting unseen.
export const APPROVAL_WEBHOOK = "notify.approvalWebhook";
export async function approvalWebhook(org: string) {
  const row = await db.systemSetting.findUnique({
    where: {
      organizationId_key: { organizationId: org, key: APPROVAL_WEBHOOK },
    },
  });
  return row?.value || "";
}
async function announceApproval(
  p: Principal,
  op: string,
  serverName: string,
  approvalId: string,
) {
  const url = await approvalWebhook(p.organizationId);
  if (!url) return;
  const who =
    p.kind === "agent"
      ? (await db.agent.findUnique({ where: { id: p.id } }))?.name + " (agent)"
      : (await db.user.findUnique({ where: { id: p.id } }))?.name;
  const text = `NexusSSH: ${who} requests approval for ${op} on ${serverName} (${approvalId}). Review it under Settings > Approvals.`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, content: text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
// SSH destinations allowed for a workspace: the deployment's SSH_ALLOWED_CIDRS
// plus networks administrators add under Settings > Security.
export const EXTRA_CIDRS = "ssh.allowedCidrs";
export async function workspaceCidrs(org: string): Promise<string[]> {
  const row = await db.systemSetting.findUnique({
    where: { organizationId_key: { organizationId: org, key: EXTRA_CIDRS } },
  });
  return row ? JSON.parse(row.value) : [];
}
export async function sshLimits(org: string) {
  return {
    vpnGateway: { url: config.VPN_GATEWAY_URL, secret: config.INTERNAL_SECRET },
    cidrs: [
      ...config.SSH_ALLOWED_CIDRS.split(","),
      ...(config.SSH_ALLOWLIST_LOCKED ? [] : await workspaceCidrs(org)),
    ],
    connectTimeout: config.SSH_CONNECT_TIMEOUT,
    outputLimit: config.SSH_OUTPUT_LIMIT,
  };
}
// Workspace setting: trust a host's key on first connection and pin it
// (OpenSSH accept-new). Keys that differ from a pinned one are still refused.
export const ACCEPT_NEW_HOST_KEYS = "ssh.acceptNewHostKeys";
export async function acceptsNewHostKeys(org: string) {
  const row = await db.systemSetting.findUnique({
    where: {
      organizationId_key: { organizationId: org, key: ACCEPT_NEW_HOST_KEYS },
    },
  });
  return row?.value === "true";
}
async function pinNewHostKey(
  s: {
    id: string;
    organizationId: string;
    host: string;
    port: number;
    fingerprint: string | null;
  },
  via: Pick<Connection, "vpn" | "bastion"> = {},
) {
  if (s.fingerprint) return s.fingerprint;
  const fingerprint = await scanHostKey(
    s.host,
    s.port,
    await sshLimits(s.organizationId),
    via,
  );
  // Only the first key seen is pinned, even if two connections race.
  const pinned = await db.server.updateMany({
    where: { id: s.id, fingerprint: null },
    data: { fingerprint },
  });
  if (pinned.count)
    await db.auditEvent.create({
      data: {
        organizationId: s.organizationId,
        principalId: "system",
        action: "host_key_auto_accepted",
        status: "success",
        serverId: s.id,
        correlationId: randomUUID(),
      },
    });
  const row = await db.server.findUniqueOrThrow({
    where: { id: s.id },
    select: { fingerprint: true },
  });
  return row.fingerprint;
}
export async function connection(
  serverId: string,
  org: string,
  inheritedVpn?: Connection["vpn"],
  allowAutoPin = true,
): Promise<Connection> {
  const s = await db.server.findFirstOrThrow({
    where: { id: serverId, organizationId: org },
    include: {
      identity: true,
      vpnProfile: true,
      bastion: { include: { identity: true, vpnProfile: true } },
    },
  });
  const effective = await resolveSettings(s.id, org);
  const bastionEffective = s.bastion ? await resolveSettings(s.bastion.id, org) : null;
  const effectiveVpnIds = [effective.values.vpnProfileId, bastionEffective?.values.vpnProfileId].filter(Boolean);
  if (new Set(effectiveVpnIds).size > 1) throw new BadRequestException("Conflicting VPN profiles on target and bastion");
  const map = async (row: { host: string; port: number; fingerprint: string | null; fileRoot: string }, settings: typeof effective.values): Promise<Connection> => {
    const identity = await db.sSHIdentity.findFirst({ where: { id: settings.identityId, organizationId: org } });
    if (!identity) throw new BadRequestException("Identity unavailable");
    const profile = settings.vpnProfileId ? await db.vpnProfile.findFirst({ where: { id: settings.vpnProfileId, organizationId: org } }) : null;
    if (settings.vpnProfileId && !profile) throw new BadRequestException("VPN profile unavailable");
    return {
      ...(profile ? { vpn: { id: profile.id, config: unseal(profile.encryptedConfig, config.ENCRYPTION_KEY, org + ":vpn:" + profile.id) } } : {}),
      host: row.host, port: row.port, username: settings.username,
      fingerprint: row.fingerprint, fileRoot: row.fileRoot,
      credential: unseal(identity.encryptedSecret, config.ENCRYPTION_KEY, org + ":" + identity.id),
    };
  };
  const result = {
    ...await map(s, effective.values),
    ...(s.bastion && bastionEffective ? { bastion: await map(s.bastion, bastionEffective.values) } : {}),
  };
  if (inheritedVpn) {
    if (result.vpn && result.vpn.id !== inheritedVpn.id)
      throw new BadRequestException(
        "Conflicting VPN profiles on target and bastion",
      );
    result.vpn = inheritedVpn;
  }
  if (s.bastion?.archived || s.bastion?.bastionId)
    throw new BadRequestException("Bastion is unavailable");
  if (allowAutoPin && await acceptsNewHostKeys(org)) {
    if (s.bastion && result.bastion)
      result.bastion.fingerprint = await pinNewHostKey(s.bastion, {
        vpn: result.vpn || result.bastion.vpn,
      });
    result.fingerprint = await pinNewHostKey(s, result);
  }
  return result;
}
export async function connectionPath(
  org: string,
  a: { vpnProfileId?: string | null; bastionId?: string | null },
): Promise<Pick<Connection, "vpn" | "bastion">> {
  const via: Pick<Connection, "vpn" | "bastion"> = {};
  if (a.vpnProfileId) {
    const profile = await db.vpnProfile.findFirst({
      where: { id: a.vpnProfileId, organizationId: org },
    });
    if (!profile) throw new NotFoundException("VPN profile unavailable");
    via.vpn = {
      id: profile.id,
      config: unseal(
        profile.encryptedConfig,
        config.ENCRYPTION_KEY,
        org + ":vpn:" + profile.id,
      ),
    };
  }
  if (a.bastionId) {
    const bastion = await db.server.findFirst({
      where: {
        id: a.bastionId,
        organizationId: org,
        archived: false,
        bastionId: null,
      },
    });
    if (!bastion) throw new NotFoundException("Bastion unavailable");
    via.bastion = await connection(bastion.id, org, via.vpn);
  }
  return via;
}
export async function operation(
  p: Principal,
  op: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<any> {
  if (kubernetesOperations.includes(op)) return kubernetesOperation(p, op, input, signal);
  if (op === "ssh_execute_many") return executeMany(p, input, signal);
  return singleOperation(p, op, input, signal);
}

async function executeMany(p: Principal, input: unknown, signal?: AbortSignal) {
  const a = parseOperation("ssh_execute_many", input);
  const ids: string[] = [...a.serverIds].sort();
  if (Math.ceil(ids.length / 3) * (a.timeoutMs + config.SSH_CONNECT_TIMEOUT) > 180000)
    throw new BadRequestException("Batch timeout is too long for this number of servers; reduce timeoutMs or serverIds");
  const { args: normalized, digest } = batchApprovalPayload(ids, a.command, a.timeoutMs);
  let subject = p;
  if (a.approvalId) {
    const approval = await db.approvalRequest.findFirst({ where: { id: a.approvalId, organizationId: p.organizationId, operation: "ssh_execute_many", status: "approved", consumedAt: null, expiresAt: { gt: new Date() }, argumentDigest: digest } });
    if (!approval) throw new ForbiddenException("Approval is missing, expired, mismatched, or already consumed");
    if (approval.principalId === p.id && p.kind === "agent" && !batchTokenAllowed(approval.tokenId, p.tokenId ? { id: p.tokenId, scopes: p.scopes } : null))
      throw new ForbiddenException("The requesting agent token is no longer the approved token");
    if (approval.principalId !== p.id) {
      if (p.kind !== "user" || !["owner", "administrator"].includes(p.role))
        throw new ForbiddenException("Only an administrator may execute another principal's approved batch");
      const agent = await db.agent.findFirst({ where: { id: approval.principalId, organizationId: p.organizationId, revoked: false, owner: { disabled: false } }, include: { owner: true, tokens: { where: { id: approval.tokenId ?? "", revoked: false, expiresAt: { gt: new Date() } } } } });
      if (agent) {
        const token = agent.tokens[0];
        const scopes: string[] = token ? effectiveAgentScopes(agent.level, JSON.parse(token.scopes), agent.owner.role) : [];
        if (!batchTokenAllowed(approval.tokenId, token ? { id: token.id, scopes } : null)) throw new ForbiddenException("The originally approved agent token is no longer active for batch execution");
        subject = { id: agent.id, organizationId: p.organizationId, kind: "agent", role: agent.level, scopes, tokenId: token.id, ownerId: agent.ownerId };
      } else {
        if (approval.tokenId) throw new ForbiddenException("The originally approved agent is unavailable");
        const user = await db.user.findFirst({ where: { id: approval.principalId, organizationId: p.organizationId, disabled: false } });
        if (!user) throw new ForbiddenException("Requesting principal is unavailable");
        subject = { id: user.id, organizationId: p.organizationId, kind: "user", role: user.role, scopes: [] };
      }
    }
  }
  if (subject.kind === "agent" && !subject.scopes.includes("ssh_execute_many"))
    throw new ForbiddenException({ code: "operation_not_in_token_scope", message: "Batch execution is not in the agent token scope" });
  // Check every target before creating or consuming the exact-set approval.
  const servers = await Promise.all(ids.map((id) => authorize(subject, id, "ssh_execute")));
  if (!a.approvalId) {
    const approval = await db.approvalRequest.create({ data: {
      organizationId: subject.organizationId, principalId: subject.id, tokenId: subject.tokenId ?? null, serverId: ids[0],
      operation: "ssh_execute_many", argumentDigest: digest,
      encryptedArguments: seal(normalized, config.ENCRYPTION_KEY, subject.organizationId),
      expiresAt: new Date(Date.now() + 600000),
    } });
    await audit(subject, "ssh_execute_many", "approval_pending", ids[0], approval.id);
    void announceApproval(subject, "ssh_execute_many", servers.map((s) => s.name).join(", "), approval.id);
    return { status: "approval_required", approvalId: approval.id, expiresAt: approval.expiresAt };
  }
  const createBatch = async (tx: Prisma.TransactionClient) => {
    const used = await tx.approvalRequest.updateMany({
      where: { id: a.approvalId, organizationId: subject.organizationId, principalId: subject.id, tokenId: subject.tokenId ?? null,
        serverId: ids[0], operation: "ssh_execute_many", argumentDigest: digest,
        status: "approved", consumedAt: null, expiresAt: { gt: new Date() } },
      data: { status: "consumed", consumedAt: new Date() },
    });
    if (used.count !== 1) throw new ForbiddenException("Approval is missing, expired, mismatched, or already consumed");
    const batch = await tx.batchDispatch.create({ data: { organizationId: subject.organizationId, principalId: subject.id } });
    const taskIds: string[] = [];
    for (const serverId of ids) {
      const args = { serverId, command: a.command, timeoutMs: a.timeoutMs };
      const task = await tx.backgroundTask.create({ data: {
        organizationId: subject.organizationId, principalId: subject.id, serverId,
        operation: "ssh_execute", encryptedArguments: seal(args, config.ENCRYPTION_KEY, subject.organizationId),
        status: "queued", tokenId: subject.tokenId, batchId: batch.id,
        expiresAt: new Date(Date.now() + 240000),
      } });
      await tx.commandExecution.create({ data: { id: task.id, organizationId: subject.organizationId, principalId: subject.id, serverId, operation: "ssh_execute", argumentDigest: hash(canonical(args)), status: "queued" } });
      taskIds.push(task.id);
    }
    await tx.auditEvent.create({ data: { organizationId: subject.organizationId, principalId: subject.id, action: "ssh_execute_many", status: "queued", serverId: ids[0], correlationId: batch.id } });
    return { batchId: batch.id, taskIds };
  };
  const batch = subject.kind === "agent"
    ? await reserveAgentCalls(subject.id, ids.length, createBatch)
    : await db.$transaction(createBatch);
  const abortBatch = async () => db.$transaction(async (tx) => {
    const stopped = await tx.batchDispatch.updateMany({ where: { id: batch.batchId, status: "pending" }, data: { status: "aborted" } });
    if (!stopped.count) return false;
    await tx.backgroundTask.updateMany({ where: { batchId: batch.batchId, status: "queued" }, data: { status: "failed" } });
    await tx.commandExecution.updateMany({ where: { id: { in: batch.taskIds }, status: "queued" }, data: { status: "failed" } });
    await tx.auditEvent.updateMany({ where: { correlationId: batch.batchId, action: "ssh_execute_many", status: "queued" }, data: { status: "failed" } });
    await tx.approvalRequest.updateMany({ where: { id: a.approvalId, status: "consumed", principalId: subject.id }, data: { status: "approved", consumedAt: null } });
    return true;
  });
  let job;
  try {
    job = await batchQueue.add("batch", { batchId: batch.batchId, taskIds: batch.taskIds, serverIds: ids }, { jobId: batch.batchId });
    const released = await db.batchDispatch.updateMany({ where: { id: batch.batchId, status: "pending" }, data: { status: "released" } });
    if (!released.count) throw new Error("Batch could not be released");
  } catch {
    const stopped = await abortBatch().catch(() => false);
    throw new BadRequestException({ message: stopped ? "Batch could not be queued; no command was started" : "Batch state is uncertain; inspect task status before retrying", batchId: batch.batchId, taskIds: batch.taskIds });
  }
  const cancelDispatched = () => {
    void db.$transaction(async (tx) => {
      const changed = await tx.batchDispatch.updateMany({ where: { id: batch.batchId, status: { in: ["released", "executing"] } }, data: { status: "aborted" } });
      if (!changed.count) return;
      await tx.backgroundTask.updateMany({ where: { batchId: batch.batchId, status: { in: ["queued", "running"] } }, data: { status: "cancelled" } });
      await tx.commandExecution.updateMany({ where: { id: { in: batch.taskIds }, status: { in: ["queued", "running"] } }, data: { status: "cancelled" } });
      await tx.auditEvent.updateMany({ where: { correlationId: batch.batchId, action: "ssh_execute_many", status: "queued" }, data: { status: "cancelled" } });
    }).catch((error) => console.error("Could not cancel dispatched batch", batch.batchId, error));
  };
  signal?.addEventListener("abort", cancelDispatched, { once: true });
  if (signal?.aborted) cancelDispatched();
  try {
    const result = await job.waitUntilFinished(batchEvents, 195000);
    return { results: result.results.map((entry: { serverId: string; status: string; result?: unknown; error?: string; taskId?: string }) => entry.status === "success" ? { ...entry, result: completedBatchResult(entry.result) } : entry) };
  } catch {
    throw new BadRequestException({ message: "Batch did not finish; inspect task status before retrying", batchId: batch.batchId, taskIds: batch.taskIds });
  } finally {
    signal?.removeEventListener("abort", cancelDispatched);
  }
}

async function singleOperation(
  p: Principal, op: string, input: unknown, signal?: AbortSignal,
): Promise<any> {
  const a = parseOperation(op, input);
  if (op === "servers_list") return listServersPage(p, a);
  if (op === "approval_get_status") {
    const row = await db.approvalRequest.findFirst({
      where: {
        id: a.approvalId,
        principalId: p.id,
        organizationId: p.organizationId,
      },
      select: { id: true, status: true, expiresAt: true, consumedAt: true },
    });
    if (!row) return kubernetesApprovalStatus(p, a.approvalId);
    return row;
  }
  if (op === "task_status" || op === "task_cancel") {
    const t = await db.backgroundTask.findFirst({
      where: {
        id: a.taskId,
        principalId: p.id,
        organizationId: p.organizationId,
      },
    });
    if (!t) throw new NotFoundException();
    const job = await queue.getJob(t.id);
    if (op === "task_cancel") {
      const changed = await db.backgroundTask.updateMany({
        where: { id: t.id, status: { in: ["queued", "running"] } },
        data: { status: "cancelled" },
      });
      if (changed.count === 0) {
        const current = await db.backgroundTask.findUniqueOrThrow({ where: { id: t.id } });
        return { taskId: t.id, status: current.status, message: "Task is already terminal" };
      }
      if (job && (await job.getState()) === "waiting") await job.remove();
      await audit(p, op, "requested", t.serverId);
      return {
        taskId: t.id,
        status: "cancelled",
        message: "Cancellation requested; remote child processes may continue",
      };
    }
    return {
      taskId: t.id,
      status: t.status,
      ...(job && (await job.getState()) === "completed"
        ? { result: job.returnvalue }
        : {}),
    };
  }
  const server = await authorize(p, a.serverId, op);
  if (op === "server_get_info") return { server: { ...numericMetadata(server), effectiveSettings: await resolveSettings(server.id, p.organizationId) } };
  // Read-only session calls still consume one agent call; reserve and record
  // together so concurrent callers cannot exceed the configured cap.
  if (p.kind === "agent" && (op === "ssh_session_status" || op === "ssh_disconnect")) {
    await reserveAgentCall(p.id, (tx) => tx.auditEvent.create({
      data: {
        organizationId: p.organizationId,
        principalId: p.id,
        action: `mcp:${op}`,
        status: "requested",
        serverId: server.id,
        correlationId: randomUUID(),
      },
    }));
  }
  if (op === "ssh_session_status")
    return {
      sessions: await db.sSHSession.findMany({
        where: {
          serverId: server.id,
          principalId: p.id,
          organizationId: p.organizationId,
        },
        take: 50,
        orderBy: { createdAt: "desc" },
      }),
    };
  if (op === "ssh_disconnect")
    return {
      disconnected: true,
      message:
        "MCP connections are operation-scoped and closed after each result",
    };
  const normalized = executionArgs(a),
    digest = hash(canonical(normalized));
  if (needsApproval(op)) {
    if (!a.approvalId) {
      const approval = await db.approvalRequest.create({
        data: {
          organizationId: p.organizationId,
          principalId: p.id,
          serverId: server.id,
          operation: op,
          argumentDigest: digest,
          encryptedArguments: seal(
            normalized,
            config.ENCRYPTION_KEY,
            p.organizationId,
          ),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      await audit(p, op, "approval_pending", server.id, approval.id);
      void announceApproval(p, op, server.name, approval.id);
      return {
        status: "approval_required",
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
      };
    }
    // An atomic compare-and-swap consumes the exact grant once, before any remote effect.
    const used = await db.approvalRequest.updateMany({
      where: {
        id: a.approvalId,
        organizationId: p.organizationId,
        principalId: p.id,
        serverId: server.id,
        operation: op,
        argumentDigest: digest,
        status: "approved",
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { status: "consumed", consumedAt: new Date() },
    });
    if (used.count !== 1)
      throw new ForbiddenException(
        "Approval is missing, expired, mismatched, or already consumed",
      );
  }
  const createTask = async (
    tx: Pick<typeof db, "backgroundTask" | "commandExecution">,
  ) => {
    const task = await tx.backgroundTask.create({
      data: {
        organizationId: p.organizationId,
        principalId: p.id,
        serverId: server.id,
        operation: op,
        encryptedArguments: seal(
          normalized,
          config.ENCRYPTION_KEY,
          p.organizationId,
        ),
        status: "queued",
        tokenId: p.tokenId,
        expiresAt: new Date(Date.now() + 120000),
      },
    });
    await tx.commandExecution.create({
      data: {
        id: task.id,
        organizationId: p.organizationId,
        principalId: p.id,
        serverId: server.id,
        operation: op,
        argumentDigest: digest,
        status: "queued",
      },
    });
    return task;
  };
  const task =
    p.kind === "agent"
      ? await reserveAgentCall(p.id, createTask)
      : await db.$transaction(createTask);
  await audit(p, op, "queued", server.id, task.id);
  const job = await queue.add(
    "operation",
    { taskId: task.id },
    { jobId: task.id },
  );
  if (a.async) return { taskId: task.id, status: "queued" };
  const cancel = () => {
    void db.backgroundTask
      .updateMany({
        where: { id: task.id, status: { in: ["queued", "running"] } },
        data: { status: "cancelled" },
      })
      .catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await job.waitUntilFinished(events, 90000);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "";
    if (connectionFailures.some((r) => r.test(reason)))
      throw new BadRequestException(reason);
    throw new BadRequestException({
      message:
        "Operation failed or did not finish in time. Inspect the task status.",
      taskId: task.id,
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
export async function claimTask(id: string) {
  const t = await db.backgroundTask.findUnique({ where: { id } });
  if (!t || t.status !== "queued" || t.expiresAt < new Date())
    throw new ForbiddenException("Task unavailable");
  if (t.batchId) {
    const batch = await db.batchDispatch.findUnique({ where: { id: t.batchId } });
    if (!batch || batch.status !== "released" || batch.organizationId !== t.organizationId || batch.principalId !== t.principalId)
      throw new ForbiddenException("Batch unavailable");
  }
  const agent = await db.agent.findUnique({
    where: { id: t.principalId },
    include: {
      owner: true,
      tokens: {
        where: {
          id: t.tokenId || "",
          revoked: false,
          expiresAt: { gt: new Date() },
        },
      },
    },
  });
  const user = agent
    ? null
    : await db.user.findUnique({ where: { id: t.principalId } });
  if (
    agent?.revoked ||
    agent?.owner.disabled ||
    (agent && !agent.tokens.length) ||
    user?.disabled ||
    (!agent && !user)
  )
    throw new ForbiddenException("Principal revoked");
  const p: Principal = {
    id: t.principalId,
    organizationId: t.organizationId,
    kind: agent ? "agent" : "user",
    role: agent?.level || user!.role,
    scopes: agent
      ? Array.from(new Set(agent.tokens.flatMap((v) => effectiveAgentScopes(agent.level, JSON.parse(v.scopes), agent.owner.role))))
      : [],
  };
  if (t.batchId && agent && !batchTokenAllowed(t.tokenId, agent.tokens[0] ? { id: agent.tokens[0].id, scopes: p.scopes } : null))
    throw new ForbiddenException({ code: "operation_not_in_token_scope", message: "The original agent token no longer permits batch execution" });
  await authorize(p, t.serverId, t.operation);
  const lease = randomUUID();
  const updated = await db.backgroundTask.updateMany({
    where: { id, status: "queued", expiresAt: { gt: new Date() } },
    data: { status: "running", leaseHash: hash(lease) },
  });
  if (updated.count !== 1) throw new ForbiddenException("Task already claimed");
  return {
    lease,
    connection: await connection(t.serverId, t.organizationId, undefined, !t.batchId),
    limits: await sshLimits(t.organizationId),
    operation: t.operation,
    args: unseal(t.encryptedArguments, config.ENCRYPTION_KEY, t.organizationId),
  };
}
