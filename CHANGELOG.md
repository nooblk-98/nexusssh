# Changelog

## Unreleased

### Fixed

- Kubernetes routes can resolve private API hostnames through the saved SSH
  bastion when host/VPN DNS cannot provide an allowed address. All resolved
  destinations remain allowlisted and TLS identity is preserved.
- Kubernetes connection errors now identify DNS, allowlist, WireGuard gateway,
  and bastion failures. Namespace discovery no longer labels connection errors
  as missing identity permissions.
- Rancher kubeconfigs with colon-separated bearer tokens now import correctly.
  Invalid context previews show the specific reason in the main error message;
  credential values remain hidden and header control characters are rejected.

### Changed

- MCP agents now use only Administrator and Custom roles. Administrator enables
  all current/future workspace servers, clusters, tools and management access
  automatically; Custom provides selectable grants and workspace management.
- Existing Viewer and Operator agents migrate to Custom with their effective
  access preserved. Existing Administrator agents receive full workspace access.
  Tokens, expiry, call limits and grants are retained; human command approvals
  and credential export restrictions continue to apply. New API role values are
  `administrator` and `custom`.

- Server names use compact single-line rows again. Drag the sidebar's right
  edge to reveal longer names; its width is remembered between visits.
  Double-click the divider to reset it, or resize it with the keyboard.

### Added

- Optional saved WireGuard and SSH bastion routes for Kubernetes profiles,
  including WireGuard → bastion → API connections and tunneled pod WebSockets.
  Destination allowlists, bastion host-key checks, TLS identity and route-bound
  command approvals apply throughout.
- MCP `kubernetes_cluster_create` for encrypted credential submission by
  workspace-management agents. SSH identity and cluster imports return metadata
  only; saved credentials cannot be retrieved through MCP.
- Kubernetes administration with direct HTTPS API connections from uploaded
  kubeconfigs. Cluster credentials are encrypted; administrators can select
  contexts, check connections, browse paginated namespaces, nodes, pods,
  deployments, StatefulSets, DaemonSets, and services, and read container logs.
- Dedicated `KUBERNETES_ALLOWED_CIDRS` network policy, verified TLS, tenant
  isolation, credential rotation, audit events, bounded responses, and request
  limits for direct cluster access.

- Direct Kubernetes MCP tools for granted cluster discovery, resource pages,
  version checks, container logs, approved kubectl-style commands, and
  non-interactive pod/container execution with stdout, stderr, and exit codes.
- Separate per-agent cluster/tool grants, exact token-bound single-use approvals,
  encrypted expiring command results, shared call budgets and audit activity.

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
