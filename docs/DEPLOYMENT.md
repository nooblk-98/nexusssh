# Deployment and operations

## Linux VPS, Lightsail and EC2

Use a Linux host with Docker Engine and Compose 2.24.4+. Ubuntu/Debian are straightforward defaults. Ordinary target SSH connections do not need AWS API credentials. Provision the host, domain, reverse proxy and security-group/firewall rules yourself: allow HTTPS to your reverse proxy, and your administrative maintenance channel. Allow SSH egress only to approved target networks.

1. Deploy `docker-compose.yml` (for example as a Portainer Git stack, or `docker compose up -d --build`). It needs no `.env` or configuration to start. On first start the API generates `ENCRYPTION_KEY`, `SESSION_SECRET`, `INTERNAL_SECRET` and `SETUP_TOKEN` into the `nexusssh_secrets` volume and reuses them afterwards. Back that volume up; losing `ENCRYPTION_KEY` makes stored SSH identities unrecoverable.
2. Set `APP_URL=https://ssh.example.com` as a stack/environment variable. It defaults to `http://localhost:${HTTP_PORT}`, which only works from the host itself. `AUTH_ISSUER`, `MCP_AUTH_ISSUER` and `MCP_PUBLIC_URL` (`APP_URL` + `/mcp`) derive from it. `SSH_ALLOWED_CIDRS` defaults to the private ranges `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`; narrow it to your target networks, or add public ranges for internet-facing servers.
3. The stack is two containers: `nexusssh` (API, web UI, MCP server and SSH worker behind one built-in HTTP gateway) and `redis`. It serves plain HTTP on `HTTP_PORT` (default `8080`). Put your own TLS-terminating reverse proxy (Caddy, Traefik, Nginx Proxy Manager, Cloudflare Tunnel, a load balancer) in front of it and forward your HTTPS domain to that port, including WebSocket upgrades for `/ws/`. Do not expose the HTTP port publicly without TLS in front; browser session cookies are `Secure` in production.
4. Run `docker compose up -d --build`. The API applies versioned migrations without dropping existing records. The data volume mounts at `/app/data`. If any process inside `nexusssh` exits, the container stops and the restart policy restarts it.
5. Open your HTTPS origin and create the first owner with the setup token printed in the API container logs (`First-run setup token: ...`), or the `SETUP_TOKEN` you set, and verify a restricted SSH identity against a disposable target before onboarding production servers.

Containers run as the Node user where practical. Redis has no published port. Never run `docker compose down -v` for a deployment containing data you need.

## Backup

The API image includes Python's SQLite online backup API. This includes committed WAL content consistently; it does not copy the live main file.

```sh
docker compose exec nexusssh python3 infrastructure/scripts/backup.py backup --backup /app/data/backups/nexus-2026-10-21.db
docker compose cp nexusssh:/app/data/backups/nexus-2026-10-21.db ./nexus-2026-10-21.db
```

Choose a unique timestamp per backup. Encrypt and copy backups off-host according to your retention policy. Back up the encryption key separately. Test restore regularly.

## Restore

Stop all application services cleanly with `docker compose stop`. Preserve the current data volume and take a recovery snapshot before replacing anything. The restore helper refuses when WAL/SHM sidecars remain; checkpoint the stopped database using SQLite before proceeding, rather than deleting sidecars from a live database.

```sh
docker compose run --rm --no-deps nexusssh python3 infrastructure/scripts/backup.py restore --backup /app/data/backups/nexus-2026-10-21.db --api-stopped
docker compose up -d
```

The helper verifies the backup, replaces the file atomically, and never silently removes WAL files. Restore the matching encryption key configuration. The application reruns an integrity check on startup.

## Upgrade

Back up and verify restore before upgrading. Review migrations and dependency changes. Build the new image, stop `nexusssh` to avoid in-flight side effects, then recreate it. Never scale `nexusssh` above one replica; it owns the SQLite file. If a migration is incompatible with an older version, rollback requires restoring the backup and its matching application image; do not run an old binary against an unreviewed new schema.

## Configuration

`APP_URL` is also the exact permitted browser Origin. `MCP_PUBLIC_URL` is the agent token audience. `MCP_AUTH_ISSUER` is the issuing authority recorded on machine credentials. `ENCRYPTION_KEY` is 32 random bytes in hexadecimal. `INTERNAL_SECRET` protects worker/MCP-to-API calls. `SETUP_TOKEN` protects first-owner enrollment. Browser sessions are opaque random database-backed credentials; `SESSION_SECRET`, `AUTH_AUDIENCE`, `ENCRYPTION_KEY_PROVIDER` and `LOG_LEVEL` are retained configuration slots, not implemented pluggable providers.

`SSH_CONNECT_TIMEOUT`, `SSH_IDLE_TIMEOUT`, `SSH_MAX_SESSIONS`, and `SSH_OUTPUT_LIMIT` bound resources. `AUDIT_RETENTION_DAYS` controls audit cleanup. Telemetry is collected on request or at a UI-selected interval, never written at high frequency to SQLite. Terminal transcripts are not recorded.

Job output is transient. Restarting Redis loses queued work/results; task metadata may remain queued or running until reconciled. Inspect and explicitly reissue safe operations rather than automatically replaying side effects.
