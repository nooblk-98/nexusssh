"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
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
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  base64ToBytes,
  formatBytes,
  notify,
  operation,
  saveFile,
  useApi,
  type Row,
} from "../lib/api";
import { useWorkspace, type Tab } from "../lib/store";
import {
  confirmDialog,
  IconButton,
  openMenu,
  promptDialog,
  type MenuItem,
} from "./ui";

type Entry = {
  name: string;
  size: number;
  mode: number;
  modifiedAt: number;
  directory: boolean;
  symlink: boolean;
};
type Transfer = {
  id: string;
  name: string;
  dir: "up" | "down";
  state: "queued" | "running" | "done" | "error";
  size: number;
  error?: string;
};
const join = (dir: string, name: string) =>
  (dir.endsWith("/") ? dir : dir + "/") + name;
const parent = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";
export function perm(mode: number, dir: boolean, link: boolean) {
  const r = (n: number) =>
    (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
  return (link ? "l" : dir ? "d" : "-") + r(mode >> 6) + r(mode >> 3) + r(mode);
}
const readAsBase64 = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export default function SftpView({ tab, server }: { tab: Tab; server: Row }) {
  const settings = useApi<Row>("settings");
  const limit: number = settings.data?.fileLimit || 1048576;
  const open = useWorkspace((s) => s.open);
  const setStatus = useWorkspace((s) => s.setStatus);
  const [path, setPath] = useState<string>(tab.path || server.fileRoot);
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
  const [selected, setSelected] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const args = (extra: Row) => ({ serverId: server.id, ...extra });

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError("");
      try {
        const r = await operation<Row>(
          "ssh_list_directory",
          args({ path: target }),
        );
        setEntries(r.entries || []);
        setPath(r.path || target);
        setInput(r.path || target);
        setSelected(null);
        setStatus(tab.id, "connected");
      } catch (e) {
        setError((e as Error).message);
        setStatus(tab.id, "error");
      } finally {
        setLoading(false);
      }
    },
    [server.id],
  );
  useEffect(() => {
    void load(path);
    // Initial load only; navigation calls load directly.
  }, []);
  const go = (target: string) => {
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
  const sorted = useMemo(() => {
    const list = [...entries].sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      const x = a[sort.key],
        y = b[sort.key];
      const c =
        typeof x === "string"
          ? x.localeCompare(String(y), undefined, { numeric: true })
          : Number(x) - Number(y);
      return sort.asc ? c : -c;
    });
    return list;
  }, [entries, sort]);

  const update = (id: string, patch: Partial<Transfer>) =>
    setTransfers((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
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
    for (const d of dirs)
      await operation(
        "ssh_create_directory",
        args({ path: join(base, d) }),
      ).catch(() => {});
    for (const { file, rel } of files) {
      const id = crypto.randomUUID();
      setTransfers((t) => [
        { id, name: rel, dir: "up", state: "queued", size: file.size },
        ...t,
      ]);
      if (file.size > limit) {
        update(id, {
          state: "error",
          error: `Larger than the ${formatBytes(limit)} transfer limit`,
        });
        continue;
      }
      update(id, { state: "running" });
      try {
        await operation(
          "ssh_upload_file",
          args({
            path: join(base, rel),
            content: await readAsBase64(file),
            encoding: "base64",
          }),
        );
        update(id, { state: "done" });
      } catch (e) {
        update(id, { state: "error", error: (e as Error).message });
      }
    }
    if (base === path) void load(path);
  }
  async function download(e: Entry) {
    const id = crypto.randomUUID();
    setTransfers((t) => [
      { id, name: e.name, dir: "down", state: "running", size: e.size },
      ...t,
    ]);
    try {
      const r = await operation<Row>(
        "ssh_download_file",
        args({ path: join(path, e.name) }),
      );
      saveFile(base64ToBytes(r.content), e.name, "application/octet-stream");
      update(id, { state: "done" });
    } catch (err) {
      update(id, { state: "error", error: (err as Error).message });
    }
  }
  const edit = (e: Entry) =>
    open({
      kind: "editor",
      serverId: server.id,
      title: e.name,
      path: join(path, e.name),
      status: "connected",
    });
  async function removeTree(target: string, dir: boolean, budget = { n: 0 }) {
    if (++budget.n > 500)
      throw new Error("Folder is too large to delete from the browser");
    if (dir) {
      const r = await operation<Row>(
        "ssh_list_directory",
        args({ path: target }),
      );
      for (const c of r.entries as Entry[])
        await removeTree(
          join(target, c.name),
          c.directory && !c.symlink,
          budget,
        );
    }
    await operation("ssh_delete_file", args({ path: target }));
  }
  const act = (f: () => Promise<unknown>) => () =>
    void f()
      .then(() => load(path))
      .catch(notify.error);
  const newFolder = act(async () => {
    const name = await promptDialog("New Folder", "Folder name", "", "Create");
    if (name)
      await operation("ssh_create_directory", args({ path: join(path, name) }));
  });
  const newFile = act(async () => {
    const name = await promptDialog("New File", "File name", "", "Create");
    if (!name) return;
    await operation(
      "ssh_write_file",
      args({ path: join(path, name), content: "" }),
    );
    open({
      kind: "editor",
      serverId: server.id,
      title: name,
      path: join(path, name),
      status: "connected",
    });
  });
  const generalMenu: MenuItem[] = [
    { label: "Refresh", onClick: () => void load(path) },
    { label: "New Folder", onClick: newFolder },
    { label: "New File", onClick: newFile },
    { label: "Upload", onClick: () => fileInput.current?.click() },
  ];
  const entryMenu = (e: Entry): MenuItem[] => [
    { label: "Refresh", onClick: () => void load(path) },
    { label: "New Folder", onClick: newFolder },
    { label: "New File", onClick: newFile },
    "sep",
    {
      label: "Rename",
      onClick: act(async () => {
        const name = await promptDialog("Rename", "New name", e.name, "Rename");
        if (name && name !== e.name)
          await operation(
            "ssh_rename_file",
            args({
              path: join(path, e.name),
              destination: name.startsWith("/") ? name : join(path, name),
            }),
          );
      }),
    },
    {
      label: "Delete",
      danger: true,
      onClick: act(async () => {
        if (
          await confirmDialog(
            "Delete",
            <>
              Permanently delete <b>{e.name}</b>
              {e.directory ? " and everything inside it" : ""}? This cannot be
              undone.
            </>,
            "Delete",
            true,
          )
        )
          await removeTree(join(path, e.name), e.directory && !e.symlink);
      }),
    },
    "sep",
    { label: "Upload", onClick: () => fileInput.current?.click() },
    { label: "Edit", disabled: e.directory, onClick: () => edit(e) },
    {
      label: "Download",
      disabled: e.directory,
      onClick: () => void download(e),
    },
  ];
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
    const entriesDropped = items
      .map((i) => i.webkitGetAsEntry?.())
      .filter(Boolean) as FileSystemEntry[];
    if (entriesDropped.length)
      for (const e of entriesDropped) await walk(e, "");
    else
      for (const f of ev.dataTransfer.files) out.push({ file: f, rel: f.name });
    if (out.length > 200)
      return notify.error("Drop at most 200 files at a time.");
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
          <IconButton label="Home" onClick={() => go(server.fileRoot)}>
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
          className={"sftp-table-wrap" + (over ? " dropzone over" : "")}
          {...dragProps}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("tr[data-entry]")) return;
            e.preventDefault();
            openMenu(e.clientX, e.clientY, generalMenu);
          }}
        >
          {error ? (
            <div className="empty-state">
              <Folder size={40} />
              <h3>Unable to open this folder</h3>
              <p>{error}</p>
            </div>
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
                {path !== "/" && path !== server.fileRoot && (
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
                    className={selected === e.name ? "selected" : ""}
                    onClick={() => setSelected(e.name)}
                    onDoubleClick={() =>
                      e.directory ? go(join(path, e.name)) : edit(e)
                    }
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      setSelected(e.name);
                      openMenu(ev.clientX, ev.clientY, entryMenu(e));
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
                            onClick={() => edit(e)}
                          >
                            <Pencil size={15} />
                          </IconButton>
                        )}
                        {!e.directory && (
                          <IconButton
                            label="Download"
                            size="sm"
                            onClick={() => void download(e)}
                          >
                            <ArrowDownToLine size={16} />
                          </IconButton>
                        )}
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
            label="Clear finished transfers"
            disabled={
              !transfers.some((t) => t.state === "done" || t.state === "error")
            }
            onClick={() =>
              setTransfers((t) =>
                t.filter((x) => x.state === "running" || x.state === "queued"),
              )
            }
          >
            <Trash2 size={17} />
          </IconButton>
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
            {transfers.map((t) => (
              <div key={t.id} className="transfer" title={t.error}>
                <div className="row">
                  {t.dir === "up" ? (
                    <ArrowUpToLine size={14} />
                  ) : (
                    <ArrowDownToLine size={14} />
                  )}
                  <span className="grow ellipsis">{t.name}</span>
                  <span className="muted">{formatBytes(t.size)}</span>
                </div>
                <div
                  className={"progress" + (t.state === "error" ? " error" : "")}
                >
                  <div
                    style={{
                      width:
                        t.state === "done" || t.state === "error"
                          ? "100%"
                          : t.state === "running"
                            ? "60%"
                            : "0%",
                    }}
                  />
                </div>
                {t.error && (
                  <div
                    className="small"
                    style={{ color: "var(--danger)", marginTop: 4 }}
                  >
                    {t.error}
                  </div>
                )}
              </div>
            ))}
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
            <span>Up to {formatBytes(limit)} per file.</span>
          </div>
        )}
      </aside>
    </div>
  );
}
