# nexusssh-mcp

Adds a [NexusSSH](https://github.com/nooblk-98/nexusssh) MCP server to every AI client on your machine with one command.

```sh
npx -y nexusssh-mcp@latest --url https://nexusssh.example.com/mcp
```

The installer asks for an agent token without echoing it. It checks the token against the endpoint, lists the clients it finds, and writes the server into each one you pick. Copy the endpoint from **Settings → MCP Server** and create the token under **Settings → AI Agents**. Node.js 20 or newer is required.

## Supported clients

| Id                | Client            | Configuration written                                                          |
| ----------------- | ----------------- | ------------------------------------------------------------------------------ |
| `claude-code`     | Claude Code       | `claude mcp add --scope user`, or `~/.claude.json` when the CLI is not on PATH |
| `claude-desktop`  | Claude Desktop    | `claude_desktop_config.json`, through the bundled stdio bridge                 |
| `cursor`          | Cursor            | `~/.cursor/mcp.json`                                                           |
| `vscode`          | VS Code (Copilot) | User `mcp.json`                                                                |
| `vscode-insiders` | VS Code Insiders  | User `mcp.json`                                                                |
| `cline`           | Cline             | `cline_mcp_settings.json`                                                      |
| `windsurf`        | Windsurf          | `~/.codeium/windsurf/mcp_config.json`                                          |
| `gemini`          | Gemini CLI        | `~/.gemini/settings.json`                                                      |
| `codex`           | Codex             | `~/.codex/config.toml`                                                         |
| `opencode`        | opencode          | `~/.config/opencode/opencode.json`                                             |

Run `npx nexusssh-mcp list` to see where each file lives on your system and which clients were detected.

## Options

```text
--url <endpoint>   MCP endpoint, e.g. https://nexusssh.example.com/mcp
--token <token>    Agent token. Prompted when omitted; NEXUSSSH_TOKEN also works
--clients <ids>    Comma-separated client ids instead of every detected client
--name <name>      Server name in client configs (default: nexusssh)
--yes, -y          Configure every detected client without asking
--skip-verify      Do not test the token against the endpoint first
```

For unattended setup, provide the token through the environment rather than a flag, which would land in your shell history:

```sh
NEXUSSSH_TOKEN=... npx -y nexusssh-mcp@latest --url https://nexusssh.example.com/mcp --yes
```

To remove the server from every client again, run `npx nexusssh-mcp uninstall`.

## What it changes

- Before it edits an existing file, the installer saves the original next to it as `<file>.nexusssh.bak`. It replaces only the entry with the chosen name and leaves your other servers alone.
- Comments in JSONC files (VS Code, opencode) are not preserved when the file is rewritten. The backup keeps them.
- The token is stored in plain text in each client's configuration, the same as a hand-written entry. New files are created readable only by you. Revoke the token under **Settings → AI Agents** if the machine is lost or shared.
- Claude Desktop starts local servers only, so its entry runs `npx nexusssh-mcp@<version> bridge`. The bridge relays stdio to the HTTP endpoint and reads the token from `NEXUSSSH_TOKEN` in that entry.
