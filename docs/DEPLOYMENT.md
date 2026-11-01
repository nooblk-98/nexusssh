# Deployment and operations

## Linux VPS, Lightsail and EC2

Use a Linux host with Docker Engine and Compose 2.24.4+. Ubuntu/Debian are straightforward defaults. Ordinary target SSH connections do not need AWS API credentials. Provision the host, domain, reverse proxy and security-group/firewall rules yourself: allow HTTPS to your reverse proxy, and your administrative maintenance channel. Allow SSH egress only to approved target networks.

1. Deploy `docker-compose.yml` (for example as a Portainer Git stack, or `docker compose up -d --build`). It needs no `.env` or configuration to start. On first start the API generates `ENCRYPTION_KEY`, `SESSION_SECRET`, `INTERNAL_SECRET` and `SETUP_TOKEN` into the `nexusssh_secrets` volume and reuses them afterwards. Back that volume up; losing `ENCRYPTION_KEY` makes stored SSH identities unrecoverable.
2. Optionally set `APP_URL=https://ssh.example.com` as a stack/environment variable. Without it the platform works on whatever address it is reached at (`http://192.168.1.10:8080`, your proxy's domain, ...): browser writes must come from the same host they were sent to, the session cookie is `Secure` whenever the browser is on HTTPS, and the MCP endpoint and invite links follow the address in use. Setting `APP_URL` pins the allowed browser origin to exactly that value and requires HTTPS outside localhost; `AUTH_ISSUER`, `MCP_AUTH_ISSUER` and `MCP_PUBLIC_URL` (`APP_URL` + `/mcp`) derive from it. Agent tokens are bound to `MCP_PUBLIC_URL`, so tokens created before you set or change it must be reissued. `SSH_ALLOWED_CIDRS` defaults to the private ranges `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`; narrow it to your target networks, or add public ranges for internet-facing servers.
3. The stack is two containers: `nexusssh` (API, web UI, MCP server and SSH worker behind one built-in HTTP gateway) and `redis`. It serves plain HTTP on `HTTP_PORT` (default `8080`). Put your own TLS-terminating reverse proxy (Caddy, Traefik, Nginx Proxy Manager, Cloudflare Tunnel, a load balancer) in front of it and forward your HTTPS domain to that port, including WebSocket upgrades for `/ws/`. Do not expose the HTTP port publicly without TLS in front; browser session cookies are `Secure` in production.
4. Run `docker compose up -d --build`. The API applies versioned migrations without dropping existing records. The data volume mounts at `/app/data`. If any process inside `nexusssh` exits, the container stops and the restart policy restarts it.
5. Open your HTTPS origin and create the first owner with the setup token printed in the API container logs (`First-run setup token: ...`), or the `SETUP_TOKEN` you set, and verify a restricted SSH identity against a disposable target before onboarding production servers.

Containers run as the Node user where practical. Redis has no published port. Never run `docker compose down -v` for a deployment containing data you need.

## Automatic deployment from GitHub

The `Deploy` workflow sends a POST to the URL in the `DEPLOY_WEBHOOK_URL`
repository secret on every push to `development`. Configure the secret under
Settings > Secrets and variables > Actions. The webhook URL stays out of the
repository and workflow logs.

Deployment runs independently of the `Verification` workflow. A successful
run means the webhook accepted the request; check the stack in Portainer for
deployment completion. Missing secrets, connection errors, timeouts, and
non-2xx responses fail the workflow.

## Backup

For a paired local recovery bundle, mount an operator-controlled directory at
`/recovery` in the application container, then run:

```sh
IMAGE_ID=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q nexusssh)")
docker compose exec nexusssh python3 infrastructure/scripts/recovery_bundle.py create --image-id "$IMAGE_ID" --bundle /recovery/nexus-$(date -u +%Y%m%dT%H%M%SZ)
python3 infrastructure/scripts/recovery_bundle.py rehearse --bundle /path/on/host/to/recovery/<bundle-name>
```

The bundle manifest binds a consistent SQLite snapshot, the persisted
`secrets.json`, and the exact Docker image ID of the running container. Keep a
`docker save` archive of that image with the bundle; the image must be loaded on
the host used for rehearsal or restore. The bundle uses owner-only permissions.
The rehearsal verifies checksums and SQLite integrity, then mounts temporary
restored copies read-only in a disposable, network-isolated container from that
exact image. Its probe opens the database and decrypts one stored SSH credential
when one exists; an empty `SSHIdentity` table can verify key format but cannot
prove historical credential decryption. No credential plaintext is printed.
The rehearsal does not start the full Redis-backed application or replace running
data. Run it on a Docker host with Python 3 and access to the mounted bundle.
Configure the `/recovery`
mount and its access controls before using this command. Keep this bundle
encrypted and off-host using a destination and key custody process selected by
the operator. Keep the image archive under the same retention policy. A local
directory alone does not protect against host loss. If
`ENCRYPTION_KEY` is supplied externally rather than in `secrets.json`, this
bundle is insufficient; retain that external key through its existing custody
system. For a full restore, stop the stack and restore both files together into
fresh data and secrets volumes, then start the matching image. Rehearse that
volume swap on a disposable stack before using it in production.

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

CI builds an image tagged with the exact source commit and retains its compressed
Docker archive and `image-manifest.txt` as a seven-day workflow artifact. The
manifest includes Docker's immutable image ID. To deploy that exact build,
download the artifact, check the loaded image ID against the manifest, run
`docker load -i nexusssh-image.tar.gz`, and set `NEXUSSSH_IMAGE` to the recorded
commit tag. Retain the previous deployment's archive and paired recovery bundle
outside CI's seven-day retention period for rollback. The image ID identifies
local image content; it is not a registry digest. If using an operator-owned
registry, deploy by its immutable digest instead. This repo does not select a
registry, image storage destination, or production deployment credential. The
CI archive consumes Actions artifact storage; review its usage before relying
on it for a long retention period.

Back up and verify restore before upgrading. Review migrations and dependency changes. Build the new image, stop `nexusssh` to avoid in-flight side effects, then recreate it. Never scale `nexusssh` above one replica; it owns the SQLite file. If a migration is incompatible with an older version, rollback requires restoring the backup and its matching application image; do not run an old binary against an unreviewed new schema.

## Configuration

`APP_URL` is also the exact permitted browser Origin. `MCP_PUBLIC_URL` is the agent token audience. `MCP_AUTH_ISSUER` is the issuing authority recorded on machine credentials. `ENCRYPTION_KEY` is 32 random bytes in hexadecimal. `INTERNAL_SECRET` protects worker/MCP-to-API calls. `SETUP_TOKEN` protects first-owner enrollment. Browser sessions are opaque random database-backed credentials; `SESSION_SECRET`, `AUTH_AUDIENCE`, `ENCRYPTION_KEY_PROVIDER` and `LOG_LEVEL` are retained configuration slots, not implemented pluggable providers.

`SSH_CONNECT_TIMEOUT`, `SSH_IDLE_TIMEOUT`, `SSH_MAX_SESSIONS`, and `SSH_OUTPUT_LIMIT` bound resources. `AUDIT_RETENTION_DAYS` controls audit cleanup. Terminal transcripts are not recorded.

Job output is transient. Restarting Redis loses queued work/results; task metadata may remain queued or running until reconciled. Inspect and explicitly reissue safe operations rather than automatically replaying side effects.
