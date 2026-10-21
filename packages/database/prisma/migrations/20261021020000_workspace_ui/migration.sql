-- AlterTable
ALTER TABLE "Server" ADD COLUMN "icon" TEXT NOT NULL DEFAULT 'linux';
ALTER TABLE "Server" ADD COLUMN "terminalSettings" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "preferences" TEXT NOT NULL DEFAULT '{}';
