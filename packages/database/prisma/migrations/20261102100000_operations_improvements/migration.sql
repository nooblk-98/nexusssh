ALTER TABLE "AuditEvent" ADD COLUMN "requestId" TEXT;
ALTER TABLE "WebSession" ADD COLUMN "oidcIdentityId" TEXT;
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");
CREATE TABLE "WorkspacePreset" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "layout" TEXT NOT NULL
);
CREATE UNIQUE INDEX "WorkspacePreset_userId_name_key" ON "WorkspacePreset"("userId", "name");
CREATE INDEX "WorkspacePreset_organizationId_userId_idx" ON "WorkspacePreset"("organizationId", "userId");
CREATE TABLE "Runbook" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Runbook_organizationId_name_key" ON "Runbook"("organizationId", "name");
CREATE TABLE "RunbookRevision" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runbookId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "version" INTEGER NOT NULL,
  "encryptedDefinition" TEXT NOT NULL,
  CONSTRAINT "RunbookRevision_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "Runbook"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RunbookRevision_runbookId_version_key" ON "RunbookRevision"("runbookId", "version");
CREATE TABLE "FileRevision" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organizationId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "serverId" TEXT NOT NULL,
  "connectionDigest" TEXT NOT NULL, "path" TEXT NOT NULL, "digest" TEXT NOT NULL, "encryptedContent" TEXT NOT NULL
);
CREATE INDEX "FileRevision_organizationId_serverId_path_createdAt_idx" ON "FileRevision"("organizationId", "serverId", "path", "createdAt");
CREATE TABLE "OidcIdentity" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL, "issuer" TEXT NOT NULL, "subject" TEXT NOT NULL
);
CREATE UNIQUE INDEX "OidcIdentity_issuer_subject_key" ON "OidcIdentity"("issuer", "subject");
CREATE INDEX "OidcIdentity_userId_idx" ON "OidcIdentity"("userId");
