"use client";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  FileText,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  api,
  notify,
  queryClient,
  timeAgo,
  useApi,
  type Row,
} from "../../lib/api";
import { useServers } from "../../lib/servers";
import {
  resources,
  type Resource,
  type ResourceSummary,
} from "../../../../packages/kubernetes/resources";
import {
  Button,
  Check,
  Drawer,
  Empty,
  Field,
  IconButton,
  confirmDialog,
} from "../ui";
import { PageHead } from "./page-head";
import { useKubernetesImport } from "../../lib/kubernetes-navigation";

type Cluster = {
  id: string;
  name: string;
  description: string;
  server: string;
  context: string;
  namespace: string;
  authentication: string;
  vpnProfileId: string | null;
  bastionId: string | null;
  status: string;
  version: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};
type ContextPreview = {
  name: string;
  server?: string;
  namespace?: string;
  authentication?: string;
  error?: string;
};
type ResourcePage = { items: ResourceSummary[]; nextCursor: string | null };
const labels: Record<Resource, string> = {
  pods: "Pods",
  deployments: "Deployments",
  statefulsets: "StatefulSets",
  daemonsets: "DaemonSets",
  services: "Services",
  nodes: "Nodes",
  namespaces: "Namespaces",
};
const refreshClusters = () =>
  queryClient.invalidateQueries({
    predicate: (query) => String(query.queryKey[0]).startsWith("kubernetes/"),
  });
const statusColor = (status: string) =>
  ["connected", "Ready", "Running", "Active", "Succeeded"].includes(status)
    ? "green"
    : [
          "error",
          "NotReady",
          "Failed",
          "CrashLoopBackOff",
          "ImagePullBackOff",
        ].includes(status)
      ? "red"
      : "blue";

function ClusterForm({
  cluster,
  onClose,
  onSaved,
}: {
  cluster?: Cluster;
  onClose: () => void;
  onSaved: (cluster: Cluster) => void;
}) {
  const [name, setName] = useState(cluster?.name || "");
  const [description, setDescription] = useState(cluster?.description || "");
  const vpns = useApi<Row[]>("vpn-profiles");
  const { servers } = useServers();
  const [vpnProfileId, setVpnProfileId] = useState(cluster?.vpnProfileId || "");
  const [bastionId, setBastionId] = useState(cluster?.bastionId || "");
  const [kubeconfig, setKubeconfig] = useState("");
  const [context, setContext] = useState("");
  const [contexts, setContexts] = useState<ContextPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preview = async (source: string) => {
    setBusy(true);
    setError("");
    setContexts([]);
    setContext("");
    try {
      const data = await api<{
        currentContext: string;
        contexts: ContextPreview[];
      }>("kubernetes/contexts", { kubeconfig: source });
      setContexts(data.contexts);
      const selected =
        data.contexts.find(
          (entry) => entry.name === data.currentContext && !entry.error,
        ) || data.contexts.find((entry) => !entry.error);
      setContext(selected?.name || "");
      if (!selected) {
        const reasons = [
          ...new Set(
            data.contexts.flatMap((entry) =>
              entry.error ? [entry.error] : [],
            ),
          ),
        ];
        setError(
          reasons.length === 1
            ? `No supported contexts were found: ${reasons[0]}`
            : "No supported contexts were found. Review the context errors below.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Cluster>(
        cluster ? `kubernetes/clusters/${cluster.id}` : "kubernetes/clusters",
        {
          name,
          description,
          vpnProfileId: vpnProfileId || null,
          bastionId: bastionId || null,
          ...(kubeconfig.trim()
            ? { kubeconfig, ...(context ? { context } : {}) }
            : {}),
        },
        cluster ? "PATCH" : "POST",
      );
      await refreshClusters();
      onSaved(result);
      notify.success("Kubernetes cluster saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={cluster ? "Edit Kubernetes cluster" : "Add Kubernetes cluster"}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !name.trim() ||
              (!cluster && !kubeconfig.trim()) ||
              (!!contexts.length && !context)
            }
            onClick={() => void save()}
          >
            {busy ? "Working…" : "Save cluster"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="alert danger" role="alert">
          {error}
        </div>
      )}
      <Field label="Cluster name" required>
        <input
          autoFocus
          className="input"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Description">
        <input
          className="input"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="grid-2">
        <Field
          label="WireGuard VPN"
          hint="Use a saved VPN profile, or inherit the bastion's VPN when none is selected."
        >
          <select
            className="select"
            value={vpnProfileId}
            onChange={(event) => setVpnProfileId(event.target.value)}
            disabled={busy || vpns.isPending || !!vpns.error}
          >
            <option value="">None / inherit from bastion</option>
            {(vpns.data || []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
            {vpnProfileId &&
              !vpns.data?.some((profile) => profile.id === vpnProfileId) && (
                <option value={vpnProfileId}>Unavailable saved VPN</option>
              )}
          </select>
        </Field>
        <Field
          label="SSH bastion"
          hint="One jump through a saved SSH server. Verify its SSH host key first."
        >
          <select
            className="select"
            value={bastionId}
            onChange={(event) => setBastionId(event.target.value)}
            disabled={busy}
          >
            <option value="">None — connect directly or through VPN</option>
            {servers
              .filter((server) => !server.bastionId)
              .map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                  {!server.fingerprint ? " (host key not verified)" : ""}
                </option>
              ))}
            {bastionId &&
              !servers.some(
                (server) => server.id === bastionId && !server.bastionId,
              ) && <option value={bastionId}>Unavailable saved bastion</option>}
          </select>
        </Field>
      </div>
      {vpns.error && (
        <p className="error-text">
          Could not load saved VPN profiles. You can keep the existing selection
          or retry.
        </p>
      )}
      <Field
        label="Import kubeconfig"
        hint={
          cluster
            ? "Upload a replacement to rotate credentials or change context. Leave blank to keep the saved connection."
            : "Choose a YAML or JSON kubeconfig, up to 256 KB."
        }
      >
        <input
          className="vpn-file-input"
          type="file"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setKubeconfig("");
            setContexts([]);
            setContext("");
            if (file.size > 256 * 1024) {
              setError("Choose a kubeconfig smaller than 256 KB.");
              return;
            }
            try {
              const source = await file.text();
              setKubeconfig(source);
              await preview(source);
            } catch {
              setError("Could not read that file.");
            }
          }}
        />
      </Field>
      <Field
        label="Kubeconfig contents"
        hint="Stored encrypted. Saved tokens, keys, and certificates are never shown again."
      >
        <textarea
          className="textarea mono"
          rows={8}
          spellCheck={false}
          disabled={busy}
          maxLength={256 * 1024}
          value={kubeconfig}
          onChange={(event) => {
            setKubeconfig(event.target.value);
            setContext("");
            setContexts([]);
          }}
        />
      </Field>
      <Button
        variant="outline"
        disabled={busy || !kubeconfig.trim()}
        onClick={() => void preview(kubeconfig)}
      >
        Read contexts
      </Button>
      {!!contexts.length && (
        <Field
          label="Kubernetes context"
          hint={contexts.find((entry) => entry.name === context)?.server}
        >
          <select
            aria-label="Kubernetes context"
            className="select"
            disabled={busy}
            value={context}
            onChange={(event) => setContext(event.target.value)}
          >
            <option value="">Choose a context</option>
            {contexts.map((entry) => (
              <option
                key={entry.name}
                value={entry.name}
                disabled={!!entry.error}
              >
                {entry.name}
                {entry.error ? " (unsupported)" : ` · ${entry.namespace}`}
              </option>
            ))}
          </select>
        </Field>
      )}
      {contexts
        .filter((entry) => entry.error)
        .map((entry) => (
          <p className="small muted" key={entry.name}>
            {entry.name}: {entry.error}
          </p>
        ))}
      <p className="small muted" style={{ marginTop: 16, lineHeight: 1.7 }}>
        Connects directly from NexusSSH to the cluster’s HTTPS API. Supports
        embedded bearer tokens or client certificates with TLS verification.
        Login plugins, local credential files, and proxies are not supported.
      </p>
    </Drawer>
  );
}

function PodLogs({
  clusterId,
  pod,
  onClose,
}: {
  clusterId: string;
  pod: ResourceSummary;
  onClose: () => void;
}) {
  const [container, setContainer] = useState(pod.containers[0]?.name || "");
  const [previous, setPrevious] = useState(false);
  const [lines, setLines] = useState("200");
  const params = new URLSearchParams({
    container,
    previous: String(previous),
    lines,
  });
  const q = useApi<{ content: string; truncated: boolean }>(
    `kubernetes/clusters/${clusterId}/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}/logs?${params}`,
    { enabled: !!container },
  );
  return (
    <Drawer
      title={`Logs: ${pod.name}`}
      wide
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close logs
        </Button>
      }
    >
      <p className="small muted">
        {pod.namespace} · {pod.name}
      </p>
      <div className="kube-log-controls">
        <Field label="Container">
          <select
            aria-label="Container"
            className="select"
            value={container}
            onChange={(event) => setContainer(event.target.value)}
          >
            {pod.containers.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Log lines">
          <select
            aria-label="Log lines"
            className="select"
            value={lines}
            onChange={(event) => setLines(event.target.value)}
          >
            {[100, 200, 500, 1000].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Check
          label="Previous container instance"
          checked={previous}
          onChange={setPrevious}
        />
        <IconButton
          label="Refresh logs"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RotateCw size={16} />
        </IconButton>
      </div>
      {q.error && (
        <div className="alert danger" role="alert">
          {q.error.message}
        </div>
      )}
      {q.isFetching ? (
        <p role="status">Loading logs…</p>
      ) : (
        !q.error &&
        q.data && (
          <>
            <pre className="kube-logs">
              {q.data.content || "No log output."}
            </pre>
            {q.data.truncated && (
              <p className="small muted">
                Output is limited to 256 KB. Choose fewer log lines.
              </p>
            )}
          </>
        )
      )}
    </Drawer>
  );
}

export function KubernetesClusters() {
  const q = useApi<Cluster[]>("kubernetes/clusters");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = q.data?.find((cluster) => cluster.id === selectedId);
  const [form, setForm] = useState<{ cluster?: Cluster } | null>(null);
  const importRequested = useKubernetesImport((state) => state.requested);
  useEffect(() => {
    if (importRequested) {
      setForm({});
      useKubernetesImport.setState({ requested: false });
    }
  }, [importRequested]);
  const [resource, setResource] = useState<Resource>("pods");
  const [namespace, setNamespace] = useState("default");
  const [namespaceDraft, setNamespaceDraft] = useState("default");
  const [cursors, setCursors] = useState<string[]>([]);
  const [pod, setPod] = useState<ResourceSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const query = new URLSearchParams();
  if (resources[resource].namespaced) query.set("namespace", namespace);
  if (cursors.length) query.set("cursor", cursors[cursors.length - 1]);
  const data = useApi<ResourcePage>(
    `kubernetes/clusters/${selectedId}/resources/${resource}?${query}`,
    { enabled: !!selected },
  );
  const namespaces = useApi<ResourcePage>(
    `kubernetes/clusters/${selectedId}/resources/namespaces`,
    { enabled: !!selected },
  );
  const open = (cluster: Cluster) => {
    setSelectedId(cluster.id);
    setNamespace(cluster.namespace);
    setNamespaceDraft(cluster.namespace);
    setResource("pods");
    setCursors([]);
    setPod(null);
    setError("");
  };
  const check = async (cluster: Cluster) => {
    setChecking(true);
    setError("");
    try {
      await api(`kubernetes/clusters/${cluster.id}/check`, {});
      await refreshClusters();
      notify.success("Kubernetes API connection verified.");
    } catch (e) {
      setError((e as Error).message);
      await refreshClusters();
    } finally {
      setChecking(false);
    }
  };
  const remove = async (cluster: Cluster) => {
    if (
      !(await confirmDialog(
        "Remove Kubernetes cluster",
        <>
          Remove <b>{cluster.name}</b> and its saved credentials from NexusSSH?
          The Kubernetes cluster keeps running.
        </>,
        "Remove",
        true,
      ))
    )
      return;
    try {
      await api(`kubernetes/clusters/${cluster.id}`, undefined, "DELETE");
      if (selectedId === cluster.id) setSelectedId(null);
      await refreshClusters();
      notify.success("Cluster profile removed.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="page kube-page">
      <PageHead
        title="Kubernetes"
        sub="Connect cluster APIs, browse resources, and read pod logs."
      >
        <Button variant="outline" onClick={() => setForm({})}>
          <Plus size={16} /> Add cluster
        </Button>
      </PageHead>
      {(q.error || error) && (
        <div className="alert danger" role="alert">
          {error || q.error?.message}
        </div>
      )}
      {q.isPending ? (
        <p>Loading clusters…</p>
      ) : selected ? (
        <>
          <div className="kube-cluster-heading">
            <Button
              variant="text"
              onClick={() => {
                setSelectedId(null);
                setError("");
              }}
            >
              <ArrowLeft size={15} /> All clusters
            </Button>
            <h2>{selected.name}</h2>
            <span className={`badge ${statusColor(selected.status)}`}>
              {selected.status === "connected"
                ? selected.version || "Connected"
                : selected.status === "error"
                  ? "Check failed"
                  : "Not checked"}
            </span>
          </div>
          <div className="card card-pad kube-connection">
            <div>
              <strong>{selected.context}</strong>
              <p className="small muted">{selected.server}</p>
              <p className="small muted">
                {selected.authentication === "token"
                  ? "Bearer token"
                  : "Client certificate"}{" "}
                ·{" "}
                {selected.bastionId
                  ? "HTTPS via SSH bastion"
                  : selected.vpnProfileId
                    ? "HTTPS via WireGuard"
                    : "Direct HTTPS"}
                {selected.bastionId && selected.vpnProfileId
                  ? " + WireGuard"
                  : ""}
                {selected.lastCheckedAt
                  ? ` · checked ${timeAgo(selected.lastCheckedAt)}`
                  : ""}
              </p>
            </div>
            <div className="row">
              <Button
                variant="outline"
                disabled={checking}
                onClick={() => void check(selected)}
              >
                {checking ? "Checking…" : "Test connection"}
              </Button>
              <IconButton
                label={`Edit ${selected.name}`}
                onClick={() => setForm({ cluster: selected })}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label={`Remove ${selected.name}`}
                danger
                onClick={() => void remove(selected)}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          </div>
          {selected.lastError && (
            <p className="small muted">
              Last connection check: {selected.lastError}
            </p>
          )}
          <div className="kube-resource-tools">
            <Field label="Resource">
              <select
                aria-label="Resource"
                className="select"
                value={resource}
                onChange={(event) => {
                  setResource(event.target.value as Resource);
                  setCursors([]);
                }}
              >
                {Object.keys(labels).map((key) => (
                  <option key={key} value={key}>
                    {labels[key as Resource]}
                  </option>
                ))}
              </select>
            </Field>
            {resources[resource].namespaced && (
              <form
                className="kube-namespace"
                onSubmit={(event) => {
                  event.preventDefault();
                  setNamespace(namespaceDraft.trim() || "*");
                  setCursors([]);
                }}
              >
                <Field label="Namespace">
                  <input
                    className="input"
                    aria-label="Namespace"
                    list="kube-namespaces"
                    value={namespaceDraft}
                    maxLength={63}
                    placeholder="* for all namespaces"
                    onChange={(event) => setNamespaceDraft(event.target.value)}
                  />
                  <datalist id="kube-namespaces">
                    <option value="*">All namespaces</option>
                    {namespaces.data?.items.map((entry) => (
                      <option key={entry.name} value={entry.name} />
                    ))}
                  </datalist>
                </Field>
                <Button variant="secondary" type="submit">
                  Apply
                </Button>
              </form>
            )}
            <IconButton
              label="Refresh resources"
              disabled={data.isFetching}
              onClick={() => {
                if (cursors.length) setCursors([]);
                else void data.refetch();
              }}
            >
              <RotateCw size={17} />
            </IconButton>
          </div>
          {namespaces.error && resources[resource].namespaced && (
            <p className="small muted">
              Namespace discovery is unavailable for this identity. Enter a
              namespace above.
            </p>
          )}
          {data.error && (
            <div className="alert danger" role="alert">
              {data.error.message}
            </div>
          )}
          <div className="card kube-resource-table">
            {data.isFetching ? (
              <p className="card-pad" role="status">
                Loading {labels[resource].toLowerCase()}…
              </p>
            ) : data.error ? null : data.data?.items.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {resources[resource].namespaced && <th>Namespace</th>}
                    <th>Status</th>
                    <th>Ready</th>
                    <th>Details</th>
                    <th>Age</th>
                    {resource === "pods" && <th>Logs</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((entry) => (
                    <tr key={entry.uid || `${entry.namespace}/${entry.name}`}>
                      <td>
                        <strong>{entry.name}</strong>
                      </td>
                      {resources[resource].namespaced && (
                        <td>{entry.namespace}</td>
                      )}
                      <td>
                        <span className={`badge ${statusColor(entry.status)}`}>
                          {entry.status}
                        </span>
                      </td>
                      <td>{entry.ready || "—"}</td>
                      <td className="kube-resource-detail">
                        {entry.detail || "—"}
                        {resource === "pods" && (
                          <div className="small muted">
                            {entry.restarts} restarts
                          </div>
                        )}
                      </td>
                      <td>
                        {entry.createdAt &&
                        Number.isFinite(Date.parse(entry.createdAt))
                          ? timeAgo(entry.createdAt)
                          : "—"}
                      </td>
                      {resource === "pods" && (
                        <td>
                          <IconButton
                            label={`View logs for ${entry.name}`}
                            disabled={!entry.containers.length}
                            onClick={() => setPod(entry)}
                          >
                            <FileText size={17} />
                          </IconButton>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !data.error && (
                <Empty
                  icon={<Boxes size={42} />}
                  title={`No ${labels[resource].toLowerCase()} found`}
                >
                  Try another namespace or refresh the cluster.
                </Empty>
              )
            )}
          </div>
          <div className="kube-pagination">
            <span className="small muted">
              Page {cursors.length + 1}
              {data.data
                ? ` · ${data.data.items.length} resources on this page`
                : ""}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={data.isFetching || !cursors.length}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Previous page
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={data.isFetching || !data.data?.nextCursor}
              onClick={() =>
                setCursors((current) => [...current, data.data!.nextCursor!])
              }
            >
              Next page
            </Button>
          </div>
        </>
      ) : q.data?.length ? (
        <div className="kube-clusters">
          {q.data.map((cluster) => (
            <section
              key={cluster.id}
              className="card card-pad kube-cluster-card"
            >
              <div className="row">
                <Boxes size={22} />
                <h2 className="grow ellipsis" title={cluster.name}>
                  {cluster.name}
                </h2>
                <IconButton
                  label={`Edit ${cluster.name}`}
                  onClick={() => setForm({ cluster })}
                >
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label={`Remove ${cluster.name}`}
                  danger
                  onClick={() => void remove(cluster)}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <p className="small muted">{cluster.server}</p>
              <p className="small">
                Context: {cluster.context} · {cluster.namespace}
              </p>
              <p className="small muted">
                Route:{" "}
                {cluster.bastionId
                  ? "SSH bastion"
                  : cluster.vpnProfileId
                    ? "WireGuard"
                    : "Direct"}
                {cluster.bastionId && cluster.vpnProfileId
                  ? " via WireGuard"
                  : ""}
              </p>
              {cluster.description && (
                <p className="small muted">{cluster.description}</p>
              )}
              <div className="row">
                <span className={`badge ${statusColor(cluster.status)}`}>
                  {cluster.status === "connected"
                    ? cluster.version || "Connected"
                    : cluster.status === "error"
                      ? "Check failed"
                      : "Not checked"}
                </span>
                <span className="grow" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => open(cluster)}
                >
                  Open cluster
                </Button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        !q.error && (
          <div className="card">
            <Empty
              icon={<Boxes size={64} strokeWidth={1.25} />}
              title="No Kubernetes clusters"
            >
              Import a kubeconfig to connect your first cluster directly.
            </Empty>
          </div>
        )
      )}
      {form && (
        <ClusterForm
          cluster={form.cluster}
          onClose={() => setForm(null)}
          onSaved={(cluster) => {
            setForm(null);
            open(cluster);
          }}
        />
      )}
      {selected && pod && (
        <PodLogs
          key={`${selected.id}/${pod.uid || pod.name}`}
          clusterId={selected.id}
          pod={pod}
          onClose={() => setPod(null)}
        />
      )}
    </div>
  );
}
