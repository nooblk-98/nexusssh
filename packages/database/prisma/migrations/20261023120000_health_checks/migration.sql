ALTER TABLE "Server" ADD COLUMN "healthFailureCategory" TEXT;
ALTER TABLE "Server" ADD COLUMN "latestHealthCheckId" TEXT;

CREATE TABLE "HealthBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued'
);
CREATE INDEX "HealthBatch_organizationId_status_expiresAt_idx" ON "HealthBatch"("organizationId", "status", "expiresAt");

CREATE TABLE "HealthCheck" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batchId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "failureCategory" TEXT,
  "observedFingerprint" TEXT,
  "fingerprintComparison" TEXT,
  "checkedHost" TEXT,
  "checkedPort" INTEGER,
  CONSTRAINT "HealthCheck_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HealthBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HealthCheck_batchId_idx" ON "HealthCheck"("batchId");
CREATE INDEX "HealthCheck_organizationId_serverId_createdAt_idx" ON "HealthCheck"("organizationId", "serverId", "createdAt");
