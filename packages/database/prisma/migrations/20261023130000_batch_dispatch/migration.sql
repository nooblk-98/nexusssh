ALTER TABLE "BackgroundTask" ADD COLUMN "batchId" TEXT;
CREATE TABLE "BatchDispatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX "BatchDispatch_organizationId_status_idx" ON "BatchDispatch"("organizationId", "status");
CREATE INDEX "BackgroundTask_batchId_idx" ON "BackgroundTask"("batchId");
