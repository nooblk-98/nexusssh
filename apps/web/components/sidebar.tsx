"use client";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  Folder,
  Menu,
  Plus,
} from "lucide-react";
import {
  api,
  copyText,
  notify,
  queryClient,
  refresh,
  useApi,
  type Row,
} from "../lib/api";
import { navigate } from "../lib/router";
import { connectServer, updateServer, useServers } from "../lib/servers";
import { useWorkspace } from "../lib/store";
import { ServerIcon } from "./icons";
import { openImportExport } from "./import-export";
import { openServerDrawer } from "./server-drawer";
import {
  confirmDialog,
  IconButton,
  Logo,
  openMenu,
  openMenuAt,
  promptDialog,
  SearchInput,
  type MenuItem,
} from "./ui";

const FOLDERS_KEY = "nexus-closed-folders";
export async function newFolder() {
  const name = await promptDialog("New Folder", "Folder name", "", "Create");
  if (name)
    await api("groups", { name })
      .then(() => refresh("groups"))
      .catch(notify.error);
}
export function signOut() {
  void api("auth/logout", {}).then(() => {
    useWorkspace.setState({ tabs: [], active: null, broadcast: [] });
    void queryClient.resetQueries();
  });
}
export function mainMenu(admin: boolean): MenuItem[] {
  const go = (p: string) => () => navigate("/settings/" + p);
  return [
    { label: "Account", onClick: go("account") },
    { label: "Preferences", onClick: go("preferences") },
    ...(admin ? [{ label: "Identities", onClick: go("identities") }] : []),
    ...(admin ? [{ label: "VPN", onClick: go("vpn") }] : []),
    "sep",
    ...(admin
      ? ([
          { label: "Users", onClick: go("users") },
          { label: "Teams", onClick: go("teams") },
        ] as MenuItem[])
      : []),
    { label: "Active Sessions", onClick: go("active-sessions") },
    { label: "History", onClick: go("history") },
    ...(admin ? [{ label: "Security", onClick: go("security") }] : []),
    "sep",
    { label: "MCP Server", onClick: go("mcp") },
    ...(admin
      ? ([
          { label: "AI Agents", onClick: go("agents") },
          { label: "Approvals", onClick: go("approvals") },
          { label: "Audit Log", onClick: go("audit") },
        ] as MenuItem[])
      : []),
    "sep",
    { label: "Logout", onClick: signOut },
  ];
}
export function Sidebar({ me }: { me: Row }) {
  const admin = ["owner", "administrator"].includes(me.role);
  const { servers, groups } = useServers();
  const { selected, select, setCollapsed } = useWorkspace();
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<string[]>([]);
  const [drop, setDrop] = useState<string | null>(null);
  useEffect(() => {
    try {
      setClosed(JSON.parse(localStorage.getItem(FOLDERS_KEY) || "[]"));
    } catch {}
  }, []);
  const toggle = (id: string) => {
    const next = closed.includes(id)
      ? closed.filter((c) => c !== id)
      : [...closed, id];
    setClosed(next);
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
    } catch {}
  };
  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      servers.filter(
        (s) =>
          !q ||
          [
            s.name,
            s.host,
            s.username,
            s.description,
            ...(s.tags || []).map((t: Row) => t.name),
          ]
            .join(" ")
            .toLowerCase()
            .includes(q),
      ),
    [servers, q],
  );
  const serverMenu = (s: Row): MenuItem[] => [
    { label: "Connect", onClick: () => connectServer(s) },
    { label: "Open SFTP", onClick: () => connectServer(s, "sftp") },
    {
      label: "Copy to Clipboard",
      items: [
        {
          label: "Name",
          onClick: () => void copyText(s.name).catch(notify.error),
        },
        {
          label: "Address",
          onClick: () => void copyText(s.host).catch(notify.error),
        },
        {
          label: "SSH command",
          onClick: () =>
            void copyText(
              `ssh ${s.port === 22 ? "" : "-p " + s.port + " "}${s.username}@${s.host}`,
            ).catch(notify.error),
        },
      ],
    },
    ...(admin
      ? ([
          "sep",
          {
            label: "Rename",
            onClick: async () => {
              const name = await promptDialog(
                "Rename Server",
                "Display name",
                s.name,
                "Rename",
              );
              if (name && name !== s.name) await updateServer(s, { name });
            },
          },
          {
            label: "Duplicate",
            onClick: () =>
              void api("servers/" + s.id + "/duplicate", {})
                .then(() => refresh("servers"))
                .catch(notify.error),
          },
          {
            label: "Delete",
            onClick: async () => {
              if (
                await confirmDialog(
                  "Delete Server",
                  <>
                    Delete <b>{s.name}</b>? It is archived so audit history
                    keeps its references.
                  </>,
                  "Delete",
                  true,
                )
              )
                await api("servers/" + s.id, {}, "DELETE")
                  .then(() => refresh("servers"))
                  .catch(notify.error);
            },
          },
          "sep",
          {
            label: "Properties",
            onClick: () => openServerDrawer({ server: s }),
          },
        ] as MenuItem[])
      : []),
  ];
  const folderMenu = (g: Row, list: Row[]): MenuItem[] => [
    {
      label: "Connect",
      disabled: !list.length,
      onClick: () => list.forEach((s) => connectServer(s)),
    },
    ...(admin
      ? ([
          {
            label: "New Server",
            onClick: () => openServerDrawer({ groupId: g.id }),
          },
          { label: "New Folder", onClick: newFolder },
          "sep",
          {
            label: "Rename",
            onClick: async () => {
              const name = await promptDialog(
                "Rename Folder",
                "Folder name",
                g.name,
                "Rename",
              );
              if (name && name !== g.name)
                await api("groups/" + g.id, { name }, "PATCH")
                  .then(() => refresh("groups"))
                  .catch(notify.error);
            },
          },
          {
            label: "Delete",
            onClick: async () => {
              if (
                await confirmDialog(
                  "Delete Folder",
                  <>
                    Delete the folder <b>{g.name}</b>?
                    {list.length > 0 &&
                      ` Its ${list.length} server${list.length === 1 ? "" : "s"} move to the top level.`}{" "}
                    No servers are deleted.
                  </>,
                  "Delete",
                  true,
                )
              )
                await api("groups/" + g.id, undefined, "DELETE")
                  .then(() => refresh("groups", "servers"))
                  .catch(notify.error);
            },
          },
        ] as MenuItem[])
      : []),
  ];
  const onDrop = (e: DragEvent, groupId: string | null) => {
    e.preventDefault();
    setDrop(null);
    const s = servers.find(
      (x) => x.id === e.dataTransfer.getData("text/server"),
    );
    if (s && (s.groupId || null) !== groupId) void updateServer(s, { groupId });
  };
  const dropProps = (key: string, groupId: string | null) =>
    admin
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes("text/server")) return;
            e.preventDefault();
            setDrop(key);
          },
          onDragLeave: () => setDrop((d) => (d === key ? null : d)),
          onDrop: (e: DragEvent) => onDrop(e, groupId),
        }
      : {};
  const serverRow = (s: Row) => (
    <button
      key={s.id}
      className={"tree-server" + (selected === s.id ? " selected" : "")}
      draggable={admin}
      onDragStart={(e) => e.dataTransfer.setData("text/server", s.id)}
      onClick={() => select(s.id)}
      onDoubleClick={() => connectServer(s)}
      onKeyDown={(e) => e.key === "Enter" && connectServer(s)}
      onContextMenu={(e) => {
        e.preventDefault();
        select(s.id);
        openMenu(e.clientX, e.clientY, serverMenu(s));
      }}
    >
      <span className="srv-icon">
        <ServerIcon name={s.icon} />
      </span>
      <span className="grow">
        <div className="srv-name ellipsis">{s.name}</div>
        <div className="srv-sub ellipsis">{s.host}&nbsp; | &nbsp;SSH2</div>
      </span>
    </button>
  );
  const root = visible.filter((s) => !s.groupId);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <Logo />
        <span className="grow" />
        {admin && <ApprovalBell />}
        <IconButton
          label="Menu"
          onClick={(e) => openMenuAt(e.currentTarget, mainMenu(admin))}
        >
          <Menu size={20} />
        </IconButton>
      </div>
      <button
        className="collapse-btn"
        aria-label="Hide server list"
        title="Hide server list"
        onClick={() => setCollapsed(true)}
      >
        <ChevronLeft size={13} />
      </button>
      <div className="sidebar-tools">
        <div className="grow">
          <SearchInput id="server-search" value={search} onChange={setSearch} />
        </div>
        {admin && (
          <button
            className="add-btn"
            aria-label="Add"
            title="Add"
            onClick={(e) =>
              openMenuAt(e.currentTarget, [
                { label: "Server", onClick: () => openServerDrawer({}) },
                { label: "Folder", onClick: newFolder },
                "sep",
                {
                  label: "Import Servers…",
                  onClick: () => openImportExport("import"),
                },
                {
                  label: "Export Servers…",
                  onClick: () => openImportExport("export"),
                },
              ])
            }
          >
            <Plus size={18} />
          </button>
        )}
      </div>
      <nav
        className="tree tree-root"
        aria-label="Servers"
        {...dropProps("root", null)}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget || !admin) return;
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [
            { label: "New Server", onClick: () => openServerDrawer({}) },
            { label: "New Folder", onClick: newFolder },
          ]);
        }}
      >
        {groups.map((g) => {
          const all = servers.filter((s) => s.groupId === g.id);
          const list = visible.filter((s) => s.groupId === g.id);
          if (q && !list.length) return null;
          const isClosed = closed.includes(g.id) && !q;
          return (
            <div key={g.id} {...dropProps(g.id, g.id)}>
              <button
                className={"tree-folder" + (isClosed ? " closed" : "")}
                style={
                  drop === g.id
                    ? { background: "var(--primary-soft)" }
                    : undefined
                }
                aria-expanded={!isClosed}
                onClick={() => toggle(g.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, folderMenu(g, all));
                }}
              >
                <Folder size={19} strokeWidth={1.5} />
                <span className="grow ellipsis">{g.name}</span>
                <ChevronDown className="chev" size={16} />
              </button>
              {!isClosed && list.map(serverRow)}
            </div>
          );
        })}
        {root.map(serverRow)}
        {!servers.length && (
          <div className="tree-empty">
            {admin ? (
              <>
                No servers yet.
                <br />
                <a onClick={() => openServerDrawer({})}>
                  Add your first server
                </a>
              </>
            ) : (
              "No servers have been shared with you yet."
            )}
          </div>
        )}
        {servers.length > 0 && q && !visible.length && (
          <div className="tree-empty">No servers match “{search}”.</div>
        )}
      </nav>
    </aside>
  );
}
// Pending approval requests, polled for administrators. A desktop notification
// is shown when new ones arrive, once the browser has allowed notifications.
function ApprovalBell() {
  const q = useApi<Row[]>("approvals", { interval: 15000 });
  const pending = (q.data || []).filter(
    (a) => a.status === "pending" && new Date(a.expiresAt) > new Date(),
  );
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const ids = new Set(pending.map((a) => a.id));
    const known = seen.current;
    seen.current = ids;
    if (!known || typeof Notification === "undefined") return;
    const fresh = pending.filter((a) => !known.has(a.id));
    if (fresh.length && Notification.permission === "granted")
      new Notification("NexusSSH approval needed", {
        body: fresh
          .map((a) => `${a.operation} on ${a.server?.name || "a server"}`)
          .join("\n"),
        tag: "nexus-approvals",
      }).onclick = () => {
        window.focus();
        navigate("/settings/approvals");
      };
  }, [q.data]);
  return (
    <IconButton
      label={
        pending.length
          ? `${pending.length} approval request${pending.length === 1 ? "" : "s"}`
          : "Approvals"
      }
      onClick={() => {
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        )
          void Notification.requestPermission();
        navigate("/settings/approvals");
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <Bell size={18} />
        {pending.length > 0 && (
          <span className="count-badge">{pending.length}</span>
        )}
      </span>
    </IconButton>
  );
}
