<p align="center">
  <img src="docs/assets/nexusssh-banner.svg" alt="NexusSSH — a centralized web-based SSH and Kubernetes manager with MCP support. Infrastructure credentials stay on your deployment." width="1200" />
</p>

# NexusSSH

**A centralized, web-based SSH and Kubernetes manager with built-in MCP support.**

Manage your servers, remote files, Kubernetes clusters, team access, and AI agents from one self-hosted workspace. Connect your infrastructure once, then work through your browser or a compatible MCP client.

**You no longer need to give AI providers your SSH passwords, private keys, Kubernetes tokens, or kubeconfig files to use NexusSSH's MCP tools.** NexusSSH keeps saved infrastructure credentials encrypted on your deployment. AI clients connect with scoped, expiring, revocable MCP tokens, and NexusSSH executes permitted operations on their behalf.

[![GitHub Actions](https://img.shields.io/badge/CI-GitHub_Actions-2088ff?style=flat-square&logo=githubactions&logoColor=white)](https://github.com/nooblk-98/nexusssh/actions/workflows/checks.yml)
[![Self-hosted](https://img.shields.io/badge/deployment-self--hosted-0f766e?style=flat-square)](#quick-start)
[![MCP support](https://img.shields.io/badge/MCP-supported-2563eb?style=flat-square)](#connect-ai-through-mcp)
[![Kubernetes support](https://img.shields.io/badge/Kubernetes-supported-6366f1?style=flat-square)](docs/KUBERNETES.md)

[Features](#what-you-can-do) · [Quick start](#quick-start) · [AI and MCP](#connect-ai-through-mcp) · [Documentation](#documentation)

## What you can do

| Area                       | Capabilities                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Centralized workspace**  | Organize SSH servers and Kubernetes clusters in nested folders. Use search, tags, favorites, recent connections, split views, and account workspace presets.                    |
| **Browser SSH**            | Open interactive terminals with pinned host keys, session resume, snippets, search, command suggestions, and broadcast input across selected sessions.                          |
| **Remote files**           | Browse SFTP, transfer files with progress and resumable uploads, and edit with Monaco. Preview changes, detect conflicting saves, and optionally retain encrypted file history. |
| **Kubernetes**             | Import kubeconfigs, choose contexts and namespaces, use cluster consoles, browse resources, view pod logs, and run supported commands or pod execution through MCP.             |
| **AI access through MCP**  | Give agents explicit server, cluster, and tool grants. Require human approval for arbitrary commands and mutations, revoke tokens, and review activity.                         |
| **Private infrastructure** | Reach targets through saved WireGuard profiles, an SSH bastion, or both. Use the same routes for browser sessions and permitted MCP operations.                                 |
| **Team access**            | Manage users, teams, operation grants, TOTP MFA and recovery codes, and optional generic OIDC sign-in.                                                                          |
| **Operations**             | Use versioned runbooks, staged connection diagnostics, dependency readiness checks, audit request references, and optional scheduled encrypted backups with restore rehearsal.  |

## Quick start

Requires Docker with Linux containers and Docker Compose **2.24.4 or newer**. The application builds inside Docker.

```sh
git clone https://github.com/nooblk-98/nexusssh.git
cd nexusssh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

1. Open [http://localhost:8080](http://localhost:8080).
2. Find the first-run setup token in `docker compose logs nexusssh`, then create your owner account. No default account password is shipped.
3. Add an SSH identity and server, or import a Kubernetes kubeconfig. Verify SSH fingerprints through a trusted server console before saving them.
4. Configure destination allowlists for your target networks, then test the connection. Select a WireGuard profile or bastion if the target needs one.
5. Open a terminal, SFTP session, or cluster console. Configure an agent when you are ready to connect an AI client.

The local override binds the application to loopback. Installation secrets are generated on first start and retained in the `nexusssh_secrets` volume; application records live in `nexusssh_data`.

> [!IMPORTANT]
> Back up your data and installation secrets. Losing the encryption key makes saved credentials unrecoverable. For a shared or internet-facing installation, configure HTTPS, a stable `APP_URL`, and explicit destination networks using the [deployment guide](docs/DEPLOYMENT.md).

## Connect AI through MCP

NexusSSH acts as the controlled execution layer between your AI client and your infrastructure. The client needs the NexusSSH endpoint and an agent token; it does not need direct SSH access or a copy of your kubeconfig.

1. Save and verify your infrastructure connections in NexusSSH.
2. Create an agent under **Settings → AI Agents**. Choose **Custom** to select its servers, clusters, and permitted tools.
3. Issue a token and configure it in a compatible remote HTTP MCP client:

   ```text
   Endpoint:       https://nexusssh.example.com/mcp
   Authorization:  Bearer <your-agent-token>
   ```

4. Use permitted tools to inspect infrastructure. Review requests that need human approval in **Settings → Approvals**, then let the requesting agent retry the exact approved operation.

For example, an authorized agent can inspect disk usage on a server, list Kubernetes resources, retrieve pod logs, or request approval to restart a service or run a supported cluster command. Scopes and resource grants still apply to every operation.

**Client compatibility:** use a client that supports remote HTTP MCP with bearer authentication. Clients requiring an OAuth consent flow cannot authenticate directly to this MCP release. Browser OIDC sign-in is separate from MCP authentication. See the [MCP client guide](docs/CLIENTS.md) for the tested SDK flow and compatibility details.

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

REST route documentation is available at `/api/docs` on your installation.

## Repository social card

<details>
<summary>Preview and download the social card</summary>

![NexusSSH social card — centralized web-based SSH and Kubernetes management with MCP support](docs/assets/nexusssh-social-card.png)

[Download PNG](docs/assets/nexusssh-social-card.png) · [Editable SVG](docs/assets/nexusssh-social-card.svg)

The PNG is **1280 × 640 pixels**, ready for repository link previews. To activate it on GitHub, upload it under **Settings → Social preview → Edit → Upload an image**, following [GitHub's social preview guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

</details>

---

Built by [Lahiru S Liyanage](https://github.com/nooblk-98) · [Release notes](CHANGELOG.md) · [License](LICENSE)
