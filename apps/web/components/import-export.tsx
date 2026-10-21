"use client";
import { useState } from "react";
import { create } from "zustand";
import { api, notify, refresh, saveFile, useApi, type Row } from "../lib/api";
import { useServers } from "../lib/servers";
import { Button, Drawer, Field } from "./ui";

type Draft = {
  name: string;
  host: string;
  port: number;
  username: string;
  folder?: string;
  icon?: string;
  tags?: string[];
  description?: string;
  fingerprint?: string | null;
  fileRoot?: string;
  environment?: string;
};
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
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  const head = rows.shift()?.map((h) => h.toLowerCase()) || [];
  const col = (r: string[], k: string) => r[head.indexOf(k)] || "";
  return rows.map((r) => ({
    name: col(r, "name") || col(r, "host"),
    host: col(r, "host") || col(r, "address"),
    port: Number(col(r, "port")) || 22,
    username: col(r, "username") || col(r, "user"),
    folder: col(r, "folder") || undefined,
    description: col(r, "notes") || col(r, "description") || undefined,
  }));
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
        version: 1,
        servers: servers.map((s) => ({
          name: s.name,
          host: s.host,
          port: s.port,
          username: s.username,
          folder: folder(s.groupId),
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
  const { servers, groups } = useServers();
  const [text, setText] = useState("");
  const [identityId, setIdentityId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  let drafts: Draft[] = [];
  let error = "";
  try {
    drafts = text.trim() ? parseServers(text).filter((d) => d.host) : [];
  } catch (e) {
    error = (e as Error).message;
  }
  const duplicate = (d: Draft) =>
    servers.some(
      (s) =>
        s.host === d.host && s.port === d.port && s.username === d.username,
    );
  async function run() {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    const folders = new Map(groups.map((g) => [g.name, g.id as string]));
    for (const d of drafts) {
      try {
        let folderId = groupId || null;
        if (d.folder) {
          if (!folders.has(d.folder))
            folders.set(
              d.folder,
              (await api<Row>("groups", { name: d.folder })).id,
            );
          folderId = folders.get(d.folder)!;
        }
        await api("servers", {
          name: d.name.slice(0, 100),
          host: d.host,
          port: d.port,
          username: d.username || "root",
          identityId,
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
        });
        ok++;
      } catch (e) {
        failed.push(`${d.name}: ${(e as Error).message}`);
      }
    }
    await refresh("servers", "groups");
    setBusy(false);
    if (failed.length)
      notify.error(
        `Imported ${ok}; ${failed.length} failed. ${failed.slice(0, 3).join("; ")}`,
      );
    else {
      notify.success(`Imported ${ok} server${ok === 1 ? "" : "s"}.`);
      close();
    }
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
            disabled={busy || !drafts.length || !identityId}
            onClick={() => void run()}
          >
            {busy
              ? "Importing…"
              : `Import ${drafts.length} Server${drafts.length === 1 ? "" : "s"}`}
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
        hint="Paste a NexusSSH JSON export, an OpenSSH ~/.ssh/config, or CSV with name,host,port,username,folder columns."
        error={error || undefined}
      >
        <textarea
          className="textarea mono"
          rows={8}
          spellCheck={false}
          placeholder={"Host web-1\n  HostName 203.0.113.10\n  User deploy"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="grid-2">
        <Field
          label="Identity"
          required
          hint="Credential used for every imported server."
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
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
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
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => (
              <tr key={i}>
                <td>
                  {d.name}
                  {duplicate(d) && (
                    <span className="badge amber" style={{ marginLeft: 6 }}>
                      exists
                    </span>
                  )}
                </td>
                <td className="mono small">
                  {d.host}:{d.port}
                </td>
                <td>{d.username || <span className="muted">root</span>}</td>
                <td>{d.folder || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
