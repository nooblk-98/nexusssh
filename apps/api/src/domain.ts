import {
  HttpException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
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
} from "../../../packages/shared/operations.js";
import {
  permitted,
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
export async function authorize(p: Principal, id: string, op: string) {
  const server = await db.server.findFirst({
    where: { id, organizationId: p.organizationId, archived: false },
  });
  if (!server) throw new NotFoundException("Server unavailable");
  if (!permitted(p, server.organizationId, op, await grants(p, id)))
    throw new ForbiddenException("Operation is not permitted for this server");
  return server;
}
// A person's operations on a server: their own grant plus every grant given
// to a team they belong to. Agents only have their own grant.
async function grants(p: Principal, serverId: string): Promise<string[]> {
  if (p.kind === "agent") {
    const grant = await db.agentPermission.findUnique({
      where: { agentId_serverId: { agentId: p.id, serverId } },
    });
    return grant ? JSON.parse(grant.operations) : [];
  }
  const [own, teams] = await Promise.all([
    db.serverPermission.findUnique({
      where: { serverId_userId: { serverId, userId: p.id } },
    }),
    db.teamPermission.findMany({
      where: { serverId, team: { members: { some: { userId: p.id } } } },
    }),
  ]);
  return [
    ...new Set(
      [own, ...teams].flatMap((g) => (g ? JSON.parse(g.operations) : [])),
    ),
  ];
}
async function enforceAgentLimits(agentId: string) {
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  const window = async (ms: number) =>
    db.commandExecution.count({
      where: {
        principalId: agentId,
        createdAt: { gt: new Date(Date.now() - ms) },
      },
    });
  if (
    agent?.maxCallsPerMinute &&
    (await window(60000)) >= agent.maxCallsPerMinute
  )
    throw new HttpException("Agent rate limit reached (per minute)", 429);
  if (agent?.maxCallsPerDay && (await window(86400000)) >= agent.maxCallsPerDay)
    throw new HttpException("Agent daily call limit reached", 429);
}
export async function listServers(p: Principal) {
  return db.server.findMany({
    where: {
      organizationId: p.organizationId,
      ...(p.kind === "agent"
        ? { archived: false, agentPermissions: { some: { agentId: p.id } } }
        : ["owner", "administrator"].includes(p.role)
          ? {}
          : {
              OR: [
                { permissions: { some: { userId: p.id } } },
                {
                  teamPermissions: {
                    some: { team: { members: { some: { userId: p.id } } } },
                  },
                },
              ],
            }),
    },
    include: { group: true, tags: true },
    orderBy: [{ favorite: "desc" }, { name: "asc" }],
    take: 500,
  });
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
async function pinNewHostKey(s: {
  id: string;
  organizationId: string;
  host: string;
  port: number;
  fingerprint: string | null;
}) {
  if (s.fingerprint) return s.fingerprint;
  const fingerprint = await scanHostKey(
    s.host,
    s.port,
    await sshLimits(s.organizationId),
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
): Promise<Connection> {
  const s = await db.server.findFirstOrThrow({
    where: { id: serverId, organizationId: org },
    include: { identity: true, bastion: { include: { identity: true } } },
  });
  if (await acceptsNewHostKeys(org)) {
    if (s.bastion) s.bastion.fingerprint = await pinNewHostKey(s.bastion);
    // A host behind a jump host cannot be scanned directly; it keeps the prompt.
    else s.fingerprint = await pinNewHostKey(s);
  }
  const map = (s: any): Connection => ({
    host: s.host,
    port: s.port,
    username: s.username,
    fingerprint: s.fingerprint,
    fileRoot: s.fileRoot,
    credential: unseal(
      s.identity.encryptedSecret,
      config.ENCRYPTION_KEY,
      org + ":" + s.identityId,
    ),
  });
  return { ...map(s), ...(s.bastion ? { bastion: map(s.bastion) } : {}) };
}
export async function operation(
  p: Principal,
  op: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const a = parseOperation(op, input);
  if (op === "servers_list") return { servers: await listServers(p) };
  if (op === "approval_get_status") {
    const row = await db.approvalRequest.findFirst({
      where: {
        id: a.approvalId,
        principalId: p.id,
        organizationId: p.organizationId,
      },
      select: { id: true, status: true, expiresAt: true, consumedAt: true },
    });
    if (!row) throw new NotFoundException();
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
      await db.backgroundTask.update({
        where: { id: t.id },
        data: { status: "cancelled" },
      });
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
  if (op === "server_get_info") return { server };
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
  if (p.kind === "agent") await enforceAgentLimits(p.id);
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
  const task = await db.backgroundTask.create({
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
  await db.commandExecution.create({
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
      ? Array.from(new Set(agent.tokens.flatMap((v) => JSON.parse(v.scopes))))
      : [],
  };
  await authorize(p, t.serverId, t.operation);
  const lease = randomUUID();
  const updated = await db.backgroundTask.updateMany({
    where: { id, status: "queued", expiresAt: { gt: new Date() } },
    data: { status: "running", leaseHash: hash(lease) },
  });
  if (updated.count !== 1) throw new ForbiddenException("Task already claimed");
  return {
    lease,
    connection: await connection(t.serverId, t.organizationId),
    limits: await sshLimits(t.organizationId),
    operation: t.operation,
    args: unseal(t.encryptedArguments, config.ENCRYPTION_KEY, t.organizationId),
  };
}
