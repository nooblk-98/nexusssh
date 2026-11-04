# Remote MCP clients

## One-command install

On the computer where your AI clients run (Node.js 20 or newer):

```sh
npx -y nexusssh-mcp@latest --url https://nexusssh.example.com/mcp
```

The installer prompts for the agent token without echoing it and verifies it with an MCP `initialize` request. It then writes the server into each detected client: Claude Code (through `claude mcp add --scope user` when the CLI is installed), Claude Desktop, Cursor, VS Code, VS Code Insiders, Cline, Windsurf, Gemini CLI, Codex, and opencode. Before it changes a file, it saves the original as `<file>.nexusssh.bak`. `npx nexusssh-mcp list` shows each client's configuration path, and `npx nexusssh-mcp uninstall` removes the entries again. The [installer README](../apps/mcp/installer/README.md) lists every option.

Claude Desktop starts only local stdio servers from its configuration file. Its entry runs `npx nexusssh-mcp@<version> bridge`, which relays newline-delimited JSON-RPC to this endpoint over the legacy stateless transport. The bridge reads the token from `NEXUSSSH_TOKEN` in that entry.

## Tested client

The verified client is the official TypeScript client v2 over real HTTP sockets, in both `versionNegotiation: { mode: 'auto' }` (modern 2026-07-28) and `mode: 'legacy'` (stateless legacy). This server uses scoped machine bearer credentials. It does not implement an OAuth authorization server, dynamic client registration or browser consent redirects.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client(
  { name: 'nexus-client', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(new StreamableHTTPClientTransport(
  new URL(process.env.NEXUS_MCP_URL!),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.NEXUS_AGENT_TOKEN}` } } },
));
const servers = await client.callTool({ name: 'servers_list', arguments: {} });
console.log(servers);
await client.close();
```

No SSH executable, SSH key or access to the target's SSH port is required on the client. Only the NexusSSH HTTPS endpoint and a supported bearer credential are needed.

## SSH execution and Kubernetes approvals

SSH commands (including `ssh_execute_many`) and file/service mutations execute immediately within the caller’s grants and token scopes. No `approvalId` is needed. A legacy SSH `approvalId` is accepted but ignored; it never changes the execution principal. Each repeated request is a new execution, not an approval replay. Do not automatically retry side effects after uncertain results.

For Kubernetes commands, call a permitted command. The result supplies `status: approval_required` and an approval UUID. A human reviews the exact arguments in the web UI and approves or rejects. Poll `approval_get_status` with that UUID, then retry the identical operation with `approvalId`. The original principal must retry. Concurrent or subsequent replays fail.

Use `async: true` for a queued operation; poll `task_status` with the task UUID. `task_cancel` closes execution when the worker observes cancellation. This is an application-level polling API, not a claim to implement deprecated MCP protocol task semantics.

## Product-specific clients

The installer writes each client's documented user-level format for remote HTTP servers with a custom `Authorization` header. Claude Code's entry has been checked to connect. The other formats follow each product's documentation and can change between versions, so if a client does not list the server, compare its entry with that client's current documentation. Keep tokens in user-level configuration rather than committing them to repository configuration.

A client that requires a hosted OAuth consent flow and cannot send a machine bearer token or launch a local stdio server cannot authenticate to this release directly.

ChatGPT remote MCP integrations are likewise not certified by these tests. Do not assume they accept arbitrary machine-token headers. If the selected product requires OAuth, an appropriate OAuth resource-server integration and issuer deployment must be implemented and tested first.

SDK implementation references: [official v2 protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) and [official SDK source](https://github.com/modelcontextprotocol/typescript-sdk). Installing v2 alone does not enable the modern era; this project uses `createMcpHandler` explicitly.
