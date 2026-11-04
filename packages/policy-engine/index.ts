import {
  kubernetesOperations,
  kubernetesWriteOperations,
} from "../kubernetes/policy.js";
export type Principal = {
  id: string;
  organizationId: string;
  kind: "user" | "agent";
  role: string;
  scopes: string[];
  tokenId?: string;
  ownerId?: string;
  managementOperation?: string;
};
export const readOperations = [
  "server_get_info",
  "server_test_connection",
  "ssh_connect",
  "ssh_disconnect",
  "ssh_session_status",
  "ssh_list_directory",
  "ssh_read_file",
  "ssh_download_file",
  "system_info",
  "system_uptime",
  "disk_usage",
  "system_logs",
  "service_status",
  "kubernetes_get",
];
export const writeOperations = [
  "ssh_execute",
  "ssh_execute_many",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_create_directory",
  "ssh_delete_file",
  "ssh_rename_file",
  "service_start",
  "service_stop",
  "service_restart",
];
export const allOperations = [
  ...readOperations,
  ...writeOperations,
  "terminal",
];
export const WORKSPACE_ADMIN = "workspace_admin";
export const agentSshOperations = allOperations.filter(
  (op) => op !== "terminal",
);
export const administratorAgentScopes = [
  ...agentSshOperations,
  ...kubernetesOperations,
  "workspace_manage",
  WORKSPACE_ADMIN,
];
export function administratorToken(level: string, scopes: string[]) {
  return level === "administrator" && scopes.includes(WORKSPACE_ADMIN);
}
export function isAgentAdministrator(p: Principal) {
  return p.kind === "agent" && administratorToken(p.role, p.scopes);
}
export function effectiveAgentScopes(
  level: string,
  scopes: string[],
  ownerRole?: string,
) {
  if (
    administratorToken(level, scopes) &&
    ownerRole !== undefined &&
    !["owner", "administrator"].includes(ownerRole)
  )
    return [];
  return administratorToken(level, scopes)
    ? [...administratorAgentScopes]
    : scopes.filter((scope) => scope !== WORKSPACE_ADMIN);
}
export function needsApproval(op: string) {
  return kubernetesWriteOperations.includes(op);
}
export function permitted(
  p: Principal,
  org: string,
  operation: string,
  grants: string[],
) {
  if (p.organizationId !== org) return false;
  if (p.kind === "user" && ["owner", "administrator"].includes(p.role))
    return true;
  if (isAgentAdministrator(p) && administratorAgentScopes.includes(operation))
    return true;
  if (!grants.includes(operation)) return false;
  if (p.kind === "agent" && !p.scopes.includes(operation)) return false;
  if (p.role === "viewer" && !readOperations.includes(operation)) return false;
  return true;
}
