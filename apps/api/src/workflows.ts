import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import { seal, unseal } from "../../../packages/shared/crypto.js";
import {
  presetLayout,
  renderRunbook,
  runbookDefinition,
  runbookParameters,
  type RunbookDefinition,
} from "../../../packages/shared/workflows.js";
import { authenticate, human, admin } from "./auth.js";
import { audit } from "./domain.js";

@Controller("api")
export class WorkflowsController {
  @Get("workspace-presets") async presets(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    const rows = await db.workspacePreset.findMany({
      where: { organizationId: p.organizationId, userId: p.id },
      orderBy: { name: "asc" },
      take: 50,
    });
    return rows.map(({ layout, ...row }) => ({
      ...row,
      layout: JSON.parse(layout),
    }));
  }
  @Post("workspace-presets") async savePreset(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    human(p);
    const input = z
      .object({ name: z.string().trim().min(1).max(100), layout: presetLayout })
      .strict()
      .parse(body);
    const existing = await db.workspacePreset.findUnique({
      where: { userId_name: { userId: p.id, name: input.name } },
    });
    if (
      !existing &&
      (await db.workspacePreset.count({ where: { userId: p.id } })) >= 50
    )
      throw new BadRequestException("Keep at most 50 workspace presets.");
    const row = await db.workspacePreset.upsert({
      where: { userId_name: { userId: p.id, name: input.name } },
      create: {
        organizationId: p.organizationId,
        userId: p.id,
        name: input.name,
        layout: JSON.stringify(input.layout),
      },
      update: { layout: JSON.stringify(input.layout) },
    });
    await audit(p, "workspace_preset_saved", "success");
    return { id: row.id };
  }
  @Delete("workspace-presets/:id") async deletePreset(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    human(p);
    await db.workspacePreset.deleteMany({
      where: {
        id: z.uuid().parse(id),
        organizationId: p.organizationId,
        userId: p.id,
      },
    });
    return { deleted: true };
  }
  @Get("runbooks") async runbooks(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    return db.runbook.findMany({
      where: { organizationId: p.organizationId },
      select: {
        id: true,
        name: true,
        revisions: {
          select: { id: true, version: true, createdAt: true },
          orderBy: { version: "desc" },
          take: 50,
        },
      },
      orderBy: { name: "asc" },
      take: 100,
    });
  }
  @Post("runbooks") async saveRunbook(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const p = await authenticate(req);
    admin(p);
    const a = z
      .object({
        name: z.string().trim().min(1).max(100),
        definition: runbookDefinition,
      })
      .strict()
      .parse(body);
    try {
      runbookParameters(a.definition.template);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.runbook.findUnique({
        where: {
          organizationId_name: {
            organizationId: p.organizationId,
            name: a.name,
          },
        },
      });
      if (
        !existing &&
        (await tx.runbook.count({
          where: { organizationId: p.organizationId },
        })) >= 100
      )
        throw new BadRequestException(
          "Keep at most 100 runbooks per workspace.",
        );
      const book = await tx.runbook.upsert({
        where: {
          organizationId_name: {
            organizationId: p.organizationId,
            name: a.name,
          },
        },
        create: { organizationId: p.organizationId, name: a.name },
        update: {},
      });
      const last = await tx.runbookRevision.findFirst({
        where: { runbookId: book.id },
        orderBy: { version: "desc" },
      });
      if ((last?.version ?? 0) >= 100)
        throw new BadRequestException(
          "This runbook has reached its 100-version limit. Create a new runbook.",
        );
      const id = randomUUID();
      const revision = await tx.runbookRevision.create({
        data: {
          id,
          runbookId: book.id,
          principalId: p.id,
          version: (last?.version ?? 0) + 1,
          encryptedDefinition: seal(
            a.definition,
            config.ENCRYPTION_KEY,
            `${p.organizationId}:runbook:${id}`,
          ),
        },
      });
      return {
        id: book.id,
        revisionId: revision.id,
        version: revision.version,
      };
    });
    await audit(p, "runbook_version_created", "success");
    return result;
  }
  @Get("runbooks/:id/revisions/:revisionId") async definition(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("revisionId") revisionId: string,
  ) {
    const p = await authenticate(req);
    human(p);
    const row = await db.runbookRevision.findFirst({
      where: {
        id: z.uuid().parse(revisionId),
        runbookId: z.uuid().parse(id),
        runbook: { organizationId: p.organizationId },
      },
    });
    if (!row) throw new NotFoundException("Runbook version unavailable");
    const definition = unseal<RunbookDefinition>(
      row.encryptedDefinition,
      config.ENCRYPTION_KEY,
      `${p.organizationId}:runbook:${row.id}`,
    );
    return {
      ...definition,
      parameters: runbookParameters(definition.template),
      version: row.version,
    };
  }
  @Post("runbooks/:id/revisions/:revisionId/preview") async preview(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("revisionId") revisionId: string,
    @Body() body: unknown,
  ) {
    const values = z
      .record(z.string().max(32), z.string().max(1000))
      .parse(body);
    const definition = await this.definition(req, id, revisionId);
    try {
      return {
        command: renderRunbook(definition.template, values),
        timeoutMs: definition.timeoutMs,
        version: definition.version,
      };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
  @Delete("runbooks/:id") async deleteRunbook(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await authenticate(req);
    admin(p);
    await db.runbook.deleteMany({
      where: { id: z.uuid().parse(id), organizationId: p.organizationId },
    });
    await audit(p, "runbook_deleted", "success");
    return { deleted: true };
  }
}
