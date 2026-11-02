"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { WorkspacePresets } from "./workspace-presets";
import {
  ChevronRight,
  Columns2,
  FileText,
  Folder,
  Grid2x2,
  Home as HomeIcon,
  LayoutGrid,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { useServers } from "../lib/servers";
import { useWorkspace, type Tab } from "../lib/store";
import { Home } from "./home";
import { KubernetesIcon } from "./kubernetes-icon";
import { openMenu, openMenuAt } from "./ui";

const TerminalView = dynamic(() => import("./terminal"), { ssr: false });
const SftpView = dynamic(() => import("./sftp"), { ssr: false });
const EditorView = dynamic(() => import("./editor"), { ssr: false });
const KubernetesConsole = dynamic(() => import("./kubernetes-console"), {
  ssr: false,
});
const kindIcon = {
  terminal: SquareTerminal,
  sftp: Folder,
  editor: FileText,
  kubernetes: KubernetesIcon,
};
const layouts = [
  { n: 1, label: "Single view", icon: Square },
  { n: 2, label: "Two columns", icon: Columns2 },
  { n: 3, label: "Three columns", icon: LayoutGrid },
  { n: 4, label: "Grid (2 × 2)", icon: Grid2x2 },
];
export function Workspace() {
  const [presets, setPresets] = useState(false);
  const {
    tabs,
    active,
    columns,
    collapsed,
    activate,
    close,
    open,
    setColumns,
    setCollapsed,
  } = useWorkspace();
  const { servers } = useServers();
  const current = tabs.find((t) => t.id === active);
  useEffect(() => {
    document.title = (current ? current.title + " - " : "") + "NexusSSH";
  }, [current]);
  const split = columns > 1 && tabs.length > 1;
  const tabMenu = (t: Tab) => {
    const server = servers.find((s) => s.id === t.serverId);
    return [
      ...(t.kind === "kubernetes"
        ? [
            {
              label: "Duplicate console",
              onClick: () =>
                open({
                  kind: t.kind,
                  serverId: t.serverId,
                  title: t.title,
                  status: "connecting" as const,
                }),
            },
          ]
        : []),
      ...(server && t.kind !== "editor"
        ? [
            {
              label: "Duplicate",
              onClick: () =>
                open({
                  kind: t.kind,
                  serverId: t.serverId,
                  title: t.title,
                  status: "connecting" as const,
                }),
            },
            t.kind === "terminal"
              ? {
                  label: "Open SFTP",
                  onClick: () =>
                    open({
                      kind: "sftp",
                      serverId: t.serverId,
                      title: t.title,
                      status: "connecting",
                    }),
                }
              : {
                  label: "Open Terminal",
                  onClick: () =>
                    open({
                      kind: "terminal",
                      serverId: t.serverId,
                      title: t.title,
                      status: "connecting",
                    }),
                },
            "sep" as const,
          ]
        : []),
      { label: "Close", onClick: () => close(t.id) },
      {
        label: "Close Others",
        disabled: tabs.length < 2,
        onClick: () =>
          tabs.filter((x) => x.id !== t.id).forEach((x) => close(x.id)),
      },
      { label: "Close All", onClick: () => tabs.forEach((x) => close(x.id)) },
    ];
  };
  const gridCols = columns === 4 ? 2 : Math.min(columns, tabs.length);
  return (
    <main className="main">
      <div className="tabbar">
        {collapsed && (
          <button
            className="expand-btn"
            aria-label="Show server list"
            title="Show server list"
            onClick={() => setCollapsed(false)}
          >
            <ChevronRight size={16} />
          </button>
        )}
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={!active}
            aria-label="Home"
            title="Home"
            className={"tab home" + (!active ? " active" : "")}
            onClick={() => activate(null)}
          >
            <HomeIcon size={16} fill="currentColor" strokeWidth={1.5} />
          </button>
          {tabs.map((t) => {
            const Icon = kindIcon[t.kind];
            return (
              <div
                key={t.id}
                role="tab"
                tabIndex={0}
                aria-selected={active === t.id}
                className={"tab" + (active === t.id ? " active" : "")}
                title={t.path || t.title}
                onClick={() => activate(t.id)}
                onKeyDown={(e) => e.key === "Enter" && activate(t.id)}
                onAuxClick={(e) => e.button === 1 && close(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, tabMenu(t));
                }}
              >
                <Icon size={15} className="tab-icon" />
                <span
                  className={
                    "dot" +
                    (t.status === "connected"
                      ? " on"
                      : t.status === "error"
                        ? " err"
                        : "")
                  }
                />
                {t.title}
                <button
                  className="close"
                  aria-label={"Close " + t.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="tabbar-end"
          aria-label="Workspace presets"
          title="Workspace presets"
          onClick={() => setPresets(true)}
        >
          <Folder size={16} />
        </button>
        <button
          className="tabbar-end"
          aria-label="Layout"
          title="Layout"
          onClick={(e) =>
            openMenuAt(
              e.currentTarget,
              layouts.map((l) => ({
                label: l.label + (columns === l.n ? "  ✓" : ""),
                icon: <l.icon size={15} />,
                onClick: () => setColumns(l.n),
              })),
            )
          }
        >
          <LayoutGrid size={16} />
        </button>
      </div>
      <div
        className="panes"
        style={
          split
            ? {
                gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                gridAutoRows: "minmax(0, 1fr)",
              }
            : undefined
        }
      >
        {!split && (
          <div className={"pane" + (active ? " hidden" : "")}>
            <Home />
          </div>
        )}
        {tabs.map((t) => {
          const server = servers.find((s) => s.id === t.serverId);
          const visible = split || active === t.id;
          return (
            <div
              key={t.id}
              className={
                "pane" +
                (visible ? "" : " hidden") +
                (split && active === t.id ? " focused" : "")
              }
              onMouseDown={() => split && activate(t.id)}
            >
              {t.kind === "kubernetes" ? (
                <KubernetesConsole tab={t} visible={visible} />
              ) : !server ? (
                <div className="empty-state">
                  <h3>Server unavailable</h3>
                  <p>
                    This server was removed or you no longer have access to it.
                  </p>
                </div>
              ) : t.kind === "terminal" ? (
                <TerminalView tab={t} server={server} visible={visible} />
              ) : t.kind === "sftp" ? (
                <SftpView tab={t} server={server} />
              ) : (
                <EditorView tab={t} server={server} />
              )}
            </div>
          );
        })}
      </div>
      {presets && <WorkspacePresets onClose={() => setPresets(false)} />}
    </main>
  );
}
