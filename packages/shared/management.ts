import { z } from "zod";
import { allOperations } from "../policy-engine/index.js";

export const WORKSPACE_MANAGE = "workspace_manage";
const id = z.uuid();
const name = z.string().trim().min(1).max(100);
const empty = z.object({}).strict();
const resource = z.object({ id }).strict();
const operations = z
  .array(
    z.enum(
      allOperations.filter((o) => o !== "terminal") as [string, ...string[]],
    ),
  )
  .max(60);
const credential = {
  name,
  kind: z.enum(["password", "key"]),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(65536).optional(),
  passphrase: z.string().max(4096).optional(),
};
const serverFields = {
  name,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).max(32),
  identityId: id,
  fileRoot: z.string().startsWith("/").max(4096),
  fingerprint: z.string().nullable().optional(),
  environment: z.enum(["development", "staging", "production"]).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(40).optional(),
  terminalSettings: z
    .record(z.string(), z.union([z.string(), z.boolean()]))
    .optional(),
  groupId: id.nullable().optional(),
  bastionId: id.nullable().optional(),
  vpnProfileId: id.nullable().optional(),
  favorite: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(32)).max(20).optional(),
};
const vpn = {
  name,
  description: z.string().max(2000).optional(),
  config: z.string().min(1).max(65536),
};
export const agentAccessSchema = z
  .object({
    level: z.enum(["viewer", "operator", "administrator", "custom"]),
    serverIds: z.array(id).max(100),
    operations,
    workspaceManagement: z.boolean().default(false),
  })
  .strict();
const limits = {
  maxCallsPerMinute: z.number().int().min(1).max(10000).nullable().optional(),
  maxCallsPerDay: z.number().int().min(1).max(1000000).nullable().optional(),
};
type Tool = {
  description: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  schema: z.ZodObject<any>;
  query?: string[];
};
const tool = (
  description: string,
  method: Tool["method"],
  path: string,
  schema = empty,
  query?: string[],
): Tool => ({ description, method, path, schema, query });
export const managementTools: Record<string, Tool> = {
  workspace_overview: tool(
    "Workspace server inventory, counts and recent activity.",
    "GET",
    "dashboard",
  ),
  workspace_servers_list: tool(
    "List all workspace servers, including archived records, folder, VPN and bastion selections. Does not return credentials.",
    "GET",
    "servers",
  ),
  server_create: tool(
    "Create an SSH server using a saved identity, optional folder, WireGuard VPN and SSH bastion. Root usernames are supported. Grants this agent its selected SSH tools on the new server.",
    "POST",
    "servers",
    z.object(serverFields).strict(),
  ),
  server_update: tool(
    "Update only supplied server fields; omitted fields remain unchanged.",
    "PATCH",
    "servers/:id",
    z
      .object({ id, changes: z.object(serverFields).partial().strict() })
      .strict(),
  ),
  server_archive: tool(
    "Archive a server, preserving audit history.",
    "DELETE",
    "servers/:id",
    resource,
  ),
  server_duplicate: tool(
    "Duplicate a server and its saved connection selections.",
    "POST",
    "servers/:id/duplicate",
    resource,
  ),
  server_move: tool(
    "Move a server into a folder; groupId null moves it to the top level.",
    "PATCH",
    "servers/:id/move",
    z.object({ id, groupId: id.nullable() }).strict(),
  ),
  server_scan_host_key: tool(
    "Read an SSH host fingerprint, optionally through VPN and bastion. Verify it before saving it on a server.",
    "POST",
    "servers/scan-host-key",
    z
      .object({
        host: serverFields.host,
        port: serverFields.port,
        vpnProfileId: serverFields.vpnProfileId,
        bastionId: serverFields.bastionId,
      })
      .strict(),
  ),
  identities_list: tool(
    "List SSH identity metadata and usage; private keys, passwords and passphrases are never returned.",
    "GET",
    "identities",
  ),
  identity_create: tool(
    "Add an encrypted SSH password or private-key identity. For kind key supply privateKey and optional passphrase; for password supply password.",
    "POST",
    "identities",
    z.object(credential).strict(),
  ),
  identity_update: tool(
    "Replace an SSH identity's name and credentials. Supply the complete replacement credential.",
    "PATCH",
    "identities/:id",
    z.object({ id, ...credential }).strict(),
  ),
  identity_delete: tool(
    "Delete an unused SSH identity. In-use identities cannot be deleted.",
    "DELETE",
    "identities/:id",
    resource,
  ),
  vpn_profiles_list: tool(
    "List WireGuard VPN profile summaries and server usage without key material.",
    "GET",
    "vpn-profiles",
  ),
  vpn_profile_create: tool(
    "Create an encrypted WireGuard VPN profile from client .conf text, including optional ListenPort.",
    "POST",
    "vpn-profiles",
    z.object(vpn).strict(),
  ),
  vpn_profile_update: tool(
    "Update VPN name or description; omit config to retain keys, or supply a replacement WireGuard configuration.",
    "PATCH",
    "vpn-profiles/:id",
    z.object({ id, changes: z.object(vpn).partial().strict() }).strict(),
  ),
  vpn_profile_delete: tool(
    "Delete an unused VPN profile. Remove all server references first, including archived servers.",
    "DELETE",
    "vpn-profiles/:id",
    resource,
  ),
  folders_list: tool(
    "List folders with parentId relationships. A null parentId means top level.",
    "GET",
    "groups",
  ),
  folder_create: tool(
    "Create a folder or subfolder using an optional parentId.",
    "POST",
    "groups",
    z
      .object({ name: name.max(80), parentId: id.nullable().optional() })
      .strict(),
  ),
  folder_update: tool(
    "Rename or move a folder, preserving its contents. parentId null moves it to top level; cycles are rejected.",
    "PATCH",
    "groups/:id",
    z
      .object({
        id,
        name: name.max(80).optional(),
        parentId: id.nullable().optional(),
      })
      .strict(),
  ),
  folder_delete: tool(
    "Delete a folder, moving its direct servers and subfolders to top level. No servers are deleted.",
    "DELETE",
    "groups/:id",
    resource,
  ),
  users_list: tool(
    "List workspace users and roles, without password hashes.",
    "GET",
    "users",
  ),
  user_create: tool(
    "Create a workspace user with a password and role.",
    "POST",
    "users",
    z
      .object({
        name,
        email: z.email(),
        password: z.string().min(12).max(200),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .strict(),
  ),
  user_update: tool(
    "Set a user's role and enabled/disabled state. The owner and this agent's owner cannot be changed.",
    "PATCH",
    "users/:id",
    z
      .object({
        id,
        disabled: z.boolean(),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .strict(),
  ),
  user_set_permissions: tool(
    "Replace a user's operation grants on one server.",
    "POST",
    "users/:id/permissions",
    z.object({ id, serverId: id, operations }).strict(),
  ),
  invitation_create: tool(
    "Create a one-day user invitation link. Returns the link; does not send it.",
    "POST",
    "invitations",
    z
      .object({
        email: z.email(),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .strict(),
  ),
  teams_list: tool("List teams, members and server grants.", "GET", "teams"),
  team_create: tool(
    "Create a team with workspace user IDs.",
    "POST",
    "teams",
    z.object({ name: name.max(80), userIds: z.array(id).max(100) }).strict(),
  ),
  team_update: tool(
    "Replace a team's name and membership.",
    "PATCH",
    "teams/:id",
    z
      .object({ id, name: name.max(80), userIds: z.array(id).max(100) })
      .strict(),
  ),
  team_set_servers: tool(
    "Replace a team's complete server grants. An empty servers array removes all grants.",
    "POST",
    "teams/:id/servers",
    z
      .object({
        id,
        servers: z
          .array(z.object({ serverId: id, operations }).strict())
          .max(500),
      })
      .strict(),
  ),
  team_delete: tool(
    "Delete a team and its grants; keep users and servers.",
    "DELETE",
    "teams/:id",
    resource,
  ),
  agents_list: tool(
    "List agent metadata, permission grants and token expiry; token values are not returned.",
    "GET",
    "agents",
  ),
  agent_create: tool(
    "Register an agent and return its bearer token once. Store that token securely. Workspace management requires administrator level.",
    "POST",
    "agents",
    agentAccessSchema.extend({
      name,
      expiresInDays: z.number().int().min(1).max(90).optional(),
      ...limits,
    }),
  ),
  agent_update_access: tool(
    "Replace an agent's level, SSH server/tool grants and workspace-management access. Updates existing tokens immediately without extending expiry.",
    "PATCH",
    "agents/:id/access",
    agentAccessSchema.extend({ id }),
  ),
  agent_update_limits: tool(
    "Set agent call budgets; null clears a limit.",
    "PATCH",
    "agents/:id/limits",
    z.object({ id, ...limits }).strict(),
  ),
  agent_activity: tool(
    "Read an agent's recent SSH executions and management audit events.",
    "GET",
    "agents/:id/activity",
    resource,
  ),
  agent_revoke: tool(
    "Revoke an agent and all its tokens immediately.",
    "DELETE",
    "agents/:id",
    resource,
  ),
  settings_get: tool("Read workspace SSH and MCP settings.", "GET", "settings"),
  settings_update: tool(
    "Update supplied workspace settings. Deployment-locked SSH networks remain locked.",
    "PATCH",
    "settings",
    z
      .object({
        acceptNewHostKeys: z.boolean().optional(),
        workspaceCidrs: z.array(z.string()).max(100).optional(),
        approvalWebhook: z.union([z.url().max(1000), z.literal("")]).optional(),
      })
      .strict(),
  ),
  sessions_list: tool("List workspace SSH sessions.", "GET", "sessions"),
  session_terminate: tool(
    "Terminate an active SSH session.",
    "DELETE",
    "sessions/:id",
    resource,
  ),
  snippets_list: tool("List saved command snippets.", "GET", "snippets"),
  snippet_create: tool(
    "Save a command snippet without executing it.",
    "POST",
    "snippets",
    z
      .object({ name: name.max(80), command: z.string().min(1).max(8192) })
      .strict(),
  ),
  snippet_delete: tool(
    "Delete a saved command snippet.",
    "DELETE",
    "snippets/:id",
    resource,
  ),
  audit_list: tool(
    "Read workspace audit events, optionally filtering by action and paging with a cursor.",
    "GET",
    "audit",
    z
      .object({ action: z.string().max(100).optional(), cursor: id.optional() })
      .strict(),
    ["action", "cursor"],
  ),
  approvals_list: tool(
    "List pending and recent approval requests. Approval decisions must be made by a human in the app.",
    "GET",
    "approvals",
  ),
};

export function managementRequest(name: string, input: unknown) {
  const entry = managementTools[name];
  if (!entry) throw new Error("Unknown management tool");
  const args = entry.schema.parse(input);
  let path = entry.path.replace(
    ":id",
    encodeURIComponent(String(args.id || "")),
  );
  const { id: _id, changes, ...rest } = args;
  if (entry.query) {
    const query = new URLSearchParams();
    for (const key of entry.query)
      if (rest[key] !== undefined) query.set(key, String(rest[key]));
    if (query.size) path += "?" + query.toString();
  }
  return {
    path,
    method: entry.method,
    body:
      entry.method === "GET" || entry.method === "DELETE"
        ? undefined
        : (changes ?? rest),
  };
}

export function managementRoute(method: string, path: string) {
  return Object.entries(managementTools).find(
    ([, entry]) =>
      entry.method === method &&
      new RegExp(
        "^/api/" + entry.path.replace(":id", "[0-9a-fA-F-]{36}") + "/?$",
      ).test(path),
  )?.[0];
}
