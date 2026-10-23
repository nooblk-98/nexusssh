import { UnauthorizedException, ForbiddenException } from "@nestjs/common";
import { reserveAgentCall } from "./agent-quota.js";
import { randomUUID } from "node:crypto";
import {
  managementRoute,
  WORKSPACE_MANAGE,
} from "../../../packages/shared/management.js";
import type { Request } from "express";
import { db } from "../../../packages/database/index.js";
import { hash, equal } from "../../../packages/shared/crypto.js";
import {
  config,
  mcpAudience,
  sameOrigin,
} from "../../../packages/shared/config.js";
import type { Principal } from "../../../packages/policy-engine/index.js";
export async function authenticate(req: Request): Promise<Principal> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = await db.agentToken.findUnique({
      where: { tokenHash: hash(auth.slice(7)) },
      include: { agent: { include: { owner: true } } },
    });
    if (
      !token ||
      token.revoked ||
      token.agent.revoked ||
      token.agent.owner.disabled ||
      token.expiresAt < new Date() ||
      token.issuer !== config.MCP_AUTH_ISSUER ||
      token.audience !== mcpAudience
    )
      throw new UnauthorizedException(
        "Invalid, expired, or revoked agent credential",
      );
    const scopes: string[] = JSON.parse(token.scopes);
    const managementOperation = managementRoute(
      req.method,
      req.originalUrl.split("?")[0],
    );
    if (managementOperation) {
      if (
        !scopes.includes(WORKSPACE_MANAGE) ||
        token.agent.level !== "administrator" ||
        !["owner", "administrator"].includes(token.agent.owner.role)
      )
        throw new ForbiddenException(
          "Enable Workspace management for an administrator agent to use this tool",
        );
      const entry = await reserveAgentCall(token.agentId, (tx) =>
        tx.auditEvent.create({
          data: {
            organizationId: token.agent.organizationId,
            principalId: token.agentId,
            action: "mcp:" + managementOperation,
            status: "requested",
            correlationId: randomUUID(),
          },
        }),
      );
      req.res?.once("finish", () => {
        void db.auditEvent
          .update({
            where: { id: entry.id },
            data: { status: req.res!.statusCode < 400 ? "success" : "failed" },
          })
          .catch(() => {});
      });
      await db.agent.update({
        where: { id: token.agentId },
        data: { lastActivityAt: new Date() },
      });
    }
    return {
      id: token.agentId,
      organizationId: token.agent.organizationId,
      kind: "agent",
      role: token.agent.level,
      scopes,
      tokenId: token.id,
      ownerId: token.agent.ownerId,
      managementOperation,
    };
  }
  const raw = req.cookies?.nexus_session;
  if (!raw) throw new UnauthorizedException();
  const session = await db.webSession.findUnique({
    where: { tokenHash: hash(raw) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || session.user.disabled)
    throw new UnauthorizedException();
  return {
    id: session.userId,
    organizationId: session.user.organizationId,
    kind: "user",
    role: session.user.role,
    scopes: [],
  };
}
export function human(p: Principal) {
  if (p.kind !== "user") throw new ForbiddenException("Human account required");
}
export function admin(p: Principal) {
  if (p.kind === "agent" && p.managementOperation) return;
  human(p);
  if (!["owner", "administrator"].includes(p.role))
    throw new ForbiddenException("Administrator required");
}
export function workspace(p: Principal) {
  if (p.kind === "agent" && p.managementOperation) return;
  human(p);
}
export function internal(req: Request) {
  if (
    !equal(
      req.headers["x-nexus-internal"]?.toString() || "",
      config.INTERNAL_SECRET,
    )
  )
    throw new UnauthorizedException();
}
export function origin(req: Request) {
  if (!sameOrigin(req.headers))
    throw new ForbiddenException("Invalid request origin");
}
