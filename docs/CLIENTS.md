# Remote MCP clients

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

## Approvals

Call a permitted mutation. The result supplies `status: approval_required` and an approval UUID. A human reviews the exact arguments in the web UI and approves or rejects. Poll `approval_get_status` with that UUID, then retry the identical operation with `approvalId`. The original principal must retry. Concurrent or subsequent replays fail.

Use `async: true` for a queued operation; poll `task_status` with the task UUID. `task_cancel` closes execution when the worker observes cancellation. This is an application-level polling API, not a claim to implement deprecated MCP protocol task semantics.

## Product-specific clients

Cursor and VS Code versions that support remote HTTP endpoints with custom Authorization headers can use this machine-token flow. Verify the exact configuration syntax in the client version you install; no product-specific configuration has been certified in this environment. Use a secret input or protected environment variable rather than committing a token to repository configuration.

Claude-compatible clients differ by product and version. A client that requires a hosted OAuth consent flow and cannot send a machine bearer token cannot authenticate to this release directly.

ChatGPT remote MCP integrations are likewise not certified by these tests. Do not assume they accept arbitrary machine-token headers. If the selected product requires OAuth, an appropriate OAuth resource-server integration and issuer deployment must be implemented and tested first.

SDK implementation references: [official v2 protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) and [official SDK source](https://github.com/modelcontextprotocol/typescript-sdk). Installing v2 alone does not enable the modern era; this project uses `createMcpHandler` explicitly.
