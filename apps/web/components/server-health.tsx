"use client";
import { useState } from "react";
import { api, notify, refresh, type Row } from "../lib/api";
import { Button, Drawer, confirmDialog } from "./ui";

type Check = { serverId: string; checkId: string; status: string; checkedAt?: string; failureCategory?: string | null; observedFingerprint?: string | null; fingerprintComparison?: string | null };
type Batch = { batchId: string; status: string; authenticationVerified: boolean; checks: Check[] };
export function healthState(server: Row, now = Date.now()): "reachable" | "unreachable" | "unknown" {
  const checked = server.lastCheckedAt && new Date(server.lastCheckedAt).getTime();
  if (!checked || !Number.isFinite(checked) || now - checked > 30 * 60_000) return "unknown";
  return server.status === "reachable" || server.status === "unreachable" ? server.status : "unknown";
}
export function HealthIndicator({ server, now }: { server: Row; now?: number }) {
  const state = healthState(server, now);
  return <span role="img" aria-label={`Connection ${state}`} title={`${state === "unknown" ? "Not checked recently" : state}${server.lastCheckedAt ? ` · checked ${new Date(server.lastCheckedAt).toLocaleString()}` : ""}`} style={{ color: state === "reachable" ? "var(--success)" : state === "unreachable" ? "var(--danger)" : "var(--text-muted)", fontWeight: 700 }}>●</span>;
}
export function ServerHealth({ servers, title, groupId, canManage, onClose }: { servers: Row[]; title: string; groupId?: string; canManage: boolean; onClose: () => void }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const single = !groupId && servers.length === 1 ? servers[0] : null;
  const observed = single ? batch?.checks.find((c) => c.serverId === single.id && c.status === "reachable" && c.observedFingerprint) : undefined;
  const comparison = observed?.fingerprintComparison;
  async function check() {
    setBusy(true); setError(""); setBatch(null);
    try {
      const started = await api<{ batchId: string }>(groupId ? `groups/${groupId}/checks` : `servers/${single!.id}/check`, {});
      for (let attempt = 0; attempt < 300; attempt++) {
        const current = await api<Batch>(`checks/${started.batchId}`);
        setBatch(current);
        await refresh("servers");
        if (current.status === "completed" || current.status === "expired") {
          if (current.status === "expired") setError("The check expired. Try again.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      setError("The check is still pending. Start a new check to refresh its status.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function saveKey() {
    if (!single || !observed?.observedFingerprint || !observed.checkId || comparison === "match") return;
    const fingerprint = observed.observedFingerprint;
    if (!await confirmDialog("Save host key", <span>Confirm that <b>{fingerprint}</b> matches the fingerprint shown on {single.name}. {comparison === "mismatch" ? "This replaces the previously saved key." : ""}</span>, "Save host key")) return;
    setSaving(true); setError("");
    try {
      await api(`servers/${single.id}/host-key/verify`, { checkId: observed.checkId, fingerprint });
      await refresh("servers"); notify.success("Host key saved for " + single.name + ".");
      setBatch(null);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  const completed = batch?.checks.filter((c) => c.status !== "queued").length ?? 0;
  return <Drawer title={title} onClose={() => !busy && !saving && onClose()} footer={<Button variant="secondary" disabled={busy || saving} onClick={onClose}>Close</Button>}>
    <p className="small">Checks test reachability and observe host keys. They do not verify SSH authentication. Status becomes unknown after 30 minutes.</p>
    <Button disabled={busy || (!groupId && !single)} onClick={() => void check()}>{busy ? "Checking…" : groupId ? "Test all in folder" : "Test server"}</Button>
    {error && <div className="alert danger" role="alert">{error}</div>}
    {batch && <><p role="status" className="small">Batch {batch.status}: {completed} of {batch.checks.length} checked</p>
      <ul>{batch.checks.map((result) => <li key={result.checkId}><b>{servers.find((s) => s.id === result.serverId)?.name || result.serverId}</b>: {result.status}{result.failureCategory && ` · ${result.failureCategory.replaceAll("_", " ")}`}{result.fingerprintComparison && ` · host key ${result.fingerprintComparison}`}</li>)}</ul>
    </>}
    {single && canManage && <section><div className="drawer-section">Host key</div>
      <p className="small">A successful check shows the observed fingerprint. Compare it with the server before saving.</p>
      {observed?.observedFingerprint && <><p><b>{comparison === "match" ? "Matches saved key" : comparison === "mismatch" ? "Changed key" : "New untrusted key"}</b></p>
        <div className="fingerprint mono">Observed: {observed.observedFingerprint}</div>
        {single.fingerprint && <div className="fingerprint mono">Saved: {single.fingerprint}</div>}
        {comparison !== "match" && <Button disabled={saving || busy} onClick={() => void saveKey()}>{saving ? "Saving…" : comparison === "mismatch" ? "Confirm and replace saved key" : "Confirm and save host key"}</Button>}
      </>}
    </section>}
  </Drawer>;
}
