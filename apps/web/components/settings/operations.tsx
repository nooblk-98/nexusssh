"use client";
import { useState } from "react";
import { api, notify, refresh, useApi } from "../../lib/api";
import { Button, Field, confirmDialog } from "../ui";
import { PageHead } from "./page-head";
type Status = {
  readiness: { status: string; checks: Record<string, boolean> };
  backup: {
    configured: boolean;
    running: boolean;
    offHostConfigured: boolean;
    intervalHours: number;
    lastSuccessAt?: string;
    lastRehearsedAt?: string;
    error?: string;
  };
  sso: { enabled: boolean; label: string };
  fileHistory: { enabled: boolean; retentionDays: number };
};
type Mapping = { id: string; userId: string; issuer: string; subject: string };
type User = { id: string; name: string; email: string; disabled: boolean };
const when = (value?: string) =>
  value ? new Date(value).toLocaleString() : "Never";
export function Operations() {
  const q = useApi<Status>("operations-status", { interval: 15000 });
  const users = useApi<User[]>("users"),
    mappings = useApi<Mapping[]>("sso-identities");
  const [userId, setUserId] = useState(""),
    [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function backup() {
    setBusy(true);
    setError("");
    try {
      await api("operations-status/backup", {});
      await q.refetch();
      notify.success("Backup started. Verification status will update here.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function map() {
    setBusy(true);
    setError("");
    try {
      await api("sso-identities", { userId, subject });
      await refresh("sso-identities");
      setSubject("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page narrow operations-page">
      <PageHead
        title="Operations"
        sub="Application readiness, backup verification and single sign-on."
      />
      {(error || q.error) && (
        <div className="alert danger" role="alert">
          {error || q.error?.message}
        </div>
      )}
      <section className="card card-pad">
        <h2>Service readiness</h2>
        {q.data ? (
          <>
            <p role="status">{q.data.readiness.status}</p>
            {Object.entries(q.data.readiness.checks).map(([name, ready]) => (
              <p key={name}>
                <span className={"badge " + (ready ? "green" : "red")}>
                  {ready ? "Ready" : "Unavailable"}
                </span>{" "}
                {name}
              </p>
            ))}
          </>
        ) : (
          <p>Checking services…</p>
        )}
        <Button variant="secondary" onClick={() => void q.refetch()}>
          Refresh status
        </Button>
      </section>
      <section className="card card-pad">
        <h2>Encrypted backups</h2>
        <p>
          {q.data?.backup.configured
            ? `Scheduled every ${q.data.backup.intervalHours} hours`
            : "Configure an encrypted backup destination in the deployment settings to enable scheduled backups."}
        </p>
        <p>
          Off-host upload:{" "}
          {q.data?.backup.offHostConfigured
            ? "Configured"
            : "Not configured; use a protected off-host mount or configure HTTPS upload"}
        </p>
        <p>Last successful backup: {when(q.data?.backup.lastSuccessAt)}</p>
        <p>Last restore rehearsal: {when(q.data?.backup.lastRehearsedAt)}</p>
        {q.data?.backup.error && (
          <p className="alert danger" role="alert">
            {q.data.backup.error}
          </p>
        )}
        <Button
          disabled={busy || !q.data?.backup.configured || q.data.backup.running}
          onClick={() => void backup()}
        >
          {q.data?.backup.running
            ? "Backing up and verifying…"
            : "Run backup and verify"}
        </Button>
        <p className="small">
          Retain the backup encryption key separately. Verification restores a
          temporary copy and checks database integrity and SSH credential
          decryption.
        </p>
      </section>
      <section className="card card-pad">
        <h2>File history</h2>
        <p>
          {q.data?.fileHistory.enabled
            ? `Enabled: up to 10 previous versions per path, retained for ${q.data.fileHistory.retentionDays} days.`
            : "Disabled. Enable encrypted file history in the deployment settings to retain previous editor saves."}
        </p>
      </section>
      <section className="card card-pad">
        <h2>Single sign-on</h2>
        <p>
          {q.data?.sso.enabled
            ? `${q.data.sso.label} is configured.`
            : "Configure an HTTPS application URL and OIDC provider credentials on the deployment to enable SSO."}
        </p>
        <p className="small">
          Map the provider's exact subject identifier to an existing account.
          Email addresses do not automatically link accounts. Local MFA remains
          required when enabled.
        </p>
        <Field label="User">
          <select
            className="select"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Choose user</option>
            {users.data
              ?.filter((u) => !u.disabled)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.email}
                </option>
              ))}
          </select>
        </Field>
        <Field label="OIDC subject identifier">
          <input
            className="input"
            maxLength={255}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
        <Button
          disabled={busy || !q.data?.sso.enabled || !userId || !subject}
          onClick={() => void map()}
        >
          Map identity
        </Button>
        {mappings.data?.map((m) => (
          <div className="row" key={m.id}>
            <span className="grow">
              {users.data?.find((u) => u.id === m.userId)?.name || m.userId}
              <br />
              <span className="small mono">{m.subject}</span>
            </span>
            <Button
              variant="danger"
              onClick={() =>
                void confirmDialog(
                  "Remove SSO identity",
                  "This also signs the account out of existing browser sessions.",
                  "Remove",
                  true,
                )
                  .then(async (ok) => {
                    if (ok) {
                      await api("sso-identities/" + m.id, undefined, "DELETE");
                      await refresh("sso-identities");
                    }
                  })
                  .catch(notify.error)
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
