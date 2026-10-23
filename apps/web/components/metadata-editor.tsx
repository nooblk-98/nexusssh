"use client";
import { useState } from "react";
import { api, notify, refresh, useApi, type Row } from "../lib/api";
import { Button, Drawer, Field } from "./ui";

const keys = ["identityId", "username", "environment", "vpnProfileId"] as const;
type Key = (typeof keys)[number];
type Change = { settings: Row; inherit: Key[]; metadata: Row };
const labels: Record<Key, string> = { identityId: "Identity", username: "Username", environment: "Environment", vpnProfileId: "VPN profile" };
export function parseDefaults(value: unknown): Row {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value as Row : {};
}
export function MetadataEditor({ title, initial = {}, values, sources, hardware = false, hardwareInitial = {}, bulk = false, onSave, onClose }: {
  title: string; initial?: Row; values?: Row; sources?: Row; hardware?: boolean; hardwareInitial?: Row; bulk?: boolean;
  onSave: (change: Change) => Promise<void>; onClose?: () => void;
}) {
  const identities = useApi<Row[]>("identities");
  const vpn = useApi<Row[]>("vpn-profiles");
  const [modes, setModes] = useState<Record<Key, string>>(() => Object.fromEntries(keys.map((k) => [k, bulk ? "keep" : Object.hasOwn(initial, k) ? "set" : "inherit"])) as Record<Key, string>);
  const [form, setForm] = useState<Row>(() => ({ ...values, ...initial }));
  const [metadata, setMetadata] = useState<Row>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const settings: Row = {};
    const inherit: Key[] = [];
    for (const key of keys) {
      if (modes[key] === "inherit") inherit.push(key);
      if (modes[key] === "set") {
        if (key !== "vpnProfileId" && !form[key]) return setError(`${labels[key]} needs a value.`);
        settings[key] = key === "vpnProfileId" && !form[key] ? null : form[key];
      }
    }
    if (Object.keys(metadata).some((key) => ["vcpu", "ramBytes", "diskBytes"].includes(key) && metadata[key] !== null && (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0))) return setError("Hardware values must be nonnegative whole numbers.");
    setBusy(true); setError("");
    try { await onSave({ settings, inherit, metadata }); onClose?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Drawer title={title} onClose={() => !busy && onClose?.()} footer={<Button disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</Button>}>
    {error && <div className="alert danger" role="alert">{error}</div>}
    {keys.map((key) => <Field key={key} label={labels[key]} hint={sources?.[key] ? `Effective: ${String(values?.[key] ?? "None")} · Source: ${sources[key].type}${sources[key].id ? ` (${sources[key].id})` : ""}` : undefined}>
      <select className="select" aria-label={`${labels[key]} mode`} value={modes[key]} onChange={(e) => setModes({ ...modes, [key]: e.target.value })}>
        {bulk && <option value="keep">Keep current</option>}
        <option value="inherit">{bulk ? "Use inherited default (remove override)" : "Use inherited default / remove value"}</option><option value="set">{bulk ? "Set on selected" : "Override / set default"}</option>
      </select>
      {modes[key] === "set" && (key === "identityId" ? <select className="select" value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })}><option value="">Choose identity</option>{(identities.data || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        : key === "vpnProfileId" ? <select className="select" value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })}><option value="">None</option>{(vpn.data || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        : key === "environment" ? <select className="select" value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })}><option value="">Choose environment</option>{["development", "staging", "production"].map((x) => <option key={x}>{x}</option>)}</select>
        : <input className="input" value={form[key] || ""} maxLength={32} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />)}
    </Field>)}
    {hardware && <><div className="drawer-section">Hardware and role</div>{(["vcpu", "ramBytes", "diskBytes", "os", "role"] as const).map((key) => <Field key={key} label={{ vcpu: "vCPU", ramBytes: "RAM (bytes)", diskBytes: "Disk (bytes)", os: "Operating system", role: "Role" }[key]}>
      <input className="input" type={key === "os" || key === "role" ? "text" : "number"} min={0} step={1} maxLength={100} placeholder={bulk ? "Leave blank to keep current" : "Optional"} value={metadata[key] === null ? "" : metadata[key] ?? hardwareInitial[key] ?? ""} onChange={(e) => setMetadata({ ...metadata, [key]: e.target.value === "" ? null : key === "os" || key === "role" ? e.target.value : Number(e.target.value) })} />
    </Field>)}</>}
  </Drawer>;
}

export function DefaultsEditor({ kind, row, onClose }: { kind: "groups" | "tags"; row: Row; onClose: () => void }) {
  return <MetadataEditor title={`${kind === "groups" ? "Folder" : "Tag"} defaults: ${row.name}`} initial={parseDefaults(row.defaults)} onClose={onClose} onSave={async ({ settings, inherit }) => {
    await api(`${kind}/${row.id}/defaults`, { settings, inherit }, "PATCH");
    await refresh(kind, "servers"); notify.success("Defaults saved.");
  }} />;
}
