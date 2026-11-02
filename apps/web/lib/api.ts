"use client";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { create } from "zustand";
export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message + (requestId ? ` [reference: ${requestId}]` : ""));
  }
}
// crypto.randomUUID exists only on HTTPS and localhost; workspaces are often
// opened over plain HTTP on a LAN address, where getRandomValues still works.
export const uid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
export async function api<T = Row>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    signal,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      typeof data.message === "string"
        ? data.message
        : Array.isArray(data.message)
          ? data.message.join(", ")
          : JSON.stringify(data.message || data),
      response.status,
      response.headers.get("X-Correlation-ID") || data.requestId,
    );
  return data;
}
export function useApi<T = Row[]>(
  path: string,
  {
    enabled = true,
    interval = 0,
  }: { enabled?: boolean; interval?: number } = {},
) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path),
    enabled,
    refetchInterval: interval || false,
  });
}
export async function refresh(...keys: string[]): Promise<void> {
  if (!keys.length) return queryClient.invalidateQueries();
  await Promise.all(
    keys.map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
  );
}
// Runs a policy-checked SSH operation. Operations that need a human decision
// come back as approval_required; callers show that instead of a result.
export async function operation<T = Row>(op: string, args: Row): Promise<T> {
  const result = await api<Row>("operations/" + op, args);
  if (result.status === "approval_required") {
    void refresh("approvals");
    throw new Error(
      "Approval required. An administrator can approve it under Settings → Approvals, then retry.",
    );
  }
  return result as T;
}
// navigator.clipboard is also limited to secure origins; fall back to a
// temporary textarea so Copy works over plain HTTP too.
export async function copyText(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Copy is not available in this browser");
}
export function saveFile(data: BlobPart, name: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const base64ToBytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export function formatBytes(n?: number) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (
    (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)) + " " + units[i]
  );
}
export function timeAgo(date: string | number | Date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return "a few seconds ago";
  if (s < 90) return "a minute ago";
  const m = Math.round(s / 60);
  if (m < 45) return m + " minutes ago";
  const h = Math.round(m / 60);
  if (h < 22) return h === 1 ? "an hour ago" : h + " hours ago";
  const d = Math.round(h / 24);
  return d === 1 ? "a day ago" : d + " days ago";
}

type Toast = { id: number; kind: "info" | "error" | "success"; text: string };
export const useToasts = create<{
  items: Toast[];
  push: (kind: Toast["kind"], text: string) => void;
  dismiss: (id: number) => void;
}>((set) => ({
  items: [],
  push: (kind, text) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { id, kind, text }] }));
    setTimeout(
      () => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
      kind === "error" ? 8000 : 4000,
    );
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
export const notify = {
  info: (t: string) => useToasts.getState().push("info", t),
  success: (t: string) => useToasts.getState().push("success", t),
  error: (e: unknown) =>
    useToasts
      .getState()
      .push("error", e instanceof Error ? e.message : String(e)),
};
