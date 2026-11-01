import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { resolveAllowed } from "../ssh-core/index.js";
import type { ClusterConnection } from "./kubeconfig.js";

export class KubernetesError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

// Only the controller's fixed resource paths reach this client. Credentials are
// sent once to a resolved, allowlisted address; redirects are never followed.
export async function kubernetesRequest(
  connection: ClusterConnection,
  path: string,
  cidrs: string[],
  text = false,
): Promise<any> {
  const endpoint = new URL(connection.server + path);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.timeout(15000);
  let address: string;
  try {
    address = await new Promise<string>((resolve, reject) => {
      const aborted = () => reject(new Error("Resolution timed out"));
      signal.addEventListener("abort", aborted, { once: true });
      void resolveAllowed(host, cidrs)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", aborted));
    });
  } catch {
    throw new KubernetesError(
      "Kubernetes API endpoint could not be resolved or is outside KUBERNETES_ALLOWED_CIDRS.",
    );
  }
  const identity = connection.tlsServerName || host;
  return new Promise((resolve, reject) => {
    const limit = text ? 256 * 1024 : 2 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    const request = https.request(
      {
        hostname: address,
        port: endpoint.port || 443,
        path: endpoint.pathname + endpoint.search,
        method: "GET",
        agent: false,
        ca: connection.ca,
        cert: connection.cert,
        key: connection.key,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: isIP(identity) ? "" : identity,
        checkServerIdentity: (_host, certificate) =>
          checkServerIdentity(identity, certificate),
        headers: {
          Host: endpoint.host,
          Accept: text ? "text/plain" : "application/json",
          ...(connection.token
            ? { Authorization: `Bearer ${connection.token}` }
            : {}),
        },
        signal,
      },
      (response) => {
        const status = response.statusCode || 502;
        if (status < 200 || status >= 300) {
          response.destroy();
          const message =
            status === 401
              ? "Cluster authentication failed. Replace the kubeconfig credentials."
              : status === 403
                ? "The kubeconfig identity does not have permission for this Kubernetes resource."
                : status === 404
                  ? "This Kubernetes resource or API is unavailable."
                  : status === 410
                    ? "This resource page expired. Refresh to start again."
                    : status >= 300 && status < 400
                      ? "The Kubernetes API redirected the request. Import its final HTTPS endpoint."
                      : `Kubernetes API request failed (HTTP ${status}).`;
          reject(
            new KubernetesError(
              message,
              status === 401 || status < 400 ? 502 : status,
            ),
          );
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            if (text) {
              chunks.push(
                chunk.subarray(0, Math.max(0, limit - (size - chunk.length))),
              );
              resolve({
                content: Buffer.concat(chunks).toString("utf8"),
                truncated: true,
              });
              request.destroy();
              return;
            }
            request.destroy();
            reject(
              new KubernetesError(
                "Kubernetes response is too large. Choose a smaller namespace or fewer log lines.",
              ),
            );
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(
            new KubernetesError("The Kubernetes response was interrupted."),
          ),
        );
        response.on("end", () => {
          if (size > limit) return;
          const body = Buffer.concat(chunks).toString("utf8");
          if (text) return resolve({ content: body, truncated: size >= limit });
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new KubernetesError("The Kubernetes API returned invalid JSON."),
            );
          }
        });
      },
    );
    request.on("error", () =>
      reject(
        new KubernetesError(
          "Could not connect to the Kubernetes API. Check its network route, TLS certificates, and endpoint.",
        ),
      ),
    );
    request.end();
  });
}
