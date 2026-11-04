# Deployment and operations

See [operations and workflow configuration](OPERATIONS.md) for readiness probes, verified deployment gating, scheduled encrypted backups, file history and generic OIDC sign-in.

## Linux VPS, Lightsail and EC2

Use a Linux host with Docker Engine and Compose 2.24.4+. Ubuntu/Debian are straightforward defaults. Ordinary target SSH connections do not need AWS API credentials. Provision the host, domain, reverse proxy and security-group/firewall rules yourself: allow HTTPS to your reverse proxy, and your administrative maintenance channel. Allow SSH egress only to approved target networks.

1. Deploy `docker-compose.yml` (for example as a Portainer Git stack, or `docker compose up -d`). It runs the published `ghcr.io/nooblk-98/nexusssh:latest` image for `linux/amd64` and `linux/arm64`; set `NEXUSSSH_IMAGE` to pin a release (`:v0.3.0`), an exact commit (`:sha-<commit>`), or the `:development` channel. It needs no `.env` or configuration to start. On first start the API generates `ENCRYPTION_KEY`, `SESSION_SECRET`, `INTERNAL_SECRET` and `SETUP_TOKEN` into the `nexusssh_secrets` volume and reuses them afterwards. Back that volume up; losing `ENCRYPTION_KEY` makes stored SSH identities unrecoverable.
2. Optionally set `APP_URL=https://ssh.example.com` as a stack/environment variable. Without it the platform works on whatever address it is reached at (`http://192.168.1.10:8080`, your proxy's domain, ...): browser writes must come from the same host they were sent to, the session cookie is `Secure` whenever the browser is on HTTPS, and the MCP endpoint and invite links follow the address in use. Setting `APP_URL` pins the allowed browser origin to exactly that value and requires HTTPS outside localhost; `AUTH_ISSUER`, `MCP_AUTH_ISSUER` and `MCP_PUBLIC_URL` (`APP_URL` + `/mcp`) derive from it. Agent tokens are bound to `MCP_PUBLIC_URL`, so tokens created before you set or change it must be reissued. `SSH_ALLOWED_CIDRS` and `KUBERNETES_ALLOWED_CIDRS` default to every address (`0.0.0.0/0,::/0`); cloud metadata addresses are always refused. Narrow them to your target networks on shared or internet-facing installations. Set them, and any other optional variable, under `services.nexusssh.environment` in a `docker-compose.override.yml` beside the compose file (see [Optional settings](../README.md#optional-settings)).
3. The stack is two containers: `nexusssh` (API, web UI, MCP server and SSH worker behind one built-in HTTP gateway) and `redis`. It serves plain HTTP on `HTTP_PORT` (default `8080`). Put your own TLS-terminating reverse proxy (Caddy, Traefik, Nginx Proxy Manager, Cloudflare Tunnel, a load balancer) in front of it and forward your HTTPS domain to that port, including WebSocket upgrades for `/ws/`. Do not expose the HTTP port publicly without TLS in front; browser session cookies are `Secure` in production.
4. Run `docker compose pull && docker compose up -d`. The API applies versioned migrations without dropping existing records. The data volume mounts at `/app/data`. If any process inside `nexusssh` exits, the container stops and the restart policy restarts it.
5. Open your HTTPS origin and create the first owner with the setup token printed in the API container logs (`First-run setup token: ...`), or the `SETUP_TOKEN` you set, and verify a restricted SSH identity against a disposable target before onboarding production servers.

Containers run as the Node user where practical. Redis has no published port. Never run `docker compose down -v` for a deployment containing data you need.

## Published images

The `Publish image` workflow builds `linux/amd64` and `linux/arm64` images on
native runners and pushes one multi-platform manifest to GitHub Container
Registry:

| Trigger                                   | Tags                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| Publishing a GitHub release (from `main`) | `v0.3.0`, `0.3.0`, `0.3`, `latest`, `sha-<commit>`            |
| Publishing a pre-release                  | `v0.4.0-rc.1`, `0.4.0-rc.1`, `sha-<commit>` (no `latest`)     |
| Push to `development`, after checks pass  | `development`, `sha-<commit>`                                |

To release, tag a verified `main` commit with a semantic version (`v0.3.0`) and
publish a GitHub release for it. Releases created by another workflow's
`GITHUB_TOKEN` do not trigger publishing; create them yourself or with a
personal token.

Moving tags (`latest`, `development`, versions) are convenient; `sha-<commit>`
tags and registry digests are immutable and are what you should pin for
production and rollback. Pushes use the workflow's `GITHUB_TOKEN`; no extra
secret is required. The first publish creates the package; make it public under
the package's settings if hosts should pull without signing in to `ghcr.io`.

## Automatic deployment from GitHub

The `Verification` workflow calls the reusable `Deploy` workflow only after
checks pass and the image is published for a push to `development`. Set the
deployed stack's `NEXUSSSH_IMAGE` to `ghcr.io/nooblk-98/nexusssh:development`
and have the deployment service pull images when it redeploys. Deployments run serially and skip
superseded commits. Configure `DEPLOY_WEBHOOK_URL` under Settings > Secrets
and variables > Actions; the URL stays out of the repository and workflow logs.

The POST includes the verified branch and commit SHA. Configure the receiving
deployment service to honor that SHA rather than independently pulling a moving
branch. A successful workflow means the webhook accepted the request; check the
deployment service for completion. Missing secrets, connection errors, timeouts,
and non-2xx responses fail the workflow. See [operations](OPERATIONS.md) for details.

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

CI builds an image tagged with the exact source commit on every run. For pushes to
`main` and tags that pass all checks, it retains the compressed Docker archive and
`image-manifest.txt` as a seven-day workflow artifact. The
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

Registry images are the simpler path: deploy by `sha-<commit>` tag or digest,
and roll back by setting `NEXUSSSH_IMAGE` to the previous one.

Back up and verify restore before upgrading. Review migrations and dependency changes. Pull the new image (`docker compose pull`), stop `nexusssh` to avoid in-flight side effects, then recreate it. Never scale `nexusssh` above one replica; it owns the SQLite file. If a migration is incompatible with an older version, rollback requires restoring the backup and its matching application image; do not run an old binary against an unreviewed new schema.

## Configuration

`APP_URL` is also the exact permitted browser Origin. `MCP_PUBLIC_URL` is the agent token audience. `MCP_AUTH_ISSUER` is the issuing authority recorded on machine credentials. `ENCRYPTION_KEY` is 32 random bytes in hexadecimal. `INTERNAL_SECRET` protects worker/MCP-to-API calls. `SETUP_TOKEN` protects first-owner enrollment. Browser sessions are opaque random database-backed credentials; `SESSION_SECRET`, `AUTH_AUDIENCE`, `ENCRYPTION_KEY_PROVIDER` and `LOG_LEVEL` are retained configuration slots, not implemented pluggable providers.

`SSH_CONNECT_TIMEOUT`, `SSH_IDLE_TIMEOUT`, `SSH_MAX_SESSIONS`, and `SSH_OUTPUT_LIMIT` bound resources. `SSH_WORKER_CONCURRENCY` (default 4) sets how many interactive SSH operations run at once, and `SSH_HEALTH_CONCURRENCY` (default 4) how many reachability checks run at once. `AUDIT_RETENTION_DAYS` controls audit cleanup. Terminal transcripts are not recorded.

Server status is evidence of reachability through its saved route. Green means
a recent successful check or authenticated connection; an active SSH terminal
also shows green. Red means a network/handshake check failed twice. Gray means
the result is stale or a VPN, DNS, policy, permission or configuration problem
prevented the check; hover the dot for its reason and timestamp. Successful
terminal, SFTP and completed MCP operations refresh this evidence without
changing host-key trust. Older queued probes cannot overwrite newer successful
connections. Unsuccessful checks become eligible for another scan after one
minute; successful evidence expires after 30 minutes. The scheduler runs every
minute and the server list refreshes every 30 seconds while the app is visible.

Job output is transient. Restarting Redis loses queued work/results; task metadata may remain queued or running until reconciled. Inspect and explicitly reissue safe operations rather than automatically replaying side effects.

Direct Kubernetes API connections use a separate `KUBERNETES_ALLOWED_CIDRS`
allowlist, defaulting to every address. Set approved cluster endpoint ranges to
restrict it, and recreate the application container when changing it. See
[Kubernetes cluster connections](KUBERNETES.md) for kubeconfig, TLS, and RBAC
requirements. The SSH VPN/bastion selections do not route these direct API reads.
