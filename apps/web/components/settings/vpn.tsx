"use client";
import { useState } from "react";
import { Network, Plus, Pencil, Trash2 } from "lucide-react";
import { api, notify, refresh, useApi, type Row } from "../../lib/api";
import { Button, Drawer, Empty, Field, IconButton, confirmDialog } from "../ui";
import { PageHead } from "./page-head";
type Form = { id?: string; name: string; description: string; config: string };
export function VpnProfiles() {
  const q = useApi<Row[]>("vpn-profiles");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function edit(profile?: Row) {
    setError("");
    setForm({
      id: profile?.id,
      name: profile?.name || "",
      description: profile?.description || "",
      config: "",
    });
  }
  async function save() {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      await api(
        form.id ? "vpn-profiles/" + form.id : "vpn-profiles",
        {
          name: form.name,
          description: form.description,
          ...(form.config.trim() ? { config: form.config } : {}),
        },
        form.id ? "PATCH" : "POST",
      );
      setForm(null);
      await refresh("vpn-profiles", "servers");
      notify.success("VPN profile saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHead
        title="VPN"
        sub="Save WireGuard profiles and choose how your SSH servers connect."
      >
        <Button variant="outline" onClick={() => edit()}>
          <Plus size={17} /> Add VPN Profile
        </Button>
      </PageHead>
      <div className="alert info">
        Select a profile in a server’s Advanced Settings. Use a jump host as
        well when SSH must pass through a bastion. VPN connections start when
        needed.
      </div>
      {q.error && (
        <div className="alert danger" role="alert">
          {q.error.message}
        </div>
      )}
      {q.isPending ? (
        <p>Loading VPN profiles…</p>
      ) : (
        <div className="card table-card">
          {q.data?.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>VPN address</th>
                  <th>Peers</th>
                  <th>Used by</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((profile) => (
                  <tr key={profile.id}>
                    <td>
                      <strong>{profile.name}</strong>
                      {profile.description && (
                        <div className="hint">{profile.description}</div>
                      )}
                      <span className="badge">WireGuard</span>
                    </td>
                    <td>{profile.summary.addresses.join(", ")}</td>
                    <td>
                      {profile.summary.peers
                        .map((p: Row) => p.endpoint)
                        .join(", ")}
                    </td>
                    <td>{profile._count.servers} servers</td>
                    <td>
                      <span className="actions row">
                        <IconButton
                          label={"Edit " + profile.name}
                          onClick={() => edit(profile)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={"Delete " + profile.name}
                          danger
                          onClick={async () => {
                            if (
                              await confirmDialog(
                                "Delete VPN Profile",
                                `Delete “${profile.name}”?`,
                                "Delete",
                                true,
                              )
                            ) {
                              try {
                                await api(
                                  "vpn-profiles/" + profile.id,
                                  undefined,
                                  "DELETE",
                                );
                                await refresh("vpn-profiles");
                                notify.success("VPN profile deleted.");
                              } catch (e) {
                                notify.error(e);
                              }
                            }
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
              icon={<Network size={72} strokeWidth={1.25} />}
              title="No VPN Profiles"
            >
              Import a WireGuard client configuration to reach servers on a
              private network.
            </Empty>
          )}
        </div>
      )}
      {form && (
        <Drawer
          title={form.id ? "Edit VPN Profile" : "New VPN Profile"}
          onClose={() => !busy && setForm(null)}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  busy || !form.name.trim() || (!form.id && !form.config.trim())
                }
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save VPN Profile"}
              </Button>
            </>
          }
        >
          {error && (
            <div className="alert danger" role="alert">
              {error}
            </div>
          )}
          <Field label="Profile name" required>
            <input
              autoFocus
              className="input"
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <input
              className="input"
              maxLength={2000}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </Field>
          <Field
            label="Import WireGuard configuration"
            hint="Choose a .conf file, or paste its contents below."
          >
            <input
              className="vpn-file-input"
              type="file"
              accept=".conf,.txt"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 65536) {
                  setError("Choose a configuration smaller than 64 KB.");
                  return;
                }
                try {
                  const config = await file.text();
                  setForm((current) =>
                    current ? { ...current, config } : current,
                  );
                  setError("");
                } catch {
                  setError("Could not read that file.");
                }
              }}
            />
          </Field>
          <Field
            label="WireGuard configuration"
            required={!form.id}
            hint={
              form.id
                ? "Leave empty to keep the saved configuration. Paste a replacement to update it for future connections."
                : "Private keys are encrypted when saved. Client profiles support multiple peers and private DNS."
            }
          >
            <textarea
              className="input"
              style={{ minHeight: 260, fontFamily: "monospace" }}
              spellCheck={false}
              autoComplete="off"
              maxLength={65536}
              value={form.config}
              placeholder={
                "[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/24"
              }
              onChange={(e) => setForm({ ...form, config: e.target.value })}
            />
          </Field>
          <p className="hint">
            Saving stores the profile. Use Test Connection on a server to verify
            the complete VPN and SSH route.
          </p>
        </Drawer>
      )}
    </div>
  );
}
