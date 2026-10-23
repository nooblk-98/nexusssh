"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpToLine,
  ChevronLeft,
  ChevronRight,
  CornerLeftUp,
  File,
  Folder,
  HardDriveDownload,
  Home,
  Link2,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { formatBytes, notify, type Row } from "../lib/api";
import { useServers } from "../lib/servers";
import { download, sftp, Upload, type Entry } from "../lib/sftp";
import { useWorkspace, type Tab } from "../lib/store";
import { HostKeyPrompt, hostKeyProblem } from "./host-key";
import {
  Button,
  confirmDialog,
  Dialog,
  Field,
  IconButton,
  openMenu,
  promptDialog,
  type MenuItem,
} from "./ui";

type Transfer = {
  id: string;
  name: string;
  dir: "up" | "down";
  state: "running" | "paused" | "done" | "error";
  size: number;
  sent: number;
  error?: string;
  upload?: Upload;
};
const join = (dir: string, name: string) =>
  (dir.endsWith("/") ? dir : dir + "/") + name;
const parent = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";
export function perm(mode: number, dir: boolean, link: boolean) {
  const r = (n: number) =>
    (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
  return (link ? "l" : dir ? "d" : "-") + r(mode >> 6) + r(mode >> 3) + r(mode);
}

export default function SftpView({ tab, server }: { tab: Tab; server: Row }) {
  const api = useMemo(() => sftp(server.id), [server.id]);
  const open = useWorkspace((s) => s.open);
  const setStatus = useWorkspace((s) => s.setStatus);
  const updateTab = useWorkspace((s) => s.updateTab);
  const [path, setPath] = useState<string>(tab.path || "");
  const [root, setRoot] = useState("");
  const [input, setInput] = useState(path);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>(
    { back: [], forward: [] },
  );
  const [sort, setSort] = useState<{ key: keyof Entry; asc: boolean }>({
    key: "name",
    asc: true,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [over, setOver] = useState(false);
  const [find, setFind] = useState<{
    term: string;
    results: Row[] | null;
    busy: boolean;
  } | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | { kind: "chmod"; mode: number; paths: string[] }
    | { kind: "copy" | "move"; paths: string[] }
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (target?: string) => {
      setLoading(true);
      setError("");
      try {
        const r = await api.list(target || undefined);
        setEntries(r.entries);
        setPath(r.path);
        setRoot(r.root);
        setInput(r.path);
        setSelected([]);
        setStatus(tab.id, "connected");
        updateTab(tab.id, { path: r.path });
      } catch (e) {
        setError((e as Error).message);
        setStatus(tab.id, "error");
      } finally {
        setLoading(false);
      }
    },
    [api, setStatus, updateTab, tab.id],
  );
  useEffect(() => {
    void load(path);
    // Initial load only; navigation calls load directly.
  }, []);
  const go = (target: string) => {
    setFind(null);
    if (target === path) return void load(target);
    setHistory((h) => ({ back: [...h.back, path], forward: [] }));
    void load(target);
  };
  const back = () => {
    const prev = history.back.at(-1);
    if (!prev) return;
    setHistory((h) => ({
      back: h.back.slice(0, -1),
      forward: [path, ...h.forward],
    }));
    void load(prev);
  };
  const forward = () => {
    const next = history.forward[0];
    if (!next) return;
    setHistory((h) => ({
      back: [...h.back, path],
      forward: h.forward.slice(1),
    }));
    void load(next);
  };
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        const x = a[sort.key],
          y = b[sort.key];
        const c =
          typeof x === "string"
            ? x.localeCompare(String(y), undefined, { numeric: true })
            : Number(x) - Number(y);
        return sort.asc ? c : -c;
      }),
    [entries, sort],
  );
  const pick = (names: string[]) =>
    sorted.filter((e) => names.includes(e.name));
  const toPaths = (list: Entry[]) => list.map((e) => join(path, e.name));

  const update = (id: string, patch: Partial<Transfer>) =>
    setTransfers((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  async function runUpload(t: Transfer) {
    update(t.id, { state: "running", error: undefined });
    try {
      await t.upload!.run();
      update(t.id, { state: "done", sent: t.size });
      return true;
    } catch (e) {
      if ((e as Error).name === "AbortError") update(t.id, { state: "paused" });
      else update(t.id, { state: "error", error: (e as Error).message });
      return false;
    }
  }
  async function uploadFiles(
    files: { file: File; rel: string }[],
    base = path,
  ) {
    const dirs = [
      ...new Set(
        files.flatMap(({ rel }) => {
          const parts = rel.split("/").slice(0, -1);
          return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
        }),
      ),
    ];
    for (const d of dirs) await api.mkdir(join(base, d)).catch(() => {});
    const queued = files.map(({ file, rel }) => {
      const id = Math.random().toString(36).slice(2);
      const t: Transfer = {
        id,
        name: rel,
        dir: "up",
        state: "running",
        size: file.size,
        sent: 0,
      };
      t.upload = new Upload(server.id, join(base, rel), file, (sent) =>
        update(id, { sent }),
      );
      return t;
    });
    setTransfers((t) => [...queued, ...t]);
    let changed = false;
    for (const t of queued) changed = (await runUpload(t)) || changed;
    if (changed && base === path) void load(path);
  }
  const startDownload = (list: Entry[]) => {
    if (!list.length) return;
    const single = list.length === 1 && !list[0].directory;
    download(api.downloadUrl(toPaths(list)));
    setTransfers((t) => [
      {
        id: Math.random().toString(36).slice(2),
        name: single
          ? list[0].name
          : (list.length === 1 ? list[0].name : list.length + " items") +
            ".tar.gz",
        dir: "down",
        state: "done",
        size: single ? list[0].size : 0,
        sent: single ? list[0].size : 0,
      },
      ...t,
    ]);
  };
  const edit = (e: Entry) =>
    open({
      kind: "editor",
      serverId: server.id,
      title: e.name,
      path: join(path, e.name),
      status: "connected",
    });
  const act = (f: () => Promise<unknown>) => () =>
    void f()
      .then(() => load(path))
      .catch(notify.error);
  const newFolder = act(async () => {
    const name = await promptDialog("New Folder", "Folder name", "", "Create");
    if (name) await api.mkdir(join(path, name));
  });
  const newFile = act(async () => {
    const name = await promptDialog("New File", "File name", "", "Create");
    if (!name) return;
    await api.write(join(path, name), "");
    open({
      kind: "editor",
      serverId: server.id,
      title: name,
      path: join(path, name),
      status: "connected",
    });
  });
  const rename = (e: Entry) =>
    act(async () => {
      const name = await promptDialog("Rename", "New name", e.name, "Rename");
      if (name && name !== e.name)
        await api.rename(
          join(path, e.name),
          name.startsWith("/") ? name : join(path, name),
        );
    })();
  const remove = (list: Entry[]) =>
    act(async () => {
      const what =
        list.length === 1 ? <b>{list[0].name}</b> : <b>{list.length} items</b>;
      const folders = list.some((e) => e.directory && !e.symlink);
      if (
        await confirmDialog(
          "Delete",
          <>
            Permanently delete {what}
            {folders ? " and everything inside" : ""}? This cannot be undone.
          </>,
          "Delete",
          true,
        )
      ) {
        await api.remove(toPaths(list));
        notify.success("Deleted.");
      }
    })();
  const generalMenu: MenuItem[] = [
    { label: "Refresh", onClick: () => void load(path) },
    { label: "New Folder", onClick: newFolder },
    { label: "New File", onClick: newFile },
    "sep",
    { label: "Upload", onClick: () => fileInput.current?.click() },
    {
      label: "Select All",
      onClick: () => setSelected(entries.map((e) => e.name)),
    },
  ];
  const entryMenu = (list: Entry[]): MenuItem[] => {
    const one = list.length === 1 ? list[0] : null;
    return [
      { label: "Refresh", onClick: () => void load(path) },
      { label: "New Folder", onClick: newFolder },
      { label: "New File", onClick: newFile },
      "sep",
      { label: "Rename", disabled: !one, onClick: () => one && rename(one) },
      {
        label: list.length > 1 ? `Delete ${list.length} items` : "Delete",
        danger: true,
        onClick: () => remove(list),
      },
      {
        label: "Permissions…",
        onClick: () =>
          setDialog({
            kind: "chmod",
            mode: list[0].mode & 0o7777,
            paths: toPaths(list),
          }),
      },
      {
        label: "Copy to…",
        onClick: () => setDialog({ kind: "copy", paths: toPaths(list) }),
      },
      {
        label: "Move to…",
        onClick: () => setDialog({ kind: "move", paths: toPaths(list) }),
      },
      "sep",
      { label: "Upload", onClick: () => fileInput.current?.click() },
      {
        label: "Edit",
        disabled: !one || one.directory,
        onClick: () => one && edit(one),
      },
      {
        label: one && !one.directory ? "Download" : "Download as .tar.gz",
        onClick: () => startDownload(list),
      },
    ];
  };
  function select(e: MouseEvent, entry: Entry) {
    if (e.shiftKey && anchor) {
      const names = sorted.map((x) => x.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(entry.name)].sort(
        (x, y) => x - y,
      );
      setSelected(names.slice(a, b + 1));
      return;
    }
    if (e.ctrlKey || e.metaKey)
      setSelected((s) =>
        s.includes(entry.name)
          ? s.filter((x) => x !== entry.name)
          : [...s, entry.name],
      );
    else setSelected([entry.name]);
    setAnchor(entry.name);
  }
  async function runSearch(term: string) {
    if (!term.trim()) return;
    setFind({ term, results: null, busy: true });
    try {
      const r = await api.search(path, term.trim());
      setFind({ term, results: r.matches, busy: false });
    } catch (e) {
      notify.error(e);
      setFind({ term, results: [], busy: false });
    }
  }
  async function onDrop(ev: DragEvent) {
    ev.preventDefault();
    setOver(false);
    const items = [...ev.dataTransfer.items];
    const out: { file: File; rel: string }[] = [];
    const walk = async (
      entry: FileSystemEntry,
      prefix: string,
    ): Promise<void> => {
      if (entry.isFile)
        out.push({
          file: await new Promise<File>((res, rej) =>
            (entry as FileSystemFileEntry).file(res, rej),
          ),
          rel: prefix + entry.name,
        });
      else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        let batch: FileSystemEntry[];
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const c of batch) await walk(c, prefix + entry.name + "/");
        } while (batch.length);
      }
    };
    const dropped = items
      .map((i) => i.webkitGetAsEntry?.())
      .filter(Boolean) as FileSystemEntry[];
    if (dropped.length) for (const e of dropped) await walk(e, "");
    else
      for (const f of ev.dataTransfer.files) out.push({ file: f, rel: f.name });
    if (out.length > 1000)
      return notify.error("Drop at most 1000 files at a time.");
    if (out.length) void uploadFiles(out);
  }
  const dragProps = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => void onDrop(e),
  };
  const header = (key: keyof Entry, label: string) => (
    <th
      className={"sortable" + (sort.key === key ? " sorted" : "")}
      onClick={() =>
        setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))
      }
      aria-sort={
        sort.key === key ? (sort.asc ? "ascending" : "descending") : "none"
      }
    >
      <span className="row" style={{ gap: 4 }}>
        {label}
        <ArrowUpDown size={13} />
      </span>
    </th>
  );
  const picked = pick(selected);
  const active = transfers.filter(
    (t) => t.dir === "up" && (t.state === "running" || t.state === "paused"),
  );
  return (
    <div className="sftp">
      <div className="sftp-main">
        <div className="sftp-nav">
          <IconButton
            label="Go back"
            disabled={!history.back.length}
            onClick={back}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton
            label="Go forward"
            disabled={!history.forward.length}
            onClick={forward}
          >
            <ChevronRight size={18} />
          </IconButton>
          {find ? (
            <form
              className="grow row"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch(find.term);
              }}
            >
              <input
                autoFocus
                className="input"
                aria-label="Find files"
                placeholder={`Find files and folders in ${path}`}
                value={find.term}
                onChange={(e) => setFind({ ...find, term: e.target.value })}
                onKeyDown={(e) => e.key === "Escape" && setFind(null)}
              />
            </form>
          ) : (
            <form
              className="grow"
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim()) go(input.trim());
              }}
            >
              <input
                className="input mono"
                aria-label="Path"
                placeholder="Path"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                style={{ fontSize: 12 }}
              />
            </form>
          )}
          <IconButton
            label={find ? "Close find" : "Find"}
            active={!!find}
            onClick={() =>
              setFind(find ? null : { term: "", results: null, busy: false })
            }
          >
            {find ? <X size={17} /> : <Search size={17} />}
          </IconButton>
          <IconButton label="Home" onClick={() => go(root)}>
            <Home size={18} />
          </IconButton>
          <IconButton
            label="Refresh"
            disabled={loading}
            onClick={() => void load(path)}
          >
            <RotateCw size={17} />
          </IconButton>
        </div>
        <div
          tabIndex={0}
          className={"sftp-table-wrap" + (over ? " dropzone over" : "")}
          {...dragProps}
          onKeyDown={(e) => {
            if (find || (e.target as HTMLElement).tagName === "INPUT") return;
            if (e.key === "Delete" && picked.length) remove(picked);
            else if (e.key === "F2" && picked.length === 1) rename(picked[0]);
            else if (e.key === "Backspace" && path !== root) go(parent(path));
            else if (e.key === "Enter" && picked.length === 1) {
              if (picked[0].directory) go(join(path, picked[0].name));
              else edit(picked[0]);
            } else if (
              e.key.toLowerCase() === "a" &&
              (e.ctrlKey || e.metaKey)
            ) {
              e.preventDefault();
              setSelected(entries.map((x) => x.name));
            }
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("tr[data-entry]") || find)
              return;
            e.preventDefault();
            setSelected([]);
            openMenu(e.clientX, e.clientY, generalMenu);
          }}
        >
          {error && hostKeyProblem(error) ? (
            <div className="empty-state">
              <HostKeyPrompt
                key={error}
                server={server}
                kind={hostKeyProblem(error)!}
                message={error}
                onTrusted={() => void load(path)}
              />
            </div>
          ) : error ? (
            <div className="empty-state">
              <Folder size={40} />
              <h3>Unable to open this folder</h3>
              <p>{error}</p>
              <Button variant="outline" onClick={() => void load(path)}>
                Try again
              </Button>
            </div>
          ) : find?.results || find?.busy ? (
            <table className="table">
              <thead>
                <tr>
                  <th>
                    {find.busy
                      ? "Searching…"
                      : `${find.results!.length}${find.results!.length >= 200 ? "+" : ""} result(s) for “${find.term}”`}
                  </th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {(find.results || []).map((m) => (
                  <tr
                    key={m.path}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      m.directory
                        ? go(m.path)
                        : open({
                            kind: "editor",
                            serverId: server.id,
                            title: m.path.split("/").pop()!,
                            path: m.path,
                            status: "connected",
                          })
                    }
                  >
                    <td>
                      <span className="name-cell mono" style={{ fontSize: 12 }}>
                        {m.directory ? (
                          <Folder
                            size={16}
                            className="folder-icon"
                            fill="currentColor"
                          />
                        ) : (
                          <File size={16} />
                        )}
                        {m.path}
                      </span>
                    </td>
                    <td>{m.directory ? "" : formatBytes(m.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {header("name", "Name")}
                  {header("modifiedAt", "Date Modified")}
                  {header("size", "Size")}
                  {header("mode", "Perm")}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {path && path !== "/" && path !== root && (
                  <tr onDoubleClick={() => go(parent(path))}>
                    <td colSpan={5}>
                      <button
                        className="name-cell"
                        onClick={() => go(parent(path))}
                      >
                        <CornerLeftUp size={17} className="folder-icon" /> ..
                      </button>
                    </td>
                  </tr>
                )}
                {sorted.map((e) => (
                  <tr
                    key={e.name}
                    data-entry
                    className={selected.includes(e.name) ? "selected" : ""}
                    onClick={(ev) => select(ev, e)}
                    onDoubleClick={() =>
                      e.directory ? go(join(path, e.name)) : edit(e)
                    }
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      const list = selected.includes(e.name) ? picked : [e];
                      if (!selected.includes(e.name)) {
                        setSelected([e.name]);
                        setAnchor(e.name);
                      }
                      openMenu(ev.clientX, ev.clientY, entryMenu(list));
                    }}
                  >
                    <td>
                      <span className="name-cell">
                        {e.directory ? (
                          <Folder
                            size={17}
                            className="folder-icon"
                            fill="currentColor"
                          />
                        ) : e.symlink ? (
                          <Link2 size={17} />
                        ) : (
                          <File size={17} />
                        )}
                        {e.name}
                      </span>
                    </td>
                    <td>{new Date(e.modifiedAt * 1000).toLocaleString()}</td>
                    <td>{e.directory ? "" : formatBytes(e.size)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {perm(e.mode, e.directory, e.symlink)}
                    </td>
                    <td>
                      <span className="actions">
                        {!e.directory && (
                          <IconButton
                            label="Edit"
                            size="sm"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              edit(e);
                            }}
                          >
                            <Pencil size={15} />
                          </IconButton>
                        )}
                        <IconButton
                          label={
                            e.directory ? "Download as .tar.gz" : "Download"
                          }
                          size="sm"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            startDownload([e]);
                          }}
                        >
                          <ArrowDownToLine size={16} />
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                ))}
                {!loading && !sorted.length && (
                  <tr>
                    <td
                      colSpan={5}
                      className="muted"
                      style={{ textAlign: "center" }}
                    >
                      This folder is empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <aside className="transfers" aria-label="Transfers">
        <div className="transfers-tools">
          <IconButton label="Upload" onClick={() => fileInput.current?.click()}>
            <ArrowUpToLine size={18} />
          </IconButton>
          <IconButton
            label={
              active.some((t) => t.state === "running")
                ? "Pause uploads"
                : "Resume uploads"
            }
            disabled={!active.length}
            onClick={() => {
              const running = active.filter((t) => t.state === "running");
              if (running.length) running.forEach((t) => t.upload!.pause());
              else
                void (async () => {
                  for (const t of active) await runUpload(t);
                  void load(path);
                })();
            }}
          >
            {active.some((t) => t.state === "running") || !active.length ? (
              <Pause size={17} />
            ) : (
              <Play size={17} />
            )}
          </IconButton>
          <IconButton
            label="Clear finished transfers"
            disabled={
              !transfers.some((t) => t.state === "done" || t.state === "error")
            }
            onClick={() =>
              setTransfers((t) =>
                t.filter((x) => x.state === "running" || x.state === "paused"),
              )
            }
          >
            <Trash2 size={17} />
          </IconButton>
          {picked.length > 1 && (
            <span className="small muted">{picked.length} selected</span>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files || [])].map((file) => ({
                file,
                rel: file.name,
              }));
              e.target.value = "";
              if (files.length) void uploadFiles(files);
            }}
          />
        </div>
        {transfers.length ? (
          <div style={{ overflow: "auto", flex: 1 }} {...dragProps}>
            {transfers.map((t) => {
              const pct = t.size
                ? Math.round((t.sent / t.size) * 100)
                : t.state === "done"
                  ? 100
                  : 0;
              return (
                <div key={t.id} className="transfer" title={t.error}>
                  <div className="row">
                    {t.dir === "up" ? (
                      <ArrowUpToLine size={14} />
                    ) : (
                      <ArrowDownToLine size={14} />
                    )}
                    <span className="grow ellipsis">{t.name}</span>
                    {t.dir === "up" &&
                      (t.state === "running" || t.state === "paused") && (
                        <>
                          <IconButton
                            size="sm"
                            label={t.state === "running" ? "Pause" : "Resume"}
                            onClick={() => {
                              if (t.state === "running") t.upload!.pause();
                              else
                                void runUpload(t).then((ok) => {
                                  if (ok) void load(path);
                                });
                            }}
                          >
                            {t.state === "running" ? (
                              <Pause size={13} />
                            ) : (
                              <Play size={13} />
                            )}
                          </IconButton>
                          <IconButton
                            size="sm"
                            label="Cancel"
                            onClick={() => {
                              void t.upload!.cancel();
                              update(t.id, {
                                state: "error",
                                error: "Cancelled",
                              });
                            }}
                          >
                            <X size={13} />
                          </IconButton>
                        </>
                      )}
                  </div>
                  <div
                    className={
                      "progress" + (t.state === "error" ? " error" : "")
                    }
                  >
                    <div
                      style={{ width: (t.state === "error" ? 100 : pct) + "%" }}
                    />
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {t.state === "error" ? (
                      <span style={{ color: "var(--danger)" }}>{t.error}</span>
                    ) : t.dir === "down" ? (
                      "Saved by your browser"
                    ) : (
                      `${formatBytes(t.sent)} of ${formatBytes(t.size)} · ${t.state === "paused" ? "paused" : t.state === "done" ? "done" : pct + "%"}`
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={"dropzone" + (over ? " over" : "")} {...dragProps}>
            <HardDriveDownload size={36} color="var(--s600)" />
            <span>
              Drop files and folders here to upload,
              <br />
              or <a onClick={() => fileInput.current?.click()}>click here</a> to
              browse files from your computer.
            </span>
          </div>
        )}
      </aside>
      {dialog?.kind === "chmod" && (
        <PermissionsDialog
          mode={dialog.mode}
          count={dialog.paths.length}
          close={() => setDialog(null)}
          apply={(mode) => act(() => api.chmod(dialog.paths, mode))()}
        />
      )}
      {(dialog?.kind === "copy" || dialog?.kind === "move") && (
        <TransferDialog
          kind={dialog.kind}
          count={dialog.paths.length}
          serverId={server.id}
          dest={path}
          close={() => setDialog(null)}
          apply={(toServerId, toPath) =>
            act(async () => {
              const r = await api.transfer({
                paths: dialog.paths,
                toServerId,
                toPath,
                move: dialog.kind === "move",
              });
              notify.success(
                `${dialog.kind === "move" ? "Moved" : "Copied"} ${r.copied} item(s).`,
              );
            })()
          }
        />
      )}
    </div>
  );
}

function PermissionsDialog({
  mode,
  count,
  close,
  apply,
}: {
  mode: number;
  count: number;
  close: () => void;
  apply: (mode: number) => void;
}) {
  const [value, setValue] = useState(mode & 0o777);
  const bits = [
    ["Owner", 6],
    ["Group", 3],
    ["Others", 0],
  ] as const;
  return (
    <Dialog
      title="Permissions"
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              apply((mode & 0o7000) | value);
              close();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="small muted" style={{ marginBottom: 10 }}>
        {count > 1
          ? `Applies to ${count} items.`
          : "Applies to the selected item."}
      </p>
      <table className="table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th />
            <th>Read</th>
            <th>Write</th>
            <th>Execute</th>
          </tr>
        </thead>
        <tbody>
          {bits.map(([label, shift]) => (
            <tr key={label}>
              <td>{label}</td>
              {[4, 2, 1].map((b) => (
                <td key={b}>
                  <label className="check" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      aria-label={`${label} ${b === 4 ? "read" : b === 2 ? "write" : "execute"}`}
                      checked={!!(value & (b << shift))}
                      onChange={(e) =>
                        setValue((v) =>
                          e.target.checked
                            ? v | (b << shift)
                            : v & ~(b << shift),
                        )
                      }
                    />
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="Octal">
        <input
          className="input mono"
          value={value.toString(8).padStart(3, "0")}
          onChange={(e) =>
            /^[0-7]{0,3}$/.test(e.target.value) &&
            setValue(parseInt(e.target.value || "0", 8))
          }
        />
      </Field>
    </Dialog>
  );
}

function TransferDialog({
  kind,
  count,
  serverId,
  dest,
  close,
  apply,
}: {
  kind: "copy" | "move";
  count: number;
  serverId: string;
  dest: string;
  close: () => void;
  apply: (serverId: string, path: string) => void;
}) {
  const { servers } = useServers();
  const [to, setTo] = useState(serverId);
  const [path, setPath] = useState(dest);
  const other = servers.find((s) => s.id === to);
  return (
    <Dialog
      title={kind === "copy" ? "Copy To" : "Move To"}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!path.startsWith("/")}
            onClick={() => {
              apply(to, path);
              close();
            }}
          >
            {kind === "copy" ? "Copy" : "Move"} {count} item
            {count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <Field label="Server">
        <select
          className="select"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPath(
              e.target.value === serverId
                ? dest
                : servers.find((s) => s.id === e.target.value)?.fileRoot || "/",
            );
          }}
        >
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.host})
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Destination folder"
        hint={
          other && to !== serverId
            ? `Must be inside ${other.fileRoot} on ${other.name}.`
            : undefined
        }
      >
        <input
          className="input mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </Field>
    </Dialog>
  );
}
