"use client";
import { useState } from "react";
import { KeyRound, Pencil, Trash2, Vault } from "lucide-react";
import {
  api,
  notify,
  refresh,
  saveFile,
  useApi,
  type Row,
} from "../../lib/api";
import { savePrefs, usePrefs } from "../../lib/store";
import { editorThemes, terminalFonts, terminalThemes } from "../../lib/themes";
import { VERSION } from "../../lib/app-info";
import {
  Button,
  Check,
  confirmDialog,
  Dialog,
  Drawer,
  Empty,
  Field,
  IconButton,
} from "../ui";
import { PageHead } from "./page-head";
import { KeyFolderImport } from "./key-folder-import";

export function Account({ me }: { me: Row }) {
  const prefs = usePrefs();
  const [editName, setEditName] = useState<string | null>(null);
  const [mfa, setMfa] = useState<Row | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<{
    action: "disable" | "recovery";
    password?: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState<{
    current: string;
    next: string;
    confirm: string;
  } | null>(null);
  const saveName = () =>
    editName?.trim() &&
    api("auth/me", { name: editName.trim() }, "PATCH")
      .then(() => {
        setEditName(null);
        void refresh("auth/me");
      })
      .catch(notify.error);
  return (
    <div className="page narrow account">
      <PageHead title="Account" />
      <h3>Username</h3>
      <p>{me.email}</p>
      <h3>
        Display Name <span style={{ color: "var(--danger)" }}>*</span>
      </h3>
      {editName == null ? (
        <p className="row">
          {me.name}
          <IconButton
            label="Edit display name"
            size="sm"
            onClick={() => setEditName(me.name)}
          >
            <Pencil size={14} color="var(--primary)" />
          </IconButton>
        </p>
      ) : (
        <div className="row account-name-edit" style={{ maxWidth: 420 }}>
          <input
            autoFocus
            className="input"
            maxLength={100}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveName()}
          />
          <Button size="sm" onClick={() => void saveName()}>
            Save
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditName(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      <h3>Two-Factor Authentication</h3>
      {prefs.mfaEnabled ? (
        <>
          <p className="row">
            <span className="badge green">Enabled</span> A one-time code is
            required when you sign in.
          </p>
          <p className="small muted" style={{ marginTop: 8 }}>
            {prefs.recoveryCodesLeft ?? 0} recovery code
            {prefs.recoveryCodesLeft === 1 ? "" : "s"} left.
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <Button
              variant="outline"
              onClick={() => setConfirm({ action: "recovery" })}
            >
              New Recovery Codes
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirm({ action: "disable" })}
            >
              Disable 2FA
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            Add an extra layer of security to your account by enabling
            two-factor authentication.
          </p>
          <Button
            style={{ marginTop: 12 }}
            onClick={() =>
              void api<Row>("auth/mfa/prepare", {})
                .then(setMfa)
                .catch(notify.error)
            }
          >
            Enable 2FA
          </Button>
        </>
      )}
      <h3>Password</h3>
      <Button
        onClick={() => setPassword({ current: "", next: "", confirm: "" })}
      >
        Change Password
      </Button>
      <h3>Workspace Information</h3>
      <div className="card card-pad" style={{ maxWidth: 302 }}>
        <dl className="kv">
          <dt>Workspace:</dt>
          <dd>{me.organization?.name}</dd>
          <dt>Role:</dt>
          <dd style={{ textTransform: "capitalize" }}>{me.role}</dd>
          <dt>Database:</dt>
          <dd>SQLite</dd>
        </dl>
      </div>
      <h3>Version</h3>
      <p>NexusSSH v{VERSION}</p>
      {mfa && (
        <Dialog
          title="Enable Two-Factor Authentication"
          onClose={() => setMfa(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setMfa(null)}>
                Cancel
              </Button>
              <Button
                disabled={code.length !== 6}
                onClick={() =>
                  void api("auth/mfa/enable", {
                    challenge: mfa.challenge,
                    code,
                  })
                    .then((r: Row) => {
                      setMfa(null);
                      setCode("");
                      setCodes(r.recoveryCodes);
                      void refresh("preferences");
                    })
                    .catch(notify.error)
                }
              >
                Verify & Enable
              </Button>
            </>
          }
        >
          <p style={{ marginBottom: 12 }}>
            Add this secret to your authenticator app, then enter the six-digit
            code it shows.
          </p>
          <Field label="Secret key">
            <input
              readOnly
              className="input mono"
              value={mfa.secret}
              onFocus={(e) => e.target.select()}
            />
          </Field>
          <Field
            label="Setup URI"
            hint="Paste into apps that accept otpauth links."
          >
            <input
              readOnly
              className="input mono"
              value={mfa.uri}
              onFocus={(e) => e.target.select()}
              style={{ fontSize: 11 }}
            />
          </Field>
          <Field label="Verification code">
            <input
              autoFocus
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
        </Dialog>
      )}
      {codes && (
        <Dialog
          title="Save Your Recovery Codes"
          onClose={() => setCodes(null)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() =>
                  saveFile(
                    codes.join(String.fromCharCode(10)),
                    "nexusssh-recovery-codes.txt",
                  )
                }
              >
                Download
              </Button>
              <Button onClick={() => setCodes(null)}>I Saved Them</Button>
            </>
          }
        >
          <p style={{ marginBottom: 12 }}>
            Each code signs you in once if you lose your authenticator. They are
            shown only now; store them somewhere safe.
          </p>
          <code className="code" style={{ columns: 2 }}>
            {codes.join(String.fromCharCode(10))}
          </code>
        </Dialog>
      )}
      {confirm && (
        <Dialog
          title={
            confirm.action === "disable"
              ? "Disable Two-Factor Authentication"
              : "Create New Recovery Codes"
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm.action === "disable" ? "danger" : "primary"}
                disabled={!confirm.password}
                onClick={() =>
                  void api<Row>(
                    confirm.action === "disable"
                      ? "auth/mfa/disable"
                      : "auth/mfa/recovery-codes",
                    { password: confirm.password },
                  )
                    .then((r) => {
                      setConfirm(null);
                      void refresh("preferences");
                      if (r.recoveryCodes) setCodes(r.recoveryCodes);
                      else
                        notify.success("Two-factor authentication disabled.");
                    })
                    .catch(notify.error)
                }
              >
                {confirm.action === "disable" ? "Disable 2FA" : "Create Codes"}
              </Button>
            </>
          }
        >
          <p style={{ marginBottom: 12 }}>
            {confirm.action === "disable"
              ? "Your account will only need a password to sign in."
              : "Your current recovery codes stop working."}
          </p>
          <Field label="Confirm with your password">
            <input
              autoFocus
              className="input"
              type="password"
              autoComplete="current-password"
              value={confirm.password || ""}
              onChange={(e) =>
                setConfirm({ ...confirm, password: e.target.value })
              }
            />
          </Field>
        </Dialog>
      )}
      {password && (
        <Dialog
          title="Change Password"
          onClose={() => setPassword(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPassword(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !password.current ||
                  password.next.length < 12 ||
                  password.next !== password.confirm
                }
                onClick={() =>
                  void api("auth/password", {
                    current: password.current,
                    password: password.next,
                  })
                    .then(() => {
                      setPassword(null);
                      notify.success(
                        "Password changed. Other sessions were signed out.",
                      );
                    })
                    .catch(notify.error)
                }
              >
                Change Password
              </Button>
            </>
          }
        >
          <Field label="Current password">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password.current}
              onChange={(e) =>
                setPassword({ ...password, current: e.target.value })
              }
            />
          </Field>
          <Field label="New password" hint="At least 12 characters.">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password.next}
              onChange={(e) =>
                setPassword({ ...password, next: e.target.value })
              }
            />
          </Field>
          <Field
            label="Confirm new password"
            error={
              password.confirm && password.confirm !== password.next
                ? "Passwords do not match."
                : undefined
            }
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password.confirm}
              onChange={(e) =>
                setPassword({ ...password, confirm: e.target.value })
              }
            />
          </Field>
        </Dialog>
      )}
    </div>
  );
}

export function Preferences() {
  const p = usePrefs();
  return (
    <div className="page narrow" style={{ maxWidth: 432 }}>
      <PageHead title="Preferences" />
      <div className="section-title">General</div>
      <Field label="UI Theme">
        <select
          className="select"
          value={p.uiTheme}
          onChange={(e) =>
            void savePrefs({ uiTheme: e.target.value as typeof p.uiTheme })
          }
        >
          <option value="auto">Auto</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>
      <div className="section-title">Terminal</div>
      <Field label="Theme">
        <select
          className="select"
          value={p.terminalTheme}
          onChange={(e) => void savePrefs({ terminalTheme: e.target.value })}
        >
          {Object.keys(terminalThemes).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Font">
        <select
          className="select"
          value={p.terminalFont}
          onChange={(e) => void savePrefs({ terminalFont: e.target.value })}
        >
          {Object.keys(terminalFonts).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Font size">
        <select
          className="select"
          value={p.terminalFontSize}
          onChange={(e) =>
            void savePrefs({ terminalFontSize: Number(e.target.value) })
          }
        >
          {[11, 12, 13, 14, 15, 16, 18, 20].map((n) => (
            <option key={n} value={n}>
              {n}px
            </option>
          ))}
        </select>
      </Field>
      <Check
        label="Copy text on selection"
        checked={p.copyOnSelect}
        onChange={(v) => void savePrefs({ copyOnSelect: v })}
      />
      <h3
        style={{
          margin: "16px 0 6px",
          fontSize: 14,
          fontWeight: 500,
          color: "var(--text-strong)",
        }}
      >
        Text completion (IntelliSense)
      </h3>
      <p className="small" style={{ color: "var(--text-strong)" }}>
        Autocomplete while you type a command in the terminal.
      </p>
      <Check
        label="Use compact suggestions"
        checked={p.compactSuggestions}
        onChange={(v) => void savePrefs({ compactSuggestions: v })}
      />
      <div className="section-title">Text Editor</div>
      <Field label="Theme">
        <select
          className="select"
          value={p.editorTheme}
          onChange={(e) => void savePrefs({ editorTheme: e.target.value })}
        >
          {Object.keys(editorThemes).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Check
        label="Wrap lines"
        checked={p.editorWrap}
        onChange={(v) => void savePrefs({ editorWrap: v })}
      />
    </div>
  );
}

type IdentityForm = {
  id?: string;
  name: string;
  kind: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
};
export function Identities() {
  const q = useApi<Row[]>("identities");
  const [form, setForm] = useState<IdentityForm | null>(null);
  const blank: IdentityForm = {
    name: "",
    kind: "password",
    password: "",
    privateKey: "",
    passphrase: "",
  };
  const list = q.data || [];
  const save = () =>
    form &&
    api(
      form.id ? "identities/" + form.id : "identities",
      {
        name: form.name.trim(),
        kind: form.kind,
        ...(form.kind === "password"
          ? { password: form.password }
          : {
              privateKey: form.privateKey,
              passphrase: form.passphrase || undefined,
            }),
      },
      form.id ? "PATCH" : "POST",
    )
      .then(() => {
        setForm(null);
        void refresh("identities");
        notify.success("Identity saved.");
      })
      .catch(notify.error);
  return (
    <div className="page">
      <PageHead
        title="Identities"
        sub="Store reusable credentials for connecting to multiple servers"
      >
        <Button variant="outline" onClick={() => setForm(blank)}>
          <KeyRound size={17} /> Add Identity
        </Button>
      </PageHead>
      <KeyFolderImport />
      <div className="card table-card">
        {list.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Used by</th>
                <th>Created</th>
                <th style={{ width: 90 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{i.kind === "key" ? "Key File" : "Password"}</td>
                  <td>
                    {i._count?.servers ?? 0} server
                    {i._count?.servers === 1 ? "" : "s"}
                  </td>
                  <td>{new Date(i.createdAt).toLocaleDateString()}</td>
                  <td>
                    <span className="actions row" style={{ gap: 2 }}>
                      <IconButton
                        label="Replace credential"
                        size="sm"
                        onClick={() =>
                          setForm({
                            ...blank,
                            id: i.id,
                            name: i.name,
                            kind: i.kind,
                          })
                        }
                      >
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton
                        label="Delete identity"
                        size="sm"
                        danger
                        onClick={async () => {
                          if (
                            await confirmDialog(
                              "Delete Identity",
                              `Delete “${i.name}”?`,
                              "Delete",
                              true,
                            )
                          )
                            await api("identities/" + i.id, undefined, "DELETE")
                              .then(() => refresh("identities"))
                              .catch(notify.error);
                        }}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Vault size={80} strokeWidth={1.25} />}
            title="No Identities Found"
          >
            Using Identities allows you to use the same credentials across
            multiple servers instead of updating every server after changing
            your password.
            <br />
            <a onClick={() => setForm(blank)}>Click here</a> to add a new
            identity.
          </Empty>
        )}
      </div>
      {form && (
        <Drawer
          title={form.id ? "Edit Identity" : "New Identity"}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !form.name.trim() ||
                  (form.kind === "password" ? !form.password : !form.privateKey)
                }
                onClick={() => void save()}
              >
                Save Identity
              </Button>
            </>
          }
        >
          {form.id && (
            <div className="alert info">
              Saving replaces the stored secret. Servers using this identity
              pick it up on their next connection.
            </div>
          )}
          <Field label="Name" required>
            <input
              autoFocus
              className="input"
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Authentication">
            <select
              className="select"
              value={form.kind}
              onChange={(e) =>
                setForm({
                  ...form,
                  kind: e.target.value as IdentityForm["kind"],
                })
              }
            >
              <option value="password">Password</option>
              <option value="key">Key File</option>
            </select>
          </Field>
          {form.kind === "password" ? (
            <Field label="Password" required>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          ) : (
            <>
              <Field label="Private Key" required>
                <textarea
                  className="textarea mono"
                  rows={6}
                  spellCheck={false}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={form.privateKey}
                  onChange={(e) =>
                    setForm({ ...form, privateKey: e.target.value })
                  }
                />
              </Field>
              <label
                className="btn btn-secondary btn-sm"
                style={{ marginTop: -8, marginBottom: 16 }}
              >
                Load key file
                <input
                  type="file"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f && f.size < 65536)
                      void f
                        .text()
                        .then((privateKey) => setForm({ ...form, privateKey }));
                  }}
                />
              </label>
              <Field label="Passphrase">
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={form.passphrase}
                  onChange={(e) =>
                    setForm({ ...form, passphrase: e.target.value })
                  }
                />
              </Field>
            </>
          )}
        </Drawer>
      )}
    </div>
  );
}
