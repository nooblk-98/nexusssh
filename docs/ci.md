# GitHub Actions

All workflows run on GitHub-hosted runners (`ubuntu-24.04`, plus
`ubuntu-24.04-arm` for arm64 images). The repository is public, so these
runners cost nothing and jobs run in parallel.

## Verification (`checks.yml`)

Three jobs run side by side; publish and deploy need all three:

- **static:** Compose config, recovery-bundle test, VPN gateway `go test -race`,
  lint, typecheck and build.
- **image:** builds the commit's Docker image with the Actions layer cache. On
  pushes to `main` it also keeps a seven-day rollback archive (see
  [deployment](DEPLOYMENT.md#upgrade)).
- **test:** unit and integration tests against the SSH/Redis fixtures, then
  Playwright browser tests against a native dev stack.

To keep runs to one per commit:

- Pushes are verified only on `main` and `development`; feature branches are
  verified through their pull request. Use **Run workflow** to verify any other
  branch by hand.
- Release tags are not verified again; they point at a commit `main` already
  verified. `publish.yml` still builds and publishes release images.
- A new push to a pull request cancels its older run. Pushes to `main` and
  `development` are never cancelled.

## Publishing

- `publish.yml` builds amd64 and arm64 natively on their own runners, pushes by
  digest, then merges a multi-platform manifest.
- `publish-installer.yml` uses npm trusted publishing with provenance when it is
  configured for the workflow on npmjs.com, otherwise the `NPM_TOKEN` secret.
- `deploy.yml` calls the deployment webhook for verified `development` pushes.

## Former self-hosted runner

The `nexusssh-local-x64` runner is no longer targeted by any workflow on
`development`. Workflow files on older tags (for example `v0.5.0`) still
target it, so re-running those old runs needs that runner online. Remove it under
**Settings → Actions → Runners** once nothing needs it.
