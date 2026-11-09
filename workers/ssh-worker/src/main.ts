import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import {
  requestContext,
  correlationId,
  logEvent,
} from "../../../packages/shared/request-context.js";
import { config, redisConnection } from "../../../packages/shared/config.js";
import {
  connectionFailures,
  operate,
  type Connection,
} from "../../../packages/ssh-core/index.js";
import { finishedStatus } from "./finish-status.js";
const headers = {
  "content-type": "application/json",
  "x-nexus-internal": config.INTERNAL_SECRET,
};
async function api(path: string, body?: unknown) {
  const response = await fetch(
    config.INTERNAL_API_URL + "/api/internal/" + path,
    {
      method: body ? "POST" : "GET",
      headers: { ...headers, "x-nexus-correlation-id": correlationId() },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error("Internal API refused worker request");
  return response.json();
}
const CANCELLED_MESSAGE =
  "Command was cancelled; remote side effects may have occurred";
function redact(value: any, c: Connection): any {
  if (typeof value === "string") {
    let result = value;
    for (const secret of Object.values(c.credential))
      if (secret) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /((?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*)\S+/gi,
        "$1[REDACTED]",
      );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, c));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, c)]),
    );
  return value;
}
// Bound Redis job results at the worker, after redaction and before BullMQ stores them.
function boundedResult(
  value: Record<string, any>,
  remaining: { bytes: number },
) {
  let targetBytes = Math.max(0, Math.min(16384, remaining.bytes));
  let truncated = false;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        typeof item !== "string" ||
        !["stdout", "stderr", "output"].includes(key)
      )
        return [key, item];
      const bytes = Buffer.from(item, "utf8");
      let end = Math.max(0, Math.min(bytes.length, targetBytes));
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let kept = "";
      while (end > 0) {
        try {
          kept = decoder.decode(bytes.subarray(0, end));
          break;
        } catch {
          end--;
        }
      }
      const used = Buffer.byteLength(kept);
      targetBytes = Math.max(0, targetBytes - used);
      remaining.bytes = Math.max(0, remaining.bytes - used);
      if (used < bytes.length) truncated = true;
      return [key, kept];
    }),
  );
  return { ...result, ...(truncated ? { truncated: true } : {}) };
}
async function runBatch(
  batchId: string,
  taskIds: string[],
  serverIds: string[],
) {
  let released = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await api(`batches/${batchId}/status`);
    if (state.status === "released") {
      released = true;
      break;
    }
    if (state.status === "aborted") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!released)
    return {
      results: taskIds.map((taskId, index) => ({
        serverId: serverIds[index],
        taskId,
        status: "failed",
        error: "Batch was not released",
      })),
    };
  const claims: any[] = new Array(taskIds.length);
  try {
    // Claim and reauthorize every target before any SSH command starts. Claims run a
    // few at a time; any failure aborts the batch before a command is sent.
    let nextClaim = 0,
      claimFailed = false;
    // Every lane settles before the batch is aborted, so no claim lands after the abort.
    await Promise.all(
      Array.from({ length: Math.min(4, taskIds.length) }, async () => {
        while (!claimFailed && nextClaim < taskIds.length) {
          const index = nextClaim++;
          try {
            claims[index] = await api(`tasks/${taskIds[index]}/claim`, {});
          } catch {
            claimFailed = true;
          }
        }
      }),
    );
    if (claimFailed) throw new Error("Batch preflight failed");
  } catch {
    await api(`batches/${batchId}/abort`, {}).catch(() => {});
    return {
      results: taskIds.map((taskId, index) => ({
        serverId: serverIds[index],
        taskId,
        status: "failed",
        error: "Batch preflight failed; no command was started",
      })),
    };
  }
  try {
    await api(`batches/${batchId}/start`, {});
  } catch {
    await api(`batches/${batchId}/abort`, {}).catch(() => {});
    return {
      results: taskIds.map((taskId, index) => ({
        serverId: serverIds[index],
        taskId,
        status: "failed",
        error: "Batch could not start; no command was started",
      })),
    };
  }
  const results: any[] = new Array(taskIds.length);
  const outputBudget = { bytes: 65536 };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, taskIds.length) }, async () => {
      while (next < taskIds.length) {
        const batch = await api(`batches/${batchId}/status`).catch(() => ({
          status: "aborted",
        }));
        if (batch.status !== "executing") break;
        const index = next++;
        const taskId = taskIds[index];
        const claim = claims[index];
        const abort = new AbortController();
        const timer = setInterval(() => {
          void api(`tasks/${taskId}/status`)
            .then((state) => {
              if (state.cancelled) abort.abort();
            })
            .catch(() => abort.abort());
        }, 1000);
        try {
          const result = await operate(
            claim.connection,
            claim.limits ?? {
              cidrs: config.SSH_ALLOWED_CIDRS.split(","),
              connectTimeout: config.SSH_CONNECT_TIMEOUT,
              outputLimit: config.SSH_OUTPUT_LIMIT,
            },
            claim.operation,
            claim.args,
            abort.signal,
          );
          const state = await api(`tasks/${taskId}/status`);
          if (state.cancelled || abort.signal.aborted)
            throw new Error("Batch command was cancelled");
          const finished = await api(`tasks/${taskId}/finish`, {
            lease: claim.lease,
            status: "completed",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            connectedHost: claim.connection.host,
            connectedPort: claim.connection.port,
          });
          if (finishedStatus(finished, "completed") === "cancelled") {
            results[index] = {
              serverId: claim.args.serverId,
              taskId,
              status: "cancelled",
              error: CANCELLED_MESSAGE,
            };
            continue;
          }
          results[index] = {
            serverId: claim.args.serverId,
            taskId,
            status: "success",
            result: boundedResult(
              {
                serverId: claim.args.serverId,
                executionId: taskId,
                status: "completed",
                ...redact(result, claim.connection),
              },
              outputBudget,
            ),
          };
        } catch (error) {
          await api(`tasks/${taskId}/finish`, {
            lease: claim.lease,
            status: abort.signal.aborted ? "cancelled" : "failed",
          }).catch(() => {});
          const message = error instanceof Error ? error.message : "";
          results[index] = {
            serverId: claim.args.serverId,
            taskId,
            status: abort.signal.aborted ? "cancelled" : "failed",
            error: abort.signal.aborted
              ? "Command interrupted; remote side effects may have occurred"
              : connectionFailures.some((rule) => rule.test(message))
                ? message
                : "SSH operation failed",
          };
        } finally {
          clearInterval(timer);
        }
      }
    }),
  );
  for (let index = 0; index < taskIds.length; index++)
    results[index] ??= {
      serverId: serverIds[index],
      taskId: taskIds[index],
      status: "cancelled",
      error: "Batch stopped before this command started",
    };
  await api(`batches/${batchId}/complete`, {}).catch(() => {});
  return { results };
}
const worker = new Worker(
  "nexus-ssh",
  async (job) =>
    requestContext.run(
      { correlationId: job.data.requestId || randomUUID() },
      async () => {
        logEvent("task_started", { taskId: job.data.taskId });
        // Jobs queued before the batch queue split must fail closed on deployment.
        if (job.name === "batch") {
          await api(`batches/${job.data.batchId}/abort`, {}).catch(() => {});
          throw new Error("Legacy batch job must be resubmitted");
        }
        const id = job.data.taskId;
        const claim = await api(`tasks/${id}/claim`, {});
        const abort = new AbortController();
        const timer = setInterval(() => {
          void api(`tasks/${id}/status`)
            .then((s) => {
              if (s.cancelled) abort.abort();
            })
            .catch(() => abort.abort());
        }, 1000);
        try {
          const result = await operate(
            claim.connection,
            // The API includes networks added under Settings > Security.
            claim.limits ?? {
              cidrs: config.SSH_ALLOWED_CIDRS.split(","),
              connectTimeout: config.SSH_CONNECT_TIMEOUT,
              outputLimit: config.SSH_OUTPUT_LIMIT,
            },
            claim.operation,
            claim.args,
            abort.signal,
          );
          const finished = await api(`tasks/${id}/finish`, {
            lease: claim.lease,
            status: "completed",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            connectedHost: claim.connection.host,
            connectedPort: claim.connection.port,
          });
          if (finishedStatus(finished, "completed") === "cancelled") {
            // Cancellation won the race; drop the output so callers see the
            // same terminal state the database recorded.
            logEvent("task_cancelled", { taskId: id });
            return {
              serverId: claim.args.serverId,
              executionId: id,
              status: "cancelled",
              error: CANCELLED_MESSAGE,
            };
          }
          logEvent("task_completed", { taskId: id });
          return {
            serverId: claim.args.serverId,
            executionId: id,
            status: "completed",
            ...redact(result, claim.connection),
          };
        } catch (e) {
          logEvent("task_failed", {
            taskId: id,
            errorType: e instanceof Error ? e.name : "unknown",
          });
          await api(`tasks/${id}/finish`, {
            lease: claim.lease,
            status: abort.signal.aborted ? "cancelled" : "failed",
          }).catch(() => {});
          // Connection-stage reasons carry no remote output or secrets, so the
          // browser can act on them; everything else stays generic.
          const message = e instanceof Error ? e.message : "";
          throw new Error(
            connectionFailures.some((r) => r.test(message))
              ? message
              : "SSH operation failed. Check connectivity, host fingerprint, path permissions, and timeout.",
          );
        } finally {
          clearInterval(timer);
        }
      },
    ),
  // A stalled job may have already run a remote command. Never replay it.
  {
    connection: redisConnection,
    concurrency: config.SSH_WORKER_CONCURRENCY,
    lockDuration: 120000,
    maxStalledCount: 0,
  },
);
// Batch work has its own capacity so queued batches cannot occupy interactive slots.
// Each batch runs at most three SSH commands; interactive work keeps its own slots.
const batchWorker = new Worker(
  "nexus-ssh-batch",
  async (job) =>
    requestContext.run(
      { correlationId: job.data.requestId || randomUUID() },
      () => runBatch(job.data.batchId, job.data.taskIds, job.data.serverIds),
    ),
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 120000,
    maxStalledCount: 0,
  },
);
worker.on("failed", (job) => {
  if (!job) return;
  if (job.name === "batch") {
    void api(`batches/${job.data.batchId}/abort`, {}).catch(() => {});
    return;
  }
  // A job can fail before or after the API records its claim (a lost claim
  // response, an interrupted finish call, or a stalled lock). Interrupting is
  // idempotent and only changes a task that is still running, so it closes the
  // window where the task would otherwise stay claimed forever.
  void api(`tasks/${job.data.taskId}/interrupt`, {}).catch((cause) =>
    console.error("Could not record interrupted task:", cause),
  );
});
worker.on("error", (error) => console.error("Worker unavailable:", error.name));
batchWorker.on("failed", (job) => {
  if (job) void api(`batches/${job.data.batchId}/abort`, {}).catch(() => {});
});
batchWorker.on("error", (error) =>
  console.error("Batch worker unavailable:", error.name),
);
const heartbeat = async () => {
  try {
    await (
      await worker.client
    ).set("nexus:ssh-worker:heartbeat", String(Date.now()), { EX: 30 });
  } catch {
    logEvent("worker_heartbeat_failed");
  }
};
void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), 10_000);
const shutdown = () => {
  clearInterval(heartbeatTimer);
  void Promise.all([worker.close(), batchWorker.close()]).then(() =>
    process.exit(0),
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
