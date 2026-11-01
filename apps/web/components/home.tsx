"use client";
import { useEffect, useState } from "react";
import { Clock, Play, X } from "lucide-react";
import { timeAgo, useApi, type Row } from "../lib/api";
import { connectServer, useServers } from "../lib/servers";
import { ServerIcon } from "./icons";
import { openServerDrawer } from "./server-drawer";
import { IconButton } from "./ui";

const HIDDEN_KEY = "nexus-hidden-recent";
// Accepts ssh://user@host:port, user@host:port, user@host or host.
export function parseTarget(text: string) {
  const m = text
    .trim()
    .replace(/^ssh:\/\//i, "")
    .match(
      /^(?:([a-z_][a-z0-9_.-]{0,31})@)?([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?\/?$/,
    );
  if (!m) return null;
  const port = Number(m[3] || 22);
  if (port < 1 || port > 65535) return null;
  return { username: m[1] || "", host: m[2].replace(/^\[|\]$/g, ""), port };
}
export function Home() {
  const { servers } = useServers();
  const sessions = useApi<Row[]>("sessions", { interval: 30000 });
  const [target, setTarget] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    try {
      setHidden(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
    } catch {}
  }, []);
  const parsed = parseTarget(target);
  function quickConnect() {
    if (!parsed) return;
    const match = servers.find(
      (s) =>
        s.host === parsed.host &&
        s.port === parsed.port &&
        (!parsed.username || s.username === parsed.username),
    );
    setTarget("");
    if (match) return connectServer(match);
    // New hosts need a stored credential and a verified host key first.
    openServerDrawer({
      prefill: { ...parsed, username: parsed.username || "" },
      connectAfter: true,
    });
  }
  const seen = new Set<string>();
  const recent = (sessions.data || [])
    .filter((x) => {
      if (seen.has(x.serverId) || hidden.includes(x.id)) return false;
      seen.add(x.serverId);
      return servers.some((s) => s.id === x.serverId);
    })
    .slice(0, 6)
    .map((x) => ({
      session: x,
      server: servers.find((s) => s.id === x.serverId)!,
    }));
  const hide = (id: string) => {
    const next = [...hidden, id].slice(-200);
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {}
  };
  return (
    <div className="home-view">
      <section className="home-card">
        <h2>Quick Connect</h2>
        <form
          className="input-group qc"
          onSubmit={(e) => {
            e.preventDefault();
            quickConnect();
          }}
        >
          <select className="select" aria-label="Protocol" defaultValue="ssh">
            <option value="ssh">SSH</option>
          </select>
          <input
            className="input"
            aria-label="Connection address"
            placeholder="ssh://user@hostname:22"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button className="go" aria-label="Connect" disabled={!parsed}>
            <Play size={14} fill="currentColor" />
          </button>
        </form>
        <h3>Recent Connections</h3>
        {recent.length ? (
          recent.map(({ session, server }) => (
            <div key={session.id} className="row">
              <button
                className="recent-item grow"
                onClick={() => connectServer(server)}
              >
                <span className="srv-icon">
                  <ServerIcon name={server.icon} size={22} />
                </span>
                <span className="grow">
                  <div className="srv-name ellipsis">{server.name}</div>
                  <div className="srv-sub ellipsis">
                    {server.username}@ {server.host} &nbsp;•&nbsp; SSH
                    &nbsp;·&nbsp; {timeAgo(session.createdAt)}
                  </div>
                </span>
              </button>
              <IconButton
                label="Remove from history"
                size="sm"
                onClick={() => hide(session.id)}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))
        ) : (
          <div className="recent-empty">
            <Clock size={26} />
            No recent connections
            <span className="small">
              Your recent connections will appear here
            </span>
          </div>
        )}
      </section>
      <div className="footer">© {new Date().getFullYear()} · NexusSSH</div>
    </div>
  );
}
