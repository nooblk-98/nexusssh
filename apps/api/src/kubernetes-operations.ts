import {
  kubernetesRoute,
  kubernetesConnectionDigest,
} from "./kubernetes-route.js";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "../../../packages/database/index.js";
import { config, mcpAudience } from "../../../packages/shared/config.js";
import {
  canonical,
  hash,
  seal,
  unseal,
} from "../../../packages/shared/crypto.js";
import type { Principal } from "../../../packages/policy-engine/index.js";
import { kubernetesSchemas } from "../../../packages/kubernetes/tools.js";
import {
  kubernetesReadOperations,
  kubernetesWriteOperations,
} from "../../../packages/kubernetes/policy.js";
import {
  kubernetesRequest,
  KubernetesError,
} from "../../../packages/kubernetes/client.js";
import { kubernetesExec } from "../../../packages/kubernetes/exec.js";
import { planCommand } from "../../../packages/kubernetes/commands.js";
import {
  resourcePath,
  resources,
  summarizeResource,
  type Resource,
} from "../../../packages/kubernetes/resources.js";
import type { ClusterConnection } from "../../../packages/kubernetes/kubeconfig.js";
import { reserveAgentCall } from "./agent-quota.js";
import { withKubernetesSlot } from "./kubernetes-slots.js";

type Store = Prisma.TransactionClient;
const cidrs = () =>
  config.KUBERNETES_ALLOWED_CIDRS.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const approvalAAD = (org: string, id: string) =>
  `${org}:kubernetes-approval:${id}`;
const resultAAD = (org: string, id: string) =>
  `${org}:kubernetes-execution:${id}`;

// Re-read live token and grants for every request and again before consumption.
// workspace_manage and administrator agent level never imply cluster access.
export async function kubernetesAccess(
  p: Principal,
  op: string,
  clusterId?: string,
  store: Store = db,
) {
  if (p.kind === "user") {
    const user = await store.user.findFirst({
      where: {
        id: p.id,
        organizationId: p.organizationId,
        disabled: false,
        role: { in: ["owner", "administrator"] },
      },
    });
    if (!user)
      throw new ForbiddenException(
        "Kubernetes access requires an administrator.",
      );
    return;
  }
  if (!p.tokenId || !p.scopes.includes(op))
    throw new ForbiddenException(
      "Kubernetes tool is outside this token's scope.",
    );
  const token = await store.agentToken.findFirst({
    where: {
      id: p.tokenId,
      agentId: p.id,
      revoked: false,
      expiresAt: { gt: new Date() },
      issuer: config.MCP_AUTH_ISSUER,
      audience: mcpAudience,
    },
    include: { agent: { include: { owner: true } } },
  });
  if (
    !token ||
    token.agent.revoked ||
    token.agent.organizationId !== p.organizationId ||
    token.agent.owner.disabled ||
    !JSON.parse(token.scopes).includes(op) ||
    (token.agent.level === "viewer" && !kubernetesReadOperations.includes(op))
  )
    throw new ForbiddenException(
      "Agent credential or Kubernetes tool access is no longer valid.",
    );
  if (clusterId) {
    const grant = await store.kubernetesAgentPermission.findUnique({
      where: { agentId_clusterId: { agentId: p.id, clusterId } },
    });
    if (!grant || !JSON.parse(grant.operations).includes(op))
      throw new ForbiddenException(
        "Agent has no grant for this cluster and tool.",
      );
  }
}
async function clusterFor(
  p: Principal,
  op: string,
  id: string,
  store: Store = db,
) {
  await kubernetesAccess(p, op, id, store);
  const cluster = await store.kubernetesCluster.findFirst({
    where: { id, organizationId: p.organizationId },
  });
  if (!cluster) throw new NotFoundException("Kubernetes cluster unavailable.");
  return cluster;
}
async function callRecord(p: Principal, op: string, clusterId?: string) {
  const record = (tx: Store) =>
    tx.auditEvent.create({
      data: {
        organizationId: p.organizationId,
        principalId: p.id,
        action: `${p.kind === "agent" ? "mcp" : "kubernetes"}:${op}${clusterId ? ":" + clusterId : ""}`,
        status: "requested",
        correlationId: randomUUID(),
      },
    });
  return p.kind === "agent" ? reserveAgentCall(p.id, record) : record(db);
}
export async function kubernetesApprovalStatus(p: Principal, id: string) {
  const row = await db.kubernetesApproval.findFirst({
    where: {
      id,
      organizationId: p.organizationId,
      principalId: p.id,
      tokenId: p.tokenId || null,
    },
  });
  if (!row) throw new NotFoundException();
  await clusterFor(p, row.operation, row.clusterId);
  const event = await callRecord(p, "approval_get_status", row.clusterId);
  await db.auditEvent.update({
    where: { id: event.id },
    data: { status: "success" },
  });
  return {
    id: row.id,
    status:
      row.expiresAt < new Date() && ["pending", "approved"].includes(row.status)
        ? "expired"
        : row.status,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}
export async function kubernetesOperation(
  p: Principal,
  op: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const a = kubernetesSchemas[op].parse(input);
  await kubernetesAccess(p, op);
  const event = await callRecord(
    p,
    op,
    typeof a.clusterId === "string" ? a.clusterId : undefined,
  );
  try {
    const result = await perform(p, op, a, signal);
    await db.auditEvent.update({
      where: { id: event.id },
      data: {
        status:
          result.status === "approval_required"
            ? "approval_pending"
            : result.status === "interrupted" || result.status === "failed"
              ? result.status
              : "success",
      },
    });
    return result;
  } catch (error) {
    await db.auditEvent.update({
      where: { id: event.id },
      data: { status: "failed" },
    });
    if (error instanceof KubernetesError)
      throw new HttpException(error.message, error.status);
    throw error;
  }
}
async function perform(
  p: Principal,
  op: string,
  a: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  if (op === "kubernetes_clusters_list") {
    const rows = await db.kubernetesCluster.findMany({
      where: {
        organizationId: p.organizationId,
        ...(p.kind === "agent"
          ? { agentPermissions: { some: { agentId: p.id } } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        context: true,
        namespace: true,
        status: true,
        version: true,
        agentPermissions:
          p.kind === "agent"
            ? { where: { agentId: p.id }, select: { operations: true } }
            : false,
      },
      orderBy: { name: "asc" },
    });
    return {
      clusters: rows
        .filter(
          (r) =>
            p.kind !== "agent" ||
            r.agentPermissions.some((g) =>
              JSON.parse(g.operations).includes(op),
            ),
        )
        .map(({ agentPermissions: _grants, ...r }) => r),
    };
  }
  if (op === "kubernetes_execution_status") {
    const row = await db.kubernetesExecution.findFirst({
      where: {
        id: a.executionId,
        organizationId: p.organizationId,
        principalId: p.id,
        tokenId: p.tokenId || null,
      },
    });
    if (!row) throw new NotFoundException("Execution unavailable.");
    await clusterFor(p, op, row.clusterId);
    await kubernetesAccess(p, row.operation, row.clusterId);
    return {
      executionId: row.id,
      clusterId: row.clusterId,
      status: row.status,
      expiresAt: row.expiresAt,
      ...(row.encryptedResult && row.expiresAt > new Date()
        ? {
            result: unseal(
              row.encryptedResult,
              config.ENCRYPTION_KEY,
              resultAAD(p.organizationId, row.id),
            ),
          }
        : { result: null }),
    };
  }
  const cluster = await clusterFor(p, op, a.clusterId);
  const routing = await kubernetesRoute(p.organizationId, cluster);
  const connection = unseal(
    cluster.encryptedConfig,
    config.ENCRYPTION_KEY,
    `${p.organizationId}:kubernetes:${cluster.id}`,
  ) as ClusterConnection;
  if (kubernetesWriteOperations.includes(op)) {
    let plan: ReturnType<typeof planCommand> | undefined;
    if (op === "kubernetes_execute") {
      try {
        plan = planCommand(a as any, cluster.namespace);
      } catch {
        throw new BadRequestException(
          "Unsupported Kubernetes command, flags, namespace, or manifest. See the MCP command reference.",
        );
      }
    }
    const { approvalId, ...normalized } = a,
      digest = hash(canonical(normalized)),
      configDigest = kubernetesConnectionDigest(
        cluster.encryptedConfig,
        routing.digest,
      );
    if (!approvalId) {
      const id = randomUUID();
      const approval = await db.kubernetesApproval.create({
        data: {
          id,
          organizationId: p.organizationId,
          principalId: p.id,
          tokenId: p.tokenId || null,
          clusterId: cluster.id,
          operation: op,
          argumentDigest: digest,
          configDigest,
          encryptedArguments: seal(
            normalized,
            config.ENCRYPTION_KEY,
            approvalAAD(p.organizationId, id),
          ),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      const admins = await db.user.findMany({
        where: {
          organizationId: p.organizationId,
          disabled: false,
          role: { in: ["owner", "administrator"] },
        },
        select: { id: true },
      });
      await db.notification.createMany({
        data: admins.map((user) => ({
          organizationId: p.organizationId,
          principalId: user.id,
          message: `Approval required: ${op} on ${cluster.name}. Review the exact command in Approvals. Request ${id}.`,
        })),
      });
      return {
        status: "approval_required",
        approvalId: id,
        expiresAt: approval.expiresAt,
      };
    }
    return withKubernetesSlot(p.organizationId, async () => {
      signal?.throwIfAborted();
      const execution = await db.$transaction(async (tx) => {
        const current = await clusterFor(p, op, cluster.id, tx);
        const currentRoute = await kubernetesRoute(
          p.organizationId,
          current,
          tx,
        );
        if (
          kubernetesConnectionDigest(
            current.encryptedConfig,
            currentRoute.digest,
          ) !== configDigest
        )
          throw new ForbiddenException(
            "Cluster credentials changed. Request a new approval.",
          );
        const consumed = await tx.kubernetesApproval.updateMany({
          where: {
            id: approvalId,
            organizationId: p.organizationId,
            principalId: p.id,
            tokenId: p.tokenId || null,
            clusterId: cluster.id,
            operation: op,
            argumentDigest: digest,
            configDigest,
            status: "approved",
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { status: "consumed", consumedAt: new Date() },
        });
        if (consumed.count !== 1)
          throw new ForbiddenException(
            "Approval is missing, expired, mismatched, or already consumed.",
          );
        return tx.kubernetesExecution.create({
          data: {
            organizationId: p.organizationId,
            principalId: p.id,
            tokenId: p.tokenId || null,
            clusterId: cluster.id,
            operation: op,
            status: "running",
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
      });
      let status = "completed",
        result: unknown;
      try {
        await kubernetesAccess(p, op, cluster.id);
        signal?.throwIfAborted();
        result =
          op === "kubernetes_pod_exec"
            ? await kubernetesExec(
                connection,
                a as any,
                cidrs(),
                signal,
                routing.network,
              )
            : await kubernetesRequest(
                connection,
                plan!.path,
                cidrs(),
                plan!.text,
                {
                  ...plan,
                  signal,
                  timeoutMs: a.timeoutMs,
                  route: routing.network,
                },
              );
      } catch (error) {
        // A lost response never proves that a remote mutation/command failed.
        status = "interrupted";
        result = {
          message:
            error instanceof KubernetesError
              ? error.message
              : "Execution interrupted. The remote outcome may be unknown; inspect it before retrying.",
        };
      }
      await db.kubernetesExecution.update({
        where: { id: execution.id },
        data: {
          status,
          encryptedResult: seal(
            result,
            config.ENCRYPTION_KEY,
            resultAAD(p.organizationId, execution.id),
          ),
        },
      });
      // Do not disclose output if access was revoked while the command ran.
      await kubernetesAccess(p, op, cluster.id);
      return {
        executionId: execution.id,
        status,
        result,
        expiresAt: execution.expiresAt,
      };
    });
  }
  return withKubernetesSlot(p.organizationId, async () => {
    if (op === "kubernetes_cluster_check") {
      const version = await kubernetesRequest(
        connection,
        "/version",
        cidrs(),
        false,
        { signal, route: routing.network },
      );
      return {
        clusterId: cluster.id,
        version:
          typeof version.gitVersion === "string"
            ? version.gitVersion.slice(0, 100)
            : "unknown",
      };
    }
    if (op === "kubernetes_resources_list") {
      const resource = a.resource as Resource;
      const data = await kubernetesRequest(
        connection,
        resourcePath(
          resource,
          resources[resource].namespaced
            ? (a.namespace ?? cluster.namespace)
            : undefined,
          a.cursor,
        ),
        cidrs(),
        false,
        { signal, route: routing.network },
      );
      if (!Array.isArray(data?.items) || data.items.length > 100)
        throw new KubernetesError("Invalid Kubernetes resource page.");
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
    const query = new URLSearchParams({
      container: a.container,
      tailLines: String(a.lines),
      previous: String(a.previous),
      timestamps: "true",
      limitBytes: String(256 * 1024),
    });
    return kubernetesRequest(
      connection,
      `/api/v1/namespaces/${a.namespace}/pods/${a.pod}/log?${query}`,
      cidrs(),
      true,
      { signal, route: routing.network },
    );
  });
}

export async function recoverKubernetesExecutions() {
  return db.kubernetesExecution.updateMany({
    where: { status: "running" },
    data: { status: "interrupted" },
  });
}
export async function expireKubernetesResults() {
  await db.kubernetesExecution.updateMany({
    where: { expiresAt: { lt: new Date() }, encryptedResult: { not: null } },
    data: { encryptedResult: null },
  });
  const before = new Date(Date.now() - config.AUDIT_RETENTION_DAYS * 86400000);
  await db.kubernetesExecution.deleteMany({
    where: { createdAt: { lt: before }, status: { not: "running" } },
  });
  await db.kubernetesApproval.deleteMany({
    where: { createdAt: { lt: before } },
  });
}

export async function kubernetesApprovals(p: Principal) {
  // Machine workspace-management tokens must never retrieve inline manifests or
  // pod command arguments belonging to other principals.
  if (p.kind !== "user" || !["owner", "administrator"].includes(p.role))
    return [];
  const rows = await db.kubernetesApproval.findMany({
    where: { organizationId: p.organizationId },
    include: { cluster: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(
    ({
      encryptedArguments,
      tokenId: _token,
      configDigest: _config,
      argumentDigest: _digest,
      ...row
    }) => ({
      ...row,
      args: unseal(
        encryptedArguments,
        config.ENCRYPTION_KEY,
        approvalAAD(p.organizationId, row.id),
      ),
    }),
  );
}
