"use client";
import { useEffect, useState } from "react";
import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { api, notify, refresh, useApi, type Row } from "../lib/api";
import { navigate } from "../lib/router";
import { serverBody } from "../lib/servers";
import { Button } from "./ui";

// Connection errors that mean the host key still needs a human decision.
export const hostKeyProblem = (message: string) =>
  /fingerprint before connecting/i.test(message)
    ? "unknown"
    : /Host denied \(verification failed\)/i.test(message)
      ? "changed"
      : null;

// Shown in place of a terminal or file list when the server's host key is not
// pinned yet (first connection) or no longer matches the pinned one.
export function HostKeyPrompt({
  server,
  kind,
  onTrusted,
}: {
  server: Row;
  kind: "unknown" | "changed";
  onTrusted: () => void;
}) {
  const me = useApi<Row>("auth/me");
  const admin = ["owner", "administrator"].includes(me.data?.role);
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!admin) return;
    api<Row>("servers/scan-host-key", { host: server.host, port: server.port })
      .then((r) => setFingerprint(r.fingerprint))
      .catch((e) => setError(e.message));
  }, [admin, server.host, server.port]);
  async function trust() {
    setBusy(true);
    try {
      await api(
        "servers/" + server.id,
        serverBody(server, { fingerprint }),
        "PATCH",
      );
      await refresh("servers");
      notify.success("Host key saved for " + server.name + ".");
      onTrusted();
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }
  const changed = kind === "changed";
  return (
    <div style={{ maxWidth: 460, textAlign: "left", display: "grid", gap: 12 }}>
      <div
        className="row"
        style={{ color: changed ? "var(--danger)" : "var(--text-strong)" }}
      >
        {changed ? <ShieldAlert size={22} /> : <ShieldQuestion size={22} />}
        <b>{changed ? "Host key has changed" : "Unknown host key"}</b>
      </div>
      <p className="small" style={{ lineHeight: 1.6 }}>
        {changed ? (
          <>
            <b>{server.host}</b> presented a different key from the one saved
            for this server. This happens after a reinstall, but it can also
            mean someone is intercepting the connection. Only replace the saved
            key if you know why it changed.
          </>
        ) : (
          <>
            This is the first connection to <b>{server.host}</b>. Check that the
            fingerprint below matches the server before trusting it, for example
            with{" "}
            <span className="mono">
              ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
            </span>{" "}
            on the server.
          </>
        )}
      </p>
      {!admin ? (
        <div className="alert info">
          Ask an administrator to verify this server’s host key.
        </div>
      ) : error ? (
        <div className="alert">{error}</div>
      ) : (
        <div className="fingerprint">
          <span className="muted">Fingerprint (SHA256)</span>
          <span className="mono" style={{ overflowWrap: "anywhere" }}>
            {fingerprint || "Reading host key…"}
          </span>
          {changed && server.fingerprint && (
            <>
              <span className="muted">Previously saved</span>
              <span className="mono" style={{ overflowWrap: "anywhere" }}>
                {server.fingerprint}
              </span>
            </>
          )}
        </div>
      )}
      {admin && !error && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {!changed && (
            <a
              className="small grow"
              onClick={() => navigate("/settings/security")}
            >
              Always trust new hosts…
            </a>
          )}
          <Button
            variant={changed ? "danger" : "primary"}
            disabled={!fingerprint || busy}
            onClick={() => void trust()}
          >
            {changed ? "Replace Key and Connect" : "Trust and Connect"}
          </Button>
        </div>
      )}
    </div>
  );
}
