import { isIP } from "node:net";
import { z } from "zod";
import ipaddr from "ipaddr.js";
const key = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine(
    (v) => Buffer.from(v, "base64").length === 32,
    "Invalid WireGuard key",
  );
const cidr = z.string().refine((v) => {
  try {
    ipaddr.parseCIDR(v);
    return true;
  } catch {
    return false;
  }
}, "Invalid CIDR");
const ip = z.string().refine((v) => ipaddr.isValid(v), "Use an IP address");
export const wireguardSchema = z
  .object({
    privateKey: key,
    addresses: z.array(cidr).min(1).max(8),
    dns: z.array(ip).max(8).default([]),
    mtu: z.number().int().min(1280).max(1500).default(1420),
    listenPort: z.number().int().min(0).max(65535).optional(),
    peers: z
      .array(
        z
          .object({
            publicKey: key,
            presharedKey: key.optional(),
            endpoint: z
              .string()
              .regex(/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/)
              .refine((v) => {
                const p = Number(v.slice(v.lastIndexOf(":") + 1));
                return p > 0 && p < 65536;
              }, "Invalid endpoint port"),
            allowedIPs: z.array(cidr).min(1).max(100),
            persistentKeepalive: z.number().int().min(0).max(65535).default(25),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type WireGuardConfig = z.infer<typeof wireguardSchema>;
export function wireguardError(error: unknown): string {
  if (!(error instanceof z.ZodError))
    return error instanceof Error
      ? error.message
      : "Invalid WireGuard configuration";
  const fields: Record<string, string> = {
    privateKey: "PrivateKey: use a 32-byte base64 key",
    addresses: "Address: use valid IPv4/IPv6 addresses or CIDRs",
    dns: "DNS: use IP addresses without search suffixes",
    mtu: "MTU: use a whole number from 1280 to 1500",
    listenPort: "ListenPort: use a whole number from 0 to 65535",
    publicKey: "PublicKey: use a 32-byte base64 key",
    presharedKey: "PresharedKey: use a 32-byte base64 key",
    endpoint: "Endpoint: use hostname:port or [IPv6]:port",
    allowedIPs: "AllowedIPs: use valid IP addresses or CIDRs",
    persistentKeepalive:
      "PersistentKeepalive: use a whole number from 0 to 65535",
  };
  return [
    ...new Set(
      error.issues.map((issue) => {
        const field = issue.path.at(-1);
        const known = issue.path.find(
          (part) => typeof part === "string" && part in fields,
        );
        const peer =
          issue.path[0] === "peers" && typeof issue.path[1] === "number"
            ? `Peer ${issue.path[1] + 1}: `
            : "";
        return (
          peer +
          (known
            ? fields[String(known)]
            : field === "peers"
              ? "Include at least one valid [Peer] section"
              : "Check the Interface and Peer sections")
        );
      }),
    ),
  ].join("; ");
}
export function parseWireGuard(text: string): WireGuardConfig {
  if (text.length > 65536)
    throw new Error("WireGuard configuration is too large");
  let iface: Record<string, string> | undefined;
  let section: Record<string, string> | undefined;
  const peers: Record<string, string>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (line === "[Interface]") {
      if (iface) throw new Error("Use one Interface section");
      section = iface = {};
      continue;
    }
    if (line === "[Peer]") {
      section = {};
      peers.push(section);
      continue;
    }
    const match = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!section || !match)
      throw new Error("Invalid WireGuard configuration line");
    const [, name, value] = match;
    const allowed =
      section === iface
        ? ["PrivateKey", "Address", "DNS", "MTU", "ListenPort"]
        : [
            "PublicKey",
            "PresharedKey",
            "Endpoint",
            "AllowedIPs",
            "PersistentKeepalive",
          ];
    if (!allowed.includes(name))
      throw new Error(
        `Unsupported WireGuard field: ${name}. Import a client profile without scripts or routing overrides.`,
      );
    if (section[name]) throw new Error(`Duplicate WireGuard field: ${name}`);
    section[name] = value.trim();
  }
  const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()) : []);
  // WireGuard clients accept bare IPs as host prefixes; the gateway needs CIDRs.
  const cidrList = (v?: string) =>
    list(v).map((address) => {
      const family = isIP(address);
      return family ? `${address}/${family === 4 ? 32 : 128}` : address;
    });
  if (
    iface?.ListenPort !== undefined &&
    (!/^\d+$/.test(iface.ListenPort) || Number(iface.ListenPort) > 65535)
  )
    throw new Error("ListenPort must be a whole number from 0 to 65535.");
  return wireguardSchema.parse({
    privateKey: iface?.PrivateKey,
    addresses: cidrList(iface?.Address),
    dns: list(iface?.DNS),
    mtu: iface?.MTU ? Number(iface.MTU) : undefined,
    listenPort:
      iface?.ListenPort !== undefined ? Number(iface.ListenPort) : undefined,
    peers: peers.map((p) => ({
      publicKey: p.PublicKey,
      presharedKey: p.PresharedKey,
      endpoint: p.Endpoint,
      allowedIPs: cidrList(p.AllowedIPs),
      persistentKeepalive: p.PersistentKeepalive
        ? Number(p.PersistentKeepalive)
        : undefined,
    })),
  });
}
export function wireguardSummary(c: WireGuardConfig) {
  return {
    addresses: c.addresses,
    dns: c.dns,
    mtu: c.mtu,
    peers: c.peers.map((p) => ({
      endpoint: p.endpoint,
      allowedIPs: p.allowedIPs,
    })),
  };
}
