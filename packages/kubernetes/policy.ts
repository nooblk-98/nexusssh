export const kubernetesReadOperations = [
  "kubernetes_clusters_list",
  "kubernetes_resources_list",
  "kubernetes_pod_logs",
  "kubernetes_cluster_check",
  "kubernetes_execution_status",
];
export const kubernetesWriteOperations = [
  "kubernetes_execute",
  "kubernetes_pod_exec",
];
export const kubernetesOperations = [
  ...kubernetesReadOperations,
  ...kubernetesWriteOperations,
];
