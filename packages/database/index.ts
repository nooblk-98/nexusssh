import { PrismaClient } from "@prisma/client";
export const db = new PrismaClient();
export async function initializeDatabase() {
  await db.$connect();
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await db.$queryRawUnsafe("PRAGMA busy_timeout=5000");
  await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  const check = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>(
    "PRAGMA integrity_check",
  );
  if (check[0]?.integrity_check !== "ok")
    throw new Error("SQLite integrity check failed");
  await db.sSHSession.updateMany({
    where: { status: "active" },
    data: { status: "interrupted", endedAt: new Date() },
  });
}
