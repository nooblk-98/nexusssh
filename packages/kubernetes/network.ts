import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import {
  connect,
  exec as sshExec,
  resolveAllowed,
  type Connection,
  type Limits,
} from "../ssh-core/index.js";
import { prepareVpn, VpnError, type VpnRoute } from "../ssh-core/vpn.js";

export type KubernetesNetwork = {
  vpn?: VpnRoute;
  bastion?: Connection;
  sshLimits: Limits;
};
export class KubernetesRouteError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(message);
  }
}

function vpnFailure(error: unknown, stage: string) {
  const destination =
    stage === "bastion_connect" ? "SSH bastion" : "Kubernetes API";
  if (error instanceof VpnError) {
    if (error.reason === "allowed_ips")
      return new KubernetesRouteError(
        stage,
        `The ${destination} destination is outside the selected WireGuard profile's AllowedIPs. Add only its approved IP/network to that VPN profile.`,
      );
    if (error.reason === "authentication")
      return new KubernetesRouteError(
        stage,
        "The WireGuard gateway rejected application authentication. The API and gateway must use the same INTERNAL_SECRET.",
      );
    if (error.reason === "in_use")
      return new KubernetesRouteError(
        stage,
        "The WireGuard profile changed while its old tunnel is in use. Close sessions using that profile before reconnecting.",
      );
    if (error.reason === "dns")
      return new KubernetesRouteError(
        stage,
        `${destination} DNS lookup through WireGuard failed. Check the profile's DNS servers and their reachability through the VPN.`,
      );
    if (error.reason === "unavailable")
      return new KubernetesRouteError(
        stage,
        "The WireGuard gateway is unavailable. Check VPN_GATEWAY_URL and that the gateway is running.",
      );
    if (error.reason === "setup")
      return new KubernetesRouteError(
        stage,
        "The WireGuard gateway could not initialize the selected profile. Check its configuration and gateway availability.",
      );
  }
  return new KubernetesRouteError(
    stage,
    `The WireGuard tunnel could not reach the ${destination}. Check its peer, AllowedIPs, endpoint port and VPN routing.`,
  );
}

async function bastionAddresses(
  client: Awaited<ReturnType<typeof connect>>,
  host: string,
  signal: AbortSignal,
) {
  // A fixed, bounded DNS lookup, never caller-supplied shell text. Numeric
  // destinations skip this; DNS labels cannot contain quotes/options/operators.
  if (
    host.length > 253 ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?\.?$/.test(host)
  )
    throw new KubernetesRouteError(
      "bastion_dns",
      "The Kubernetes API hostname is not valid for a bastion DNS lookup.",
    );
  try {
    const result = await sshExec(
      client,
      `getent ahosts '${host}'`,
      5000,
      16384,
      signal,
    );
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const addresses = [...new Set(lines.map((line) => line.split(/\s+/)[0]))];
    if (
      result.exitCode !== 0 ||
      result.truncated ||
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some((address) => !isIP(address))
    )
      throw new Error();
    return addresses;
  } catch {
    throw new KubernetesRouteError(
      "bastion_dns",
      "The SSH bastion could not resolve the Kubernetes API hostname. Ensure getent is available and this hostname resolves on the jump host, or configure working DNS in the selected WireGuard profile.",
    );
  }
}

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
  let stage = "route_config";
  try {
    if (route?.bastion?.bastion)
      throw new KubernetesRouteError(
        stage,
        "Only one SSH bastion hop is supported for Kubernetes connections.",
      );
    const vpn = route?.vpn || route?.bastion?.vpn;
    if (
      route?.vpn &&
      route.bastion?.vpn &&
      route.vpn.id !== route.bastion.vpn.id
    )
      throw new KubernetesRouteError(
        stage,
        "The cluster and bastion select different WireGuard profiles. Select the same VPN or inherit the bastion's VPN.",
      );
    try {
      if (!cidrs.length) throw new Error();
      for (const cidr of cidrs) ipaddr.parseCIDR(cidr);
    } catch {
      throw new KubernetesRouteError(
        "api_allowlist",
        "KUBERNETES_ALLOWED_CIDRS is empty or invalid. Configure the approved Kubernetes API destination networks.",
      );
    }
    stage = "vpn_setup";
    const tunnel = vpn
      ? await bounded(prepareVpn(vpn, route?.sshLimits.vpnGateway), signal)
      : undefined;
    const connectBastion = async () => {
      stage = "bastion_connect";
      try {
        bastion = await bounded(
          connect({ ...route!.bastion!, vpn }, route!.sshLimits),
          signal,
          (client) => client.end(),
        );
      } catch (error) {
        if (error instanceof VpnError) throw vpnFailure(error, stage);
        const message = error instanceof Error ? error.message : "";
        if (
          message ===
          "Verify and save the SSH host fingerprint before connecting"
        )
          throw new KubernetesRouteError(
            stage,
            "Verify and save the bastion's SSH host fingerprint before connecting to Kubernetes.",
          );
        if (message === "Host denied (verification failed)")
          throw new KubernetesRouteError(
            stage,
            "The bastion's SSH host key does not match its saved fingerprint. Verify the host key on the saved SSH server.",
          );
        if (message === "All configured authentication methods failed")
          throw new KubernetesRouteError(
            stage,
            "Bastion SSH authentication failed. Check the saved SSH identity and effective username.",
          );
        if (
          message.startsWith(
            "SSH destination is outside the configured allowlist",
          )
        )
          throw new KubernetesRouteError(
            stage,
            "The SSH bastion is outside the SSH destination allowlist. Check SSH_ALLOWED_CIDRS and the workspace's SSH networks.",
          );
        if (message.startsWith("Cloud metadata addresses"))
          throw new KubernetesRouteError(
            stage,
            "Cloud metadata addresses cannot be SSH bastion destinations.",
          );
        throw new KubernetesRouteError(
          stage,
          "Could not connect to the saved SSH bastion. Test that SSH server with the same VPN and verify its host key, credentials and SSH allowlist.",
        );
      }
    };
    const resolveApi = async (
      resolver?: (host: string) => Promise<string[]>,
      source = "the NexusSSH host",
    ) => {
      stage = source === "the SSH bastion" ? "bastion_dns" : "api_dns";
      let observed: string[] = [];
      try {
        return await bounded(
          resolveAllowed(host, cidrs, async (name) => {
            if (isIP(name)) observed = [name];
            else if (resolver) observed = await resolver(name);
            else
              observed = (
                await lookup(name, { all: true, verbatim: true })
              ).map((value) => value.address);
            return observed;
          }),
          signal,
        );
      } catch (error) {
        if (error instanceof KubernetesRouteError) throw error;
        const reason = error instanceof Error ? error.message : "";
        if (reason.startsWith("Cloud metadata addresses"))
          throw new KubernetesRouteError(
            "metadata",
            "Cloud metadata addresses cannot be Kubernetes API destinations.",
          );
        if (
          reason.startsWith(
            "SSH destination is outside the configured allowlist",
          ) &&
          observed.length
        ) {
          const addresses = observed
            .filter((value) => isIP(value))
            .slice(0, 8)
            .join(", ");
          throw new KubernetesRouteError(
            "api_allowlist",
            `Kubernetes API address ${addresses} resolved using ${source} is outside KUBERNETES_ALLOWED_CIDRS. Add only the approved API IP/network to the deployment's Kubernetes allowlist; SSH and Kubernetes allowlists are separate.`,
          );
        }
        if (error instanceof VpnError) throw vpnFailure(error, stage);
        throw new KubernetesRouteError(
          "api_dns",
          `Kubernetes API DNS lookup for ${host} failed using ${source}. ${vpn ? "Set DNS servers in the WireGuard profile that resolve this private hostname and are reachable over the VPN." : "Configure DNS reachable from NexusSSH, or select a bastion that can resolve this private hostname."}`,
        );
      }
    };
    let address: string;
    try {
      address = await resolveApi(
        vpn?.config.dns.length ? tunnel?.resolve : undefined,
        vpn?.config.dns.length
          ? "the WireGuard profile's DNS servers"
          : "the NexusSSH host",
      );
    } catch (error) {
      // Private/split DNS may only exist on the jump host. Resolve there rather
      // than passing an unchecked hostname to forwardOut; every result is still
      // allowlisted and only a numeric address is forwarded.
      if (
        !route?.bastion ||
        isIP(host) ||
        !(error instanceof KubernetesRouteError) ||
        !["api_dns", "api_allowlist"].includes(error.stage) ||
        signal.aborted
      )
        throw error;
      await connectBastion();
      address = await resolveApi(
        (name) => bastionAddresses(bastion!, name, signal),
        "the SSH bastion",
      );
    }
    signal.throwIfAborted();
    if (route?.bastion) {
      if (!bastion) await connectBastion();
      stage = "bastion_forward";
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
    } else if (tunnel) {
      stage = "vpn_connect";
      socket = await bounded(tunnel.dial(address, port), signal, (channel) =>
        channel.destroy(),
      );
    }
    signal.throwIfAborted();
    return { address, socket, close: cleanup };
  } catch (error) {
    cleanup();
    if (signal.aborted)
      throw new KubernetesRouteError(
        stage,
        `Kubernetes connection timed out or was cancelled during ${stage.replaceAll("_", " ")}. Check DNS and reachability for the selected route.`,
      );
    if (error instanceof KubernetesRouteError) throw error;
    if (
      error instanceof VpnError ||
      stage === "vpn_setup" ||
      stage === "vpn_connect"
    )
      throw vpnFailure(error, stage);
    if (stage === "bastion_forward")
      throw new KubernetesRouteError(
        stage,
        `The SSH bastion connected but could not forward to Kubernetes at ${host}:${port}. Check TCP forwarding permissions and that the API is reachable from the jump host.`,
      );
    throw new KubernetesRouteError(
      stage,
      "Could not open the Kubernetes network route.",
    );
  }
}
