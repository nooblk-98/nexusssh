import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  Query,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db } from "../../../packages/database/index.js";
import {
  config,
  mcpAudience,
  mcpEndpoint,
  publicOrigin,
} from "../../../packages/shared/config.js";
import {
  hash,
  secret,
  seal,
  unseal,
  equal,
} from "../../../packages/shared/crypto.js";
import {
  allOperations,
  readOperations,
} from "../../../packages/policy-engine/index.js";
import { authenticate, admin, human, internal } from "./auth.js";
import {
  audit,
  listServers,
  authorize,
  operation,
  claimTask,
} from "./domain.js";
import { verifyTotp, newTotp, totpStep } from "./totp.js";
const credentials = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(["password", "key"]),
    password: z.string().max(4096).optional(),
    privateKey: z.string().max(65536).optional(),
    passphrase: z.string().max(4096).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.kind === "password" ? Boolean(v.password) : Boolean(v.privateKey),
    "Credential is required",
  );
const serverSchema = z
  .object({
    name: z.string().min(1).max(100),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    identityId: z.uuid(),
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .nullable()
      .default(null),
    environment: z
      .enum(["development", "staging", "production"])
      .default("development"),
    description: z.string().max(2000).default(""),
    fileRoot: z
      .string()
      .startsWith("/")
      .max(4096)
      .refine(
        (v) => !v.includes("..") && v !== "/",
        "Use a restricted file root",
      ),
    groupId: z.uuid().nullable().default(null),
    bastionId: z.uuid().nullable().default(null),
    favorite: z.boolean().default(false),
    archived: z.boolean().default(false),
    tags: z.array(z.string().min(1).max(32)).max(20).default([]),
  })
  .strict();
const login = z.object({
  email: z.email(),
  password: z.string().min(12).max(200),
  code: z.string().optional(),
});
@ApiTags("NexusSSH")
@ApiCookieAuth()
@Controller("api")
export class AppController {
  @Get("health") health() {
    return { status: "ok", service: "api" };
  }
  @Get("auth/status") async status() {
    return { setupRequired: (await db.user.count()) === 0 };
  }
  @Post("auth/setup") async setup(@Body() body: unknown) {
    const a = login
      .extend({
        name: z.string().min(1).max(80),
        organization: z.string().min(1).max(80),
        setupToken: z.string(),
      })
      .parse(body);
    if (
      !process.env.SETUP_TOKEN ||
      !equal(a.setupToken, process.env.SETUP_TOKEN)
    )
      throw new UnauthorizedException("Invalid setup token");
    const passwordHash = await bcrypt.hash(a.password, 12);
    await db.$transaction(async (tx) => {
      if (await tx.user.count())
        throw new ForbiddenException("Setup already completed");
      const org = await tx.organization.create({
        data: { name: a.organization },
      });
      await tx.user.create({
        data: {
          organizationId: org.id,
          name: a.name,
          email: a.email.toLowerCase(),
          passwordHash,
          role: "owner",
        },
      });
    });
    return { created: true };
  }
  @Post("auth/login") async login(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const a = login.parse(body);
    const user = await db.user.findUnique({
      where: { email: a.email.toLowerCase() },
    });
    const valid = await bcrypt.compare(
      a.password,
      user?.passwordHash ||
        "$2b$12$9TU3fZWsNjf0YJC3PVfDCO9Qv4bMLVeHj0Pt.5gQe7VStKjd8LFyS",
    );
    if (!user || user.disabled || !valid) {
      if (user)
        await audit(
          {
            id: user.id,
            organizationId: user.organizationId,
            kind: "user",
            role: user.role,
            scopes: [],
          },
          "login",
          "failed",
        );
      throw new UnauthorizedException("Invalid credentials");
    }
    const p = {
      id: user.id,
      organizationId: user.organizationId,
      kind: "user" as const,
      role: user.role,
      scopes: [],
    };
    if (
      user.totpSecret &&
      !verifyTotp(
        unseal<string>(user.totpSecret, config.ENCRYPTION_KEY, user.id),
        a.code || "",
      )
    ) {
      await audit(p, "login", "failed_mfa");
      throw new UnauthorizedException("Valid authenticator code required");
    }
    if (user.totpSecret) {
      const step = totpStep(
        unseal<string>(user.totpSecret, config.ENCRYPTION_KEY, user.id),
        a.code || "",
      );
      if (
        step === null ||
        (
          await db.user.updateMany({
            where: { id: user.id, totpLastStep: { lt: step } },
            data: { totpLastStep: step },
          })
        ).count !== 1
      )
        throw new UnauthorizedException("Authenticator code already used");
    }
    const token = secret();
    await db.webSession.create({
      data: {
        userId: user.id,
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 28800000),
      },
    });
    res.cookie("nexus_session", token, {
      httpOnly: true,
      secure: config.APP_URL
        ? config.NODE_ENV === "production"
        : req.headers.origin?.startsWith("https://") === true,
      sameSite: "strict",
      path: "/",
      maxAge: 28800000,
    });
    await audit(p, "login", "success");
    return { authenticated: true };
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.cookies?.nexus_session)
      await db.webSession.deleteMany({
        where: { tokenHash: hash(req.cookies.nexus_session) },
      });
    res.clearCookie("nexus_session", { path: "/" });
    return { ok: true };
  }
  @Get("auth/me") async me(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    return db.user.findUnique({
      where: { id: p.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        organization: { select: { name: true } },
      },
    });
  }
  @Post("auth/mfa/prepare") async prepareMfa(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    const key = newTotp();
    return {
      secret: key,
      challenge: seal(
        { key, expires: Date.now() + 300000 },
        config.ENCRYPTION_KEY,
        p.id,
      ),
      uri: `otpauth://totp/NexusSSH:${p.id}?secret=${key}&issuer=NexusSSH`,
    };
  }
  @Post("auth/mfa/enable") async enableMfa(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    const a = z.object({ challenge: z.string(), code: z.string() }).parse(body);
    const value = unseal<{ key: string; expires: number }>(
      a.challenge,
      config.ENCRYPTION_KEY,
      p.id,
    );
    if (value.expires < Date.now() || !verifyTotp(value.key, a.code))
      throw new BadRequestException("Invalid or expired MFA challenge");
    await db.user.update({
      where: { id: p.id },
      data: {
        totpSecret: seal(value.key, config.ENCRYPTION_KEY, p.id),
        totpLastStep: totpStep(value.key, a.code) ?? -1,
      },
    });
    await audit(p, "mfa_enabled", "success");
    return { enabled: true };
  }
  @Get("dashboard") async dashboard(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    const servers = await listServers(p);
    const ids = servers.map((s) => s.id);
    return {
      servers: servers.filter((s) => !s.archived),
      stats: {
        total: servers.filter((s) => !s.archived).length,
        reachable: servers.filter(
          (s) => !s.archived && s.status === "reachable",
        ).length,
        unreachable: servers.filter(
          (s) => !s.archived && s.status === "unreachable",
        ).length,
        sessions: await db.sSHSession.count({
          where: {
            organizationId: p.organizationId,
            serverId: { in: ids },
            status: "active",
          },
        }),
        agents: await db.agent.count({
          where: { organizationId: p.organizationId, revoked: false },
        }),
        approvals: await db.approvalRequest.count({
          where: {
            organizationId: p.organizationId,
            status: "pending",
            expiresAt: { gt: new Date() },
          },
        }),
      },
      activity: await db.auditEvent.findMany({
        where: {
          organizationId: p.organizationId,
          ...(["owner", "administrator"].includes(p.role)
            ? {}
            : { principalId: p.id }),
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    };
  }
  @Get("identities") async identities(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    return db.sSHIdentity.findMany({
      where: { organizationId: p.organizationId },
      select: { id: true, name: true, kind: true, createdAt: true },
    });
  }
  @Post("identities") async identity(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = credentials.parse(body),
      id = randomUUID();
    await db.sSHIdentity.create({
      data: {
        id,
        organizationId: p.organizationId,
        name: a.name,
        kind: a.kind,
        encryptedSecret: seal(
          a.kind === "password"
            ? { password: a.password }
            : { privateKey: a.privateKey, passphrase: a.passphrase },
          config.ENCRYPTION_KEY,
          p.organizationId + ":" + id,
        ),
      },
    });
    await audit(p, "identity_created", "success");
    return { id, name: a.name };
  }
  @Patch("identities/:id") async rotateIdentity(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = credentials.parse(body);
    const result = await db.sSHIdentity.updateMany({
      where: { id, organizationId: p.organizationId },
      data: {
        name: a.name,
        kind: a.kind,
        encryptedSecret: seal(
          a.kind === "password"
            ? { password: a.password }
            : { privateKey: a.privateKey, passphrase: a.passphrase },
          config.ENCRYPTION_KEY,
          p.organizationId + ":" + id,
        ),
      },
    });
    if (!result.count) throw new NotFoundException();
    await audit(p, "identity_rotated", "success");
    return { id };
  }
  @Get("servers") async servers(@Req() req: Request) {
    return listServers(await authenticate(req));
  }
  async serverData(p: any, body: unknown, id?: string) {
    const { tags, ...a } = serverSchema.parse(body);
    if (
      !(await db.sSHIdentity.findFirst({
        where: { id: a.identityId, organizationId: p.organizationId },
      }))
    )
      throw new BadRequestException("Identity unavailable");
    if (
      a.groupId &&
      !(await db.serverGroup.findFirst({
        where: { id: a.groupId, organizationId: p.organizationId },
      }))
    )
      throw new BadRequestException("Group unavailable");
    if (a.bastionId) {
      const b = await db.server.findFirst({
        where: {
          id: a.bastionId,
          organizationId: p.organizationId,
          archived: false,
        },
      });
      if (!b || b.bastionId || b.id === id)
        throw new BadRequestException("Invalid bastion");
      if (id && (await db.server.count({ where: { bastionId: id } })))
        throw new BadRequestException("Nested bastions are not supported");
    }
    const tagIds = await Promise.all(
      [...new Set(tags)].map((name) =>
        db.serverTag.upsert({
          where: {
            organizationId_name: { organizationId: p.organizationId, name },
          },
          create: { organizationId: p.organizationId, name },
          update: {},
        }),
      ),
    );
    return {
      ...a,
      tags: {
        ...(id ? { set: [] } : {}),
        connect: tagIds.map((t) => ({ id: t.id })),
      },
    };
  }
  @Post("servers") async addServer(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const data = await this.serverData(p, body);
    const s = await db.server.create({
      data: { ...data, organizationId: p.organizationId },
    });
    await audit(p, "server_created", "success", s.id);
    return s;
  }
  @Patch("servers/:id") async editServer(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    await authorize(p, id, "server_get_info");
    const data = await this.serverData(p, body, id);
    const s = await db.server.update({
      where: { id },
      data: { ...data, status: "unknown" },
    });
    await audit(p, "server_updated", "success", id);
    return s;
  }
  @Post("servers/:id/duplicate") async duplicate(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    const old = await authorize(p, id, "server_get_info");
    const { id: _id, createdAt: _c, updatedAt: _u, ...data } = old;
    return db.server.create({
      data: {
        ...data,
        name: old.name + " copy",
        status: "unknown",
        lastCheckedAt: null,
        favorite: false,
      },
    });
  }
  @Delete("servers/:id") async deleteServer(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    await authorize(p, id, "server_get_info");
    await db.server.update({ where: { id }, data: { archived: true } });
    await audit(p, "server_archived", "success", id);
    return { archived: true, message: "Archived to preserve audit references" };
  }
  @Get("groups") async groups(@Req() req: Request) {
    const p = await authenticate(req);
    return db.serverGroup.findMany({
      where: { organizationId: p.organizationId },
    });
  }
  @Post("groups") async group(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const a = z.object({ name: z.string().trim().min(1).max(80) }).parse(body);
    if (
      await db.serverGroup.findFirst({
        where: { organizationId: p.organizationId, name: a.name },
      })
    )
      throw new ConflictException("A folder with this name already exists");
    const group = await db.serverGroup.create({
      data: { organizationId: p.organizationId, ...a },
    });
    await audit(p, "folder_created", "success");
    return group;
  }
  @Delete("groups/:id") async removeGroup(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    // Servers in the folder become ungrouped; nothing else is removed.
    await db.$transaction([
      db.server.updateMany({
        where: { groupId: id, organizationId: p.organizationId },
        data: { groupId: null },
      }),
      db.serverGroup.deleteMany({
        where: { id, organizationId: p.organizationId },
      }),
    ]);
    await audit(p, "folder_deleted", "success");
    return { deleted: true };
  }
  @Post("operations/:op") async run(
    @Req() req: Request,
    @Param("op") op: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClose);
    try {
      return await operation(await authenticate(req), op, body, abort.signal);
    } finally {
      res.off("close", onClose);
    }
  }
  @Get("agents") async agents(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    return db.agent.findMany({
      where: { organizationId: p.organizationId },
      include: {
        permissions: true,
        tokens: {
          select: { id: true, expiresAt: true, revoked: true, scopes: true },
        },
      },
    });
  }
  @Post("agents") async createAgent(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().min(1).max(100),
        level: z
          .enum(["viewer", "operator", "administrator", "custom"])
          .default("viewer"),
        serverIds: z.array(z.uuid()).max(100),
        operations: z
          .array(z.enum(allOperations as [string, ...string[]]))
          .max(60),
        expiresInDays: z.number().int().min(1).max(90).default(30),
      })
      .strict()
      .parse(body);
    if (
      a.operations.includes("terminal") ||
      (a.level === "viewer" &&
        a.operations.some((o) => !readOperations.includes(o)))
    )
      throw new BadRequestException("Invalid agent operations");
    if (
      (await db.server.count({
        where: {
          id: { in: a.serverIds },
          organizationId: p.organizationId,
          archived: false,
        },
      })) !== new Set(a.serverIds).size
    )
      throw new BadRequestException("Server unavailable");
    const token = secret();
    const agent = await db.agent.create({
      data: {
        organizationId: p.organizationId,
        ownerId: p.id,
        name: a.name,
        level: a.level,
        permissions: {
          create: [...new Set(a.serverIds)].map((serverId) => ({
            serverId,
            operations: JSON.stringify(a.operations),
          })),
        },
        tokens: {
          create: {
            tokenHash: hash(token),
            issuer: config.MCP_AUTH_ISSUER,
            audience: mcpAudience,
            scopes: JSON.stringify(a.operations),
            expiresAt: new Date(Date.now() + a.expiresInDays * 86400000),
          },
        },
      },
    });
    await audit(p, "agent_created", "success");
    return { agent, token, endpoint: mcpEndpoint(req.headers) };
  }
  @Delete("agents/:id") async revoke(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    const count = await db.agent.updateMany({
      where: { id, organizationId: p.organizationId },
      data: { revoked: true },
    });
    if (!count.count) throw new NotFoundException();
    await db.agentToken.updateMany({
      where: { agentId: id },
      data: { revoked: true },
    });
    await audit(p, "agent_revoked", "success");
    return { revoked: true };
  }
  @Get("approvals") async approvals(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    const items = await db.approvalRequest.findMany({
      where: {
        organizationId: p.organizationId,
        ...(["owner", "administrator"].includes(p.role)
          ? {}
          : { principalId: p.id }),
      },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return items.map(({ encryptedArguments, ...row }) => ({
      ...row,
      args: unseal(encryptedArguments, config.ENCRYPTION_KEY, p.organizationId),
    }));
  }
  @Post("approvals/:id") async decide(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({ decision: z.enum(["approved", "rejected"]) })
      .parse(body);
    const result = await db.approvalRequest.updateMany({
      where: {
        id,
        organizationId: p.organizationId,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      data: { status: a.decision, decidedBy: p.id },
    });
    if (result.count !== 1)
      throw new BadRequestException("Approval unavailable or expired");
    await audit(p, "approval_" + a.decision, "success", undefined, id);
    return { id, status: a.decision };
  }
  @Get("audit") async logs(
    @Req() req: Request,
    @Query("action") action?: string,
    @Query("cursor") cursor?: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    return db.auditEvent.findMany({
      where: {
        organizationId: p.organizationId,
        ...(action ? { action: { contains: action.slice(0, 100) } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      ...(cursor ? { cursor: { id: z.uuid().parse(cursor) }, skip: 1 } : {}),
    });
  }
  @Get("users") async users(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    return db.user.findMany({
      where: { organizationId: p.organizationId },
      select: { id: true, name: true, email: true, role: true, disabled: true },
    });
  }
  @Post("users") async user(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const a = login
      .extend({
        name: z.string().min(1).max(100),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .parse(body);
    const u = await db.user.create({
      data: {
        organizationId: p.organizationId,
        name: a.name,
        email: a.email.toLowerCase(),
        passwordHash: await bcrypt.hash(a.password, 12),
        role: a.role,
      },
    });
    await audit(p, "user_created", "success");
    return { id: u.id };
  }
  @Patch("users/:id") async updateUser(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        disabled: z.boolean(),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .parse(body);
    const u = await db.user.findFirst({
      where: { id, organizationId: p.organizationId },
    });
    if (!u || u.role === "owner" || id === p.id)
      throw new BadRequestException("Cannot change this account");
    await db.user.update({ where: { id }, data: a });
    await db.webSession.deleteMany({ where: { userId: id } });
    await audit(p, "user_updated", "success");
    return { id };
  }
  @Post("users/:id/permissions") async userPermission(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        serverId: z.uuid(),
        operations: z.array(z.enum(allOperations as [string, ...string[]])),
      })
      .parse(body);
    if (
      !(await db.user.findFirst({
        where: { id, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException();
    await authorize(p, a.serverId, "server_get_info");
    await db.serverPermission.upsert({
      where: { serverId_userId: { serverId: a.serverId, userId: id } },
      create: {
        userId: id,
        serverId: a.serverId,
        operations: JSON.stringify(a.operations),
      },
      update: { operations: JSON.stringify(a.operations) },
    });
    await audit(p, "permissions_updated", "success", a.serverId);
    return { updated: true };
  }
  @Get("sessions") async sessions(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    return db.sSHSession.findMany({
      where: {
        organizationId: p.organizationId,
        ...(["owner", "administrator"].includes(p.role)
          ? {}
          : { principalId: p.id }),
      },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Get("settings") async settings(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    return {
      endpoint: mcpEndpoint(req.headers),
      protocol: "2026-07-28",
      legacy: "2025 stateless",
      fileLimit: config.SSH_OUTPUT_LIMIT,
      sessionLimit: config.SSH_MAX_SESSIONS,
      recording: false,
      operations: allOperations,
    };
  }
  @Get("teams") async teams(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    return db.team.findMany({
      where: { organizationId: p.organizationId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
  }
  @Post("teams") async createTeam(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().min(1).max(80),
        userIds: z.array(z.uuid()).max(100),
      })
      .parse(body);
    if (
      (await db.user.count({
        where: { id: { in: a.userIds }, organizationId: p.organizationId },
      })) !== new Set(a.userIds).size
    )
      throw new BadRequestException("Member unavailable");
    const team = await db.team.create({
      data: {
        organizationId: p.organizationId,
        name: a.name,
        members: {
          create: [...new Set(a.userIds)].map((userId) => ({ userId })),
        },
      },
    });
    await audit(p, "team_created", "success");
    return team;
  }
  @Delete("teams/:id") async removeTeam(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    await db.team.deleteMany({
      where: { id, organizationId: p.organizationId },
    });
    await audit(p, "team_deleted", "success");
    return { deleted: true };
  }
  @Post("invitations") async invite(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        email: z.email(),
        role: z.enum(["administrator", "operator", "viewer"]),
      })
      .parse(body);
    const token = secret();
    await db.systemSetting.create({
      data: {
        organizationId: p.organizationId,
        key: "invite:" + hash(token),
        value: JSON.stringify({
          ...a,
          email: a.email.toLowerCase(),
          expires: Date.now() + 86400000,
        }),
      },
    });
    await audit(p, "invitation_created", "success");
    return {
      url: publicOrigin(req.headers) + "/?invite=" + token,
      expiresInHours: 24,
    };
  }
  @Post("auth/invitation") async acceptInvite(@Body() body: unknown) {
    const a = login
        .extend({ token: z.string().min(32), name: z.string().min(1).max(100) })
        .parse(body),
      key = "invite:" + hash(a.token),
      passwordHash = await bcrypt.hash(a.password, 12);
    await db.$transaction(async (tx) => {
      const invite = await tx.systemSetting.findFirst({ where: { key } });
      if (!invite) throw new BadRequestException("Invitation unavailable");
      const value = JSON.parse(invite.value);
      if (value.expires < Date.now() || value.email !== a.email.toLowerCase())
        throw new ForbiddenException("Invitation expired or email mismatch");
      await tx.user.create({
        data: {
          organizationId: invite.organizationId,
          email: value.email,
          name: a.name,
          role: value.role,
          passwordHash,
        },
      });
      await tx.systemSetting.delete({ where: { id: invite.id } });
    });
    return { created: true };
  }
  @Get("snippets") async snippets(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    return db.savedCommand.findMany({
      where: { organizationId: p.organizationId },
      orderBy: { name: "asc" },
      take: 100,
    });
  }
  @Post("snippets") async saveSnippet(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().min(1).max(80),
        command: z.string().min(1).max(8192),
      })
      .parse(body);
    return db.savedCommand.create({
      data: { organizationId: p.organizationId, ...a },
    });
  }
  @Delete("snippets/:id") async deleteSnippet(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    await db.savedCommand.deleteMany({
      where: { id, organizationId: p.organizationId },
    });
    return { deleted: true };
  }
  @Delete("sessions/:id") async endSession(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    human(p);
    const result = await db.sSHSession.updateMany({
      where: {
        id,
        organizationId: p.organizationId,
        ...(["owner", "administrator"].includes(p.role)
          ? {}
          : { principalId: p.id }),
        status: "active",
      },
      data: { status: "terminated", endedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException();
    await audit(p, "terminal_terminated", "success", undefined, id);
    return { terminated: true };
  }
  @Get("internal/auth") async internalAuth(@Req() req: Request) {
    internal(req);
    const p = await authenticate(req);
    if (p.kind !== "agent") throw new ForbiddenException();
    await db.agent.update({
      where: { id: p.id },
      data: { lastActivityAt: new Date() },
    });
    return { authenticated: true };
  }
  @Post("internal/tasks/:id/claim") async claim(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    internal(req);
    return claimTask(z.uuid().parse(id));
  }
  @Get("internal/tasks/:id/status") async taskStatus(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    internal(req);
    const t = await db.backgroundTask.findUniqueOrThrow({ where: { id } });
    const agent = await db.agent.findUnique({
      where: { id: t.principalId },
      include: { owner: true },
    });
    const user = agent
      ? null
      : await db.user.findUnique({ where: { id: t.principalId } });
    return {
      cancelled:
        t.status === "cancelled" ||
        !!agent?.revoked ||
        !!agent?.owner.disabled ||
        !!user?.disabled ||
        t.expiresAt < new Date(),
    };
  }
  @Post("internal/tasks/:id/finish") async finish(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    internal(req);
    const a = z
      .object({
        lease: z.string(),
        status: z.enum(["completed", "failed", "cancelled"]),
        exitCode: z.number().int().nullable().optional(),
        durationMs: z.number().int().optional(),
      })
      .parse(body);
    const t = await db.backgroundTask.findUniqueOrThrow({ where: { id } });
    if (!t.leaseHash || !equal(t.leaseHash, hash(a.lease)))
      throw new ForbiddenException();
    const status = t.status === "cancelled" ? "cancelled" : a.status;
    await db.backgroundTask.update({
      where: { id },
      data: { status, leaseHash: null },
    });
    await db.commandExecution.update({
      where: { id },
      data: { status, exitCode: a.exitCode, durationMs: a.durationMs },
    });
    if (t.operation === "server_test_connection")
      await db.server.update({
        where: { id: t.serverId },
        data: {
          status: status === "completed" ? "reachable" : "unreachable",
          lastCheckedAt: new Date(),
        },
      });
    await audit(
      {
        id: t.principalId,
        organizationId: t.organizationId,
        kind: "user",
        role: "",
        scopes: [],
      },
      t.operation,
      status,
      t.serverId,
      id,
    );
    return { ok: true };
  }
}
