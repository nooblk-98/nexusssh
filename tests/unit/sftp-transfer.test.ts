import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import posix from "node:path/posix";
import type { Request } from "express";

type Node = { type: "file" | "dir" | "link" | "fifo"; data?: Buffer; target?: string };
const f = vi.hoisted(() => ({
  fs: new Map<string, Node>(),
  ended: 0,
  actor: { id: "", organizationId: "", kind: "user", role: "owner", scopes: [] },
}));
const TYPE_BITS = { file: 0o100000, dir: 0o040000, link: 0o120000, fifo: 0o010000 };
function attrs(node: Node) {
  return {
    size: node.data?.length ?? 0,
    mode: TYPE_BITS[node.type] | 0o644,
    mtime: 0,
    isDirectory: () => node.type === "dir",
    isFile: () => node.type === "file",
    isSymbolicLink: () => node.type === "link",
  };
}
const missing = () => Object.assign(new Error("missing"), { code: 2 });
vi.mock("../../packages/shared/config.js", () => ({
  config: { ENCRYPTION_KEY: "ab".repeat(32), SFTP_FILE_HISTORY: false, SFTP_HISTORY_DAYS: 30 },
}));
vi.mock("../../apps/api/src/auth.js", () => ({
  authenticate: async () => f.actor,
  human: () => {},
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  audit: vi.fn(),
  authorize: vi.fn(),
  connection: async () => ({ host: "app.test", port: 22, username: "app", fingerprint: "fixture", fileRoot: "/safe" }),
  sshLimits: async () => ({}),
}));
vi.mock("../../apps/api/src/connection-health.js", () => ({
  markSshReachable: vi.fn(async () => {}),
}));
vi.mock("../../packages/database/index.js", () => ({ db: {} }));
vi.mock("../../packages/ssh-core/index.js", async () => {
  const { EventEmitter } = await import("node:events"),
    { Readable, Writable } = await import("node:stream");
  return {
    connectionFailures: [],
    inside: () => true,
    connect: async () => {
      const client = new EventEmitter() as any;
      client.end = () => {
        f.ended++;
        client.emit("close");
      };
      return client;
    },
    sftp: async () => ({
      createReadStream: (path: string) => {
        const node = f.fs.get(path);
        return node?.type === "file"
          ? Readable.from([node.data!])
          : new Readable({ read() { this.destroy(missing()); } });
      },
      createWriteStream: (path: string) => {
        const parts: Buffer[] = [];
        return new Writable({
          write(chunk, _, done) { parts.push(Buffer.from(chunk)); done(); },
          final(done) { f.fs.set(path, { type: "file", data: Buffer.concat(parts) }); done(); },
        });
      },
    }),
    safePath: async (_: unknown, root: string, path: string) => {
      if (path !== root && !path.startsWith(root + "/")) throw new Error("outside root");
      return path;
    },
    invoke: async (_: unknown, method: string, ...args: any[]) => {
      const [a, b] = args as [string, string];
      const node = f.fs.get(a);
      switch (method) {
        case "realpath":
          return posix.normalize(a);
        case "lstat":
        case "stat":
          if (!node) throw missing();
          return attrs(node);
        case "readdir":
          return [...f.fs.entries()]
            .filter(([p]) => posix.dirname(p) === a && p !== a)
            .map(([p, n]) => ({ filename: posix.basename(p), attrs: attrs(n) }));
        case "mkdir":
          if (node) throw new Error("exists");
          f.fs.set(a, { type: "dir" });
          return;
        case "rmdir":
          if ([...f.fs.keys()].some((p) => posix.dirname(p) === a && p !== a))
            throw new Error("Directory not empty");
          f.fs.delete(a);
          return;
        case "unlink":
          f.fs.delete(a);
          return;
        case "rename":
        case "ext_openssh_rename":
          f.fs.set(b, node!);
          f.fs.delete(a);
          return;
      }
      throw new Error("Unexpected method " + method);
    },
  };
});
import { closeSftp, SftpController } from "../../apps/api/src/sftp.js";
const controller = new SftpController();
let source: string, destination: string;
beforeEach(() => {
  f.fs.clear();
  f.ended = 0;
  f.actor.id = randomUUID();
  f.actor.organizationId = randomUUID();
  source = randomUUID();
  destination = randomUUID();
  f.fs.set("/safe", { type: "dir" });
  f.fs.set("/safe/dst", { type: "dir" });
  f.fs.set("/safe/app", { type: "dir" });
  f.fs.set("/safe/app/config.yml", { type: "file", data: Buffer.from("kept") });
});
afterEach(() => {
  vi.useRealTimers();
  closeSftp(source);
  closeSftp(destination);
});
const move = (req: Request = {} as Request) =>
  controller.transfer(req, source, {
    paths: ["/safe/app"],
    toServerId: destination,
    toPath: "/safe/dst",
    move: true,
  });

it("refuses a cross-server move containing a symlink and leaves the source intact", async () => {
  f.fs.set("/safe/app/current", { type: "link", target: "/safe/app/config.yml" });
  await expect(move()).rejects.toThrow(/symbolic links/);
  expect(f.fs.get("/safe/app/current")?.type).toBe("link");
  expect(f.fs.get("/safe/app/config.yml")?.data?.toString()).toBe("kept");
  expect(f.fs.has("/safe/dst/app")).toBe(false);
});
it("refuses a cross-server move of a top-level symlink or special file", async () => {
  f.fs.set("/safe/link", { type: "link", target: "/safe/app" });
  f.fs.set("/safe/pipe", { type: "fifo" });
  for (const path of ["/safe/link", "/safe/pipe"])
    await expect(
      controller.transfer({} as Request, source, { paths: [path], toServerId: destination, toPath: "/safe/dst", move: true }),
    ).rejects.toThrow(/special files/);
  expect(f.fs.get("/safe/link")?.type).toBe("link");
  expect(f.fs.get("/safe/pipe")?.type).toBe("fifo");
});
it("checks every item before moving any of them", async () => {
  f.fs.set("/safe/other", { type: "dir" });
  f.fs.set("/safe/other/socket", { type: "fifo" });
  await expect(
    controller.transfer({} as Request, source, { paths: ["/safe/app", "/safe/other"], toServerId: destination, toPath: "/safe/dst", move: true }),
  ).rejects.toThrow(/special files/);
  expect(f.fs.get("/safe/app/config.yml")?.data?.toString()).toBe("kept");
  expect(f.fs.has("/safe/dst/app")).toBe(false);
});
it("moves directories of regular files across servers", async () => {
  f.fs.set("/safe/app/nested", { type: "dir" });
  f.fs.set("/safe/app/nested/data.txt", { type: "file", data: Buffer.from("payload") });
  await expect(move()).resolves.toMatchObject({ copied: 2 });
  expect(f.fs.get("/safe/dst/app/config.yml")?.data?.toString()).toBe("kept");
  expect(f.fs.get("/safe/dst/app/nested/data.txt")?.data?.toString()).toBe("payload");
  expect([...f.fs.keys()].some((p) => p.startsWith("/safe/app"))).toBe(false);
});
it("copies across servers skipping links and special files", async () => {
  f.fs.set("/safe/app/current", { type: "link", target: "/safe/app/config.yml" });
  f.fs.set("/safe/app/pipe", { type: "fifo" });
  await expect(
    controller.transfer({} as Request, source, { paths: ["/safe/app"], toServerId: destination, toPath: "/safe/dst", move: false }),
  ).resolves.toMatchObject({ copied: 1 });
  expect(f.fs.get("/safe/dst/app/config.yml")?.data?.toString()).toBe("kept");
  expect(f.fs.has("/safe/dst/app/current")).toBe(false);
  expect(f.fs.get("/safe/app/current")?.type).toBe("link");
});
it("keeps the pooled channel open while a request is in flight", async () => {
  vi.useFakeTimers();
  const res = new EventEmitter();
  await controller.list({ res } as unknown as Request, source, "/safe");
  vi.advanceTimersByTime(120000);
  expect(f.ended).toBe(0);
  res.emit("close");
  vi.advanceTimersByTime(59000);
  expect(f.ended).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(f.ended).toBe(1);
});
