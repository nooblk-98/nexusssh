import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { db } from "../../../packages/database/index.js";
import {
  agentSshOperations,
  isAgentAdministrator,
  permitted,
  type Principal,
} from "../../../packages/policy-engine/index.js";
export async function authorize(p: Principal, id: string, op: string) {
  const server = await db.server.findFirst({
    where: { id, organizationId: p.organizationId, archived: false },
  });
  if (!server) throw new NotFoundException("Server unavailable");
  if (isAgentAdministrator(p) && agentSshOperations.includes(op)) return server;
  if (
    p.kind === "agent" &&
    !(p.managementOperation && op === "server_get_info")
  ) {
    const grant = await db.agentPermission.findUnique({
      where: { agentId_serverId: { agentId: p.id, serverId: id } },
    });
    if (!grant || !JSON.parse(grant.operations).includes(op))
      throw new ForbiddenException({
        code: "server_not_granted",
        message: "This server operation is not granted to the agent",
      });
    if (!p.scopes.includes(op))
      throw new ForbiddenException({
        code: "operation_not_in_token_scope",
        message: "This operation is not in the agent token scope",
      });
    if (!permitted(p, server.organizationId, op, JSON.parse(grant.operations)))
      throw new ForbiddenException({
        code: "agent_policy_denied",
        message: "The agent level does not permit this operation",
      });
    return server;
  }
  if (
    !(p.managementOperation && op === "server_get_info") &&
    !permitted(p, server.organizationId, op, await grants(p, id))
  )
    throw new ForbiddenException("Operation is not permitted for this server");
  return server;
}
// A person's operations on a server: their own grant plus every grant given
// to a team they belong to. Agents only have their own grant.
async function grants(p: Principal, serverId: string): Promise<string[]> {
  if (p.kind === "agent") {
    const grant = await db.agentPermission.findUnique({
      where: { agentId_serverId: { agentId: p.id, serverId } },
    });
    return grant ? JSON.parse(grant.operations) : [];
  }
  const [own, teams] = await Promise.all([
    db.serverPermission.findUnique({
      where: { serverId_userId: { serverId, userId: p.id } },
    }),
    db.teamPermission.findMany({
      where: { serverId, team: { members: { some: { userId: p.id } } } },
    }),
  ]);
  return [
    ...new Set(
      [own, ...teams].flatMap((g) => (g ? JSON.parse(g.operations) : [])),
    ),
  ];
}
export function serverVisibility(p: Principal) {
  return {
    organizationId: p.organizationId,
    ...(p.kind === "agent" && !p.managementOperation && !isAgentAdministrator(p)
      ? { archived: false, agentPermissions: { some: { agentId: p.id } } }
      : p.managementOperation || ["owner", "administrator"].includes(p.role)
        ? {}
        : {
            OR: [
              { permissions: { some: { userId: p.id } } },
              {
                teamPermissions: {
                  some: { team: { members: { some: { userId: p.id } } } },
                },
              },
            ],
          }),
  };
}
