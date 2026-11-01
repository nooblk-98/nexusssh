import { kubernetesRoute } from "./kubernetes-route.js";
import { withKubernetesSlot } from "./kubernetes-slots.js";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../../../packages/database/index.js";
import { seal, unseal } from "../../../packages/shared/crypto.js";
import { config } from "../../../packages/shared/config.js";
import type { Principal } from "../../../packages/policy-engine/index.js";
import { admin, authenticate, human } from "./auth.js";
import {
  kubeconfigContexts,
  KubeconfigError,
  namespaceName,
  parseKubeconfig,
  resourceName,
  type ClusterConnection,
} from "../../../packages/kubernetes/kubeconfig.js";
import {
  kubernetesRequest,
  KubernetesError,
} from "../../../packages/kubernetes/client.js";
import {
  resourceKinds,
  resourcePath,
  resources,
  summarizeResource,
} from "../../../packages/kubernetes/resources.js";
import {
  prepareConsoleCommand,
  runConsoleCommand,
  formatConsoleResult,
} from "../../../packages/kubernetes/console.js";

const input = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    kubeconfig: z
      .string()
      .max(256 * 1024)
      .optional(),
    context: z.string().min(1).max(256).optional(),
    vpnProfileId: z.uuid().nullable().default(null),
    bastionId: z.uuid().nullable().default(null),
    groupId: z.uuid().nullable().default(null),
  })
  .strict();
const selection = {
  id: true,
  name: true,
  description: true,
  server: true,
  context: true,
  namespace: true,
  authentication: true,
  vpnProfileId: true,
  bastionId: true,
  groupId: true,
  status: true,
  version: true,
  lastCheckedAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertClusterFolder(
  organizationId: string,
  groupId: string | null,
  client: Pick<typeof db, "serverGroup">,
) {
  if (
    groupId &&
    !(await client.serverGroup.findFirst({
      where: { id: groupId, organizationId },
      select: { id: true },
    }))
  )
    throw new BadRequestException("Folder unavailable in this workspace.");
}

@Controller("api/kubernetes")
export class KubernetesController {
  private async principal(req: Request) {
    const p = await authenticate(req);
    human(p);
    admin(p);
    return p;
  }
  private async profile(p: Principal, id: string) {
    const cluster = await db.kubernetesCluster.findFirst({
      where: { id: z.uuid().parse(id), organizationId: p.organizationId },
    });
    if (!cluster)
      throw new NotFoundException("Kubernetes cluster unavailable.");
    return cluster;
  }
  private async audit(
    p: Principal,
    action: string,
    status: string,
    id = "profile",
  ) {
    await db.auditEvent.create({
      data: {
        organizationId: p.organizationId,
        principalId: p.id,
        action: `kubernetes:${action}:${id}`,
        status,
        correlationId: randomUUID(),
      },
    });
  }
  private async read(
    p: Principal,
    cluster: {
      id: string;
      encryptedConfig: string;
      vpnProfileId?: string | null;
      bastionId?: string | null;
    },
    path: string,
    action: string,
    text = false,
  ) {
    return withKubernetesSlot(p.organizationId, async () => {
      try {
        const connection = unseal(
          cluster.encryptedConfig,
          config.ENCRYPTION_KEY,
          `${p.organizationId}:kubernetes:${cluster.id}`,
        ) as ClusterConnection;
        const { network: route } = await kubernetesRoute(
          p.organizationId,
          cluster,
        );
        const data = await kubernetesRequest(
          connection,
          path,
          config.KUBERNETES_ALLOWED_CIDRS.split(",")
            .map((cidr) => cidr.trim())
            .filter(Boolean),
          text,
          { route },
        );
        await this.audit(p, action, "success", cluster.id);
        return data;
      } catch (error) {
        await this.audit(p, action, "failed", cluster.id);
        if (error instanceof KubernetesError)
          throw new HttpException(error.message, error.status);
        if (error instanceof HttpException) throw error;
        throw new HttpException("Kubernetes request failed.", 502);
      }
    });
  }

  @Get("clusters") async list(@Req() req: Request) {
    const p = await this.principal(req);
    return db.kubernetesCluster.findMany({
      where: { organizationId: p.organizationId },
      select: selection,
      orderBy: { name: "asc" },
    });
  }

  @Post("contexts") async contexts(@Req() req: Request, @Body() body: unknown) {
    await this.principal(req);
    const { kubeconfig } = z
      .object({ kubeconfig: z.string().max(256 * 1024) })
      .strict()
      .parse(body);
    try {
      return kubeconfigContexts(kubeconfig);
    } catch (error) {
      throw new BadRequestException(
        error instanceof KubeconfigError
          ? error.message
          : "Invalid kubeconfig.",
      );
    }
  }

  private async save(req: Request, body: unknown, id?: string) {
    const p = await authenticate(req);
    // Workspace-management agents can submit a new credential, but they cannot
    // inspect, rotate or delete existing profiles, or grant themselves access.
    if (id || p.managementOperation !== "kubernetes_cluster_create") human(p);
    admin(p);
    const existing = id ? await this.profile(p, id) : undefined;
    const changes = z.record(z.string(), z.unknown()).parse(body);
    const value = input.parse({
      ...(existing
        ? {
            name: existing.name,
            description: existing.description,
            vpnProfileId: existing.vpnProfileId,
            bastionId: existing.bastionId,
            groupId: existing.groupId,
          }
        : {}),
      ...changes,
    });
    await kubernetesRoute(p.organizationId, value);
    const routeChanged =
      value.vpnProfileId !== (existing?.vpnProfileId ?? null) ||
      value.bastionId !== (existing?.bastionId ?? null);
    const profileId = id || randomUUID();
    if (!existing && !value.kubeconfig?.trim())
      throw new BadRequestException("Import a kubeconfig file.");
    if (value.context && !value.kubeconfig?.trim())
      throw new BadRequestException(
        "Upload the kubeconfig again to change its context.",
      );
    if (
      !existing &&
      (await db.kubernetesCluster.count({
        where: { organizationId: p.organizationId },
      })) >= 50
    )
      throw new BadRequestException(
        "This workspace already has 50 cluster profiles.",
      );
    let secret:
      | {
          encryptedConfig: string;
          server: string;
          context: string;
          namespace: string;
          authentication: string;
        }
      | undefined;
    if (value.kubeconfig?.trim()) {
      try {
        const connection = parseKubeconfig(value.kubeconfig, value.context);
        secret = {
          encryptedConfig: seal(
            connection,
            config.ENCRYPTION_KEY,
            `${p.organizationId}:kubernetes:${profileId}`,
          ),
          server: connection.server,
          context: connection.context,
          namespace: connection.namespace,
          authentication: connection.authentication,
        };
      } catch (error) {
        throw new BadRequestException(
          error instanceof KubeconfigError
            ? error.message
            : "Invalid kubeconfig.",
        );
      }
    }
    let row;
    try {
      row = existing
        ? await db.$transaction(async (tx) => {
            await assertClusterFolder(p.organizationId, value.groupId, tx);
            if (
              (secret || routeChanged) &&
              (await tx.kubernetesExecution.count({
                where: { clusterId: profileId, status: "running" },
              }))
            )
              throw new ConflictException(
                "Wait for active Kubernetes commands to finish before changing its connection or credentials.",
              );
            return tx.kubernetesCluster.update({
              where: { id: profileId },
              data: {
                name: value.name,
                description: value.description,
                vpnProfileId: value.vpnProfileId,
                bastionId: value.bastionId,
                groupId: value.groupId,
                ...secret,
                ...(secret || routeChanged
                  ? {
                      status: "unknown",
                      version: null,
                      lastCheckedAt: null,
                      lastError: null,
                    }
                  : {}),
              },
              select: selection,
            });
          })
        : await db.$transaction(async (tx) => {
            await assertClusterFolder(p.organizationId, value.groupId, tx);
            return tx.kubernetesCluster.create({
              data: {
                id: profileId,
                organizationId: p.organizationId,
                name: value.name,
                description: value.description,
                vpnProfileId: value.vpnProfileId,
                bastionId: value.bastionId,
                groupId: value.groupId,
                ...secret!,
              },
              select: selection,
            });
          });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw new ConflictException("A cluster with this name already exists.");
      throw error;
    }
    await this.audit(
      p,
      existing ? "profile_updated" : "profile_created",
      "success",
      profileId,
    );
    return row;
  }

  @Post("clusters") create(@Req() req: Request, @Body() body: unknown) {
    return this.save(req, body);
  }
  @Patch("clusters/:id") update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.save(req, body, id);
  }

  @Patch("clusters/:id/move") async move(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const p = await this.principal(req);
    const { groupId } = z
      .object({ groupId: z.uuid().nullable() })
      .strict()
      .parse(body);
    await db.$transaction(async (tx) => {
      const cluster = await tx.kubernetesCluster.findFirst({
        where: { id: z.uuid().parse(id), organizationId: p.organizationId },
        select: { id: true },
      });
      if (!cluster)
        throw new NotFoundException("Kubernetes cluster unavailable.");
      await assertClusterFolder(p.organizationId, groupId, tx);
      await tx.kubernetesCluster.update({ where: { id }, data: { groupId } });
    });
    await this.audit(p, "profile_moved", "success", id);
    return { id, groupId };
  }

  @Delete("clusters/:id") async remove(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await this.principal(req);
    await this.profile(p, id);
    await db.$transaction(async (tx) => {
      if (
        await tx.kubernetesExecution.count({
          where: { clusterId: id, status: "running" },
        })
      )
        throw new ConflictException(
          "Wait for active Kubernetes commands to finish before deleting this cluster.",
        );
      await tx.kubernetesCluster.delete({ where: { id } });
    });
    await this.audit(p, "profile_deleted", "success", id);
    return { deleted: true };
  }

  @Post("clusters/:id/check") async check(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const p = await this.principal(req),
      cluster = await this.profile(p, id);
    try {
      const version = await this.read(
        p,
        cluster,
        "/version",
        "connection_checked",
      );
      if (typeof version?.gitVersion !== "string")
        throw new HttpException(
          "The endpoint did not return a Kubernetes version.",
          502,
        );
      return await db.kubernetesCluster.update({
        where: { id },
        data: {
          status: "connected",
          version: version.gitVersion.slice(0, 100),
          lastCheckedAt: new Date(),
          lastError: null,
        },
        select: selection,
      });
    } catch (error) {
      await db.kubernetesCluster.update({
        where: { id },
        data: {
          status: "error",
          lastCheckedAt: new Date(),
          lastError:
            error instanceof HttpException &&
            typeof error.getResponse() === "string"
              ? String(error.getResponse())
              : "Connection check failed.",
        },
        select: { id: true },
      });
      throw error;
    }
  }

  @Post("clusters/:id/console") async consoleCommand(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClose);
    try {
      const p = await this.principal(req);
      const args = z
        .object({
          command: z.array(z.string().min(1).max(8192)).min(1).max(64),
          namespace: namespaceName.optional(),
          manifest: z
            .string()
            .max(256 * 1024)
            .optional(),
          timeoutMs: z.number().int().min(1000).max(60000).default(30000),
        })
        .strict()
        .parse(body);
      if (res.destroyed) abort.abort();
      abort.signal.throwIfAborted();
      return await withKubernetesSlot(p.organizationId, async () => {
        const { cluster, route, plan, execution } = await db.$transaction(
          async (tx) => {
            const cluster = await tx.kubernetesCluster.findFirst({
              where: {
                id: z.uuid().parse(id),
                organizationId: p.organizationId,
              },
            });
            if (!cluster)
              throw new NotFoundException("Kubernetes cluster unavailable.");
            let plan;
            try {
              plan = prepareConsoleCommand(
                { ...args, namespace: undefined },
                args.namespace || cluster.namespace,
              );
            } catch (error) {
              throw new BadRequestException(
                error instanceof Error
                  ? error.message
                  : "Unsupported kubectl command.",
              );
            }
            const { network: route } = await kubernetesRoute(
              p.organizationId,
              cluster,
              tx,
            );
            abort.signal.throwIfAborted();
            const execution = await tx.kubernetesExecution.create({
              data: {
                organizationId: p.organizationId,
                principalId: p.id,
                clusterId: cluster.id,
                operation: "kubernetes_console",
                status: "running",
                expiresAt: new Date(Date.now() + 3600000),
              },
            });
            return { cluster, route, plan, execution };
          },
        );
        let status = "interrupted";
        try {
          const connection = unseal(
            cluster.encryptedConfig,
            config.ENCRYPTION_KEY,
            `${p.organizationId}:kubernetes:${cluster.id}`,
          ) as ClusterConnection;
          const verb =
            args.command[0] === "kubectl" ? args.command[1] : args.command[0];
          const explicitOutput = args.command.some((part) =>
            /^(?:-o|--output)(?:=|$)/.test(part),
          );
          const result = await runConsoleCommand(
            connection,
            plan,
            config.KUBERNETES_ALLOWED_CIDRS.split(",")
              .map((cidr) => cidr.trim())
              .filter(Boolean),
            {
              route,
              signal: abort.signal,
              timeoutMs: args.timeoutMs,
              ...(verb === "get" && !explicitOutput
                ? {
                    accept:
                      "application/json;as=Table;g=meta.k8s.io;v=v1,application/json",
                  }
                : {}),
            },
          );
          await this.principal(req);
          status = "completed";
          return formatConsoleResult(result, args.command, plan.text);
        } catch (error) {
          if (error instanceof KubernetesError)
            throw new HttpException(error.message, error.status);
          if (error instanceof HttpException) throw error;
          throw new HttpException(
            "Command interrupted. The remote outcome may be unknown; inspect the cluster before retrying.",
            502,
          );
        } finally {
          await db.kubernetesExecution.update({
            where: { id: execution.id },
            data: { status },
          });
          await this.audit(p, "console_command", status, cluster.id);
        }
      });
    } finally {
      res.off("close", onClose);
    }
  }

  @Get("clusters/:id/resources/:resource") async listResources(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("resource") raw: string,
    @Query() query: unknown,
  ) {
    const p = await this.principal(req),
      cluster = await this.profile(p, id);
    const resource = z.enum(resourceKinds).parse(raw);
    const args = z
      .object({
        namespace: z.union([namespaceName, z.literal("*")]).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(query);
    const data = await this.read(
      p,
      cluster,
      resourcePath(
        resource,
        resources[resource].namespaced
          ? (args.namespace ?? cluster.namespace)
          : undefined,
        args.cursor,
      ),
      `list_${resource}`,
    );
    if (!Array.isArray(data?.items) || data.items.length > 100)
      throw new HttpException(
        "The cluster returned an invalid resource page.",
        502,
      );
    return {
      items: data.items.map((item: unknown) =>
        summarizeResource(resource, item),
      ),
      nextCursor:
        typeof data.metadata?.continue === "string" &&
        data.metadata.continue.length <= 4096
          ? data.metadata.continue || null
          : null,
    };
  }

  @Get("clusters/:id/pods/:namespace/:pod/logs") async logs(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("namespace") rawNamespace: string,
    @Param("pod") rawPod: string,
    @Query() query: unknown,
  ) {
    const p = await this.principal(req),
      cluster = await this.profile(p, id);
    const namespace = namespaceName.parse(rawNamespace),
      pod = resourceName.parse(rawPod);
    const args = z
      .object({
        container: resourceName,
        lines: z.coerce.number().int().min(1).max(1000).default(200),
        previous: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .parse(query);
    const params = new URLSearchParams({
      container: args.container,
      tailLines: String(args.lines),
      previous: args.previous,
      timestamps: "true",
      limitBytes: String(256 * 1024),
    });
    return this.read(
      p,
      cluster,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`,
      "pod_logs",
      true,
    );
  }
}
