"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { create } from "zustand";
import { ArrowLeft, ChevronDown, ScanLine, ShieldCheck } from "lucide-react";
import { api, notify, refresh, useApi, type Row } from "../lib/api";
import { navigate } from "../lib/router";
import {
  connectServer,
  serverBody,
  settingsOf,
  useServers,
} from "../lib/servers";
import { serverIcons, ServerIcon, type ServerIconName } from "./icons";
import { Button, Check, Drawer, Field } from "./ui";

type Open = {
  server?: Row;
  groupId?: string;
  prefill?: { host: string; port: number; username: string };
  connectAfter?: boolean;
};
const useDrawer = create<{ open: Open | null; set: (o: Open | null) => void }>(
  (set) => ({ open: null, set: (open) => set({ open }) }),
);
export const openServerDrawer = (o: Open) => useDrawer.getState().set(o);

export const terminalDefaults = {
  encoding: "utf-8",
  backspaceCtrlH: false,
  altIsMeta: false,
  ctrlCCopy: false,
  ctrlVPaste: true,
  scrollOnKeystroke: true,
  showScrollbar: true,
};
const encodings: Record<string, string> = {
  "utf-8": "UTF-8",
  "iso-8859-1": "ISO-8859-1 (Latin-1)",
  "windows-1252": "Windows-1252",
  "iso-8859-15": "ISO-8859-15",
  "koi8-r": "KOI8-R",
  shift_jis: "Shift_JIS",
  "euc-kr": "EUC-KR",
  gbk: "GBK",
  big5: "Big5",
};

export function ServerDrawerHost() {
  const { open, set } = useDrawer();
  if (!open) return null;
  return (
    <ServerDrawer
      key={open.server?.id || "new"}
      o={open}
      close={() => set(null)}
    />
  );
}
function ServerDrawer({ o, close }: { o: Open; close: () => void }) {
  const s = o.server;
  const identities = useApi<Row[]>("identities");
  const { servers, groups } = useServers();
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [iconOpen, setIconOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [v, setV] = useState(() => ({
    name: s?.name || "",
    icon: (s?.icon || "linux") as ServerIconName,
    host: s?.host || o.prefill?.host || "",
    port: String(s?.port || o.prefill?.port || 22),
    identityId: s?.identityId || "",
    authType: "password" as "password" | "key",
    username: s?.username || o.prefill?.username || "",
    password: "",
    privateKey: "",
    passphrase: "",
    fingerprint: s?.fingerprint || "",
    groupId: s?.groupId || o.groupId || "",
    description: s?.description || "",
    fileRoot: s?.fileRoot || "/home",
    environment: s?.environment || "development",
    bastionId: s?.bastionId || "",
    tags: (s?.tags || []).map((t: Row) => t.name).join(", "),
  }));
  const [term, setTerm] = useState({
    ...terminalDefaults,
    ...(s ? settingsOf(s) : {}),
  });
  const keyFile = useRef<HTMLInputElement>(null);
  const put = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  async function scan() {
    if (!v.host) return setErrors({ host: "Enter the address first." });
    setScanning(true);
    try {
      const r = await api<Row>("servers/scan-host-key", {
        host: v.host.trim(),
        port: Number(v.port) || 22,
      });
      setV((x) => ({ ...x, fingerprint: r.fingerprint }));
      notify.info(
        "Host key received. Compare it with the server's own fingerprint before saving.",
      );
    } catch (e) {
      notify.error(e);
    } finally {
      setScanning(false);
    }
  }
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const err: Record<string, string> = {};
    if (!v.name.trim()) err.name = "This field is required.";
    if (!/^[a-zA-Z0-9.:-]+$/.test(v.host.trim()))
      err.host = "Invalid hostname or IP address";
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      err.port = "Port must be between 1 and 65535";
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v.username))
      err.username = "Use a valid Linux user name.";
    if (!v.identityId) {
      if (v.authType === "password" && !v.password && !s)
        err.password = "This field is required.";
      if (v.authType === "key" && !v.privateKey)
        err.privateKey = "This field is required.";
      if (s && v.authType === "password" && !v.password)
        err.password = "Enter a password or choose an identity.";
    }
    if (v.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(v.fingerprint))
      err.fingerprint = "Expected SHA256:… (43 characters).";
    setErrors(err);
    if (Object.keys(err).length) {
      if (err.fileRoot) setAdvanced(true);
      return;
    }
    setBusy(true);
    try {
      let identityId = v.identityId;
      if (!identityId) {
        const created = await api<Row>("identities", {
          name: `${v.name.trim()} (${v.username})`,
          kind: v.authType,
          ...(v.authType === "password"
            ? { password: v.password }
            : {
                privateKey: v.privateKey,
                passphrase: v.passphrase || undefined,
              }),
        });
        identityId = created.id;
        void refresh("identities");
      }
      const body = serverBody(s || {}, {
        name: v.name.trim(),
        icon: v.icon,
        host: v.host.trim(),
        port,
        username: v.username,
        identityId,
        fingerprint: v.fingerprint || null,
        groupId: v.groupId || null,
        description: v.description,
        fileRoot: v.fileRoot,
        environment: v.environment,
        bastionId: v.bastionId || null,
        tags: String(v.tags)
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean),
        terminalSettings: term,
        favorite: !!s?.favorite,
      });
      const saved = await api<Row>(
        s ? "servers/" + s.id : "servers",
        body,
        s ? "PATCH" : "POST",
      );
      await refresh("servers");
      notify.success(s ? "Server saved." : "Server added.");
      close();
      if (o.connectAfter) connectServer(saved);
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!iconOpen) return;
    const f = () => setIconOpen(false);
    setTimeout(() => document.addEventListener("click", f, { once: true }));
    return () => document.removeEventListener("click", f);
  }, [iconOpen]);
  if (advanced)
    return (
      <Drawer
        title="Advanced Settings"
        onClose={close}
        head={
          <button
            className="btn btn-text btn-sm"
            onClick={() => setAdvanced(false)}
          >
            <ArrowLeft size={16} /> Back
          </button>
        }
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              Save Settings
            </Button>
          </>
        }
      >
        <div className="drawer-section">Encoding</div>
        <Field label="Terminal encoding">
          <select
            className="select"
            value={term.encoding}
            onChange={(e) => setTerm({ ...term, encoding: e.target.value })}
          >
            {Object.entries(encodings).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="drawer-section">Keyboard</div>
        <Check
          label="Backspace as Ctrl-H"
          checked={term.backspaceCtrlH}
          onChange={(c) => setTerm({ ...term, backspaceCtrlH: c })}
        />
        <Check
          label="Treat Alt key as Meta key"
          checked={term.altIsMeta}
          onChange={(c) => setTerm({ ...term, altIsMeta: c })}
        />
        <Check
          label="Ctrl+C copies the selection"
          checked={term.ctrlCCopy}
          onChange={(c) => setTerm({ ...term, ctrlCCopy: c })}
        />
        <Check
          label="Ctrl+V pastes from the clipboard"
          checked={term.ctrlVPaste}
          onChange={(c) => setTerm({ ...term, ctrlVPaste: c })}
        />
        <div className="drawer-section" style={{ marginTop: 18 }}>
          Scrolling
        </div>
        <Check
          label="Scroll to bottom after keystroke"
          checked={term.scrollOnKeystroke}
          onChange={(c) => setTerm({ ...term, scrollOnKeystroke: c })}
        />
        <Check
          label="Scrollbar visibility"
          checked={term.showScrollbar}
          onChange={(c) => setTerm({ ...term, showScrollbar: c })}
        />
        <div className="drawer-section" style={{ marginTop: 18 }}>
          Access
        </div>
        <Field
          label="SFTP root"
          required
          hint="File browsing and transfers stay inside this directory."
          error={errors.fileRoot}
        >
          <input
            className="input"
            value={v.fileRoot}
            onChange={put("fileRoot")}
          />
        </Field>
        <Field label="Environment">
          <select
            className="select"
            value={v.environment}
            onChange={put("environment")}
          >
            <option value="development">Development</option>
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
        </Field>
        <Field
          label="Jump host"
          hint="Connect through another saved server (one hop)."
        >
          <select
            className="select"
            value={v.bastionId}
            onChange={put("bastionId")}
          >
            <option value="">None</option>
            {servers
              .filter((x) => x.id !== s?.id && !x.bastionId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Tags" hint="Separate tags with commas.">
          <input className="input" value={v.tags} onChange={put("tags")} />
        </Field>
      </Drawer>
    );
  return (
    <Drawer
      title={s ? "Edit Server" : "New Server"}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save Server"}
          </Button>
        </>
      }
    >
      <form id="serverForm" onSubmit={submit} noValidate>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 96px", gap: 12 }}
        >
          <Field label="Display Name" required error={errors.name}>
            <input
              autoFocus
              className={"input" + (errors.name ? " invalid" : "")}
              placeholder="Linux Server"
              maxLength={100}
              value={v.name}
              onChange={put("name")}
            />
          </Field>
          <div className="field" style={{ position: "relative" }}>
            <span className="label">
              Icon<span className="required">*</span>
            </span>
            <button
              type="button"
              className="picker"
              aria-label="Choose icon"
              onClick={() => setIconOpen(!iconOpen)}
            >
              <ServerIcon name={v.icon} size={22} />
              <ChevronDown size={16} />
            </button>
            {iconOpen && (
              <div
                className="menu"
                style={{ position: "absolute", top: 64, right: 0, width: 230 }}
              >
                <div className="icon-grid">
                  {(Object.keys(serverIcons) as ServerIconName[]).map((k) => (
                    <button
                      type="button"
                      key={k}
                      title={serverIcons[k][0]}
                      aria-label={serverIcons[k][0]}
                      className={v.icon === k ? "on" : ""}
                      onClick={() => setV((x) => ({ ...x, icon: k }))}
                    >
                      <ServerIcon name={k} size={22} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <Field label="Address" required error={errors.host}>
          <input
            className={"input" + (errors.host ? " invalid" : "")}
            placeholder="IP Address or Hostname"
            value={v.host}
            onChange={put("host")}
          />
        </Field>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 96px", gap: 12 }}
        >
          <Field label="Protocol">
            <select className="select" defaultValue="ssh">
              <option value="ssh">SSH v2</option>
            </select>
          </Field>
          <Field label="Port" required error={errors.port}>
            <input
              className={"input" + (errors.port ? " invalid" : "")}
              inputMode="numeric"
              value={v.port}
              onChange={put("port")}
            />
          </Field>
        </div>
        <Field
          label={
            <span className="row" style={{ justifyContent: "space-between" }}>
              Identity
              <a
                className="small"
                onClick={() => (close(), navigate("/settings/identities"))}
              >
                Manage
              </a>
            </span>
          }
        >
          <select
            className="select"
            value={v.identityId}
            onChange={put("identityId")}
          >
            <option value="">No Identity</option>
            {(identities.data || []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} · {i.kind === "key" ? "Key File" : "Password"}
              </option>
            ))}
          </select>
        </Field>
        {!v.identityId && (
          <Field label="Authentication">
            <select
              className="select"
              value={v.authType}
              onChange={put("authType")}
            >
              <option value="password">Password</option>
              <option value="key">Key File</option>
            </select>
          </Field>
        )}
        <Field label="Username" required error={errors.username}>
          <input
            className={"input" + (errors.username ? " invalid" : "")}
            autoComplete="off"
            value={v.username}
            onChange={put("username")}
          />
        </Field>
        {!v.identityId && v.authType === "password" && (
          <Field
            label="Password"
            error={errors.password}
            hint={
              s
                ? "Saving creates a new stored credential for this server."
                : undefined
            }
          >
            <input
              className={"input" + (errors.password ? " invalid" : "")}
              type="password"
              autoComplete="new-password"
              value={v.password}
              onChange={put("password")}
            />
          </Field>
        )}
        {!v.identityId && v.authType === "key" && (
          <>
            <Field
              label={
                <span
                  className="row"
                  style={{ justifyContent: "space-between" }}
                >
                  Private Key
                  <a className="small" onClick={() => keyFile.current?.click()}>
                    Load file
                  </a>
                </span>
              }
              error={errors.privateKey}
            >
              <textarea
                className="textarea mono"
                rows={4}
                spellCheck={false}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={v.privateKey}
                onChange={put("privateKey")}
              />
              <input
                ref={keyFile}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 65536)
                    void f
                      .text()
                      .then((privateKey) =>
                        setV((x) => ({ ...x, privateKey })),
                      );
                }}
              />
            </Field>
            <Field label="Passphrase">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={v.passphrase}
                onChange={put("passphrase")}
              />
            </Field>
          </>
        )}
        <Field
          label="Host Key Fingerprint"
          error={errors.fingerprint}
          hint="Connections are refused until a verified host key is saved. Compare with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
        >
          <div className="input-group">
            <input
              className={"input mono" + (errors.fingerprint ? " invalid" : "")}
              placeholder="SHA256:…"
              value={v.fingerprint}
              onChange={put("fingerprint")}
              style={{ fontSize: 12 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={scanning}
              onClick={() => void scan()}
              title="Read the key the server presents"
            >
              <ScanLine size={15} />
              {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
        </Field>
        {v.fingerprint && v.fingerprint === s?.fingerprint && (
          <p
            className="small row"
            style={{
              marginTop: -10,
              marginBottom: 14,
              color: "var(--success)",
            }}
          >
            <ShieldCheck size={14} /> Pinned host key
          </p>
        )}
        <Field label="Folder">
          <select
            className="select"
            value={v.groupId}
            onChange={put("groupId")}
          >
            <option value="">None</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes">
          <textarea
            className="textarea"
            rows={1}
            maxLength={2000}
            value={v.description}
            onChange={put("description")}
          />
        </Field>
        <Button variant="secondary" block onClick={() => setAdvanced(true)}>
          Advanced Settings
        </Button>
      </form>
    </Drawer>
  );
}
