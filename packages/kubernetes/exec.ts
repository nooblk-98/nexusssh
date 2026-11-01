import WebSocket from "ws";
import { kubernetesTarget, KubernetesError } from "./client.js";
import type { ClusterConnection } from "./kubeconfig.js";
import { namespaceName, resourceName } from "./names.js";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};
export async function kubernetesExec(
  connection: ClusterConnection,
  args: {
    namespace: string;
    pod: string;
    container: string;
    command: string[];
    timeoutMs: number;
  },
  cidrs: string[],
  cancellation?: AbortSignal,
): Promise<ExecResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(args.timeoutMs),
    ...(cancellation ? [cancellation] : []),
  ]);
  const namespace = namespaceName.parse(args.namespace),
    pod = resourceName.parse(args.pod),
    container = resourceName.parse(args.container);
  const query = new URLSearchParams({
    container,
    stdout: "true",
    stderr: "true",
    stdin: "false",
    tty: "false",
  });
  for (const part of args.command) query.append("command", part);
  const path = `/api/v1/namespaces/${namespace}/pods/${pod}/exec?${query}`;
  const target = await kubernetesTarget(connection, path, cidrs, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const url = new URL(connection.server + path);
    url.protocol = "wss:";
    // ws uses this URL to choose the address; pin it, retaining original Host/SNI.
    url.hostname = target.hostname.includes(":")
      ? `[${target.hostname}]`
      : target.hostname;
    const socket = new WebSocket(
      url,
      ["v5.channel.k8s.io", "v4.channel.k8s.io"],
      {
        ...target,
        followRedirects: false,
        handshakeTimeout: args.timeoutMs,
        maxPayload: 2 * 1024 * 1024,
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      truncated = false,
      settled = false;
    const finish = (error?: Error, exitCode?: number) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      socket.terminate();
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: exitCode!,
          truncated,
        });
    };
    const aborted = () =>
      finish(
        new KubernetesError(
          "Pod command interrupted. The remote process may still be running; inspect it before retrying.",
        ),
      );
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(
        new KubernetesError(
          `Pod exec upgrade denied (HTTP ${response.statusCode}). Check pods/exec RBAC and WebSocket support.`,
        ),
      );
    });
    socket.on("error", () =>
      finish(
        new KubernetesError(
          "Pod exec connection failed. Check TLS, pods/exec RBAC and Kubernetes WebSocket support.",
        ),
      ),
    );
    socket.on("close", () =>
      finish(
        new KubernetesError(
          "Pod exec closed without an exit status. The remote outcome is unknown; do not retry automatically.",
        ),
      ),
    );
    socket.on("message", (data, binary) => {
      if (!binary)
        return finish(new KubernetesError("Invalid pod exec protocol."));
      const frame = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      const channel = frame[0],
        payload = frame.subarray(1);
      if (channel === 1 || channel === 2) {
        const left = Math.max(0, 256 * 1024 - bytes);
        if (left)
          (channel === 1 ? stdout : stderr).push(payload.subarray(0, left));
        bytes += payload.length;
        truncated ||= bytes > 256 * 1024;
      } else if (channel === 3) {
        try {
          const status = JSON.parse(payload.toString("utf8"));
          if (status.status === "Success") return finish(undefined, 0);
          const code = status.details?.causes?.find(
            (cause: any) => cause.reason === "ExitCode",
          )?.message;
          if (
            status.reason === "NonZeroExitCode" &&
            /^\d+$/.test(code) &&
            Number(code) <= 255
          )
            return finish(undefined, Number(code));
          finish(
            new KubernetesError(
              "Kubernetes could not start or complete the pod command.",
            ),
          );
        } catch {
          finish(new KubernetesError("Invalid pod exec exit status."));
        }
      }
    });
  });
}
