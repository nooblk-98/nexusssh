"use client";
import { useState } from "react";
import { api, refresh, useApi, type Row } from "../../lib/api";
import { Button } from "../ui";

type Entry = { folder: string; file: File; tag?: Row; servers: Row[]; passphrase: string; error?: string; identityId?: string; assigned: number; status?: string };
const MAX_FOLDERS = 25;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_SERVER_PAGES = 1000;
const identityName = (folder: string) => `Imported key: ${folder}`;

export function KeyFolderImport() {
  const tags = useApi<Row[]>("tags");
  const identities = useApi<Row[]>("identities");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);

  const select = async (files: FileList | null) => {
    setConfirmed(false);
    setMessage("");
    setEntries([]);
    const grouped = new Map<string, File[]>();
    for (const file of Array.from(files || [])) {
      const parts = file.webkitRelativePath.split("/");
      // A browser-selected directory is the first component. Only its immediate child folders count.
      if (parts.length !== 3 || !parts[1] || !parts[2]) continue;
      const group = grouped.get(parts[1]) || [];
      group.push(file);
      grouped.set(parts[1], group);
    }
    if (grouped.size > MAX_FOLDERS) {
      setEntries([]);
      setMessage(`Select at most ${MAX_FOLDERS} immediate folders.`);
      return;
    }
    if (!grouped.size) {
      setEntries([]);
      setMessage("No files were found in immediate subfolders.");
      return;
    }
    setLoadingPreview(true);
    const allServers: Row[] = [];
    try {
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_SERVER_PAGES; page++) {
        const result: { servers: Row[]; nextCursor: string | null } = await api(`servers?search=&fields=id,name,tags,archived${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!Array.isArray(result.servers) || result.servers.length > 100) throw new Error("Invalid server page");
        allServers.push(...result.servers.filter((server) => !server.archived));
        if (!result.nextCursor) break;
        if (seen.has(result.nextCursor)) throw new Error("Repeated server cursor");
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
        if (page === MAX_SERVER_PAGES - 1) throw new Error("Server page limit exceeded");
      }
    } catch {
      setMessage("Could not load the complete server list. Retry the folder selection; no keys were imported.");
      setLoadingPreview(false);
      return;
    }
    const imported = Array.from(grouped, ([folder, group]) => {
      const candidates = group.filter((file) => !file.name.endsWith(".pub") && !file.name.startsWith("."));
      const matches = (tags.data || []).filter((tag) => tag.name === folder);
      const tag = matches.length === 1 ? matches[0] : undefined;
      const matched = tag ? allServers.filter((server) => (server.tags || []).some((item: Row) => item.id === tag.id)) : [];
      const existing = (identities.data || []).some((identity) => identity.name === identityName(folder));
      return {
        folder, file: candidates[0] || group[0], tag, servers: matched, passphrase: "", assigned: 0,
        error: candidates.length !== 1 ? "Exactly one private-key file is required." :
          candidates[0].size > MAX_KEY_BYTES ? "Key exceeds 64 KiB." :
          matches.length !== 1 ? "Folder name must match exactly one workspace tag." :
          !matched.length ? "No servers have this tag." :
          existing ? "An imported identity with this name already exists; resolve it before retrying." : undefined,
      };
    });
    const owners = new Map<string, number>();
    imported.forEach((entry) => entry.servers.forEach((server) => owners.set(String(server.id), (owners.get(String(server.id)) || 0) + 1)));
    setEntries(imported.map((entry) => owners.size && entry.servers.some((server) => owners.get(String(server.id))! > 1)
      ? { ...entry, error: "A matched server has multiple selected tags; resolve the overlap before importing." }
      : entry));
    setLoadingPreview(false);
  };

  const run = async () => {
    if (!confirmed || busy || entries.some((entry) => entry.error)) return;
    setBusy(true);
    const next = entries.map((entry) => ({ ...entry }));
    for (const entry of next) {
      if (entry.status === "Complete") continue;
      try {
        if (!entry.identityId) {
          const key = await entry.file.text();
          if (!key.startsWith("-----BEGIN ") || !key.includes("PRIVATE KEY-----")) throw new Error("Invalid private key file.");
          const created = await api<{ id: string }>("identities", { name: identityName(entry.folder), kind: "key", privateKey: key, passphrase: entry.passphrase || undefined }, "POST");
          entry.identityId = created.id;
          entry.status = "Identity created; assigning servers";
          setEntries([...next]);
        }
        const ids = [...new Set(entry.servers.map((server) => String(server.id)))];
        for (let offset = entry.assigned; offset < ids.length; offset += 100) {
          await api("servers/metadata/bulk", { serverIds: ids.slice(offset, offset + 100), settings: { identityId: entry.identityId } }, "POST");
          entry.assigned = Math.min(offset + 100, ids.length);
          setEntries([...next]);
        }
        entry.status = "Complete";
      } catch {
        // API and parsing errors can include sensitive material. Keep the visible outcome generic.
        entry.status = entry.identityId ? "Assignment failed; retry remaining batches" : "Identity creation failed";
      }
      setEntries([...next]);
    }
    setBusy(false);
    await refresh("identities", "servers");
  };

  return <div className="card card-pad key-folder-import">
    <h3>Import keys by tag folder</h3>
    <p>Select a directory whose immediate subfolders each contain one private key. Each folder name must exactly match one workspace tag. The key becomes a new encrypted identity and is assigned to servers with that tag.</p>
    <input className="vpn-file-input" type="file" multiple aria-label="Choose key directory" {...{ webkitdirectory: "" }} onChange={(event) => void select(event.currentTarget.files)} disabled={busy || loadingPreview || tags.isLoading || identities.isLoading} />
    {loadingPreview && <p role="status">Loading all servers for preview…</p>}
    {message && <p role="alert">{message}</p>}
    {!!entries.length && <>
      <div className="settings-table-scroll"><table className="table"><thead><tr><th>Folder</th><th>Key file</th><th>Passphrase</th><th>Matching servers</th><th>Status</th></tr></thead><tbody>
        {entries.map((entry, index) => <tr key={entry.folder}><td>{entry.folder}</td><td>{entry.file.name}</td><td><input type="password" className="input" aria-label={`Passphrase for ${entry.folder}`} autoComplete="off" value={entry.passphrase} disabled={busy || !!entry.identityId} onChange={(event) => { const value = event.target.value; setEntries((current) => current.map((item, i) => i === index ? { ...item, passphrase: value } : item)); setConfirmed(false); }} /></td><td>{entry.servers.length}: {entry.servers.map((server) => server.name).join(", ")}</td><td>{entry.error || entry.status || "Ready"}{entry.identityId && entry.status !== "Complete" ? ` (${entry.assigned}/${entry.servers.length} assigned)` : ""}</td></tr>)}
      </tbody></table></div>
      <p>Import may partly succeed. Keep this page open to retry remaining assignments. If you leave it, inspect identities and server assignments before selecting the folder again; existing imported names are blocked to avoid duplicates.</p>
      <label className="check"><input type="checkbox" checked={confirmed} disabled={busy || entries.some((entry) => !!entry.error)} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm creation and assignment for the servers shown</label>
      <div><Button disabled={!confirmed || busy || entries.some((entry) => !!entry.error) || entries.every((entry) => entry.status === "Complete")} onClick={() => void run()}>{busy ? "Importing…" : entries.some((entry) => !!entry.identityId) ? "Retry remaining" : "Import keys"}</Button></div>
    </>}
  </div>;
}
