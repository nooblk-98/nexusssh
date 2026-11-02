import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import { queue } from "./domain.js";

export async function boundedCheck(
  check: () => Promise<unknown>,
  timeoutMs = 2000,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export async function readiness() {
  const [database, redis, worker, vpn] = await Promise.all([
    boundedCheck(() => db.$queryRaw`SELECT 1`),
    boundedCheck(async () => {
      await (await queue.client).get("nexus:readiness-probe");
    }),
    boundedCheck(async () => {
      const value = await (
        await queue.client
      ).get("nexus:ssh-worker:heartbeat");
      if (!value || Date.now() - Number(value) > 30_000)
        throw new Error("Worker heartbeat stale");
    }),
    boundedCheck(async () => {
      const response = await fetch(config.VPN_GATEWAY_URL + "/health", {
        signal: AbortSignal.timeout(1800),
      });
      if (!response.ok) throw new Error("Gateway unavailable");
      await response.body?.cancel();
    }),
  ]);
  const checks = { database, redis, worker, vpn };
  return {
    status: Object.values(checks).every(Boolean) ? "ready" : "degraded",
    checks,
  };
}
