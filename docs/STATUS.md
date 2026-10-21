# Verification and remaining work

Last verification: 21 October 2026. This file distinguishes a functioning implementation from the much larger master brief. It is not a production-readiness declaration.

## Executed checks

- TypeScript checks for API, MCP, worker, shared packages and Next.js: passed.
- ESLint: passed for application and test sources; generated Monaco distribution files are excluded.
- Native production Next.js/backend build: passed.
- Docker images for all four application services: built successfully.
- Docker Compose with the development Nginx override: all six services started; API/web/MCP/Redis health checks passed.
- Vitest: **27 tests passed** with `RUN_INTEGRATION=1` against a disposable Linux OpenSSH container and Redis.
- Playwright/Edge: **1 browser workflow passed** against both native development and the production images behind development Nginx, covering first-owner setup/login, empty dashboard, server dialog, agent/MCP/settings screens, desktop and 390px mobile layout. Desktop/mobile screenshots inspected. The test account remained usable after API/container recreation, verifying SQLite volume persistence and the incremental migration.
- npm dependency audit: **0 known vulnerabilities** at the time checked. This is not a security certification.

Integration coverage includes real password and private-key SSH, unknown/changed host-key rejection, PTY input/output and cleanup, atomic SFTP writes/downloads, traversal and symlink rejection, exact approval races/replay denial, per-agent grants, organization isolation, expired/revoked credentials, numeric Linux metrics, truthful missing-Docker errors, asynchronous cancellation, single-use invitations, team creation, and consistent WAL backup/restore. Official MCP v2 clients exercised discovery, real SSH commands, files and server listing over actual HTTP sockets in both protocol eras.

## Phase status

| Phase | Implemented | Remaining |
|---|---|---|
| Foundation | Monorepo, Next/Nest, all requested Prisma models, migrations, owner enrollment/login, real dashboard, Compose | Further module decomposition and complete request-body schemas in OpenAPI |
| Servers | CRUD/edit, archive, duplicate, folders/tags/favorites, credential rotation API, pinned keys, CIDR validation, one-hop bastion core | Nested folders, restore-from-archive UI, bastion selector and credential-rotation UI |
| Terminal | Real PTY, concurrent sessions, split panes, resize, search, font size, copy/paste, buffer download, disconnect/reconnect, snippet insertion | Full keyboard shortcut suite, configurable encrypted recording, saved workspace layouts |
| SFTP | Browse/read/write, upload/download, mkdir, rename/move, delete approval, permission display, local Monaco assets, atomic replacement | Streaming progress percentages, recursive search, remote copy, file preview types, optional configuration backups |
| MCP | All requested tool names, official v2 modern/legacy handler, bearer machine credentials, strict schemas, approvals, tasks | Product-specific external-app certification, OAuth server/consent integration for clients requiring it |
| Security/approvals | Shared policy, explicit grants, exact single-use approval, revocation, encryption, MFA replay prevention, audit metadata | Independent security review, comprehensive denial-event auditing, MFA recovery, secret-manager adapters, stronger isolated egress/mTLS |
| DevOps | Linux diagnostics/metrics, process/log/service tools, Docker/Compose inspection and container mutations | Successful Docker-daemon fixture coverage, systemd-capable fixture, alert delivery, historical charts |
| Deployment | Non-root app images, Nginx HTTP entrypoint for an external TLS reverse proxy, named SQLite volume, migrations, backup/restore docs and tests, CI configuration | Real domain/certificate deployment, external HTTPS client certification, restore disaster drill on target host |
| Premium | Responsive original dashboard, light mode, teams/invitations APIs, member access UI | Embedded LLM assistant, OIDC/SSO, scheduled runbooks, RDP/VNC, sharing, PWA, richer notifications and team/agent detail editors |

## Deliberate boundaries

- MCP SSH connections are operation-scoped; the connection tools do not claim persistent/resumable shells.
- Transfers are buffered and limited to 1 MiB by default; this is not a large-file transfer implementation.
- Browser shell access grants the capabilities of the remote account. Restrict that account at OS level.
- A process can outlive SSH cancellation; no automatic retry of side effects is attempted.
- Agent token and permission edits currently use revoke-and-recreate through the UI. New grants require explicit selection.
- Servers are archived to preserve historical foreign-key references, rather than destroying audit history.
- No fake server statistics, command results, Docker containers or MCP responses are used.
- Test-only passwords in `tests/` belong to disposable fixtures. Application secrets, private keys, database files, local test accounts and build outputs are excluded from Git.
