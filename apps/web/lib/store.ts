"use client";
import { useEffect } from "react";
import { create } from "zustand";
import { api, notify, queryClient, uid, useApi, type Row } from "./api";

export type Prefs = {
  uiTheme: "auto" | "light" | "dark";
  terminalTheme: string;
  terminalFont: string;
  terminalFontSize: number;
  copyOnSelect: boolean;
  compactSuggestions: boolean;
  editorTheme: string;
  editorWrap: boolean;
  mfaEnabled?: boolean;
  recoveryCodesLeft?: number;
};
export const defaultPrefs: Prefs = {
  uiTheme: "auto",
  terminalTheme: "Molokai",
  terminalFont: "DejaVu Sans Mono",
  terminalFontSize: 14,
  copyOnSelect: true,
  compactSuggestions: true,
  editorTheme: "Dracula",
  editorWrap: false,
};
export function applyTheme(theme: Prefs["uiTheme"]) {
  const dark =
    theme === "dark" ||
    (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem("nexus-theme", theme);
  } catch {}
}
export function usePrefs() {
  const q = useApi<Partial<Prefs>>("preferences");
  const prefs: Prefs = { ...defaultPrefs, ...(q.data || {}) };
  useEffect(() => {
    if (!q.data) return;
    applyTheme(prefs.uiTheme);
    if (prefs.uiTheme !== "auto") return;
    const m = matchMedia("(prefers-color-scheme: dark)");
    const f = () => applyTheme("auto");
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q.data, prefs.uiTheme]);
  return prefs;
}
export async function savePrefs(patch: Partial<Prefs>) {
  queryClient.setQueryData(["preferences"], (old: Row | undefined) => ({
    ...(old || {}),
    ...patch,
  }));
  if (patch.uiTheme) applyTheme(patch.uiTheme);
  await api("preferences", patch, "PATCH").catch(notify.error);
}

export type TabKind = "terminal" | "sftp" | "editor";
export type Tab = {
  id: string;
  kind: TabKind;
  serverId: string;
  title: string;
  path?: string;
  status?: "connecting" | "connected" | "error" | "closed";
  // Terminal resume token, so a reload reattaches to the same shell.
  resume?: string;
};
type Workspace = {
  tabs: Tab[];
  active: string | null;
  columns: number;
  collapsed: boolean;
  selected: string | null;
  broadcast: string[];
  open: (t: Omit<Tab, "id">) => string;
  close: (id: string) => void;
  activate: (id: string | null) => void;
  setStatus: (id: string, status: Tab["status"]) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  setColumns: (n: number) => void;
  setCollapsed: (v: boolean) => void;
  select: (id: string | null) => void;
  toggleBroadcast: (id: string) => void;
};
export const narrow = () =>
  typeof window !== "undefined" && matchMedia("(max-width: 760px)").matches;
// Open tabs are remembered per browser tab (sessionStorage), so a reload
// brings them back; terminals then resume their shells.
const SAVED = "nexus-workspace";
function saved(): Pick<Workspace, "tabs" | "active" | "columns"> {
  try {
    const v = JSON.parse(sessionStorage.getItem(SAVED) || "null");
    if (v && Array.isArray(v.tabs))
      return {
        tabs: v.tabs.map((t: Tab) => ({ ...t, status: "connecting" })),
        active: v.active ?? null,
        columns: v.columns || 1,
      };
  } catch {}
  return { tabs: [], active: null, columns: 1 };
}
export const useWorkspace = create<Workspace>((set, get) => ({
  ...(typeof window === "undefined"
    ? { tabs: [], active: null, columns: 1 }
    : saved()),
  // On phones the server list overlays the workspace, so it starts hidden.
  collapsed: narrow(),
  selected: null,
  broadcast: [],
  open: (t) => {
    // An editor for a file that is already open is focused, not duplicated.
    const existing =
      t.kind === "editor" &&
      get().tabs.find(
        (x) =>
          x.kind === "editor" && x.serverId === t.serverId && x.path === t.path,
      );
    if (existing) {
      set({ active: existing.id });
      return existing.id;
    }
    const id = uid();
    set((s) => ({ tabs: [...s.tabs, { ...t, id }], active: id }));
    return id;
  },
  close: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const active =
        s.active === id
          ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null)
          : s.active;
      return { tabs, active, broadcast: s.broadcast.filter((b) => b !== id) };
    }),
  activate: (active) => set({ active }),
  setStatus: (id, status) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)),
    })),
  setColumns: (columns) => set({ columns }),
  setCollapsed: (collapsed) => set({ collapsed }),
  select: (selected) => set({ selected }),
  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  toggleBroadcast: (id) =>
    set((s) => ({
      broadcast: s.broadcast.includes(id)
        ? s.broadcast.filter((b) => b !== id)
        : [...s.broadcast, id],
    })),
}));
if (typeof window !== "undefined")
  useWorkspace.subscribe((s) => {
    try {
      sessionStorage.setItem(
        SAVED,
        JSON.stringify({ tabs: s.tabs, active: s.active, columns: s.columns }),
      );
    } catch {}
  });
// Terminals register their input sink so broadcast keystrokes reach every
// terminal that has broadcasting switched on.
export const terminalSinks = new Map<string, (data: string) => void>();
export function sendInput(fromTab: string, data: string) {
  const { broadcast } = useWorkspace.getState();
  if (!broadcast.includes(fromTab)) return terminalSinks.get(fromTab)?.(data);
  for (const id of broadcast) terminalSinks.get(id)?.(data);
}
