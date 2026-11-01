import type { Duplex } from "node:stream";
import {
  connect,
  resolveAllowed,
  type Connection,
  type Limits,
} from "../ssh-core/index.js";
import { prepareVpn, type VpnRoute } from "../ssh-core/vpn.js";

export type KubernetesNetwork = {
  vpn?: VpnRoute;
  bastion?: Connection;
  sshLimits: Limits;
};

// A cancelled dial can finish later. Always close its late socket/client instead
// of allowing a cancelled request to leak a tunnel or authenticate further.
function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      reject(new Error("Kubernetes route interrupted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        if (done) {
          late?.(value);
          return;
        }
        done = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function openKubernetesNetwork(
  host: string,
  port: number,
  cidrs: string[],
  signal: AbortSignal,
  route?: KubernetesNetwork,
) {
  let socket: Duplex | undefined,
    bastion: Awaited<ReturnType<typeof connect>> | undefined;
  const close = () => {
    socket?.destroy();
    bastion?.end();
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", close, { once: true });
  const cleanup = () => {
    signal.removeEventListener("abort", close);
    close();
  };
  try {
    if (route?.bastion?.bastion)
      throw new Error("Only one bastion hop is supported");
    const vpn = route?.vpn || route?.bastion?.vpn;
    if (
      route?.vpn &&
      route.bastion?.vpn &&
      route.vpn.id !== route.bastion.vpn.id
    )
      throw new Error("Conflicting VPN profiles");
    const tunnel = vpn
      ? await bounded(prepareVpn(vpn, route?.sshLimits.vpnGateway), signal)
      : undefined;
    const address = await bounded(
      resolveAllowed(
        host,
        cidrs,
        vpn?.config.dns.length ? tunnel?.resolve : undefined,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (route?.bastion) {
      bastion = await bounded(
        connect({ ...route.bastion, vpn }, route.sshLimits),
        signal,
        (client) => client.end(),
      );
      socket = await bounded(
        new Promise<Duplex>((resolve, reject) =>
          bastion!.forwardOut(
            "127.0.0.1",
            0,
            address,
            port,
            (error, channel) => (error ? reject(error) : resolve(channel)),
          ),
        ),
        signal,
        (channel) => channel.destroy(),
      );
    } else if (tunnel)
      socket = await bounded(tunnel.dial(address, port), signal, (channel) =>
        channel.destroy(),
      );
    signal.throwIfAborted();
    return { address, socket, close: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
