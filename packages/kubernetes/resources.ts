export const resources = {
  pods: { prefix: "/api/v1", namespaced: true },
  deployments: { prefix: "/apis/apps/v1", namespaced: true },
  statefulsets: { prefix: "/apis/apps/v1", namespaced: true },
  daemonsets: { prefix: "/apis/apps/v1", namespaced: true },
  services: { prefix: "/api/v1", namespaced: true },
  nodes: { prefix: "/api/v1", namespaced: false },
  namespaces: { prefix: "/api/v1", namespaced: false },
} as const;
export type Resource = keyof typeof resources;
export const resourceKinds = Object.keys(resources) as [
  Resource,
  ...Resource[],
];

export function resourcePath(
  resource: Resource,
  namespace?: string,
  cursor?: string,
) {
  const { prefix, namespaced } = resources[resource];
  const scope =
    namespaced && namespace && namespace !== "*"
      ? `/namespaces/${encodeURIComponent(namespace)}`
      : "";
  const query = new URLSearchParams({ limit: "100" });
  if (cursor) query.set("continue", cursor);
  return `${prefix}${scope}/${resource}?${query}`;
}

const record = (value: any): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value: any): Record<string, any>[] =>
  Array.isArray(value) ? value.slice(0, 100).map(record) : [];
const text = (value: any, max = 512) =>
  typeof value === "string" ? value.slice(0, max) : "";
const count = (value: any, fallback = 0) =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;

export function summarizeResource(resource: Resource, input: unknown) {
  const item = record(input),
    metadata = record(item.metadata),
    spec = record(item.spec),
    status = record(item.status);
  let state = "Unknown",
    ready = "",
    detail = "";
  let containers: { name: string; image: string }[] = [];
  let restarts = 0;
  if (resource === "pods") {
    const states = [
      ...list(status.containerStatuses),
      ...list(status.initContainerStatuses),
    ];
    const waiting = states
      .map((entry) => record(record(entry.state).waiting))
      .find((entry) => entry.reason);
    state =
      text(waiting?.reason) ||
      (metadata.deletionTimestamp ? "Terminating" : text(status.phase)) ||
      "Unknown";
    containers = [...list(spec.containers), ...list(spec.initContainers)].map(
      (entry) => ({ name: text(entry.name), image: text(entry.image) }),
    );
    ready = `${list(status.containerStatuses).filter((entry) => entry.ready === true).length}/${list(spec.containers).length}`;
    restarts = states.reduce(
      (sum, entry) => sum + count(entry.restartCount),
      0,
    );
    detail = text(spec.nodeName) || "Not scheduled";
  } else if (resource === "nodes") {
    state = list(status.conditions).some(
      (entry) => entry.type === "Ready" && entry.status === "True",
    )
      ? "Ready"
      : "NotReady";
    detail = [
      text(record(status.nodeInfo).kubeletVersion),
      text(record(status.nodeInfo).osImage),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (resource === "namespaces") {
    state = text(status.phase) || "Unknown";
  } else if (resource === "services") {
    state = text(spec.type) || "ClusterIP";
    const addresses = list(record(status.loadBalancer).ingress).map(
      (entry) => text(entry.ip) || text(entry.hostname),
    );
    detail = [
      addresses.join(", ") || text(spec.clusterIP),
      list(spec.ports)
        .map((entry) => `${count(entry.port)}/${text(entry.protocol) || "TCP"}`)
        .join(", "),
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 2048);
  } else {
    const desired =
      resource === "daemonsets"
        ? count(status.desiredNumberScheduled)
        : count(spec.replicas, 1);
    const available =
      resource === "daemonsets"
        ? count(status.numberReady)
        : count(status.readyReplicas);
    ready = `${available}/${desired}`;
    state = available >= desired ? "Ready" : "Progressing";
    detail = list(record(record(spec.template).spec).containers)
      .map((entry) => text(entry.image))
      .join(", ")
      .slice(0, 2048);
  }
  return {
    uid: text(metadata.uid),
    name: text(metadata.name),
    namespace: text(metadata.namespace),
    createdAt: text(metadata.creationTimestamp),
    status: state,
    ready,
    detail,
    restarts,
    containers,
  };
}
export type ResourceSummary = ReturnType<typeof summarizeResource>;
