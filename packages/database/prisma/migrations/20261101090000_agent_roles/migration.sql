-- Preserve effective restricted access while removing the old agent roles.
UPDATE "AgentPermission" SET "operations" = (SELECT json_group_array(value) FROM json_each("AgentPermission"."operations") WHERE value IN ('server_get_info', 'server_test_connection', 'ssh_connect', 'ssh_disconnect', 'ssh_session_status', 'ssh_list_directory', 'ssh_read_file', 'ssh_download_file', 'system_info', 'system_uptime', 'disk_usage', 'system_logs', 'service_status', 'kubernetes_get')) WHERE "agentId" IN (SELECT "id" FROM "Agent" WHERE "level" = 'viewer');
UPDATE "KubernetesAgentPermission" SET "operations" = (SELECT json_group_array(value) FROM json_each("KubernetesAgentPermission"."operations") WHERE value IN ('kubernetes_clusters_list', 'kubernetes_resources_list', 'kubernetes_pod_logs', 'kubernetes_cluster_check', 'kubernetes_execution_status')) WHERE "agentId" IN (SELECT "id" FROM "Agent" WHERE "level" = 'viewer');
UPDATE "AgentToken" SET "scopes" = (SELECT json_group_array(value) FROM json_each("AgentToken"."scopes") WHERE value IN ('server_get_info', 'server_test_connection', 'ssh_connect', 'ssh_disconnect', 'ssh_session_status', 'ssh_list_directory', 'ssh_read_file', 'ssh_download_file', 'system_info', 'system_uptime', 'disk_usage', 'system_logs', 'service_status', 'kubernetes_get', 'kubernetes_clusters_list', 'kubernetes_resources_list', 'kubernetes_pod_logs', 'kubernetes_cluster_check', 'kubernetes_execution_status')) WHERE "agentId" IN (SELECT "id" FROM "Agent" WHERE "level" = 'viewer');
UPDATE "AgentToken" SET "scopes" = (SELECT json_group_array(value) FROM json_each("AgentToken"."scopes") WHERE value NOT IN ('workspace_admin', 'workspace_manage')) WHERE "agentId" IN (SELECT "id" FROM "Agent" WHERE "level" <> 'administrator');
-- Administrator now means all current and future MCP resources and tools.
UPDATE "AgentToken" SET "scopes" = '["server_get_info","server_test_connection","ssh_connect","ssh_disconnect","ssh_session_status","ssh_list_directory","ssh_read_file","ssh_download_file","system_info","system_uptime","disk_usage","system_logs","service_status","kubernetes_get","ssh_execute","ssh_execute_many","ssh_write_file","ssh_upload_file","ssh_create_directory","ssh_delete_file","ssh_rename_file","service_start","service_stop","service_restart","kubernetes_clusters_list","kubernetes_resources_list","kubernetes_pod_logs","kubernetes_cluster_check","kubernetes_execution_status","kubernetes_execute","kubernetes_pod_exec","workspace_manage","workspace_admin"]' WHERE "agentId" IN (SELECT "id" FROM "Agent" WHERE "level" = 'administrator');

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "organizationId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'custom',
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "lastActivityAt" DATETIME,
  "maxCallsPerMinute" INTEGER,
  "maxCallsPerDay" INTEGER,
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Agent" SELECT "id", "createdAt", "updatedAt", "organizationId", "ownerId", "name", CASE WHEN "level" = 'administrator' THEN 'administrator' ELSE 'custom' END, "revoked", "lastActivityAt", "maxCallsPerMinute", "maxCallsPerDay" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE INDEX "Agent_organizationId_idx" ON "Agent"("organizationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
