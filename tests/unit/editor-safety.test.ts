import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { fileVersion } from "../../packages/shared/file-version.js";
import { unseal } from "../../packages/shared/crypto.js";
const f = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  rows: [] as any[],
  authorize: vi.fn(),
  actor: {
    id: "",
    organizationId: "",
    kind: "user",
    role: "owner",
    scopes: [],
  },
  history: true,
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: {
    ENCRYPTION_KEY: "ab".repeat(32),
    get SFTP_FILE_HISTORY() {
      return f.history;
    },
    SFTP_HISTORY_DAYS: 30,
  },
}));
vi.mock("../../apps/api/src/auth.js", () => ({
  authenticate: async () => f.actor,
  human: () => {},
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  audit: vi.fn(),
  authorize: f.authorize,
  connection: async () => ({
    host: "app.test",
    port: 22,
    username: "app",
    fingerprint: "fixture",
    fileRoot: "/safe",
  }),
  sshLimits: async () => ({}),
}));
vi.mock("../../apps/api/src/connection-health.js", () => ({
  markSshReachable: vi.fn(async () => {}),
}));
vi.mock("../../packages/database/index.js", () => ({
  db: {
    fileRevision: {
      create: async ({ data }: any) => {
        f.rows.push({ createdAt: new Date(), ...data });
        return data;
      },
      findMany: async ({ where, skip = 0, take }: any) =>
        f.rows
          .filter(
            (r) =>
              r.organizationId === where.organizationId &&
              r.serverId === where.serverId &&
              r.path === where.path &&
              (!where.connectionDigest ||
                r.connectionDigest === where.connectionDigest),
          )
          .slice(skip, take),
      findFirst: async ({ where }: any) =>
        f.rows.find(
          (r) =>
            r.id === where.id &&
            r.organizationId === where.organizationId &&
            r.serverId === where.serverId &&
            r.path === where.path &&
            r.connectionDigest === where.connectionDigest,
        ),
      deleteMany: vi.fn(),
    },
  },
}));
vi.mock("../../packages/ssh-core/index.js", async () => {
  const { EventEmitter } = await import("node:events"),
    { Readable, Writable } = await import("node:stream");
  return {
    connectionFailures: [],
    inside: () => true,
    connect: async () => {
      const client = new EventEmitter() as any;
      client.end = () => client.emit("close");
      return client;
    },
    sftp: async () => ({
      createReadStream: (path: string) =>
        f.files.has(path)
          ? Readable.from([f.files.get(path)!])
          : new Readable({
              read() {
                this.destroy(Object.assign(new Error("missing"), { code: 2 }));
              },
            }),
      createWriteStream: (path: string) => {
        const parts: Buffer[] = [];
        return new Writable({
          write(chunk, _, done) {
            parts.push(Buffer.from(chunk));
            done();
          },
          final(done) {
            f.files.set(path, Buffer.concat(parts));
            done();
          },
        });
      },
    }),
    safePath: async (_: unknown, root: string, path: string) => {
      if (!path.startsWith(root + "/") || path.includes(".."))
        throw new Error("outside root");
      return path;
    },
    invoke: async (_: unknown, method: string, ...args: string[]) => {
      if (method === "stat") {
        const data = f.files.get(args[0]);
        if (!data) throw Object.assign(new Error("missing"), { code: 2 });
        return { size: data.length, mode: 0o644, isFile: () => true };
      }
      if (method === "ext_openssh_rename" || method === "rename") {
        f.files.set(args[1], f.files.get(args[0])!);
        f.files.delete(args[0]);
        return;
      }
      if (method === "unlink") {
        f.files.delete(args[0]);
        return;
      }
      throw new Error("Unexpected method " + method);
    },
  };
});
import { closeSftp, SftpController } from "../../apps/api/src/sftp.js";
const controller = new SftpController(),
  req = {} as Request;
let serverId: string;
beforeEach(() => {
  f.files.clear();
  f.rows = [];
  f.authorize.mockReset();
  f.actor.id = randomUUID();
  f.actor.organizationId = randomUUID();
  f.history = true;
  serverId = randomUUID();
  f.files.set("/safe/app.conf", Buffer.from("original"));
});
afterEach(() => closeSftp(serverId));
it("returns a version, rejects stale writes and preserves both remote data and local history", async () => {
  const opened = await controller.read(req, serverId, "/safe/app.conf");
  expect(opened?.version).toBe(fileVersion(Buffer.from("original")));
  f.files.set("/safe/app.conf", Buffer.from("someone else's change"));
  await expect(
    controller.write(req, serverId, {
      path: "/safe/app.conf",
      content: "my edit",
      expectedVersion: opened!.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.files.get("/safe/app.conf")!.toString()).toBe(
    "someone else's change",
  );
  expect(f.rows).toHaveLength(0);
});
it("encrypts previous contents and scopes history by workspace, server, path and current connection", async () => {
  const opened = await controller.read(req, serverId, "/safe/app.conf");
  await controller.write(req, serverId, {
    path: "/safe/app.conf",
    content: "updated",
    expectedVersion: opened!.version,
  });
  const row = f.rows[0];
  expect(row.encryptedContent).not.toContain("original");
  expect(
    unseal(
      row.encryptedContent,
      "ab".repeat(32),
      `${f.actor.organizationId}:file:${row.id}`,
    ),
  ).toBe("original");
  expect(
    await controller.historyContent(req, serverId, row.id, "/safe/app.conf"),
  ).toMatchObject({ content: "original" });
  f.actor.organizationId = randomUUID();
  await expect(
    controller.historyContent(req, serverId, row.id, "/safe/app.conf"),
  ).rejects.toThrow("unavailable");
});
it("serializes concurrent saves so only one writer with the same version succeeds", async () => {
  const version = fileVersion(Buffer.from("original"));
  const results = await Promise.allSettled(
    ["first", "second"].map((content) =>
      controller.write(req, serverId, {
        path: "/safe/app.conf",
        content,
        expectedVersion: version,
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.files.get("/safe/app.conf")!.toString()).toBe("first");
});
it("keeps file history opt-in and rechecks read permissions for historical contents", async () => {
  f.history = false;
  await controller.write(req, serverId, {
    path: "/safe/app.conf",
    content: "updated",
  });
  expect(f.rows).toHaveLength(0);
  f.authorize.mockRejectedValueOnce(new Error("Read access denied"));
  await expect(
    controller.historyContent(req, serverId, randomUUID(), "/safe/app.conf"),
  ).rejects.toThrow("Read access denied");
});
