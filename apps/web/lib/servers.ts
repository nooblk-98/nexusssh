"use client";
import { api, notify, refresh, useApi, type Row } from "./api";
import { narrow, useWorkspace } from "./store";
export function useServers() {
  const servers = useApi<Row[]>("servers");
  const groups = useApi<Row[]>("groups");
  return {
    servers: (servers.data || []).filter((s) => !s.archived),
    groups: [...(groups.data || [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    loading: servers.isPending,
  };
}
export const settingsOf = (s: Row): Row => {
  try {
    return JSON.parse(s.terminalSettings || "{}");
  } catch {
    return {};
  }
};
// The API replaces the whole record on PATCH, so edits start from the row.
export function serverBody(s: Row, patch: Row = {}) {
  return {
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    identityId: s.identityId,
    fingerprint: s.fingerprint || null,
    environment: s.environment,
    description: s.description || "",
    icon: s.icon || "linux",
    terminalSettings: settingsOf(s),
    fileRoot: s.fileRoot,
    groupId: s.groupId || null,
    bastionId: s.bastionId || null,
    favorite: !!s.favorite,
    archived: false,
    tags: (s.tags || []).map((t: Row) => t.name),
    ...patch,
  };
}
export const updateServer = (s: Row, patch: Row) =>
  api("servers/" + s.id, serverBody(s, patch), "PATCH")
    .then(() => refresh("servers"))
    .catch(notify.error);
export function connectServer(s: Row, kind: "terminal" | "sftp" = "terminal") {
  const ws = useWorkspace.getState();
  ws.select(s.id);
  ws.open({ kind, serverId: s.id, title: s.name, status: "connecting" });
  if (narrow()) ws.setCollapsed(true);
}
