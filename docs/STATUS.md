# Verification and remaining work

Source review updated: 5 November 2026. This page describes implemented behavior and the limits of local verification; it is not a production-readiness declaration.

## Verification

The operations update adds deployment gating, editor protection and conflict checks, optional encrypted file history, staged connection diagnostics, dependency readiness, request references, managed encrypted backups, account workspace presets, versioned runbooks and generic OIDC sign-in. See [operations configuration and limitations](OPERATIONS.md).

Local checks cover TypeScript, ESLint, the native production build, unit suites with disposable SQLite migration tests, encrypted-backup restore rehearsal, and browser workflows using mocked API/SSH surfaces. Container-based integration requires a running Docker daemon. Real identity-provider login, off-host backup endpoints, deployment webhook behavior and customer VPN peers require validation in the target environment. Repository tests do not certify those external systems.

The unit suites include real database migrations and encrypted storage, authorization/direct-execution boundaries, Kubernetes command planning, VPN parsing, task recovery, SFTP conflict/history protection, request-context isolation, SSO browser/state binding and local MFA enforcement. Browser fixtures validate UI behavior; Linux/OpenSSH integration fixtures separately exercise the actual remote transports when enabled.

The [4 November follow-up UI review](ui-review/README.md#2026-11-04-follow-up-request-lifecycle-and-status-contrast) adds browser regressions for stale SFTP directory responses, cancellation when leaving Operations, and computed AA contrast for readiness badges. Its performance measurement is browser request cancellation, not a backend throughput benchmark.

The [5 November review](ui-review/README.md#2026-11-05-follow-up-primary-actions-and-cluster-checks) adds primary-action contrast checks in both themes, a delayed cluster-check regression, and request-count coverage showing that connection checks no longer reload unrelated resource lists.

## Phase status

| Phase | Implemented | Remaining |
|---|---|---|
| Foundation | Monorepo, Next/Nest, all requested Prisma models, migrations, owner enrollment/login, real dashboard, Compose | Further module decomposition and complete request-body schemas in OpenAPI |
| Servers | CRUD/edit, archive, duplicate, folders/tags/favorites, credential rotation, pinned keys, CIDR validation, one-hop bastion selector, encrypted WireGuard profiles and server routing | Restore-from-archive UI |
| Terminal | Real PTY, concurrent sessions, split panes, resize, search, font size, copy/paste, buffer download, disconnect/resume, snippet insertion, account workspace presets | Full keyboard shortcut suite, configurable encrypted recording |
| SFTP | Browse/read/write, chunked resumable uploads with progress, streaming downloads, recursive search, remote copy/move, permissions, Monaco, atomic saves, conflict detection and optional encrypted file history | Additional file-preview formats and portable external-write compare-and-swap |
| MCP | All requested tool names, official v2 modern/legacy handler, bearer machine credentials, strict schemas, approval-free SSH, approval-free Kubernetes, tasks | Product-specific external-app certification, OAuth server/consent integration for clients requiring it |
| Security/authorization | Shared policy, explicit grants, approval-free execution, revocation, encryption, MFA replay prevention/recovery codes, explicit OIDC mappings, request references and denial logs | Independent security review, secret-manager adapters, stronger isolated egress/mTLS |
| DevOps | System information, journal logs and systemd service tools (Docker management and metrics monitoring intentionally removed) | systemd-capable fixture |
| Deployment | Non-root app images, single application container with a built-in HTTP gateway for an external TLS reverse proxy, named SQLite volume, migrations, backup/restore docs and tests, scheduled encrypted backups, readiness, gated CI deployment | Real domain/certificate deployment, external HTTPS client certification, restore disaster drill on target host |
| Premium | Responsive dashboard, themes, teams/invitations, member/agent editing, OIDC sign-in and versioned runbooks | Embedded LLM assistant, scheduled runbooks, RDP/VNC, sharing, PWA and richer notifications |

## Deliberate boundaries

- MCP SSH connections are operation-scoped; the connection tools do not claim persistent/resumable shells.
- Interactive SFTP uses resumable 8 MiB upload chunks and a configurable 10 GiB default file limit. Monaco editing is limited to 5 MiB; MCP output/file operations retain their separate bounded limits.
- Browser shell access grants the capabilities of the remote account. Restrict that account at OS level.
- A process can outlive SSH cancellation; no automatic retry of side effects is attempted.
- Agent grants and limits can be edited; tokens expire and can be revoked. New custom grants require explicit selection.
- Servers are archived to preserve historical foreign-key references, rather than destroying audit history.
- No fake command results or MCP responses are used.
- Test-only passwords in `tests/` belong to disposable fixtures. Application secrets, private keys, database files, local test accounts and build outputs are excluded from Git.
