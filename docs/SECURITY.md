# Security boundaries

This application holds credentials and can issue remote commands. Automated tests cover important boundaries, but an independent security review is still required before sensitive production use.

## Identities and access

SSH credentials use AES-256-GCM with a random nonce and organization/identity-bound authenticated context. The master key is supplied outside SQLite. Agent tokens and browser sessions are random opaque values, stored only as SHA-256 hashes. Agent metadata binds issuer, audience, expiry, scopes, organization and active identity. Browser passwords use bcrypt cost 12. TOTP code reuse is rejected atomically.

MCP agents have two roles: **Administrator** automatically receives all MCP tools, workspace management, and access to all current and future servers and Kubernetes clusters in its workspace; **Custom** uses selected server/cluster tool grants and an optional workspace-management group. Both roles still require exact human command approvals and cannot export saved SSH credentials or kubeconfigs. Full Administrator agents require an enabled human owner with owner/administrator role. Role changes, token expiry/revocation and call budgets are enforced on requests and queued execution. Browser user roles remain separate: owners/administrators manage the organization, operators/viewers require server grants, and viewers cannot execute writes or open arbitrary shells. Credentials may be submitted once through an authenticated TLS form, but are never returned to the browser or stored in browser storage.

Agent shell commands and file/service mutations require an exact human approval. This is deliberately broader than a keyword blacklist. Interactive browser terminals and SFTP use the signed-in user's operation grants; terminal access permits arbitrary actions allowed by the remote account. Do not grant terminals to identities that should be restricted to read-only diagnostics.

## Remote execution

Use dedicated non-root SSH identities with restricted filesystem permissions, no unrestricted sudo and appropriate forced commands/chroots where practical. Read-only diagnostic grants do not make an overprivileged remote account safe. Remote Docker group membership is effectively privileged host access.

Destinations are resolved against an explicit CIDR allowlist and the selected address is pinned for the connection, including a bastion's destination. Unknown or changed host keys fail closed. Host fingerprints must be verified out of band. No public tunnel/proxy tool exists.

File paths reject traversal and resolve real paths/parents within the configured root. Final symlinks are refused for writes. Replacement first attempts OpenSSH POSIX rename, then standard SFTP rename. Servers may refuse overwrites through the standard operation; a failed replacement leaves the old destination intact. SFTP cannot eliminate all filesystem race conditions if an adversary can change directories concurrently. Use an OS-enforced chroot/restricted account for strong containment. Never put credential files or secrets inside an agent-readable root.

Remote output, logs and file contents are untrusted data. Credential-value and common secret-pattern redaction is defense in depth, not a guarantee that arbitrary command output or base64 file content contains no secrets. OS permissions and explicit grants are the primary boundary. Do not feed remote text into trusted assistant instructions. There is no embedded LLM that bypasses these APIs.

Cancellation and timeouts close the SSH channel/connection. Detached processes and remote process descendants can outlive a channel; NexusSSH does not claim reliable process-tree termination. API jobs expire, workers do not automatically retry side effects, and approval consumption is never rolled back after failure.

## Deployment

Only the `nexusssh` gateway port is published in the production Compose configuration. The API, web, MCP and worker processes listen on container-internal ports; do not publish Redis. Keep the Compose network trusted, use host/firewall egress rules in addition to the application allowlist, and limit access to the Docker host. Internal services currently use a shared internal credential on the private network, not mTLS.

TLS termination (your reverse proxy) and encryption keys are deployment responsibilities. Production requires HTTPS. The development override binds only loopback HTTP. Never expose the development override publicly.

MFA enrollment issues ten single-use recovery codes; only their hashes are stored. Users can regenerate them or disable MFA after confirming their current password and MFA. Generic OIDC supports explicit administrator mappings to existing users; it does not automatically link emails or assign roles, and enabled local MFA remains required. Keep a local owner account for recovery. No email-reset flow is implemented. Back up encrypted SQLite data and retain encryption and backup keys in separately protected locations. See [operations](OPERATIONS.md) for SSO, file-history and backup controls.
