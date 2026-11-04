"use client";
import { useMemo, useState } from "react";
import { api, type Row } from "../lib/api";
import { folderPath, type Folder } from "../lib/folders";
import { Button, Drawer, Field } from "./ui";
import { RunbookPicker } from "./runbooks";

type Result = { serverId: string; status: string; result?: Row; error?: string; taskId?: string };
export function ExecuteMany({ servers, groups, tags, selectedIds, onClose }: { servers: Row[]; groups: Folder[]; tags: Row[]; selectedIds: string[]; onClose: () => void }) {
  const [source, setSource] = useState<"manual" | "folder" | "tag">("manual");
  const [ids, setIds] = useState<string[]>(() => [...new Set(selectedIds)]);
  const [folderId, setFolderId] = useState("");
  const [tagId, setTagId] = useState("");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutValue] = useState("30000");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targets = useMemo(() => {
    const chosen = source === "folder" ? servers.filter((server) => folderId && folderPath(groups, server.groupId).some((folder) => folder.id === folderId))
      : source === "tag" ? servers.filter((server) => tagId && (server.tags || []).some((tag: Row) => tag.id === tagId))
      : servers.filter((server) => ids.includes(server.id));
    return [...new Map(chosen.map((server) => [server.id, server])).values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [servers, groups, source, ids, folderId, tagId]);
  const frozen = busy;
  async function execute() {
    const timeoutMs = Number(timeout);
    if (!targets.length || targets.length > 10) return setError("Select 1–10 servers.");
    if (!command.trim() || command.length > 8192) return setError("Enter a command of at most 8192 characters.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) return setError("Timeout must be 100–60000 ms.");
    setBusy(true); setError(""); setResults(null);
    try {
      const payload = { serverIds: targets.map((server) => server.id), command, timeoutMs };
      const response = await api<{ results: Result[] }>("operations/ssh_execute_many", payload);
      if (!Array.isArray(response.results)) throw new Error("The API returned no per-server results.");
      setResults(response.results);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Drawer title="Run command on servers" wide onClose={() => !busy && onClose()} footer={<Button variant="secondary" disabled={busy} onClick={onClose}>Close</Button>}>
    <p className="small">Choose an exact set of 1–10 servers. The command runs immediately using your server permissions.</p>
    <RunbookPicker disabled={frozen || busy} onPreview={(command, timeoutMs) => { setCommand(command); setTimeoutValue(String(timeoutMs)); }} />
    {error && <div className="alert danger" role="alert">{error}</div>}
    <Field label="Choose servers from"><select className="select" disabled={frozen} value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="manual">Selected servers</option><option value="folder">Folder and subfolders</option><option value="tag">Tag</option></select></Field>
    {source === "folder" && <Field label="Folder"><select className="select" disabled={frozen} value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">Choose folder</option>{groups.map((group) => <option key={group.id} value={group.id}>{folderPath(groups, group.id).map((part) => part.name).join(" / ")}</option>)}</select></Field>}
    {source === "tag" && <Field label="Tag"><select className="select" disabled={frozen} value={tagId} onChange={(event) => setTagId(event.target.value)}><option value="">Choose tag</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></Field>}
    {source === "manual" && <Field label="Explicit servers"><div style={{ maxHeight: 160, overflowY: "auto" }}>{servers.map((server) => <label key={server.id} className="row"><input type="checkbox" disabled={frozen} checked={ids.includes(server.id)} onChange={() => setIds((current) => current.includes(server.id) ? current.filter((id) => id !== server.id) : [...current, server.id])} />{server.name} <span className="small">{server.host}</span></label>)}</div></Field>}
    <div className="drawer-section">Exact targets ({targets.length})</div>
    {targets.length > 10 && <div className="alert danger" role="alert">This set has more than 10 servers. Choose a smaller exact set.</div>}
    <ul>{targets.map((server) => <li key={server.id}>{server.name} <span className="small mono">{server.id}</span></li>)}</ul>
    <Field label="Command"><textarea className="textarea mono" disabled={frozen} rows={4} maxLength={8192} value={command} onChange={(event) => setCommand(event.target.value)} /></Field>
    <Field label="Timeout (ms)"><input className="input" disabled={frozen} type="number" min={100} max={60000} value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} /></Field>
    <Button disabled={busy || targets.length < 1 || targets.length > 10 || !command.trim()} onClick={() => void execute()}>{busy ? "Running…" : "Run command"}</Button>
    {results && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>{results.map((entry) => { const output = entry.result?.result || entry.result; return <section key={entry.serverId} className="panel"><b>{servers.find((server) => server.id === entry.serverId)?.name || entry.serverId}</b><div>{entry.status}</div>{entry.error && <div className="alert danger">{entry.error}</div>}{entry.taskId && <div className="small">Task: {entry.taskId}</div>}{output && <><div className="small">stdout</div><pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(output.stdout ?? "")}</pre><div className="small">stderr</div><pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(output.stderr ?? "")}</pre>{output.exitCode !== undefined && <div>Exit code: {String(output.exitCode)}</div>}</>}</section>; })}</div>}
  </Drawer>;
}
