"use client";
import { useMemo } from "react";
import { api, notify, refresh, useApi, type Row } from "./api";
import { narrow, useWorkspace } from "./store";
import type { Folder } from "./folders";
const EMPTY_SERVERS: Row[] = [];
const EMPTY_GROUPS: Folder[] = [];
export function useServers() {
  const servers = useApi<Row[]>("servers", { interval: 30000 });
  const groups = useApi<Folder[]>("groups");
  const serverData = servers.data || EMPTY_SERVERS;
  const groupData = groups.data || EMPTY_GROUPS;
  const visibleServers = useMemo(
    () => serverData.filter((s) => !s.archived),
    [serverData],
  );
  const sortedGroups = useMemo(
    () => [...groupData].sort((a, b) => a.name.localeCompare(b.name)),
    [groupData],
  );
  return {
    servers: visibleServers,
    groups: sortedGroups,
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
    vpnProfileId: s.vpnProfileId || null,
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
