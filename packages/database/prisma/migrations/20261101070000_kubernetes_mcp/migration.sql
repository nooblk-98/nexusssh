CREATE TABLE "KubernetesAgentPermission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "agentId" TEXT NOT NULL,
  "clusterId" TEXT NOT NULL,
  "operations" TEXT NOT NULL,
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("clusterId") REFERENCES "KubernetesCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KubernetesAgentPermission_agentId_clusterId_key" ON "KubernetesAgentPermission"("agentId", "clusterId");
CREATE TABLE "KubernetesApproval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "clusterId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "tokenId" TEXT,
  "operation" TEXT NOT NULL,
  "argumentDigest" TEXT NOT NULL,
  "configDigest" TEXT NOT NULL,
  "encryptedArguments" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedBy" TEXT,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  FOREIGN KEY ("clusterId") REFERENCES "KubernetesCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "KubernetesApproval_organizationId_createdAt_idx" ON "KubernetesApproval"("organizationId", "createdAt");
CREATE TABLE "KubernetesExecution" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "organizationId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "tokenId" TEXT,
  "clusterId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "encryptedResult" TEXT,
  "expiresAt" DATETIME NOT NULL,
  FOREIGN KEY ("clusterId") REFERENCES "KubernetesCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "KubernetesExecution_organizationId_principalId_createdAt_idx" ON "KubernetesExecution"("organizationId", "principalId", "createdAt");
