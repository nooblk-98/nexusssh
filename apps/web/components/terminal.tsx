"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Folder,
  Keyboard,
  Maximize,
  RadioTower,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { copyText, useApi, type Row } from "../lib/api";
import {
  loadHistory,
  remember,
  suggest,
  type Suggestion,
} from "../lib/intellisense";
import { connectServer, settingsOf } from "../lib/servers";
import {
  sendInput,
  terminalSinks,
  usePrefs,
  useWorkspace,
  type Tab,
} from "../lib/store";
import { terminalFonts, terminalThemes } from "../lib/themes";
import { terminalDefaults } from "./server-drawer";
import { HostKeyPrompt, hostKeyProblem } from "./host-key";
import { openSnippets } from "./snippets";
import { Button, IconButton, openMenu, openMenuAt, type MenuItem } from "./ui";

type Metrics = { cpu: number | null; memory: number | null; storage: number | null };
const emptyMetrics: Metrics = { cpu: null, memory: null, storage: null };

function metricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function MetricBar({ label, value }: { label: string; value: number | null }) {
  const title = `${label}: ${value === null ? "Unavailable" : `${value}%`}`;
  return (
    <div className="terminal-metric" title={title}>
      <span className="terminal-metric-label">{label}</span>
      <div
        className="terminal-metric-track"
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : value}
        aria-valuetext={value === null ? "Unavailable" : `${value}%`}
      >
        <span className="terminal-metric-fill" style={{ width: `${value ?? 0}%` }} />
      </div>
      <span className="terminal-metric-value">{value === null ? "Unavailable" : `${value}%`}</span>
    </div>
  );
}

export default function TerminalView({
  tab,
  server,
  visible,
}: {
  tab: Tab;
  server: Row;
  visible: boolean;
}) {
  const prefs = usePrefs();
  const snippets = useApi<Row[]>("snippets");
  const { setStatus, updateTab, broadcast, toggleBroadcast } = useWorkspace();
  // Set when the user asks for a fresh shell, so the old one is ended now
  // instead of waiting out its resume grace period.
  const fresh = useRef(false);
  // On-screen keys (shown by default on touch screens) with sticky Ctrl/Alt.
  const [keys, setKeys] = useState(
    () =>
      typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches,
  );
  const [sticky, setSticky] = useState({ ctrl: false, alt: false });
  const modifiers = useRef(sticky);
  const pane = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const find = useRef<SearchAddon | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<
    "connecting" | "connected" | "closed" | "error"
  >("connecting");
  const [message, setMessage] = useState("");
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [toolbar, setToolbar] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [fontSize, setFontSize] = useState(prefs.terminalFontSize);
  const [popup, setPopup] = useState<{
    items: Suggestion[];
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const settings = { ...terminalDefaults, ...settingsOf(server) };
  // Latest values for xterm callbacks, which are created once per connection.
  const live = useRef({ popup, prefs, settings });
  live.current = { popup, prefs, settings };
  const line = useRef<string | null>("");
  const broadcasting = broadcast.includes(tab.id);
  const hostKey = state === "error" ? hostKeyProblem(message) : null;

  useEffect(() => {
    const t = new XTerm({
      cursorBlink: true,
      fontFamily:
        terminalFonts[prefs.terminalFont] || terminalFonts["DejaVu Sans Mono"],
      fontSize,
      scrollback: 5000,
      theme: terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai,
      macOptionIsMeta: settings.altIsMeta,
      scrollOnUserInput: settings.scrollOnKeystroke,
      allowProposedApi: true,
    });
    const f = new FitAddon(),
      s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    find.current = s;
    const safeFit = () => {
      if (
        host.current &&
        host.current.offsetWidth > 0 &&
        host.current.offsetHeight > 0
      )
        f.fit();
    };
    safeFit();
    const dev = location.port === "3000";
    const endpoint = dev ? `${location.hostname}:3001` : location.host;
    const resume = fresh.current
      ? ""
      : useWorkspace.getState().tabs.find((x) => x.id === tab.id)?.resume;
    fresh.current = false;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${endpoint}/ws/terminal?serverId=${server.id}` +
        (resume ? "&resume=" + resume : ""),
    );
    const decoder =
      settings.encoding !== "utf-8" ? new TextDecoder(settings.encoding) : null;
    let failed = false;
    let ready = false;
    const status = (v: typeof state, msg = "") => {
      setState(v);
      setMessage(msg);
      if (v !== "connected") setMetrics(emptyMetrics);
      setStatus(tab.id, v);
    };
    status("connecting");
    const send = (data: string) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
    };
    terminalSinks.set(tab.id, (data) => {
      send(data);
      t.focus();
    });
    const resize = () => {
      safeFit();
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "output") {
        const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
        t.write(decoder ? decoder.decode(bytes, { stream: true }) : bytes);
      } else if (m.type === "ready") {
        ready = true;
        updateTab(tab.id, { resume: m.resume });
        status("connected");
        resize();
        t.focus();
      } else if (m.type === "metrics") {
        if (ready && ws.readyState === WebSocket.OPEN && !failed) {
          setMetrics({
            cpu: metricValue(m.cpu),
            memory: metricValue(m.memory),
            storage: metricValue(m.storage),
          });
        }
      } else if (m.type === "error") {
        failed = true;
        status("error", m.message);
        t.writeln("\r\n\x1b[31m" + m.message + "\x1b[0m");
      }
    };
    ws.onclose = () => {
      ready = false;
      setMetrics(emptyMetrics);
      if (!failed) status("closed");
    };
    ws.onerror = () => {
      failed = true;
      ready = false;
      status("error", "Connection failed");
    };
    const showSuggestions = () => {
      const { prefs } = live.current;
      const current = line.current;
      if (current == null) return setPopup(null);
      const items = suggest(
        current,
        loadHistory(server.id),
        true,
        true,
        prefs.compactSuggestions ? 6 : 12,
      );
      if (!items.length) return setPopup(null);
      const screen = host.current!.querySelector(
        ".xterm-screen",
      ) as HTMLElement | null;
      const cw = (screen?.offsetWidth || 1) / t.cols,
        ch = (screen?.offsetHeight || 1) / t.rows;
      setPopup({
        items,
        index: 0,
        x: 8 + t.buffer.active.cursorX * cw,
        y: 6 + (t.buffer.active.cursorY + 1) * ch,
      });
    };
    // Tracks what the user has typed on the current line; anything we cannot
    // follow (arrows, history recall) suspends suggestions until Enter.
    const track = (data: string) => {
      if (data === "\r") {
        if (line.current) remember(server.id, line.current);
        line.current = "";
        setPopup(null);
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (line.current) line.current = line.current.slice(0, -1);
      } else if (data === "\x03" || data === "\x15") line.current = "";
      else if (/^[\x20-\x7e]+$/.test(data)) {
        if (line.current != null) line.current += data;
      } else line.current = null;
      showSuggestions();
    };
    const input = t.onData((data) => {
      const { settings } = live.current;
      if (settings.backspaceCtrlH && data === "\x7f") data = "\b";
      const mod = modifiers.current;
      if (mod.ctrl && data.length === 1 && /[a-z@[\\\]^_ ]/i.test(data))
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
      if (mod.alt && data.length === 1) data = "\x1b" + data;
      if (mod.ctrl || mod.alt) {
        modifiers.current = { ctrl: false, alt: false };
        setSticky(modifiers.current);
      }
      track(data);
      sendInput(tab.id, data);
    });
    const selection = t.onSelectionChange(() => {
      if (live.current.prefs.copyOnSelect && t.hasSelection())
        void copyText(t.getSelection()).catch(() => {});
    });
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const { popup, settings } = live.current;
      if (popup) {
        // Tab belongs to the remote shell (for native path/command completion).
        // IntelliSense remains available by clicking a suggestion or using Right.
        if (e.key === "Tab") {
          setPopup(null);
          return true;
        }
        if (e.key === "ArrowRight" && !e.shiftKey) {
          const pick = popup.items[popup.index].text;
          const rest = pick.slice((line.current || "").length);
          line.current = pick;
          setPopup(null);
          sendInput(tab.id, rest);
          return false;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const d = e.key === "ArrowDown" ? 1 : -1;
          setPopup({
            ...popup,
            index: (popup.index + d + popup.items.length) % popup.items.length,
          });
          return false;
        }
        if (e.key === "Escape") {
          setPopup(null);
          return false;
        }
      }
      const mod = e.ctrlKey && !e.altKey && !e.metaKey;
      if (
        mod &&
        settings.ctrlCCopy &&
        e.key.toLowerCase() === "c" &&
        t.hasSelection()
      ) {
        void copyText(t.getSelection()).catch(() => {});
        t.clearSelection();
        return false;
      }
      // Without the async clipboard API (plain HTTP) the browser's own paste
      // event still reaches the terminal, so the key is left alone.
      if (
        mod &&
        settings.ctrlVPaste &&
        e.key.toLowerCase() === "v" &&
        navigator.clipboard?.readText
      ) {
        void navigator.clipboard
          .readText()
          .then((text) => sendInput(tab.id, text.slice(0, 16384)))
          .catch(() => {});
        return false;
      }
      return true;
    });
    return () => {
      terminalSinks.delete(tab.id);
      observer.disconnect();
      input.dispose();
      selection.dispose();
      // Closing the tab or starting a fresh shell ends this one; anything else
      // (a reload, a remount) leaves it resumable for a short while.
      const closing =
        fresh.current ||
        !useWorkspace.getState().tabs.some((x) => x.id === tab.id);
      if (closing && ws.readyState === 1)
        ws.send(JSON.stringify({ type: "disconnect" }));
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      // xterm schedules a viewport sync on open; disposing in the same tick
      // makes that callback throw, so let it run first.
      setTimeout(() => t.dispose());
    };
    // Reconnect creates a new connection; appearance changes are applied below.
  }, [server.id, generation]);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.fontSize = fontSize;
    t.options.fontFamily =
      terminalFonts[prefs.terminalFont] || terminalFonts["DejaVu Sans Mono"];
    t.options.theme =
      terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai;
    if (host.current?.offsetWidth) fit.current?.fit();
  }, [fontSize, prefs.terminalFont, prefs.terminalTheme]);
  useEffect(() => {
    if (visible && host.current?.offsetWidth) {
      fit.current?.fit();
      term.current?.focus();
    }
  }, [visible, toolbar]);
  const theme = terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai;
  const snippetItems: MenuItem[] = (snippets.data || []).map((s) => ({
    label: s.name,
    onClick: () => sendInput(tab.id, s.command),
  }));
  return (
    <div
      ref={pane}
      className="pane-inner"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      {toolbar ? (
        <div className="term-toolbar">
          <IconButton
            label="Snippets"
            onClick={(e) =>
              openMenuAt(e.currentTarget, [
                { label: "Edit Snippets", onClick: () => openSnippets(tab.id) },
                ...(snippetItems.length
                  ? ["sep" as const, ...snippetItems]
                  : []),
              ])
            }
          >
            <Code2 size={19} />
          </IconButton>
          <IconButton
            label="Open SFTP"
            onClick={() => connectServer(server, "sftp")}
          >
            <Folder size={19} />
          </IconButton>
          <IconButton
            label="Search"
            active={searching}
            onClick={() => setSearching(!searching)}
          >
            <Search size={19} />
          </IconButton>
          <IconButton
            label={
              broadcasting ? "Broadcast Keyboard (on)" : "Broadcast Keyboard"
            }
            active={broadcasting}
            className={broadcasting ? "broadcast-on" : ""}
            onClick={() => toggleBroadcast(tab.id)}
          >
            <RadioTower size={19} />
          </IconButton>
          <span className="sep" />
          <IconButton
            label="Zoom Out"
            onClick={() => setFontSize((n) => Math.max(8, n - 1))}
          >
            <ZoomOut size={19} />
          </IconButton>
          <IconButton
            label="Zoom In"
            onClick={() => setFontSize((n) => Math.min(32, n + 1))}
          >
            <ZoomIn size={19} />
          </IconButton>
          <IconButton
            label="On-screen keys"
            active={keys}
            onClick={() => setKeys(!keys)}
          >
            <Keyboard size={19} />
          </IconButton>
          <IconButton
            label="Fullscreen"
            onClick={() =>
              document.fullscreenElement
                ? void document.exitFullscreen()
                : void pane.current?.requestFullscreen()
            }
          >
            <Maximize size={17} />
          </IconButton>
          <button
            className="toolbar-toggle"
            aria-label="Hide toolbar"
            title="Hide toolbar"
            onClick={() => setToolbar(false)}
          >
            <ChevronUp size={12} />
          </button>
        </div>
      ) : (
        <div
          className="toolbar-hidden"
          style={{ background: theme.background }}
        >
          <button
            className="toolbar-toggle"
            aria-label="Show toolbar"
            title="Show toolbar"
            onClick={() => setToolbar(true)}
          >
            <ChevronDown size={12} />
          </button>
        </div>
      )}
      <div
        className={
          "term-body" + (settings.showScrollbar ? "" : " no-scrollbar")
        }
        style={{ background: theme.background }}
      >
        <div
          ref={host}
          onContextMenu={(e) => {
            // On insecure origins the Async Clipboard API is unavailable.
            // Keep the browser's native Paste menu in that case; this handler
            // only replaces it when our terminal menu can provide Paste.
            if (!navigator.clipboard?.readText) return;
            e.preventDefault();
            openMenu(e.clientX, e.clientY, [
              {
                label: "Paste",
                onClick: () =>
                  void navigator.clipboard
                    ?.readText()
                    .then((text) => sendInput(tab.id, text.slice(0, 16384)))
                    .catch(() => {}),
              },
              {
                label: "Copy",
                disabled: !term.current?.hasSelection(),
                onClick: () => {
                  const selected = term.current?.getSelection();
                  if (selected) void copyText(selected).catch(() => {});
                },
              },
              {
                label: "Select all",
                onClick: () => term.current?.selectAll(),
              },
            ]);
          }}
          style={{ position: "absolute", inset: "6px 0 0 8px" }}
        />
        {searching && (
          <div className="term-search">
            <input
              autoFocus
              className="input"
              placeholder="Find in terminal"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                find.current?.findNext(e.target.value, { incremental: true });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey)
                  find.current?.findPrevious(query);
                else if (e.key === "Enter") find.current?.findNext(query);
                if (e.key === "Escape") setSearching(false);
              }}
            />
            <IconButton
              label="Previous match"
              size="sm"
              onClick={() => find.current?.findPrevious(query)}
            >
              <ChevronUp size={16} />
            </IconButton>
            <IconButton
              label="Next match"
              size="sm"
              onClick={() => find.current?.findNext(query)}
            >
              <ChevronDown size={16} />
            </IconButton>
            <IconButton
              label="Close search"
              size="sm"
              onClick={() => {
                find.current?.clearDecorations();
                setSearching(false);
                term.current?.focus();
              }}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {popup && (
          <div
            className="intellisense"
            style={{ left: popup.x, top: popup.y }}
            role="listbox"
          >
            {popup.items.map((s, i) => (
              <button
                key={s.text}
                className={i === popup.index ? "on" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const rest = s.text.slice((line.current || "").length);
                  line.current = s.text;
                  setPopup(null);
                  sendInput(tab.id, rest);
                }}
              >
                <span className="grow ellipsis">{s.text}</span>
                {!prefs.compactSuggestions && (
                  <span className="kind">{s.kind}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {(state === "closed" || state === "error") && (
          <div className="term-overlay">
            {hostKey ? (
              <div>
                <HostKeyPrompt
                  key={message}
                  server={server}
                  kind={hostKey}
                  message={message}
                  onTrusted={() => {
                    fresh.current = true;
                    setGeneration((g) => g + 1);
                  }}
                />
              </div>
            ) : (
              <div>
                <b>
                  {state === "error" ? "Connection failed" : "Session closed"}
                </b>
                {message && <span className="small muted">{message}</span>}
                <Button
                  onClick={() => {
                    setGeneration((g) => g + 1);
                  }}
                >
                  Reconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {keys && (
        <div className="term-keys" role="toolbar" aria-label="Terminal keys">
          {(["ctrl", "alt"] as const).map((m) => (
            <button
              key={m}
              className={sticky[m] ? "on" : ""}
              aria-pressed={sticky[m]}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                modifiers.current = {
                  ...modifiers.current,
                  [m]: !modifiers.current[m],
                };
                setSticky(modifiers.current);
                term.current?.focus();
              }}
            >
              {m === "ctrl" ? "Ctrl" : "Alt"}
            </button>
          ))}
          {(
            [
              ["Esc", "\x1b"],
              ["Tab", "\t"],
              ["←", "\x1b[D"],
              ["↑", "\x1b[A"],
              ["↓", "\x1b[B"],
              ["→", "\x1b[C"],
              ["Home", "\x1b[H"],
              ["End", "\x1b[F"],
              ["PgUp", "\x1b[5~"],
              ["PgDn", "\x1b[6~"],
              ["|", "|"],
              ["~", "~"],
              ["/", "/"],
              ["-", "-"],
            ] as const
          ).map(([label, seq]) => (
            <button
              key={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                sendInput(tab.id, seq);
                term.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="statusbar">
        <b>{server.name}</b>
        <span className="key">Host:</span>
        <span className="mono">{server.host}</span>
        {broadcasting && <span className="badge amber">Broadcasting</span>}
        {state === "connected" && (
          <div className="terminal-metrics" aria-label="VM resource usage">
            <MetricBar label="CPU" value={metrics.cpu} />
            <MetricBar label="RAM" value={metrics.memory} />
            <MetricBar label="Disk" value={metrics.storage} />
          </div>
        )}
        <span
          className={
            "state" +
            (state === "connected" ? " on" : state === "error" ? " err" : "")
          }
        >
          {state === "connected"
            ? "Connected"
            : state === "connecting"
              ? "Connecting…"
              : state === "error"
                ? "Error"
                : "Disconnected"}
        </span>
      </div>
    </div>
  );
}
