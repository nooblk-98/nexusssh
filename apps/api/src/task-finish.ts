import { ForbiddenException } from "@nestjs/common";
import { db } from "../../../packages/database/index.js";

export async function finishTask(
  id: string,
  leaseHash: string,
  result: { status: "completed" | "failed" | "cancelled"; exitCode?: number | null; durationMs?: number },
) {
  return db.$transaction(async (tx) => {
    const running = await tx.backgroundTask.updateMany({
      where: { id, status: "running", leaseHash },
      data: { status: result.status, leaseHash: null },
    });
    let status: typeof result.status = result.status;
    if (!running.count) {
      const cancelled = await tx.backgroundTask.updateMany({
        where: { id, status: "cancelled", leaseHash },
        data: { leaseHash: null },
      });
      if (!cancelled.count) throw new ForbiddenException("Task already finished");
      status = "cancelled";
    }
    await tx.commandExecution.update({
      where: { id },
      data: { status, exitCode: result.exitCode, durationMs: result.durationMs },
    });
    return status;
  });
}
