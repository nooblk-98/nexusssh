import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { db } from "../../../packages/database/index.js";
import type { Prisma } from "@prisma/client";
import { sshHealthState, SSH_HEALTH_STALE_MS } from "../../../packages/shared/ssh-health.js";

export const settingsSchema = z.object({
  identityId: z.uuid().optional(),
  username: z.string().trim().min(1).max(32).optional(),
  environment: z.enum(["development", "staging", "production"]).optional(),
  vpnProfileId: z.uuid().nullable().optional(),
}).strict();
export const metadataSchema = z.object({
  vcpu: z.number().int().min(0).max(65535).nullable().optional(),
  ramBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  diskBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  os: z.string().trim().max(100).nullable().optional(),
  role: z.string().trim().max(100).nullable().optional(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export function parseSettings(raw: string): Settings { return settingsSchema.parse(JSON.parse(raw)); }
export const settingKeys = ["identityId", "username", "environment", "vpnProfileId"] as const;
export function mergeSettings(raw: string, change: Settings, inherit: (typeof settingKeys)[number][] = [], defaults = false) {
  const next = { ...parseSettings(raw), ...change };
  for (const key of inherit) delete next[key];
  if (defaults && next.vpnProfileId === null) delete next.vpnProfileId;
  return JSON.stringify(settingsSchema.parse(next));
}
export async function validateSettings(org: string, settings: Settings, client: Prisma.TransactionClient = db) {
  if (settings.identityId && !(await client.sSHIdentity.findFirst({ where: { id: settings.identityId, organizationId: org } })))
    throw new BadRequestException("Identity unavailable");
  if (settings.vpnProfileId && !(await client.vpnProfile.findFirst({ where: { id: settings.vpnProfileId, organizationId: org } })))
    throw new BadRequestException("VPN profile unavailable");
}
export async function resolveSettings(serverId: string, org: string, proposed?: {
  overrides?: Settings; groupId?: string | null; tagIds?: string[];
  defaults?: { type: "folder" | "tag"; id: string; value: Settings };
  client?: Prisma.TransactionClient;
}) {
  const client = proposed?.client ?? db;
  const server = await client.server.findFirst({ where: { id: serverId, organizationId: org }, include: { tags: true } });
  if (!server) throw new BadRequestException("Server unavailable");
  const groupId = proposed?.groupId === undefined ? server.groupId : proposed.groupId;
  const tags = proposed?.tagIds ? await client.serverTag.findMany({ where: { id: { in: proposed.tagIds }, organizationId: org } }) : server.tags;
  if (proposed?.tagIds && tags.length !== new Set(proposed.tagIds).size) throw new BadRequestException("Tag unavailable");
  const folders = [];
  const seen = new Set<string>();
  let current = groupId;
  while (current) {
    if (seen.has(current)) throw new BadRequestException("Folder cycle");
    seen.add(current);
    const folder = await client.serverGroup.findFirst({ where: { id: current, organizationId: org } });
    if (!folder) throw new BadRequestException("Folder unavailable");
    folders.push(folder);
    current = folder.parentId;
  }
  const own = proposed?.overrides ?? parseSettings(server.overrides);
  const values: Record<string, string | null> = {};
  const sources: Record<string, { type: string; id?: string }> = {};
  const conflicts: string[] = [];
  for (const key of ["identityId", "username", "environment", "vpnProfileId"] as const) {
    if (Object.hasOwn(own, key)) {
      values[key] = own[key] ?? null; sources[key] = { type: "server", id: serverId }; continue;
    }
    const folder = folders.find((f) => Object.hasOwn(f.id === proposed?.defaults?.id && proposed.defaults.type === "folder" ? proposed.defaults.value : parseSettings(f.defaults), key));
    if (folder) {
      const defaults = folder.id === proposed?.defaults?.id && proposed.defaults.type === "folder" ? proposed.defaults.value : parseSettings(folder.defaults);
      values[key] = defaults[key] ?? null; sources[key] = { type: "folder", id: folder.id }; continue;
    }
    const candidates = tags.map((t) => ({ id: t.id, value: (t.id === proposed?.defaults?.id && proposed.defaults.type === "tag" ? proposed.defaults.value : parseSettings(t.defaults))[key] })).filter((x) => x.value !== undefined);
    const distinct = new Set(candidates.map((x) => x.value));
    if (distinct.size > 1) { conflicts.push(key); continue; }
    if (candidates.length) { values[key] = candidates[0].value ?? null; sources[key] = { type: "tag", id: candidates[0].id }; continue; }
    values[key] = key === "environment" ? "development" : null;
    sources[key] = { type: "fallback" };
  }
  if (conflicts.length) throw new BadRequestException({ message: "Conflicting tag defaults", serverIds: [serverId], fields: conflicts });
  if (!values.identityId || !values.username) throw new BadRequestException({ message: "Effective identity and username are required", serverIds: [serverId] });
  await validateSettings(org, { identityId: values.identityId, vpnProfileId: values.vpnProfileId }, client);
  return { values: values as { identityId: string; username: string; environment: string; vpnProfileId: string | null }, sources };
}

export async function preflightAffected(tx: Prisma.TransactionClient, org: string, affectedIds: string[], defaults?: { type: "folder" | "tag"; id: string; value: Settings }) {
  const affected = new Set(affectedIds);
  const targets = await tx.server.findMany({ where: { organizationId: org, OR: [{ id: { in: affectedIds } }, { bastionId: { in: affectedIds } }] }, select: { id: true, bastionId: true } });
  const rejected: string[] = [];
  for (const target of targets) {
    try {
      const proposed = (id: string) => ({ client: tx, ...(defaults && affected.has(id) ? { defaults } : {}) });
      const targetSettings = await resolveSettings(target.id, org, proposed(target.id));
      const bastionSettings = target.bastionId ? await resolveSettings(target.bastionId, org, proposed(target.bastionId)) : null;
      if (targetSettings.values.vpnProfileId && bastionSettings?.values.vpnProfileId && targetSettings.values.vpnProfileId !== bastionSettings.values.vpnProfileId)
        throw new BadRequestException("Conflicting VPN profiles on target and bastion");
    } catch { rejected.push(target.id); }
  }
  if (rejected.length) throw new BadRequestException({ message: "Effective settings invalidate affected servers", serverIds: rejected });
  return targets.map((target) => target.id);
}

export async function settingsReferenceCount(tx: Prisma.TransactionClient, org: string, key: "identityId" | "vpnProfileId", id: string) {
  const [servers, folders, tags] = await Promise.all([
    tx.server.findMany({ where: { organizationId: org }, select: { identityId: true, vpnProfileId: true, overrides: true } }),
    tx.serverGroup.findMany({ where: { organizationId: org }, select: { defaults: true } }),
    tx.serverTag.findMany({ where: { organizationId: org }, select: { defaults: true } }),
  ]);
  return servers.filter((row) => row[key] === id || parseSettings(row.overrides)[key] === id).length
    + folders.filter((row) => parseSettings(row.defaults)[key] === id).length
    + tags.filter((row) => parseSettings(row.defaults)[key] === id).length;
}

export function numericMetadata<T extends { ramBytes: { toString(): string } | null; diskBytes: { toString(): string } | null; status: string; lastCheckedAt: Date | null; healthFailureCategory: string | null }>(row: T) {
  const number = (value: { toString(): string } | null) => {
    if (value === null) return null;
    const parsed = Number(value.toString());
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BadRequestException("Stored byte count exceeds the supported range");
    return parsed;
  };
  const healthStale = !row.lastCheckedAt || Date.now() - row.lastCheckedAt.getTime() > SSH_HEALTH_STALE_MS;
  return { ...row, ramBytes: number(row.ramBytes), diskBytes: number(row.diskBytes), status: sshHealthState(row), healthFailureCategory: healthStale ? null : row.healthFailureCategory, healthStale };
}
