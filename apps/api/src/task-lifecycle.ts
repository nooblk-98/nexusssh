import { db } from "../../../packages/database/index.js";
import {
  administratorToken,
  effectiveAgentScopes,
  readOperations,
} from "../../../packages/policy-engine/index.js";
import { batchTokenAllowed } from "../../../packages/shared/operations.js";

type Store = typeof db;

type TaskAccess = {
  id: string;
  principalId: string;
  organizationId: string;
  serverId: string;
  operation: string;
  tokenId: string | null;
  batchId: string | null;
  status: string;
  expiresAt: Date;
};

// A worker polls this while a task runs. Revoked credentials, scopes and
// per-server grants must stop the command even when the original request was
// authorized. Users keep the legacy disabled/expiry checks.
export async function taskCancelled(t: TaskAccess, store: Store = db) {
  if (
    t.status === "cancelled" ||
    t.status === "interrupted" ||
    t.expiresAt < new Date()
  )
    return true;
  if (t.batchId) {
    const batch = await store.batchDispatch.findUnique({
      where: { id: t.batchId },
      select: { status: true },
    });
    if (batch?.status === "aborted") return true;
  }
  const agent = await store.agent.findUnique({
    where: { id: t.principalId },
    include: { owner: true },
  });
  if (!agent) {
    const user = await store.user.findFirst({
      where: { id: t.principalId, organizationId: t.organizationId },
      select: { disabled: true },
    });
    return !user || user.disabled;
  }
  if (
    agent.organizationId !== t.organizationId ||
    agent.revoked ||
    agent.owner.disabled
  )
    return true;
  // Every agent task was created with a token; a missing token means the
  // credential cannot be revalidated and the task must stop.
  if (!t.tokenId) return true;
  const token = await store.agentToken.findFirst({
    where: {
      id: t.tokenId,
      agentId: agent.id,
      revoked: false,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, scopes: true },
  });
  if (!token) return true;
  const scopes = effectiveAgentScopes(
    agent.level,
    JSON.parse(token.scopes),
    agent.owner.role,
  );
  if (
    !scopes.includes(t.operation) ||
    (agent.level === "viewer" && !readOperations.includes(t.operation))
  )
    return true;
  // Batch dispatches also require the original token to retain both scopes.
  if (t.batchId) return !batchTokenAllowed(t.tokenId, { id: token.id, scopes });
  // Administrator tokens cover the workspace; custom tokens also need the
  // per-server grant that was valid when the task was created.
  if (!administratorToken(agent.level, scopes)) {
    const grant = await store.agentPermission.findUnique({
      where: {
        agentId_serverId: { agentId: agent.id, serverId: t.serverId },
      },
      select: { operations: true },
    });
    if (!grant || !JSON.parse(grant.operations).includes(t.operation))
      return true;
  }
  return false;
}

type TaskIdentity = {
  id: string;
  organizationId: string;
  principalId: string;
  operation: string;
};

// The API marks a task running before preparing its connection. A setup
// failure after that point must release the lease and record a terminal state,
// otherwise the task stays "running" until the next API restart.
export async function failClaimedTask(
  task: TaskIdentity & { leaseHash: string },
  store: Store = db,
) {
  return store.$transaction(async (tx) => {
    const changed = await tx.backgroundTask.updateMany({
      where: {
        id: task.id,
        status: "running",
        leaseHash: task.leaseHash,
      },
      data: { status: "failed", leaseHash: null },
    });
    if (!changed.count) return false;
    await tx.commandExecution.updateMany({
      where: { id: task.id, status: "running" },
      data: { status: "failed" },
    });
    await tx.auditEvent.updateMany({
      where: {
        correlationId: task.id,
        organizationId: task.organizationId,
        principalId: task.principalId,
        action: task.operation,
        status: "queued",
      },
      data: { status: "failed" },
    });
    return true;
  });
}

// A task row and its audit record are written before queue.add. If the queue
// rejects the job, no worker can ever claim it, so release the queued rows
// instead of leaving an execution that looks pending forever.
export async function failQueuedTask(task: TaskIdentity, store: Store = db) {
  return store.$transaction(async (tx) => {
    const changed = await tx.backgroundTask.updateMany({
      where: { id: task.id, status: "queued" },
      data: { status: "failed" },
    });
    if (!changed.count) return false;
    await tx.commandExecution.updateMany({
      where: { id: task.id, status: "queued" },
      data: { status: "failed" },
    });
    await tx.auditEvent.updateMany({
      where: {
        correlationId: task.id,
        organizationId: task.organizationId,
        principalId: task.principalId,
        action: task.operation,
        status: "queued",
      },
      data: { status: "failed" },
    });
    return true;
  });
}
