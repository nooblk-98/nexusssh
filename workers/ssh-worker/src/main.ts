import { Worker } from "bullmq";
import { config, redisConnection } from "../../../packages/shared/config.js";
import {
  connectionFailures,
  operate,
  type Connection,
} from "../../../packages/ssh-core/index.js";
const headers = {
  "content-type": "application/json",
  "x-nexus-internal": config.INTERNAL_SECRET,
};
async function api(path: string, body?: unknown) {
  const response = await fetch(
    config.INTERNAL_API_URL + "/api/internal/" + path,
    {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error("Internal API refused worker request");
  return response.json();
}
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
const worker = new Worker(
  "nexus-ssh",
  async (job) => {
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
      await api(`tasks/${id}/finish`, {
        lease: claim.lease,
        status: "completed",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      return {
        serverId: claim.args.serverId,
        executionId: id,
        status: "completed",
        ...redact(result, claim.connection),
      };
    } catch (e) {
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
  { connection: redisConnection, concurrency: 4, lockDuration: 120000 },
);
worker.on("error", (error) => console.error("Worker unavailable:", error.name));
process.on("SIGTERM", () => void worker.close().then(() => process.exit(0)));
process.on("SIGINT", () => void worker.close().then(() => process.exit(0)));
