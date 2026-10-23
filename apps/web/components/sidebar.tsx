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
import { folderPath, folderLabel, folderOptions } from "../lib/folders";
import { navigate } from "../lib/router";
import { connectServer, updateServer, useServers } from "../lib/servers";
import { useWorkspace } from "../lib/store";
import { ServerIcon } from "./icons";
import { openImportExport } from "./import-export";
import { openServerDrawer } from "./server-drawer";
import { DefaultsEditor, MetadataEditor } from "./metadata-editor";
import { HealthIndicator, ServerHealth } from "./server-health";
import {
  Button,
  Drawer,
  Field,
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
export async function newFolder(parentId: string | null = null) {
  const name = await promptDialog("New Folder", "Folder name", "", "Create");
  if (name)
    await api("groups", { name, parentId })
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
  const tagsQuery = useApi<Row[]>("tags");
  const tags = tagsQuery.data || [];
  const [defaults, setDefaults] = useState<{ kind: "groups" | "tags"; row: Row } | null>(null);
  const [view, setView] = useState<"tree" | "table" | "tags">("tree");
  const [tagFilter, setTagFilter] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [health, setHealth] = useState<{ title: string; servers: Row[]; groupId?: string } | null>(null);
  const [healthNow, setHealthNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setHealthNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const { selected, select, setCollapsed } = useWorkspace();
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<string[]>([]);
  const [drag, setDrag] = useState<{
    kind: "server" | "folder";
    id: string;
  } | null>(null);
  const [move, setMove] = useState<{
    kind: "server" | "folder";
    row: Row;
  } | null>(null);
  const [destination, setDestination] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");
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
  const matchesFolder = (id?: string | null) =>
    folderPath(groups, id).some((g) => g.name.toLowerCase().includes(q));
  const visible = useMemo(
    () =>
      servers.filter(
        (s) =>
          (!tagFilter || (s.tags || []).some((t: Row) => t.id === tagFilter)) && (!q ||
          matchesFolder(s.groupId) ||
          [
            s.name,
            s.host,
            s.username,
            s.description,
            ...(s.tags || []).map((t: Row) => t.name),
          ]
            .join(" ")
            .toLowerCase()
            .includes(q)),
      ),
    [servers, groups, q, tagFilter],
  );
  const toggleChecked = (id: string) => setChecked((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const startMove = (kind: "server" | "folder", row: Row) => {
    setMove({ kind, row });
    setDestination((kind === "folder" ? row.parentId : row.groupId) || "");
    setMoveError("");
  };
  const expand = (id: string | null) => {
    const ancestors = new Set(folderPath(groups, id).map((g) => g.id));
    setClosed((current) => {
      const next = current.filter((id) => !ancestors.has(id));
      try {
        localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const moveItem = async (
    item: { kind: "server" | "folder"; id: string },
    parentId: string | null,
  ) => {
    if (item.kind === "folder") {
      await api("groups/" + item.id, { parentId }, "PATCH");
      await refresh("groups");
    } else {
      await api("servers/" + item.id + "/move", { groupId: parentId }, "PATCH");
      await refresh("servers");
    }
    expand(parentId);
  };
  const serverMenu = (s: Row): MenuItem[] => [
    { label: "Connect", onClick: () => connectServer(s) },
    { label: "Test connection and host key", onClick: () => setHealth({ title: `Check ${s.name}`, servers: [s] }) },
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
          { label: "Move to…", onClick: () => startMove("server", s) },
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
    { label: "Test all", disabled: !list.length, onClick: () => setHealth({ title: `Test folder: ${g.name}`, groupId: g.id, servers: [...new Map(list.map((s) => [s.id, s])).values()] }) },
    ...(admin
      ? ([
          {
            label: "New Server",
            onClick: () => openServerDrawer({ groupId: g.id }),
          },
          {
            label: "New Subfolder",
            onClick: () => {
              expand(g.id);
              return newFolder(g.id);
            },
          },
          { label: "Edit defaults", onClick: () => setDefaults({ kind: "groups", row: g }) },
          { label: "Move to…", onClick: () => startMove("folder", g) },
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
                    {
                      " Its directly contained servers and subfolders move to the top level. No servers are deleted."
                    }
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
  const dropProps = (key: string, parentId: string | null) =>
    admin
      ? {
          onDragOver: (e: DragEvent) => {
            if (
              !e.dataTransfer.types.includes("text/server") &&
              !e.dataTransfer.types.includes("text/folder")
            )
              return;
            e.stopPropagation();
            if (
              drag?.kind === "folder" &&
              folderPath(groups, parentId).some((g) => g.id === drag.id)
            ) {
              e.dataTransfer.dropEffect = "none";
              setDrop(null);
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDrop(key);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDrop((d) => (d === key ? null : d));
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDrop(null);
            setDrag(null);
            const folder = e.dataTransfer.getData("text/folder");
            const server = e.dataTransfer.getData("text/server");
            if (
              folder &&
              folderPath(groups, parentId).some((g) => g.id === folder)
            )
              return;
            const item = folder
              ? { kind: "folder" as const, id: folder }
              : { kind: "server" as const, id: server };
            const current = folder
              ? groups.find((g) => g.id === folder)?.parentId
              : servers.find((s) => s.id === server)?.groupId;
            if (item.id && (current || null) !== parentId)
              void moveItem(item, parentId).catch(notify.error);
          },
        }
      : {};
  const dragProps = (kind: "server" | "folder", id: string) => ({
    draggable: admin,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData("text/" + kind, id);
      e.dataTransfer.effectAllowed = "move";
      setDrag({ kind, id });
    },
    onDragEnd: () => {
      setDrag(null);
      setDrop(null);
    },
  });
  const serverRow = (s: Row, depth = 0) => (
    <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
    {admin && <input type="checkbox" aria-label={`Select ${s.name}`} checked={checked.includes(s.id)} onChange={() => toggleChecked(s.id)} />}
    <button
      className={"tree-server" + (selected === s.id ? " selected" : "")}
      style={{ paddingLeft: 10 + depth * 20 }}
      data-server-id={s.id}
      {...dragProps("server", s.id)}
      {...dropProps(s.groupId || "root", s.groupId || null)}
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
      <HealthIndicator server={s} now={healthNow} />
      <span className="grow">
        <div className="srv-name ellipsis">{s.name}</div>
        <div className="srv-sub ellipsis">{s.host}&nbsp; | &nbsp;SSH2</div>
      </span>
    </button>
    </div>
  );
  const root = visible.filter((s) => !s.groupId);
  const shownFolders = new Set<string>();
  for (const g of groups) {
    if (!q || matchesFolder(g.id))
      folderPath(groups, g.id).forEach((f) => shownFolders.add(f.id));
  }
  visible.forEach((s) =>
    folderPath(groups, s.groupId).forEach((f) => shownFolders.add(f.id)),
  );
  const renderFolder = (g: Row, depth = 0): React.ReactNode => {
    if (!shownFolders.has(g.id)) return null;
    const all = servers.filter((s) =>
      folderPath(groups, s.groupId).some((f) => f.id === g.id),
    );
    const list = visible.filter((s) => s.groupId === g.id);
    const isClosed = closed.includes(g.id) && !q;
    return (
      <div key={g.id} data-folder-id={g.id}>
        <button
          className={
            "tree-folder" +
            (isClosed ? " closed" : "") +
            (drop === g.id ? " drop-target" : "")
          }
          style={{ paddingLeft: 10 + depth * 20 }}
          aria-expanded={!isClosed}
          title={folderLabel(groups, g.id)}
          {...dragProps("folder", g.id)}
          {...dropProps(g.id, g.id)}
          onClick={() => toggle(g.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, folderMenu(g, all));
          }}
        >
          <Folder size={19} strokeWidth={1.5} />
          <span className="grow ellipsis">{g.name}</span>
          <ChevronDown className="chev" size={16} />
        </button>
        {!isClosed && (
          <div>
            {groups
              .filter((child) => child.parentId === g.id)
              .map((child) => renderFolder(child, depth + 1))}
            {list.map((s) => serverRow(s, depth + 1))}
          </div>
        )}
      </div>
    );
  };
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
      <div className="sidebar-tools" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(["tree", "table", "tags"] as const).map((mode) => <button key={mode} className="btn btn-secondary" aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === "tree" ? "Tree" : mode === "table" ? "Table" : "By tag"}</button>)}
        <select className="select" aria-label="Filter by tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}><option value="">All tags</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>
      </div>
      {admin && view === "tags" && <div className="sidebar-tools"><select className="select" aria-label="Edit tag defaults" onChange={(e) => { const tag = tags.find((x) => x.id === e.target.value); if (tag) setDefaults({ kind: "tags", row: tag }); e.currentTarget.value = ""; }} defaultValue=""><option value="">Edit tag defaults…</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div>}
      {admin && !!checked.length && <div className="sidebar-tools">{checked.length} selected <Button onClick={() => setBulkOpen(true)}>Bulk edit</Button><Button variant="secondary" onClick={() => setChecked([])}>Clear</Button></div>}
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
        {view === "tree" && <>{groups.filter((g) => !g.parentId).map((g) => renderFolder(g))}{root.map((s) => serverRow(s))}</>}
        {view === "table" && <div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Select</th><th>Status</th><th>Name</th><th>Host</th><th>Environment</th><th>vCPU</th><th>RAM</th><th>Disk</th><th>OS</th><th>Role</th><th>Check</th></tr></thead><tbody>{visible.map((s) => <tr key={s.id} onClick={() => select(s.id)}><td><input type="checkbox" aria-label={`Select ${s.name}`} checked={checked.includes(s.id)} onChange={() => toggleChecked(s.id)} onClick={(e) => e.stopPropagation()} /></td><td><HealthIndicator server={s} now={healthNow} /></td><td><button className="btn btn-secondary" onClick={() => openServerDrawer({ server: s })}>{s.name}</button></td><td>{s.host}</td><td>{s.effectiveSettings?.values?.environment ?? s.environment}</td><td>{s.vcpu ?? "—"}</td><td>{s.ramBytes ?? "—"}</td><td>{s.diskBytes ?? "—"}</td><td>{s.os || "—"}</td><td>{s.role || "—"}</td><td><button className="btn btn-secondary" onClick={() => setHealth({ title: `Check ${s.name}`, servers: [s] })}>Test</button></td></tr>)}</tbody></table></div>}
        {view === "tags" && <>{tags.filter((tag) => !tagFilter || tag.id === tagFilter).map((tag) => { const list = visible.filter((s) => (s.tags || []).some((t: Row) => t.id === tag.id)); return list.length || tagFilter ? <section key={tag.id}><div className="tree-folder">{tag.name} ({list.length})</div>{list.map((s) => serverRow(s))}</section> : null; })}{!tagFilter && visible.filter((s) => !(s.tags || []).length).length > 0 && <section><div className="tree-folder">Untagged</div>{visible.filter((s) => !(s.tags || []).length).map((s) => serverRow(s))}</section>}</>}
        {admin && drag && (
          <div
            className={
              "tree-drop-root" + (drop === "root" ? " drop-target" : "")
            }
            {...dropProps("root", null)}
          >
            Move to top level
          </div>
        )}
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
        {q && !visible.length && !shownFolders.size && (
          <div className="tree-empty">No servers match “{search}”.</div>
        )}
      </nav>
      {defaults && <DefaultsEditor kind={defaults.kind} row={defaults.row} onClose={() => setDefaults(null)} />}
      {health && <ServerHealth title={health.title} servers={health.servers} groupId={health.groupId} canManage={admin} onClose={() => setHealth(null)} />}
      {bulkOpen && <MetadataEditor title={`Bulk edit ${new Set(checked).size} servers`} bulk hardware onClose={() => setBulkOpen(false)} onSave={async ({ settings, inherit, metadata }) => {
        const serverIds = [...new Set(checked)].filter((id) => servers.some((s) => s.id === id));
        if (!serverIds.length) throw new Error("No selected servers are available.");
        if (serverIds.length > 100) throw new Error("Select at most 100 servers.");
        if (!Object.keys(settings).length && !inherit.length && !Object.keys(metadata).length) throw new Error("Choose at least one change.");
        const result = await api<{ updated: number }>("servers/metadata/bulk", { serverIds, settings, inherit, metadata });
        await refresh("servers"); setChecked([]); notify.success(`Updated ${result.updated} servers together.`);
      }} />}
      {move && (
        <Drawer
          title={"Move " + move.row.name}
          onClose={() => !moving && setMove(null)}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={moving}
                onClick={() => setMove(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={moving}
                onClick={async () => {
                  setMoving(true);
                  setMoveError("");
                  try {
                    await moveItem(
                      { kind: move.kind, id: move.row.id },
                      destination || null,
                    );
                    setMove(null);
                  } catch (e) {
                    setMoveError((e as Error).message);
                  } finally {
                    setMoving(false);
                  }
                }}
              >
                {moving ? "Moving…" : "Move"}
              </Button>
            </>
          }
        >
          {moveError && (
            <div className="alert danger" role="alert">
              {moveError}
            </div>
          )}
          <Field label="Destination folder">
            <select
              className="select"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">Top level</option>
              {folderOptions(groups)
                .filter(
                  (g) =>
                    move.kind !== "folder" ||
                    !folderPath(groups, g.id).some((f) => f.id === move.row.id),
                )
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
            </select>
          </Field>
        </Drawer>
      )}
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
