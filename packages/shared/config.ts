import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { z } from "zod";
// Compose passes unset optional variables as empty strings; treat them as unset.
for (const [k, v] of Object.entries(process.env))
  if (v === "") delete process.env[k];
// Secrets missing from the environment are generated once into SECRETS_FILE
// (a volume shared by api, mcp and ssh-worker) and reused on every start.
const generated = [
  "ENCRYPTION_KEY",
  "SESSION_SECRET",
  "INTERNAL_SECRET",
  "SETUP_TOKEN",
];
export const generatedSecrets: string[] = [];
const secretsFile = process.env.SECRETS_FILE;
if (secretsFile && generated.some((k) => !process.env[k])) {
  let stored: Record<string, string>;
  try {
    stored = JSON.parse(readFileSync(secretsFile, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    const fresh = Object.fromEntries(
      generated.map((k) => [k, randomBytes(32).toString("hex")]),
    );
    const tmp = `${secretsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
    try {
      linkSync(tmp, secretsFile);
      stored = fresh;
    } catch (le: any) {
      if (le.code !== "EEXIST") throw le;
      stored = JSON.parse(readFileSync(secretsFile, "utf8"));
    } finally {
      unlinkSync(tmp);
    }
  }
  for (const k of generated)
    if (!process.env[k] && stored[k]) {
      process.env[k] = stored[k];
      generatedSecrets.push(k);
    }
}
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url().optional(),
  DATABASE_URL: z.string().startsWith("file:"),
  REDIS_URL: z.url(),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  SESSION_SECRET: z.string().min(48),
  INTERNAL_SECRET: z.string().min(48),
  AUTH_ISSUER: z.url().optional(),
  AUTH_AUDIENCE: z.string().min(1).default("nexusssh"),
  MCP_PUBLIC_URL: z.url().optional(),
  MCP_AUTH_ISSUER: z.url().optional(),
  SSH_ALLOWED_CIDRS: z.string().min(1).default("0.0.0.0/0,::/0"),
  VPN_GATEWAY_URL: z.url().default("http://127.0.0.1:3003"),
  // "true" ignores networks added in Settings > Security and disables editing.
  SSH_ALLOWLIST_LOCKED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SSH_CONNECT_TIMEOUT: z.coerce.number().int().min(1000).default(10000),
  SSH_IDLE_TIMEOUT: z.coerce.number().int().min(1000).default(300000),
  SSH_MAX_SESSIONS: z.coerce.number().int().positive().default(20),
  // Interactive SSH operations the worker runs at once; batches have their own queue.
  SSH_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Host key reachability checks run at once by the health worker.
  SSH_HEALTH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  KUBERNETES_ALLOWED_CIDRS: z.string().min(1).default("0.0.0.0/0,::/0"),
  SSH_OUTPUT_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(4194304)
    .default(1048576),
  // Largest file accepted by interactive SFTP uploads (default 10 GiB).
  SFTP_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 ** 3),
  API_PORT: z.coerce.number().default(3001),
  MCP_PORT: z.coerce.number().default(3002),
  INTERNAL_API_URL: z.url().default("http://127.0.0.1:3001"),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  SFTP_FILE_HISTORY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SFTP_HISTORY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BACKUP_DIRECTORY: z.string().optional(),
  BACKUP_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  BACKUP_RETAIN_COUNT: z.coerce.number().int().min(1).max(365).default(14),
  BACKUP_UPLOAD_URL: z.url().startsWith("https://").optional(),
  BACKUP_WEBHOOK_URL: z.url().startsWith("https://").optional(),
  OIDC_ISSUER: z.url().startsWith("https://").optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_LABEL: z.string().max(80).default("Single sign-on"),
});
const parsed = schema.parse(process.env);
// Without APP_URL the platform serves whatever address it is reached on: browser
// requests must come from the same host they were sent to, and agent tokens use
// fixed identifiers so they stay valid across addresses.
const configured = parsed.APP_URL && new URL(parsed.APP_URL).origin;
export const config = {
  ...parsed,
  AUTH_ISSUER: parsed.AUTH_ISSUER ?? configured ?? "urn:nexusssh",
  MCP_AUTH_ISSUER: parsed.MCP_AUTH_ISSUER ?? configured ?? "urn:nexusssh",
  MCP_PUBLIC_URL:
    parsed.MCP_PUBLIC_URL ?? (configured ? configured + "/mcp" : undefined),
};
export const mcpAudience = config.MCP_PUBLIC_URL ?? "urn:nexusssh:mcp";
if (
  config.NODE_ENV === "production" &&
  config.APP_URL &&
  !config.APP_URL.startsWith("https://") &&
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(config.APP_URL).hostname,
  )
)
  throw new Error("Production APP_URL must use HTTPS");
type Headers = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
export function sameOrigin(headers: Headers) {
  const origin = first(headers.origin);
  if (!origin) return false;
  if (configured) return origin === configured;
  try {
    return new URL(origin).host === first(headers.host);
  } catch {
    return false;
  }
}
export function publicOrigin(headers: Headers) {
  if (configured) return configured;
  const proto =
    first(headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  return `${proto}://${first(headers.host)}`;
}
export function mcpEndpoint(headers: Headers) {
  return config.MCP_PUBLIC_URL ?? publicOrigin(headers) + "/mcp";
}
export const redisConnection = (() => {
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    maxRetriesPerRequest: null,
  };
})();
