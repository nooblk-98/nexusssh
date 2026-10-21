"use client";
import { useEffect, useState } from "react";
import { ShieldAlert, ShieldQuestion, ShieldX } from "lucide-react";
import { api, notify, refresh, useApi, type Row } from "../lib/api";
import { navigate } from "../lib/router";
import { serverBody } from "../lib/servers";
import { Button } from "./ui";

type Kind = "unknown" | "changed" | "blocked";
// Connection errors that need an administrator's decision before connecting.
export const hostKeyProblem = (message: string): Kind | null =>
  /fingerprint before connecting/i.test(message)
    ? "unknown"
    : /Host denied \(verification failed\)/i.test(message)
      ? "changed"
      : /outside the configured allowlist/i.test(message)
        ? "blocked"
        : null;
// "…allowlist (203.0.113.7, 2001:db8::1)" lists the addresses that were refused.
const blockedAddresses = (message: string, host: string) => {
  const listed = message.match(/allowlist \(([^)]*)\)/)?.[1];
  const found = listed
    ? listed
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  return found.length ? found : /^[0-9a-fA-F.:]+$/.test(host) ? [host] : [];
};

// Shown in place of a terminal or file list when the server's host key is not
// pinned yet, no longer matches, or the server is outside the SSH allowlist.
export function HostKeyPrompt({
  server,
  kind: initial,
  message = "",
  onTrusted,
}: {
  server: Row;
  kind: Kind;
  message?: string;
  onTrusted: () => void;
}) {
  const me = useApi<Row>("auth/me");
  const settings = useApi<Row>("settings");
  const admin = ["owner", "administrator"].includes(me.data?.role);
  const [kind, setKind] = useState<Kind>(initial);
  const [blocked, setBlocked] = useState<string[]>(() =>
    initial === "blocked" ? blockedAddresses(message, server.host) : [],
  );
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!admin || kind === "blocked") return;
    setError("");
    api<Row>("servers/scan-host-key", { host: server.host, port: server.port })
      .then((r) => setFingerprint(r.fingerprint))
      .catch((e) => {
        if (hostKeyProblem(e.message) === "blocked") {
          setBlocked(blockedAddresses(e.message, server.host));
          setKind("blocked");
        } else setError(e.message);
      });
  }, [admin, kind, attempt, server.host, server.port]);
  async function allow() {
    setBusy(true);
    try {
      const current: string[] = settings.data?.workspaceCidrs || [];
      await api(
        "settings",
        { workspaceCidrs: [...current, ...blocked] },
        "PATCH",
      );
      await refresh("settings");
      notify.success(`Allowed ${blocked.join(", ")} as an SSH destination.`);
      // A pinned key, or automatic acceptance, means the connection can go ahead.
      if (server.fingerprint || settings.data?.acceptNewHostKeys) onTrusted();
      else {
        setKind("unknown");
        setAttempt((n) => n + 1);
      }
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }
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
  if (kind === "blocked")
    return (
      <div
        style={{ maxWidth: 460, textAlign: "left", display: "grid", gap: 12 }}
      >
        <div className="row" style={{ color: "var(--text-strong)" }}>
          <ShieldX size={22} />
          <b>Destination not allowed</b>
        </div>
        <p className="small" style={{ lineHeight: 1.6 }}>
          <b>{blocked.join(", ") || server.host}</b> is not in this workspace’s
          list of allowed SSH destinations, so NexusSSH will not connect to it
          or read its host key.
        </p>
        {!admin ? (
          <div className="alert info">
            Ask an administrator to allow this server under Settings → Security.
          </div>
        ) : !blocked.length ? (
          <div className="alert">
            {server.host} could not be resolved to an address. Add its network
            under Settings → Security.
          </div>
        ) : (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <a
              className="small grow"
              onClick={() => navigate("/settings/security")}
            >
              Manage allowed destinations…
            </a>
            <Button disabled={busy} onClick={() => void allow()}>
              Allow {blocked.length === 1 ? blocked[0] : "these addresses"} and
              Continue
            </Button>
          </div>
        )}
      </div>
    );
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
