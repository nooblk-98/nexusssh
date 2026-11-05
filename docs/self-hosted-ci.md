# Self-hosted GitHub Actions

All executable jobs in `.github/workflows/` target
`[self-hosted, Linux, X64, nexusssh]`; reusable workflow callers do not set
`runs-on`. There is no GitHub-hosted fallback. ARM64 images use QEMU on the
x64 machine. A single runner executes jobs serially.

To keep the queue short, Verification runs once per commit:

- Pushes are verified only on `main` and `development`; feature branches are
  verified through their pull request. Use **Run workflow** to verify any other
  branch by hand.
- Release tags are not verified again; they point at a commit `main` already
  verified. `publish.yml` still builds and publishes release images.
- A new push to a pull request cancels its older run. Pushes to `main` and
  `development` are never cancelled.
- Node and Go use the host's persistent caches (`~/.npm`, Go module and build
  caches) instead of the Actions cache service.

## Current host

- Repository: `nooblk-98/nexusssh`
- Runner: `nexusssh-local-x64`
- Service account: `nexusssh-runner` (Docker access; no personal GitHub credentials)
- Installation/workspace: `/opt/nexusssh-runner` / `/opt/nexusssh-runner/_work`
- Service: `actions.runner.nooblk-98-nexusssh.nexusssh-local-x64.service`
- System service starts automatically at boot. Keep this machine powered on
  and connected; jobs queue when it is offline.

Inspect with:

```sh
systemctl status actions.runner.nooblk-98-nexusssh.nexusssh-local-x64.service
journalctl -u actions.runner.nooblk-98-nexusssh.nexusssh-local-x64.service -n 100
gh api repos/nooblk-98/nexusssh/actions/runners
```

The unrelated runner on this host is managed separately. Do not change or
stop it when maintaining NexusSSH.

## Persistent-host differences

- Playwright OS dependencies are installed once by the host administrator;
  jobs only download Chromium. After changing the Playwright version, check
  whether its OS dependencies need refreshing.
- Verification tears down both SSH/Redis fixtures and the VPN dev Compose
  stack, including after a failure. Runner process cleanup stops native dev
  processes at job completion. The test ports must remain available.
- Watch disk space: Docker layers and tool caches persist between jobs.
- npm publishing uses the existing `NPM_TOKEN` repository secret, not OIDC
  trusted publishing or `--provenance`, which npm does not support on
  self-hosted runners. Keep the token valid with publish permission.
- Fork PR verification is skipped. Repository settings require approval for
  workflow runs from all external contributors. Never approve arbitrary
  untrusted workflow code for execution on this persistent host.
