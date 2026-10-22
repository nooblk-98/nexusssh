"use client";
import { useState } from "react";
import {
  ArrowDownToLine,
  Bot,
  Copy,
  Plus,
  RotateCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  copyText,
  notify,
  operation,
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
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <PageHead
        title="MCP Server"
        sub="Give AI assistants scoped, audited access to your servers over the Model Context Protocol"
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
            Register an agent under AI Agents and choose its servers and tools.
            Enable Workspace management for keys, VPN profiles, folders and
            other app administration.
          </li>
          <li>
            Copy the token shown once after creation into your client’s secret
            store.
          </li>
          <li>
            Point the client at the endpoint with the token as a bearer header.
          </li>
        </ol>
        <div style={{ position: "relative" }}>
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
          Client configuration formats vary; this shows the URL and header every
          client needs. SSH credentials never leave this deployment — agents
          only call the tools you grant, and changes can require human approval.
        </p>
        <div className="section-title">Tools</div>
        <div className="check-grid">
          {[
            ...(q.data?.operations || []),
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
  return (
    <div className="page">
      <PageHead
        title="AI Agents"
        sub="Machine identities for MCP clients, each limited to the servers and tools you assign"
      >
        <Button
          variant="outline"
          onClick={() =>
            setForm({
              name: "",
              workspaceManagement: false,
              level: "viewer",
              days: 30,
              serverIds: [],
              operations: [],
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
          <table className="table">
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
                    {a.level} · {a.permissions.length} server
                    {a.permissions.length === 1 ? "" : "s"}
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
                  <td className="row" style={{ gap: 2 }}>
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
                          level: a.level,
                          days: 30,
                          serverIds: a.permissions.map((p: Row) => p.serverId),
                          operations: scopes.filter(
                            (op) => op !== "workspace_manage",
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
                  (!form.serverIds.length && !form.workspaceManagement)
                }
                onClick={() =>
                  void api<Row>(
                    form.id ? "agents/" + form.id + "/access" : "agents",
                    {
                      level: form.level,
                      serverIds: form.serverIds,
                      operations: form.operations,
                      workspaceManagement: form.workspaceManagement,
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
              hint="Custom uses only the tools selected below."
            >
              <select
                className="select"
                value={form.level}
                onChange={(e) =>
                  setForm({
                    ...form,
                    level: e.target.value,
                    workspaceManagement:
                      e.target.value === "administrator" &&
                      form.workspaceManagement,
                    operations:
                      e.target.value === "viewer"
                        ? form.operations.filter((op) =>
                            settings.data?.readOperations.includes(op),
                          )
                        : form.operations,
                  })
                }
              >
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
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
                hint="Counts SSH and workspace management calls."
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
          <div className="drawer-section">Workspace management</div>
          <Check
            label="Manage this workspace through MCP"
            checked={form.workspaceManagement}
            disabled={form.level !== "administrator"}
            onChange={(workspaceManagement) =>
              setForm({ ...form, workspaceManagement })
            }
          />
          <p className="hint" style={{ marginBottom: 16 }}>
            Administrator agents can manage SSH identities, VPNs, folders,
            servers, users, teams, settings and other agents. Existing tokens
            receive access immediately. SSH execution still uses the selected
            tools and server grants; approval decisions stay in the app.
          </p>
          <div className="drawer-section">Servers</div>
          <div className="check-grid">
            {servers.map((s) => (
              <Check
                key={s.id}
                label={s.name}
                checked={form.serverIds.includes(s.id)}
                onChange={(v) =>
                  setForm({
                    ...form,
                    serverIds: v
                      ? [...form.serverIds, s.id]
                      : form.serverIds.filter((x) => x !== s.id),
                  })
                }
              />
            ))}
          </div>
          <div className="drawer-section" style={{ marginTop: 14 }}>
            Tools
          </div>
          <div className="check-grid">
            {ops.map((o) => (
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
      <Field label="Server">
        <select
          className="select"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        >
          <option value="">All servers</option>
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
              <th>Server</th>
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

export function Approvals() {
  const q = useApi<Row[]>("approvals", { interval: 15000 });
  const list = q.data || [];
  const decide = (id: string, decision: "approved" | "rejected") =>
    void api("approvals/" + id, { decision })
      .then(() => refresh("approvals"))
      .catch(notify.error);
  return (
    <div className="page">
      <PageHead
        title="Approvals"
        sub="Changes requested by agents and users wait here for a human decision"
      >
        <Button variant="outline" onClick={() => void q.refetch()}>
          <RotateCw size={16} /> Refresh
        </Button>
      </PageHead>
      <div className="card table-card">
        {list.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Server</th>
                <th>Arguments</th>
                <th>Requested</th>
                <th>Status</th>
                <th style={{ width: 210 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const expired =
                  a.status === "pending" && new Date(a.expiresAt) < new Date();
                return (
                  <tr key={a.id}>
                    <td className="mono small">{a.operation}</td>
                    <td>{a.server?.name}</td>
                    <td
                      className="mono small ellipsis"
                      style={{ maxWidth: 320 }}
                      title={JSON.stringify(a.args, null, 2)}
                    >
                      {JSON.stringify(a.args)}
                    </td>
                    <td>{timeAgo(a.createdAt)}</td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (expired
                            ? ""
                            : a.status === "approved"
                              ? "green"
                              : a.status === "rejected"
                                ? "red"
                                : "amber")
                        }
                      >
                        {expired ? "expired" : a.status}
                      </span>
                    </td>
                    <td>
                      {a.status === "pending" && !expired && (
                        <span className="row" style={{ gap: 6 }}>
                          <Button
                            size="sm"
                            onClick={() => decide(a.id, "approved")}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => decide(a.id, "rejected")}
                          >
                            Reject
                          </Button>
                        </span>
                      )}
                      {a.status === "approved" && !a.consumedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          title="Run the approved operation now with your own permissions"
                          onClick={() =>
                            void operation(a.operation, {
                              ...a.args,
                              approvalId: a.id,
                            })
                              .then(() => {
                                notify.success("Operation completed.");
                                void refresh("approvals");
                              })
                              .catch(notify.error)
                          }
                        >
                          Execute
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<ShieldCheck size={52} strokeWidth={1.5} />}
            title="No Approval Requests"
            tall
          >
            Requests for file changes, service control and other sensitive
            operations appear here.
          </Empty>
        )}
      </div>
    </div>
  );
}

export function AuditLog() {
  const [filter, setFilter] = useState("");
  const q = useApi<Row[]>(
    "audit" +
      (filter.trim() ? "?action=" + encodeURIComponent(filter.trim()) : ""),
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
        {list.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Principal</th>
                <th>Server</th>
                <th>Status</th>
                <th>Time</th>
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
