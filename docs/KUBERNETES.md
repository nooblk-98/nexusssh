# Kubernetes cluster connections

Workspace owners and administrators can open **Kubernetes** from the main menu
or Settings. Import a kubeconfig to connect directly from the NexusSSH API
process to a Kubernetes HTTPS API. Direct connections require no SSH server or
local `kubectl`. Saved WireGuard VPN and SSH bastion routes are also supported.

## Import a cluster

1. Open Kubernetes and choose **Add cluster**.
2. Enter a display name, then upload a YAML/JSON kubeconfig or paste its contents.
   Files are limited to 256 KB.
3. Choose the context to save. File imports read available contexts automatically;
   after pasting, use **Read contexts**. Each saved profile represents one context.
4. Save the profile and choose **Open console**, or click its entry in the main
   sidebar. The console verifies the API connection and shows its Kubernetes
   version. Resource permissions are checked by Kubernetes for each command.

Choose an optional **WireGuard VPN** and/or **SSH bastion** in the cluster form.
These selections can be changed later without uploading the kubeconfig again.

Choose **Folder** to organize a cluster alongside SSH servers in the existing
nested folder tree. You can create folders/subfolders from the sidebar, drag a
cluster into a folder, or use its **Move to…** action. A folder's **New Kubernetes
cluster** action preselects that folder. Search matches cluster names, contexts
and folder paths; matching entries are revealed inside collapsed folders.
Deleting a folder moves its direct clusters to the top level without deleting
connections or credentials. Folder assignment only organizes the cluster; its
VPN/bastion selection, command approvals and MCP grants remain the same.
SSH folder defaults do not apply to cluster connections. MCP cluster creation
accepts an optional `groupId` from the same workspace, and cluster discovery
includes that non-secret folder ID.

Supported credentials are an embedded bearer `token` or embedded
`client-certificate-data` plus `client-key-data`. An optional
`certificate-authority-data` bundle is used for TLS trust; otherwise the host's
standard trusted certificate authorities apply. `tls-server-name` and API base
paths, such as a cluster gateway's HTTPS path, are supported.

Rancher-exported kubeconfigs with `access-key:secret-key` bearer tokens and
`/k8s/clusters/...` gateway paths are supported. Import the token unchanged;
do not remove its colon. Tokens cannot contain spaces, line breaks or header
control characters.

TLS verification is always enabled. External login commands (`exec`), auth
providers, local credential/CA paths, proxy URLs, basic authentication, and
impersonation are rejected. These features can run programs, read files, or
change routing in a conventional kubeconfig client; NexusSSH does not execute
them. See the [Kubernetes kubeconfig reference](https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/).

To embed an existing context's certificate files, export it on a trusted machine:

```sh
kubectl config view --raw --minify --flatten > nexusssh-kubeconfig.yaml
```

This does not convert an external cloud login plugin into a static token.
For those contexts, provide a restricted service-account token or a client
certificate instead. Token expiration is handled by replacing the kubeconfig.

## Network access

The API endpoint must be reachable from the NexusSSH deployment, with its IP
addresses included in `KUBERNETES_ALLOWED_CIDRS`. This is a separate setting from
the SSH destination allowlist and defaults to RFC 1918 private networks:

```dotenv
KUBERNETES_ALLOWED_CIDRS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

Narrow the ranges to your cluster endpoints. For a public managed API, add its
approved address ranges and allow the NexusSSH host through the cluster's
network access controls. Recreate the application container after changing the
setting. The Compose file passes this variable to the application.

Every DNS result is checked, and the selected address is pinned for the HTTPS
connection. Cloud metadata addresses remain blocked regardless of the allowlist.
Redirects are rejected. Set a saved route on each cluster profile:

- No selections: connect directly from the NexusSSH host.
- WireGuard only: reach the API through the selected saved VPN profile.
- SSH bastion only: forward the API connection through one saved SSH server.
- Both: reach the SSH bastion through WireGuard, then forward to the API.

When no cluster VPN is selected, a selected bastion's effective VPN is inherited,
including folder/tag defaults. Conflicting cluster/bastion VPNs and nested
bastion hops are rejected. The bastion must be active, in the same workspace,
and have a verified SSH host fingerprint. Configure and verify it through the
SSH server screen before using it as a jump host. Its saved SSH identity and
effective username are reused internally; no SSH credentials are returned.

The API destination must pass `KUBERNETES_ALLOWED_CIDRS` on every route. Bastion
SSH connections separately obey the deployment/workspace SSH allowlist. When a
VPN has DNS servers, hostnames are resolved through its gateway; otherwise
NexusSSH's DNS is used. If that lookup fails or returns addresses outside the
Kubernetes allowlist, a selected bastion can resolve the hostname instead. This
uses a fixed, bounded `getent ahosts` lookup on the authenticated jump host;
`getent` must be available there. Every address from the selected resolver must
pass the allowlist before a numeric IP is forwarded. Metadata destinations are
always blocked. The original API Host/SNI, CA trust and client certificates are
preserved inside the tunnel. Failed routes never fall back to a direct connection.

All profile checks, UI resource/log reads, MCP commands and pod WebSockets share
this routing. VPN profile deletion is blocked while a cluster references it.

Connection errors identify the failing stage: gateway setup/authentication,
hostname lookup, destination allowlist, bastion authentication/forwarding, or
WireGuard reachability. A working SSH connection does not establish that the
Kubernetes API address is allowed or reachable. Check both
`KUBERNETES_ALLOWED_CIDRS` and the VPN peer's `AllowedIPs`. For WireGuard without
a bastion, private hostnames need working DNS servers in the VPN profile, with
those servers reachable through the VPN. Namespace discovery errors only suggest
an identity permission issue when the API returns HTTP 403.

## Cluster command console

**Open console** opens a workspace terminal tab alongside SSH terminals. Type
`kubectl get nodes`, `kubectl get pods -A`, or `help`. Each tab remembers its
selected namespace. Switch it with
`kubectl config set-context --current --namespace=apps`; this changes only the
current console tab's default. `-n` overrides that default for one command. Up/Down recalls
commands during the current visit. Reloading restores the tab and namespace,
but command history/output are not stored in browser storage or replayed.

Supported commands are `version`, `get`, `describe`, `logs`, `scale`,
`rollout restart`, `delete`, `patch`, and `apply -f -`, using the same bounded
command vocabulary as MCP below. `get` displays Kubernetes table output when
available; use `-o json` or `-o yaml` for structured output. Lists have up to
100 results; use the returned continuation cursor with `--continue` to page.
Logs are bounded snapshots. Streaming/watch, interactive pod shells, shell
pipelines, local files/plugins and credential overrides are not supported.
This is a cluster command console, not a shell on the NexusSSH host.

For `kubectl apply -f -`, paste one manifest and press Ctrl+D. Ctrl+C cancels
manifest input or stops waiting for a running command. Cancelling a request
does not prove a remote change was undone; inspect the cluster before retrying.
Each command runs at most 60 seconds and returns at most 256 KB of console
output. Closing the tab aborts its request; commands never retry automatically.

Only signed-in workspace owners/administrators can use the browser console.
Commands use the saved encrypted connection and its WireGuard/bastion route,
with the same destination and TLS checks. Running commands prevent connection
or credential changes. Command outcomes are audited without storing the
entered command or its output. MCP agents use `kubernetes_execute` and
`kubernetes_pod_exec` with explicit grants or Administrator access and the
existing single-use human approval flow; they cannot use the browser endpoint
to bypass approvals or retrieve saved credentials.

## Optional resource browsing and logs

Choose **Browse resources** on a cluster profile to open the optional resource
view. The selector includes pods, deployments, StatefulSets, DaemonSets,
services, nodes, and namespaces. Apply a namespace or `*` for all namespaces.
Nodes and namespaces are cluster-scoped. Namespace discovery is optional: if
the supplied identity cannot list namespaces, enter an allowed namespace manually.

Resource lists show up to 100 objects per page, with Previous/Next controls.
Refresh a list to see changes. Expired Kubernetes continuation tokens require a
fresh first page. Resource summaries include status, readiness, node/image or
service details, restarts, and age; raw pod specifications and environment
variables are not returned.

For a pod, open its log action and choose a regular or init container. Logs are
snapshots rather than a continuous stream: select 100-1,000 lines, optionally
select the previous container instance, and refresh. Output is limited to
256 KB. The browsing screen shows resource summaries and logs. Direct MCP
commands and container execution are available through explicitly granted agent
tools below. The existing SSH-based `kubernetes_get` tool remains separate.
Port forwarding and interactive container terminals are not supported.

## Permissions, storage, and limits

Kubernetes RBAC on the uploaded identity still applies. Grant only the access
needed for these reads:

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "nodes", "namespaces"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list"]
```

These are RBAC rules to add to a Role or ClusterRole, not a complete manifest.
A namespace-scoped Role does not grant node or namespace discovery; those views
can return a permission error while permitted namespaced resources still work.

Selected connection credentials are encrypted using the existing application
key, bound to the workspace and profile ID. Unused contexts are not saved.
Listing or editing a profile never returns its stored token, certificates, or
private key. Editing a name/description preserves credentials; upload a new
kubeconfig to rotate them or change contexts. Removing a profile deletes the
saved connection and does not delete anything in Kubernetes.

Profiles and encrypted credentials are part of the SQLite backup. Preserve the
matching application secrets volume as described in [deployment and recovery](DEPLOYMENT.md).
The schema migration adds a cluster-profile table and preserves existing records.

The API allows four concurrent outbound Kubernetes requests per workspace, shared
by the administration screen and MCP, and
120 requests per minute per client IP on the Kubernetes routes. Outbound reads
have a 15-second deadline, and JSON responses are limited to 2 MB. Import,
update, removal, connection checks, resource reads, and log reads are audited
without recording credential contents or log output.

## Direct Kubernetes MCP tools

1. Import the cluster in **Kubernetes**.
2. Open **AI Agents**, register an agent or edit **Access**. Choose
   **Administrator** for all current/future clusters, servers and MCP tools.
   Choose **Custom** to select individual **Kubernetes clusters** and
   **Kubernetes tools**, separately from SSH grants. Existing tokens receive
   updated access immediately. Custom workspace-management access alone does
   not grant cluster execution; a human administrator or full Administrator
   agent assigns Custom cluster/tool grants.
3. Connect the agent token to the existing MCP endpoint. Refresh your client's
   tool list if it was connected before the deployment.

Agents with explicit **Workspace management** access can also submit a new
profile using `kubernetes_cluster_create`. Supply `name`, YAML/JSON `kubeconfig`
text, optional `context`/`description`, and optional saved `vpnProfileId` and
`bastionId`. These IDs must belong to the same workspace. This is a write-only
credential submission: the result contains profile metadata, never the saved
kubeconfig, token, certificate, private key or encrypted credential. Creation
does not automatically grant Custom agents access to that cluster. Full
Administrator agents have automatic access, including newly imported clusters.
Human administrators or full Administrator agents assign Custom grants.

SSH `identity_create` similarly accepts a supplied private key/passphrase or
password and returns only identity metadata. Identity lists contain IDs, names,
kinds and usage counts. MCP has no credential-retrieval or export tool. Agents
can use granted connections without receiving the saved connection credentials.

| Tool | Purpose |
| --- | --- |
| `kubernetes_clusters_list` | List explicitly granted cluster IDs and non-secret metadata. |
| `kubernetes_cluster_check` | Check the saved cluster's Kubernetes version. |
| `kubernetes_resources_list` | Read a summarized resource page; pass `nextCursor` as `cursor` to continue. Omit namespace to use the saved default or use `*` for all namespaces. |
| `kubernetes_pod_logs` | Read bounded current/previous logs for one namespace, pod and container. |
| `kubernetes_execute` | Request an approved kubectl-style command using an argv array. |
| `kubernetes_pod_exec` | Request an approved command inside one named pod and container. |
| `kubernetes_execution_status` | Retrieve your command execution's status and encrypted saved result. |

For Custom agents, each tool requires both its token scope and a grant on the
selected cluster. Administrator automatically enables all tools and clusters. Grant `kubernetes_clusters_list` for
discovery and `kubernetes_execution_status` for later result retrieval, alongside
the desired command tools. Kubernetes RBAC on the uploaded identity still applies.

### Approval and results

Both command tools always require a human approval, including `get` commands.
Call the tool without `approvalId` first. It returns `approval_required`, an
`approvalId`, and an expiry. An administrator reviews the exact cluster,
namespace, argv, container, timeout and optional inline manifest in **Approvals**
and approves or rejects the request. Poll `approval_get_status` with that ID,
then repeat the original tool call with identical arguments plus `approvalId`.
The requester resumes execution; the approval screen does not run the command
under another user's identity.

Approvals last 10 minutes, are single use, and are bound to the original token,
workspace, cluster credentials, saved route, operation and exact arguments. A changed command,
rotated kubeconfig, VPN or bastion credentials, changed route or host fingerprint,
revoked token/grant, expired approval or consumed approval
cannot be used. The app never automatically retries a command.

Executions return an `executionId`, status and result. Results are encrypted at
rest and available to the requesting principal/token for one hour while its
grants remain valid. Arguments are encrypted in approval records; audit events
and agent activity contain metadata rather than output or credentials. Expired
output is removed by hourly maintenance; metadata uses `AUDIT_RETENTION_DAYS`.
Pending executions after an API restart become `interrupted` and are not replayed.

### kubectl-style command reference

`kubernetes_execute` accepts `clusterId`, a `command` argv array, optional
`namespace`, optional inline `manifest`, and `timeoutMs` (1–60 seconds, default
30 seconds). A leading `kubectl` is optional. The implementation translates a
bounded command vocabulary into verified HTTPS API requests; it does not start a
local shell or install a kubectl executable.

| Command argv | Behavior |
| --- | --- |
| `["kubectl", "version"]` | Kubernetes server version through the saved cluster route. |
| `["get", "pods", "-n", "apps"]` | JSON resource list, up to 100 objects with Kubernetes continuation metadata. |
| `["get", "deploy/api", "-o", "json"]` | One raw resource. `json` and `yaml` flags are accepted; output is always JSON. |
| `["describe", "pod/api-1", "-n", "apps"]` | Raw JSON inspection of that resource; no kubectl events/text rendering. |
| `["logs", "api-1", "-c", "api", "--tail=200", "--previous"]` | Bounded log snapshot, at most 1,000 lines and 256 KB. |
| `["scale", "deploy/api", "--replicas=3"]` | Patch a deployment or StatefulSet scale subresource. |
| `["rollout", "restart", "deploy/api"]` | Restart a deployment, StatefulSet or DaemonSet through its pod template annotation. |
| `["delete", "pod/api-1"]` | Delete one named resource with background propagation. |
| `["patch", "deploy/api", "--type=merge", "-p", "{\"spec\":{\"replicas\":2}}"]` | Inline JSON patch; types `merge`, `json` and `strategic` are supported. |
| `["apply", "-f", "-"]` | Server-side apply of one inline YAML/JSON `manifest`, with `metadata.name` and a supported `apiVersion`/`kind`. |

Supported resource types are pods, deployments, StatefulSets, DaemonSets,
services, nodes, namespaces, ConfigMaps, Secrets, PVCs, Jobs, CronJobs and
Ingresses, with common singular names and short aliases. Read list flags include
`-A`/`--all-namespaces`, `-l`/`--selector`, `--field-selector`, and `--continue`.
Choose a namespace with `-n`/`--namespace` or the separate `namespace` field;
conflicting selections are rejected. JSON responses have a 2 MB bound.

This subset does not accept plugins, kubeconfig/server/token/context overrides,
local files, remote manifest URLs, arbitrary API paths, kustomize, watch/follow,
multi-document manifests, CRDs, bulk deletes, port forwarding or interactive
terminal flags. Granting the command tool can expose raw resource content,
including Secrets when the cluster identity permits them; each exact command
still requires human approval. Use the summarized read tools for routine browsing.

### Commands inside pods

Example `kubernetes_pod_exec` arguments:

```json
{
  "clusterId": "<saved-cluster-id>",
  "namespace": "apps",
  "pod": "api-1",
  "container": "api",
  "command": ["sh", "-lc", "id && uname -a"],
  "timeoutMs": 30000
}
```

The command runs inside the selected container. Shell operators are interpreted
only when you explicitly call an installed shell, as in that example. There is
no stdin or TTY. Results include `stdout`, `stderr`, `exitCode` and `truncated`;
combined output is limited to 256 KB. A nonzero exit code is a completed remote
command; `interrupted` means the remote outcome may be unknown. Timeout or client
disconnect closes the connection but may leave remote processes running. Inspect
the pod before retrying.

Pod exec needs a Kubernetes API/gateway that supports WebSocket remote commands
(`v5.channel.k8s.io` or `v4.channel.k8s.io`). There is no legacy SPDY fallback.
The gateway must pass through WebSocket upgrades on the API base path. Grant
`get` and `create` on `pods/exec` in the required namespaces; authorization varies
with Kubernetes version and feature gates. See the official
[streaming protocol transition](https://kubernetes.io/blog/2024/08/20/websockets-transition/)
and [WebSocket authorization design](https://www.kubernetes.dev/resources/keps/4006/).
Workload commands also need their corresponding `patch`/`delete` permissions,
including `deployments/scale` or `statefulsets/scale` for scaling and `patch` plus
`create` for server-side apply. Scope these grants to the namespaces and resources
the agent should operate on.

Changing a cluster's connection route, replacing credentials or removing a profile is blocked while a command
is running. Wait for its bounded execution to finish. The four-request workspace
concurrency limit also applies to commands.
