"use client";
import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  CirclePlay,
  History,
  Link2,
  Pencil,
  Power,
  RotateCw,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import {
  api,
  copyText,
  notify,
  queryClient,
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
  IconButton,
  SearchInput,
} from "../ui";
import { PageHead } from "./page-head";

const roles = ["administrator", "operator", "viewer"] as const;
const roleLabel = (r: string) =>
  r === "owner"
    ? "Owner"
    : r === "administrator"
      ? "Admin"
      : r[0].toUpperCase() + r.slice(1);
function useSort<T extends Row>(rows: T[], initial: string) {
  const [sort, setSort] = useState({ key: initial, asc: true });
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const c = String(a[sort.key] ?? "").localeCompare(
          String(b[sort.key] ?? ""),
          undefined,
          { numeric: true },
        );
        return sort.asc ? c : -c;
      }),
    [rows, sort],
  );
  const th = (key: string, label: string) => (
    <th
      className="sortable"
      onClick={() =>
        setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))
      }
    >
      <span className="row" style={{ gap: 4 }}>
        {label} <ArrowUpDown size={13} />
      </span>
    </th>
  );
  return { sorted, th };
}
function duration(from: string, to?: string | null) {
  const s = Math.max(
    0,
    Math.round(
      ((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) /
        1000,
    ),
  );
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

type UserForm = {
  id?: string;
  name: string;
  email: string;
  password: string;
  role: string;
  disabled?: boolean;
};
export function UsersPage({ me }: { me: Row }) {
  const users = useApi<Row[]>("users");
  const teams = useApi<Row[]>("teams");
  const { servers } = useServers();
  const settings = useApi<Row>("settings");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<UserForm | null>(null);
  const [teamsFor, setTeamsFor] = useState<Row | null>(null);
  const [access, setAccess] = useState<{
    user: Row;
    serverId: string;
    ops: string[];
  } | null>(null);
  const [invite, setInvite] = useState<{
    email: string;
    role: string;
    url?: string;
  } | null>(null);
  const teamNames = (id: string) =>
    (teams.data || [])
      .filter((t) => t.members.some((m: Row) => m.userId === id))
      .map((t) => t.name);
  const rows = (users.data || [])
    .map((u): Row => ({
      ...u,
      type: roleLabel(u.role),
      teams: teamNames(u.id).join(", "),
    }))
    .filter((u) =>
      (u.name + " " + u.email).toLowerCase().includes(search.toLowerCase()),
    );
  const { sorted, th } = useSort(rows, "name");
  const active = (users.data || []).filter((u) => !u.disabled).length;
  async function saveUser() {
    if (!form) return;
    try {
      if (form.id)
        await api(
          "users/" + form.id,
          { role: form.role, disabled: !!form.disabled },
          "PATCH",
        );
      else
        await api("users", {
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
        });
      setForm(null);
      void refresh("users");
      notify.success("User saved.");
    } catch (e) {
      notify.error(e);
    }
  }
  return (
    <div className="page">
      <PageHead
        title="Users"
        sub={`${active} active user${active === 1 ? "" : "s"} · ${(users.data || []).length} total`}
      >
        <Button
          variant="outline"
          onClick={() => setInvite({ email: "", role: "operator" })}
        >
          <Link2 size={16} /> Invite
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            setForm({ name: "", email: "", password: "", role: "operator" })
          }
        >
          <UserPlus size={17} /> Add User
        </Button>
      </PageHead>
      <div className="card table-card" style={{ minHeight: 560 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search users..."
        />
        <table className="table">
          <thead>
            <tr>
              {th("name", "Name")}
              {th("email", "Username")}
              {th("type", "Type")}
              <th>
                <span className="row" style={{ gap: 6 }}>
                  <UsersRound size={15} /> Teams
                </span>
              </th>
              <th style={{ width: 130 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.id} style={u.disabled ? { opacity: 0.55 } : undefined}>
                <td>
                  <b style={{ fontWeight: 600 }}>{u.name}</b>
                  {u.disabled && (
                    <span className="badge red" style={{ marginLeft: 8 }}>
                      Disabled
                    </span>
                  )}
                </td>
                <td>{u.email}</td>
                <td>{u.type}</td>
                <td>{u.teams || "-"}</td>
                <td>
                  {u.role !== "owner" && u.id !== me.id ? (
                    <span className="row" style={{ gap: 2 }}>
                      <IconButton
                        label="Teams"
                        size="sm"
                        onClick={() => setTeamsFor(u)}
                      >
                        <UsersRound size={16} />
                      </IconButton>
                      <IconButton
                        label="Edit"
                        size="sm"
                        onClick={() =>
                          setForm({
                            id: u.id,
                            name: u.name,
                            email: u.email,
                            password: "",
                            role: u.role,
                            disabled: u.disabled,
                          })
                        }
                      >
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton
                        label={u.disabled ? "Enable user" : "Disable user"}
                        size="sm"
                        danger={!u.disabled}
                        onClick={async () => {
                          if (
                            u.disabled ||
                            (await confirmDialog(
                              "Disable User",
                              `Disable ${u.name}? Their sessions end immediately.`,
                              "Disable",
                              true,
                            ))
                          )
                            await api(
                              "users/" + u.id,
                              { role: u.role, disabled: !u.disabled },
                              "PATCH",
                            )
                              .then(() => refresh("users"))
                              .catch(notify.error);
                        }}
                      >
                        <Power size={15} />
                      </IconButton>
                    </span>
                  ) : (
                    <span className="muted small">
                      {u.id === me.id ? "You" : "Owner"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && (
        <Drawer
          title={form.id ? "Edit User" : "New User"}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !form.id &&
                  (!form.name.trim() ||
                    !form.email.trim() ||
                    form.password.length < 12)
                }
                onClick={() => void saveUser()}
              >
                Save User
              </Button>
            </>
          }
        >
          <Field label="Display Name" required>
            <input
              className="input"
              disabled={!!form.id}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Email (username)" required>
            <input
              className="input"
              type="email"
              disabled={!!form.id}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          {!form.id && (
            <Field
              label="Password"
              required
              hint="At least 12 characters. The user can change it under Account."
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          )}
          <Field
            label="Type"
            hint="Operators and viewers only see servers they are given access to."
          >
            <select
              className="select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </Field>
          {form.id && (
            <>
              <Check
                label="Disabled"
                checked={!!form.disabled}
                onChange={(v) => setForm({ ...form, disabled: v })}
              />
              <div className="drawer-section" style={{ marginTop: 18 }}>
                Server access
              </div>
              <Button
                variant="secondary"
                block
                onClick={() => {
                  const user = (users.data || []).find(
                    (u) => u.id === form.id,
                  )!;
                  setForm(null);
                  setAccess({ user, serverId: servers[0]?.id || "", ops: [] });
                }}
              >
                Assign server access…
              </Button>
            </>
          )}
        </Drawer>
      )}
      {access && (
        <Drawer
          title={"Server Access · " + access.user.name}
          onClose={() => setAccess(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAccess(null)}>
                Cancel
              </Button>
              <Button
                disabled={!access.serverId}
                onClick={() =>
                  void api("users/" + access.user.id + "/permissions", {
                    serverId: access.serverId,
                    operations: access.ops,
                  })
                    .then(() => {
                      setAccess(null);
                      notify.success("Access updated.");
                    })
                    .catch(notify.error)
                }
              >
                Save Access
              </Button>
            </>
          }
        >
          <Field label="Server">
            <select
              className="select"
              value={access.serverId}
              onChange={(e) =>
                setAccess({ ...access, serverId: e.target.value })
              }
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="small muted" style={{ marginBottom: 6 }}>
            Saving replaces this user’s permissions for the selected server.
            Select nothing to revoke access.
          </p>
          {(settings.data?.operations || []).map((o: string) => (
            <Check
              key={o}
              label={
                o === "terminal"
                  ? "Interactive terminal"
                  : o.replaceAll("_", " ")
              }
              checked={access.ops.includes(o)}
              onChange={(v) =>
                setAccess({
                  ...access,
                  ops: v
                    ? [...access.ops, o]
                    : access.ops.filter((x) => x !== o),
                })
              }
            />
          ))}
        </Drawer>
      )}
      {teamsFor && (
        <Drawer
          title={"Teams · " + teamsFor.name}
          onClose={() => setTeamsFor(null)}
          footer={
            <Button variant="secondary" onClick={() => setTeamsFor(null)}>
              Close
            </Button>
          }
        >
          {(teams.data || []).length ? (
            (teams.data || []).map((t) => {
              const ids: string[] = t.members.map((m: Row) => m.userId);
              const member = ids.includes(teamsFor.id);
              return (
                <Check
                  key={t.id}
                  label={t.name}
                  checked={member}
                  onChange={(v) =>
                    void api(
                      "teams/" + t.id,
                      {
                        name: t.name,
                        userIds: v
                          ? [...ids, teamsFor.id]
                          : ids.filter((x) => x !== teamsFor.id),
                      },
                      "PATCH",
                    )
                      .then(() => refresh("teams"))
                      .catch(notify.error)
                  }
                />
              );
            })
          ) : (
            <p className="muted small">No teams yet. Create one under Teams.</p>
          )}
        </Drawer>
      )}
      {invite && (
        <Drawer
          title="Invite User"
          onClose={() => setInvite(null)}
          footer={
            invite.url ? (
              <Button variant="secondary" onClick={() => setInvite(null)}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setInvite(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={!invite.email.includes("@")}
                  onClick={() =>
                    void api<Row>("invitations", {
                      email: invite.email.trim(),
                      role: invite.role,
                    })
                      .then((r) => setInvite({ ...invite, url: r.url }))
                      .catch(notify.error)
                  }
                >
                  Create Invitation
                </Button>
              </>
            )
          }
        >
          {invite.url ? (
            <>
              <div className="alert info">
                Share this single-use link privately. It expires in 24 hours.
              </div>
              <Field label="Invitation link">
                <input
                  readOnly
                  className="input mono"
                  value={invite.url}
                  onFocus={(e) => e.target.select()}
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Button
                variant="outline"
                onClick={() => void copyText(invite.url!).catch(notify.error)}
              >
                Copy link
              </Button>
            </>
          ) : (
            <>
              <Field label="Email" required>
                <input
                  autoFocus
                  className="input"
                  type="email"
                  value={invite.email}
                  onChange={(e) =>
                    setInvite({ ...invite, email: e.target.value })
                  }
                />
              </Field>
              <Field label="Type">
                <select
                  className="select"
                  value={invite.role}
                  onChange={(e) =>
                    setInvite({ ...invite, role: e.target.value })
                  }
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </Drawer>
      )}
    </div>
  );
}

export function Teams() {
  const teams = useApi<Row[]>("teams");
  const users = useApi<Row[]>("users");
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    userIds: string[];
  } | null>(null);
  const list = teams.data || [];
  return (
    <div className="page">
      <PageHead
        title="Teams"
        sub="Manage teams and organize your users into groups"
      >
        <Button
          variant="outline"
          onClick={() => setForm({ name: "", userIds: [] })}
        >
          <UserPlus size={17} /> Add Team
        </Button>
      </PageHead>
      <div className="card table-card">
        {list.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Members</th>
                <th style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td>
                    <b style={{ fontWeight: 600 }}>{t.name}</b>
                  </td>
                  <td className="ellipsis" style={{ maxWidth: 520 }}>
                    {t.members.map((m: Row) => m.user.name).join(", ") || "-"}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 2 }}>
                      <IconButton
                        label="Edit team"
                        size="sm"
                        onClick={() =>
                          setForm({
                            id: t.id,
                            name: t.name,
                            userIds: t.members.map((m: Row) => m.userId),
                          })
                        }
                      >
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton
                        label="Delete team"
                        size="sm"
                        danger
                        onClick={async () => {
                          if (
                            await confirmDialog(
                              "Delete Team",
                              `Delete the team “${t.name}”? Users are not deleted.`,
                              "Delete",
                              true,
                            )
                          )
                            await api("teams/" + t.id, {}, "DELETE")
                              .then(() => refresh("teams"))
                              .catch(notify.error);
                        }}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<UsersRound size={56} strokeWidth={1.5} />}
            title="No Teams Found"
          >
            Organize your users into teams to simplify access management and
            collaboration.
            <br />
            <a onClick={() => setForm({ name: "", userIds: [] })}>
              Click here
            </a>{" "}
            to create your first team.
          </Empty>
        )}
      </div>
      {form && (
        <Drawer
          title={form.id ? "Edit Team" : "New Team"}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                disabled={!form.name.trim()}
                onClick={() =>
                  void api(
                    form.id ? "teams/" + form.id : "teams",
                    { name: form.name.trim(), userIds: form.userIds },
                    form.id ? "PATCH" : "POST",
                  )
                    .then(() => {
                      setForm(null);
                      void refresh("teams");
                    })
                    .catch(notify.error)
                }
              >
                Save Team
              </Button>
            </>
          }
        >
          <Field label="Team Name" required>
            <input
              autoFocus
              className="input"
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="drawer-section">Members</div>
          {(users.data || []).map((u) => (
            <Check
              key={u.id}
              label={
                <span>
                  {u.name} <span className="muted small">{u.email}</span>
                </span>
              }
              checked={form.userIds.includes(u.id)}
              onChange={(v) =>
                setForm({
                  ...form,
                  userIds: v
                    ? [...form.userIds, u.id]
                    : form.userIds.filter((x) => x !== u.id),
                })
              }
            />
          ))}
        </Drawer>
      )}
    </div>
  );
}

function usePeople() {
  const users = useApi<Row[]>("users");
  return (id: string) => users.data?.find((u) => u.id === id)?.name || "—";
}
export function ActiveSessions() {
  const q = useApi<Row[]>("sessions", { interval: 15000 });
  const who = usePeople();
  const active = (q.data || []).filter((s) => s.status === "active");
  return (
    <div className="page">
      <PageHead
        title="Active Sessions"
        sub={`${active.length} active session(s)`}
      >
        <Button variant="outline" onClick={() => void q.refetch()}>
          <RotateCw size={16} /> Refresh
        </Button>
      </PageHead>
      <div className="card table-card">
        {active.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Server</th>
                <th>User</th>
                <th>Started</th>
                <th>Duration</th>
                <th style={{ width: 90 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id}>
                  <td>{s.server?.name}</td>
                  <td>{who(s.principalId)}</td>
                  <td>{timeAgo(s.createdAt)}</td>
                  <td>{duration(s.createdAt)}</td>
                  <td>
                    <IconButton
                      label="Terminate session"
                      size="sm"
                      danger
                      onClick={async () => {
                        if (
                          await confirmDialog(
                            "Terminate Session",
                            `End this session on ${s.server?.name}?`,
                            "Terminate",
                            true,
                          )
                        )
                          await api("sessions/" + s.id, undefined, "DELETE")
                            .then(() => refresh("sessions"))
                            .catch(notify.error);
                      }}
                    >
                      <Power size={15} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<CirclePlay size={52} strokeWidth={1.5} />}
            title="No Active Sessions"
            tall
          >
            There are currently no active connections.
          </Empty>
        )}
      </div>
    </div>
  );
}
export function SessionHistory() {
  const q = useApi<Row[]>("sessions");
  const who = usePeople();
  const [search, setSearch] = useState("");
  const rows = (q.data || []).map((s): Row => ({
    ...s,
    serverName: s.server?.name || "",
    user: who(s.principalId),
  }));
  const shown = rows.filter((r) =>
    (r.serverName + " " + r.user + " " + r.status)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const lines = [
      ["Server", "User", "Status", "Started", "Ended", "Duration"].join(","),
      ...rows.map((r) =>
        [
          r.serverName,
          r.user,
          r.status,
          r.createdAt,
          r.endedAt || "",
          duration(r.createdAt, r.endedAt),
        ]
          .map(esc)
          .join(","),
      ),
    ];
    saveFile(lines.join("\n"), "nexusssh-session-history.csv", "text/csv");
  };
  return (
    <div className="page">
      <PageHead title="Session History" sub={`${rows.length} total records`}>
        <Button variant="outline" disabled={!rows.length} onClick={exportCsv}>
          <ArrowDownToLine size={16} /> Export
        </Button>
        <Button variant="outline" onClick={() => void q.refetch()}>
          <RotateCw size={16} /> Refresh
        </Button>
      </PageHead>
      <div className="card table-card">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search history..."
        />
        {rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Server</th>
                <th>User</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>{r.serverName}</td>
                  <td>{r.user}</td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (r.status === "active"
                          ? "green"
                          : r.status === "terminated"
                            ? "red"
                            : "")
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    {duration(
                      r.createdAt,
                      r.endedAt || (r.status === "active" ? null : r.updatedAt),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<History size={52} strokeWidth={1.5} />}
            title="No Session History"
            tall
          >
            Session logs will appear here.
          </Empty>
        )}
      </div>
    </div>
  );
}

export function Security() {
  const q = useApi<Row>("settings");
  const set = (acceptNewHostKeys: boolean) => {
    const put = (v: boolean) =>
      queryClient.setQueryData<Row>(["settings"], (old) => ({
        ...old,
        acceptNewHostKeys: v,
      }));
    put(acceptNewHostKeys);
    void api("settings", { acceptNewHostKeys }, "PATCH")
      .then(() => notify.success("Security settings saved."))
      .catch((e) => {
        put(!acceptNewHostKeys);
        notify.error(e);
      });
  };
  return (
    <div className="page narrow">
      <PageHead title="Security" sub="Workspace-wide connection safeguards" />
      <div className="section-title">SSH Host Keys</div>
      <Check
        label="Accept unknown host keys automatically"
        checked={!!q.data?.acceptNewHostKeys}
        onChange={set}
      />
      <p className="small muted" style={{ lineHeight: 1.6, marginLeft: 28 }}>
        The first time anyone connects to a server without a saved host key, its
        key is trusted and saved without asking (like OpenSSH{" "}
        <span className="mono">StrictHostKeyChecking accept-new</span>). If a
        server later presents a different key, the connection is still refused
        and an administrator must confirm the new key. Servers reached through a
        jump host always ask.
      </p>
      {q.data?.acceptNewHostKeys && (
        <div className="alert info" style={{ marginTop: 14 }}>
          First connections are not verified while this is on. Turn it off once
          your servers’ keys are saved if you need every new host checked.
        </div>
      )}
    </div>
  );
}
