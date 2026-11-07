import { administratorAgentScopes, effectiveAgentScopes, isAgentAdministrator, administratorToken } from "../../../packages/policy-engine/index.js";
import { kubernetesOperations, kubernetesReadOperations } from "../../../packages/kubernetes/policy.js";
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
import type { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import ssh2 from "ssh2";
import { db } from "../../../packages/database/index.js";
import { batchTokenAllowed } from "../../../packages/shared/operations.js";
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
  EXTRA_CIDRS,
  acceptsNewHostKeys,
  sshLimits,
  workspaceCidrs,
  audit,
  listServers,
  listServersPage,
  authorize,
  operation,
  claimTask,
} from "./domain.js";
import { verifyTotp, newTotp, totpStep } from "./totp.js";
import { scanHostKey } from "../../../packages/ssh-core/index.js";
import { connectionPath } from "./domain.js";
import { settingsSchema, metadataSchema, settingKeys, parseSettings, mergeSettings, validateSettings, resolveSettings, preflightAffected, settingsReferenceCount, numericMetadata } from "./metadata.js";
import { closeSftp } from "./sftp.js";

async function preflightDefaults(tx: Prisma.TransactionClient, org: string, type: "folder" | "tag", id: string, value: ReturnType<typeof parseSettings>) {
  const servers = await tx.server.findMany({ where: { organizationId: org }, include: { tags: { select: { id: true } } } });
  const folders = type === "folder" ? await tx.serverGroup.findMany({ where: { organizationId: org }, select: { id: true, parentId: true } }) : [];
  const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  const affected = servers.filter((server) => {
    if (type === "tag") return server.tags.some((tag) => tag.id === id);
    const seen = new Set<string>();
    let current = server.groupId;
    while (current && !seen.has(current)) {
      if (current === id) return true;
      seen.add(current);
      current = parents.get(current) ?? null;
    }
    return false;
  });
  return preflightAffected(tx, org, affected.map((server) => server.id), { type, id, value });
}
import { finishTask } from "./task-finish.js";
import { taskCancelled } from "./task-lifecycle.js";
import { saveFolder, deleteFolder } from "./folders.js";
import { markSshReachable } from "./connection-health.js";
import { readiness } from "./readiness.js";
import { correlationId as currentRequestId } from "../../../packages/shared/request-context.js";
import { createWebSession } from "./sessions.js";
import { enqueueHealthBatch } from "./health.js";
import {
  WORKSPACE_MANAGE,
  managementTools,
  agentAccessSchema,
  administratorAgentAccess,
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
function validateKeyCredential(value: z.infer<typeof credentials>) {
  if (value.kind !== "key") return;
  try {
    const parsed = ssh2.utils.parseKey(value.privateKey!, value.passphrase);
    if (!(parsed instanceof Error) && parsed.isPrivateKey()) return;
  } catch {
    // Parser errors may contain sensitive key details; never return them.
  }
  throw new BadRequestException("Invalid SSH private key or passphrase");
}
const serverSchema = z
  .object({
    name: z.string().min(1).max(100),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().regex(/^[a-z_][a-z0-9_.-]{0,31}$/),
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
const canonicalHost = (host: string) => host.trim().toLowerCase().replace(/\.+$/, "");
// Mirrors the Server_identity_* database triggers, which compare active servers only.
// Prisma reports their abort as a generic constraint error (P2003), so writers check
// first to return a clear conflict.
async function assertServerIdentityFree(org: string, host: string, port: number, groupId: string | null, exceptId?: string) {
  const candidates = await db.server.findMany({
    where: { organizationId: org, port, groupId, archived: false, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { host: true },
  });
  if (candidates.some((s) => canonicalHost(s.host) === canonicalHost(host)))
    throw new ConflictException("A server with this host and port already exists in this folder");
}
const isServerIdentityConflict = (error: unknown) =>
  String(error).includes("server_identity_conflict") || (error as { code?: string })?.code === "P2003";
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
  @Get("ready") async ready(@Res({ passthrough: true }) res: Response) {
    const result = await readiness();
    res.status(result.status === "ready" ? 200 : 503);
    return result;
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
    await createWebSession(user.id, req, res);
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
        approvals: 0,
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
    validateKeyCredential(a);
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
    validateKeyCredential(a);
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
    const result = await db.$transaction(async (tx) => {
      const used = await settingsReferenceCount(tx, p.organizationId, "identityId", id);
      if (used) throw new ConflictException(`This identity is used by ${used} saved setting${used === 1 ? "" : "s"}`);
      return tx.sSHIdentity.deleteMany({ where: { id, organizationId: p.organizationId } });
    });
    if (!result.count) throw new NotFoundException();
    await audit(p, "identity_deleted", "success");
    return { deleted: true };
  }
  @Get("servers") async servers(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const p = await authenticate(req);
    if (!Object.keys(query).length) return listServers(p);
    const q = z.object({
      folder: z.union([z.uuid(), z.literal("null")]).optional(),
      tag: z.string().min(1).max(32).optional(),
      search: z.string().max(100).optional(),
      fields: z.string().max(300).optional(),
      cursor: z.uuid().optional(),
    }).strict().parse(query);
    return listServersPage(p, { ...q, folder: q.folder === "null" ? null : q.folder });
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
    await assertServerIdentityFree(p.organizationId, data.host, data.port, data.groupId);
    const s = await db.server.create({
      data: { ...data, organizationId: p.organizationId, overrides: JSON.stringify({ identityId: data.identityId, username: data.username, environment: data.environment, vpnProfileId: data.vpnProfileId }) },
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
    return numericMetadata(s);
  }
  @Post("servers/import") async importServers(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const input = z.object({ servers: z.array(z.unknown()).min(1).max(100) }).strict().parse(body);
    const results = [];
    for (const [index, raw] of input.servers.entries()) {
      try {
        const parsed = serverSchema.parse(raw);
        const host = parsed.host.trim().toLowerCase().replace(/\.+$/, "");
        const candidates = await db.server.findMany({ where: {
          organizationId: p.organizationId, port: parsed.port, groupId: parsed.groupId, archived: false,
        } });
        const existing = candidates.find((s) => s.host.trim().toLowerCase().replace(/\.+$/, "") === host);
        if (existing) {
          results.push({ index, status: "duplicate", server: numericMetadata(existing) });
          continue;
        }
        const data = await this.serverData(p, { ...raw as object, host });
        const server = await db.$transaction(async (tx) => {
          const created = await tx.server.create({ data: { ...data, organizationId: p.organizationId, overrides: JSON.stringify({ identityId: data.identityId, username: data.username, environment: data.environment, vpnProfileId: data.vpnProfileId }) } });
          if (p.kind === "agent") await tx.agentPermission.create({ data: {
            agentId: p.id, serverId: created.id,
            operations: JSON.stringify(p.scopes.filter((op) => allOperations.includes(op) && op !== "terminal")),
          } });
          await tx.auditEvent.create({ data: {
            organizationId: p.organizationId, principalId: p.id,
            action: "server_created", status: "success", serverId: created.id,
            correlationId: randomUUID(), requestId: currentRequestId(),
          } });
          return created;
        });
        results.push({ index, status: "created", server: numericMetadata(server) });
      } catch (error) {
        // A concurrent writer can win after the lookup. The database trigger is
        // authoritative; resolve that collision to the same per-row response.
        if (isServerIdentityConflict(error)) {
          const parsed = serverSchema.safeParse(raw);
          if (parsed.success) {
            const key = parsed.data;
            const host = key.host.trim().toLowerCase().replace(/\.+$/, "");
            const candidates = await db.server.findMany({ where: {
              organizationId: p.organizationId, port: key.port, groupId: key.groupId, archived: false,
            } });
            const existing = candidates.find((s) => s.host.trim().toLowerCase().replace(/\.+$/, "") === host);
            if (existing) {
              results.push({ index, status: "duplicate", server: numericMetadata(existing) });
              continue;
            }
          }
        }
        results.push({ index, status: "error", error: "Invalid server or unavailable referenced resource" });
      }
    }
    return { results };
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
    const { inherit, ...patch } = z.record(z.string(), z.unknown()).parse(body) as Record<string, unknown> & { inherit?: unknown };
    const inheritKeys = inherit === undefined ? [] : z.array(z.enum(settingKeys)).max(4).parse(inherit);
    const data = await this.serverData(p, { ...saved, ...patch }, id);
    // Like the trigger, only a changed address, folder or restore is checked, so legacy rows stay editable.
    if (!data.archived && (old.archived || canonicalHost(data.host) !== canonicalHost(old.host) || data.port !== old.port || data.groupId !== old.groupId))
      await assertServerIdentityFree(p.organizationId, data.host, data.port, data.groupId, id);
    const changed = Object.fromEntries(Object.entries(patch).filter(([key]) => settingKeys.includes(key as (typeof settingKeys)[number])));
    const overrides = mergeSettings(old.overrides, settingsSchema.parse(changed), inheritKeys);
    await resolveSettings(id, p.organizationId, { overrides: parseSettings(overrides), groupId: data.groupId, tagIds: data.tags.connect.map((tag) => tag.id) });
    const s = await db.server.update({
      where: { id },
      data: { ...data, overrides, status: "unknown" },
    });
    closeSftp(id);
    await audit(p, "server_updated", "success", id);
    return numericMetadata(s);
  }
  @Post("servers/:id/duplicate") async duplicate(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const old = await authorize(p, id, "server_get_info");
    // Two servers cannot share a host and port in one folder, so a copy that keeps
    // them needs a different folder.
    const a = z
      .object({
        name: serverSchema.shape.name.optional(),
        host: serverSchema.shape.host.optional(),
        port: z.number().int().min(1).max(65535).optional(),
        groupId: z.uuid().nullable().optional(),
      })
      .strict()
      .parse(body ?? {});
    if (
      a.groupId &&
      !(await db.serverGroup.findFirst({
        where: { id: a.groupId, organizationId: p.organizationId },
      }))
    )
      throw new BadRequestException("Destination folder unavailable");
    const host = a.host ?? old.host,
      port = a.port ?? old.port,
      groupId = a.groupId === undefined ? old.groupId : a.groupId;
    if (!old.archived) await assertServerIdentityFree(p.organizationId, host, port, groupId);
    const { id: _id, createdAt: _c, updatedAt: _u, ...data } = old;
    const s = await db.server.create({
      data: {
        ...data,
        overrides: old.overrides,
        name: a.name ?? old.name + " copy",
        host,
        port,
        groupId,
        // A pinned host key belongs to the original address only.
        fingerprint: host === old.host && port === old.port ? old.fingerprint : null,
        status: "unknown",
        lastCheckedAt: null,
        healthFailureCategory: null,
        latestHealthCheckId: null,
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
    return numericMetadata(s);
  }
  @Patch("servers/:id/move") async moveServer(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const current = await authorize(p, id, "server_get_info");
    const a = z.object({ groupId: z.uuid().nullable() }).strict().parse(body);
    if (a.groupId !== current.groupId && !current.archived)
      await assertServerIdentityFree(p.organizationId, current.host, current.port, a.groupId, id);
    const invalidated = await db.$transaction(async (tx) => {
      if (
        a.groupId &&
        !(await tx.serverGroup.findFirst({
          where: { id: a.groupId, organizationId: p.organizationId },
        }))
      )
        throw new BadRequestException("Destination folder unavailable");
      await tx.server.update({ where: { id }, data: { groupId: a.groupId } });
      return preflightAffected(tx, p.organizationId, [id]);
    });
    for (const serverId of invalidated) closeSftp(serverId);
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
  @Patch("groups/:id/defaults") async folderDefaults(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = await authenticate(req); admin(p);
    const envelope = z.object({ settings: settingsSchema.optional(), inherit: z.array(z.enum(settingKeys)).max(4).optional() }).strict().safeParse(body);
    const change = envelope.success ? envelope.data.settings ?? {} : settingsSchema.parse(body);
    const inherit = envelope.success ? envelope.data.inherit ?? [] : [];
    const folder = await db.serverGroup.findFirst({ where: { id, organizationId: p.organizationId } });
    if (!folder) throw new NotFoundException("Folder unavailable");
    const defaults = mergeSettings(folder.defaults, change, inherit, true);
    await validateSettings(p.organizationId, parseSettings(defaults));
    const affected = await db.$transaction(async (tx) => {
      const ids = await preflightDefaults(tx, p.organizationId, "folder", id, parseSettings(defaults));
      await tx.serverGroup.update({ where: { id }, data: { defaults } });
      return ids;
    });
    for (const serverId of affected) closeSftp(serverId);
    return { id, defaults: parseSettings(defaults) };
  }
  @Get("tags") async tagsList(@Req() req: Request) {
    const p = await authenticate(req);
    return db.serverTag.findMany({ where: { organizationId: p.organizationId }, select: { id: true, name: true, defaults: true } });
  }
  @Patch("tags/:id/defaults") async tagDefaults(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = await authenticate(req); admin(p);
    const envelope = z.object({ settings: settingsSchema.optional(), inherit: z.array(z.enum(settingKeys)).max(4).optional() }).strict().safeParse(body);
    const change = envelope.success ? envelope.data.settings ?? {} : settingsSchema.parse(body);
    const inherit = envelope.success ? envelope.data.inherit ?? [] : [];
    const tag = await db.serverTag.findFirst({ where: { id, organizationId: p.organizationId } });
    if (!tag) throw new NotFoundException("Tag unavailable");
    const defaults = mergeSettings(tag.defaults, change, inherit, true);
    await validateSettings(p.organizationId, parseSettings(defaults));
    const affected = await db.$transaction(async (tx) => {
      const ids = await preflightDefaults(tx, p.organizationId, "tag", id, parseSettings(defaults));
      await tx.serverTag.update({ where: { id }, data: { defaults } });
      return ids;
    });
    for (const serverId of affected) closeSftp(serverId);
    return { id, defaults: parseSettings(defaults) };
  }
  @Get("servers/:id/effective-settings") async effectiveSettings(@Req() req: Request, @Param("id") id: string) {
    const p = await authenticate(req); await authorize(p, id, "server_get_info");
    return resolveSettings(id, p.organizationId);
  }
  @Patch("servers/:id/overrides") async updateOverrides(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = await authenticate(req); admin(p);
    const server = await authorize(p, id, "server_get_info");
    const input = z.object({ settings: settingsSchema.optional(), inherit: z.array(z.enum(settingKeys)).max(4).optional(), metadata: metadataSchema.optional() }).strict().parse(body);
    const overrides = mergeSettings(server.overrides, input.settings ?? {}, input.inherit ?? []);
    await validateSettings(p.organizationId, parseSettings(overrides));
    await resolveSettings(id, p.organizationId, { overrides: parseSettings(overrides) });
    const metadata = input.metadata ?? {};
    await db.server.update({ where: { id }, data: {
      overrides, ...(metadata.vcpu !== undefined ? { vcpu: metadata.vcpu } : {}),
      ...(metadata.ramBytes !== undefined ? { ramBytes: metadata.ramBytes } : {}),
      ...(metadata.diskBytes !== undefined ? { diskBytes: metadata.diskBytes } : {}),
      ...(metadata.os !== undefined ? { os: metadata.os } : {}), ...(metadata.role !== undefined ? { role: metadata.role } : {}),
    } });
    closeSftp(id);
    return resolveSettings(id, p.organizationId);
  }
  @Post("servers/metadata/bulk") async bulkMetadata(@Req() req: Request, @Body() body: unknown) {
    const p = await authenticate(req); admin(p);
    const input = z.object({ serverIds: z.array(z.uuid()).min(1).max(100), settings: settingsSchema.optional(), inherit: z.array(z.enum(settingKeys)).max(4).optional(), metadata: metadataSchema.optional() }).strict().parse(body);
    const ids = [...new Set(input.serverIds)];
    const changes: { id: string; overrides: string }[] = [];
    for (const id of ids) {
      const server = await authorize(p, id, "server_get_info");
      const overrides = mergeSettings(server.overrides, input.settings ?? {}, input.inherit ?? []);
      await validateSettings(p.organizationId, parseSettings(overrides));
      await resolveSettings(id, p.organizationId, { overrides: parseSettings(overrides) });
      changes.push({ id, overrides });
    }
    const metadata = input.metadata ?? {};
    await db.$transaction(async (tx) => {
      for (const change of changes) await tx.server.update({ where: { id: change.id }, data: {
        overrides: change.overrides,
        ...(metadata.vcpu !== undefined ? { vcpu: metadata.vcpu } : {}),
        ...(metadata.ramBytes !== undefined ? { ramBytes: metadata.ramBytes } : {}),
        ...(metadata.diskBytes !== undefined ? { diskBytes: metadata.diskBytes } : {}),
        ...(metadata.os !== undefined ? { os: metadata.os } : {}), ...(metadata.role !== undefined ? { role: metadata.role } : {}),
      } });
    });
    for (const id of ids) closeSftp(id);
    return { serverIds: ids, updated: ids.length };
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
  @Post("servers/:id/check") async checkServer(@Req() req: Request, @Param("id") id: string) {
    const p = await authenticate(req);
    await authorize(p, z.uuid().parse(id), "server_test_connection");
    const result = await enqueueHealthBatch(p.organizationId, p.id, [id]);
    await audit(p, "health_check_started", "success", id);
    return result;
  }
  @Post("groups/:id/checks") async checkFolder(@Req() req: Request, @Param("id") id: string) {
    const p = await authenticate(req);
    const folder = await db.serverGroup.findFirst({ where: { id: z.uuid().parse(id), organizationId: p.organizationId } });
    if (!folder) throw new NotFoundException("Folder unavailable");
    const folders = await db.serverGroup.findMany({ where: { organizationId: p.organizationId }, select: { id: true, parentId: true } });
    const descendants = new Set([id]);
    let previous = -1;
    while (previous !== descendants.size) {
      previous = descendants.size;
      for (const child of folders) if (child.parentId && descendants.has(child.parentId)) descendants.add(child.id);
    }
    const servers = await db.server.findMany({ where: { organizationId: p.organizationId, archived: false, groupId: { in: [...descendants] } }, select: { id: true }, take: 101 });
    if (servers.length > 100) throw new BadRequestException("Folder check is limited to 100 servers");
    for (const server of servers) await authorize(p, server.id, "server_test_connection");
    const result = await enqueueHealthBatch(p.organizationId, p.id, servers.map((server) => server.id));
    await audit(p, "folder_health_check_started", "success");
    return result;
  }
  @Get("checks/:batchId") async healthBatch(@Req() req: Request, @Param("batchId") batchId: string) {
    const p = await authenticate(req);
    const batch = await db.healthBatch.findFirst({ where: { id: z.uuid().parse(batchId), organizationId: p.organizationId, principalId: p.id }, include: { checks: { orderBy: { createdAt: "asc" } } } });
    if (!batch) throw new NotFoundException("Health batch unavailable");
    for (const check of batch.checks) await authorize(p, check.serverId, "server_test_connection");
    return { batchId: batch.id, status: batch.expiresAt < new Date() && batch.status !== "completed" ? "expired" : batch.status, authenticationVerified: false, checks: batch.checks.map((check) => ({ serverId: check.serverId, checkId: check.id, status: check.status, checkedAt: check.checkedAt, failureCategory: check.failureCategory, observedFingerprint: check.observedFingerprint, fingerprintComparison: check.fingerprintComparison })) };
  }
  @Post("servers/:id/host-key/verify") async verifyHostKey(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = await authenticate(req);
    human(p);
    admin(p);
    const input = z.object({ checkId: z.uuid(), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }).strict().parse(body);
    const check = await db.healthCheck.findFirst({ where: { id: input.checkId, serverId: z.uuid().parse(id), organizationId: p.organizationId, observedFingerprint: input.fingerprint, status: "reachable", checkedAt: { gt: new Date(Date.now() - 30 * 60_000) } } });
    if (!check) throw new BadRequestException("No matching observed fingerprint for this server");
    const updated = await db.server.updateMany({ where: { id, organizationId: p.organizationId, archived: false, latestHealthCheckId: input.checkId, host: check.checkedHost ?? "", port: check.checkedPort ?? -1 }, data: { fingerprint: input.fingerprint } });
    if (!updated.count) throw new BadRequestException("Server changed since this fingerprint was observed; scan it again");
    closeSftp(id);
    await audit(p, "server_host_key_verified", "success", id);
    return { serverId: id, fingerprint: input.fingerprint };
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
        clusterPermissions: true,
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
    const parsed = agentAccessSchema.extend({ name: z.string().trim().min(1).max(100), level: z.enum(["administrator", "custom"]).default("custom"), clusterIds: z.array(z.uuid()).max(50).default([]), clusterOperations: z.array(z.enum(kubernetesOperations as [string, ...string[]])).max(20).default([]), expiresInDays: z.number().int().min(1).max(90).default(30), ...agentLimits }).parse(body);
    const a = parsed.level === "administrator" ? { ...parsed, ...administratorAgentAccess } : parsed;
    if (a.level === "administrator" && p.kind === "agent" && !isAgentAdministrator(p)) human(p);
    if ((await db.server.count({ where: { id: { in: a.serverIds }, organizationId: p.organizationId, archived: false } })) !== new Set(a.serverIds).size) throw new BadRequestException("Server unavailable");
    if (a.level === "custom" && (a.clusterIds.length || a.clusterOperations.length)) {
      if (!isAgentAdministrator(p)) human(p);
      if (a.clusterIds.length && !a.clusterOperations.length) throw new BadRequestException("Choose Kubernetes tools for the selected clusters");
      if (await db.kubernetesCluster.count({ where: { organizationId: p.organizationId, id: { in: a.clusterIds } } }) !== new Set(a.clusterIds).size) throw new BadRequestException("Cluster unavailable");
    }
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
        clusterPermissions: { create: [...new Set(a.clusterIds)].map((clusterId) => ({ clusterId, operations: JSON.stringify(a.clusterOperations) })) },
        tokens: {
          create: {
            tokenHash: hash(token),
            issuer: config.MCP_AUTH_ISSUER,
            audience: mcpAudience,
            scopes: JSON.stringify([
              ...new Set([
                ...a.operations,
                ...a.clusterOperations,
                ...(a.level === "administrator" ? administratorAgentScopes : []),
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
    const parsed = agentAccessSchema.parse(body);
    const a = parsed.level === "administrator" ? { ...parsed, ...administratorAgentAccess } : parsed;
    if ((a.clusterIds === undefined) !== (a.clusterOperations === undefined)) throw new BadRequestException("Supply both clusterIds and clusterOperations");
    if ((a.level === "administrator" || a.clusterIds !== undefined) && !isAgentAdministrator(p)) human(p);
    if (a.clusterIds?.length && !a.clusterOperations?.length) throw new BadRequestException("Choose Kubernetes tools for the selected clusters");
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
      if (a.clusterIds !== undefined) {
        if (await tx.kubernetesCluster.count({ where: { organizationId: p.organizationId, id: { in: a.clusterIds } } }) !== new Set(a.clusterIds).size) throw new BadRequestException("Cluster unavailable");
        await tx.kubernetesAgentPermission.deleteMany({ where: { agentId: id } });
        await tx.kubernetesAgentPermission.createMany({ data: [...new Set(a.clusterIds)].map((clusterId) => ({ agentId: id, clusterId, operations: JSON.stringify(a.clusterOperations) })) });
      }
      const tokens = await tx.agentToken.findMany({ where: { agentId: id, revoked: false } });
      for (const token of tokens) {
        const old: string[] = JSON.parse(token.scopes);
        const clusterScopes = a.clusterOperations ?? old.filter((op) => kubernetesOperations.includes(op));
        await tx.agentToken.update({ where: { id: token.id }, data: { scopes: JSON.stringify([...new Set(a.level === "administrator" ? administratorAgentScopes : [...a.operations, ...clusterScopes, ...(a.workspaceManagement ? [WORKSPACE_MANAGE] : [])])]) } });
      }
    });
    await audit(p, "agent_access_updated", "success", undefined, id);
    return { updated: true };
  }
  @Post("agents/:id/grants") async agentGrant(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = await authenticate(req);
    admin(p);
    const input = z.object({ serverId: z.uuid(), operations: z.array(z.enum(allOperations.filter((op) => op !== "terminal") as [string, ...string[]])).min(1).max(60) }).strict().parse(body);
    await db.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, organizationId: p.organizationId, revoked: false, owner: { disabled: false } } });
      if (!agent) throw new NotFoundException("Agent unavailable");
      const server = await tx.server.findFirst({ where: { id: input.serverId, organizationId: p.organizationId, archived: false } });
      if (!server) throw new NotFoundException("Server unavailable");
      if (agent.level === "administrator") throw new BadRequestException("Administrator access is automatic. Choose Custom to edit grants.");
      const operations = JSON.stringify([...new Set(input.operations)]);
      await tx.agentPermission.upsert({ where: { agentId_serverId: { agentId: id, serverId: input.serverId } }, create: { agentId: id, serverId: input.serverId, operations }, update: { operations } });
      await tx.auditEvent.create({ data: { organizationId: p.organizationId, principalId: p.id, action: "agent_grant_updated", status: "success", serverId: input.serverId, correlationId: randomUUID(), requestId: currentRequestId() } });
    });
    return { agentId: id, serverId: input.serverId, operations: [...new Set(input.operations)] };
  }
  @Delete("agents/:id/grants/:serverId") async agentRevokeGrant(@Req() req: Request, @Param("id") id: string, @Param("serverId") serverId: string) {
    const p = await authenticate(req);
    admin(p);
    z.uuid().parse(serverId);
    const removed = await db.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, organizationId: p.organizationId, revoked: false, owner: { disabled: false } } });
      if (!agent) throw new NotFoundException("Agent unavailable");
      const server = await tx.server.findFirst({ where: { id: serverId, organizationId: p.organizationId, archived: false } });
      if (!server) throw new NotFoundException("Server unavailable");
      if (agent.level === "administrator") throw new BadRequestException("Administrator access is automatic. Choose Custom to edit grants.");
      const result = await tx.agentPermission.deleteMany({ where: { agentId: id, serverId } });
      await tx.auditEvent.create({ data: { organizationId: p.organizationId, principalId: p.id, action: "agent_grant_revoked", status: "success", serverId, correlationId: randomUUID(), requestId: currentRequestId() } });
      return result.count > 0;
    });
    return { agentId: id, serverId, removed };
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
    const [executions, management, clusterExecutions] = await Promise.all([
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
      db.kubernetesExecution.findMany({ where: { organizationId: p.organizationId, principalId: id }, select: { id: true, createdAt: true, operation: true, status: true, clusterId: true, cluster: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const clusters = await db.kubernetesCluster.findMany({ where: { organizationId: p.organizationId }, select: { id: true, name: true } });
    const names = new Map(clusters.map((cluster) => [cluster.id, cluster.name]));
    return [
      ...clusterExecutions.map(({ cluster, ...entry }) => ({ ...entry, serverId: entry.clusterId, server: { name: cluster.name + " (Kubernetes)" } })),
      ...executions,
      ...management.map((event) => ({
        ...event,
        operation: event.action.split(":")[1],
        serverId: event.action.split(":")[2] || "workspace",
        server: { name: names.has(event.action.split(":")[2]) ? names.get(event.action.split(":")[2]) + " (Kubernetes)" : "Workspace" },
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
    return [];
  }
  @Post("approvals/:id") async decide(
    @Req() req: Request,
    @Param("id") _id: string,
    @Body() _body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    throw new BadRequestException("Approvals are no longer supported; authorized operations execute directly.");
  }
  @Get("audit") async logs(
    @Req() req: Request,
    @Query("action") action?: string,
    @Query("cursor") cursor?: string,
    @Query("requestId") requestId?: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    return db.auditEvent.findMany({
      where: {
        organizationId: p.organizationId,
        ...(action ? { action: { contains: action.slice(0, 100) } } : {}),
        ...(requestId ? { requestId: z.uuid().parse(requestId) } : {}),
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
      kubernetesOperations,
      kubernetesReadOperations,
      managementTools: Object.entries(managementTools).map(([name, tool]) => ({
        name,
        description: tool.description,
      })),
      acceptNewHostKeys: await acceptsNewHostKeys(p.organizationId),
      deploymentCidrs: config.SSH_ALLOWED_CIDRS.split(","),
      workspaceCidrs: await workspaceCidrs(p.organizationId),
      allowlistLocked: config.SSH_ALLOWLIST_LOCKED,
      ...(["owner", "administrator"].includes(p.role)
        ? { approvalWebhook: "" }
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
    // Legacy approvalWebhook input is accepted but ignored; notifications were removed.
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
  @Get("internal/batches/:id/status") async batchStatus(@Req() req: Request, @Param("id") id: string) {
    internal(req);
    const batch = await db.batchDispatch.findUnique({ where: { id: z.uuid().parse(id) }, select: { status: true } });
    if (!batch) throw new NotFoundException("Batch unavailable");
    return batch;
  }
  @Post("internal/batches/:id/abort") async abortBatch(@Req() req: Request, @Param("id") id: string) {
    internal(req);
    const batchId = z.uuid().parse(id);
    return db.$transaction(async (tx) => {
      const changed = await tx.batchDispatch.updateMany({ where: { id: batchId, status: { in: ["released", "executing"] } }, data: { status: "aborted" } });
      if (!changed.count) return { aborted: false };
      const tasks = await tx.backgroundTask.findMany({ where: { batchId }, select: { id: true } });
      await tx.backgroundTask.updateMany({ where: { batchId, status: { in: ["queued", "running"] } }, data: { status: "failed", leaseHash: null } });
      await tx.commandExecution.updateMany({ where: { id: { in: tasks.map((task) => task.id) }, status: { in: ["queued", "running"] } }, data: { status: "failed" } });
      await tx.auditEvent.updateMany({ where: { correlationId: batchId, action: "ssh_execute_many", status: "queued" }, data: { status: "failed" } });
      return { aborted: true };
    });
  }
  @Post("internal/batches/:id/start") async startBatch(@Req() req: Request, @Param("id") id: string) {
    internal(req);
    const batchId = z.uuid().parse(id);
    return db.$transaction(async (tx) => {
      const batch = await tx.batchDispatch.findFirst({ where: { id: batchId, status: "released" } });
      if (!batch) throw new ForbiddenException("Batch unavailable");
      const tasks = await tx.backgroundTask.findMany({ where: { batchId }, select: { principalId: true, organizationId: true, tokenId: true, serverId: true, status: true } });
      if (!tasks.length || tasks.some((task) => task.principalId !== batch.principalId || task.organizationId !== batch.organizationId || task.status !== "running"))
        throw new ForbiddenException("Batch preflight is incomplete");
      const agent = await tx.agent.findFirst({ where: { id: batch.principalId, organizationId: batch.organizationId, revoked: false, owner: { disabled: false } }, include: { owner: true, tokens: { where: { id: tasks[0].tokenId ?? "", revoked: false, expiresAt: { gt: new Date() } } } } });
      if (agent) {
        const token = agent.tokens[0];
        const scopes: string[] = token ? effectiveAgentScopes(agent.level, JSON.parse(token.scopes), agent.owner.role) : [];
        if (tasks.some((task) => task.tokenId !== tasks[0].tokenId) || !batchTokenAllowed(tasks[0].tokenId, token ? { id: token.id, scopes } : null))
          throw new ForbiddenException("Original agent token no longer permits this batch");
      } else {
        if (tasks.some((task) => task.tokenId !== null)) throw new ForbiddenException("Original agent is unavailable");
        const user = await tx.user.findFirst({ where: { id: batch.principalId, organizationId: batch.organizationId, disabled: false } });
        if (!user) throw new ForbiddenException("Requesting user is unavailable");
        for (const task of tasks) {
          const server = await tx.server.findFirst({ where: { id: task.serverId, organizationId: batch.organizationId, archived: false } });
          if (!server) throw new ForbiddenException("Batch server is unavailable");
          if (["owner", "administrator"].includes(user.role)) continue;
          const [own, teams] = await Promise.all([
            tx.serverPermission.findUnique({ where: { serverId_userId: { serverId: task.serverId, userId: user.id } } }),
            tx.teamPermission.findMany({ where: { serverId: task.serverId, team: { members: { some: { userId: user.id } } } } }),
          ]);
          if (user.role === "viewer" || ![own, ...teams].some((grant) => grant && JSON.parse(grant.operations).includes("ssh_execute")))
            throw new ForbiddenException("Batch server execution grant was removed");
        }
      }
      if (agent) for (const task of tasks) {
        const server = await tx.server.findFirst({ where: { id: task.serverId, organizationId: batch.organizationId, archived: false } });
        const grant = await tx.agentPermission.findUnique({ where: { agentId_serverId: { agentId: agent.id, serverId: task.serverId } } });
        const full = agent.tokens[0] && administratorToken(agent.level, effectiveAgentScopes(agent.level, JSON.parse(agent.tokens[0].scopes), agent.owner.role));
        if (!server || (!full && (!grant || !JSON.parse(grant.operations).includes("ssh_execute"))))
          throw new ForbiddenException("Batch server execution grant was removed");
      }
      await tx.batchDispatch.update({ where: { id: batchId }, data: { status: "executing" } });
      return { started: true };
    });
  }
  @Post("internal/batches/:id/complete") async completeBatch(@Req() req: Request, @Param("id") id: string) {
    internal(req);
    await db.batchDispatch.updateMany({ where: { id: z.uuid().parse(id), status: "executing" }, data: { status: "completed" } });
    return { completed: true };
  }
  @Get("internal/tasks/:id/status") async taskStatus(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    internal(req);
    const t = await db.backgroundTask.findUniqueOrThrow({ where: { id } });
    return { cancelled: await taskCancelled(t) };
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
        connectedHost: z.string().min(1).max(253).optional(),
        connectedPort: z.number().int().min(1).max(65535).optional(),
      })
      .parse(body);
    const t = await db.backgroundTask.findUniqueOrThrow({ where: { id } });
    if (!t.leaseHash || !equal(t.leaseHash, hash(a.lease)))
      throw new ForbiddenException();
    const status = await finishTask(id, t.leaseHash, a);
    if (status === "completed" && a.connectedHost && a.connectedPort)
      await markSshReachable(t.organizationId, t.serverId, { host: a.connectedHost, port: a.connectedPort }).catch(() => {});
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
    // The persisted status is authoritative: a cancellation that committed
    // before this finish wins, and the worker must not report success.
    return { ok: true, status };
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
