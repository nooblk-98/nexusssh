-- Keep per-agent call-limit counts bounded by principal and time window.
CREATE INDEX "CommandExecution_principalId_createdAt_idx" ON "CommandExecution"("principalId", "createdAt");
CREATE INDEX "AuditEvent_principalId_createdAt_idx" ON "AuditEvent"("principalId", "createdAt");
