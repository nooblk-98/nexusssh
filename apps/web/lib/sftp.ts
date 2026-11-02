"use client";
import { api, uid, type Row } from "./api";
// Client for the interactive SFTP endpoints (apps/api/src/sftp.ts).
export type Entry = {
  name: string;
  size: number;
  mode: number;
  modifiedAt: number;
  directory: boolean;
  symlink: boolean;
};
const q = (params: Record<string, string | string[]>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    for (const x of [v].flat()) s.append(k, x);
  return s.toString();
};
export const sftp = (serverId: string) => {
  const base = `sftp/${serverId}/`;
  return {
    list: (path?: string) =>
      api<{ path: string; root: string; entries: Entry[]; truncated: boolean }>(
        base + "list?" + q(path ? { path } : {}),
      ),
    search: (path: string, term: string) =>
      api<{ matches: { path: string; directory: boolean; size: number }[] }>(
        base + "search?" + q({ path, q: term }),
      ),
    read: (path: string) =>
      api<{
        content: string;
        size: number;
        version: string;
        historyEnabled: boolean;
      }>(base + "read?" + q({ path })),
    write: (path: string, content: string, expectedVersion?: string) =>
      api<{ version: string }>(base + "write", {
        path,
        content,
        expectedVersion,
      }),
    history: (path: string) =>
      api<{ id: string; createdAt: string; digest: string }[]>(
        base + "history?" + q({ path }),
      ),
    historyContent: (path: string, id: string) =>
      api<{ content: string; digest: string }>(
        base + "history/" + id + "?" + q({ path }),
      ),
    mkdir: (path: string) => api(base + "mkdir", { path }),
    remove: (paths: string[]) => api(base + "delete", { paths }),
    rename: (path: string, destination: string) =>
      api(base + "rename", { path, destination }),
    chmod: (paths: string[], mode: number) =>
      api(base + "chmod", { paths, mode }),
    transfer: (a: {
      paths: string[];
      toServerId: string;
      toPath: string;
      move: boolean;
    }) => api<Row>(base + "transfer", a),
    downloadUrl: (paths: string[]) =>
      "/api/" + base + "download?" + q({ path: paths }),
  };
};
// Starts a browser download without leaving the page.
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
export const CHUNK = 8 * 1024 * 1024;
function sendChunk(
  url: string,
  body: Blob,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
) {
  return new Promise<Row>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data: Row = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else
        reject(
          new Error(
            typeof data.message === "string"
              ? data.message
              : `Upload failed (${xhr.status})`,
          ),
        );
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new DOMException("Paused", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
// A resumable upload: pause aborts the current chunk, resume asks the server
// how much it already has and continues from there.
export class Upload {
  readonly id = uid().slice(0, 32);
  offset = 0;
  private controller?: AbortController;
  constructor(
    readonly serverId: string,
    readonly path: string,
    readonly file: File,
    private readonly onProgress: (sent: number) => void,
  ) {}
  private url(extra: Record<string, string> = {}) {
    return (
      `/api/sftp/${this.serverId}/upload?` +
      q({
        path: this.path,
        uploadId: this.id,
        offset: String(this.offset),
        size: String(this.file.size),
        ...extra,
      })
    );
  }
  async run() {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    if (this.offset) {
      const status = await api<Row>(
        `sftp/${this.serverId}/upload?` +
          q({ path: this.path, uploadId: this.id }),
      );
      this.offset = Math.min(this.offset, status.offset);
    }
    do {
      const end = Math.min(this.offset + CHUNK, this.file.size);
      const r = await sendChunk(
        this.url(),
        this.file.slice(this.offset, end),
        (sent) => this.onProgress(this.offset + sent),
        signal,
      );
      this.offset = r.offset;
      this.onProgress(this.offset);
    } while (this.offset < this.file.size);
  }
  pause() {
    this.controller?.abort();
  }
  async cancel() {
    this.controller?.abort();
    await fetch(this.url({ cancel: "1" }), { method: "POST" }).catch(() => {});
  }
}
