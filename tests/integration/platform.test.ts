import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connect, operate } from "../../packages/ssh-core/index.js";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createServer } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import { scanHostKey } from "../../packages/ssh-core/index.js";
import { hash } from "../../packages/shared/crypto.js";
const enabled = process.env.RUN_INTEGRATION === "1";
describe.runIf(enabled)(
  "real Linux SSH, API, SQLite, worker and remote MCP integration",
  () => {
    const root = process.cwd(),
      port = 3101,
      mcpPort = 3102,
      origin = "http://localhost:3000";
    const processes: ChildProcess[] = [];
    let cookie = "",
      serverId = "",
      token = "",
      fingerprint = "",
      privateKey = "",
      directory = "";
    let env: NodeJS.ProcessEnv;
    let log = "";
    const docker = (...args: string[]) =>
      execFileSync(
        "docker",
        ["compose", "-f", "tests/fixtures/compose.yml", ...args],
        { encoding: "utf8" },
      ).trim();
    async function request(
      route: string,
      body?: unknown,
      auth?: string,
      method?: string,
    ) {
      const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          origin,
          "content-type": "application/json",
          ...(auth ? { authorization: "Bearer " + auth } : { cookie }),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await r.json();
      return { r, data };
    }

    function launch(file: string) {
      const p = spawn(process.execPath, ["--import", "tsx", file], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout?.on("data", (d) => (log += d));
      p.stderr?.on("data", (d) => (log += d));
      processes.push(p);
      return p;
    }
    async function wait(url: string) {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(url)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Service failed to start: " + log);
    }
    beforeAll(async () => {
      mkdirSync("data", { recursive: true });
      directory = mkdtempSync(path.join(root, "data", "integration-"));
      env = {
        ...process.env,
        NODE_ENV: "test",
        APP_URL: origin,
        DATABASE_URL:
          "file:" + path.join(directory, "test.db").replaceAll("\\", "/"),
        REDIS_URL: "redis://127.0.0.1:26379",
        ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        SESSION_SECRET: randomBytes(32).toString("hex"),
        INTERNAL_SECRET: randomBytes(32).toString("hex"),
        SETUP_TOKEN: randomBytes(32).toString("hex"),
        AUTH_ISSUER: origin,
        AUTH_AUDIENCE: "nexusssh",
        MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}/mcp`,
        MCP_AUTH_ISSUER: origin,
        INTERNAL_API_URL: `http://127.0.0.1:${port}`,
        API_PORT: String(port),
        MCP_PORT: String(mcpPort),
        SSH_ALLOWED_CIDRS: "127.0.0.1/32",
        SSH_CONNECT_TIMEOUT: "5000",
      };
      if (process.platform === "win32")
        env.DATABASE_URL =
          "file:" +
          path
            .relative(
              path.join(root, "packages/database/prisma"),
              path.join(directory, "test.db"),
            )
            .replaceAll("\\", "/");
      writeFileSync(path.join(directory, "test.db"), "");
      execFileSync(
        process.execPath,
        [
          "node_modules/prisma/build/index.js",
          "migrate",
          "deploy",
          "--schema",
          "packages/database/prisma/schema.prisma",
        ],
        { cwd: root, env, stdio: "pipe" },
      );
      fingerprint = docker(
        "exec",
        "-T",
        "ssh",
        "ssh-keygen",
        "-lf",
        "/etc/ssh/ssh_host_ed25519_key.pub",
        "-E",
        "sha256",
      ).split(" ")[1];
      privateKey = docker(
        "exec",
        "-T",
        "ssh",
        "cat",
        "/home/nexus/.ssh/test_key",
      );
      const seed = new PrismaClient({
        datasources: { db: { url: env.DATABASE_URL } },
      });
      const mainOrg = await seed.organization.create({
        data: { name: "Integration" },
      });
      await seed.user.create({
        data: {
          organizationId: mainOrg.id,
          name: "Fixture Owner",
          email: "owner@example.test",
          role: "owner",
          passwordHash: await bcrypt.hash("fixture-owner-password-123", 12),
        },
      });
      const otherOrg = await seed.organization.create({
        data: { name: "Other organization" },
      });
      const otherUser = await seed.user.create({
        data: {
          organizationId: otherOrg.id,
          name: "Other owner",
          email: "other@example.test",
          role: "owner",
          passwordHash: await bcrypt.hash("other-fixture-password-123", 12),
        },
      });
      await seed.agent.create({
        data: {
          organizationId: otherOrg.id,
          ownerId: otherUser.id,
          name: "Expired fixture",
          tokens: {
            create: {
              tokenHash: hash("expired-fixture-token"),
              issuer: env.MCP_AUTH_ISSUER!,
              audience: env.MCP_PUBLIC_URL!,
              scopes: "[]",
              expiresAt: new Date(0),
            },
          },
        },
      });
      await seed.$disconnect();
      launch("apps/api/src/main.ts");
      launch("workers/ssh-worker/src/main.ts");
      launch("apps/mcp/src/main.ts");
      await wait(`http://127.0.0.1:${port}/api/health`);
      await wait(`http://127.0.0.1:${mcpPort}/health`);
      const setup = await request("auth/setup", {
        email: "owner@example.test",
        password: "fixture-owner-password-123",
        name: "Fixture Owner",
        organization: "Integration",
        setupToken: env.SETUP_TOKEN,
      });
      expect(setup.r.status).toBe(403);
      const login = await request("auth/login", {
        email: "owner@example.test",
        password: "fixture-owner-password-123",
      });
      expect(login.r.status).toBe(201);
      cookie = login.r.headers.get("set-cookie")!.split(";")[0];
      const identity = await request("identities", {
        name: "Fixture",
        kind: "password",
        password: "nexus-fixture-only-password",
      });
      const added = await request("servers", {
        name: "Disposable Linux",
        host: "127.0.0.1",
        port: 22222,
        username: "nexus",
        identityId: identity.data.id,
        fingerprint,
        fileRoot: "/home/nexus/files",
      });
      expect(added.r.status).toBe(201);
      serverId = added.data.id;
      const agent = await request("agents", {
        name: "Integration agent",
        level: "custom",
        serverIds: [serverId],
        operations: [
          "system_info",
          "ssh_execute",
          "ssh_read_file",
          "ssh_list_directory",
        ],
        expiresInDays: 1,
      });
      token = agent.data.token;
      expect(token).toBeTruthy();
    });
    afterAll(async () => {
      for (const p of processes) p.kill();
      await new Promise((r) => setTimeout(r, 500));
      if (directory) writeFileSync(path.join(directory, "services.log"), log);
    });
    it("logs in and reads database-backed counts", async () => {
      const { data } = await request("dashboard");
      expect(data.stats.total).toBe(1);
      expect(data.stats.agents).toBe(1);
    });
    it("persists nested folders and moves without cycles or lost contents", async () => {
      const create = async (name: string, parentId: string | null = null) => {
        const result = await request("groups", { name, parentId });
        expect(result.r.status).toBe(201);
        return result.data.id as string;
      };
      const patch = (id: string, parentId: string | null) =>
        request("groups/" + id, { parentId }, undefined, "PATCH");
      const remove = (id: string) =>
        request("groups/" + id, undefined, undefined, "DELETE");
      const a = await create("Folder A"),
        b = await create("Folder B");
      const child = await create("Shared", a),
        sibling = await create("Shared", b);
      const leaf = await create("Leaf", child);
      expect((await request("groups", { name: "Folder A" })).r.status).toBe(
        409,
      );
      expect(
        (await request("groups", { name: "Shared", parentId: a })).r.status,
      ).toBe(409);
      expect((await patch(a, leaf)).r.status).toBe(400);
      expect((await patch(child, child)).r.status).toBe(400);
      expect((await patch(child, randomUUID())).r.status).toBe(400);
      expect((await patch(child, b)).r.status).toBe(409);
      expect((await patch(child, null)).r.status).toBe(200);
      const before = (await request("servers")).data.find(
        (s: any) => s.id === serverId,
      );
      expect(
        (
          await request(
            "servers/" + serverId + "/move",
            { groupId: leaf },
            undefined,
            "PATCH",
          )
        ).r.status,
      ).toBe(200);
      const moved = (await request("servers")).data.find(
        (s: any) => s.id === serverId,
      );
      expect(moved.groupId).toBe(leaf);
      expect(moved.identityId).toBe(before.identityId);
      expect(moved.host).toBe(before.host);
      expect((await remove(child)).r.status).toBe(200);
      expect(
        (await request("groups")).data.find((g: any) => g.id === leaf).parentId,
      ).toBeNull();
      expect(
        (await request("servers")).data.find((s: any) => s.id === serverId)
          .groupId,
      ).toBe(leaf);
      expect((await remove(leaf)).r.status).toBe(200);
      expect(
        (await request("servers")).data.find((s: any) => s.id === serverId)
          .groupId,
      ).toBeNull();
      await remove(sibling);
      await remove(a);
      await remove(b);
      // A same-named child can replace its deleted parent at the top level.
      const parent = await create("Same"),
        same = await create("Same", parent);
      expect((await remove(parent)).r.status).toBe(200);
      expect(
        (await request("groups")).data.find((g: any) => g.id === same).parentId,
      ).toBeNull();
      await remove(same);
    });
    it("isolates folder destinations by workspace and denies non-admin moves", async () => {
      const own = (await request("groups", { name: "Protected folder" })).data
        .id;
      const original = cookie;
      const other = await request("auth/login", {
        email: "other@example.test",
        password: "other-fixture-password-123",
      });
      cookie = other.r.headers.get("set-cookie")!.split(";")[0];
      const foreign = (await request("groups", { name: "Foreign folder" })).data
        .id;
      try {
        expect(
          (
            await request(
              "groups/" + own,
              { parentId: foreign },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(404);
        expect(
          (
            await request(
              "servers/" + serverId + "/move",
              { groupId: foreign },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(404);
        cookie = original;
        expect(
          (
            await request("groups", {
              name: "Invalid child",
              parentId: foreign,
            })
          ).r.status,
        ).toBe(400);
        expect(
          (
            await request(
              "groups/" + own,
              { parentId: foreign },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(400);
        expect(
          (
            await request(
              "servers/" + serverId + "/move",
              { groupId: foreign },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(400);
        expect(
          (await request("groups/" + own, { parentId: null }, token, "PATCH")).r
            .status,
        ).toBe(403);
        expect(
          (
            await request(
              "servers/" + serverId + "/move",
              { groupId: null },
              token,
              "PATCH",
            )
          ).r.status,
        ).toBe(403);
      } finally {
        cookie = other.r.headers.get("set-cookie")!.split(";")[0];
        await request("groups/" + foreign, undefined, undefined, "DELETE");
        cookie = original;
        await request("groups/" + own, undefined, undefined, "DELETE");
      }
    });
    it("rejects anonymous, CSRF, and internal API access", async () => {
      expect((await fetch(`http://127.0.0.1:${port}/api/servers`)).status).toBe(
        401,
      );
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/api/servers`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (await request("internal/tasks/" + randomUUID() + "/claim", {})).r
          .status,
      ).toBe(401);
    });
    it("authenticates with a real SSH password and verifies the host key", async () => {
      const { data } = await request("operations/server_test_connection", {
        serverId,
      });
      expect(data.connected).toBe(true);
      expect(data.status).toBe("completed");
    });
    it("rejects unknown and changed host keys; authenticates a real private key", async () => {
      const c = {
        host: "127.0.0.1",
        port: 22222,
        username: "nexus",
        fingerprint,
        fileRoot: "/home/nexus/files",
        credential: { privateKey },
      };
      const l = {
        cidrs: ["127.0.0.1/32"],
        connectTimeout: 3000,
        outputLimit: 1024,
      };
      await expect(connect({ ...c, fingerprint: null }, l)).rejects.toThrow(
        "fingerprint",
      );
      await expect(
        connect({ ...c, fingerprint: "SHA256:" + "A".repeat(43) }, l),
      ).rejects.toThrow();
      const client = await connect(c, l);
      client.end();
    });
    it("denies agent access outside its assigned servers and operations", async () => {
      expect(
        (
          await request(
            "operations/system_info",
            { serverId: randomUUID() },
            token,
          )
        ).r.status,
      ).toBe(404);
      expect(
        (await request("operations/system_logs", { serverId }, token)).r.status,
      ).toBe(403);
    });
    it("enforces organization isolation and expired machine credentials", async () => {
      expect(
        (await request("servers", undefined, "expired-fixture-token")).r.status,
      ).toBe(401);
      const login = await request("auth/login", {
        email: "other@example.test",
        password: "other-fixture-password-123",
      });
      const original = cookie;
      cookie = login.r.headers.get("set-cookie")!.split(";")[0];
      try {
        expect((await request("servers")).data).toHaveLength(0);
        expect(
          (await request("operations/system_info", { serverId })).r.status,
        ).toBe(404);
        expect((await request("identities")).data).toHaveLength(0);
      } finally {
        cookie = original;
      }
    });
    it("creates single-use invitations and explicit team membership", async () => {
      const invite = await request("invitations", {
        email: "invited@example.test",
        role: "viewer",
      });
      const token = new URL(invite.data.url).searchParams.get("invite");
      const details = {
        token,
        email: "invited@example.test",
        name: "Invited",
        password: "invited-fixture-password-123",
      };
      expect((await request("auth/invitation", details)).r.status).toBe(201);
      expect((await request("auth/invitation", details)).r.status).toBe(400);
      const users = await request("users"),
        user = users.data.find((u: any) => u.email === "invited@example.test");
      const team = await request("teams", {
        name: "Operations",
        userIds: [user.id],
      });
      expect(team.r.status).toBe(201);
      expect((await request("teams")).data[0].members[0].user.id).toBe(user.id);
    });
    it("polls and cancels asynchronous jobs", async () => {
      const args = {
        serverId,
        command: "sleep 20",
        async: true,
      };
      const task = await request("operations/ssh_execute", args);
      expect(task.data.status).toBe("queued");
      await request("operations/task_cancel", { taskId: task.data.taskId });
      const status = await request("operations/task_status", {
        taskId: task.data.taskId,
      });
      expect(status.data.status).toBe("cancelled");
      const repeated = await request("operations/task_cancel", {
        taskId: task.data.taskId,
      });
      expect(repeated.data.status).toBe("cancelled");
      expect(repeated.data.message).toBe("Task is already terminal");
    });
    it("executes repeated SSH commands immediately without human approval", async () => {
      const args = { serverId, command: "printf nexus-verified" };
      const results = await Promise.all([
        request("operations/ssh_execute", args, token),
        request("operations/ssh_execute", args, token),
      ]);
      for (const result of results) {
        expect(result.r.status).toBe(201);
        expect(result.data.stdout).toBe("nexus-verified");
        expect(result.data.approvalId).toBeUndefined();
      }
    });
    it("runs batches without approval while preserving batch scope and target checks", async () => {
      const args = { serverIds: [serverId], command: "printf batch-no-approval" };
      // This token has ssh_execute but not ssh_execute_many.
      expect((await request("operations/ssh_execute_many", args, token)).r.status).toBe(403);
      expect((await request("operations/ssh_execute_many", {
        ...args, serverIds: [serverId, randomUUID()],
      })).r.status).toBe(404);
      const executed = await request("operations/ssh_execute_many", args);
      expect(executed.r.status).toBe(201);
      expect(executed.data.approvalId).toBeUndefined();
      expect(executed.data.results).toEqual([
        expect.objectContaining({
          serverId, status: "success",
          result: expect.objectContaining({ stdout: "batch-no-approval" }),
        }),
      ]);
      // Legacy approval IDs cannot impersonate an old approval's principal.
      const legacy = await request("operations/ssh_execute", {
        serverId, command: "printf legacy-no-approval", approvalId: randomUUID(),
      }, token);
      expect(legacy.r.status).toBe(201);
      expect(legacy.data.stdout).toBe("legacy-no-approval");
    });
    it("browses SFTP, writes atomically, downloads and rejects symlink escapes", async () => {
      const list = await request("operations/ssh_list_directory", {
        serverId,
        path: "/home/nexus/files",
      });
      expect(list.data.entries.some((f: any) => f.name === "example.txt")).toBe(
        true,
      );
      const args = {
        serverId,
        path: "/home/nexus/files/roundtrip.txt",
        content: "SFTP roundtrip",
      };
      expect(
        (await request("operations/ssh_write_file", args)).data.atomic,
      ).toBe(true);
      const downloaded = await request("operations/ssh_download_file", {
        serverId,
        path: "/home/nexus/files/roundtrip.txt",
      });
      expect(Buffer.from(downloaded.data.content, "base64").toString()).toBe(
        "SFTP roundtrip",
      );
      expect(
        (
          await request("operations/ssh_read_file", {
            serverId,
            path: "/home/nexus/files/escape/passwd",
          })
        ).r.status,
      ).toBe(400);
      expect(
        (
          await request("operations/ssh_read_file", {
            serverId,
            path: "/home/nexus/files/../.ssh/test_key",
          })
        ).r.status,
      ).toBe(400);
    });
    it("opens a real interactive PTY and cleans up after disconnect", async () => {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/ws/terminal?serverId=${serverId}`,
          { headers: { cookie, origin } },
        );
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Terminal timed out"));
        }, 15000);
        let output = "";
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ready")
            ws.send(
              JSON.stringify({
                type: "input",
                data: "printf 'terminal-%s\\n' verified\r",
              }),
            );
          if (msg.type === "output") {
            output += Buffer.from(msg.data, "base64").toString();
            if (output.includes("terminal-verified")) {
              clearTimeout(timer);
              // An explicit disconnect ends the shell at once; a bare close
              // would leave it resumable for the grace period.
              ws.send(JSON.stringify({ type: "disconnect" }));
              ws.close();
              resolve();
            }
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        });
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(
        (await request("sessions")).data.filter(
          (s: any) => s.status === "active",
        ),
      ).toHaveLength(0);
    });
    function terminal(resume?: string) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?serverId=${serverId}` +
          (resume ? "&resume=" + resume : ""),
        { headers: { cookie, origin } },
      );
      let output = "";
      const ready = new Promise<any>((resolve, reject) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ready") resolve(msg);
          if (msg.type === "output")
            output += Buffer.from(msg.data, "base64").toString();
          if (msg.type === "error") reject(new Error(msg.message));
        });
        ws.on("error", reject);
      });
      const waitFor = async (text: string) => {
        for (let i = 0; i < 100 && !output.includes(text); i++)
          await new Promise((r) => setTimeout(r, 100));
        expect(output).toContain(text);
      };
      return { ws, ready, waitFor };
    }
    it("resumes a detached terminal and replays its output", async () => {
      const first = terminal();
      const hello = await first.ready;
      expect(hello.resumed).toBe(false);
      first.ws.send(
        JSON.stringify({
          type: "input",
          data: "sleep 1; printf 'while-%s\\n' detached\r",
        }),
      );
      first.ws.close();
      await new Promise((r) => setTimeout(r, 1800));
      expect(
        (await request("sessions")).data.filter(
          (s: any) => s.status === "active",
        ),
      ).toHaveLength(1);
      const second = terminal(hello.resume);
      const resumed = await second.ready;
      expect(resumed.resumed).toBe(true);
      expect(resumed.sessionId).toBe(hello.sessionId);
      await second.waitFor("while-detached");
      second.ws.send(JSON.stringify({ type: "disconnect" }));
      await new Promise((r) => setTimeout(r, 300));
      expect(
        (await request("sessions")).data.filter(
          (s: any) => s.status === "active",
        ),
      ).toHaveLength(0);
      // A token never resumes someone else's shell or a finished one.
      const fresh = terminal(hello.resume);
      expect((await fresh.ready).resumed).toBe(false);
      fresh.ws.send(JSON.stringify({ type: "disconnect" }));
    });
    it("serves interactive SFTP without approvals, in resumable chunks", async () => {
      const base = `http://127.0.0.1:${port}/api/sftp/${serverId}/`;
      const headers = { cookie, origin };
      const list = await request(
        `sftp/${serverId}/list?path=/home/nexus/files`,
      );
      expect(list.data.entries.some((f: any) => f.name === "example.txt")).toBe(
        true,
      );
      const write = await request(`sftp/${serverId}/write`, {
        path: "/home/nexus/files/interactive.txt",
        content: "interactive write",
      });
      expect(write.r.status).toBe(201);
      expect(
        (
          await request(
            `sftp/${serverId}/read?path=/home/nexus/files/interactive.txt`,
          )
        ).data.content,
      ).toBe("interactive write");
      const id = randomBytes(16).toString("hex"),
        body = Buffer.from("0123456789abcdef"),
        target = encodeURIComponent("/home/nexus/files/chunked.bin");
      const chunk = (offset: number, end: number) =>
        fetch(
          `${base}upload?path=${target}&uploadId=${id}&offset=${offset}&size=${body.length}`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/octet-stream" },
            body: body.subarray(offset, end),
          },
        ).then((r) => r.json());
      expect((await chunk(0, 6)).offset).toBe(6);
      const status = await fetch(
        `${base}upload?path=${target}&uploadId=${id}`,
        { headers },
      ).then((r) => r.json());
      expect(status.offset).toBe(6);
      expect((await chunk(6, body.length)).done).toBe(true);
      const downloaded = await fetch(`${base}download?path=${target}`, {
        headers,
      });
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(body);
      await request(`sftp/${serverId}/mkdir`, {
        path: "/home/nexus/files/tree",
      });
      await request(`sftp/${serverId}/write`, {
        path: "/home/nexus/files/tree/inner.txt",
        content: "inner",
      });
      const archive = Buffer.from(
        await (
          await fetch(`${base}download?path=/home/nexus/files/tree`, {
            headers,
          })
        ).arrayBuffer(),
      );
      expect([archive[0], archive[1]]).toEqual([0x1f, 0x8b]);
      expect(
        (
          await request(
            `sftp/${serverId}/read?path=/home/nexus/files/escape/passwd`,
          )
        ).r.status,
      ).toBe(400);
      const removed = await request(`sftp/${serverId}/delete`, {
        paths: [
          "/home/nexus/files/tree",
          "/home/nexus/files/interactive.txt",
          "/home/nexus/files/chunked.bin",
        ],
      });
      expect(removed.data.removed).toBe(4);
      // Agents use granted operations without approval; the browser API is human only.
      expect(
        (await request(`sftp/${serverId}/list`, undefined, token)).r.status,
      ).toBe(403);
    });
    it("shares servers with a team at the granted level", async () => {
      const created = await request("users", {
        name: "Team member",
        email: "member@example.test",
        password: "member-fixture-password-123",
        role: "operator",
      });
      const login = await request("auth/login", {
        email: "member@example.test",
        password: "member-fixture-password-123",
      });
      const owner = cookie,
        member = login.r.headers.get("set-cookie")!.split(";")[0];
      try {
        cookie = member;
        expect((await request("servers")).data).toHaveLength(0);
        cookie = owner;
        const team = await request("teams", {
          name: "Readers",
          userIds: [created.data.id],
        });
        await request("teams/" + team.data.id + "/servers", {
          servers: [
            {
              serverId,
              operations: ["server_get_info", "ssh_list_directory"],
            },
          ],
        });
        cookie = member;
        expect((await request("servers")).data).toHaveLength(1);
        expect(
          (await request(`sftp/${serverId}/list?path=/home/nexus/files`)).r
            .status,
        ).toBe(200);
        expect(
          (
            await request(`sftp/${serverId}/write`, {
              path: "/home/nexus/files/denied.txt",
              content: "no",
            })
          ).r.status,
        ).toBe(403);
      } finally {
        cookie = owner;
      }
    });
    it("does not post SSH approval notifications to the configured webhook", async () => {
      const { createServer } = await import("node:http");
      const received: any[] = [];
      const hook = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received.push(JSON.parse(body));
          res.end("ok");
        });
      });
      await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(hook.address() as any).port}/hook`;
      try {
        expect(
          (
            await request(
              "settings",
              { approvalWebhook: url },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(200);
        const pending = await request("operations/ssh_create_directory", {
          serverId,
          path: "/home/nexus/files/webhook-check",
        });
        expect(pending.r.status).toBe(201);
        expect(pending.data.approvalId).toBeUndefined();
        expect(received).toEqual([]);
      } finally {
        await request("settings", { approvalWebhook: "" }, undefined, "PATCH");
        hook.close();
      }
    });
    it("caps agent calls per minute", async () => {
      const agent = await request("agents", {
        name: "Capped agent",
        level: "custom",
        serverIds: [serverId],
        operations: ["server_test_connection"],
        expiresInDays: 1,
        maxCallsPerMinute: 1,
      });
      const call = () =>
        request(
          "operations/server_test_connection",
          { serverId },
          agent.data.token,
        );
      expect((await call()).r.status).toBe(201);
      const limited = await call();
      expect(limited.r.status).toBe(429);
      expect(limited.data.message).toContain("call limit");
    });
    it("keeps unsent server fields on a partial update", async () => {
      const before = (await request("servers")).data[0];
      const patched = await request(
        "servers/" + serverId,
        { description: "partial update" },
        undefined,
        "PATCH",
      );
      expect(patched.r.status).toBe(200);
      const after = (await request("servers")).data[0];
      expect(after.description).toBe("partial update");
      expect([
        after.host,
        after.port,
        after.fingerprint,
        after.fileRoot,
      ]).toEqual([
        before.host,
        before.port,
        before.fingerprint,
        before.fileRoot,
      ]);
    });
    it("signs in once with each two-factor recovery code", async () => {
      await request("users", {
        name: "MFA user",
        email: "mfa@example.test",
        password: "mfa-fixture-password-123",
        role: "viewer",
      });
      const owner = cookie;
      const credentials = {
        email: "mfa@example.test",
        password: "mfa-fixture-password-123",
      };
      try {
        cookie = (await request("auth/login", credentials)).r.headers
          .get("set-cookie")!
          .split(";")[0];
        const prepared = await request("auth/mfa/prepare", {});
        const { totp } = await import("../../apps/api/src/totp.js");
        const enabled = await request("auth/mfa/enable", {
          challenge: prepared.data.challenge,
          code: totp(prepared.data.secret, Math.floor(Date.now() / 30000)),
        });
        const codes: string[] = enabled.data.recoveryCodes;
        expect(codes).toHaveLength(10);
        expect((await request("auth/login", credentials)).r.status).toBe(401);
        expect(
          (await request("auth/login", { ...credentials, code: codes[0] })).r
            .status,
        ).toBe(201);
        expect(
          (await request("auth/login", { ...credentials, code: codes[0] })).r
            .status,
        ).toBe(401);
      } finally {
        cookie = owner;
      }
    });
    it("manages workspace resources through real MCP tools without exposing stored credentials", async () => {
      const registered = await request("agents", {
        name: "Workspace manager",
        level: "administrator",
        workspaceManagement: true,
        serverIds: [],
        operations: ["server_get_info", "server_test_connection"],
        expiresInDays: 1,
      });
      expect(registered.r.status).toBe(201);
      const managerToken = registered.data.token;
      const c = new Client({ name: "workspace-test", version: "1.0.0" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(env.MCP_PUBLIC_URL!), {
          requestInit: { headers: { authorization: "Bearer " + managerToken } },
        }),
      );
      const call = async (name: string, args: any = {}) => {
        const result: any = await c.callTool({ name, arguments: args });
        expect(result.isError, name + ": " + result.content?.[0]?.text).toBe(
          false,
        );
        return JSON.parse(result.content[0].text);
      };
      try {
        const tools = (await c.listTools()).tools.map((t) => t.name);
        expect(tools).toEqual(
          expect.arrayContaining([
            "identity_create",
            "vpn_profile_create",
            "folder_create",
            "server_create",
            "agent_update_access",
            "team_set_servers",
            "settings_update",
          ]),
        );
        expect(tools).not.toContain("approval_decide");
        const root = await call("folder_create", { name: "MCP Root" });
        const child = await call("folder_create", {
          name: "MCP Child",
          parentId: root.id,
        });
        expect(
          (await call("folders_list")).items.find((g: any) => g.id === child.id)
            .parentId,
        ).toBe(root.id);
        const cycle: any = await c.callTool({
          name: "folder_update",
          arguments: { id: root.id, parentId: child.id },
        });
        expect(cycle.isError).toBe(true);
        const identity = await call("identity_create", {
          name: "MCP SSH key",
          kind: "key",
          privateKey,
        });
        await call("identity_update", {
          id: identity.id,
          name: "MCP Rotated key",
          kind: "key",
          privateKey,
        });
        expect(JSON.stringify(await call("identities_list"))).not.toContain(
          privateKey,
        );
        const disposable = await call("identity_create", {
          name: "Unused",
          kind: "password",
          password: "not-a-real-password",
        });
        await call("identity_delete", { id: disposable.id });
        const wgKey = randomBytes(32).toString("base64");
        const vpn = await call("vpn_profile_create", {
          name: "MCP VPN",
          description: "Keep description",
          config: `[Interface]\nPrivateKey = ${wgKey}\nAddress = 10.79.0.2/32\nListenPort = 0\n[Peer]\nPublicKey = ${wgKey}\nEndpoint = 127.0.0.1:51820\nAllowedIPs = 10.79.0.0/24`,
        });
        const updatedVpn = await call("vpn_profile_update", {
          id: vpn.id,
          changes: { name: "Renamed MCP VPN" },
        });
        expect(updatedVpn.description).toBe("Keep description");
        expect(JSON.stringify(await call("vpn_profiles_list"))).not.toContain(
          wgKey,
        );
        const created = await call("server_create", {
          name: "MCP provisioned SSH",
          host: "127.0.0.1",
          port: 22222,
          username: "nexus",
          identityId: identity.id,
          fingerprint,
          fileRoot: "/home/nexus/files",
          groupId: child.id,
          vpnProfileId: vpn.id,
        });
        expect(created.vpnProfileId).toBe(vpn.id);
        expect(
          (await call("workspace_servers_list")).servers.some(
            (s: any) => s.id === created.id,
          ),
        ).toBe(true);
        await call("server_update", {
          id: created.id,
          changes: { vpnProfileId: null, description: "Updated through MCP" },
        });
        expect(
          (await call("server_test_connection", { serverId: created.id }))
            .connected,
        ).toBe(true);
        expect(
          (
            await call("server_scan_host_key", {
              host: "127.0.0.1",
              port: 22222,
            })
          ).fingerprint,
        ).toBe(fingerprint);
        await call("server_move", { id: created.id, groupId: root.id });
        await call("folder_update", {
          id: child.id,
          name: "Moved child",
          parentId: null,
        });
        // A copy cannot keep the same host and port in the same folder.
        const sameAddress: any = await c.callTool({ name: "server_duplicate", arguments: { id: created.id } });
        expect(sameAddress.isError).toBe(true);
        expect(sameAddress.content?.[0]?.text).toContain("already exists in this folder");
        const duplicate = await call("server_duplicate", { id: created.id, host: "127.0.0.2" });
        expect(duplicate.host).toBe("127.0.0.2");
        expect(duplicate.fingerprint).toBeNull();
        await call("server_archive", { id: duplicate.id });
        // Archiving is deletion, so the same address can be added to the folder again.
        const readded = await call("server_duplicate", { id: created.id, host: "127.0.0.2" });
        await call("server_archive", { id: readded.id });
        const user = await call("user_create", {
          name: "MCP Viewer",
          email: "mcp-viewer@example.test",
          password: "mcp-viewer-password-12345",
          role: "viewer",
        });
        await call("user_update", {
          id: user.id,
          role: "viewer",
          disabled: true,
        });
        await call("user_set_permissions", {
          id: user.id,
          serverId: created.id,
          operations: ["server_get_info"],
        });
        expect(
          (await call("users_list")).items.some((u: any) => u.id === user.id),
        ).toBe(true);
        const team = await call("team_create", {
          name: "MCP team",
          userIds: [user.id],
        });
        await call("team_update", {
          id: team.id,
          name: "MCP team renamed",
          userIds: [],
        });
        await call("team_set_servers", {
          id: team.id,
          servers: [{ serverId: created.id, operations: ["server_get_info"] }],
        });
        expect(
          (await call("teams_list")).items.find((t: any) => t.id === team.id)
            .servers,
        ).toHaveLength(1);
        await call("team_delete", { id: team.id });
        expect(
          (
            await call("invitation_create", {
              email: "mcp-invite@example.test",
              role: "viewer",
            })
          ).url,
        ).toContain("invite=");
        const childAgent = await call("agent_create", {
          name: "MCP child agent",
          level: "custom",
          serverIds: [created.id],
          operations: ["server_get_info"],
          workspaceManagement: false,
        });
        expect(childAgent.token).toBeTruthy();
        await call("agent_update_access", {
          id: childAgent.agent.id,
          level: "custom",
          serverIds: [],
          operations: [],
          workspaceManagement: false,
        });
        await call("agent_update_limits", {
          id: childAgent.agent.id,
          maxCallsPerMinute: 5,
        });
        expect(JSON.stringify(await call("agents_list"))).not.toContain(
          childAgent.token,
        );
        await call("agent_revoke", { id: childAgent.agent.id });
        const settings = await call("settings_get");
        await call("settings_update", {
          acceptNewHostKeys: settings.acceptNewHostKeys,
        });
        const snippet = await call("snippet_create", {
          name: "MCP snippet",
          command: "uname -a",
        });
        expect(
          (await call("snippets_list")).items.some(
            (s: any) => s.id === snippet.id,
          ),
        ).toBe(true);
        await call("snippet_delete", { id: snippet.id });
        await call("sessions_list");
        await call("approvals_list");
        await call("workspace_overview");
        const audit = await call("audit_list", { action: "mcp:" });
        expect(audit.items.length).toBeGreaterThan(0);
        expect(JSON.stringify(audit)).not.toContain(privateKey);
        expect(JSON.stringify(audit)).not.toContain(wgKey);
        expect(
          (
            await call("agent_activity", { id: registered.data.agent.id })
          ).items.some((r: any) => r.operation === "identity_create"),
        ).toBe(true);
        // Human approval cannot be supplied by a workspace-management token.
        expect(
          (
            await request(
              "approvals/" + randomUUID(),
              { decision: "approved" },
              managerToken,
            )
          ).r.status,
        ).toBe(403);
        await call("server_archive", { id: created.id });
        await call("vpn_profile_delete", { id: vpn.id });
        await call("folder_delete", { id: root.id });
        await call("folder_delete", { id: child.id });
      } finally {
        await c.close();
        await request(
          "agents/" + registered.data.agent.id,
          {},
          undefined,
          "DELETE",
        );
      }
    });
    it("requires explicit management access and honors removal, owner roles, workspace isolation and budgets", async () => {
      const registered = await request("agents", {
        name: "Scoped manager",
        level: "custom",
        serverIds: [],
        operations: [],
      });
      const agentId = registered.data.agent.id,
        auth = registered.data.token;
      expect((await request("groups", { name: "Denied" }, auth)).r.status).toBe(
        403,
      );
      const access = {
        level: "custom",
        serverIds: [],
        operations: [],
        workspaceManagement: true,
      };
      expect(
        (
          await request(
            "agents/" + agentId + "/access",
            access,
            undefined,
            "PATCH",
          )
        ).r.status,
      ).toBe(200);
      expect((await request("groups", undefined, auth)).r.status).toBe(200);
      const other = await request("auth/login", {
        email: "other@example.test",
        password: "other-fixture-password-123",
      });
      const original = cookie;
      cookie = other.r.headers.get("set-cookie")!.split(";")[0];
      const foreign = (await request("groups", { name: "Foreign MCP folder" }))
        .data.id;
      cookie = original;
      try {
        expect(
          (
            await request(
              "groups/" + foreign,
              { name: "Wrong workspace" },
              auth,
              "PATCH",
            )
          ).r.status,
        ).toBe(404);
        expect(
          (
            await request(
              "groups",
              { name: "Wrong child", parentId: foreign },
              auth,
            )
          ).r.status,
        ).toBe(400);
        await request(
          "agents/" + agentId + "/limits",
          { maxCallsPerMinute: 1 },
          undefined,
          "PATCH",
        );
        expect((await request("groups", undefined, auth)).r.status).toBe(429);
        await request(
          "agents/" + agentId + "/limits",
          { maxCallsPerMinute: null },
          undefined,
          "PATCH",
        );
        await request(
          "agents/" + agentId + "/access",
          { ...access, workspaceManagement: false },
          undefined,
          "PATCH",
        );
        expect((await request("groups", undefined, auth)).r.status).toBe(403);
        expect(
          (
            await request(
              "agents/" + agentId + "/access",
              { ...access, level: "viewer" },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(400);
        const check = new PrismaClient({
          datasources: { db: { url: env.DATABASE_URL } },
        });
        try {
          await request(
            "agents/" + agentId + "/access",
            access,
            undefined,
            "PATCH",
          );
          const row = await check.agent.findUniqueOrThrow({
            where: { id: agentId },
          });
          await check.user.update({
            where: { id: row.ownerId },
            data: { role: "operator" },
          });
          try {
            expect((await request("groups", undefined, auth)).r.status).toBe(
              403,
            );
          } finally {
            await check.user.update({
              where: { id: row.ownerId },
              data: { role: "owner" },
            });
          }
        } finally {
          await check.$disconnect();
        }
      } finally {
        cookie = other.r.headers.get("set-cookie")!.split(";")[0];
        await request("groups/" + foreign, undefined, undefined, "DELETE");
        cookie = original;
        await request("agents/" + agentId, {}, undefined, "DELETE");
      }
    });
    it("serves modern 2026-07-28 and legacy clients over real HTTP sockets", async () => {
      for (const mode of ["auto", "legacy"] as const) {
        const c = new Client(
          { name: "integration-client", version: "1.0.0" },
          { versionNegotiation: { mode } },
        );
        await c.connect(
          new StreamableHTTPClientTransport(new URL(env.MCP_PUBLIC_URL!), {
            requestInit: { headers: { authorization: "Bearer " + token } },
          }),
        );
        expect(c.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
        const advertised = (await c.listTools()).tools;
        for (const name of ["ssh_execute", "ssh_execute_many", "ssh_write_file", "service_restart"]) {
          const tool = advertised.find((t) => t.name === name);
          expect(tool?.description).not.toContain("Requires an exact, single-use human approval");
          expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        }
        const listed: any = await c.callTool({
          name: "servers_list",
          arguments: {},
        });
        expect(JSON.parse(listed.content[0].text).servers).toHaveLength(1);
        const info: any = await c.callTool({
          name: "system_info",
          arguments: { serverId },
        });
        expect(info.isError).toBe(false);
        expect(JSON.parse(info.content[0].text).stdout).toContain("Linux");
        const executed: any = await c.callTool({
          name: "ssh_execute",
          arguments: { serverId, command: "printf mcp-real-ssh" },
        });
        expect(executed.isError).toBe(false);
        expect(JSON.parse(executed.content[0].text).approvalId).toBeUndefined();
        expect(JSON.parse(executed.content[0].text).stdout).toBe(
          "mcp-real-ssh",
        );
        const file: any = await c.callTool({
          name: "ssh_read_file",
          arguments: { serverId, path: "/home/nexus/files/example.txt" },
        });
        expect(JSON.parse(file.content[0].text).content).toContain(
          "fixture content",
        );
        await c.close();
      }
    });
    it("rejects anonymous and revoked MCP credentials", async () => {
      expect(
        (await fetch(env.MCP_PUBLIC_URL!, { method: "POST" })).status,
      ).toBe(401);
      const agents = await request("agents");
      await request("agents/" + agents.data[0].id, {}, undefined, "DELETE");
      expect((await request("servers", undefined, token)).r.status).toBe(401);
      expect(
        (
          await fetch(env.MCP_PUBLIC_URL!, {
            headers: { authorization: "Bearer " + token },
          })
        ).status,
      ).toBe(401);
    });
    it("enforces timeout and output bounds on the real remote shell", async () => {
      const c = {
          host: "127.0.0.1",
          port: 22222,
          username: "nexus",
          fingerprint,
          fileRoot: "/home/nexus/files",
          credential: { privateKey },
        },
        l = { cidrs: ["127.0.0.1/32"], connectTimeout: 3000, outputLimit: 32 };
      const result = await operate(c, l, "ssh_execute", {
        command: "printf %0100d 1",
        timeoutMs: 3000,
      });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBe(32);
      await expect(
        operate(c, l, "ssh_execute", { command: "sleep 3", timeoutMs: 100 }),
      ).rejects.toThrow("timed out");
    });
    it("uses the VPN transport for SSH, host-key scans and SSH bastions", async () => {
      // This adapter isolates the Node transport from WireGuard itself (tested
      // with two real encrypted peers in the Go suite). SSH is the real fixture.
      let tunnels = 0;
      const sockets = new Set<Socket>();
      const gateway = createServer((req, res) => {
        if (req.headers["x-nexus-internal"] !== env.INTERNAL_SECRET) {
          res.writeHead(401).end();
          return;
        }
        req.resume();
        req.on("end", () => res.writeHead(204).end());
      });
      gateway.on("connect", (req, socket, head) => {
        if (
          req.headers["x-nexus-internal"] !== env.INTERNAL_SECRET ||
          req.url !== "127.0.0.1:22222"
        ) {
          socket.destroy();
          return;
        }
        tunnels++;
        const upstream = tcpConnect(22222, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        sockets.add(upstream);
        sockets.add(socket as Socket);
        socket.on("close", () => {
          upstream.destroy();
          sockets.delete(socket as Socket);
        });
        upstream.on("close", () => {
          socket.destroy();
          sockets.delete(upstream);
        });
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
      });
      await new Promise<void>((resolve) =>
        gateway.listen(0, "127.0.0.1", resolve),
      );
      const address = gateway.address() as { port: number };
      const limits = {
        cidrs: ["127.0.0.1/32"],
        connectTimeout: 5000,
        outputLimit: 1024,
        vpnGateway: {
          url: `http://127.0.0.1:${address.port}`,
          secret: env.INTERNAL_SECRET!,
        },
      };
      const vpn = {
        id: randomUUID(),
        config: {
          privateKey: randomBytes(32).toString("base64"),
          addresses: ["10.77.0.2/32"],
          dns: [],
          mtu: 1420,
          peers: [],
        },
      };
      const c = {
        host: "127.0.0.1",
        port: 22222,
        username: "nexus",
        fingerprint,
        fileRoot: "/home/nexus/files",
        credential: { privateKey },
        vpn,
      };
      try {
        expect(await scanHostKey(c.host, c.port, limits, { vpn })).toBe(
          fingerprint,
        );
        expect(
          (await operate(c, limits, "server_test_connection", {})).connected,
        ).toBe(true);
        expect(
          (
            await operate(
              { ...c, port: 22, bastion: c },
              limits,
              "system_info",
              {},
            )
          ).stdout,
        ).toContain("Linux");
        expect(tunnels).toBe(3);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
      }
    });
    it("stores VPN secrets encrypted, scopes profiles, and preserves server selections", async () => {
      const key = randomBytes(32).toString("base64");
      const config = `[Interface]\nPrivateKey = ${key}\nAddress = 10.77.0.2/32\n[Peer]\nPublicKey = ${key}\nEndpoint = 127.0.0.1:51820\nAllowedIPs = 10.77.0.0/24`;
      const created = await request("vpn-profiles", {
        name: "Test VPN",
        config,
      });
      expect(created.r.status).toBe(201);
      const profileId = created.data.id;
      expect(JSON.stringify(created.data)).not.toContain(key);
      const check = new PrismaClient({
        datasources: { db: { url: env.DATABASE_URL } },
      });
      try {
        const stored = await check.vpnProfile.findUniqueOrThrow({
          where: { id: profileId },
        });
        expect(stored.encryptedConfig).not.toContain(key);
        expect(
          JSON.stringify((await request("vpn-profiles")).data),
        ).not.toContain(key);
        expect(
          (
            await request(
              "servers/" + serverId,
              { vpnProfileId: profileId },
              undefined,
              "PATCH",
            )
          ).r.status,
        ).toBe(200);
        const patched = await request(
          "servers/" + serverId,
          { description: "VPN selection preserved" },
          undefined,
          "PATCH",
        );
        expect(patched.data.vpnProfileId).toBe(profileId);
        expect(
          (
            await request(
              "vpn-profiles/" + profileId,
              undefined,
              undefined,
              "DELETE",
            )
          ).r.status,
        ).toBe(400);
        const other = await request("auth/login", {
          email: "other@example.test",
          password: "other-fixture-password-123",
        });
        const otherCookie = other.r.headers.get("set-cookie")!.split(";")[0];
        const response = await fetch(
          `http://127.0.0.1:${port}/api/vpn-profiles/${profileId}`,
          {
            method: "PATCH",
            headers: {
              cookie: otherCookie,
              origin,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Wrong owner" }),
          },
        );
        expect(response.status).toBe(404);
        const rename = await request(
          "vpn-profiles/" + profileId,
          { name: "Renamed VPN" },
          undefined,
          "PATCH",
        );
        expect(rename.r.status).toBe(200);
        expect(
          (
            await check.vpnProfile.findUniqueOrThrow({
              where: { id: profileId },
            })
          ).encryptedConfig,
        ).toBe(stored.encryptedConfig);
      } finally {
        await request(
          "servers/" + serverId,
          { vpnProfileId: null, description: "" },
          undefined,
          "PATCH",
        );
        await request(
          "vpn-profiles/" + profileId,
          undefined,
          undefined,
          "DELETE",
        );
        await check.$disconnect();
      }
      expect(
        (
          await request(
            "servers/" + serverId,
            { vpnProfileId: randomUUID() },
            undefined,
            "PATCH",
          )
        ).r.status,
      ).toBe(400);
    });
    it("does not fall back to a direct SSH connection when a selected VPN fails", async () => {
      await expect(
        connect(
          {
            host: "127.0.0.1",
            port: 22222,
            username: "nexus",
            fingerprint,
            fileRoot: "/home/nexus",
            credential: { privateKey },
            vpn: {
              id: randomUUID(),
              config: {
                privateKey: randomBytes(32).toString("base64"),
                addresses: ["10.77.0.2/32"],
                dns: [],
                mtu: 1420,
                peers: [],
              },
            },
          },
          {
            cidrs: ["127.0.0.1/32"],
            connectTimeout: 1000,
            outputLimit: 1024,
            vpnGateway: { url: "http://127.0.0.1:1", secret: "test" },
          },
        ),
      ).rejects.toThrow();
    });
    it("backs up live WAL consistently and restores a verified copy", () => {
      const backup = path.join(directory, "backup.db"),
        restored = path.join(directory, "restored.db");
      execFileSync("python", [
        "infrastructure/scripts/backup.py",
        "backup",
        "--database",
        path.join(directory, "test.db"),
        "--backup",
        backup,
      ]);
      execFileSync("python", [
        "infrastructure/scripts/backup.py",
        "restore",
        "--database",
        restored,
        "--backup",
        backup,
        "--api-stopped",
      ]);
      expect(readFileSync(backup).length).toBeGreaterThan(0);
      // Earlier tests add servers, so compare against the live database rather than a fixed count.
      const servers = (file: string) =>
        execFileSync(
          "python",
          [
            "-c",
            `import sqlite3; c=sqlite3.connect(r'${file}'); print(c.execute('select count(*) from Server').fetchone()[0])`,
          ],
          { encoding: "utf8" },
        ).trim();
      const live = servers(path.join(directory, "test.db"));
      expect(Number(live)).toBeGreaterThan(0);
      expect(servers(restored)).toBe(live);
    });
  },
);
