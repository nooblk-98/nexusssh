"use client";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, useApi, type Row } from "../lib/api";
import { usePath } from "../lib/router";
import { usePrefs, useWorkspace } from "../lib/store";
import { Auth } from "../components/auth";
import { ServerDrawerHost } from "../components/server-drawer";
import { Settings } from "../components/settings/layout";
import { Sidebar } from "../components/sidebar";
import { SnippetsDrawerHost } from "../components/snippets";
import { DialogHost, MenuHost, Toasts } from "../components/ui";
import { Workspace } from "../components/workspace";

export default function Page() {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
      <MenuHost />
      <DialogHost />
      <Toasts />
    </QueryClientProvider>
  );
}
function App() {
  const me = useApi<Row>("auth/me");
  if (me.isPending)
    return <div className="splash">Opening your workspace…</div>;
  if (!me.data) return <Auth onLogin={() => void queryClient.resetQueries()} />;
  return <SignedIn me={me.data} />;
}
function SignedIn({ me }: { me: Row }) {
  usePrefs();
  const path = usePath();
  const { collapsed, setCollapsed } = useWorkspace();
  const admin = ["owner", "administrator"].includes(me.role);
  const settings = path.match(/^\/settings\/?([a-z-]*)/);
  useEffect(() => {
    const mq = matchMedia("(max-width: 760px)");
    const f = () => setCollapsed(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [setCollapsed]);
  useEffect(() => {
    // Ctrl/Cmd+K focuses the server search, as in the server list.
    const f = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "k" &&
        !settings
      ) {
        e.preventDefault();
        useWorkspace.getState().setCollapsed(false);
        setTimeout(() => document.getElementById("server-search")?.focus());
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [settings]);
  return (
    <>
      {/* The workspace stays mounted under settings so open sessions survive. */}
      <div
        className={"shell" + (collapsed ? " collapsed" : "")}
        style={settings ? { display: "none" } : undefined}
      >
        <Sidebar me={me} />
        <div className="sidebar-mask" onClick={() => setCollapsed(true)} />
        <Workspace />
      </div>
      {settings && <Settings me={me} slug={settings[1]} />}
      <ServerDrawerHost />
      <SnippetsDrawerHost admin={admin} />
    </>
  );
}
