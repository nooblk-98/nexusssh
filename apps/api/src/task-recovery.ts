import { db } from "../../../packages/database/index.js";

// A previous API/worker lifetime may have reached the remote host. The
// outcome is unknown, so never make these tasks claimable again.
export async function reconcileRunningTasks() {
  return db.$transaction(async (tx) => {
    const running = await tx.backgroundTask.findMany({
      where: { status: "running" },
      select: { id: true },
    });
    if (!running.length) return 0;
    const ids = running.map(({ id }) => id);
    await tx.backgroundTask.updateMany({
      where: { id: { in: ids }, status: "running" },
      data: { status: "interrupted", leaseHash: null },
    });
    await tx.commandExecution.updateMany({
      where: { id: { in: ids } },
      data: { status: "interrupted" },
    });
    return ids.length;
  });
}
