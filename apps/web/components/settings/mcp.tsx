"use client";
import { useState } from "react";
import {
  ArrowDownToLine,
  Bot,
  Copy,
  Plus,
  RotateCw,
  ScrollText,
} from "lucide-react";
import {
  api,
  copyText,
  notify,
  refresh,
  saveFile,
  timeAgo,
  useApi,
  type Row,
} from "../../lib/api";
import { useServers } from "../../lib/servers";
import {
  Button,
  Check,
  confirmDialog,
  Drawer,
  Empty,
  Field,
  SearchInput,
} from "../ui";
import { PageHead } from "./page-head";

const copy = (text: string) =>
  void copyText(text)
    .then(() => notify.success("Copied to clipboard."))
    .catch(notify.error);
const installCommand = (endpoint: string) =>
  `npx -y nexusssh-mcp@latest --url ${endpoint || "<endpoint>"}`;
export function McpServer() {
  const q = useApi<Row>("settings");
  const endpoint = q.data?.endpoint || "";
  const config = JSON.stringify(
    {
      mcpServers: {
        nexusssh: {
          type: "http",
          url: endpoint,
          headers: { Authorization: "Bearer <agent-token>" },
        },
      },
    },
    null,
    2,
  );
  const install = installCommand(endpoint);
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <PageHead
        title="MCP Server"
        sub="Give AI assistants scoped, audited access to your servers and Kubernetes clusters over MCP"
      />
      <div className="card card-pad">
        <Field
          label="Endpoint"
          hint={`Streamable HTTP · protocol ${q.data?.protocol || ""} (legacy ${q.data?.legacy || "clients"} supported)`}
        >
          <div className="input-group">
            <input
              readOnly
              className="input mono"
              value={endpoint}
              style={{ fontSize: 12 }}
            />
            <button
              className="btn btn-secondary"
              onClick={() => copy(endpoint)}
            >
              <Copy size={15} /> Copy
            </button>
          </div>
        </Field>
        <div className="section-title">Connect a client</div>
        <ol
          className="small"
          style={{
            lineHeight: 1.9,
            paddingLeft: 18,
            margin: "0 0 14px",
            listStyle: "decimal",
          }}
        >
          <li>
            Register an agent under AI Agents and choose its servers, Kubernetes
            clusters and tools. Enable Workspace management for keys, VPN
            profiles, folders and other app administration.
          </li>
          <li>Copy the token shown once after creation.</li>
          <li>
            Run the installer on the computer where your AI clients run. It asks
            for the token, checks it, and adds NexusSSH to Claude Code, Claude
            Desktop, Cursor, VS Code, Cline, Windsurf, Gemini CLI, Codex and
            opencode. Restart the clients afterwards.
          </li>
        </ol>
        <div className="mcp-code-block">
          <code className="code">{install}</code>
          <button
            className="btn btn-secondary btn-sm"
            style={{ position: "absolute", top: 8, right: 8 }}
            onClick={() => copy(install)}
          >
            <Copy size={13} /> Copy
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Requires Node.js 20 or newer. Existing client files are backed up
          before they change. Remove the server again with{" "}
          <span className="mono">npx nexusssh-mcp uninstall</span>. SSH
          credentials never leave this deployment — agents only call the tools
          you grant. SSH and Kubernetes operations run without approval.
        </p>
        <details style={{ marginTop: 12 }}>
          <summary className="small" style={{ cursor: "pointer" }}>
            Configure a client manually
          </summary>
          <div className="mcp-code-block" style={{ marginTop: 10 }}>
            <code className="code">{config}</code>
            <button
              className="btn btn-secondary btn-sm"
              style={{ position: "absolute", top: 8, right: 8 }}
              onClick={() => copy(config)}
            >
              <Copy size={13} /> Copy
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Client configuration formats vary; this shows the URL and bearer
            header every remote HTTP client needs.
          </p>
        </details>
        <div className="section-title">Tools</div>
        <div className="check-grid">
          {[
            ...(q.data?.operations || []),
            ...(q.data?.kubernetesOperations || []),
            ...(q.data?.managementTools || []).map((t: Row) => t.name),
          ]
            .filter((o: string) => o !== "terminal")
            .map((o: string) => (
              <span key={o} className="mono small" style={{ padding: "4px 0" }}>
                {o}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

export function Agents() {
  const maxServerGrants = 100;
  const clusters = useApi<Row[]>("kubernetes/clusters");
  const q = useApi<Row[]>("agents");
  const settings = useApi<Row>("settings");
  const { servers } = useServers();
  const [token, setToken] = useState("");
  const [form, setForm] = useState<{
    id?: string;
    workspaceManagement: boolean;
    name: string;
    level: string;
    days: number;
    serverIds: string[];
    operations: string[];
    clusterIds: string[];
    clusterOperations: string[];
    perMinute: string;
    perDay: string;
  } | null>(null);
  const [limits, setLimits] = useState<{
    agent: Row;
    perMinute: string;
    perDay: string;
  } | null>(null);
  const [activity, setActivity] = useState<Row | null>(null);
  const list = q.data || [];
  const cap = (v: string) => (v.trim() ? Number(v) : null);
  const ops: string[] = (settings.data?.operations || []).filter(
    (o: string) => o !== "terminal",
  );
  const availableOps = ops;
  return (
    <div className="page">
      <PageHead
        title="AI Agents"
        sub="Administrator access for your workspace, or custom server, cluster and tool grants"
      >
        <Button
          variant="outline"
          onClick={() =>
            setForm({
              name: "",
              workspaceManagement: false,
              level: "administrator",
              days: 30,
              serverIds: [],
              operations: [],
              clusterIds: [],
              clusterOperations: [],
              perMinute: "",
              perDay: "",
            })
          }
        >
          <Plus size={17} /> Register Agent
        </Button>
      </PageHead>
      {token && (
        <div
          className="card card-pad"
          style={{ marginBottom: 14, borderColor: "var(--primary-border)" }}
        >
          <b>Copy this token now — it is shown only once.</b>
          <div className="input-group" style={{ marginTop: 10 }}>
            <input
              readOnly
              className="input mono"
              value={token}
              style={{ fontSize: 11 }}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-secondary" onClick={() => copy(token)}>
              <Copy size={15} /> Copy
            </button>
          </div>
          <p className="small muted" style={{ margin: "10px 0 6px" }}>
            Add it to your AI clients with this command, and paste the token
            when asked:
          </p>
          <div className="input-group">
            <input
              readOnly
              className="input mono"
              value={installCommand(settings.data?.endpoint || "")}
              style={{ fontSize: 11 }}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="btn btn-secondary"
              onClick={() =>
                copy(installCommand(settings.data?.endpoint || ""))
              }
            >
              <Copy size={15} /> Copy
            </button>
          </div>
          <Button
            variant="text"
            size="sm"
            style={{ marginTop: 8 }}
            onClick={() => setToken("")}
          >
            I saved it
          </Button>
        </div>
      )}
      <div className="card table-card">
        {list.length ? (
          <table className="table settings-table-wide">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Access</th>
                <th>Limits</th>
                <th>Last Active</th>
                <th>Status</th>
                <th style={{ width: 230 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b style={{ fontWeight: 600 }}>{a.name}</b>
                  </td>
                  <td>
                    {a.level === "administrator"
                      ? "Administrator · All servers and clusters"
                      : `Custom · ${a.permissions.length} server${a.permissions.length === 1 ? "" : "s"}`}
                    {a.level !== "administrator" &&
                      !!a.clusterPermissions?.length && (
                        <div>
                          {a.clusterPermissions.length} Kubernetes cluster
                          {a.clusterPermissions.length === 1 ? "" : "s"}
                        </div>
                      )}
                    {a.tokens.some(
                      (t: Row) =>
                        !t.revoked &&
                        JSON.parse(t.scopes).includes("workspace_manage"),
                    ) && <div className="badge">Workspace management</div>}
                  </td>
                  <td className="small">
                    {a.maxCallsPerMinute || a.maxCallsPerDay
                      ? [
                          a.maxCallsPerMinute && `${a.maxCallsPerMinute}/min`,
                          a.maxCallsPerDay && `${a.maxCallsPerDay}/day`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Unlimited"}
                  </td>
                  <td>
                    {a.lastActivityAt ? timeAgo(a.lastActivityAt) : "Never"}
                  </td>
                  <td>
                    <span className={"badge " + (a.revoked ? "red" : "green")}>
                      {a.revoked ? "Revoked" : "Active"}
                    </span>
                  </td>
                  <td>
                    <div className="settings-table-actions">
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => setActivity(a)}
                      >
                        Activity
                      </Button>
                      <Button
                        variant="text"
                        size="sm"
                        disabled={a.revoked}
                        onClick={() => {
                          const scopes: string[] = [
                            ...new Set<string>(
                              a.tokens
                                .filter((t: Row) => !t.revoked)
                                .flatMap((t: Row) => JSON.parse(t.scopes)),
                            ),
                          ];
                          setForm({
                            id: a.id,
                            name: a.name,
                            level:
                              a.level === "administrator"
                                ? "administrator"
                                : "custom",
                            days: 30,
                            serverIds: a.permissions.map(
                              (p: Row) => p.serverId,
                            ),
                            operations: scopes.filter((op) => ops.includes(op)),
                            clusterIds: (a.clusterPermissions || []).map(
                              (p: Row) => p.clusterId,
                            ),
                            clusterOperations: scopes.filter((op) =>
                              settings.data?.kubernetesOperations?.includes(op),
                            ),
                            workspaceManagement:
                              scopes.includes("workspace_manage"),
                            perMinute: "",
                            perDay: "",
                          });
                        }}
                      >
                        Access
                      </Button>
                      <Button
                        variant="text"
                        size="sm"
                        disabled={a.revoked}
                        onClick={() =>
                          setLimits({
                            agent: a,
                            perMinute: a.maxCallsPerMinute
                              ? String(a.maxCallsPerMinute)
                              : "",
                            perDay: a.maxCallsPerDay
                              ? String(a.maxCallsPerDay)
                              : "",
                          })
                        }
                      >
                        Limits
                      </Button>
                      <Button
                        variant="text"
                        size="sm"
                        disabled={a.revoked}
                        onClick={async () => {
                          if (
                            await confirmDialog(
                              "Revoke Agent",
                              `Revoke all access for ${a.name}? Its tokens stop working immediately.`,
                              "Revoke",
                              true,
                            )
                          )
                            await api("agents/" + a.id, {}, "DELETE")
                              .then(() => refresh("agents"))
                              .catch(notify.error);
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Bot size={56} strokeWidth={1.5} />}
            title="No Agents Registered"
          >
            Create a dedicated identity for each assistant or automation and
            assign only the tools and servers it needs.
          </Empty>
        )}
      </div>
      {form && (
        <Drawer
          title={form.id ? "Agent Access · " + form.name : "Register Agent"}
          wide
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !form.name.trim() ||
                  (form.level === "custom" &&
                    (form.serverIds.length > maxServerGrants ||
                      (!form.serverIds.length &&
                        !form.clusterIds.length &&
                        !form.workspaceManagement) ||
                      (!!form.clusterIds.length &&
                        !form.clusterOperations.length) ||
                      form.clusterIds.length > 50 ||
                      (!!form.clusterIds.length && !!clusters.error)))
                }
                onClick={() =>
                  void api<Row>(
                    form.id ? "agents/" + form.id + "/access" : "agents",
                    {
                      level: form.level,
                      ...(form.level === "custom"
                        ? {
                            serverIds: form.serverIds,
                            operations: form.operations,
                            clusterIds: form.clusterIds,
                            clusterOperations: form.clusterOperations,
                            workspaceManagement: form.workspaceManagement,
                          }
                        : {}),
                      ...(!form.id
                        ? {
                            name: form.name.trim(),
                            expiresInDays: form.days,
                            maxCallsPerMinute: cap(form.perMinute),
                            maxCallsPerDay: cap(form.perDay),
                          }
                        : {}),
                    },
                    form.id ? "PATCH" : "POST",
                  )
                    .then((r) => {
                      if (r.token) setToken(r.token);
                      setForm(null);
                      void refresh("agents");
                    })
                    .catch(notify.error)
                }
              >
                {form.id ? "Save Access" : "Create Token"}
              </Button>
            </>
          }
        >
          {!form.id && (
            <Field label="Agent Name" required>
              <input
                autoFocus
                className="input"
                placeholder="Infrastructure assistant"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
          )}
          <div className="grid-2">
            <Field
              label="Permission level"
              hint="Administrator enables all access. Custom uses your selections below."
            >
              <select
                className="select"
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
              >
                <option value="administrator">Administrator</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            {!form.id && (
              <Field label="Expires after (days)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={90}
                  value={form.days}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      days: Math.max(
                        1,
                        Math.min(90, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </Field>
            )}
          </div>
          {!form.id && (
            <div className="grid-2">
              <Field label="Max calls per minute" hint="Empty means unlimited.">
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.perMinute}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      perMinute: e.target.value.replace(/\D/g, ""),
                    })
                  }
                />
              </Field>
              <Field
                label="Max calls per day"
                hint="Counts SSH, Kubernetes and workspace management calls."
              >
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.perDay}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      perDay: e.target.value.replace(/\D/g, ""),
                    })
                  }
                />
              </Field>
            </div>
          )}
          {form.level === "administrator" ? (
            <div className="card card-pad" role="note">
              <b>All MCP permissions enabled</b>
              <p className="hint">
                Administrator agents can use every SSH and Kubernetes tool on
                all current and future servers and clusters, and manage the
                workspace. No individual grants are needed.
              </p>
              <p className="hint">
                SSH and Kubernetes operations run without approval. Saved SSH
                credentials and kubeconfigs are never returned through MCP.
              </p>
            </div>
          ) : (
            <>
              <div className="drawer-section">Workspace management</div>
              <Check
                label="Manage this workspace through MCP"
                checked={form.workspaceManagement}
                onChange={(workspaceManagement) =>
                  setForm({ ...form, workspaceManagement })
                }
              />
              <p className="hint" style={{ marginBottom: 16 }}>
                Enable this group to add encrypted Kubernetes profiles and
                manage SSH identities, VPNs, folders, servers, users, teams,
                settings and other agents. Existing tokens receive access
                immediately. SSH execution still uses the selected tools and
                server and cluster grants without approval. Saved SSH
                credentials and kubeconfigs are never returned through MCP.
                Kubernetes cluster/tool grants are assigned separately by a
                human administrator.
              </p>
              <div className="drawer-section">Servers</div>
              <p className="hint">
                Selected tools apply to every selected server. Up to{" "}
                {maxServerGrants} servers per agent ({form.serverIds.length}{" "}
                selected).
                {servers.length > maxServerGrants &&
                  " Select all is unavailable because this workspace has more than 100 servers."}
              </p>
              <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                <Button
                  variant="text"
                  size="sm"
                  disabled={
                    !servers.length ||
                    servers.length > maxServerGrants ||
                    servers.every((s) => form.serverIds.includes(s.id))
                  }
                  onClick={() =>
                    setForm({ ...form, serverIds: servers.map((s) => s.id) })
                  }
                >
                  Select all servers
                </Button>
                <Button
                  variant="text"
                  size="sm"
                  disabled={!form.serverIds.length}
                  onClick={() => setForm({ ...form, serverIds: [] })}
                >
                  Clear servers
                </Button>
              </div>
              <div className="check-grid">
                {servers.map((s) => (
                  <Check
                    key={s.id}
                    label={s.name}
                    checked={form.serverIds.includes(s.id)}
                    disabled={
                      !form.serverIds.includes(s.id) &&
                      form.serverIds.length >= maxServerGrants
                    }
                    onChange={(v) =>
                      setForm({
                        ...form,
                        serverIds: v
                          ? form.serverIds.length < maxServerGrants
                            ? [...form.serverIds, s.id]
                            : form.serverIds
                          : form.serverIds.filter((x) => x !== s.id),
                      })
                    }
                  />
                ))}
              </div>
              <div className="drawer-section" style={{ marginTop: 14 }}>
                SSH tools
              </div>
              <p className="hint">
                Select the SSH actions this agent can use on its selected
                servers.
              </p>
              <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                <Button
                  variant="text"
                  size="sm"
                  disabled={
                    !availableOps.length ||
                    availableOps.every((o) => form.operations.includes(o))
                  }
                  onClick={() => setForm({ ...form, operations: availableOps })}
                >
                  Select all SSH tools
                </Button>
                <Button
                  variant="text"
                  size="sm"
                  disabled={!form.operations.length}
                  onClick={() => setForm({ ...form, operations: [] })}
                >
                  Clear SSH tools
                </Button>
              </div>
              <div className="check-grid">
                {availableOps.map((o) => (
                  <Check
                    key={o}
                    label={<span className="mono small">{o}</span>}
                    checked={form.operations.includes(o)}
                    onChange={(v) =>
                      setForm({
                        ...form,
                        operations: v
                          ? [...form.operations, o]
                          : form.operations.filter((x) => x !== o),
                      })
                    }
                  />
                ))}
              </div>
              <div className="drawer-section" style={{ marginTop: 14 }}>
                Kubernetes clusters
              </div>
              <p className="hint">
                Choose saved clusters and tools separately from SSH grants.
                Existing agents have no cluster access until assigned here.
                Commands execute immediately within the granted permissions.
              </p>
              {clusters.error ? (
                <p role="alert" className="hint">
                  Could not load cluster profiles. Retry before editing cluster
                  grants.
                </p>
              ) : null}
              {!clusters.data?.length && !clusters.error && (
                <p className="hint">
                  Import a kubeconfig in Kubernetes settings to add a cluster.
                </p>
              )}
              <div className="check-grid">
                {(clusters.data || []).map((cluster) => (
                  <Check
                    key={cluster.id}
                    label={cluster.name}
                    checked={form.clusterIds.includes(cluster.id)}
                    onChange={(value) =>
                      setForm({
                        ...form,
                        clusterIds: value
                          ? [...form.clusterIds, cluster.id]
                          : form.clusterIds.filter((id) => id !== cluster.id),
                      })
                    }
                  />
                ))}
              </div>
              <div className="drawer-section" style={{ marginTop: 14 }}>
                Kubernetes tools
              </div>
              <div className="check-grid">
                {(settings.data?.kubernetesOperations || []).map(
                  (op: string) => (
                    <Check
                      key={op}
                      label={<span className="mono small">{op}</span>}
                      checked={form.clusterOperations.includes(op)}
                      onChange={(value) =>
                        setForm({
                          ...form,
                          clusterOperations: value
                            ? [...form.clusterOperations, op]
                            : form.clusterOperations.filter(
                                (item) => item !== op,
                              ),
                        })
                      }
                    />
                  ),
                )}
              </div>
              <p className="hint">
                For command tools, also select kubernetes_execution_status to
                retrieve saved results. kubernetes_execute accepts a supported
                kubectl-style command; kubernetes_pod_exec runs argv inside a
                named container.
              </p>
            </>
          )}
        </Drawer>
      )}
      {limits && (
        <Drawer
          title={"Limits · " + limits.agent.name}
          onClose={() => setLimits(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLimits(null)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  void api(
                    "agents/" + limits.agent.id + "/limits",
                    {
                      maxCallsPerMinute: cap(limits.perMinute),
                      maxCallsPerDay: cap(limits.perDay),
                    },
                    "PATCH",
                  )
                    .then(() => {
                      setLimits(null);
                      void refresh("agents");
                      notify.success("Limits saved.");
                    })
                    .catch(notify.error)
                }
              >
                Save Limits
              </Button>
            </>
          }
        >
          <p className="small muted" style={{ marginBottom: 14 }}>
            Calls beyond a limit are refused with HTTP 429 until the window
            passes. Leave a field empty for no limit.
          </p>
          <Field label="Max calls per minute">
            <input
              autoFocus
              className="input"
              inputMode="numeric"
              value={limits.perMinute}
              onChange={(e) =>
                setLimits({
                  ...limits,
                  perMinute: e.target.value.replace(/\D/g, ""),
                })
              }
            />
          </Field>
          <Field label="Max calls per day">
            <input
              className="input"
              inputMode="numeric"
              value={limits.perDay}
              onChange={(e) =>
                setLimits({
                  ...limits,
                  perDay: e.target.value.replace(/\D/g, ""),
                })
              }
            />
          </Field>
        </Drawer>
      )}
      {activity && (
        <AgentActivity agent={activity} close={() => setActivity(null)} />
      )}
    </div>
  );
}

function AgentActivity({ agent, close }: { agent: Row; close: () => void }) {
  const q = useApi<Row[]>("agents/" + agent.id + "/activity");
  const [server, setServer] = useState("");
  const rows = (q.data || []).filter((r) => !server || r.serverId === server);
  const names = [
    ...new Map((q.data || []).map((r) => [r.serverId, r.server?.name])),
  ];
  return (
    <Drawer
      title={"Activity · " + agent.name}
      wide
      onClose={close}
      footer={
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      }
    >
      <Field label="Target">
        <select
          className="select"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        >
          <option value="">All targets</option>
          {names.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      {rows.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Target</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono small">{r.operation}</td>
                <td>{r.server?.name}</td>
                <td>
                  <span
                    className={
                      "badge " +
                      (r.status === "completed"
                        ? "green"
                        : r.status === "failed"
                          ? "red"
                          : "")
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td title={new Date(r.createdAt).toLocaleString()}>
                  {timeAgo(r.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">
          {q.isPending ? "Loading…" : "No operations recorded yet."}
        </p>
      )}
    </Drawer>
  );
}

export function AuditLog() {
  const [filter, setFilter] = useState("");
  const [reference, setReference] = useState("");
  const q = useApi<Row[]>(
    "audit?" +
      new URLSearchParams({
        ...(filter.trim() ? { action: filter.trim() } : {}),
        ...(/^[a-f0-9-]{36}$/i.test(reference.trim())
          ? { requestId: reference.trim() }
          : {}),
      }),
    { interval: 30000 },
  );
  const list = q.data || [];
  const users = useApi<Row[]>("users");
  const agents = useApi<Row[]>("agents");
  const { servers } = useServers();
  const principal = (id: string) =>
    users.data?.find((u) => u.id === id)?.name ||
    (agents.data?.find((a) => a.id === id)?.name ?? "").replace(
      /^(.+)$/,
      "$1 (agent)",
    ) ||
    id.slice(0, 8);
  return (
    <div className="page">
      <PageHead
        title="Audit Log"
        sub="Sign-ins, connections, agent tool calls and administrative changes"
      >
        <Button
          variant="outline"
          disabled={!list.length}
          onClick={() =>
            saveFile(
              JSON.stringify(list, null, 2),
              "nexusssh-audit.json",
              "application/json",
            )
          }
        >
          <ArrowDownToLine size={16} /> Export
        </Button>
        <Button variant="outline" onClick={() => void q.refetch()}>
          <RotateCw size={16} /> Refresh
        </Button>
      </PageHead>
      <div className="card table-card">
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter by action..."
        />
        <SearchInput
          value={reference}
          onChange={setReference}
          placeholder="Find request reference..."
        />
        {list.length ? (
          <table className="table settings-table-wide">
            <thead>
              <tr>
                <th>Action</th>
                <th>Principal</th>
                <th>Server</th>
                <th>Status</th>
                <th>Time</th>
                <th>Request reference</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td>{e.action.replaceAll("_", " ")}</td>
                  <td>{principal(e.principalId)}</td>
                  <td>
                    {servers.find((s) => s.id === e.serverId)?.name || "-"}
                  </td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (e.status === "success"
                          ? "green"
                          : e.status === "denied" || e.status === "failure"
                            ? "red"
                            : "")
                      }
                    >
                      {e.status}
                    </span>
                  </td>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="mono small">{e.requestId || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<ScrollText size={52} strokeWidth={1.5} />}
            title="No Events"
            tall
          >
            {filter
              ? "No events match this filter."
              : "Activity will appear here."}
          </Empty>
        )}
      </div>
    </div>
  );
}
