import { parseDocument } from "yaml";
import { z } from "zod";
import { createSecureContext } from "node:tls";
import { X509Certificate } from "node:crypto";
import { namespaceName } from "./names.js";
export { namespaceName, resourceName } from "./names.js";

export const MAX_KUBECONFIG_BYTES = 256 * 1024;
const entryName = z.string().min(1).max(256);
const fields = z.record(z.string(), z.unknown());
const documentSchema = z.object({
  apiVersion: z.literal("v1").optional(),
  kind: z.literal("Config").optional(),
  "current-context": entryName.optional(),
  clusters: z
    .array(z.object({ name: entryName, cluster: fields }))
    .min(1)
    .max(100),
  users: z
    .array(z.object({ name: entryName, user: fields }))
    .min(1)
    .max(100),
  contexts: z
    .array(z.object({ name: entryName, context: fields }))
    .min(1)
    .max(100),
});

export class KubeconfigError extends Error {}
export type ClusterConnection = {
  server: string;
  context: string;
  namespace: string;
  authentication: "token" | "certificate";
  token?: string;
  ca?: string;
  cert?: string;
  key?: string;
  tlsServerName?: string;
};

function document(text: string) {
  if (!text.trim() || Buffer.byteLength(text) > MAX_KUBECONFIG_BYTES)
    throw new KubeconfigError(
      "Choose a kubeconfig file no larger than 256 KB.",
    );
  try {
    const parsed = parseDocument(text, {
      schema: "core",
      uniqueKeys: true,
      customTags: [],
    });
    if (parsed.errors.length || parsed.warnings.length) throw new Error();
    const config = documentSchema.parse(parsed.toJS({ maxAliasCount: 0 }));
    for (const entries of [config.clusters, config.users, config.contexts])
      if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
        throw new Error();
    return config;
  } catch {
    // Parser errors can quote credentials from the uploaded document.
    throw new KubeconfigError(
      "Invalid kubeconfig YAML or JSON. Include uniquely named clusters, users, and contexts.",
    );
  }
}

function embedded(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new KubeconfigError(`Invalid embedded ${label}.`);
  const base64 = value.replace(/\s/g, "");
  if (
    !base64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new KubeconfigError(`Invalid embedded ${label}.`);
  return Buffer.from(base64, "base64").toString("utf8");
}

function connection(
  config: z.infer<typeof documentSchema>,
  selected?: string,
): ClusterConnection {
  const context =
    selected ||
    config["current-context"] ||
    (config.contexts.length === 1 ? config.contexts[0].name : "");
  const chosen = config.contexts.find(
    (entry) => entry.name === context,
  )?.context;
  if (!chosen)
    throw new KubeconfigError("Choose a context from the uploaded kubeconfig.");
  const cluster = config.clusters.find(
    (entry) => entry.name === chosen.cluster,
  )?.cluster;
  const user = config.users.find((entry) => entry.name === chosen.user)?.user;
  if (!cluster || !user)
    throw new KubeconfigError(
      "The context references a missing cluster or user.",
    );
  if (
    cluster["insecure-skip-tls-verify"] !== undefined &&
    cluster["insecure-skip-tls-verify"] !== false
  )
    throw new KubeconfigError(
      "TLS verification must be enabled in the kubeconfig.",
    );
  if (
    ["certificate-authority", "proxy-url"].some((key) =>
      Object.hasOwn(cluster, key),
    ) ||
    [
      "exec",
      "auth-provider",
      "tokenFile",
      "token-file",
      "client-certificate",
      "client-key",
      "username",
      "password",
      "as",
      "as-groups",
      "as-user-extra",
    ].some((key) => Object.hasOwn(user, key))
  )
    throw new KubeconfigError(
      "Use embedded tokens or certificate data. Login plugins, local files, proxies, and impersonation are not supported.",
    );
  let endpoint: URL;
  try {
    endpoint = new URL(z.string().max(2048).parse(cluster.server));
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error();
  } catch {
    throw new KubeconfigError(
      "The Kubernetes API server must be an HTTPS URL without credentials, query parameters, or a fragment.",
    );
  }
  const namespace = namespaceName.safeParse(chosen.namespace ?? "default");
  if (!namespace.success)
    throw new KubeconfigError("The context has an invalid namespace.");
  const tlsName = z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/)
    .optional()
    .safeParse(cluster["tls-server-name"]);
  if (!tlsName.success) throw new KubeconfigError("Invalid TLS server name.");
  const ca = embedded(cluster["certificate-authority-data"], "CA certificate");
  const cert = embedded(user["client-certificate-data"], "client certificate");
  const key = embedded(user["client-key-data"], "client key");
  const token = z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/)
    .optional()
    .safeParse(user.token);
  if (!token.success || (!token.data && !(cert && key)) || !!cert !== !!key)
    throw new KubeconfigError(
      "Provide a bearer token or an embedded client certificate and matching key.",
    );
  try {
    if (ca) {
      const certificates = ca.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      );
      if (
        !certificates?.length ||
        ca
          .replace(
            /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
            "",
          )
          .trim()
      )
        throw new Error();
      certificates.forEach((certificate) => new X509Certificate(certificate));
    }
    createSecureContext({ ca, cert, key, minVersion: "TLSv1.2" });
  } catch {
    throw new KubeconfigError(
      "Invalid CA certificate or client certificate/key pair.",
    );
  }
  return {
    server: endpoint.origin + endpoint.pathname.replace(/\/+$/, ""),
    context,
    namespace: namespace.data,
    authentication: token.data ? "token" : "certificate",
    token: token.data,
    ca,
    cert,
    key,
    tlsServerName: tlsName.data,
  };
}

export function parseKubeconfig(text: string, selected?: string) {
  return connection(document(text), selected);
}

export function kubeconfigContexts(text: string) {
  const config = document(text);
  return {
    currentContext:
      config["current-context"] ||
      (config.contexts.length === 1 ? config.contexts[0].name : ""),
    contexts: config.contexts.map((entry) => {
      try {
        const parsed = connection(config, entry.name);
        return {
          name: parsed.context,
          server: parsed.server,
          namespace: parsed.namespace,
          authentication: parsed.authentication,
        };
      } catch (error) {
        return {
          name: entry.name,
          error:
            error instanceof KubeconfigError
              ? error.message
              : "Unsupported context.",
        };
      }
    }),
  };
}
