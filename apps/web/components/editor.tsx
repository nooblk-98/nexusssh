"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RotateCw, Save, WrapText, History, GitCompare } from "lucide-react";
import { ApiError, notify, type Row } from "../lib/api";
import { editorGuards, confirmEditorClose } from "../lib/editor-guards";
import { sftp } from "../lib/sftp";
import { savePrefs, usePrefs, useWorkspace, type Tab } from "../lib/store";
import { editorLanguage, editorThemes } from "../lib/themes";
import { Button, IconButton, Dialog } from "./ui";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false },
);

const Monaco = dynamic(
  () =>
    import("@monaco-editor/react").then((m) => {
      m.loader.config({ paths: { vs: "/monaco/vs" } });
      return m.default;
    }),
  { ssr: false },
);
export default function EditorView({ tab, server }: { tab: Tab; server: Row }) {
  const prefs = usePrefs();
  const setStatus = useWorkspace((s) => s.setStatus);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState<string>();
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [revisions, setRevisions] = useState<
    { id: string; createdAt: string }[] | null
  >(null);
  const [comparison, setComparison] = useState<{
    content: string;
    version?: string;
    historical?: boolean;
  } | null>(null);
  const [closing, setClosing] = useState(false);
  const closeDecision = useRef<((allowed: boolean) => void) | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const save = useRef<() => Promise<boolean>>(async () => false);
  const loadRequest = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const load = () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError("");
    setLoadError(false);
    sftp(server.id)
      .read(tab.path!)
      .then((r) => {
        if (request !== loadRequest.current) return;
        setText(r.content);
        setSaved(r.content);
        setVersion(r.version);
        setHistoryEnabled(r.historyEnabled);
        setStatus(tab.id, "connected");
      })
      .catch((e) => {
        if (request !== loadRequest.current) return;
        setLoadError(true);
        setError(e.message);
        setStatus(tab.id, "error");
      })
      .finally(() => {
        if (request === loadRequest.current) setLoading(false);
      });
  };
  useEffect(load, [server.id, tab.path]);
  save.current = async () => {
    if (saving || loading || loadError) return false;
    if (text === saved) return true;
    const submitted = text;
    setSaving(true);
    try {
      const result = await sftp(server.id).write(tab.path!, submitted, version);
      setSaved(submitted);
      setVersion(result.version);
      setError("");
      notify.success("Saved " + tab.title);
      return textRef.current === submitted;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError(e.message);
      else notify.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const dirty = text !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    editorGuards.set(tab.id, () =>
      !dirtyRef.current
        ? Promise.resolve(true)
        : new Promise((resolve) => {
            closeDecision.current = resolve;
            setClosing(true);
          }),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      editorGuards.delete(tab.id);
      window.removeEventListener("beforeunload", beforeUnload);
      closeDecision.current?.(false);
    };
  }, [tab.id]);
  const decide = (allowed: boolean) => {
    setClosing(false);
    closeDecision.current?.(allowed);
    closeDecision.current = null;
  };
  const themeName = prefs.editorTheme;
  const monacoTheme =
    themeName === "Light"
      ? "vs"
      : themeName === "Dark"
        ? "vs-dark"
        : "nexus-" + themeName.toLowerCase();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div className="editor-bar">
        <span
          className="mono ellipsis grow"
          style={{ fontSize: 12 }}
          title={tab.path}
        >
          {tab.path}
          {dirty && <b style={{ color: "var(--warn)" }}> ●</b>}
        </span>
        <IconButton
          label={prefs.editorWrap ? "Disable line wrap" : "Wrap lines"}
          active={prefs.editorWrap}
          onClick={() => void savePrefs({ editorWrap: !prefs.editorWrap })}
        >
          <WrapText size={17} />
        </IconButton>
        <IconButton
          label="Reload from server"
          disabled={loading || saving}
          onClick={() =>
            void confirmEditorClose(tab.id).then((allowed) => allowed && load())
          }
        >
          <RotateCw size={16} />
        </IconButton>
        <Button
          size="sm"
          disabled={!dirty || saving || loading || loadError}
          onClick={() => void save.current()}
        >
          <Save size={14} /> {saving ? "Saving…" : "Save"}
        </Button>
        <IconButton
          label="Preview changes"
          disabled={loading}
          onClick={() => setComparison({ content: saved })}
        >
          <GitCompare size={16} />
        </IconButton>
        {historyEnabled && (
          <IconButton
            label="File history"
            onClick={() =>
              void sftp(server.id)
                .history(tab.path!)
                .then(setRevisions)
                .catch(notify.error)
            }
          >
            <History size={16} />
          </IconButton>
        )}
      </div>
      {error && !loading && !loadError && (
        <div className="alert danger" role="alert">
          {error}
          <Button
            variant="secondary"
            onClick={() =>
              void sftp(server.id)
                .read(tab.path!)
                .then((r) =>
                  setComparison({ content: r.content, version: r.version }),
                )
                .catch(notify.error)
            }
          >
            Compare with remote
          </Button>
        </div>
      )}
      {loadError ? (
        <div className="empty-state">
          <h3>Unable to open this file</h3>
          <p>{error}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <div className="empty-state muted">Loading…</div>
      ) : (
        <Monaco
          height="100%"
          theme={monacoTheme}
          language={editorLanguage(tab.path || "")}
          value={text}
          onChange={(v) => setText(v || "")}
          beforeMount={(monaco) => {
            for (const [name, t] of Object.entries(editorThemes))
              if (t)
                monaco.editor.defineTheme("nexus-" + name.toLowerCase(), {
                  base: t.base,
                  inherit: true,
                  rules: t.rules,
                  colors: t.colors,
                });
          }}
          onMount={(editor, monaco) =>
            editor.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
              () => void save.current(),
            )
          }
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            automaticLayout: true,
            wordWrap: prefs.editorWrap ? "on" : "off",
            scrollBeyondLastLine: false,
          }}
        />
      )}
      {closing && (
        <Dialog
          title="Unsaved changes"
          onClose={() => decide(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => decide(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={saving}
                onClick={() => decide(true)}
              >
                Discard changes
              </Button>
              <Button
                disabled={saving}
                onClick={() =>
                  void save.current().then((saved) => {
                    if (saved) decide(true);
                  })
                }
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <p>Save changes to {tab.title} before continuing?</p>
        </Dialog>
      )}
      {revisions && (
        <Dialog title="File history" onClose={() => setRevisions(null)}>
          <p className="small">
            Previous contents are encrypted. Select a version to compare before
            restoring.
          </p>
          {!revisions.length && <p>No previous versions saved.</p>}
          {revisions.map((r) => (
            <p key={r.id}>
              <Button
                variant="secondary"
                onClick={() =>
                  void sftp(server.id)
                    .historyContent(tab.path!, r.id)
                    .then((v) => {
                      setComparison({ content: v.content, historical: true });
                      setRevisions(null);
                    })
                    .catch(notify.error)
                }
              >
                {new Date(r.createdAt).toLocaleString()}
              </Button>
            </p>
          ))}
        </Dialog>
      )}
      {comparison && (
        <Dialog
          title={
            comparison.historical
              ? "Previous version ↔ Your editor"
              : "Saved / remote ↔ Your editor"
          }
          onClose={() => setComparison(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setComparison(null)}>
                Close
              </Button>
              {comparison.version && (
                <Button
                  onClick={() => {
                    setSaved(comparison.content);
                    setVersion(comparison.version);
                    setError("");
                    setComparison(null);
                  }}
                >
                  Use remote as save baseline
                </Button>
              )}
              {comparison.historical && (
                <Button
                  onClick={() => {
                    const content = comparison.content;
                    setComparison(null);
                    void confirmEditorClose(tab.id).then((allowed) => {
                      if (allowed) setText(content);
                    });
                  }}
                >
                  Load previous version into editor
                </Button>
              )}
            </>
          }
        >
          <div style={{ height: 400, minWidth: "min(70vw, 650px)" }}>
            <DiffEditor
              original={comparison.content}
              modified={text}
              language={editorLanguage(tab.path || "")}
              theme={monacoTheme}
              options={{
                readOnly: true,
                originalEditable: false,
                automaticLayout: true,
                renderSideBySide: false,
              }}
            />
          </div>
          <p className="small">
            Loading a previous version changes the editor only. Review it and
            save to update the remote file.
          </p>
        </Dialog>
      )}
    </div>
  );
}
