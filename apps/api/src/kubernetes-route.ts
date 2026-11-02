import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import { canonical, hash, unseal } from "../../../packages/shared/crypto.js";
import type { KubernetesNetwork } from "../../../packages/kubernetes/network.js";
import type { Connection } from "../../../packages/ssh-core/index.js";
import { resolveSettings } from "./metadata.js";

type References = { vpnProfileId?: string | null; bastionId?: string | null };

// Only saved, same-workspace routes can be used. Route credentials stay in the
// API process, separate from the kubeconfig and public profile metadata.
export async function kubernetesRoute(
  org: string,
  refs: References,
  store: Prisma.TransactionClient = db,
) {
  let bastion: Connection | undefined;
  let inheritedVpn: string | null | undefined;
  const material: unknown[] = [
    refs.vpnProfileId || null,
    refs.bastionId || null,
  ];
  if (refs.bastionId) {
    const row = await store.server.findFirst({
      where: {
        id: refs.bastionId,
        organizationId: org,
        archived: false,
        bastionId: null,
      },
    });
    if (!row)
      throw new NotFoundException(
        "Bastion unavailable. Choose an active SSH server without another bastion hop.",
      );
    const effective = await resolveSettings(row.id, org, { client: store });
    const identity = await store.sSHIdentity.findFirst({
      where: { id: effective.values.identityId, organizationId: org },
    });
    if (!identity)
      throw new NotFoundException("Bastion SSH identity unavailable.");
    inheritedVpn = effective.values.vpnProfileId;
    if (refs.vpnProfileId && inheritedVpn && refs.vpnProfileId !== inheritedVpn)
      throw new BadRequestException(
        "Conflicting VPN profiles on cluster and bastion.",
      );
    bastion = {
      host: row.host,
      port: row.port,
      username: effective.values.username,
      fingerprint: row.fingerprint,
      fileRoot: row.fileRoot,
      credential: unseal(
        identity.encryptedSecret,
        config.ENCRYPTION_KEY,
        `${org}:${identity.id}`,
      ),
    };
    material.push(
      row.host,
      row.port,
      row.fingerprint,
      effective.values.username,
      identity.id,
      identity.encryptedSecret,
    );
  }
  let vpn: Connection["vpn"];
  const vpnId = refs.vpnProfileId || inheritedVpn;
  if (vpnId) {
    const profile = await store.vpnProfile.findFirst({
      where: { id: vpnId, organizationId: org },
    });
    if (!profile) throw new NotFoundException("VPN profile unavailable.");
    vpn = {
      id: profile.id,
      config: unseal(
        profile.encryptedConfig,
        config.ENCRYPTION_KEY,
        `${org}:vpn:${profile.id}`,
      ),
    };
    material.push(profile.id, profile.encryptedConfig);
  }
  if (!vpn && !bastion)
    return { network: undefined, digest: hash(canonical(material)) };
  const extra = config.SSH_ALLOWLIST_LOCKED
    ? null
    : await store.systemSetting.findUnique({
        where: {
          organizationId_key: { organizationId: org, key: "ssh.allowedCidrs" },
        },
      });
  const network: KubernetesNetwork = {
    vpn,
    bastion,
    sshLimits: {
      cidrs: [
        ...config.SSH_ALLOWED_CIDRS.split(","),
        ...(extra ? (JSON.parse(extra.value) as string[]) : []),
      ],
      connectTimeout: config.SSH_CONNECT_TIMEOUT,
      outputLimit: config.SSH_OUTPUT_LIMIT,
      vpnGateway: {
        url: config.VPN_GATEWAY_URL,
        secret: config.INTERNAL_SECRET,
      },
    },
  };
  return { network, digest: hash(canonical(material)) };
}

export function kubernetesConnectionDigest(
  encryptedConfig: string,
  routeDigest: string,
) {
  return hash(canonical({ encryptedConfig, routeDigest }));
}
