# NexusSSH

A self-hosted infrastructure console with real browser SSH, SFTP, and a remote MCP gateway. SSH credentials stay on the deployment; external agents use scoped machine credentials over HTTP/HTTPS.

> [!IMPORTANT]
> This is a working initial implementation, not a production certification or a claim that the entire master brief is complete. Read [verification and remaining work](docs/STATUS.md) before deployment.

## What works

- Next.js dashboard backed by real SQLite records; dark/light themes and responsive navigation.
- Owner setup, password login, opaque HttpOnly sessions, TOTP MFA, role and server permissions.
- Encrypted password/key identities, pinned host keys, destination CIDR allowlists, one-hop bastions.
- Interactive xterm.js shells over authenticated WebSockets, multiple sessions, split panes, resizing, search and reconnect.
- SFTP browsing, bounded uploads/downloads, Monaco editing, atomic saves, mkdir, rename/move and deletion.
- Remote MCP SDK v2 using explicit 2026-07-28 handling, with tested legacy stateless compatibility.
- Agents with explicit server/tool grants, expiring hashed machine tokens, revocation, and exact single-use approvals.
- Linux, service and Docker diagnostics through SSH; background execution and cancellation through BullMQ.
- SQLite migrations, WAL, integrity checks, online backup and offline restore.
- Compose services for web, API, MCP, worker, Redis and Nginx. Only the API mounts SQLite.

## Quick start: local Compose

Requires Docker Engine/Desktop with Linux containers, Docker Compose 2.24.4+ and Node.js 24 for initial setup.

```sh
npm ci
npm run setup
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Open **http://localhost:8080**. On first run, enter `SETUP_TOKEN` from the generated `.env` and create your owner account. No default application password is shipped. Keep `.env` private and retain its encryption key; losing that key makes stored SSH identities unrecoverable.

Before adding servers, set `SSH_ALLOWED_CIDRS` in `.env` to the exact target networks and recreate the API and worker services. The example documentation network does not grant access to your infrastructure. Verify each host fingerprint through a trusted server console:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Add a non-root SSH account, credential, verified fingerprint and restricted file root in the Servers screen. The account needs the remote permissions appropriate to the operations you grant. Passwords/private keys are never returned by an API.

## Native development

```sh
npm ci
npm run setup
npm run db:generate
npm run db:migrate
```

Start Redis on a private local port and set `REDIS_URL`. Then `npm run dev` starts web :3000, API :3001, MCP :3002 and the worker. The local web URL must match `APP_URL` exactly for Origin validation. Use `http://localhost:3000`, not a different loopback hostname. The bundled test Redis listens on :26379 if you choose to reuse it for development.

The native SQLite URL is resolved relative to `packages/database/prisma`. `npm run setup` writes `file:../../../data/nexusssh.db`; the migration wrapper creates the file without truncating existing data. Docker always overrides it with `file:/app/data/nexusssh.db`.

## Production installation

Follow [deployment and upgrades](docs/DEPLOYMENT.md). Configure a real domain, trusted TLS certificate, network allowlist, secrets and restricted target accounts before using the production Compose file. Production startup refuses an HTTP `APP_URL`.

The application uses no PostgreSQL, MySQL, MongoDB or external database server. Redis contains bounded transient jobs/results, not application records.

## Repository

```text
apps/web/              Next.js UI and shadcn-style Button primitive
apps/api/              NestJS REST, authentication, policy enforcement, WebSocket terminal
apps/mcp/              Official MCP v2 per-request HTTP gateway
packages/database/     Prisma schema and versioned SQLite migrations
packages/ssh-core/     Verified ssh2 connections, commands and SFTP
packages/policy-engine/ Shared grants and approval classification
packages/shared/       Strict schemas, encryption and configuration
workers/ssh-worker/    BullMQ execution; credentials fetched via authenticated API leases
infrastructure/       Container builds, Nginx, setup, backup/restore
tests/                 Unit, real Linux integration and browser tests
docs/                  Architecture, operations, security and verification
```

Business logic lives in the API/shared packages. The API handles interactive shells using the same SSH core as the worker. Workers never open the SQLite file. MCP does not connect directly to SSH and does not own database access.

## Checks

```sh
npm run lint
npm run typecheck
npm run build
npm test
docker compose -f tests/fixtures/compose.yml up -d --build
RUN_INTEGRATION=1 npm test
```

PowerShell: `$env:RUN_INTEGRATION='1'; npm test`. Integration tests create a disposable database under `data/`, authenticate to a disposable Linux OpenSSH server and run the official MCP client in a separate HTTP client context. They never target production servers. `npm test` alone skips the Docker-dependent integration suite explicitly.

`npm run test:e2e` uses Edge and a fresh development Compose installation at :8080. It creates a clearly identified browser-test owner; use a disposable Compose project/volume, not an existing workspace. Test outputs are under `test-results/`.

## Further reading

- [Architecture and request flows](docs/ARCHITECTURE.md)
- [Security boundaries and operational constraints](docs/SECURITY.md)
- [Remote MCP clients](docs/CLIENTS.md)
- [Deployment, backup, restore and upgrades](docs/DEPLOYMENT.md)
- [Verified behavior and remaining work](docs/STATUS.md)

REST route documentation is available at `/api/docs`. Zod schemas in `packages/shared/operations.ts` are the authoritative tool argument schemas; Swagger currently documents routes and authentication rather than every generated Zod payload.
