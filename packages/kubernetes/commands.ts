import { parseDocument } from "yaml";
import { namespaceName, resourceName } from "./names.js";
import { resources } from "./resources.js";

const catalog: Record<
  string,
  { prefix: string; namespaced: boolean; kind: string }
> = {
  ...Object.fromEntries(
    Object.entries(resources).map(([key, value]) => [
      key,
      {
        ...value,
        kind: (
          {
            pods: "Pod",
            deployments: "Deployment",
            statefulsets: "StatefulSet",
            daemonsets: "DaemonSet",
            services: "Service",
            nodes: "Node",
            namespaces: "Namespace",
          } as Record<string, string>
        )[key],
      },
    ]),
  ),
  configmaps: { prefix: "/api/v1", namespaced: true, kind: "ConfigMap" },
  secrets: { prefix: "/api/v1", namespaced: true, kind: "Secret" },
  persistentvolumeclaims: {
    prefix: "/api/v1",
    namespaced: true,
    kind: "PersistentVolumeClaim",
  },
  jobs: { prefix: "/apis/batch/v1", namespaced: true, kind: "Job" },
  cronjobs: { prefix: "/apis/batch/v1", namespaced: true, kind: "CronJob" },
  ingresses: {
    prefix: "/apis/networking.k8s.io/v1",
    namespaced: true,
    kind: "Ingress",
  },
};
const aliases: Record<string, string> = {
  po: "pods",
  pod: "pods",
  deploy: "deployments",
  deployment: "deployments",
  sts: "statefulsets",
  statefulset: "statefulsets",
  ds: "daemonsets",
  daemonset: "daemonsets",
  svc: "services",
  service: "services",
  no: "nodes",
  node: "nodes",
  ns: "namespaces",
  namespace: "namespaces",
  cm: "configmaps",
  configmap: "configmaps",
  secret: "secrets",
  pvc: "persistentvolumeclaims",
  persistentvolumeclaim: "persistentvolumeclaims",
  job: "jobs",
  cj: "cronjobs",
  cronjob: "cronjobs",
  ing: "ingresses",
  ingress: "ingresses",
};
export type CommandPlan = {
  path: string;
  method: "GET" | "PATCH" | "DELETE";
  body?: string;
  contentType?: string;
  text?: boolean;
};
const invalid = (
  message = "Unsupported kubectl command or flags. See the Kubernetes MCP command reference.",
): never => {
  throw new Error(message);
};

// This deliberately parses a bounded kubectl vocabulary, never a shell command,
// a local file, a plugin, a credential override, or an arbitrary API URL.
export function planCommand(
  input: { command: string[]; namespace?: string; manifest?: string },
  defaultNamespace: string,
): CommandPlan {
  const argv = [...input.command];
  if (argv[0] === "kubectl") argv.shift();
  const verb = argv.shift();
  const allowed: Record<string, string[]> = {
    get: [
      "namespace",
      "all-namespaces",
      "output",
      "selector",
      "field-selector",
      "continue",
    ],
    describe: ["namespace"],
    logs: ["namespace", "container", "tail", "previous", "timestamps"],
    scale: ["namespace", "replicas"],
    rollout: ["namespace"],
    delete: ["namespace"],
    patch: ["namespace", "patch", "type"],
    apply: ["namespace", "filename"],
  };
  if (!verb || !allowed[verb]) return invalid();
  const flags: Record<string, string> = {},
    positional: string[] = [];
  const short: Record<string, string> = {
    n: "namespace",
    A: "all-namespaces",
    o: "output",
    l: "selector",
    c: "container",
    p: "patch",
    f: "filename",
  };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("-")) {
      positional.push(item);
      continue;
    }
    const [raw, ...rest] = item.replace(/^--?/, "").split("=");
    const key = short[raw] || raw;
    if (!allowed[verb].includes(key) || key in flags) return invalid();
    const boolean = ["all-namespaces", "previous", "timestamps"].includes(key);
    const value = rest.length ? rest.join("=") : boolean ? "true" : argv[++i];
    if (value === undefined || (boolean && !["true", "false"].includes(value)))
      return invalid();
    flags[key] = value;
  }
  if (input.namespace && flags.namespace && input.namespace !== flags.namespace)
    return invalid("Conflicting namespace selections.");
  const namespace = namespaceName.parse(
    flags.namespace || input.namespace || defaultNamespace,
  );
  if (verb !== "apply" && input.manifest !== undefined)
    return invalid("Inline manifests are only supported by apply -f -.");
  if (verb === "apply") {
    if (flags.filename !== "-" || positional.length || !input.manifest)
      return invalid("Use apply -f - and supply one inline manifest.");
    const document = parseDocument(input.manifest, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      return invalid("Invalid inline manifest.");
    const obj = document.toJS({ maxAliasCount: 0 });
    const entry = Object.entries(catalog).find(
      ([, value]) =>
        value.kind === obj?.kind &&
        value.prefix.replace(/^\/apis?\//, "") === obj?.apiVersion,
    );
    if (!entry || typeof obj?.metadata?.name !== "string")
      return invalid(
        "Supply one supported resource with apiVersion, kind, and metadata.name.",
      );
    const [resource, meta] = entry,
      name = resourceName.parse(obj.metadata.name);
    const scope = meta.namespaced
      ? namespaceName.parse(obj.metadata.namespace || namespace)
      : undefined;
    if ((flags.namespace || input.namespace) && scope && scope !== namespace)
      return invalid("Manifest namespace differs from the selected namespace.");
    return {
      path: `${meta.prefix}${scope ? `/namespaces/${scope}` : ""}/${resource}/${name}?fieldManager=nexusssh`,
      method: "PATCH",
      body: JSON.stringify(obj),
      contentType: "application/apply-patch+yaml",
    };
  }
  if (verb === "rollout" && positional.shift() !== "restart") return invalid();
  if (!positional.length || positional.length > 2) return invalid();
  if (
    verb === "logs" &&
    !positional[0].includes("/") &&
    !["pods", "pod", "po"].includes(positional[0])
  )
    positional[0] = "pods/" + positional[0];
  const target = positional[0].split("/");
  if (target.length > 2 || (target.length === 2 && positional[1]))
    return invalid();
  const resource = aliases[target[0]] || target[0],
    meta = catalog[resource];
  if (!meta) return invalid("Unsupported Kubernetes resource type.");
  const name = target[1] || positional[1];
  if (name) resourceName.parse(name);
  const scope =
    meta.namespaced && flags["all-namespaces"] !== "true"
      ? `/namespaces/${namespace}`
      : "";
  const path = `${meta.prefix}${scope}/${resource}${name ? `/${name}` : ""}`;
  if (verb === "get" || verb === "describe") {
    if (flags.output && !["json", "yaml"].includes(flags.output))
      return invalid(
        "Only JSON or YAML output is supported; results are returned as JSON.",
      );
    const query = new URLSearchParams();
    if (!name) query.set("limit", "100");
    if (flags.selector) query.set("labelSelector", flags.selector);
    if (flags["field-selector"])
      query.set("fieldSelector", flags["field-selector"]);
    if (flags.continue) query.set("continue", flags.continue);
    return { path: path + (query.size ? `?${query}` : ""), method: "GET" };
  }
  if (!name) return invalid("This command requires one named resource.");
  if (verb === "logs") {
    // kubectl logs POD also accepts the pod name without a resource prefix.
    if (resource !== "pods" || !flags.container)
      return invalid("Use logs pod/NAME --container NAME.");
    resourceName.parse(flags.container);
    const lines = Number(flags.tail || 200);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000)
      return invalid("Log tail must be between 1 and 1000.");
    const query = new URLSearchParams({
      container: flags.container,
      tailLines: String(lines),
      previous: flags.previous || "false",
      timestamps: flags.timestamps || "true",
      limitBytes: String(256 * 1024),
    });
    return { path: `${path}/log?${query}`, method: "GET", text: true };
  }
  if (verb === "delete")
    return {
      path,
      method: "DELETE",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Background",
      }),
      contentType: "application/json",
    };
  if (verb === "scale") {
    if (
      !["deployments", "statefulsets"].includes(resource) ||
      !/^\d+$/.test(flags.replicas || "") ||
      Number(flags.replicas) > 10000
    )
      return invalid(
        "Scale supports deployments/statefulsets with --replicas between 0 and 10000.",
      );
    return {
      path: `${path}/scale`,
      method: "PATCH",
      body: JSON.stringify({ spec: { replicas: Number(flags.replicas) } }),
      contentType: "application/merge-patch+json",
    };
  }
  if (verb === "rollout") {
    if (!["deployments", "statefulsets", "daemonsets"].includes(resource))
      return invalid();
    return {
      path,
      method: "PATCH",
      body: JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
              },
            },
          },
        },
      }),
      contentType: "application/strategic-merge-patch+json",
    };
  }
  if (verb === "patch") {
    const types: Record<string, string> = {
      merge: "application/merge-patch+json",
      json: "application/json-patch+json",
      strategic: "application/strategic-merge-patch+json",
    };
    const contentType = types[flags.type || "strategic"];
    if (!contentType || !flags.patch)
      return invalid(
        "Supply --patch inline JSON and --type merge, json, or strategic.",
      );
    const body = JSON.parse(flags.patch);
    if (
      !body ||
      typeof body !== "object" ||
      (flags.type === "json" ? !Array.isArray(body) : Array.isArray(body))
    )
      return invalid("Invalid patch document.");
    return { path, method: "PATCH", body: JSON.stringify(body), contentType };
  }
  return invalid();
}
