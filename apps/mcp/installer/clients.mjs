import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const PACKAGE = "nexusssh-mcp";
export const VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// Base directories each client resolves its user-level configuration from.
export function locations(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const appData =
    platform === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : xdg;
  return {
    home,
    appData,
    xdg,
    codex: env.CODEX_HOME || join(home, ".codex"),
    platform,
  };
}

const bearer = (s) => ({ Authorization: `Bearer ${s.token}` });

// Claude Desktop only launches local stdio servers from its config file, so it
// runs this package's bridge, which forwards to the HTTP endpoint.
export function bridgeEntry(s, platform) {
  const args = ["-y", `${PACKAGE}@${VERSION}`, "bridge", "--url", s.url];
  return {
    ...(platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", ...args] }
      : { command: "npx", args }),
    env: { NEXUSSSH_TOKEN: s.token },
  };
}

export function clients(loc = locations()) {
  const code = (product) => join(loc.appData, product, "User");
  const cline = join(
    code("Code"),
    "globalStorage",
    "saoudrizwan.claude-dev",
  );
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: join(loc.home, ".claude.json"),
      detect: [join(loc.home, ".claude.json"), join(loc.home, ".claude")],
      key: "mcpServers",
      cli: true,
      entry: (s) => ({ type: "http", url: s.url, headers: bearer(s) }),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      file: join(loc.appData, "Claude", "claude_desktop_config.json"),
      detect: [join(loc.appData, "Claude")],
      key: "mcpServers",
      entry: (s) => bridgeEntry(s, loc.platform),
    },
    {
      id: "cursor",
      label: "Cursor",
      file: join(loc.home, ".cursor", "mcp.json"),
      detect: [join(loc.home, ".cursor")],
      key: "mcpServers",
      entry: (s) => ({ url: s.url, headers: bearer(s) }),
    },
    {
      id: "vscode",
      label: "VS Code",
      file: join(code("Code"), "mcp.json"),
      detect: [code("Code")],
      key: "servers",
      entry: (s) => ({ type: "http", url: s.url, headers: bearer(s) }),
    },
    {
      id: "vscode-insiders",
      label: "VS Code Insiders",
      file: join(code("Code - Insiders"), "mcp.json"),
      detect: [code("Code - Insiders")],
      key: "servers",
      entry: (s) => ({ type: "http", url: s.url, headers: bearer(s) }),
    },
    {
      id: "cline",
      label: "Cline",
      file: join(cline, "settings", "cline_mcp_settings.json"),
      detect: [cline],
      key: "mcpServers",
      entry: (s) => ({
        type: "streamableHttp",
        url: s.url,
        headers: bearer(s),
        disabled: false,
      }),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      file: join(loc.home, ".codeium", "windsurf", "mcp_config.json"),
      detect: [join(loc.home, ".codeium", "windsurf")],
      key: "mcpServers",
      entry: (s) => ({ serverUrl: s.url, headers: bearer(s) }),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      file: join(loc.home, ".gemini", "settings.json"),
      detect: [join(loc.home, ".gemini")],
      key: "mcpServers",
      entry: (s) => ({ httpUrl: s.url, headers: bearer(s) }),
    },
    {
      id: "codex",
      label: "Codex",
      file: join(loc.codex, "config.toml"),
      detect: [loc.codex],
      toml: true,
    },
    {
      id: "opencode",
      label: "opencode",
      file: [
        join(loc.xdg, "opencode", "opencode.jsonc"),
        join(loc.xdg, "opencode", "opencode.json"),
      ].find(existsSync) || join(loc.xdg, "opencode", "opencode.json"),
      detect: [join(loc.xdg, "opencode")],
      key: "mcp",
      entry: (s) => ({
        type: "remote",
        url: s.url,
        headers: bearer(s),
        enabled: true,
      }),
    },
  ];
}

export const detected = (client) => client.detect.some(existsSync);

// Removes // and /* */ comments, then trailing commas, outside strings.
function scan(text, skip) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const n = skip(text, i);
    if (n) i += n;
    else out += text[i++];
  }
  return out;
}
export function parseJsonc(text) {
  text = text.replace(/^\uFEFF/, "");
  const plain = scan(text, (t, i) => {
    if (t.startsWith("//", i)) {
      const end = t.indexOf("\n", i);
      return (end < 0 ? t.length : end) - i;
    }
    if (t.startsWith("/*", i)) {
      const end = t.indexOf("*/", i + 2);
      return (end < 0 ? t.length : end + 2) - i;
    }
    return 0;
  });
  const strict = scan(plain, (t, i) =>
    t[i] === "," && /^\s*[}\]]/.test(t.slice(i + 1)) ? 1 : 0,
  );
  return {
    value: strict.trim() ? JSON.parse(strict) : {},
    comments: plain !== text,
  };
}

export function setJsonServer(text, key, name, entry) {
  const { value, comments } = parseJsonc(text);
  if (typeof value !== "object" || !value || Array.isArray(value))
    throw new Error("the file does not contain a JSON object");
  value[key] = { ...(value[key] || {}), [name]: entry };
  return { text: JSON.stringify(value, null, 2) + "\n", comments };
}
export function removeJsonServer(text, key, name) {
  const { value, comments } = parseJsonc(text);
  if (!value?.[key]?.[name]) return null;
  delete value[key][name];
  return { text: JSON.stringify(value, null, 2) + "\n", comments };
}

// Codex keeps MCP servers in TOML tables named [mcp_servers.<name>].
export function removeTomlServer(text, name) {
  const header = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\.(?:${name}|"${name}")\\s*(?:\\]|\\.)`,
  );
  let skip = false;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*\[/.test(line)) skip = header.test(line);
      return !skip;
    })
    .join("\n");
}
export function setTomlServer(text, name, s) {
  const rest = removeTomlServer(text, name).trimEnd();
  // JSON string escapes are valid TOML basic strings.
  const block = [
    `[mcp_servers.${name}]`,
    `url = ${JSON.stringify(s.url)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${s.token}`)} }`,
  ].join("\n");
  return (rest ? rest + "\n\n" : "") + block + "\n";
}

function claudeCli(args) {
  try {
    execFileSync("claude", args, { stdio: "pipe", timeout: 30000 });
    return "ok";
  } catch (e) {
    // Missing CLI (or a .cmd shim Node will not spawn without a shell): fall back to the file.
    if (e.code === "ENOENT" || e.code === "EINVAL") return "missing";
    return { error: String(e.stderr || e.message).trim() };
  }
}

async function edit(file, change) {
  const exists = existsSync(file);
  const before = exists ? await readFile(file, "utf8") : "";
  const after = change(before);
  if (after === null) return null;
  const text = typeof after === "string" ? after : after.text;
  const backup = exists ? `${file}.nexusssh.bak` : undefined;
  if (backup) await copyFile(file, backup);
  await mkdir(dirname(file), { recursive: true });
  // New files hold a bearer token, so only the owner may read them.
  await writeFile(file, text, exists ? undefined : { mode: 0o600 });
  return { file, backup, comments: typeof after === "object" && after.comments };
}

export async function install(client, s, { cli = true } = {}) {
  if (client.cli && cli) {
    claudeCli(["mcp", "remove", s.name, "-s", "user"]);
    const header = `Authorization: Bearer ${s.token}`;
    const added = claudeCli([
      "mcp", "add", "--transport", "http", "-s", "user",
      s.name, s.url, "--header", header,
    ]);
    if (added === "ok") return { via: "claude mcp add" };
    if (added.error) throw new Error(added.error);
  }
  return edit(client.file, (text) =>
    client.toml
      ? setTomlServer(text, s.name, s)
      : setJsonServer(text, client.key, s.name, client.entry(s)),
  );
}

export async function uninstall(client, name, { cli = true } = {}) {
  if (client.cli && cli) {
    const removed = claudeCli(["mcp", "remove", name, "-s", "user"]);
    if (removed === "ok") return { via: "claude mcp remove" };
    if (removed.error) return null;
  }
  if (!existsSync(client.file)) return null;
  return edit(client.file, (text) => {
    if (!client.toml) return removeJsonServer(text, client.key, name);
    const after = removeTomlServer(text, name);
    return after === text ? null : after.trimEnd() + "\n";
  });
}
