"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Button } from "./ui/button";
export default function Terminal({
  serverId,
  name,
}: {
  serverId: string;
  name: string;
}) {
  const div = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [snippets, setSnippets] = useState<
    Array<{ id: string; name: string; command: string }>
  >([]);
  useEffect(() => {
    void fetch("/api/snippets")
      .then((r) => r.json())
      .then((v) => {
        if (Array.isArray(v)) setSnippets(v);
      });
  }, []);
  const [status, setStatus] = useState("Connecting"),
    [generation, setGeneration] = useState(0),
    [font, setFont] = useState(13);
  useEffect(() => {
    const t = new XTerm({
      cursorBlink: true,
      fontFamily: "Consolas, monospace",
      fontSize: font,
      scrollback: 3000,
      theme: {
        background: "#0b1015",
        foreground: "#d8e0eb",
        cursor: "#83dfbd",
      },
    });
    const fit = new FitAddon(),
      find = new SearchAddon();
    terminal.current = t;
    search.current = find;
    t.loadAddon(fit);
    t.loadAddon(find);
    t.open(div.current!);
    fit.fit();
    const dev = location.port === "3000";
    const endpoint = dev ? `${location.hostname}:3001` : location.host;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${endpoint}/ws/terminal?serverId=${serverId}`,
    );
    socket.current = ws;
    const resize = () => {
      fit.fit();
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(div.current!);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "output")
        t.write(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)));
      else if (m.type === "ready") {
        setStatus("Connected");
        resize();
        t.focus();
      } else if (m.type === "error") {
        setStatus(m.message);
        t.writeln("\r\n" + m.message);
      }
    };
    ws.onclose = () => setStatus("Disconnected");
    ws.onerror = () => setStatus("Connection failed");
    const input = t.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
    });
    return () => {
      observer.disconnect();
      input.dispose();
      ws.close();
      t.dispose();
    };
  }, [serverId, generation]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.fontSize = font;
  }, [font]);
  return (
    <div className="terminal-pane">
      <div className="terminal-toolbar">
        <b>{name}</b>
        <span className={status === "Connected" ? "mint" : "muted"}>
          {status}
        </span>
        <input
          aria-label="Search terminal"
          placeholder="Find in output"
          onChange={(e) => search.current?.findNext(e.target.value)}
        />
        <select
          aria-label="Terminal font size"
          value={font}
          onChange={(e) => setFont(Number(e.target.value))}
        >
          {[12, 13, 14, 16, 18].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => setGeneration((g) => g + 1)}>
          Reconnect
        </Button>
        <Button variant="ghost" onClick={() => socket.current?.close()}>
          Disconnect
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(
              terminal.current?.getSelection() || "",
            )
          }
        >
          Copy selection
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (socket.current?.readyState === 1)
                  socket.current.send(
                    JSON.stringify({
                      type: "input",
                      data: text.slice(0, 16384),
                    }),
                  );
              })
              .catch(() => setStatus("Clipboard access denied"))
          }
        >
          Paste
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const b = terminal.current?.buffer.active;
            if (!b) return;
            const lines = [];
            for (let i = 0; i < b.length; i++)
              lines.push(b.getLine(i)?.translateToString(true) || "");
            const url = URL.createObjectURL(
              new Blob([lines.join("\n")], { type: "text/plain" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = name + "-terminal.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download buffer
        </Button>
        <select
          aria-label="Insert command snippet"
          value=""
          onChange={(e) => {
            const snippet = snippets.find((s) => s.id === e.target.value);
            if (snippet && socket.current?.readyState === 1) {
              socket.current.send(
                JSON.stringify({ type: "input", data: snippet.command }),
              );
              terminal.current?.focus();
            }
          }}
          style={{ width: 135 }}
        >
          <option value="">Insert snippet…</option>
          {snippets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          onClick={() => div.current?.parentElement?.requestFullscreen()}
        >
          Full screen
        </Button>
      </div>
      <div className="terminal-body" ref={div} />
      <div className="terminal-note">
        Interactive access has the permissions of the SSH account. Output
        recording is off. Reconnect starts a new shell.
      </div>
    </div>
  );
}
