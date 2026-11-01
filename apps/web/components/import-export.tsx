"use client";
import { useState } from "react";
import { create } from "zustand";
import { api, notify, refresh, saveFile, useApi, type Row } from "../lib/api";
import { folderPath, folderOptions } from "../lib/folders";
import { useServers } from "../lib/servers";
import { Button, Drawer, Field } from "./ui";

type Draft = {
  validationError?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  folder?: string;
  folderPath?: string[];
  icon?: string;
  tags?: string[];
  description?: string;
  fingerprint?: string | null;
  fileRoot?: string;
  environment?: string;
  identity?: string;
  vpn?: string;
};
type ImportOutcome = { status: "created" | "duplicate" | "error"; error?: string };
const IMPORT_BATCH_SIZE = 25;
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (!cell || quoted) quoted = !quoted;
      else throw new Error("Invalid CSV quote.");
    } else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function parseTags(value: string): string[] {
  if (!value.trim()) return [];
  if (value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string"))
      throw new Error("Tags must be a JSON array of strings or comma-separated names.");
    return parsed.map((tag) => tag.trim()).filter(Boolean);
  }
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}
// OpenSSH client config: one entry per concrete Host alias; patterns are skipped.
function parseSshConfig(text: string): Draft[] {
  const out: Draft[] = [];
  let current: Draft[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(\w+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host" || key === "match") {
      current =
        key === "host"
          ? value
              .split(/\s+/)
              .filter((h) => !/[*?!]/.test(h))
              .map((h) => ({ name: h, host: h, port: 22, username: "" }))
          : [];
      out.push(...current);
    } else if (key === "hostname") current.forEach((d) => (d.host = value));
    else if (key === "user") current.forEach((d) => (d.username = value));
    else if (key === "port")
      current.forEach((d) => (d.port = Number(value) || 22));
  }
  return out;
}
function parseCsv(text: string): Draft[] {
  const rows = csvRows(text);
  const aliases: Record<string, string> = { hostname: "host", address: "host", user: "username" };
  const head = rows.shift()?.map((h) => {
    const key = h.replace(/^\uFEFF/, "").trim().toLowerCase();
    return aliases[key] || key;
  }) || [];
  if (!head.includes("host"))
    throw new Error("CSV needs a host, hostname, or address column.");
  const col = (r: string[], k: string) => r[head.indexOf(k)] || "";
  return rows.map((r, index) => {
    let tags: string[] = [];
    let validationError: string | undefined;
    try { tags = parseTags(col(r, "tags")); }
    catch { validationError = `Row ${index + 2}: invalid tags.`; }
    return {
      name: col(r, "name") || col(r, "host"),
      host: col(r, "host"),
      port: col(r, "port") ? Number(col(r, "port")) : 22,
      username: col(r, "username"),
      folder: col(r, "folder") || undefined,
      identity: col(r, "identity") || undefined,
      vpn: col(r, "vpn") || undefined,
      tags,
      validationError,
      environment: col(r, "environment") || undefined,
      description: col(r, "notes") || col(r, "description") || undefined,
    };
  });
}
export function parseServers(text: string): Draft[] {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const v = JSON.parse(t);
    return (Array.isArray(v) ? v : v.servers || []).map((s: Row) => ({
      ...s,
      port: Number(s.port) || 22,
    }));
  }
  if (/^\s*host\s/im.test(t)) return parseSshConfig(t);
  return parseCsv(t);
}

const useOpen = create<{
  open: "import" | "export" | null;
  set: (v: "import" | "export" | null) => void;
}>((set) => ({ open: null, set: (open) => set({ open }) }));
export const openImportExport = (v: "import" | "export") =>
  useOpen.getState().set(v);
export function ImportExportHost() {
  const { open, set } = useOpen();
  if (!open) return null;
  return open === "export" ? (
    <Export close={() => set(null)} />
  ) : (
    <Import close={() => set(null)} />
  );
}

function Export({ close }: { close: () => void }) {
  const { servers, groups } = useServers();
  const folder = (id?: string) => groups.find((g) => g.id === id)?.name;
  const json = () =>
    JSON.stringify(
      {
        format: "nexusssh-servers",
        version: 2,
        servers: servers.map((s) => ({
          name: s.name,
          host: s.host,
          port: s.port,
          username: s.username,
          folder: folder(s.groupId),
          folderPath: folderPath(groups, s.groupId).map((g) => g.name),
          icon: s.icon,
          tags: (s.tags || []).map((t: Row) => t.name),
          description: s.description,
          fingerprint: s.fingerprint,
          fileRoot: s.fileRoot,
          environment: s.environment,
        })),
      },
      null,
      2,
    );
  const sshConfig = () =>
    servers
      .map(
        (s) =>
          `Host ${s.name.replace(/\s+/g, "-")}\n  HostName ${s.host}\n  User ${s.username}\n  Port ${s.port}\n`,
      )
      .join("\n");
  return (
    <Drawer
      title="Export Servers"
      onClose={close}
      footer={
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      }
    >
      <p className="small" style={{ lineHeight: 1.6, marginBottom: 16 }}>
        Exports {servers.length} server{servers.length === 1 ? "" : "s"} with
        folders, notes and pinned host keys. Passwords and private keys are
        never exported.
      </p>
      <Button
        block
        onClick={() =>
          saveFile(json(), "nexusssh-servers.json", "application/json")
        }
      >
        Download JSON
      </Button>
      <div style={{ height: 10 }} />
      <Button
        block
        variant="outline"
        onClick={() => saveFile(sshConfig(), "ssh_config")}
      >
        Download as ~/.ssh/config
      </Button>
    </Drawer>
  );
}

function Import({ close }: { close: () => void }) {
  const identities = useApi<Row[]>("identities");
  const vpnProfiles = useApi<Row[]>("vpn-profiles");
  const { servers, groups } = useServers();
  const [text, setText] = useState("");
  const [identityId, setIdentityId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, ImportOutcome>>({});
  const [submittedText, setSubmittedText] = useState("");
  let drafts: Draft[] = [];
  let error = "";
  try {
    drafts = text.trim() ? parseServers(text) : [];
  } catch (e) {
    error = (e as Error).message;
  }
  const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.+$/, "");
  const normalizeFolder = (parts: string[]) => JSON.stringify(parts.map((part) => part.trim().toLowerCase()));
  const folderOf = (d: Draft) => d.folderPath?.length ? d.folderPath : d.folder ? [d.folder] : folderPath(groups, groupId).map((g) => g.name);
  const draftKey = (d: Draft) => JSON.stringify([normalizeHost(d.host), d.port, normalizeFolder(folderOf(d))]);
  const existingServer = (d: Draft) => servers.some((s) =>
    normalizeHost(String(s.host)) === normalizeHost(d.host) && s.port === d.port &&
    normalizeFolder(folderPath(groups, s.groupId).map((g) => g.name)) === normalizeFolder(folderOf(d)),
  );
  const issue = (d: Draft) => {
    if (d.validationError) return d.validationError;
    if (!d.host.trim() || d.host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(d.host.trim())) return "Invalid or missing host";
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) return "Port must be 1–65535";
    if (!d.name.trim() || d.name.length > 100) return "Name must be 1–100 characters";
    if (d.username && !/^[a-z_][a-z0-9_.-]{0,31}$/.test(d.username)) return "Invalid username";
    if (d.identity && !identities.data?.some((i) => i.id === d.identity || i.name === d.identity)) return "Identity not found";
    if (!d.identity && !identityId) return "Choose a default identity";
    if (d.vpn && !vpnProfiles.data?.some((v) => v.id === d.vpn || v.name === d.vpn)) return "VPN profile not found";
    if (d.environment && !["development", "staging", "production"].includes(d.environment)) return "Invalid environment";
    if (d.description && d.description.length > 2000) return "Description exceeds 2000 characters";
    if (d.tags && (d.tags.length > 20 || d.tags.some((tag) => !tag || tag.length > 32))) return "Use at most 20 tags of 1–32 characters";
    return "";
  };
  const firstDraft = new Map<string, number>();
  const repeatedDraft = drafts.map((d, index) => {
    if (issue(d)) return undefined;
    const key = draftKey(d);
    const first = firstDraft.get(key);
    if (first === undefined) firstDraft.set(key, index);
    return first;
  });
  const validCount = drafts.filter((d, index) => !issue(d) && repeatedDraft[index] === undefined).length;
  async function run() {
    setBusy(true);
    setSubmittedText(text);
    const next: Record<number, ImportOutcome> = {};
    const folders = new Map(
      groups.map((g) => [
        JSON.stringify(folderPath(groups, g.id).map((f) => f.name)),
        g.id as string,
      ]),
    );
    const ready: { index: number; body: Row }[] = [];
    for (const [index, d] of drafts.entries()) {
      const validation = issue(d);
      if (validation) { next[index] = { status: "error", error: validation }; continue; }
      if (repeatedDraft[index] !== undefined) { next[index] = { status: "duplicate", error: `Same host, port and folder as row ${repeatedDraft[index]! + 1}; skipped` }; continue; }
      try {
        let folderId = groupId || null;
        const path = d.folderPath?.length
          ? d.folderPath
          : d.folder
            ? [d.folder]
            : groupId
              ? folderPath(groups, groupId).map((g) => g.name)
              : [];
        if (path.length) {
          let parentId: string | null = null;
          for (let i = 0; i < path.length; i++) {
            const key = JSON.stringify(path.slice(0, i + 1));
            if (!folders.has(key))
              folders.set(
                key,
                (await api<Row>("groups", { name: path[i], parentId })).id,
              );
            parentId = folders.get(key)!;
          }
          folderId = parentId;
        }
        ready.push({ index, body: {
          name: d.name.slice(0, 100),
          host: d.host.trim(),
          port: d.port,
          username: d.username || "root",
          identityId: (identities.data || []).find((i) => i.id === d.identity || i.name === d.identity)?.id || identityId,
          vpnProfileId: (vpnProfiles.data || []).find((v) => v.id === d.vpn || v.name === d.vpn)?.id || null,
          fingerprint: d.fingerprint || null,
          fileRoot:
            d.fileRoot ||
            (d.username && d.username !== "root"
              ? "/home/" + d.username
              : "/root"),
          environment: d.environment || "development",
          description: d.description || "",
          icon: d.icon || "linux",
          tags: d.tags || [],
          groupId: folderId,
        } });
      } catch {
        next[index] = { status: "error", error: "Could not prepare folder" };
      }
    }
    for (let start = 0; start < ready.length; start += IMPORT_BATCH_SIZE) {
      const batch = ready.slice(start, start + IMPORT_BATCH_SIZE);
      try {
        const response = await api<{ results: { index: number; status: ImportOutcome["status"]; error?: string }[] }>("servers/import", { servers: batch.map((item) => item.body) });
        for (const [position, item] of batch.entries()) {
          const result = response.results?.find((r) => r.index === position);
          next[item.index] = result && ["created", "duplicate", "error"].includes(result.status)
            ? { status: result.status, error: result.error }
            : { status: "error", error: "No result returned" };
        }
      } catch {
        for (const item of batch) next[item.index] = { status: "error", error: "Batch request failed; retry to check for duplicates" };
      }
    }
    setOutcomes(next);
    await refresh("servers", "groups");
    setBusy(false);
    notify.info(`${Object.values(next).filter((o) => o.status === "created").length} created, ${Object.values(next).filter((o) => o.status === "duplicate").length} duplicates, ${Object.values(next).filter((o) => o.status === "error").length} errors.`);
  }
  return (
    <Drawer
      title="Import Servers"
      wide
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !validCount || !!error}
            onClick={() => void run()}
          >
            {busy
              ? "Importing…"
              : `Import ${validCount} Server${validCount === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <Field
        label={
          <span className="row" style={{ justifyContent: "space-between" }}>
            Servers
            <label
              className="small"
              style={{ color: "var(--primary)", cursor: "pointer" }}
            >
              Load file
              <input
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 2 * 1024 * 1024)
                    void f.text().then(setText);
                }}
              />
            </label>
          </span>
        }
        hint="Paste a NexusSSH JSON export, OpenSSH config, or CSV with name,host,port,username,folder,identity,vpn,tags,environment,description columns. CSV also accepts hostname/address for host and user for username. Blank usernames use root. Quote fields containing commas."
        error={error || undefined}
      >
        <textarea
          className="textarea mono"
          rows={8}
          spellCheck={false}
          placeholder={"Host web-1\n  HostName 203.0.113.10\n  User deploy"}
          value={text}
          onChange={(e) => { setText(e.target.value); setOutcomes({}); }}
        />
      </Field>
      <div className="grid-2">
        <Field
          label="Identity"
          hint="Default credential when a row has no identity."
        >
          <select
            className="select"
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
          >
            <option value="">Choose identity</option>
            {(identities.data || []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Folder" hint="Used when an entry names no folder.">
          <select
            className="select"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">None</option>
            {folderOptions(groups).map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {drafts.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>User</th>
              <th>Folder</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => (
              <tr key={i}>
                <td>
                  {d.name}
                  {existingServer(d) && (
                    <span className="badge amber" style={{ marginLeft: 6 }}>
                      server exists in folder
                    </span>
                  )}
                  {repeatedDraft[i] !== undefined && <span className="badge amber" style={{ marginLeft: 6 }}>same host, port and folder as row {repeatedDraft[i]! + 1}</span>}
                </td>
                <td className="mono small">
                  {d.host}:{d.port}
                </td>
                <td>{d.username || <span className="muted">root</span>}</td>
                <td>{d.folder || "-"}</td>
                <td>{submittedText === text && outcomes[i] ? `${outcomes[i].status}${outcomes[i].error ? `: ${outcomes[i].error}` : ""}` : issue(d) || (repeatedDraft[i] !== undefined ? "Duplicate draft" : existingServer(d) ? "Already exists" : "Ready")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
