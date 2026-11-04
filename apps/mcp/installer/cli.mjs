#!/usr/bin/env node
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { bridge } from "./bridge.mjs";
import {
  PACKAGE,
  VERSION,
  clients,
  detected,
  install,
  uninstall,
} from "./clients.mjs";

const usage = `NexusSSH MCP installer ${VERSION}

Usage:
  npx ${PACKAGE} [install] --url <endpoint>   Add NexusSSH to your AI clients
  npx ${PACKAGE} uninstall                    Remove it again
  npx ${PACKAGE} list                         Show supported and detected clients
  npx ${PACKAGE} bridge --url <endpoint>      stdio bridge (token in NEXUSSSH_TOKEN)

Options:
  --url <endpoint>     MCP endpoint from Settings → MCP Server, e.g. https://nexus.example.com/mcp
  --token <token>      Agent token (prompted when omitted; NEXUSSSH_TOKEN also works)
  --clients <ids>      Comma-separated client ids instead of every detected client
  --name <name>        Server name in client configs (default: nexusssh)
  --yes, -y            Configure every detected client without asking
  --skip-verify        Do not test the token against the endpoint first
  --help, -h           Show this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    clients: { type: "string" },
    name: { type: "string", default: "nexusssh" },
    yes: { type: "boolean", short: "y" },
    "skip-verify": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const command = positionals[0] || "install";
const tty = process.stdin.isTTY && process.stdout.isTTY;
const pretty = (path) => path.replace(homedir(), "~");
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

function ask(question, hidden = false) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let muted = false;
  // Keep a pasted token off the screen; only the line break is echoed.
  rl._writeToOutput = (s) => {
    if (!muted) process.stdout.write(s);
    else if (s.includes("\n")) process.stdout.write("\n");
  };
  const answer = new Promise((resolve) => rl.question(question, resolve));
  muted = hidden;
  return answer.then((value) => {
    rl.close();
    return value.trim();
  });
}

function endpoint(raw) {
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    fail(`"${raw}" is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    fail("The endpoint must use http or https.");
  if (url.pathname === "/" || !url.pathname) url.pathname = "/mcp";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local)
    console.warn(
      "! This endpoint uses plain HTTP, so the token travels unencrypted. Prefer HTTPS.",
    );
  return url.toString();
}

async function verify(url, token) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: PACKAGE, version: VERSION },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    await res.body?.cancel();
  } catch (e) {
    return `could not reach ${url} (${e.cause?.code || e.message})`;
  }
  if (res.ok) return null;
  if (res.status === 401) return "the token was rejected (HTTP 401)";
  if (res.status === 403)
    return "access was denied (HTTP 403). Check the token, and that the URL matches the server's public MCP address";
  if (res.status === 404)
    return "nothing answered at that path (HTTP 404). Copy the endpoint from Settings → MCP Server";
  return `the endpoint answered HTTP ${res.status}`;
}

function select(all) {
  if (!opts.clients) return null;
  const ids = opts.clients.split(",").map((id) => id.trim());
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length)
    fail(
      `Unknown client ${unknown.join(", ")}. Run "npx ${PACKAGE} list" for ids.`,
    );
  return all.filter((c) => ids.includes(c.id));
}

async function choose(all, picked) {
  if (picked) return picked;
  const found = all.filter(detected);
  if (!found.length)
    fail(
      `No supported AI clients were found. Pass --clients (see "npx ${PACKAGE} list").`,
    );
  if (opts.yes || !tty) return found;
  console.log("\nDetected AI clients:");
  found.forEach((c, i) =>
    console.log(`  ${i + 1}. ${c.label.padEnd(18)} ${pretty(c.file)}`),
  );
  const missing = all.filter((c) => !found.includes(c));
  if (missing.length)
    console.log(`Not found: ${missing.map((c) => c.label).join(", ")}`);
  const answer = await ask(
    "\nConfigure which? Press Enter for all, or list numbers (e.g. 1,3): ",
  );
  if (!answer) return found;
  const picks = answer.split(/[\s,]+/).map(Number);
  if (picks.some((n) => !found[n - 1])) fail("That selection is not in the list.");
  return [...new Set(picks)].map((n) => found[n - 1]);
}

async function run() {
  if (opts.help) return console.log(usage);
  if (!/^[A-Za-z0-9_-]+$/.test(opts.name))
    fail("--name may contain only letters, digits, - and _.");
  const all = clients();

  if (command === "list") {
    for (const c of all)
      console.log(
        `${detected(c) ? "●" : "○"} ${c.id.padEnd(16)} ${c.label.padEnd(18)} ${pretty(c.file)}`,
      );
    return console.log("\n● detected  ○ not found");
  }

  if (command === "bridge") {
    const token = process.env.NEXUSSSH_TOKEN || opts.token;
    const url = opts.url || process.env.NEXUSSSH_URL;
    if (!url || !token)
      fail("bridge needs --url and the NEXUSSSH_TOKEN environment variable.");
    return bridge({ url, token });
  }

  if (command === "uninstall") {
    let removed = 0;
    for (const c of select(all) || all.filter(detected)) {
      try {
        const r = await uninstall(c, opts.name);
        if (!r) continue;
        removed++;
        console.log(`✓ ${c.label}: removed (${r.via || pretty(r.file)})`);
      } catch (e) {
        console.error(`✗ ${c.label}: ${e.message}`);
      }
    }
    return console.log(
      removed ? "\nRestart your clients to finish." : `No "${opts.name}" entries found.`,
    );
  }

  if (command !== "install") fail(`Unknown command "${command}".\n\n${usage}`);

  const picked = select(all);
  console.log(`NexusSSH MCP installer ${VERSION}\n`);
  if (!opts.url && !tty) fail("Pass --url when running without a terminal.");
  const url = endpoint(
    opts.url || (await ask("MCP endpoint (Settings → MCP Server): ")),
  );
  if (opts.token)
    console.warn("! --token is saved in your shell history; prefer the prompt.");
  let token = opts.token || process.env.NEXUSSSH_TOKEN;
  if (!token) {
    if (!tty) fail("Set NEXUSSSH_TOKEN or pass --token without a terminal.");
    token = await ask("Agent token (input hidden): ", true);
  }
  if (!token) fail("An agent token is required. Create one under Settings → AI Agents.");

  if (!opts["skip-verify"]) {
    process.stdout.write("Checking the token… ");
    const problem = await verify(url, token);
    if (problem) {
      console.log("failed");
      fail(`${problem[0].toUpperCase()}${problem.slice(1)}. Use --skip-verify to install anyway.`);
    }
    console.log("ok");
  }

  const targets = await choose(all, picked);
  console.log("");
  const setup = { name: opts.name, url, token };
  let failed = 0;
  for (const c of targets) {
    try {
      const r = await install(c, setup);
      const where = r.via || pretty(r.file);
      console.log(`✓ ${c.label}: ${where}`);
      if (r.backup) console.log(`    previous file saved as ${pretty(r.backup)}`);
      if (r.comments) console.log("    comments in that file were not preserved");
    } catch (e) {
      failed++;
      console.error(`✗ ${c.label}: ${e.message}`);
    }
  }
  console.log(
    `\nRestart your AI clients to load "${opts.name}". The token is stored in each client's configuration,\n` +
      "so revoke it under Settings → AI Agents if this machine is lost or shared.",
  );
  if (failed) process.exitCode = 1;
}

run().catch((e) => fail(e.message));
