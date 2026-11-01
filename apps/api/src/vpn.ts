import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Req,
  Param,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../../../packages/database/index.js";
import { settingsReferenceCount } from "./metadata.js";
import { config } from "../../../packages/shared/config.js";
import { seal } from "../../../packages/shared/crypto.js";
import {
  parseWireGuard,
  wireguardSummary,
} from "../../../packages/shared/wireguard.js";
import { authenticate, admin, workspace } from "./auth.js";
import { audit } from "./domain.js";
const input = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    config: z.string().max(65536).optional(),
  })
  .strict();
const selection = {
  id: true,
  name: true,
  description: true,
  summary: true,
  updatedAt: true,
  _count: { select: { servers: true, clusters: true } },
} as const;
@Controller("api/vpn-profiles")
export class VpnController {
  @Get() async list(@Req() req: Request) {
    const p = await authenticate(req);
    workspace(p);
    const rows = await db.vpnProfile.findMany({
      where: { organizationId: p.organizationId },
      select: selection,
      orderBy: { name: "asc" },
    });
    return rows.map((row) => ({ ...row, summary: JSON.parse(row.summary) }));
  }
  async save(req: Request, body: unknown, id?: string) {
    const p = await authenticate(req);
    admin(p);
    const existing = id
      ? await db.vpnProfile.findFirst({
          where: { id, organizationId: p.organizationId },
          select: { name: true, description: true },
        })
      : undefined;
    if (id && !existing) throw new NotFoundException("VPN profile unavailable");
    const a = input.parse({
      ...existing,
      ...z.record(z.string(), z.unknown()).parse(body),
    });
    if (!id && !a.config?.trim())
      throw new BadRequestException("Import a WireGuard client configuration");
    const profileId = id || randomUUID();
    let secret: { encryptedConfig: string; summary: string } | undefined;
    if (a.config?.trim()) {
      try {
        const parsed = parseWireGuard(a.config);
        secret = {
          encryptedConfig: seal(
            parsed,
            config.ENCRYPTION_KEY,
            p.organizationId + ":vpn:" + profileId,
          ),
          summary: JSON.stringify(wireguardSummary(parsed)),
        };
      } catch (e) {
        throw new BadRequestException(
          e instanceof z.ZodError
            ? "Invalid WireGuard keys, addresses, or peer settings"
            : (e as Error).message,
        );
      }
    }
    const row = id
      ? await db.vpnProfile.update({
          where: { id },
          data: { name: a.name, description: a.description, ...secret },
          select: selection,
        })
      : await db.vpnProfile.create({
          data: {
            id: profileId,
            organizationId: p.organizationId,
            name: a.name,
            description: a.description,
            ...secret!,
          },
          select: selection,
        });
    await audit(
      p,
      id ? "vpn_profile_updated" : "vpn_profile_created",
      "success",
    );
    return { ...row, summary: JSON.parse(row.summary) };
  }
  @Post() create(@Req() req: Request, @Body() body: unknown) {
    return this.save(req, body);
  }
  @Patch(":id") update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.save(req, body, id);
  }
  @Delete(":id") async remove(@Req() req: Request, @Param("id") id: string) {
    const p = await authenticate(req);
    admin(p);
    if (
      !(await db.vpnProfile.findFirst({
        where: { id, organizationId: p.organizationId },
      }))
    )
      throw new NotFoundException("VPN profile unavailable");
    try {
      await db.$transaction(async (tx) => {
        if (await tx.kubernetesCluster.count({ where: { organizationId: p.organizationId, vpnProfileId: id } })) throw new BadRequestException("Remove this VPN profile from Kubernetes clusters before deleting it");
        if (await settingsReferenceCount(tx, p.organizationId, "vpnProfileId", id))
          throw new BadRequestException("Remove this VPN profile from servers, folder defaults and tag defaults before deleting it");
        await tx.vpnProfile.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Profile is in use or unavailable");
    }
    await audit(p, "vpn_profile_deleted", "success");
    return { deleted: true };
  }
}
