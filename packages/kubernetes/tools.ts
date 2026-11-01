import { z } from "zod";
import { namespaceName, resourceName } from "./names.js";
import { resourceKinds } from "./resources.js";

const cluster = { clusterId: z.uuid() };
export const kubernetesSchemas: Record<string, z.ZodObject<any>> = {
  kubernetes_clusters_list: z.object({}).strict(),
  kubernetes_cluster_check: z.object(cluster).strict(),
  kubernetes_resources_list: z
    .object({
      ...cluster,
      resource: z.enum(resourceKinds),
      namespace: z.union([namespaceName, z.literal("*")]).optional(),
      cursor: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  kubernetes_pod_logs: z
    .object({
      ...cluster,
      namespace: namespaceName,
      pod: resourceName,
      container: resourceName,
      lines: z.number().int().min(1).max(1000).default(200),
      previous: z.boolean().default(false),
    })
    .strict(),
  kubernetes_execute: z
    .object({
      ...cluster,
      command: z.array(z.string().min(1).max(8192)).min(1).max(64),
      namespace: namespaceName.optional(),
      manifest: z
        .string()
        .max(256 * 1024)
        .optional(),
      timeoutMs: z.number().int().min(1000).max(60000).default(30000),
      approvalId: z.uuid().optional(),
    })
    .strict(),
  kubernetes_pod_exec: z
    .object({
      ...cluster,
      namespace: namespaceName,
      pod: resourceName,
      container: resourceName,
      command: z.array(z.string().min(1).max(8192)).min(1).max(64),
      timeoutMs: z.number().int().min(1000).max(60000).default(30000),
      approvalId: z.uuid().optional(),
    })
    .strict(),
  kubernetes_execution_status: z.object({ executionId: z.uuid() }).strict(),
};

export const kubernetesToolDescriptions: Record<string, string> = {
  kubernetes_clusters_list:
    "List accessible saved Kubernetes clusters: all workspace clusters for Administrator, explicitly granted clusters for Custom. Never returns kubeconfig credentials.",
  kubernetes_cluster_check:
    "Check a granted saved cluster's HTTPS API and Kubernetes version.",
  kubernetes_resources_list:
    "List a page of resources on a granted cluster. Use nextCursor as cursor for following pages; namespace '*' selects all namespaces.",
  kubernetes_pod_logs:
    "Read bounded container logs from a granted cluster, up to 1000 lines and 256 KB.",
  kubernetes_execute:
    "Run an approved kubectl-style command using argv, e.g. ['get','pods','-n','apps'] or ['scale','deployment/api','--replicas=3']. Supports get, describe, logs, scale, rollout restart, delete, patch, and apply -f - with an inline manifest. Uses the saved cluster connection. No local shell, credential overrides, plugins, files, or URLs. Always requires exact single-use human approval, even for reads.",
  kubernetes_pod_exec:
    "Run an approved command argv inside one named pod/container, e.g. ['sh','-lc','id']. Returns bounded stdout, stderr, and exit code. No interactive TTY. Always requires exact single-use human approval. Timeout/cancellation may leave remote processes running; never retry automatically.",
  kubernetes_execution_status:
    "Inspect your Kubernetes command execution and its bounded result. Output expires after one hour; commands are never replayed.",
};
