"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RotateCw, Save, WrapText } from "lucide-react";
import { notify, type Row } from "../lib/api";
import { sftp } from "../lib/sftp";
import { savePrefs, usePrefs, useWorkspace, type Tab } from "../lib/store";
import { editorLanguage, editorThemes } from "../lib/themes";
import { Button, IconButton } from "./ui";

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
  const [error, setError] = useState("");
  const save = useRef<() => void>(() => {});
  const load = () => {
    setLoading(true);
    setError("");
    sftp(server.id)
      .read(tab.path!)
      .then((r) => {
        setText(r.content);
        setSaved(r.content);
        setStatus(tab.id, "connected");
      })
      .catch((e) => {
        setError(e.message);
        setStatus(tab.id, "error");
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [server.id, tab.path]);
  save.current = () => {
    if (saving || text === saved) return;
    setSaving(true);
    sftp(server.id)
      .write(tab.path!, text)
      .then(() => {
        setSaved(text);
        notify.success("Saved " + tab.title);
      })
      .catch(notify.error)
      .finally(() => setSaving(false));
  };
  const dirty = text !== saved;
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
          disabled={loading}
          onClick={load}
        >
          <RotateCw size={16} />
        </IconButton>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => save.current()}
        >
          <Save size={14} /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? (
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
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
              save.current(),
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
    </div>
  );
}
