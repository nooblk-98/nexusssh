"use client";
import { useState } from "react";
import { api, notify, refresh, useApi } from "../lib/api";
import { useWorkspace } from "../lib/store";
import type { PresetLayout } from "../../../packages/shared/workflows";
import { Button, Drawer, Field, confirmDialog } from "./ui";
type Preset = { id: string; name: string; layout: PresetLayout };
export function WorkspacePresets({ onClose }: { onClose: () => void }) {
  const list = useApi<Preset[]>("workspace-presets");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (
        list.data?.some((p) => p.name === name.trim()) &&
        !(await confirmDialog(
          "Replace preset",
          "Replace this named layout with your current workspace?",
          "Replace",
        ))
      )
        return;
      const state = useWorkspace.getState();
      const layout: PresetLayout = {
        columns: state.columns,
        tabs: state.tabs.map(({ kind, serverId, title, path, namespace }) => ({
          kind,
          serverId,
          title,
          ...(path ? { path } : {}),
          ...(namespace ? { namespace } : {}),
        })),
      };
      await api("workspace-presets", { name, layout });
      await refresh("workspace-presets");
      setName("");
      notify.success("Workspace preset saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function restore(preset: Preset) {
    const state = useWorkspace.getState();
    if (state.tabs.length + preset.layout.tabs.length > 30)
      return setError(
        "Close some tabs before opening this preset (30-tab limit).",
      );
    state.setColumns(preset.layout.columns);
    for (const tab of preset.layout.tabs)
      state.open({ ...tab, status: "connecting" });
    onClose();
  }
  return (
    <Drawer title="Workspace presets" onClose={onClose}>
      <p className="small">
        Save named layouts to your account. Opening a preset adds its tabs to
        your workspace. Credentials and terminal resume tokens are never saved
        in presets.
      </p>
      {error && (
        <div className="alert danger" role="alert">
          {error}
        </div>
      )}
      <Field label="Save current layout as">
        <input
          className="input"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Button disabled={busy || !name.trim()} onClick={() => void save()}>
        Save preset
      </Button>
      <div className="drawer-section">Saved layouts</div>
      {list.error && <p role="alert">{list.error.message}</p>}
      {list.data?.map((p) => (
        <div className="row" key={p.id}>
          <span className="grow">
            {p.name} <span className="small">{p.layout.tabs.length} tabs</span>
          </span>
          <Button variant="secondary" onClick={() => restore(p)}>
            Open
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void confirmDialog(
                "Delete preset",
                `Delete “${p.name}”?`,
                "Delete",
                true,
              )
                .then(async (ok) => {
                  if (ok) {
                    await api("workspace-presets/" + p.id, undefined, "DELETE");
                    await refresh("workspace-presets");
                  }
                })
                .catch(notify.error)
            }
          >
            Delete
          </Button>
        </div>
      ))}
      {list.data?.length === 0 && <p>No saved presets.</p>}
    </Drawer>
  );
}
