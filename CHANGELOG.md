# Changelog

## Unreleased

### MCP

- Add the `nexusssh-mcp` installer. `npx -y nexusssh-mcp@latest --url <endpoint>` prompts for an agent token, verifies it, and adds NexusSSH to Claude Code, Claude Desktop, Cursor, VS Code, Cline, Windsurf, Gemini CLI, Codex and opencode, backing up each file it changes. `uninstall` removes the entries again. Claude Desktop connects through the package's stdio bridge.
- **Settings → MCP Server** and the one-time token banner on **Settings → AI Agents** now show the install command for this deployment. The manual JSON configuration moved under **Configure a client manually**.
- Publishing a GitHub release also publishes the installer to npm at the release version.

### Deployment

- `docker-compose.yml` now sets only `APP_URL` and `REDIS_URL`. `SSH_ALLOWED_CIDRS` now defaults in the application to the private ranges compose used to supply (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`), so this compose file needs an image from this release or later. Every other setting already had the same default in the application, and the unused `ENCRYPTION_KEY_PROVIDER` and `LOG_LEVEL` entries are gone. The README lists the optional settings and how to set them in `docker-compose.override.yml`. If you set OIDC, backup, file history or other optional variables through your shell or `.env`, move them into that override file before you upgrade.

## [0.3.1](https://github.com/nooblk-98/nexusssh/compare/v0.3.0...v0.3.1) - 2026-11-02

NexusSSH now ships as a prebuilt multi-platform image, so a deployment is one command. Application behavior and the database schema are unchanged from v0.3.0; no migration runs.

### Deployment

- Publish multi-platform (`linux/amd64`, `linux/arm64`) images to GitHub Container Registry. Publishing a GitHub release pushes its tag (`v0.3.1`), version (`0.3.1`, `0.3`) and `latest`; pushes to `development` publish `development` after checks pass. Every build also gets an immutable `sha-<commit>` tag.
- `docker-compose.yml` now runs `ghcr.io/nooblk-98/nexusssh:latest` instead of building from source, so `docker compose up -d` is the whole deployment. Override the image with `NEXUSSSH_IMAGE`.
- The optional backup and native-development VPN overrides moved to `infrastructure/compose/backup.yml` and `infrastructure/compose/vpn-dev.yml`. Update any deployment that referenced `docker-compose.backup.yml`.
- Building from source moved to `docker-compose.dev.yml`. If you deploy a Git stack that relied on `docker compose up -d --build`, set `NEXUSSSH_IMAGE` to the tag you want and pull images on redeploy.

### Documentation

- Rewrite the README with a one-command deploy, an image tag table, an architecture diagram, and a screenshot gallery of the platform.

### Upgrade

1. Back up the `nexusssh_data` and `nexusssh_secrets` volumes.
2. Replace your `docker-compose.yml` with the v0.3.1 file, keeping your environment overrides.
3. Run `docker compose pull && docker compose up -d`. Your existing volumes are reused.

## [0.3.0](https://github.com/nooblk-98/nexusssh/compare/v0.2.0...v0.3.0) - 2026-11-02

NexusSSH is a centralized, self-hosted web workspace for SSH, SFTP, Kubernetes, and AI access through MCP. Saved infrastructure credentials remain encrypted on your deployment; compatible AI clients use scoped MCP tokens instead of receiving SSH keys, passwords, or kubeconfigs.

### Highlights

- Manage Kubernetes clusters alongside SSH servers in the same nested folder tree.
- Use browser cluster consoles and scoped MCP tools for resources, logs, approved commands, and pod execution.
- Protect remote edits with unsaved-work prompts, change previews, conflict checks, and optional encrypted file history.
- Add account workspace presets, versioned runbooks, generic OIDC sign-in, and scheduled encrypted backups.
- Diagnose complete connection routes and monitor application readiness with traceable request references.

### Breaking changes and access review

- MCP agent roles are now `administrator` and `custom`. Existing Viewer and Operator agents migrate to Custom while retaining their effective grants, tokens, expiry, and call limits.
- Administrator agents receive all current and future workspace servers, clusters, tools, and workspace-management access. Review existing Administrator agents before upgrading; use Custom when selected grants are required.
- Exact human command approvals, live access checks, token revocation, and saved-credential export restrictions continue to apply. Custom agents need explicit Kubernetes/tool grants.

### Added

- Direct Kubernetes HTTPS connections from encrypted kubeconfigs, including embedded bearer tokens or client certificates, context selection, namespace navigation, paginated resource browsing, and bounded pod logs.
- Kubernetes command consoles in workspace tabs, with command history, cancellation, table/JSON/YAML output, namespace switching, and inline `apply -f -` manifests. Supported MCP commands use the same runner.
- Scoped Kubernetes MCP tools for cluster discovery, connection checks, resources, logs, approved command execution, and non-interactive pod/container execution. Command results are encrypted and expire.
- Saved WireGuard and SSH bastion routes for clusters, including combined VPN → bastion → Kubernetes API connections and tunneled pod WebSockets. Destination allowlists, bastion host-key checks, and TLS verification remain enforced.
- Shared nested folders for SSH servers and clusters, cluster drag-and-drop and Move actions, and metadata-only cluster creation for permitted workspace-management agents.
- Optional generic OIDC browser sign-in with authorization-code flow, PKCE, nonce/state validation, explicit mappings to existing users, and existing local MFA enforcement. Removed mappings invalidate associated browser sessions.
- Account workspace presets for tab layouts, target references, SFTP paths, and Kubernetes namespaces. Presets exclude saved credentials, terminal contents, and resume tokens.
- Encrypted, immutable runbook versions with parameter previews and the existing exact-target, single-use approval workflow for multi-server commands.
- Editor Save/Discard/Cancel protection, browser reload warnings, change previews, version-checked saves, and optional encrypted previous-file contents for reviewed rollback.
- Staged connection diagnostics covering configuration, VPN gateway setup, DNS/policy, bastion authentication, and target SSH authentication without running a command.
- Field-specific WireGuard import validation and a Validate configuration action before saving profiles.
- `/api/ready` dependency checks for SQLite, Redis, the SSH worker heartbeat, and the userspace VPN gateway, plus an administrator Operations page.
- Scheduled encrypted backups with consistent SQLite/WAL snapshots, local retention, optional HTTPS upload, temporary restore rehearsal, administrator failure notifications, and an optional event webhook.
- Request references across API errors, audit records, queued SSH execution, worker callbacks, and structured metadata logs.
- `npm run bootstrap` and `npm run doctor`, updated operations documentation, a redesigned README, and editable repository banner/social-card assets.

### Changed

- Development deployment now waits for successful verification, runs serially, and skips superseded commits. The webhook receives the verified branch and SHA; configure its receiver to deploy that revision.
- Compose health checks use dependency readiness while process startup sequencing uses liveness.
- Compact SSH/Kubernetes rows, Kubernetes branding, and a resizable sidebar improve workspace navigation. Cluster consoles use a compact `kubectl >` prompt; switch namespaces with `kubectl config set-context --current --namespace=NAME` or `-n`.

### Fixed

- Successful SSH terminal, SFTP, and MCP connections refresh host status. Older queued probes cannot overwrite newer connection evidence; route/policy/configuration failures appear as unavailable checks rather than falsely offline hosts.
- Kubernetes private API hostnames can resolve through a saved bastion when host/VPN DNS cannot supply an allowed address. Routing errors identify DNS, allowlist, gateway, and bastion failures without misreporting namespace permissions.
- Rancher kubeconfigs with colon-separated bearer tokens import unchanged; invalid context previews report useful reasons without exposing credentials.
- WireGuard profiles accept bare IPv4/IPv6 addresses in `Address` and `AllowedIPs`, normalizing them to host prefixes while preserving explicit CIDRs.
- Concurrent editor saves using the same loaded version cannot silently overwrite each other through the editor API. Remote changes prompt a comparison before an acknowledged save.

### Security

- Updated the API dependency path and applied compatible body-parser/Multer fixes, removing the three high-severity advisories reported for v0.2.0.
- The dependency audit on 2026-11-02 still reports 12 moderate advisories and no high or critical advisories. Review these findings as part of deployment maintenance.
- SSH credentials, kubeconfigs, runbook definitions, optional file history, and backup archives retain encryption and access boundaries. MCP clients receive permitted tool output, which can itself contain sensitive data.

### Upgrade notes

1. Back up the SQLite data volume and installation-secrets volume together, and retain the previous application image. Preserve the installation encryption key.
2. Review the Administrator-to-all-resources behavior above and convert agents to Custom where explicit grants are appropriate.
3. Deploy the v0.3.0 source and rebuild with `docker compose up -d --build`. Startup applies the bundled SQLite migrations. Keep one application replica; rollback may require the matching pre-upgrade database and image.
4. Configure `KUBERNETES_ALLOWED_CIDRS` for cluster destinations and retain verified SSH bastion fingerprints and Kubernetes TLS trust. Kubeconfig `exec` plugins and external credential files are intentionally unsupported.
5. OIDC, managed backups, and encrypted file history are opt-in. Configure the provider and HTTPS `APP_URL`, a backup destination with a separate `BACKUP_ENCRYPTION_KEY`, or `SFTP_FILE_HISTORY=true` as needed. See [operations](docs/OPERATIONS.md) and [.env.example](.env.example).
6. Update the development deployment webhook receiver to honor the supplied verified SHA. Main-branch pushes and release tags run verification without calling the development deployment webhook.

### Validation and practical limits

The release is verified through the repository's CI workflow: production Docker build, Go VPN tests with the race detector, lint, TypeScript checks, production build, SQLite migrations/recovery tests, SSH/Redis-backed integration tests, and Playwright browser workflows.

Real OIDC providers, off-host backup destinations, deployment webhook receivers, and customer VPN peers need environment-specific verification. Managed backups currently support databases up to 256 MiB. Portable SFTP cannot eliminate races with external writers between a version check and remote rename. See [verification](docs/STATUS.md), [operations](docs/OPERATIONS.md), and [security](docs/SECURITY.md) for details.

### Contributors

- [Lahiru S Liyanage (@nooblk-98)](https://github.com/nooblk-98).

## [0.2.0](https://github.com/nooblk-98/nexusssh/compare/v0.1.0...v0.2.0) - 2026-11-01

### Breaking changes

- The `servers_list` and `workspace_servers_list` MCP tools now return a page
  containing `servers` and `nextCursor`. Clients must follow the cursor to read
  the complete list. Filtered REST server-list requests use the same shape;
  `GET /api/servers` without query parameters keeps the existing array response.
- Active servers cannot share the same normalized host, port, and folder in a
  workspace. Duplicating a server requires a different host, port, or folder.
  Archived records do not reserve addresses. Existing duplicate records are
  retained by the database migration.

### Added

- Server import previews with per-row results and duplicate detection, plus
  improved CSV parsing, nested folder paths, tags, and import metadata.
- Folder and tag connection defaults, explicit per-server overrides, effective
  setting sources, and bulk updates for up to 100 servers. Structured metadata
  includes vCPU, RAM, disk, operating system, and role.
- Queued reachability and host-key checks for servers and folders, periodic
  status refresh, failure categories, and explicit host-key verification.
  Reachability checks do not authenticate to servers or automatically trust keys.
- Approval-controlled `ssh_execute_many` commands across 1-10 exact servers,
  with per-server results and dedicated batch dispatch. Agent batches require
  both `ssh_execute_many` and `ssh_execute` scopes on the original token.
- SSH key-folder imports with previews, passphrase handling, key validation,
  and assignment to matching tagged servers.
- Read-only `kubernetes_get` for pods, deployments, services, namespaces, and
  nodes through the target server's `kubectl` installation and permissions.
- Incremental agent grants and revocation for individual servers.
- Tree, table, and tag views, bulk selection, and a compact server toolbar.
- An About page with version, developer, repository, documentation, releases,
  and support links. The version is read from the root package manifest.
- A deployment webhook workflow that runs only on pushes to `development` and
  reads the URL from the `DEPLOY_WEBHOOK_URL` repository secret.

### Changed

- SSH worker and health-check concurrency can be configured through
  `SSH_WORKER_CONCURRENCY` and `SSH_HEALTH_CONCURRENCY`, both defaulting to 4.
- VPN preparation is reused across concurrent requests and recovers when the
  gateway no longer has the prepared tunnel. Terminal output and batch
  execution paths have reduced overhead.
- Rollback image archives are saved after successful verification for pushes
  to `main` and tags. Artifact upload quota failures do not fail verification.
- Added explicit proprietary licensing and installation/usage documentation.

### Fixed

- Long server names wrap in the tree; hovering shows the full name and address.
- Archived servers no longer prevent reusing their address or deleting folders.
- Duplicate server records preserve connection settings and reset host-key trust
  when the address changes.
- SSH private-key validation uses the compatible `ssh2` utilities import.
- Browser checks select the Recent Connections heading explicitly and create
  independent identity and server-folder fixtures for the current data rules.

### Upgrade notes

1. Back up the SQLite data volume and the secrets volume together. Keep a copy
   of the previous application image before upgrading.
2. Update integrations that consume paginated server-list tools or duplicate
   servers, and grant the new tools only to agents that need them.
3. Deploy the `v0.2.0` source and rebuild with `docker compose up -d --build`.
   Startup applies the bundled SQLite migrations. Downgrading requires a
   compatible database backup and its matching application image.
4. For automatic development deployments, keep the webhook in the GitHub Actions
   repository secret. Pushes to `main` and release tags do not call that webhook.

### Known issues

- The dependency audit on 2026-11-01 reported 3 high and 12 moderate advisories,
  including the API's body-parser/Multer dependency paths and development
  tooling. No critical advisories were reported. Dependency upgrades are not
  included in this release.

### Contributors

- [Lahiru S Liyanage (@nooblk-98)](https://github.com/nooblk-98).

## [0.1.0](https://github.com/nooblk-98/nexusssh/releases/tag/v0.1.0) - 2026-10-23

Initial tagged release: browser SSH and SFTP, remote MCP access, nested server
folders, encrypted identities and WireGuard routing, team and agent permissions,
and a single application container alongside Redis. See the
[original release notes](https://github.com/nooblk-98/nexusssh/releases/tag/v0.1.0)
for features, breaking changes, and upgrade guidance.
