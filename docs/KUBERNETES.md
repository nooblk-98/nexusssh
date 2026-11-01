# Kubernetes cluster connections

Workspace owners and administrators can open **Kubernetes** from the main menu
or Settings. Import a kubeconfig to connect directly from the NexusSSH API
process to a Kubernetes HTTPS API. No SSH server or local `kubectl` installation
is required for this connection method.

## Import a cluster

1. Open Kubernetes and choose **Add cluster**.
2. Enter a display name, then upload a YAML/JSON kubeconfig or paste its contents.
   Files are limited to 256 KB.
3. Choose the context to save. File imports read available contexts automatically;
   after pasting, use **Read contexts**. Each saved profile represents one context.
4. Save the profile and use **Test connection** to verify the API endpoint and
   read its Kubernetes version. Resource permissions are checked by Kubernetes
   when each resource is requested.

Supported credentials are an embedded bearer `token` or embedded
`client-certificate-data` plus `client-key-data`. An optional
`certificate-authority-data` bundle is used for TLS trust; otherwise the host's
standard trusted certificate authorities apply. `tls-server-name` and API base
paths, such as a cluster gateway's HTTPS path, are supported.

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
Redirects are rejected. Existing per-server SSH VPN/bastion selections do not
route these direct API connections; use a network route available to the
NexusSSH host.

## Resource browsing and logs

The resource selector includes pods, deployments, StatefulSets, DaemonSets,
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
256 KB. Secret objects, workload writes, pod exec, and port forwarding are not
exposed by this first version. The existing SSH-based `kubernetes_get` MCP tool
remains separate; direct profiles are limited to human workspace administrators.

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

The API allows four concurrent outbound Kubernetes reads per workspace and
120 requests per minute per client IP on the Kubernetes routes. Outbound reads
have a 15-second deadline, and JSON responses are limited to 2 MB. Import,
update, removal, connection checks, resource reads, and log reads are audited
without recording credential contents or log output.
