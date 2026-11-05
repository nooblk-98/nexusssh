import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const f = vi.hoisted(() => ({
  connects: 0,
  release: [] as (() => void)[],
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: { SSH_MAX_SESSIONS: 1, SSH_IDLE_TIMEOUT: 60000, SSH_OUTPUT_LIMIT: 1 << 20 },
  sameOrigin: () => true,
}));
vi.mock("../../apps/api/src/auth.js", () => ({
  authenticate: async () => ({ id: "u1", organizationId: "org", kind: "user", role: "owner", scopes: [] }),
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  authorize: async () => {},
  audit: async () => {},
  connection: async () => ({ host: "app.test", port: 22 }),
  sshLimits: async () => ({}),
}));
vi.mock("../../apps/api/src/connection-health.js", () => ({
  markSshReachable: async () => {},
}));
vi.mock("../../packages/database/index.js", () => ({
  db: {
    sSHSession: {
      create: async () => ({ id: "session-" + f.connects }),
      updateMany: async () => ({ count: 1 }),
      findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id })),
    },
    sSHConnectionHistory: { create: async () => ({}) },
  },
}));
vi.mock("../../packages/ssh-core/index.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    // Every SSH handshake stays pending until the test releases it, so all
    // browsers are mid-startup at the same time.
    connect: async () => {
      f.connects++;
      await new Promise<void>((resolve) => f.release.push(resolve));
      const client = new EventEmitter() as any;
      client.end = () => {};
      client.shell = (_: unknown, done: (e: unknown, s: unknown) => void) => {
        const stream = new EventEmitter() as any;
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        stream.write = () => {};
        done(undefined, stream);
      };
      client.exec = () => {};
      return client;
    },
  };
});
import { terminals } from "../../apps/api/src/terminal.js";

let server: Server | undefined;
let wss: ReturnType<typeof terminals> | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  // Unblock any handshake still pending so a regression fails instead of hanging.
  for (const release of f.release.splice(0)) release();
  for (const ws of clients.splice(0)) ws.terminate();
  wss?.closeAll();
  wss?.close();
  await new Promise((resolve) => server?.close(resolve));
});

it("counts startups still connecting against the session capacity", async () => {
  server = createServer();
  wss = terminals(server);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}/ws/terminal?serverId=${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
  const messages = Array.from({ length: 3 }, () => {
    const ws = new WebSocket(url, { headers: { origin: "http://127.0.0.1" } });
    clients.push(ws);
    return new Promise<any>((resolve) =>
      ws.on("message", (raw) => {
        resolve(JSON.parse(raw.toString()));
        ws.close();
      }),
    );
  });
  await vi.waitFor(() => expect(f.connects).toBe(1));
  // The two browsers beyond capacity are refused without an SSH connection.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.connects).toBe(1);
  for (const release of f.release) release();
  const results = await Promise.all(messages);
  expect(results.filter((m) => m.type === "ready")).toHaveLength(1);
  expect(results.filter((m) => m.message === "Session capacity reached")).toHaveLength(2);
});
