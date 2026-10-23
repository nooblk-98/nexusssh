-- CreateTable
CREATE TABLE "TeamPermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "serverId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "operations" TEXT NOT NULL,
    CONSTRAINT "TeamPermission_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamPermission_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamPermission_serverId_teamId_key" ON "TeamPermission"("serverId", "teamId");

-- AlterTable
ALTER TABLE "User" ADD COLUMN "recoveryCodes" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "maxCallsPerMinute" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "maxCallsPerDay" INTEGER;
