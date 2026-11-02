CREATE TABLE "KubernetesCluster" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "server" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "namespace" TEXT NOT NULL DEFAULT 'default',
  "authentication" TEXT NOT NULL,
  "encryptedConfig" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "version" TEXT,
  "lastCheckedAt" DATETIME,
  "lastError" TEXT,
  CONSTRAINT "KubernetesCluster_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KubernetesCluster_organizationId_name_key" ON "KubernetesCluster"("organizationId", "name");
CREATE INDEX "KubernetesCluster_organizationId_idx" ON "KubernetesCluster"("organizationId");
