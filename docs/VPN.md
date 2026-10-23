# WireGuard VPN profiles and SSH bastions

Open **Menu → VPN** (or **Settings → VPN**) and choose **Add VPN Profile**. Import a WireGuard client `.conf` file or paste its contents. Give it a name and save it. Profiles are scoped to the workspace. Administrators can create, rename, replace, and delete profiles; private and preshared keys are encrypted with the same installation encryption key as SSH credentials and are never returned by the profile API.

Edit a server and open **Advanced Settings**:

- **VPN profile:** select a saved WireGuard profile, or leave it empty for a direct connection.
- **Jump host:** optionally select a saved SSH server as a bastion. With both fields selected, NexusSSH reaches the bastion through WireGuard, then forwards SSH to the destination.
- If the destination has no VPN selection, it inherits its jump host's VPN. Conflicting selections are rejected. One SSH bastion hop is supported.

Save the server. Its terminal, SFTP, diagnostics, connection tests, and MCP operations all use this route. Host-key scanning and automatic first-key acceptance also follow the selected route. Root usernames remain supported. Use **Test Connection** on the server to verify the full path; saving a VPN profile alone does not establish a verified connection to a peer.

WireGuard `AllowedIPs` must cover the next TCP hop (the server or bastion). The existing SSH destination allowlist still applies to the bastion and destination. Administrators can add private networks under **Settings → Security**. Profile `DNS` addresses are used inside the VPN for hostname resolution; without DNS entries, the application's normal resolver is used. There is no direct-network fallback when a selected VPN fails.

## Supported client configuration

The importer accepts one `[Interface]` section with `PrivateKey`, `Address` (one or more CIDRs), optional `DNS` (IP addresses), optional `MTU` (1280–1500, default 1420), and optional `ListenPort` (0–65535). `ListenPort` sets the gateway's local UDP port; omit it or use 0 for an automatically assigned port. Concurrent profiles with fixed ports need distinct available ports. It does not publish a port through Docker or the host firewall. Each `[Peer]` accepts `PublicKey`, optional `PresharedKey`, `Endpoint`, `AllowedIPs`, and optional `PersistentKeepalive` (default 25 seconds). Multiple peers and IPv4/IPv6 addresses are supported. Unsupported directives, including scripts and system routing overrides, are rejected with an explanation; they are never executed. DNS search suffixes are not supported.

When editing, leave the configuration field blank to keep the stored keys. To rotate keys or endpoints, paste a replacement. Close sessions using the old profile before opening sessions with its replacement. A profile cannot be deleted while any server references it, including archived servers. Use distinct WireGuard client identities for separate profiles.

## Runtime

The production Docker image includes a userspace WireGuard gateway built with [wireguard-go's netstack](https://git.zx2c4.com/wireguard-go/tree/tun/netstack). It runs as the same non-root user and listens only on the container's loopback interface. No host VPN installation, network-administration capabilities, TUN device, or host-route changes are needed. The gateway has no database or persistent key files; configuration is sent over an authenticated internal connection when needed.

Each profile has its own userspace network stack, so unrelated profiles can use overlapping private address ranges. Concurrent SSH connections using the same profile share one WireGuard device. Idle devices expire after five minutes; capacity is 64 active or recently used profile versions. SSH sessions and application limits govern connection lifetimes.

For native development, `npm run dev` starts the gateway using `docker-compose.vpn-dev.yml` on `127.0.0.1:3003`. It uses `INTERNAL_SECRET` from `.env`. `npm run dev:vpn` starts it separately. If needed, `VPN_GATEWAY_URL` points the API/worker at another trusted internal gateway. Do not expose the gateway as a public proxy. The all-in-one production container starts it automatically.

The `VpnProfile` migration adds a new table and optional server relation; existing connections remain direct unless a profile is selected. Back up the SQLite database and installation encryption secrets together as before.

## Verification

`go test -race ./...` in `services/vpn-gateway` creates two real userspace WireGuard peers, passes concurrent TCP streams over their encrypted link, and checks gateway authorization and route rejection. The TypeScript integration suite checks encrypted storage, workspace isolation, profile references, edits and failed-VPN behavior. The browser test imports a `.conf`, selects it on a server form, edits metadata without revealing keys, and deletes the unused profile.

An actual deployment still needs its own valid WireGuard client configuration and a reachable peer. No VPN configuration is bundled or committed.
