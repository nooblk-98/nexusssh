import { describe, it, expect } from "vitest";
import {
  parseWireGuard,
  wireguardSummary,
} from "../../packages/shared/wireguard.js";
const key = Buffer.alloc(32, 1).toString("base64");
const source = `[Interface]\nPrivateKey = ${key}\nAddress = 10.77.0.2/32, fd00::2/128\nDNS = 10.77.0.1\n[Peer]\nPublicKey = ${key}\nPresharedKey = ${key}\nEndpoint = vpn.example.test:51820\nAllowedIPs = 10.0.0.0/8, fd00::/64\nPersistentKeepalive = 25`;
describe("WireGuard imports", () => {
  it.each([
    ["10.77.0.2", ["10.77.0.2/32"]],
    ["fd00::2", ["fd00::2/128"]],
    [
      "10.77.0.2, fd00::2, 192.168.1.2/24, fd01::2/64",
      ["10.77.0.2/32", "fd00::2/128", "192.168.1.2/24", "fd01::2/64"],
    ],
  ])("imports addresses without a prefix: %s", (addresses, expected) => {
    const config = parseWireGuard(
      source.replace("10.77.0.2/32, fd00::2/128", addresses),
    );
    expect(config.addresses).toEqual(expected);
    expect(wireguardSummary(config).addresses).toEqual(expected);
  });
  it("imports individual AllowedIPs as host routes without broadening explicit routes", () => {
    const config = parseWireGuard(
      source.replace(
        "AllowedIPs = 10.0.0.0/8, fd00::/64",
        "AllowedIPs = 10.0.0.5, fd00::5, 192.168.0.0/16, fd01::/64",
      ),
    );
    expect(config.peers[0].allowedIPs).toEqual([
      "10.0.0.5/32",
      "fd00::5/128",
      "192.168.0.0/16",
      "fd01::/64",
    ]);
  });
  it.each(["bad-ip", "10.77.0.2/33", "fd00::2/129", "10.77.0.2/"])(
    "rejects invalid addresses and routes: %s",
    (address) => {
      expect(() =>
        parseWireGuard(source.replace("10.77.0.2/32", address)),
      ).toThrow();
      expect(() =>
        parseWireGuard(source.replace("10.0.0.0/8", address)),
      ).toThrow();
    },
  );
  it.each([0, 51820, 65535])(
    "preserves ListenPort %i for the gateway",
    (port) => {
      expect(
        parseWireGuard(source.replace("[Peer]", `ListenPort = ${port}\n[Peer]`))
          .listenPort,
      ).toBe(port);
    },
  );
  it.each(["-1", "65536", "51820.5", "auto", "1e3", "0xCA6C"])(
    "rejects invalid ListenPort %s",
    (port) => {
      expect(() =>
        parseWireGuard(
          source.replace("[Peer]", `ListenPort = ${port}\n[Peer]`),
        ),
      ).toThrow("ListenPort");
    },
  );
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
