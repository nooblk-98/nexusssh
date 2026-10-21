import "dotenv/config";
import { z } from "zod";
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
  AUTH_ISSUER: z.url(),
  AUTH_AUDIENCE: z.string().min(1),
  MCP_PUBLIC_URL: z.url(),
  MCP_AUTH_ISSUER: z.url(),
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
export const config = schema.parse(process.env);
if (config.NODE_ENV === "production" && !config.APP_URL.startsWith("https://"))
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
