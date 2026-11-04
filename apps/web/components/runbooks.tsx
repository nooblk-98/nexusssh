"use client";
import { useState } from "react";
import { api, notify, refresh, useApi } from "../lib/api";
import { Button, Field, confirmDialog } from "./ui";
import { PageHead } from "./settings/page-head";
type Revision = { id: string; version: number; createdAt: string };
type Runbook = { id: string; name: string; revisions: Revision[] };
type Definition = {
  template: string;
  timeoutMs: number;
  parameters: string[];
  version: number;
};
export function RunbookPicker({
  onPreview,
  disabled,
}: {
  onPreview: (command: string, timeoutMs: number) => void;
  disabled: boolean;
}) {
  const books = useApi<Runbook[]>("runbooks");
  const [book, setBook] = useState(""),
    [revision, setRevision] = useState("");
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selected = books.data?.find((b) => b.id === book);
  async function choose(id: string, revisionId: string) {
    setBook(id);
    setRevision(revisionId);
    setDefinition(null);
    setValues({});
    setError("");
    if (!id || !revisionId) return;
    setBusy(true);
    try {
      setDefinition(
        await api<Definition>(`runbooks/${id}/revisions/${revisionId}`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ command: string; timeoutMs: number }>(
        `runbooks/${book}/revisions/${revision}/preview`,
        values,
      );
      onPreview(r.command, r.timeoutMs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <Field label="Use a runbook">
        <select
          className="select"
          disabled={disabled || busy}
          value={book}
          onChange={(e) => {
            const b = books.data?.find((b) => b.id === e.target.value);
            void choose(b?.id || "", b?.revisions[0]?.id || "");
          }}
        >
          <option value="">Custom command</option>
          {books.data?.map((b) => (
            <option value={b.id} key={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <Field label="Version">
          <select
            className="select"
            disabled={disabled || busy}
            value={revision}
            onChange={(e) => void choose(book, e.target.value)}
          >
            {selected.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                Version {r.version}
              </option>
            ))}
          </select>
        </Field>
      )}
      {definition && (
        <>
          <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
            {definition.template}
          </pre>
          {definition.parameters.map((name) => (
            <Field key={name} label={name}>
              <input
                className="input"
                disabled={disabled || busy}
                maxLength={1000}
                value={values[name] || ""}
                onChange={(e) =>
                  setValues({ ...values, [name]: e.target.value })
                }
              />
            </Field>
          ))}
          <Button
            variant="secondary"
            disabled={
              disabled ||
              busy ||
              definition.parameters.some((p) => values[p] === undefined)
            }
            onClick={() => void preview()}
          >
            Preview exact command
          </Button>
          <p className="small">
            Review the generated command and targets below, then request
            approval.
          </p>
        </>
      )}
      {error && (
        <p className="alert danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function RunbooksPage() {
  const books = useApi<Runbook[]>("runbooks");
  const [name, setName] = useState(""),
    [template, setTemplate] = useState(""),
    [timeout, setTimeoutValue] = useState(30000);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("runbooks", {
        name,
        definition: { template, timeoutMs: timeout },
      });
      await refresh("runbooks");
      notify.success("Runbook version saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page narrow runbooks-page">
      <PageHead
        title="Runbooks"
        sub="Versioned command templates for the multi-server approval workflow."
      />
      {error && (
        <div className="alert danger" role="alert">
          {error}
        </div>
      )}
      <section className="card card-pad">
        <Field label="Runbook name">
          <input
            className="input"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Command template"
          hint="Use {{service}} outside quotes. Values are quoted automatically. Use a single line without command substitutions or heredocs."
        >
          <textarea
            className="textarea mono"
            rows={3}
            maxLength={4096}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="systemctl status -- {{service}}"
          />
        </Field>
        <Field label="Timeout (ms)">
          <input
            className="input"
            type="number"
            min={100}
            max={60000}
            value={timeout}
            onChange={(e) => setTimeoutValue(Number(e.target.value))}
          />
        </Field>
        <Button
          disabled={busy || !name.trim() || !template.trim()}
          onClick={() => void save()}
        >
          Save new version
        </Button>
        <p className="small">
          Saving the same name creates a new version. Runbooks do not grant
          permissions or skip approvals.
        </p>
      </section>
      {books.data?.map((b) => (
        <section className="card card-pad" key={b.id}>
          <b>{b.name}</b>
          <div className="runbook-actions">
            {b.revisions.slice(0, 5).map((r) => (
              <Button
                variant="secondary"
                key={r.id}
                onClick={() =>
                  void api<Definition>(`runbooks/${b.id}/revisions/${r.id}`)
                    .then((d) => {
                      setName(b.name);
                      setTemplate(d.template);
                      setTimeoutValue(d.timeoutMs);
                    })
                    .catch(notify.error)
                }
              >
                Load v{r.version}
              </Button>
            ))}
            <Button
              variant="danger"
              onClick={() =>
                void confirmDialog(
                  "Delete runbook",
                  `Delete “${b.name}” and its template versions?`,
                  "Delete",
                  true,
                )
                  .then(async (ok) => {
                    if (ok) {
                      await api("runbooks/" + b.id, undefined, "DELETE");
                      await refresh("runbooks");
                    }
                  })
                  .catch(notify.error)
              }
            >
              Delete
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
