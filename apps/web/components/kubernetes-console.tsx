"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { CircleHelp, Eraser, Maximize, Square } from "lucide-react";
import { KubernetesIcon } from "./kubernetes-icon";
import { api, useApi, type Row } from "../lib/api";
import { usePrefs, useWorkspace, type Tab } from "../lib/store";
import { terminalFonts, terminalThemes } from "../lib/themes";
import {
  consoleHelp,
  splitConsoleCommand,
  consoleNamespace,
} from "../../../packages/kubernetes/console-input";
import { IconButton } from "./ui";

export default function KubernetesConsole({
  tab,
  visible,
}: {
  tab: Tab;
  visible: boolean;
}) {
  const clusters = useApi<Row[]>("kubernetes/clusters");
  const cluster = clusters.data?.find((item) => item.id === tab.serverId);
  const prefs = usePrefs();
  const pane = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const controls = useRef<{
    help: () => void;
    clear: () => void;
    cancel: () => void;
  } | null>(null);
  const [namespace, setNamespace] = useState("default");
  const selectedNamespace = useRef(namespace);
  selectedNamespace.current = namespace;
  const [running, setRunning] = useState(false);
  const [state, setState] = useState("Connecting…");
  const clusterId = cluster?.id as string | undefined;
  useEffect(() => {
    if (cluster) setNamespace(tab.namespace || cluster.namespace || "default");
  }, [clusterId]);

  useEffect(() => {
    if (!clusterId || !host.current) return;
    // xterm schedules viewport initialization after open(). Start after React's
    // setup/cleanup probe so it cannot dispose the renderer before that timer.
    let cleanup: (() => void) | undefined;
    const initialize = window.setTimeout(() => {
      if (!host.current) return;
      const t = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        convertEol: true,
        fontFamily:
          terminalFonts[prefs.terminalFont] ||
          terminalFonts["DejaVu Sans Mono"],
        fontSize: prefs.terminalFontSize,
        theme: terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(host.current);
      terminal.current = t;
      fit.current = f;
      let disposed = false,
        busy = true,
        line = "",
        cursor = 0,
        promptText = "",
        promptRow = 0;
      let historyIndex = 0,
        draft = "";
      const history: string[] = [];
      let request: AbortController | undefined;
      let manifest: { command: string[]; text: string } | undefined;
      const write = (value: string) => t.write(value.replace(/\r?\n/g, "\r\n"));
      const prompt = () => {
        promptText = "kubectl > ";
        promptRow = 0;
        cursor = line.length;
        t.write(promptText + line);
        promptRow = Math.floor((promptText.length + cursor) / t.cols);
      };
      const redraw = () => {
        if (promptRow) t.write(`\x1b[${promptRow}A`);
        t.write("\r\x1b[J" + promptText + line + " \b");
        const endRow = Math.floor((promptText.length + line.length) / t.cols);
        const nextRow = Math.floor((promptText.length + cursor) / t.cols);
        if (endRow > nextRow) t.write(`\x1b[${endRow - nextRow}A`);
        t.write(`\x1b[${((promptText.length + cursor) % t.cols) + 1}G`);
        promptRow = nextRow;
      };
      const status = (value: string, tabStatus: Tab["status"]) => {
        if (disposed) return;
        setState(value);
        useWorkspace.getState().setStatus(tab.id, tabStatus);
      };
      const execute = async (command: string[], source?: string) => {
        busy = true;
        setRunning(true);
        status("Running…", "connected");
        request = new AbortController();
        try {
          const result = await api<{ output: string; truncated: boolean }>(
            `kubernetes/clusters/${clusterId}/console`,
            {
              command,
              namespace: selectedNamespace.current,
              ...(source !== undefined ? { manifest: source } : {}),
              timeoutMs: 60000,
            },
            "POST",
            request.signal,
          );
          if (disposed) return;
          write(result.output);
          if (result.output && !result.output.endsWith("\n")) t.write("\r\n");
          if (result.truncated)
            write("\nOutput limited to 256 KB. Narrow the command's result.\n");
          status("Ready", "connected");
        } catch (error) {
          if (disposed) return;
          write(
            `\x1b[31m${request.signal.aborted ? "Stopped waiting. The remote outcome may be unknown; inspect the cluster before retrying." : (error as Error).message}\x1b[0m\n`,
          );
          status("Command ended", "error");
        } finally {
          request = undefined;
          if (!disposed) {
            busy = false;
            setRunning(false);
            prompt();
          }
        }
      };
      const cancel = () => {
        if (busy) {
          request?.abort();
          return;
        }
        manifest = undefined;
        line = "";
        cursor = 0;
        t.write("^C\r\n");
        prompt();
      };
      const submit = () => {
        t.write("\r\n");
        const input = line.trim();
        line = "";
        cursor = 0;
        if (!input) {
          prompt();
          return;
        }
        if (history.at(-1) !== input) {
          history.push(input);
          if (history.length > 100) history.shift();
        }
        historyIndex = history.length;
        draft = "";
        if (input === "clear") {
          t.clear();
          prompt();
          return;
        }
        if (input === "help" || input === "kubectl help") {
          write(consoleHelp + "\n\n");
          prompt();
          return;
        }
        if (input === "exit") {
          useWorkspace.getState().close(tab.id);
          return;
        }
        try {
          const command = splitConsoleCommand(input);
          const nextNamespace = consoleNamespace(command);
          if (nextNamespace !== null) {
            selectedNamespace.current = nextNamespace;
            setNamespace(nextNamespace);
            useWorkspace
              .getState()
              .updateTab(tab.id, { namespace: nextNamespace });
            write(`Namespace set to ${nextNamespace}.\n`);
            prompt();
            return;
          }
          const args = command[0] === "kubectl" ? command.slice(1) : command;
          if (
            args[0] === "apply" &&
            args.some(
              (part, i) =>
                (["-f", "--filename"].includes(part) && args[i + 1] === "-") ||
                ["-f=-", "--filename=-"].includes(part),
            )
          ) {
            manifest = { command, text: "" };
            write(
              "Paste one YAML/JSON manifest, then press Ctrl+D to apply. Ctrl+C cancels.\n",
            );
          } else void execute(command);
        } catch (error) {
          write(`\x1b[31m${(error as Error).message}\x1b[0m\n`);
          prompt();
        }
      };
      const input = t.onData((data) => {
        if (data === "\x03") {
          cancel();
          return;
        }
        if (busy) return;
        if (manifest) {
          if (data === "\x04") {
            const source = manifest;
            manifest = undefined;
            t.write("\r\n");
            void execute(source.command, source.text);
          } else if (data === "\x7f") {
            if (manifest.text.length) {
              manifest.text = manifest.text.slice(0, -1);
              t.write("\b \b");
            }
          } else {
            const text = data
              .replace(/\r\n?/g, "\n")
              .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
            if (
              new TextEncoder().encode(manifest.text + text).length >
              256 * 1024
            ) {
              t.write("\x07");
              return;
            }
            manifest.text += text;
            write(text);
          }
          return;
        }
        if (data === "\r") {
          submit();
          return;
        }
        if (data === "\x04" && !line) {
          useWorkspace.getState().close(tab.id);
          return;
        }
        if (data === "\x1b[A" || data === "\x1b[B") {
          if (historyIndex === history.length) draft = line;
          historyIndex = Math.max(
            0,
            Math.min(
              history.length,
              historyIndex + (data === "\x1b[A" ? -1 : 1),
            ),
          );
          line = history[historyIndex] ?? draft;
          cursor = line.length;
        } else if (data === "\x1b[D") cursor = Math.max(0, cursor - 1);
        else if (data === "\x1b[C") cursor = Math.min(line.length, cursor + 1);
        else if (["\x01", "\x1b[H", "\x1b[1~"].includes(data)) cursor = 0;
        else if (["\x05", "\x1b[F", "\x1b[4~"].includes(data))
          cursor = line.length;
        else if (data === "\x15") {
          line = line.slice(cursor);
          cursor = 0;
        } else if (data === "\x0b") line = line.slice(0, cursor);
        else if (data === "\x0c") {
          t.clear();
          redraw();
          return;
        } else if (data === "\x7f") {
          if (cursor) {
            line = line.slice(0, cursor - 1) + line.slice(cursor);
            cursor--;
          }
        } else if (data === "\x1b[3~")
          line = line.slice(0, cursor) + line.slice(cursor + 1);
        else if (!data.startsWith("\x1b")) {
          const text = data
            .replace(/[\r\n\t]/g, " ")
            .replace(/[\x00-\x1f\x7f]/g, "");
          if (line.length + text.length > 16384) {
            t.write("\x07");
            return;
          }
          line = line.slice(0, cursor) + text + line.slice(cursor);
          cursor += text.length;
        } else return;
        redraw();
      });
      controls.current = {
        cancel,
        clear: () => {
          if (!busy && !manifest) {
            t.clear();
            redraw();
          }
          t.focus();
        },
        help: () => {
          if (!busy && !manifest) {
            t.write("\r\n");
            write(consoleHelp + "\n\n");
            prompt();
          }
          t.focus();
        },
      };
      const resize = () => {
        if (host.current?.offsetWidth && host.current.offsetHeight) {
          f.fit();
          if (!busy && !manifest) redraw();
        }
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host.current);
      f.fit();
      write(
        `${cluster!.name} · ${cluster!.context}\nType help for commands.\n\n`,
      );
      request = new AbortController();
      void api<Row>(
        `kubernetes/clusters/${clusterId}/check`,
        {},
        "POST",
        request.signal,
      )
        .then((result) => {
          if (disposed) return;
          write(`Connected · ${result.version}\n\n`);
          status("Ready", "connected");
        })
        .catch((error) => {
          if (disposed) return;
          write(`\x1b[31m${(error as Error).message}\x1b[0m\n\n`);
          status("Connection error", "error");
        })
        .finally(() => {
          if (!disposed) {
            request = undefined;
            busy = false;
            prompt();
            t.focus();
          }
        });
      cleanup = () => {
        disposed = true;
        request?.abort();
        controls.current = null;
        observer.disconnect();
        input.dispose();
        t.dispose();
        terminal.current = null;
        fit.current = null;
      };
    }, 0);
    return () => {
      window.clearTimeout(initialize);
      cleanup?.();
    };
  }, [clusterId, tab.id]);

  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.fontFamily =
      terminalFonts[prefs.terminalFont] || terminalFonts["DejaVu Sans Mono"];
    terminal.current.options.fontSize = prefs.terminalFontSize;
    terminal.current.options.theme =
      terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai;
    if (host.current?.offsetWidth) fit.current?.fit();
  }, [prefs.terminalFont, prefs.terminalFontSize, prefs.terminalTheme]);
  useEffect(() => {
    if (visible && host.current?.offsetWidth) {
      fit.current?.fit();
      terminal.current?.focus();
    }
  }, [visible]);
  if (clusters.isPending)
    return <div className="empty-state">Loading cluster…</div>;
  if (!cluster)
    return (
      <div className="empty-state">
        <h3>Cluster unavailable</h3>
        <p>
          {clusters.error?.message ||
            "This cluster was removed or you no longer have access to it."}
        </p>
      </div>
    );
  const theme = terminalThemes[prefs.terminalTheme] || terminalThemes.Molokai;
  return (
    <div
      ref={pane}
      className="pane-inner kube-console"
      aria-label={`Kubernetes console ${cluster.name}`}
    >
      <div className="term-toolbar">
        <KubernetesIcon size={18} />
        <strong className="ellipsis">{cluster.context}</strong>
        <span className="grow" />
        <IconButton
          label="Console help"
          onClick={() => controls.current?.help()}
        >
          <CircleHelp size={18} />
        </IconButton>
        <IconButton
          label="Clear console"
          onClick={() => controls.current?.clear()}
        >
          <Eraser size={18} />
        </IconButton>
        <IconButton
          label="Cancel command"
          disabled={!running}
          onClick={() => controls.current?.cancel()}
        >
          <Square size={16} />
        </IconButton>
        <IconButton
          label="Fullscreen console"
          onClick={() =>
            document.fullscreenElement
              ? void document.exitFullscreen()
              : void pane.current?.requestFullscreen()
          }
        >
          <Maximize size={17} />
        </IconButton>
      </div>
      <div className="term-body" style={{ background: theme.background }}>
        <div
          ref={host}
          className="term-host"
          data-testid="kubernetes-terminal"
        />
      </div>
      <div className="statusbar">
        <span>kubectl</span>
        <span className="ellipsis">{cluster.name}</span>
        <span className="state" role="status">
          {state}
        </span>
      </div>
    </div>
  );
}
