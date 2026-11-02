# Operations and workflow improvements

## Deployment, readiness and setup

Verification calls the reusable deployment workflow only after checks pass on a push to `development`. Deployments run serially; superseded commits are skipped. The webhook receives `{ "ref": "development", "sha": "<verified commit>" }`. Configure the receiver to deploy that exact SHA. A receiver that independently pulls a moving branch cannot guarantee the tested revision is deployed.

`GET /api/health` checks process liveness. `GET /api/ready` returns 200 only when SQLite, Redis, a recent SSH-worker heartbeat and the VPN gateway are available; otherwise it returns 503 with boolean component checks. This does not test customer VPN peers or SSH hosts. Compose uses readiness, while startup sequencing uses liveness. Administrators can inspect readiness under **Settings → Operations**.

`npm run bootstrap` installs lockfile dependencies, creates `.env` only if absent, regenerates Prisma, applies migrations and checks types. `npm run doctor` regenerates Prisma and checks types on an existing checkout. Existing secrets are preserved.

## Connection diagnostics

Choose **Diagnose route and authentication** in a server's connection-check drawer. It checks saved configuration, VPN gateway setup, DNS/destination policy, optional bastion authentication, then target SSH host verification and authentication. Failed stages stop later checks. Gateway acceptance alone is not a WireGuard handshake; successful routed SSH proves connectivity to that destination. No command runs, and existing permissions/allowlists apply.

VPN imports also offer **Validate configuration** before saving, with field-specific errors that omit key material. Validation does not establish connectivity.

## Editor protection and file history

Closing or reloading modified editors offers Save/Discard/Cancel. Browser close/reload uses the native unsaved-work warning. **Preview changes** shows a diff. Saves carry the SHA-256 version of the loaded remote bytes. A changed remote file produces HTTP 409: compare it and explicitly adopt the new remote baseline before saving your edits.

This API serializes editor saves to the same server/path. An external writer can still change the remote file between the SFTP read and rename: portable SFTP has no remote compare-and-swap operation. Atomic replacement prevents partial writes, rather than eliminating external-write races.

`SFTP_FILE_HISTORY=true` enables encrypted previous editor-save contents; it is off by default because configuration files may contain secrets. The limit is ten versions per server/path and 30 days by default (`SFTP_HISTORY_DAYS`, 1–365), with hourly expiry cleanup. Reads require current file-read permission and matching host, account, root and fingerprint identity. Uploads and external writes are not automatically versioned. Select **File history**, compare a version and load it into the editor; only an ordinary version-checked save changes the remote file. The editor limit is 5 MiB.

## Workspace presets and runbooks

The **Workspace presets** toolbar button saves named layouts to the signed-in account. Presets store tab kinds, target IDs, titles, paths, namespaces and columns. Credentials, terminal contents and resume tokens are excluded. Opening a preset adds tabs and uses current permissions. Limits: 50 presets per user and 30 tabs per preset.

Administrators create encrypted, immutable template versions under **Settings → Runbooks**. Saving the same name creates a version. Use single-line templates such as `systemctl status -- {{service}}`, with parameters outside quotes. Values are shell-quoted automatically. Heredocs and command substitutions are rejected. Administrators must choose commands with appropriate argument behavior; use `--` where supported and avoid `eval`, interpreters or programs that execute parameter text.

In **Run command on servers**, choose a template/version, supply parameters and preview the exact command. Review targets and request approval. Existing single-use approvals, permission checks, timeouts, cancellation and per-server results apply. Template changes do not alter pending approvals. Limits: 100 versions per runbook, with 50 recent versions selectable in lists.

## Generic OIDC sign-in

Keep a working local owner account. Set these deployment variables:

| Variable             | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `APP_URL`            | Exact HTTPS public origin, without a trailing slash |
| `OIDC_ISSUER`        | HTTPS discovery issuer URL                          |
| `OIDC_CLIENT_ID`     | Confidential web-client identifier                  |
| `OIDC_CLIENT_SECRET` | Provider client secret                              |
| `OIDC_LABEL`         | Button label; default `Single sign-on`              |

Register `<APP_URL>/api/auth/oidc/callback` as the exact redirect URI. Enable authorization-code flow, S256 PKCE and `openid profile email`. `openid-client` validates tokens; state/nonce/PKCE are tied to an HttpOnly Secure browser cookie and single-use, five-minute state.

Under **Settings → Operations**, map the provider's exact `sub` to an existing enabled user. Email matching never creates/links accounts, and provider claims do not grant roles. Current local roles and grants apply. Enabled local MFA still requires an authenticator or recovery code. Removing a mapping signs out that user's browser sessions. NexusSSH logout does not log out of the provider.

SSO stays disabled until all settings and HTTPS `APP_URL` exist. Provider-specific connectivity must be verified on the deployment; repository tests exercise the application flow with a provider adapter fixture.

## Scheduled encrypted backups

Backups are disabled until `BACKUP_DIRECTORY` and `BACKUP_ENCRYPTION_KEY` exist. Use a separate 32-byte hexadecimal key, retained outside the application and archives.

| Variable                | Default / purpose                                                      |
| ----------------------- | ---------------------------------------------------------------------- |
| `BACKUP_DIRECTORY`      | Required archive directory; prefer a protected off-host mount          |
| `BACKUP_ENCRYPTION_KEY` | Required separate 64-character hexadecimal key                         |
| `BACKUP_INTERVAL_HOURS` | `24`, range 1–168                                                      |
| `BACKUP_RETAIN_COUNT`   | `14`, range 1–365 local archives                                       |
| `BACKUP_UPLOAD_URL`     | Optional HTTPS PUT collection endpoint; generated filename is appended |
| `BACKUP_WEBHOOK_URL`    | Optional HTTPS completion/failure notification endpoint                |
| `APP_REVISION`          | Source revision recorded in the archive; set during image build        |

The optional `infrastructure/compose/backup.yml` override mounts `BACKUP_HOST_DIRECTORY` at `/app/backups`. Provision a protected destination writable by UID 1000 and add the override to the base deployment: `docker compose -f docker-compose.yml -f infrastructure/compose/backup.yml up -d`. Base Compose keeps backups disabled.

The scheduler snapshots committed SQLite/WAL content, captures effective installation encryption secrets, checks integrity/decryption, compresses and encrypts with AES-256-GCM, then decrypts and rehearses a temporary restored copy. It never restores over the live database. The current database limit is 256 MiB. External provider credentials and deployment configuration must be retained separately.

**Settings → Operations** shows the latest result and rehearsal time and allows manual runs. Failures create in-app administrator notifications. The optional HTTPS webhook receives event/time without secrets. Local retention runs after verified local creation, including when a subsequent upload fails; off-host retention belongs to the destination. A local directory alone does not provide disaster recovery.

On a recovery host with Node.js 24, provide the matching `BACKUP_ENCRYPTION_KEY` in the environment and unpack into a **new** directory:

```sh
node infrastructure/scripts/managed-backup.mjs unpack /protected/backup.nexusbackup /protected/new-restore
```

This refuses an existing destination, authenticates/decrypts the archive and verifies restored data/decryption. Then follow the stopped-stack restore procedure in [deployment](DEPLOYMENT.md) using the matching image. The existing network-isolated `recovery_bundle.py` image rehearsal remains available for full target-host disaster drills.

## Request references

API errors expose `X-Correlation-ID`; **Audit Log** can filter by this request reference. It follows queued SSH jobs into worker requests, audit records and structured metadata logs. Existing business correlation IDs for tasks/approvals are preserved separately. Bodies, credentials, authorization codes and remote output are excluded from these logs.
