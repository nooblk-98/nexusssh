# Deployment and operations

## Linux VPS, Lightsail and EC2

Use a Linux host with Docker Engine and Compose 2.24.4+. Ubuntu/Debian are straightforward defaults. Ordinary target SSH connections do not need AWS API credentials. Provision the host, domain, reverse proxy and security-group/firewall rules yourself: allow HTTPS to your reverse proxy, and your administrative maintenance channel. Allow SSH egress only to approved target networks.

1. Copy the repository and run `npm ci && npm run setup` once with Node 24, or generate equally strong random secrets using your secret manager.
2. Set `APP_URL=https://ssh.example.com`, `AUTH_ISSUER` and `MCP_AUTH_ISSUER` to that origin, `MCP_PUBLIC_URL=https://ssh.example.com/mcp`, and the destination `SSH_ALLOWED_CIDRS` in `.env`. Compose reads these for variable interpolation; no `env_file` is required, so on Portainer or another stack manager you can set the same variables as stack environment variables instead of creating `.env`. Compose refuses to start if a required variable is missing.
3. The bundled Nginx serves plain HTTP on `HTTP_PORT` (default `8080`). Put your own TLS-terminating reverse proxy (Caddy, Traefik, Nginx Proxy Manager, Cloudflare Tunnel, a load balancer) in front of it and forward your HTTPS domain to that port, including WebSocket upgrades for `/ws/`. Do not expose the HTTP port publicly without TLS in front; browser session cookies are `Secure` in production.
4. Run `docker compose up -d --build`. The API applies versioned migrations without dropping existing records. The named volume mounts at `/app/data`, only in the API service.
5. Open your HTTPS origin, create the first owner with `SETUP_TOKEN`, and verify a restricted SSH identity against a disposable target before onboarding production servers.

Containers run as the Node user where practical. Redis has no published port. Never run `docker compose down -v` for a deployment containing data you need.

## Backup

The API image includes Python's SQLite online backup API. This includes committed WAL content consistently; it does not copy the live main file.

```sh
docker compose exec api python3 infrastructure/scripts/backup.py backup --backup /app/data/backups/nexus-2026-10-21.db
docker compose cp api:/app/data/backups/nexus-2026-10-21.db ./nexus-2026-10-21.db
```

Choose a unique timestamp per backup. Encrypt and copy backups off-host according to your retention policy. Back up the encryption key separately. Test restore regularly.

## Restore

Stop all application services cleanly with `docker compose stop`. Preserve the current data volume and take a recovery snapshot before replacing anything. The restore helper refuses when WAL/SHM sidecars remain; checkpoint the stopped database using SQLite before proceeding, rather than deleting sidecars from a live database.

```sh
docker compose run --rm --no-deps api python3 infrastructure/scripts/backup.py restore --backup /app/data/backups/nexus-2026-10-21.db --api-stopped
docker compose up -d
```

The helper verifies the backup, replaces the file atomically, and never silently removes WAL files. Restore the matching encryption key configuration. The application reruns an integrity check on startup.

## Upgrade

Back up and verify restore before upgrading. Review migrations and dependency changes. Build new images, stop API/workers to avoid in-flight side effects, then recreate services. Never scale the SQLite-owning API above one replica. If a migration is incompatible with an older version, rollback requires restoring the backup and its matching application image; do not run an old binary against an unreviewed new schema.

## Configuration

`APP_URL` is also the exact permitted browser Origin. `MCP_PUBLIC_URL` is the agent token audience. `MCP_AUTH_ISSUER` is the issuing authority recorded on machine credentials. `ENCRYPTION_KEY` is 32 random bytes in hexadecimal. `INTERNAL_SECRET` protects worker/MCP-to-API calls. `SETUP_TOKEN` protects first-owner enrollment. Browser sessions are opaque random database-backed credentials; `SESSION_SECRET`, `AUTH_AUDIENCE`, `ENCRYPTION_KEY_PROVIDER` and `LOG_LEVEL` are retained configuration slots, not implemented pluggable providers.

`SSH_CONNECT_TIMEOUT`, `SSH_IDLE_TIMEOUT`, `SSH_MAX_SESSIONS`, and `SSH_OUTPUT_LIMIT` bound resources. `AUDIT_RETENTION_DAYS` controls audit cleanup. Telemetry is collected on request or at a UI-selected interval, never written at high frequency to SQLite. Terminal transcripts are not recorded.

Job output is transient. Restarting Redis loses queued work/results; task metadata may remain queued or running until reconciled. Inspect and explicitly reissue safe operations rather than automatically replaying side effects.
