# Architecture

Browser → built-in gateway (`infrastructure/scripts/start.mjs`) → Next.js / NestJS API / MCP gateway, all processes in the single `nexusssh` container. MCP forwards authenticated operations to the API. The API resolves the principal, checks organization/server grants, normalizes arguments and queues authorized SSH operations without human approval. Kubernetes commands also execute directly after authorization. It writes task metadata to SQLite and enqueues only a task UUID in Redis. A worker claims that task through the internal API, rechecks current principal authorization, receives an in-memory SSH configuration, and executes through `ssh-core`.

The worker returns bounded transient results through BullMQ. Persistent execution records contain metadata and argument digests, not raw stdout or terminal transcripts. Kubernetes results are encrypted with bounded retention. Redis persistence is disabled and finished jobs expire within one hour or the configured count bound.

Interactive terminals use browser WebSocket → API → shared SSH core → remote PTY. Authentication and authorization are checked before upgrade and periodically during the session. Idle deadlines, maximum session count, frame and output limits close abusive or stalled connections. Detached shells can resume with a browser-bound token for up to two minutes; explicit close ends them. Account presets contain layout metadata and start new connections without copying resume tokens.

The API is the sole owner of the SQLite named volume. WAL and busy timeout support controlled concurrent requests in that one process. Do not scale the API horizontally against this file. MCP and workers authenticate to API endpoints; The gateway blocks `/api/internal/` externally; MCP and workers reach the API over loopback. Deploy on local storage, not NFS.

Kubernetes commands execute immediately after scope and cluster-grant authorization. Access is rechecked before execution and before returning results. Every repeated request starts a new execution; interrupted commands are not automatically retried.

The MCP gateway uses `createMcpHandler`, which explicitly serves the 2026-07-28 per-request era and the separate legacy stateless path. It does not invent modern session IDs or silently mix session models. SSH connections exposed through MCP are operation-scoped; `ssh_connect` verifies a connection and closes it. It does not promise a persistent command shell.
