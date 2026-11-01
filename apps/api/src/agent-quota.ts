import { HttpException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { db } from "../../../packages/database/index.js";

type Transaction = Prisma.TransactionClient;

// SQLite takes a write lock on this row before either count. The reservation
// must be inserted by the caller in the same transaction.
export async function reserveAgentCall<T>(
  agentId: string,
  record: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return reserveAgentCalls(agentId, 1, record);
}

export async function reserveAgentCalls<T>(
  agentId: string,
  count: number,
  record: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.update({
      where: { id: agentId },
      data: { lastActivityAt: new Date() },
    });
    const now = Date.now();
    for (const [duration, cap] of [
      [60000, agent.maxCallsPerMinute],
      [86400000, agent.maxCallsPerDay],
    ] as const) {
      if (!cap) continue;
      const since = new Date(now - duration);
      const [ssh, management] = await Promise.all([
        tx.commandExecution.count({
          where: { principalId: agentId, createdAt: { gt: since } },
        }),
        tx.auditEvent.count({
          where: {
            principalId: agentId,
            action: { startsWith: "mcp:" },
            createdAt: { gt: since },
          },
        }),
      ]);
      if (ssh + management + count > cap)
        throw new HttpException("Agent call limit reached", 429);
    }
    return record(tx);
  });
}
