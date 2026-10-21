import { describe, it, expect } from "vitest";
import {
  parseWireGuard,
  wireguardSummary,
} from "../../packages/shared/wireguard.js";
const key = Buffer.alloc(32, 1).toString("base64");
const source = `[Interface]\nPrivateKey = ${key}\nAddress = 10.77.0.2/32, fd00::2/128\nDNS = 10.77.0.1\n[Peer]\nPublicKey = ${key}\nPresharedKey = ${key}\nEndpoint = vpn.example.test:51820\nAllowedIPs = 10.0.0.0/8, fd00::/64\nPersistentKeepalive = 25`;
describe("WireGuard imports", () => {
  it("parses client profiles and removes all key material from summaries", () => {
    const c = parseWireGuard(source);
    expect(c.addresses).toHaveLength(2);
    expect(c.peers[0].persistentKeepalive).toBe(25);
    expect(JSON.stringify(wireguardSummary(c))).not.toContain(key);
  });
  it("supports multiple peers and rejects scripts, duplicate fields and invalid addresses", () => {
    expect(
      parseWireGuard(
        source +
          `\n[Peer]\nPublicKey = ${key}\nEndpoint = [::1]:51821\nAllowedIPs = 192.168.0.0/16`,
      ).peers,
    ).toHaveLength(2);
    expect(() =>
      parseWireGuard(source.replace("Address =", "PostUp = evil\nAddress =")),
    ).toThrow("Unsupported");
    expect(() =>
      parseWireGuard(
        source.replace("[Peer]", "PrivateKey = " + key + "\n[Peer]"),
      ),
    ).toThrow("Duplicate");
    expect(() =>
      parseWireGuard(source.replace("10.77.0.2/32", "bad-ip")),
    ).toThrow();
    expect(() => parseWireGuard(source.replace(":51820", ":65536"))).toThrow();
  });
});
