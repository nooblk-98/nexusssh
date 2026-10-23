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
import { randomBytes, randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
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
import { authenticate, admin, human, workspace, internal } from "./auth.js";
import {
  ACCEPT_NEW_HOST_KEYS,
  APPROVAL_WEBHOOK,
  EXTRA_CIDRS,
  approvalWebhook,
  acceptsNewHostKeys,
  sshLimits,
  workspaceCidrs,
  audit,
  listServers,
  authorize,
  operation,
  claimTask,
} from "./domain.js";
import { verifyTotp, newTotp, totpStep } from "./totp.js";
import { scanHostKey } from "../../../packages/ssh-core/index.js";
import { connectionPath } from "./domain.js";
import { closeSftp } from "./sftp.js";
import { finishTask } from "./task-finish.js";
import { saveFolder, deleteFolder } from "./folders.js";
import {
  WORKSPACE_MANAGE,
  managementTools,
  agentAccessSchema,
} from "../../../packages/shared/management.js";
// Keep in sync with the icon picker in apps/web/components/icons.tsx.
const serverIcons = [
  "linux",
  "windows",
  "apple",
  "server",
  "database",
  "storage",
  "router",
  "cluster",
  "cloud",
  "container",
  "terminal",
  "monitor",
  "firewall",
  "globe",
] as const;
// Optional per-agent call caps; null or omitted means unlimited.
const agentLimits = {
  maxCallsPerMinute: z.number().int().min(1).max(10000).nullish(),
  maxCallsPerDay: z.number().int().min(1).max(1000000).nullish(),
};
// Recovery codes are shown once; only their hashes are stored.
const normalizeRecovery = (code: string) =>
  code.toLowerCase().replace(/[^a-z0-9]/g, "");
async function newRecoveryCodes(userId: string) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(6).toString("hex").match(/.{4}/g)!.join("-"),
  );
  await db.user.update({
    where: { id: userId },
    data: {
      recoveryCodes: JSON.stringify(
        codes.map((c) => hash(normalizeRecovery(c))),
      ),
    },
  });
  return codes;
}
async function confirmPassword(userId: string, body: unknown) {
  const a = z.object({ password: z.string().min(1).max(200) }).parse(body);
  const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(a.password, u.passwordHash)))
    throw new BadRequestException("Password is incorrect");
}
// An IP address or CIDR network; a bare address becomes a single-host network.
const cidr = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const value = v.includes("/") ? v : v + (v.includes(":") ? "/128" : "/32");
    try {
      const [net, bits] = ipaddr.parseCIDR(value);
      return net.toString() + "/" + bits;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid IP address or CIDR: " + v,
      });
      return z.NEVER;
    }
  });
const preferences = z
  .object({
    uiTheme: z.enum(["auto", "light", "dark"]),
    terminalTheme: z.string().max(40),
    terminalFont: z.string().max(60),
    terminalFontSize: z.number().int().min(8).max(32),
    copyOnSelect: z.boolean(),
    suggestHistory: z.boolean(),
    suggestArguments: z.boolean(),
    compactSuggestions: z.boolean(),
    editorTheme: z.string().max(40),
    editorWrap: z.boolean(),
  })
  .partial()
  .strict();
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
    icon: z.enum(serverIcons).default("linux"),
    terminalSettings: z
      .record(z.string().max(40), z.union([z.string().max(40), z.boolean()]))
      .default({})
      .refine((v) => Object.keys(v).length <= 30, "Too many settings")
      .transform((v) => JSON.stringify(v)),
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
    vpnProfileId: z.uuid().nullable().default(null),
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
    const code = (a.code || "").trim();
    if (user.totpSecret && code && !/^\d{6}$/.test(code)) {
      // A one-time recovery code instead of an authenticator code; consumed
      // with a compare-and-swap so it cannot be used twice.
      const codes: string[] = JSON.parse(user.recoveryCodes);
      const h = hash(normalizeRecovery(code));
      const used =
        codes.includes(h) &&
        (
          await db.user.updateMany({
            where: { id: user.id, recoveryCodes: user.recoveryCodes },
            data: {
              recoveryCodes: JSON.stringify(codes.filter((c) => c !== h)),
            },
          })
        ).count === 1;
      if (!used) {
        await audit(p, "login", "failed_mfa");
        throw new UnauthorizedException("Valid authenticator code required");
      }
      await audit(p, "login_recovery_code", "success");
    } else if (
      user.totpSecret &&
      !verifyTotp(
        unseal<string>(user.totpSecret, config.ENCRYPTION_KEY, user.id),
        code,
      )
    ) {
      await audit(p, "login", "failed_mfa");
      throw new UnauthorizedException("Valid authenticator code required");
    } else if (user.totpSecret) {
      const step = totpStep(
        unseal<string>(user.totpSecret, config.ENCRYPTION_KEY, user.id),
        code,
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
  @Patch("auth/me") async updateMe(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    human(p);
    const a = z.object({ name: z.string().trim().min(1).max(100) }).parse(body);
    await db.user.update({ where: { id: p.id }, data: a });
    await audit(p, "profile_updated", "success");
    return { updated: true };
  }
  @Post("auth/password") async changePassword(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    const a = z
      .object({
        current: z.string().min(1).max(200),
        password: z.string().min(12).max(200),
      })
      .parse(body);
    const u = await db.user.findUniqueOrThrow({ where: { id: p.id } });
    if (!(await bcrypt.compare(a.current, u.passwordHash)))
      throw new BadRequestException("Current password is incorrect");
    await db.user.update({
      where: { id: p.id },
      data: { passwordHash: await bcrypt.hash(a.password, 12) },
    });
    // Other browsers signed in as this user must sign in again.
    const current = req.cookies?.nexus_session
      ? hash(req.cookies.nexus_session)
      : "";
    await db.webSession.deleteMany({
      where: { userId: p.id, tokenHash: { not: current } },
    });
    await audit(p, "password_changed", "success");
    return { updated: true };
  }
  @Get("preferences") async getPreferences(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    const u = await db.user.findUniqueOrThrow({
      where: { id: p.id },
      select: { preferences: true, totpSecret: true, recoveryCodes: true },
    });
    return {
      ...JSON.parse(u.preferences),
      mfaEnabled: !!u.totpSecret,
      recoveryCodesLeft: JSON.parse(u.recoveryCodes).length,
    };
  }
  @Patch("preferences") async setPreferences(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    const a = preferences.parse(body);
    const u = await db.user.findUniqueOrThrow({
      where: { id: p.id },
      select: { preferences: true },
    });
    const merged = { ...JSON.parse(u.preferences), ...a };
    await db.user.update({
      where: { id: p.id },
      data: { preferences: JSON.stringify(merged) },
    });
    return merged;
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
    return { enabled: true, recoveryCodes: await newRecoveryCodes(p.id) };
  }
  @Post("auth/mfa/disable") async disableMfa(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    await confirmPassword(p.id, body);
    await db.user.update({
      where: { id: p.id },
      data: { totpSecret: null, totpLastStep: -1, recoveryCodes: "[]" },
    });
    await audit(p, "mfa_disabled", "success");
    return { enabled: false };
  }
  @Post("auth/mfa/recovery-codes") async recoveryCodes(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    await confirmPassword(p.id, body);
    const u = await db.user.findUniqueOrThrow({ where: { id: p.id } });
    if (!u.totpSecret)
      throw new BadRequestException("Two-factor authentication is not enabled");
    await audit(p, "mfa_recovery_codes_created", "success");
    return { recoveryCodes: await newRecoveryCodes(p.id) };
  }
  @Get("dashboard") async dashboard(@Req() req: Request) {
    const p = await authenticate(req);
    workspace(p);
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
      select: {
        id: true,
        name: true,
        kind: true,
        createdAt: true,
        _count: { select: { servers: true } },
      },
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
  @Delete("identities/:id") async deleteIdentity(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    const used = await db.server.count({
      where: { identityId: id, organizationId: p.organizationId },
    });
    if (used)
      throw new ConflictException(
        `This identity is used by ${used} server${used === 1 ? "" : "s"}`,
      );
    const result = await db.sSHIdentity.deleteMany({
      where: { id, organizationId: p.organizationId },
    });
    if (!result.count) throw new NotFoundException();
    await audit(p, "identity_deleted", "success");
    return { deleted: true };
  }
  @Get("servers") async servers(@Req() req: Request) {
    return listServers(await authenticate(req));
  }
  async serverData(p: any, body: unknown, id?: string) {
    const { tags, ...a } = serverSchema.parse(body);
    if (
      a.vpnProfileId &&
      !(await db.vpnProfile.findFirst({
        where: { id: a.vpnProfileId, organizationId: p.organizationId },
      }))
    )
      throw new BadRequestException("VPN profile unavailable");
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
      if (a.vpnProfileId && b.vpnProfileId && a.vpnProfileId !== b.vpnProfileId)
        throw new BadRequestException(
          "Choose the bastion's VPN profile or inherit its VPN",
        );
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
    if (p.kind === "agent")
      await db.agentPermission.create({
        data: {
          agentId: p.id,
          serverId: s.id,
          operations: JSON.stringify(
            p.scopes.filter(
              (op) => allOperations.includes(op) && op !== "terminal",
            ),
          ),
        },
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
    const old = await authorize(p, id, "server_get_info");
    // Fields left out keep their saved values, so callers can send only changes.
    const tags = await db.serverTag.findMany({
      where: { servers: { some: { id } } },
      select: { name: true },
    });
    const saved = {
      name: old.name,
      host: old.host,
      port: old.port,
      username: old.username,
      identityId: old.identityId,
      fingerprint: old.fingerprint,
      environment: old.environment,
      description: old.description,
      icon: old.icon,
      terminalSettings: JSON.parse(old.terminalSettings),
      fileRoot: old.fileRoot,
      groupId: old.groupId,
      bastionId: old.bastionId,
      vpnProfileId: old.vpnProfileId,
      favorite: old.favorite,
      archived: old.archived,
      tags: tags.map((t) => t.name),
    };
    const data = await this.serverData(
      p,
      { ...saved, ...z.record(z.string(), z.unknown()).parse(body) },
      id,
    );
    const s = await db.server.update({
      where: { id },
      data: { ...data, status: "unknown" },
    });
    closeSftp(id);
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
    const s = await db.server.create({
      data: {
        ...data,
        name: old.name + " copy",
        status: "unknown",
        lastCheckedAt: null,
        favorite: false,
      },
    });
    if (p.kind === "agent")
      await db.agentPermission.create({
        data: {
          agentId: p.id,
          serverId: s.id,
          operations: JSON.stringify(
            p.scopes.filter(
              (op) => allOperations.includes(op) && op !== "terminal",
            ),
          ),
        },
      });
    await audit(p, "server_duplicated", "success", s.id);
    return s;
  }
  @Patch("servers/:id/move") async moveServer(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    await authorize(p, id, "server_get_info");
    const a = z.object({ groupId: z.uuid().nullable() }).strict().parse(body);
    await db.$transaction(async (tx) => {
      if (
        a.groupId &&
        !(await tx.serverGroup.findFirst({
          where: { id: a.groupId, organizationId: p.organizationId },
        }))
      )
        throw new BadRequestException("Destination folder unavailable");
      await tx.server.update({ where: { id }, data: { groupId: a.groupId } });
    });
    await audit(p, "server_moved", "success", id);
    return { id, groupId: a.groupId };
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
    const a = z
      .object({
        name: z.string().trim().min(1).max(80),
        parentId: z.uuid().nullable().optional(),
      })
      .strict()
      .parse(body);
    const group = await saveFolder(p.organizationId, a);
    await audit(p, "folder_created", "success");
    return group;
  }
  @Patch("groups/:id") async updateGroup(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        parentId: z.uuid().nullable().optional(),
      })
      .strict()
      .refine(
        (v) => v.name !== undefined || v.parentId !== undefined,
        "Specify a name or destination folder",
      )
      .parse(body);
    const group = await saveFolder(p.organizationId, a, id);
    await audit(
      p,
      a.parentId !== undefined ? "folder_moved" : "folder_renamed",
      "success",
    );
    return group;
  }
  @Post("servers/scan-host-key") async scan(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9.:-]+$/),
        port: z.number().int().min(1).max(65535).default(22),
        vpnProfileId: z.uuid().nullable().optional(),
        bastionId: z.uuid().nullable().optional(),
      })
      .parse(body);
    try {
      return {
        fingerprint: await scanHostKey(
          a.host,
          a.port,
          await sshLimits(p.organizationId),
          await connectionPath(p.organizationId, a),
        ),
      };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
  @Delete("groups/:id") async removeGroup(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    await deleteFolder(p.organizationId, id);
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
        workspaceManagement: z.boolean().default(false),
        expiresInDays: z.number().int().min(1).max(90).default(30),
        ...agentLimits,
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
    if (a.workspaceManagement && a.level !== "administrator")
      throw new BadRequestException(
        "Workspace management requires administrator level",
      );
    const token = secret();
    const agent = await db.agent.create({
      data: {
        organizationId: p.organizationId,
        ownerId: p.ownerId || p.id,
        name: a.name,
        level: a.level,
        maxCallsPerMinute: a.maxCallsPerMinute ?? null,
        maxCallsPerDay: a.maxCallsPerDay ?? null,
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
            scopes: JSON.stringify([
              ...new Set([
                ...a.operations,
                ...(a.workspaceManagement ? [WORKSPACE_MANAGE] : []),
              ]),
            ]),
            expiresAt: new Date(Date.now() + a.expiresInDays * 86400000),
          },
        },
      },
    });
    await audit(p, "agent_created", "success");
    return { agent, token, endpoint: mcpEndpoint(req.headers) };
  }
  @Patch("agents/:id/access") async agentAccess(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = agentAccessSchema.parse(body);
    if (
      (a.workspaceManagement && a.level !== "administrator") ||
      (a.level === "viewer" &&
        a.operations.some((op) => !readOperations.includes(op)))
    )
      throw new BadRequestException("Invalid agent access");
    await db.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({
        where: { id, organizationId: p.organizationId, revoked: false },
      });
      if (!agent) throw new NotFoundException("Agent unavailable");
      if (
        (await tx.server.count({
          where: {
            id: { in: a.serverIds },
            organizationId: p.organizationId,
            archived: false,
          },
        })) !== new Set(a.serverIds).size
      )
        throw new BadRequestException("Server unavailable");
      await tx.agentPermission.deleteMany({ where: { agentId: id } });
      await tx.agent.update({
        where: { id },
        data: {
          level: a.level,
          permissions: {
            create: [...new Set(a.serverIds)].map((serverId) => ({
              serverId,
              operations: JSON.stringify(a.operations),
            })),
          },
        },
      });
      await tx.agentToken.updateMany({
        where: { agentId: id, revoked: false },
        data: {
          scopes: JSON.stringify([
            ...new Set([
              ...a.operations,
              ...(a.workspaceManagement ? [WORKSPACE_MANAGE] : []),
            ]),
          ]),
        },
      });
    });
    await audit(p, "agent_access_updated", "success", undefined, id);
    return { updated: true };
  }
  @Patch("agents/:id/limits") async agentLimits(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z.object(agentLimits).strict().parse(body);
    const result = await db.agent.updateMany({
      where: { id, organizationId: p.organizationId },
      data: {
        maxCallsPerMinute: a.maxCallsPerMinute ?? null,
        maxCallsPerDay: a.maxCallsPerDay ?? null,
      },
    });
    if (!result.count) throw new NotFoundException();
    await audit(p, "agent_limits_updated", "success");
    return a;
  }
  // Recent SSH operations an agent ran, newest first.
  @Get("agents/:id/activity") async agentActivity(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    if (
      !(await db.agent.findFirst({
        where: { id, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException();
    const [executions, management] = await Promise.all([
      db.commandExecution.findMany({
        where: { principalId: id, organizationId: p.organizationId },
        include: { server: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      db.auditEvent.findMany({
        where: {
          principalId: id,
          organizationId: p.organizationId,
          action: { startsWith: "mcp:" },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);
    return [
      ...executions,
      ...management.map((event) => ({
        ...event,
        operation: event.action.slice(4),
        server: { name: "Workspace" },
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 200);
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
    workspace(p);
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
    if (!u || u.role === "owner" || id === p.id || id === p.ownerId)
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
    workspace(p);
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
    workspace(p);
    return {
      endpoint: mcpEndpoint(req.headers),
      protocol: "2026-07-28",
      legacy: "2025 stateless",
      fileLimit: config.SSH_OUTPUT_LIMIT,
      sessionLimit: config.SSH_MAX_SESSIONS,
      recording: false,
      operations: allOperations,
      readOperations,
      managementTools: Object.entries(managementTools).map(([name, tool]) => ({
        name,
        description: tool.description,
      })),
      acceptNewHostKeys: await acceptsNewHostKeys(p.organizationId),
      deploymentCidrs: config.SSH_ALLOWED_CIDRS.split(","),
      workspaceCidrs: await workspaceCidrs(p.organizationId),
      allowlistLocked: config.SSH_ALLOWLIST_LOCKED,
      ...(["owner", "administrator"].includes(p.role)
        ? { approvalWebhook: await approvalWebhook(p.organizationId) }
        : {}),
    };
  }
  @Patch("settings") async updateSettings(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        acceptNewHostKeys: z.boolean().optional(),
        workspaceCidrs: z.array(cidr).max(100).optional(),
        approvalWebhook: z.union([z.url().max(1000), z.literal("")]).optional(),
      })
      .strict()
      .parse(body);
    const save = (key: string, value: string) =>
      db.systemSetting.upsert({
        where: {
          organizationId_key: { organizationId: p.organizationId, key },
        },
        create: { organizationId: p.organizationId, key, value },
        update: { value },
      });
    if (a.acceptNewHostKeys !== undefined) {
      await save(ACCEPT_NEW_HOST_KEYS, String(a.acceptNewHostKeys));
      await audit(
        p,
        a.acceptNewHostKeys
          ? "host_key_auto_accept_enabled"
          : "host_key_auto_accept_disabled",
        "success",
      );
    }
    if (a.approvalWebhook !== undefined) {
      await save(APPROVAL_WEBHOOK, a.approvalWebhook);
      await audit(p, "approval_webhook_updated", "success");
    }
    if (a.workspaceCidrs && config.SSH_ALLOWLIST_LOCKED)
      throw new ForbiddenException(
        "SSH destinations are locked by the deployment (SSH_ALLOWLIST_LOCKED)",
      );
    if (a.workspaceCidrs) {
      await save(EXTRA_CIDRS, JSON.stringify([...new Set(a.workspaceCidrs)]));
      await audit(p, "ssh_allowlist_updated", "success");
    }
    return a;
  }
  @Get("teams") async teams(@Req() req: Request) {
    const p = await authenticate(req);
    admin(p);
    const teams = await db.team.findMany({
      where: { organizationId: p.organizationId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        servers: { select: { serverId: true, operations: true } },
      },
    });
    return teams.map((t) => ({
      ...t,
      servers: t.servers.map((g) => ({
        serverId: g.serverId,
        operations: JSON.parse(g.operations),
      })),
    }));
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
  @Patch("teams/:id") async updateTeam(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().min(1).max(80),
        userIds: z.array(z.uuid()).max(100),
      })
      .parse(body);
    const ids = [...new Set(a.userIds)];
    if (
      (await db.user.count({
        where: { id: { in: ids }, organizationId: p.organizationId },
      })) !== ids.length
    )
      throw new BadRequestException("Member unavailable");
    if (
      !(await db.team.findFirst({
        where: { id, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException();
    await db.$transaction([
      db.teamMember.deleteMany({ where: { teamId: id } }),
      db.team.update({
        where: { id },
        data: {
          name: a.name,
          members: { create: ids.map((userId) => ({ userId })) },
        },
      }),
    ]);
    await audit(p, "team_updated", "success");
    return { id };
  }
  // Replaces the team's server grants; an empty operation list removes one.
  @Post("teams/:id/servers") async teamServers(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        servers: z
          .array(
            z.object({
              serverId: z.uuid(),
              operations: z.array(
                z.enum(allOperations as [string, ...string[]]),
              ),
            }),
          )
          .max(500),
      })
      .parse(body);
    if (
      !(await db.team.findFirst({
        where: { id, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException();
    const ids = a.servers.map((s) => s.serverId);
    if (
      (await db.server.count({
        where: { id: { in: ids }, organizationId: p.organizationId },
      })) !== new Set(ids).size
    )
      throw new BadRequestException("Server unavailable");
    await db.$transaction([
      db.teamPermission.deleteMany({ where: { teamId: id } }),
      ...a.servers
        .filter((s) => s.operations.length)
        .map((s) =>
          db.teamPermission.create({
            data: {
              teamId: id,
              serverId: s.serverId,
              operations: JSON.stringify([...new Set(s.operations)]),
            },
          }),
        ),
    ]);
    await audit(p, "team_servers_updated", "success");
    return { updated: true };
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
    workspace(p);
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
    workspace(p);
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
        t.status === "interrupted" ||
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
    const status = await finishTask(id, t.leaseHash, a);
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
  @Post("internal/tasks/:id/interrupt") async interruptTask(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    internal(req);
    const changed = await db.$transaction(async (tx) => {
      const result = await tx.backgroundTask.updateMany({
        where: { id: z.uuid().parse(id), status: "running" },
        data: { status: "interrupted", leaseHash: null },
      });
      if (result.count)
        await tx.commandExecution.update({
          where: { id },
          data: { status: "interrupted" },
        });
      return result;
    });
    return { interrupted: changed.count === 1 };
  }
}
