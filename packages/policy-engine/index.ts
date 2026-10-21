export type Principal = {
  id: string;
  organizationId: string;
  kind: "user" | "agent";
  role: string;
  scopes: string[];
  tokenId?: string;
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
  "system_logs",
  "service_status",
];
export const writeOperations = [
  "ssh_execute",
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
export function needsApproval(op: string) {
  return writeOperations.includes(op);
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
  if (!grants.includes(operation)) return false;
  if (p.kind === "agent" && !p.scopes.includes(operation)) return false;
  if (p.role === "viewer" && !readOperations.includes(operation)) return false;
  return true;
}
