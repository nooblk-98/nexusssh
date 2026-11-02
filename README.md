<div align="center">

<img src="docs/assets/nexusssh-banner.svg" alt="NexusSSH — a centralized web-based SSH and Kubernetes manager with MCP support. Infrastructure credentials stay on your deployment." width="1200" />

[![Verification](https://img.shields.io/github/actions/workflow/status/nooblk-98/nexusssh/checks.yml?branch=development&style=flat-square&label=checks)](https://github.com/nooblk-98/nexusssh/actions/workflows/checks.yml)
[![Release](https://img.shields.io/badge/release-v0.3.0-0f766e?style=flat-square)](CHANGELOG.md)
[![Container image](https://img.shields.io/badge/ghcr.io-nexusssh-2088ff?style=flat-square&logo=docker&logoColor=white)](https://github.com/nooblk-98/nexusssh/pkgs/container/nexusssh)
[![Self-hosted](https://img.shields.io/badge/deployment-self--hosted-0f766e?style=flat-square)](#getting-started)
[![MCP support](https://img.shields.io/badge/MCP-supported-2563eb?style=flat-square)](#connect-an-ai-client-through-mcp)
[![Kubernetes support](https://img.shields.io/badge/Kubernetes-supported-6366f1?style=flat-square)](docs/KUBERNETES.md)

⭐ If NexusSSH is useful to you, star the repository. It helps others find it.

[Overview](#overview) · [Features](#features) · [Screenshots](#screenshots) · [Getting started](#getting-started) · [AI and MCP](#connect-an-ai-client-through-mcp) · [Documentation](#documentation)

<img src="docs/assets/screenshots/ssh-terminal.png" alt="NexusSSH workspace with a browser SSH terminal open next to the folder tree of servers and Kubernetes clusters" width="1000" />

</div>

## Overview

NexusSSH is a self-hosted workspace for your servers and Kubernetes clusters. Save your connections once, then open terminals, browse files, run cluster commands, and manage team access from a browser.

It also ships with a built-in [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server, so AI assistants can work on your infrastructure **without ever receiving your SSH passwords, private keys, Kubernetes tokens, or kubeconfig files**. Credentials stay encrypted on your deployment. AI clients connect with scoped, expiring, revocable tokens, and NexusSSH runs only the operations you have granted them. Sensitive operations wait for human approval.

## Features

| Area                       | Capabilities                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Centralized workspace**  | Nested folders for servers and clusters, search, tags, favorites, recent connections, split views, a command palette, and saved workspace presets.          |
| **Browser SSH**            | Interactive terminals with pinned host keys, session resume, snippets, search, command suggestions, and broadcast input across sessions.                     |
| **Remote files**           | SFTP browsing, resumable uploads with progress, and a Monaco editor with change previews, conflict detection, and optional encrypted file history.            |
| **Kubernetes**             | Kubeconfig import with context and namespace selection, a cluster command console, resource browsing, and pod logs.                                          |
| **AI access through MCP**  | Per-agent server, cluster, and tool grants, human approval for commands and mutations, call limits, token revocation, and per-agent activity.                |
| **Private infrastructure** | Reach targets through saved WireGuard profiles, an SSH bastion, or both. The same routes serve browser sessions and MCP operations.                          |
| **Team access**            | Users, teams, operation grants, TOTP MFA with recovery codes, and optional OIDC single sign-on.                                                              |
| **Operations**             | Versioned runbooks, staged connection diagnostics, readiness checks, a searchable audit log, and optional scheduled encrypted backups with restore rehearsal. |

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/sftp-file-browser.png"><img src="docs/assets/screenshots/sftp-file-browser.png" alt="SFTP file browser listing a remote home directory with upload drop zone" /></a>
      <p align="center"><b>SFTP file browser</b><br/><sub>Browse, upload, download, and edit remote files in the browser.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/kubernetes-console.png"><img src="docs/assets/screenshots/kubernetes-console.png" alt="Kubernetes console listing kube-system pods for a saved cluster" /></a>
      <p align="center"><b>Kubernetes console</b><br/><sub>Run kubectl-style commands against saved clusters, with no local kubeconfig.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/mcp-server.png"><img src="docs/assets/screenshots/mcp-server.png" alt="MCP server settings showing the endpoint, client configuration, and available tools" /></a>
      <p align="center"><b>Built-in MCP server</b><br/><sub>Point any remote HTTP MCP client at one endpoint with a scoped token.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/ai-agents.png"><img src="docs/assets/screenshots/ai-agents.png" alt="AI Agents page listing registered agents with access, limits, and status" /></a>
      <p align="center"><b>AI agents</b><br/><sub>Grant, limit, and revoke each agent's access to servers, clusters, and tools.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/audit-log.png"><img src="docs/assets/screenshots/audit-log.png" alt="Audit log of terminal connections, Kubernetes commands, and agent tool calls" /></a>
      <p align="center"><b>Audit log</b><br/><sub>Every sign-in, connection, and agent tool call, with request references.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/vpn-profiles.png"><img src="docs/assets/screenshots/vpn-profiles.png" alt="VPN page listing WireGuard profiles and the servers that use them" /></a>
      <p align="center"><b>WireGuard routes</b><br/><sub>Reach private networks through saved VPN profiles and bastions.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/command-palette.png"><img src="docs/assets/screenshots/command-palette.png" alt="Command palette open over a terminal, with connect, details, and test actions per server" /></a>
      <p align="center"><b>Command palette</b><br/><sub>Press <kbd>Ctrl</kbd>+<kbd>K</kbd> to connect, inspect, or test any server.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="docs/assets/screenshots/security-settings.png"><img src="docs/assets/screenshots/security-settings.png" alt="Security settings for host key policy, allowed SSH destinations, and approval notifications" /></a>
      <p align="center"><b>Connection safeguards</b><br/><sub>Host key policy, destination allowlists, and approval notifications.</sub></p>
    </td>
  </tr>
</table>

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Linux containers, on `amd64` or `arm64`
- Docker Compose **2.24.4 or newer**

### Deploy with one command

```sh
curl -fsSL https://raw.githubusercontent.com/nooblk-98/nexusssh/main/docker-compose.yml -o docker-compose.yml && docker compose up -d
```

This pulls the prebuilt image from GitHub Container Registry and starts two containers: `nexusssh` (web UI, API, MCP server, and SSH worker behind one gateway) and `redis`. No `.env` file is needed to start.

| Image tag                                 | Built from                                    |
| ----------------------------------------- | --------------------------------------------- |
| `ghcr.io/nooblk-98/nexusssh:latest`       | The `main` branch (default)                   |
| `ghcr.io/nooblk-98/nexusssh:0.3.0`        | A specific release version                    |
| `ghcr.io/nooblk-98/nexusssh:development`  | The `development` branch, for early testing   |
| `ghcr.io/nooblk-98/nexusssh:sha-<commit>` | An exact commit, for pinning and rollback     |

To run another tag, set `NEXUSSSH_IMAGE`, for example `NEXUSSSH_IMAGE=ghcr.io/nooblk-98/nexusssh:development docker compose up -d`. To upgrade, run `docker compose pull && docker compose up -d`.

### First sign-in

1. Open `http://<your-host>:8080`.
2. Copy the first-run setup token from `docker compose logs nexusssh`, then create your owner account. No default password is shipped.
3. Add an SSH identity and a server, or import a Kubernetes kubeconfig. Verify SSH host fingerprints through a trusted console before saving them.
4. Under **Settings → Security**, allow the networks your targets live in, then test the connection. Pick a WireGuard profile or bastion if the target needs one.
5. Open a terminal, an SFTP session, or a cluster console.

Installation secrets are generated on first start and kept in the `nexusssh_secrets` volume. Application records live in `nexusssh_data`.

> [!IMPORTANT]
> Back up both volumes. Losing the encryption key makes saved credentials unrecoverable, and `docker compose down -v` deletes them.

> [!WARNING]
> The app serves plain HTTP on port `8080`. For a shared or internet-facing installation, put a TLS-terminating reverse proxy in front, set a stable `APP_URL`, and narrow `SSH_ALLOWED_CIDRS` by following the [deployment guide](docs/DEPLOYMENT.md).

## Connect an AI client through MCP

NexusSSH is the controlled execution layer between your AI client and your infrastructure. The client needs only the NexusSSH endpoint and an agent token. It never needs direct SSH access or a copy of your kubeconfig.

1. Save and verify your connections in NexusSSH.
2. Under **Settings → AI Agents**, register an agent. Choose **Administrator** for the whole workspace, or **Custom** to pick its servers, clusters, and tools.
3. Copy the token, which is shown once, into your client's secret store and add the server:

   ```json
   {
     "mcpServers": {
       "nexusssh": {
         "type": "http",
         "url": "https://nexusssh.example.com/mcp",
         "headers": { "Authorization": "Bearer <agent-token>" }
       }
     }
   }
   ```

4. Ask your assistant to inspect disk usage, list Kubernetes resources, or read pod logs. Commands and mutations return an approval request. Approve it under **Settings → Approvals**, and the agent retries the exact approved operation.

> [!NOTE]
> Use a client that supports remote HTTP MCP with bearer authentication. Clients that require an OAuth consent flow can't authenticate to this release. Browser OIDC sign-in is separate from MCP authentication. See the [MCP client guide](docs/CLIENTS.md) for the tested flow, approvals, and async tasks.

## How it works

```mermaid
flowchart LR
  B[Browser] --> G[Gateway :8080]
  A[AI client] -- bearer token --> G
  G --> W[Web UI]
  G --> API[API]
  G --> M[MCP server]
  M --> API
  API -- task ID --> R[(Redis)]
  R --> K[SSH worker]
  API --- D[(SQLite)]
  K --> V[WireGuard / bastion]
  API --> V
  V --> T[Servers and clusters]
```

The API checks every request against the caller's grants, consumes an exact human approval when one is required, and queues only a task ID. The worker rechecks authorization before it receives an in-memory SSH configuration. Execution records keep metadata and argument digests, not raw output. Read the [architecture](docs/ARCHITECTURE.md) and [security](docs/SECURITY.md) notes for the full model.

## Local development

To build the container from your checkout instead of pulling it, add the development override. It also binds the app to loopback only:

```sh
git clone https://github.com/nooblk-98/nexusssh.git
cd nexusssh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

To run the services natively, you need Node.js 24 and a Redis instance on `127.0.0.1:6379`.

```sh
npm ci
npm run setup        # creates .env with generated secrets
npm run db:generate
npm run db:migrate
npm run dev          # web on :3000, API on :3001, MCP on :3002
```

| Command             | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `npm run lint`      | Lint all workspaces                        |
| `npm run typecheck` | Type-check the API, worker, and web UI     |
| `npm test`          | Run unit tests with Vitest                 |
| `npm run test:e2e`  | Run Playwright browser tests               |
| `npm run build`     | Build all workspaces for production        |

REST route documentation is served at `/api/docs` on every installation.

## Documentation

| Guide                                | Contents                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| [Deployment](docs/DEPLOYMENT.md)     | Hosting, HTTPS, persistent volumes, upgrades, and recovery                |
| [Operations](docs/OPERATIONS.md)     | OIDC, encrypted backups, file history, diagnostics, presets, and runbooks |
| [MCP clients](docs/CLIENTS.md)       | Client setup, authentication, tools, approvals, and task handling         |
| [Kubernetes](docs/KUBERNETES.md)     | Kubeconfig imports, consoles, commands, and private routes                |
| [VPN and bastions](docs/VPN.md)      | WireGuard configuration and combined connection paths                     |
| [Folders](docs/FOLDERS.md)           | Organizing servers and clusters                                           |
| [Architecture](docs/ARCHITECTURE.md) | Service boundaries and execution flows                                    |
| [Security](docs/SECURITY.md)         | Credential handling, permissions, and operational constraints             |
| [Verification](docs/STATUS.md)       | Current coverage and remaining work                                       |

<details>
<summary>Repository social card</summary>

![NexusSSH social card — centralized web-based SSH and Kubernetes management with MCP support](docs/assets/nexusssh-social-card.png)

[Download PNG](docs/assets/nexusssh-social-card.png) · [Editable SVG](docs/assets/nexusssh-social-card.svg)

The PNG is **1280 × 640 pixels**. To use it for link previews, upload it under **Settings → Social preview → Edit → Upload an image**, following [GitHub's social preview guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

</details>

---

<div align="center">

Built by [Lahiru S Liyanage](https://github.com/nooblk-98) · [Release notes](CHANGELOG.md)

</div>
