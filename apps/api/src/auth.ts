import { UnauthorizedException, ForbiddenException } from "@nestjs/common";
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
    return {
      id: token.agentId,
      organizationId: token.agent.organizationId,
      kind: "agent",
      role: token.agent.level,
      scopes: JSON.parse(token.scopes),
      tokenId: token.id,
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
  human(p);
  if (!["owner", "administrator"].includes(p.role))
    throw new ForbiddenException("Administrator required");
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
