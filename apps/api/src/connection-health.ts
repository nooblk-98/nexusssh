import { db } from "../../../packages/database/index.js";

export async function markSshReachable(
  organizationId: string,
  serverId: string,
  target: { host: string; port: number },
) {
  // Clearing the generation prevents a probe queued before this authenticated
  // connection from overwriting its newer evidence when that probe finishes.
  await db.server.updateMany({
    where: {
      id: serverId,
      organizationId,
      archived: false,
      host: target.host,
      port: target.port,
    },
    data: {
      status: "reachable",
      lastCheckedAt: new Date(),
      healthFailureCategory: null,
      latestHealthCheckId: null,
    },
  });
}
