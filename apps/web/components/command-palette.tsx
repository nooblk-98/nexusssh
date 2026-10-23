"use client";
import { useState } from "react";
import { type Row } from "../lib/api";
import { connectServer } from "../lib/servers";
import { Button, Drawer } from "./ui";
import { openServerDrawer } from "./server-drawer";

export function CommandPalette({ servers, canManage, onClose, onCheck }: { servers: Row[]; canManage: boolean; onClose: () => void; onCheck: (server: Row) => void }) {
  const [query, setQuery] = useState("");
  const matches = servers.filter((server) => `${server.name} ${server.host} ${(server.tags || []).map((tag: Row) => tag.name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30);
  const act = (action: () => void) => { action(); onClose(); };
  return <Drawer title="Command palette" onClose={onClose}>
    <input autoFocus className="input" aria-label="Search servers and actions" placeholder="Search servers or actions" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="drawer-section">Actions</div>
    {canManage && (!query || "new server".includes(query.toLowerCase())) && <Button variant="secondary" onClick={() => act(() => openServerDrawer({}))}>New server</Button>}
    <div className="drawer-section">Servers</div>
    {matches.map((server) => <div key={server.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
      <span className="grow ellipsis" title={server.host}>{server.name}</span>
      <Button size="sm" onClick={() => act(() => connectServer(server))}>Connect</Button>
      {canManage && <Button size="sm" variant="secondary" onClick={() => act(() => openServerDrawer({ server }))}>Details</Button>}
      <Button size="sm" variant="secondary" onClick={() => act(() => onCheck(server))}>Test</Button>
    </div>)}
    {!matches.length && <p className="small">No matching servers.</p>}
  </Drawer>;
}
