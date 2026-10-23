"use client";
import { useState } from "react";
import { create } from "zustand";
import { Code2, Plus, Trash2 } from "lucide-react";
import { api, notify, refresh, useApi, type Row } from "../lib/api";
import { sendInput } from "../lib/store";
import {
  Button,
  confirmDialog,
  Drawer,
  Field,
  IconButton,
  SearchInput,
} from "./ui";

const useSnippetsDrawer = create<{
  tab: string | null;
  set: (t: string | null) => void;
}>((set) => ({ tab: null, set: (tab) => set({ tab }) }));
export const openSnippets = (tab: string) =>
  useSnippetsDrawer.getState().set(tab);
export function SnippetsDrawerHost({ admin }: { admin: boolean }) {
  const { tab, set } = useSnippetsDrawer();
  if (!tab) return null;
  return <SnippetsDrawer tab={tab} admin={admin} close={() => set(null)} />;
}
function SnippetsDrawer({
  tab,
  admin,
  close,
}: {
  tab: string;
  admin: boolean;
  close: () => void;
}) {
  const q = useApi<Row[]>("snippets");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{
    name: string;
    command: string;
  } | null>(null);
  const list = (q.data || []).filter((s) =>
    (s.name + " " + s.command).toLowerCase().includes(search.toLowerCase()),
  );
  if (editing)
    return (
      <Drawer
        title="New Snippet"
        onClose={() => setEditing(null)}
        head={<Code2 size={18} color="var(--primary)" />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={!editing.name.trim() || !editing.command.trim()}
              onClick={() =>
                void api("snippets", editing)
                  .then(() => {
                    void refresh("snippets");
                    setEditing(null);
                  })
                  .catch(notify.error)
              }
            >
              Save Snippet
            </Button>
          </>
        }
      >
        <Field label="Name" required>
          <input
            autoFocus
            className="input"
            maxLength={80}
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </Field>
        <Field
          label="Command"
          required
          hint="Inserted at the prompt; press Enter in the terminal to run it."
        >
          <textarea
            className="textarea mono"
            rows={6}
            spellCheck={false}
            value={editing.command}
            onChange={(e) =>
              setEditing({ ...editing, command: e.target.value })
            }
          />
        </Field>
      </Drawer>
    );
  return (
    <Drawer
      title="Snippets"
      onClose={close}
      head={<Code2 size={18} color="var(--primary)" />}
      footer={
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      }
    >
      {admin && (
        <div style={{ position: "absolute", top: 18, right: 52 }}>
          <IconButton
            label="New snippet"
            size="sm"
            onClick={() => setEditing({ name: "", command: "" })}
          >
            <Plus size={18} color="var(--primary)" />
          </IconButton>
        </div>
      )}
      <div style={{ padding: "0 14px 12px" }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search snippets..."
        />
      </div>
      {list.map((s) => (
        <div
          key={s.id}
          className="snippet"
          role="button"
          tabIndex={0}
          title="Insert into the terminal"
          onClick={() => {
            sendInput(tab, s.command);
            close();
          }}
        >
          <Code2 size={16} color="var(--primary)" />
          <div className="grow">
            <div className="ellipsis">{s.name}</div>
            <div className="ellipsis mono">{s.command}</div>
          </div>
          {admin && (
            <IconButton
              label="Delete snippet"
              danger
              size="sm"
              onClick={async (e) => {
                e.stopPropagation();
                if (
                  await confirmDialog(
                    "Delete Snippet",
                    `Delete “${s.name}”?`,
                    "Delete",
                    true,
                  )
                )
                  await api("snippets/" + s.id, undefined, "DELETE")
                    .then(() => refresh("snippets"))
                    .catch(notify.error);
              }}
            >
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      ))}
      {!list.length && (
        <p className="muted small" style={{ padding: 20, textAlign: "center" }}>
          {q.data?.length
            ? "No snippets match your search."
            : "No snippets yet."}
        </p>
      )}
    </Drawer>
  );
}
