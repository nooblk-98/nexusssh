import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import {
  bridgeEntry,
  clients,
  install,
  locations,
  parseJsonc,
  removeTomlServer,
  setJsonServer,
  setTomlServer,
  uninstall,
} from "../../apps/mcp/installer/clients.mjs";
import { bridge } from "../../apps/mcp/installer/bridge.mjs";

const setup = {
  name: "nexusssh",
  url: "https://nexus.example.com/mcp",
  token: 'tok"en',
};
let dir = "";
let server: Server | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  server?.close();
  dir = "";
  server = undefined;
});

describe("MCP installer configuration", () => {
  it("parses JSONC without touching comment markers inside strings", () => {
    const { value, comments } = parseJsonc(
      '﻿// note\n{ "a": "https://x//y", /* c */ "b": [1, 2,], }\n',
    );
    expect(value).toEqual({ a: "https://x//y", b: [1, 2] });
    expect(comments).toBe(true);
    expect(parseJsonc("").value).toEqual({});
  });

  it("adds the server beside existing entries and replaces its own", () => {
    const entry = { url: setup.url };
    const first = setJsonServer('{"mcpServers":{"other":{}}}', "mcpServers", "nexusssh", entry);
    const again = setJsonServer(first.text, "mcpServers", "nexusssh", { url: "new" });
    expect(JSON.parse(again.text).mcpServers).toEqual({
      other: {},
      nexusssh: { url: "new" },
    });
    expect(() => setJsonServer("[]", "mcpServers", "nexusssh", entry)).toThrow();
  });

  it("rewrites only the named Codex table and its subtables", () => {
    const text =
      'model = "o3"\n[mcp_servers.nexusssh]\nurl = "old"\n[mcp_servers.nexusssh.env]\nA = "1"\n[mcp_servers.other]\ncommand = "x"\n';
    const next = setTomlServer(text, "nexusssh", setup);
    expect(next).not.toContain("old");
    expect(next).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(next).toContain(
      'http_headers = { Authorization = "Bearer tok\\"en" }',
    );
    expect(removeTomlServer(next, "nexusssh")).not.toContain("nexusssh");
  });

  it("runs Claude Desktop through the pinned stdio bridge", () => {
    const posix = bridgeEntry(setup, "linux");
    expect(posix.command).toBe("npx");
    expect(posix.args).toContain("bridge");
    expect(posix.args.find((a: string) => a.startsWith("nexusssh-mcp@"))).toMatch(/@\d+\.\d+\.\d+$/);
    expect(posix.env).toEqual({ NEXUSSSH_TOKEN: setup.token });
    expect(bridgeEntry(setup, "win32").args.slice(0, 2)).toEqual(["/c", "npx"]);
  });

  it("writes every client's file and removes the entries again", async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-installer-"));
    const loc = locations({ APPDATA: join(dir, "AppData") }, "win32", dir);
    const all = clients(loc);
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor", "mcp.json"), '{"mcpServers":{"keep":{}}}');
    for (const c of all) await install(c, setup, { cli: false });
    const cursor = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.nexusssh.headers.Authorization).toBe(`Bearer ${setup.token}`);
    expect(cursor.mcpServers.keep).toEqual({});
    const vscode = all.find((c) => c.id === "vscode")!;
    expect(JSON.parse(await readFile(vscode.file, "utf8")).servers.nexusssh.type).toBe("http");
    for (const c of all) expect(await uninstall(c, "nexusssh", { cli: false })).not.toBeNull();
    for (const c of all) expect(await uninstall(c, "nexusssh", { cli: false })).toBeNull();
    expect(
      JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers,
    ).toEqual({ keep: {} });
  });
});

describe("MCP stdio bridge", () => {
  it("relays JSON and event-stream responses and reports HTTP failures", async () => {
    const seen: Array<string | undefined> = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(req.headers["mcp-protocol-version"] as string | undefined);
        if (req.headers.authorization !== "Bearer good") return res.writeHead(401).end();
        const msg = JSON.parse(body);
        if (msg.method === "initialize")
          return res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "t" } } }));
        if (!("id" in msg)) return res.writeHead(202).end();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } })}\n\n`);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
    const run = async (token: string, lines: unknown[]) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.on("data", (c) => (text += c));
      const done = bridge({ url, token, input, output, log: () => {} });
      for (const line of lines) {
        input.write(JSON.stringify(line) + "\n");
        await new Promise((r) => setTimeout(r, 50));
      }
      input.end();
      await done;
      return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    };
    const out = await run("good", [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[1].result).toEqual({ ok: true });
    expect(seen).toEqual([undefined, "2025-06-18", "2025-06-18"]);
    const denied = await run("bad", [{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
    expect(denied[0]).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(denied[0].error.message).toContain("401");
  });
});
