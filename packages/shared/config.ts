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
  APP_URL: z.url(),
  DATABASE_URL: z.string().startsWith("file:"),
  REDIS_URL: z.url(),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  SESSION_SECRET: z.string().min(48),
  INTERNAL_SECRET: z.string().min(48),
  AUTH_ISSUER: z.url().optional(),
  AUTH_AUDIENCE: z.string().min(1).default("nexusssh"),
  MCP_PUBLIC_URL: z.url().optional(),
  MCP_AUTH_ISSUER: z.url().optional(),
  SSH_ALLOWED_CIDRS: z.string().min(1),
  SSH_CONNECT_TIMEOUT: z.coerce.number().int().min(1000).default(10000),
  SSH_IDLE_TIMEOUT: z.coerce.number().int().min(1000).default(300000),
  SSH_MAX_SESSIONS: z.coerce.number().int().positive().default(20),
  SSH_OUTPUT_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(4194304)
    .default(1048576),
  API_PORT: z.coerce.number().default(3001),
  MCP_PORT: z.coerce.number().default(3002),
  INTERNAL_API_URL: z.url().default("http://127.0.0.1:3001"),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
});
const parsed = schema.parse(process.env);
const origin = new URL(parsed.APP_URL).origin;
export const config = {
  ...parsed,
  AUTH_ISSUER: parsed.AUTH_ISSUER ?? origin,
  MCP_AUTH_ISSUER: parsed.MCP_AUTH_ISSUER ?? origin,
  MCP_PUBLIC_URL: parsed.MCP_PUBLIC_URL ?? origin + "/mcp",
};
const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(config.APP_URL).hostname,
);
if (
  config.NODE_ENV === "production" &&
  !config.APP_URL.startsWith("https://") &&
  !localhost
)
  throw new Error("Production APP_URL must use HTTPS");
export const redisConnection = (() => {
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    maxRetriesPerRequest: null,
  };
})();
