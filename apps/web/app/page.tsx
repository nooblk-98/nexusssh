"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { create } from "zustand";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Clock,
  Code2,
  Copy,
  Folder,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Plus,
  Trash2,
  Search,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Star,
  Moon,
  Sun,
  Terminal as TerminalIcon,
  Users,
  Workflow,
  X,
  Zap,
  RefreshCw,
  File,
} from "lucide-react";
import { Button } from "../components/ui/button";
const Terminal = dynamic(() => import("../components/terminal"), {
  ssr: false,
});
const Editor = dynamic(
  () =>
    import("@monaco-editor/react").then((m) => {
      m.loader.config({ paths: { vs: "/monaco/vs" } });
      return m.default;
    }),
  { ssr: false },
);
type Row = Record<string, any>;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const useWorkspace = create<{
  page: string;
  selected: string;
  tabs: Row[];
  setPage: (p: string) => void;
  setSelected: (id: string) => void;
  connect: (s: Row) => void;
  close: (id: string) => void;
  light: boolean;
  setLight: (light: boolean) => void;
}>((set) => ({
  page: "Dashboard",
  selected: "",
  tabs: [],
  setPage: (page) => set({ page }),
  setSelected: (selected) => set({ selected }),
  connect: (s) =>
    set((v) => ({
      page: "Terminal",
      selected: s.id,
      tabs: [...v.tabs, { ...s, tabId: crypto.randomUUID() }],
    })),
  close: (id) => set((v) => ({ tabs: v.tabs.filter((t) => t.tabId !== id) })),
  // The layout script applies the saved theme to <html> before first paint.
  light:
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("light"),
  setLight: (light) => {
    document.documentElement.classList.toggle("light", light);
    try {
      localStorage.setItem("nexus-theme", light ? "light" : "dark");
    } catch {}
    set({ light });
  },
}));
async function api(path: string, body?: unknown, method?: string) {
  const response = await fetch("/api/" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.message === "string"
        ? data.message
        : JSON.stringify(data.message || data),
    );
  return data;
}
function useApi(path: string, enabled = true, interval = false) {
  return useQuery<Row>({
    queryKey: [path],
    queryFn: () => api(path),
    enabled,
    refetchInterval: interval ? 15000 : false,
  });
}
function download(text: string, name: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const menu = [
  ["Dashboard", LayoutDashboard],
  ["Servers", Server],
  ["Terminal", TerminalIcon],
  ["File Manager", Folder],
  ["AI Agents", GitBranch],
  ["MCP Server", Code2],
  ["Automation", Workflow],
  ["Audit Logs", ShieldCheck],
  ["Team Management", Users],
  ["Settings", Settings],
] as const;
function Field({
  label,
  children,
  full = false,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className={"field" + (full ? " full" : "")}>
      {label}
      {children}
    </label>
  );
}
function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Server size={30} />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, [close]);
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="modal-title row between">
          <h2>{title}</h2>
          <Button variant="ghost" aria-label="Close dialog" onClick={close}>
            <X size={17} />
          </Button>
        </div>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
export default function Page() {
  return (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
}
function Auth({ onLogin }: { onLogin: () => void }) {
  const { data } = useApi("auth/status");
  const [invitation, setInvitation] = useState("");
  useEffect(
    () =>
      setInvitation(new URLSearchParams(location.search).get("invite") || ""),
    [],
  );
  const setup = data?.setupRequired && !invitation;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (invitation) await api("auth/invitation", { ...f, token: invitation });
      if (setup) await api("auth/setup", f);
      await api("auth/login", {
        email: f.email,
        password: f.password,
        code: f.code,
      });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-screen">
      <div className="login-art">
        <div className="brand">
          <div className="brand-icon">
            <TerminalIcon size={20} />
          </div>
          NexusSSH
        </div>
        <div>
          <div className="eyebrow">YOUR INFRASTRUCTURE. ONE WORKSPACE.</div>
          <h1>
            A closer connection
            <br />
            to your servers.
          </h1>
          <p>
            Secure shells, remote files, and carefully scoped AI access. All
            from a workspace you control.
          </p>
          <div className="row" style={{ marginTop: 35 }}>
            <ShieldCheck className="mint" size={19} />
            <span className="muted small">
              Self-hosted. Credentials stay with you.
            </span>
          </div>
        </div>
        <span className="small muted">NEXUSSSH / INFRASTRUCTURE CONSOLE</span>
      </div>
      <form className="login-form" onSubmit={submit}>
        <div>
          <div className="eyebrow">NEXUSSSH CONSOLE</div>
          <h1>
            {invitation
              ? "Join your workspace"
              : setup
                ? "Create your workspace"
                : "Welcome back"}
          </h1>
          <p className="muted" style={{ marginTop: 10 }}>
            {setup
              ? "Set up the first owner account."
              : "Sign in to your infrastructure workspace."}
          </p>
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <div>
          {setup && (
            <>
              <Field label="Workspace name">
                <input
                  required
                  name="organization"
                  autoComplete="organization"
                />
              </Field>
              <Field label="Your name">
                <input required name="name" autoComplete="name" />
              </Field>
              <Field label="Installation setup token">
                <input
                  type="password"
                  required
                  name="setupToken"
                  placeholder="Setup token (SETUP_TOKEN or API container logs)"
                />
              </Field>
            </>
          )}
          <Field label="Email address">
            <input
              required
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
            />
          </Field>
          {invitation && (
            <Field label="Your name">
              <input required name="name" />
            </Field>
          )}
          <Field label="Password">
            <input
              required
              name="password"
              type="password"
              minLength={12}
              autoComplete={setup ? "new-password" : "current-password"}
              placeholder="At least 12 characters"
            />
          </Field>
          {!setup && (
            <Field label="Authenticator code (if enabled)">
              <input
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
              />
            </Field>
          )}
          <Button disabled={busy || !data}>
            {busy ? "Please wait…" : setup ? "Create workspace" : "Sign in"}
            <ArrowRight size={16} />
          </Button>
        </div>
        <p className="footnote">
          Access is restricted to authorized workspace members. Session cookies
          are protected and SSH credentials are encrypted at rest.
        </p>
      </form>
    </div>
  );
}
function App() {
  const me = useApi("auth/me");
  const qc = useQueryClient();
  const {
    page,
    setPage,
    connect,
    selected,
    setSelected,
    tabs,
    close,
    light,
    setLight,
  } = useWorkspace();
  const [search, setSearch] = useState(""),
    [modal, setModal] = useState<ReactNode>(null),
    [error, setError] = useState(""),
    [split, setSplit] = useState(false);
  const logged = !!me.data;
  const dashboard = useApi("dashboard", logged, true);
  const servers: Row[] = dashboard.data?.servers || [];
  const groups = useApi("groups", logged);
  const folders: Row[] = Array.isArray(groups.data) ? groups.data : [];
  const isAdmin = ["owner", "administrator"].includes(me.data?.role);
  const matches = (s: Row) =>
    JSON.stringify([s.name, s.host, s.environment, s.tags, s.group])
      .toLowerCase()
      .includes(search.toLowerCase());
  const deleteFolder = (g: Row, count: number) =>
    setModal(
      <Modal title="Delete folder" close={() => setModal(null)}>
        <div className="stack">
          <p>
            Delete the folder <b>{g.name}</b>?
            {count > 0 &&
              ` Its ${count} server${count === 1 ? "" : "s"} will move to Ungrouped.`}{" "}
            No servers are deleted.
          </p>
          <div className="form-actions">
            <Button variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void api("groups/" + g.id, undefined, "DELETE")
                  .then(() => {
                    setModal(null);
                    refresh();
                  })
                  .catch(fail)
              }
            >
              Delete folder
            </Button>
          </div>
        </div>
      </Modal>,
    );
  const refresh = () => {
    void qc.invalidateQueries();
  };
  const fail = (e: unknown) => setError((e as Error).message);
  async function run(op: string, args: Row) {
    try {
      const result = await api("operations/" + op, args);
      if (result.status === "approval_required") {
        refresh();
        setPage("Audit Logs");
        setError(
          "Approval requested. Review it in the approvals panel, then retry the exact operation using its approval ID.",
        );
      }
      refresh();
      return result;
    } catch (e) {
      fail(e);
      throw e;
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  if (me.isPending) return <div className="empty">Opening your workspace…</div>;
  if (!logged)
    return (
      <Auth
        onLogin={() => {
          void qc.resetQueries();
          refresh();
        }}
      />
    );
  const openServer = (server?: Row) =>
    setModal(
      <ServerForm
        server={server}
        done={() => {
          setModal(null);
          refresh();
        }}
      />,
    );
  const current = servers.find((s) => s.id === selected) || servers[0];
  const selection = (
    <select
      aria-label="Select server"
      value={current?.id || ""}
      onChange={(e) => setSelected(e.target.value)}
    >
      <option value="" disabled>
        Select a server
      </option>
      {servers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
  const headings: Record<string, string> = {
    Dashboard: "Your infrastructure, at a glance.",
    Servers: "Every connection, in one place.",
    Terminal: "A direct line to your infrastructure.",
    "File Manager": "Browse and edit files over verified SFTP.",
    "AI Agents": "Give your agents the access they need.",
    "MCP Server": "One remote endpoint. Centralized access.",
    Automation: "Track queued operations and cancel running work.",
    "Audit Logs": "A clear record of access and decisions.",
    "Team Management": "Manage the people behind your infrastructure.",
    Settings: "Make this workspace your own.",
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <TerminalIcon size={20} />
          </div>
          NexusSSH
        </div>
        <div className="row" style={{ padding: "0 10px 10px" }}>
          <div className="avatar" style={{ borderRadius: 6 }}>
            {me.data.name[0]}
          </div>
          <div>
            <div className="small">{me.data.organization.name}</div>
            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              Private workspace
            </div>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        {menu.slice(0, 4).map(([name, Icon]) => (
          <button
            key={name}
            className={"nav-item" + (page === name ? " active" : "")}
            onClick={() => setPage(name)}
          >
            <Icon />
            {name}
          </button>
        ))}
        <div className="workspace-label">CONTROL PLANE</div>
        {menu.slice(4, 8).map(([name, Icon]) => (
          <button
            key={name}
            className={"nav-item" + (page === name ? " active" : "")}
            onClick={() => setPage(name)}
          >
            <Icon />
            {name}
          </button>
        ))}
        <div className="nav-bottom">
          {menu.slice(8).map(([name, Icon]) => (
            <button
              key={name}
              className={"nav-item" + (page === name ? " active" : "")}
              onClick={() => setPage(name)}
            >
              <Icon />
              {name}
            </button>
          ))}
          <div className="sidebar-footer row">
            <div className="avatar">{me.data.name[0]}</div>
            <div style={{ flex: 1 }}>
              <div className="small">{me.data.name}</div>
              <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                {me.data.role}
              </div>
            </div>
            <button
              aria-label="Sign out"
              className="btn-ghost"
              style={{ border: 0 }}
              onClick={() =>
                void api("auth/logout", {}).then(() => {
                  void qc.resetQueries();
                  refresh();
                })
              }
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="search-box">
            <Search size={17} />
            <input
              id="global-search"
              placeholder="Search servers…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage("Servers");
              }}
            />
            <span className="key desktop-only">⌘ K</span>
          </div>
          <select
            className="mobile-nav"
            aria-label="Navigation"
            value={page}
            onChange={(e) => setPage(e.target.value)}
          >
            {menu.map(([name]) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <div className="row">
            <span className="muted small desktop-only">
              <span className="status-dot" />
              {dashboard.data?.stats.sessions ?? 0} active sessions
            </span>
            <Button
              variant="ghost"
              aria-label={
                light ? "Switch to dark mode" : "Switch to light mode"
              }
              onClick={() => setLight(!light)}
            >
              {light ? <Moon size={17} /> : <Sun size={17} />}
            </Button>
            <Button
              variant="ghost"
              aria-label="Review pending approvals"
              onClick={() => setPage("Audit Logs")}
            >
              <Bell size={17} />
              {dashboard.data?.stats.approvals > 0 && (
                <span>{dashboard.data?.stats.approvals}</span>
              )}
            </Button>
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">WORKSPACE / {page.toUpperCase()}</div>
              <h1>{page === "Dashboard" ? "Infrastructure overview" : page}</h1>
              <p>{headings[page]}</p>
            </div>
            <div className="row">
              {page === "Dashboard" && (
                <Button variant="outline" onClick={() => setPage("MCP Server")}>
                  <Code2 size={15} />
                  MCP endpoint
                </Button>
              )}
              {["Dashboard", "Servers"].includes(page) && (
                <Button onClick={() => openServer()}>
                  <Plus size={16} />
                  Add server
                </Button>
              )}
            </div>
          </div>
          {dashboard.error && (
            <div className="error">{dashboard.error.message}</div>
          )}
          {page === "Dashboard" && (
            <>
              <div className="stats">
                {[
                  [
                    "Total servers",
                    dashboard.data?.stats.total ?? 0,
                    Server,
                    `${dashboard.data?.stats.reachable ?? 0} reachable · ${dashboard.data?.stats.unreachable ?? 0} unreachable`,
                  ],
                  [
                    "Active sessions",
                    dashboard.data?.stats.sessions ?? 0,
                    TerminalIcon,
                    "Interactive SSH connections",
                  ],
                  [
                    "AI agents",
                    dashboard.data?.stats.agents ?? 0,
                    GitBranch,
                    "Scoped infrastructure access",
                  ],
                  [
                    "Pending approvals",
                    dashboard.data?.stats.approvals ?? 0,
                    ShieldCheck,
                    "Human oversight, built in",
                  ],
                ].map(([label, value, Icon, note]) => {
                  const I = Icon as typeof Server;
                  return (
                    <div className="stat" key={String(label)}>
                      <div className="stat-label">
                        {String(label)}
                        <I size={15} />
                      </div>
                      <div className="stat-value">{String(value)}</div>
                      <div className="stat-foot">{String(note)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="dashboard-grid">
                <div className="stack">
                  <section className="panel">
                    <div className="panel-head">
                      <div className="row">
                        <h2>Your servers</h2>
                        <span className="badge">{servers.length}</span>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => setPage("Servers")}
                      >
                        View all
                        <ArrowUpRight size={14} />
                      </Button>
                    </div>
                    {servers.length ? (
                      <div className="servers-grid">
                        {servers.slice(0, 4).map((s) => (
                          <ServerCard
                            key={s.id}
                            s={s}
                            connect={() => connect(s)}
                            edit={() => openServer(s)}
                            test={() =>
                              void run("server_test_connection", {
                                serverId: s.id,
                              }).catch(() => {})
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title="Your first connection starts here"
                        body="Add a Linux server, securely store its SSH identity, and verify its host key to open your first session."
                        action={
                          <Button
                            variant="outline"
                            onClick={() => openServer()}
                          >
                            <Plus size={14} />
                            Add your first server
                          </Button>
                        }
                      />
                    )}
                  </section>
                  <ActivityPanel data={dashboard.data?.activity || []} />
                </div>
                <div className="stack" style={{ alignContent: "start" }}>
                  <section className="panel">
                    <div className="panel-head">
                      <h2>Build your workspace</h2>
                      <Zap size={15} className="mint" />
                    </div>
                    {[
                      [
                        "Connect a server",
                        "Bring your own Linux server. Verify its host key before connecting.",
                      ],
                      [
                        "Open a secure shell",
                        "Work with real interactive terminals and SFTP file access.",
                      ],
                      [
                        "Invite an AI agent",
                        "Assign servers and operations. Keep credentials on your backend.",
                      ],
                    ].map(([title, body], i) => (
                      <div className="guide-item" key={title}>
                        <div className="guide-number">{i + 1}</div>
                        <div>
                          <h3>{title}</h3>
                          <p>{body}</p>
                        </div>
                      </div>
                    ))}
                  </section>
                  <div className="callout">
                    <div className="row" style={{ marginBottom: 9 }}>
                      <ShieldCheck size={18} />
                      <b>You hold the keys.</b>
                    </div>
                    SSH identities are encrypted on your server. Agents receive
                    scoped access, never your private keys.
                    <Button
                      variant="ghost"
                      onClick={() => setPage("AI Agents")}
                    >
                      Manage agent access
                      <ArrowRight size={13} />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
          {page === "Servers" && (
            <>
              <div className="toolbar">
                <input
                  style={{ maxWidth: 300 }}
                  placeholder="Filter by name, host, tag…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    setModal(
                      <SimpleForm
                        title="Create folder"
                        fields={["name"]}
                        action={(v) => api("groups", v)}
                        done={() => {
                          setModal(null);
                          refresh();
                        }}
                      />,
                    )
                  }
                >
                  <Folder size={14} />
                  New folder
                </Button>
              </div>
              {servers.length || folders.length ? (
                <div className="stack">
                  {[...folders, { id: "", name: "Ungrouped" }].map((g) => {
                    const all = servers.filter(
                      (s) => (s.groupId || "") === g.id,
                    );
                    const shown = all.filter(matches);
                    if (!g.id && !all.length) return null;
                    if (search && !shown.length) return null;
                    return (
                      <section className="panel" key={g.id || "ungrouped"}>
                        <div className="panel-head">
                          <div className="row">
                            <Folder size={15} className="mint" />
                            <h2>{g.name}</h2>
                            <span className="badge">{all.length}</span>
                          </div>
                          {g.id && isAdmin && (
                            <Button
                              variant="ghost"
                              aria-label={"Delete folder " + g.name}
                              onClick={() => deleteFolder(g, all.length)}
                            >
                              <Trash2 size={15} />
                            </Button>
                          )}
                        </div>
                        {shown.length ? (
                          <div className="servers-grid">
                            {shown.map((s) => (
                              <ServerCard
                                key={s.id}
                                s={s}
                                connect={() => connect(s)}
                                edit={() => openServer(s)}
                                test={() =>
                                  void run("server_test_connection", {
                                    serverId: s.id,
                                  }).catch(() => {})
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="muted small" style={{ padding: 21 }}>
                            This folder is empty. Choose it as the folder when
                            adding or editing a server.
                          </p>
                        )}
                      </section>
                    );
                  })}
                  {search && !servers.some(matches) && (
                    <p className="muted small">No servers match “{search}”.</p>
                  )}
                </div>
              ) : (
                <div className="panel">
                  <Empty
                    title="No servers connected"
                    body="Add your first connection to start managing infrastructure."
                    action={
                      <Button onClick={() => openServer()}>Add server</Button>
                    }
                  />
                </div>
              )}
            </>
          )}
          {page === "Terminal" && (
            <>
              <div className="toolbar">
                {selection}
                <Button
                  disabled={!current}
                  onClick={() => current && connect(current)}
                >
                  <Plus size={14} />
                  New session
                </Button>
                <Button variant="outline" onClick={() => setSplit(!split)}>
                  Split panes
                </Button>
              </div>
              <div className="tabs">
                {tabs.map((t) => (
                  <Button
                    key={t.tabId}
                    variant="outline"
                    onClick={() => close(t.tabId)}
                  >
                    {t.name}
                    <X size={13} />
                  </Button>
                ))}
              </div>
              {tabs.length ? (
                <div className={split ? "split" : "stack"}>
                  {tabs.map((t) => (
                    <Terminal key={t.tabId} serverId={t.id} name={t.name} />
                  ))}
                </div>
              ) : (
                <div className="panel">
                  <Empty
                    title="Ready when you are"
                    body="Choose a server and open a session. Host fingerprints must be verified first."
                  />
                </div>
              )}
            </>
          )}
          {page === "File Manager" && (
            <>
              <div className="toolbar">{selection}</div>
              {current ? (
                <FileManager key={current.id} server={current} run={run} />
              ) : (
                <Empty
                  title="No server selected"
                  body="Add a server to browse its permitted files."
                />
              )}
            </>
          )}
          {page === "AI Agents" && (
            <Agents
              open={setModal}
              close={() => setModal(null)}
              refresh={refresh}
              servers={servers}
            />
          )}
          {page === "MCP Server" && <Mcp />}
          {page === "Audit Logs" && <Audit run={run} />}
          {page === "Team Management" && (
            <Team
              open={setModal}
              close={() => setModal(null)}
              refresh={refresh}
              servers={servers}
            />
          )}
          {page === "Settings" && <Preferences />}
          {page === "Automation" && <Tasks run={run} />}
        </main>
      </div>
      {modal}
      {error && (
        <div role="alert" className="error toast">
          <div className="row between">
            <span>{error}</span>
            <Button
              aria-label="Dismiss message"
              variant="ghost"
              onClick={() => setError("")}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
function ServerCard({
  s,
  connect,
  edit,
  test,
}: {
  s: Row;
  connect: () => void;
  edit: () => void;
  test: () => void;
}) {
  return (
    <article className="server-card">
      <div className="row between">
        <div className="server-icon">
          <Server size={19} />
        </div>
        <div className="row">
          {s.favorite && <Star size={13} className="mint" />}
          <span className={"badge " + s.status}>{s.status}</span>
          <Button variant="ghost" aria-label={"Edit " + s.name} onClick={edit}>
            <MoreHorizontal size={16} />
          </Button>
        </div>
      </div>
      <div>
        <h2>{s.name}</h2>
        <div className="muted mono small" style={{ marginTop: 7 }}>
          {s.username}@{s.host}:{s.port}
        </div>
      </div>
      <div className="row">
        <span className={"badge " + s.environment}>{s.environment}</span>
        {s.group && <span className="badge">{s.group.name}</span>}
        {s.tags?.slice(0, 2).map((t: Row) => (
          <span key={t.id} className="badge">
            {t.name}
          </span>
        ))}
      </div>
      <div className="card-footer">
        <button
          className="btn-ghost small"
          style={{ border: 0 }}
          onClick={test}
        >
          Test connection
        </button>
        <Button variant="outline" onClick={connect}>
          <TerminalIcon size={13} />
          Connect
        </Button>
      </div>
    </article>
  );
}
function ActivityPanel({ data }: { data: Row[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent activity</h2>
        <span className="muted small">Live workspace events</span>
      </div>
      {data.length ? (
        <table className="activity">
          <thead>
            <tr>
              <th>EVENT</th>
              <th>STATUS</th>
              <th>TIME</th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className="status-dot" />
                  {a.action.replaceAll("_", " ")}
                </td>
                <td>
                  <span className="badge">{a.status}</span>
                </td>
                <td className="muted">
                  {new Date(a.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty
          title="A clean slate"
          body="Connection, execution, and access events will appear here."
        />
      )}
    </section>
  );
}
function ServerForm({ server, done }: { server?: Row; done: () => void }) {
  const identities = useApi("identities"),
    groups = useApi("groups");
  const [mode, setMode] = useState("existing"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      let identityId = String(f.identityId);
      if (mode !== "existing") {
        const identity = await api("identities", {
          name: f.name + " identity",
          kind: mode,
          password: mode === "password" ? f.password : undefined,
          privateKey: mode === "key" ? f.privateKey : undefined,
          passphrase: mode === "key" ? f.passphrase : undefined,
        });
        identityId = identity.id;
      }
      const data = {
        name: f.name,
        host: f.host,
        port: Number(f.port),
        username: f.username,
        identityId,
        fingerprint: f.fingerprint || null,
        fileRoot: f.fileRoot,
        environment: f.environment,
        description: f.description || "",
        groupId: f.groupId || null,
        tags: String(f.tags || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        favorite: f.favorite === "on",
        bastionId: server?.bastionId || null,
        archived: false,
      };
      await api(
        server ? "servers/" + server.id : "servers",
        data,
        server ? "PATCH" : "POST",
      );
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={server ? "Edit connection" : "Add a server"} close={done}>
      <form onSubmit={submit} className="stack">
        {error && <div className="error">{error}</div>}
        <div className="form-grid">
          <Field label="Connection name">
            <input
              autoFocus
              name="name"
              required
              defaultValue={server?.name}
              placeholder="production-web-01"
            />
          </Field>
          <Field label="Environment">
            <select
              name="environment"
              defaultValue={server?.environment || "development"}
            >
              <option>development</option>
              <option>staging</option>
              <option>production</option>
            </select>
          </Field>
          <Field label="Hostname or IP">
            <input
              required
              name="host"
              defaultValue={server?.host}
              placeholder="10.20.0.10"
            />
          </Field>
          <Field label="SSH port">
            <input
              required
              type="number"
              name="port"
              min={1}
              max={65535}
              defaultValue={server?.port || 22}
            />
          </Field>
          <Field label="SSH username">
            <input
              required
              name="username"
              defaultValue={server?.username}
              placeholder="nexus"
            />
          </Field>
          <Field label="Permitted file root">
            <input
              required
              name="fileRoot"
              defaultValue={server?.fileRoot || "/home/nexus"}
            />
          </Field>
          <Field label="Authentication">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="existing">Saved identity</option>
              <option value="password">New password identity</option>
              <option value="key">New private key identity</option>
            </select>
          </Field>
          {mode === "existing" ? (
            <Field label="Identity">
              <select
                required
                name="identityId"
                defaultValue={server?.identityId}
              >
                <option value="">Choose identity</option>
                {((identities.data as unknown as Row[]) || []).map((i) => (
                  <option value={i.id} key={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : mode === "password" ? (
            <Field label="SSH password">
              <input
                required
                type="password"
                name="password"
                autoComplete="off"
              />
            </Field>
          ) : (
            <>
              <Field label="Private key" full>
                <textarea
                  required
                  name="privateKey"
                  spellCheck={false}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
              <Field label="Key passphrase">
                <input type="password" name="passphrase" autoComplete="off" />
              </Field>
            </>
          )}
          <Field label="Verified host key fingerprint" full>
            <input
              name="fingerprint"
              defaultValue={server?.fingerprint || ""}
              placeholder="SHA256:…"
            />
            <span className="small">
              Verify through your server console or administrator. Unknown and
              changed keys are rejected.
            </span>
          </Field>
          <Field label="Folder">
            <select name="groupId" defaultValue={server?.groupId || ""}>
              <option value="">Ungrouped</option>
              {((groups.data as unknown as Row[]) || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tags, separated by commas">
            <input
              name="tags"
              defaultValue={server?.tags?.map((t: Row) => t.name).join(", ")}
            />
          </Field>
          <Field label="Description" full>
            <input name="description" defaultValue={server?.description} />
          </Field>
          <label className="row small muted">
            <input
              style={{ width: "auto" }}
              type="checkbox"
              name="favorite"
              defaultChecked={server?.favorite}
            />
            Favorite connection
          </label>
        </div>
        <div className="form-actions">
          {server && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (
                  confirm(
                    "Archive this server? Existing audit records will be retained.",
                  )
                )
                  void api("servers/" + server.id, {}, "DELETE")
                    .then(done)
                    .catch((e) => setError(e.message));
              }}
            >
              Archive
            </Button>
          )}
          {server && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void api("servers/" + server.id + "/duplicate", {})
                  .then(done)
                  .catch((e) => setError(e.message))
              }
            >
              Duplicate
            </Button>
          )}
          <Button disabled={busy}>
            {busy ? "Saving…" : "Save connection"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function SimpleForm({
  title,
  fields,
  action,
  done,
}: {
  title: string;
  fields: string[];
  action: (v: Row) => Promise<unknown>;
  done: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title={title} close={done}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void action(Object.fromEntries(new FormData(e.currentTarget)))
            .then(done)
            .catch((e) => setError(e.message));
        }}
      >
        {error && <div className="error">{error}</div>}
        {fields.map((f) => (
          <Field key={f} label={f}>
            <input
              name={f}
              required
              type={f.toLowerCase().includes("password") ? "password" : "text"}
            />
          </Field>
        ))}
        <Button>Save</Button>
      </form>
    </Modal>
  );
}
type Run = (op: string, args: Row) => Promise<Row>;
function FileManager({ server, run }: { server: Row; run: Run }) {
  const light = useWorkspace((s) => s.light);
  const [path, setPath] = useState(server.fileRoot),
    [entries, setEntries] = useState<Row[]>([]),
    [file, setFile] = useState(""),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [approval, setApproval] = useState("");
  async function browse(target = path) {
    setBusy(true);
    try {
      const r = await run("ssh_list_directory", {
        serverId: server.id,
        path: target,
      });
      setEntries(r.entries || []);
      setPath(target);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function read(target: string) {
    setBusy(true);
    try {
      const r = await run("ssh_read_file", {
        serverId: server.id,
        path: target,
      });
      setFile(target);
      setText(r.content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const args = (extra: Row) => ({
    serverId: server.id,
    ...extra,
    ...(approval ? { approvalId: approval } : {}),
  });
  async function mutate(op: string, extra: Row) {
    setBusy(true);
    try {
      const r = await run(op, args(extra));
      if (r.status === "completed") {
        setApproval("");
        await browse();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ext = file.split(".").pop() || "";
  const languages: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    php: "php",
    html: "html",
    css: "css",
    sh: "shell",
    conf: "ini",
  };
  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      <div className="toolbar">
        <input
          aria-label="Remote path"
          style={{ flex: 1 }}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <Button disabled={busy} onClick={() => void browse()}>
          <RefreshCw size={14} />
          Browse
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const name = prompt("New directory name");
            if (name)
              void mutate("ssh_create_directory", { path: path + "/" + name });
          }}
        >
          New folder
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const name = prompt("New file name");
            if (name) {
              setFile(path + "/" + name);
              setText("");
            }
          }}
        >
          New file
        </Button>
      </div>
      <div className="panel file-layout">
        <div className="file-list">
          <div className="panel-head">
            <h3>Files</h3>
            <span className="small muted">{entries.length} entries</span>
          </div>
          {path !== server.fileRoot && (
            <button
              className="file-row"
              onClick={() =>
                void browse(path.split("/").slice(0, -1).join("/") || "/")
              }
            >
              ../ Parent directory
            </button>
          )}
          {entries.map((f) => (
            <button
              key={f.name}
              className="file-row"
              onClick={() =>
                f.directory
                  ? void browse(path + "/" + f.name)
                  : void read(path + "/" + f.name)
              }
            >
              {f.directory ? <Folder size={15} /> : <File size={15} />}
              <span style={{ flex: 1 }}>{f.name}</span>
              <span
                className="muted"
                title={"Permissions: " + (f.mode & 0o777).toString(8)}
              >
                {f.directory ? "dir" : f.size + " B"}
              </span>
            </button>
          ))}
          {!entries.length && (
            <div className="empty">Browse to load remote files.</div>
          )}
        </div>
        <div className="file-editor">
          <div className="panel-head">
            <h3 className="mono small">{file || "Select a text file"}</h3>
            <Button
              disabled={!file || busy}
              onClick={() =>
                void mutate("ssh_write_file", { path: file, content: text })
              }
            >
              Save file
            </Button>
          </div>
          {file ? (
            <Editor
              height="420px"
              theme={light ? "vs" : "vs-dark"}
              language={languages[ext] || "plaintext"}
              value={text}
              onChange={(v) => setText(v || "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                automaticLayout: true,
              }}
            />
          ) : (
            <Empty
              title="Your remote editor"
              body="Open a file to edit. Changes require approval and use atomic writes."
            />
          )}
        </div>
      </div>
      <div className="toolbar">
        <input
          style={{ maxWidth: 340 }}
          aria-label="Approval ID"
          placeholder="Approval ID for an approved retry"
          value={approval}
          onChange={(e) => setApproval(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={!file}
          onClick={() =>
            void run("ssh_download_file", { serverId: server.id, path: file })
              .then((r) => {
                const bytes = Uint8Array.from(atob(r.content), (c) =>
                  c.charCodeAt(0),
                );
                const u = URL.createObjectURL(new Blob([bytes]));
                const a = document.createElement("a");
                a.href = u;
                a.download = file.split("/").pop()!;
                a.click();
                URL.revokeObjectURL(u);
              })
              .catch(() => {})
          }
        >
          <ArrowDownToLine size={14} />
          Download
        </Button>
        <Button
          variant="outline"
          disabled={!file}
          onClick={() => {
            const destination = prompt("Absolute destination", file);
            if (destination)
              void mutate("ssh_rename_file", { path: file, destination });
          }}
        >
          Rename / move
        </Button>
        <Button
          variant="destructive"
          disabled={!file}
          onClick={() => {
            if (confirm("Request approval to delete " + file + "?"))
              void mutate("ssh_delete_file", { path: file });
          }}
        >
          Delete
        </Button>
        <label className="btn btn-outline">
          Upload
          <input
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 1048576) {
                setError("Maximum transfer size is 1 MiB");
                return;
              }
              const reader = new FileReader();
              reader.onload = () =>
                void mutate("ssh_upload_file", {
                  path: path + "/" + f.name,
                  content: String(reader.result).split(",")[1],
                  encoding: "base64",
                });
              reader.readAsDataURL(f);
            }}
          />
        </label>
      </div>
      <p className="footnote">
        Restricted root: {server.fileRoot}. Transfers are bounded to 1 MiB. SFTP
        operations remain subject to the remote account’s filesystem
        permissions.
      </p>
    </div>
  );
}
function Agents({
  open,
  close,
  refresh,
  servers,
}: {
  open: (v: ReactNode) => void;
  close: () => void;
  refresh: () => void;
  servers: Row[];
}) {
  const q = useApi("agents");
  const [token, setToken] = useState(""),
    [error, setError] = useState("");
  const create = () =>
    open(
      <AgentForm
        servers={servers}
        done={(v) => {
          if (v) setToken(v.token);
          close();
          refresh();
        }}
      />,
    );
  return (
    <div className="stack">
      {q.error && <div className="error">{q.error.message}</div>}
      {error && <div className="error">{error}</div>}
      <div className="row between">
        <div className="callout" style={{ flex: 1 }}>
          Agents can only reach assigned servers through explicitly granted
          tools. Every change requires human approval.
        </div>
        <Button onClick={create}>
          <Plus size={14} />
          Register agent
        </Button>
      </div>
      {token && (
        <section className="panel panel-body stack">
          <h2>Copy this machine credential now</h2>
          <p className="muted small">
            It is only shown once. Keep it in your client’s secret store.
          </p>
          <code style={{ overflowWrap: "anywhere" }}>{token}</code>
          <div className="row">
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(token)}
            >
              <Copy size={14} />
              Copy
            </Button>
            <Button variant="ghost" onClick={() => setToken("")}>
              Dismiss
            </Button>
          </div>
        </section>
      )}
      <div className="panel">
        {Array.isArray(q.data) && q.data.length ? (
          <table className="activity">
            <thead>
              <tr>
                <th>AGENT</th>
                <th>ACCESS</th>
                <th>LAST ACTIVE</th>
                <th>STATUS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((a: Row) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.name}</b>
                    <div className="muted small">{a.id}</div>
                  </td>
                  <td>
                    {a.level} · {a.permissions.length} servers
                  </td>
                  <td>
                    {a.lastActivityAt
                      ? new Date(a.lastActivityAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td>
                    <span className="badge">
                      {a.revoked ? "Revoked" : "Active"}
                    </span>
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={a.revoked}
                      onClick={() => {
                        if (confirm("Revoke all access for " + a.name + "?"))
                          void api("agents/" + a.id, {}, "DELETE")
                            .then(refresh)
                            .catch((e) => setError(e.message));
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
            title="No agents registered"
            body="Create a dedicated identity for each assistant or automation. Assign only the tools and servers it needs."
          />
        )}
      </div>
    </div>
  );
}
function AgentForm({
  servers,
  done,
}: {
  servers: Row[];
  done: (v?: Row) => void;
}) {
  const settings = useApi("settings");
  const [error, setError] = useState("");
  return (
    <Modal title="Register an AI agent" close={() => done()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void api("agents", {
            name: f.get("name"),
            level: f.get("level"),
            expiresInDays: Number(f.get("days")),
            serverIds: f.getAll("server"),
            operations: f.getAll("operation"),
          })
            .then(done)
            .catch((e) => setError(e.message));
        }}
      >
        {error && <div className="error">{error}</div>}
        <Field label="Agent name">
          <input
            required
            name="name"
            placeholder="Infrastructure monitoring agent"
          />
        </Field>
        <div className="form-grid">
          <Field label="Permission level">
            <select name="level">
              <option>viewer</option>
              <option>operator</option>
              <option>administrator</option>
              <option>custom</option>
            </select>
          </Field>
          <Field label="Expires after (days)">
            <input
              name="days"
              type="number"
              min={1}
              max={90}
              defaultValue={30}
            />
          </Field>
        </div>
        <h3>Assigned servers</h3>
        <div className="check-list">
          {servers.map((s) => (
            <label key={s.id}>
              <input type="checkbox" name="server" value={s.id} />
              {s.name}
            </label>
          ))}
        </div>
        <h3>Allowed operations</h3>
        <div className="check-list">
          {settings.data?.operations
            .filter((o: string) => o !== "terminal")
            .map((o: string) => (
              <label key={o}>
                <input type="checkbox" name="operation" value={o} />
                {o.replaceAll("_", " ")}
              </label>
            ))}
        </div>
        <Button>Create scoped credential</Button>
      </form>
    </Modal>
  );
}
function Mcp() {
  const q = useApi("settings");
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Remote MCP gateway</h2>
          <span className="badge reachable">Streamable HTTP</span>
        </div>
        <div className="panel-body stack">
          <Field label="Endpoint">
            <div className="row">
              <input readOnly value={q.data?.endpoint || ""} />
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard.writeText(q.data?.endpoint || "")
                }
              >
                <Copy size={15} />
                Copy
              </Button>
            </div>
          </Field>
          <div className="form-grid">
            <div className="callout">
              <b>Modern protocol</b>
              <br />
              2026-07-28, with explicit per-request transport setup.
            </div>
            <div className="callout">
              <b>Machine authentication</b>
              <br />
              Scoped, expiring bearer credentials with immediate revocation.
            </div>
          </div>
          <h3>Connect a compatible client</h3>
          <p className="muted">
            Register an agent, assign its servers and tools, and configure the
            endpoint with its bearer token. No local SSH tools or private keys
            are required.
          </p>
          <pre className="output">
            {JSON.stringify(
              {
                mcpServers: {
                  nexusssh: {
                    url: q.data?.endpoint,
                    headers: { Authorization: "Bearer <agent-token>" },
                  },
                },
              },
              null,
              2,
            )}
          </pre>
          <p className="footnote">
            Configuration varies by client. This illustrates the endpoint and
            header requirements; it is not a universal client configuration. See
            docs/CLIENTS.md for tested SDK usage and client support limits.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Available operations</h2>
          <span className="muted small">
            Backend permission checks apply to every call
          </span>
        </div>
        <div className="panel-body check-list">
          {q.data?.operations
            .filter((o: string) => o !== "terminal")
            .map((o: string) => (
              <span key={o} className="mono small muted">
                {o}
              </span>
            ))}
        </div>
      </section>
    </div>
  );
}
function Audit({ run }: { run: Run }) {
  const q = useApi("audit", true, true),
    approvals = useApi("approvals", true, true);
  const qc = useQueryClient();
  const [error, setError] = useState("");
  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      <section className="panel">
        <div className="panel-head">
          <h2>Approval requests</h2>
          <ShieldCheck size={17} />
        </div>
        <div className="panel-body stack">
          {Array.isArray(approvals.data) && approvals.data.length ? (
            approvals.data.map((a: Row) => (
              <div key={a.id} className="server-card">
                <div className="row between">
                  <h3>
                    {a.operation.replaceAll("_", " ")} · {a.server.name}
                  </h3>
                  <span className="badge">
                    {new Date(a.expiresAt) < new Date() &&
                    a.status === "pending"
                      ? "expired"
                      : a.status}
                  </span>
                </div>
                <pre className="output">{JSON.stringify(a.args, null, 2)}</pre>
                <div className="small muted">
                  Principal: {a.principalId}
                  <br />
                  Expires: {new Date(a.expiresAt).toLocaleString()}
                </div>
                <div className="row">
                  <Button
                    variant="outline"
                    onClick={() => void navigator.clipboard.writeText(a.id)}
                  >
                    Copy approval ID
                  </Button>
                  {a.status === "pending" &&
                    ["approved", "rejected"].map((decision) => (
                      <Button
                        key={decision}
                        variant={
                          decision === "approved" ? "default" : "outline"
                        }
                        onClick={() =>
                          void api("approvals/" + a.id, { decision })
                            .then(() => qc.invalidateQueries())
                            .catch((e) => setError(e.message))
                        }
                      >
                        {decision === "approved" ? "Approve" : "Reject"}
                      </Button>
                    ))}
                  {a.status === "approved" && (
                    <Button
                      onClick={() =>
                        void run(a.operation, {
                          ...a.args,
                          approvalId: a.id,
                        }).catch(() => {})
                      }
                    >
                      Execute as requester
                    </Button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No approval requests.</p>
          )}
        </div>
      </section>
      {q.error && <div className="error">{q.error.message}</div>}
      <div className="row between">
        <h2>Audit history</h2>
        <Button
          variant="outline"
          onClick={() =>
            download(
              JSON.stringify(q.data, null, 2),
              "nexusssh-audit.json",
              "application/json",
            )
          }
        >
          Export visible events
        </Button>
      </div>
      <ActivityPanel data={Array.isArray(q.data) ? q.data : []} />
    </div>
  );
}
function Team({
  open,
  close,
  refresh,
  servers,
}: {
  open: (v: ReactNode) => void;
  close: () => void;
  refresh: () => void;
  servers: Row[];
}) {
  const q = useApi("users"),
    teams = useApi("teams");
  const [error, setError] = useState(""),
    [invite, setInvite] = useState("");
  return (
    <div className="stack">
      {q.error && <div className="error">{q.error.message}</div>}
      {error && <div className="error">{error}</div>}
      <div>
        <Button
          onClick={() =>
            open(
              <SimpleForm
                title="Create workspace member"
                fields={["name", "email", "password", "role"]}
                action={(v) => api("users", v)}
                done={() => {
                  close();
                  refresh();
                }}
              />,
            )
          }
        >
          <Plus size={14} />
          Add member
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            open(
              <SimpleForm
                title="Invite a member"
                fields={["email", "role"]}
                action={async (v) => {
                  const result = await api("invitations", v);
                  setInvite(result.url);
                }}
                done={() => {
                  close();
                  refresh();
                }}
              />,
            )
          }
        >
          Create invitation
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            open(
              <SimpleForm
                title="Create a team"
                fields={["name"]}
                action={(v) => api("teams", { ...v, userIds: [] })}
                done={() => {
                  close();
                  refresh();
                }}
              />,
            )
          }
        >
          New team
        </Button>
      </div>
      {invite && (
        <div className="callout">
          Share this single-use invitation privately. It expires in 24 hours.
          <input readOnly value={invite} />
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(invite)}
          >
            Copy invitation
          </Button>
        </div>
      )}
      {Array.isArray(teams.data) && teams.data.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Teams</h2>
          </div>
          <div className="panel-body">
            {teams.data.map((t: Row) => (
              <div className="row between" key={t.id}>
                <span>
                  {t.name} · {t.members.length} members
                </span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void api("teams/" + t.id, {}, "DELETE")
                      .then(refresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="muted small">
        Roles: administrator, operator, viewer. New operators and viewers need
        explicit server assignments.
      </p>
      <div className="panel">
        <table className="activity">
          <thead>
            <tr>
              <th>MEMBER</th>
              <th>ROLE</th>
              <th>ACCESS</th>
            </tr>
          </thead>
          <tbody>
            {Array.isArray(q.data) &&
              q.data.map((u: Row) => (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td>{u.role}</td>
                  <td>
                    <div className="row">
                      <span className="badge">
                        {u.disabled ? "Disabled" : "Active"}
                      </span>
                      {u.role !== "owner" && (
                        <>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void api(
                                "users/" + u.id,
                                { disabled: !u.disabled, role: u.role },
                                "PATCH",
                              )
                                .then(refresh)
                                .catch((e) => setError(e.message))
                            }
                          >
                            {u.disabled ? "Enable" : "Disable"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              open(
                                <PermissionForm
                                  user={u}
                                  servers={servers}
                                  done={() => {
                                    close();
                                    refresh();
                                  }}
                                />,
                              )
                            }
                          >
                            Assign server
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function PermissionForm({
  user,
  servers,
  done,
}: {
  user: Row;
  servers: Row[];
  done: () => void;
}) {
  const settings = useApi("settings"),
    [error, setError] = useState("");
  return (
    <Modal title={"Server access · " + user.name} close={done}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void api("users/" + user.id + "/permissions", {
            serverId: f.get("serverId"),
            operations: f.getAll("operation"),
          })
            .then(done)
            .catch((e) => setError(e.message));
        }}
      >
        {error && <div className="error">{error}</div>}
        <Field label="Server">
          <select name="serverId">
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="check-list">
          {settings.data?.operations.map((o: string) => (
            <label key={o}>
              <input type="checkbox" name="operation" value={o} />
              {o}
            </label>
          ))}
        </div>
        <p className="footnote">
          Saving replaces this member’s grants for the selected server.
          Selecting no operations revokes access.
        </p>
        <Button>Save permissions</Button>
      </form>
    </Modal>
  );
}
function Preferences() {
  const q = useApi("settings");
  const [mfa, setMfa] = useState<Row | null>(null),
    [code, setCode] = useState(""),
    [message, setMessage] = useState("");
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Account security</h2>
          <Shield size={17} />
        </div>
        <div className="panel-body stack">
          <h3>Authenticator app</h3>
          <p className="muted small">
            Enable TOTP to require a one-time code at sign-in. Keep your
            authenticator secret in a secure recovery vault.
          </p>
          <Button
            style={{ width: "fit-content" }}
            onClick={() =>
              void api("auth/mfa/prepare", {})
                .then(setMfa)
                .catch((e) => setMessage(e.message))
            }
          >
            Set up MFA
          </Button>
          {mfa && (
            <>
              <Field label="Authenticator secret">
                <input readOnly value={mfa.secret} />
              </Field>
              <Field label="Six-digit code">
                <input value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Button
                onClick={() =>
                  void api("auth/mfa/enable", {
                    challenge: mfa.challenge,
                    code,
                  })
                    .then(() => {
                      setMfa(null);
                      setMessage("MFA enabled.");
                    })
                    .catch((e) => setMessage(e.message))
                }
              >
                Verify and enable
              </Button>
            </>
          )}
          {message && <div className="callout">{message}</div>}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Workspace safeguards</h2>
        </div>
        <div className="panel-body">
          <pre className="output">
            {JSON.stringify(
              {
                terminalRecording: "disabled",
                maximumSessions: q.data?.sessionLimit,
                transferLimitBytes: q.data?.fileLimit,
                protocol: q.data?.protocol,
                database: "SQLite · API-owned",
                hostVerification: "required",
              },
              null,
              2,
            )}
          </pre>
          <p className="footnote">
            Network allowlists, encryption keys, TLS, and retention settings are
            configured by the deployment administrator in the environment
            configuration.
          </p>
        </div>
      </section>
    </div>
  );
}
function Tasks({ run }: { run: Run }) {
  const [id, setId] = useState(""),
    [result, setResult] = useState<Row | null>(null);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Background operations</h2>
        <Clock size={17} />
      </div>
      <div className="panel-body stack">
        <p className="muted">
          MCP and API callers can submit operations with{" "}
          <code>async: true</code>. Use the returned task ID to inspect or
          cancel your task.
        </p>
        <Field label="Task ID">
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        <div className="row">
          <Button
            onClick={() =>
              void run("task_status", { taskId: id })
                .then(setResult)
                .catch(() => {})
            }
          >
            Check status
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void run("task_cancel", { taskId: id })
                .then(setResult)
                .catch(() => {})
            }
          >
            Cancel task
          </Button>
        </div>
        {result && (
          <pre className="output">{JSON.stringify(result, null, 2)}</pre>
        )}
        <p className="footnote">
          Cancellation closes the SSH channel. Processes detached on the remote
          server may continue. Scheduled runbooks are not included in this
          release.
        </p>
      </div>
    </section>
  );
}
