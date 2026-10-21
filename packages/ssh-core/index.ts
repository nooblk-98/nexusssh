import { Client, type SFTPWrapper, type ClientChannel } from "ssh2";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import posix from "node:path/posix";
import ipaddr from "ipaddr.js";
export type Connection = {
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  fileRoot: string;
  credential: { password?: string; privateKey?: string; passphrase?: string };
  bastion?: Connection;
};
export type Limits = {
  cidrs: string[];
  connectTimeout: number;
  outputLimit: number;
};
export function allowedIP(address: string, cidrs: string[]) {
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  return cidrs.some((c) => {
    const [net, bits] = ipaddr.parseCIDR(c);
    return ip.kind() === net.kind() && ip.match(net, bits);
  });
}
export async function resolveAllowed(host: string, cidrs: string[]) {
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !allowedIP(a.address, cidrs)))
    throw new Error("SSH destination is outside the configured allowlist");
  return addresses[0].address;
}
export function fingerprint(key: Buffer) {
  return (
    "SHA256:" +
    createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
  );
}
export async function connect(c: Connection, l: Limits): Promise<Client> {
  if (!c.fingerprint)
    throw new Error(
      "Verify and save the SSH host fingerprint before connecting",
    );
  const address = await resolveAllowed(c.host, l.cidrs);
  const client = new Client();
  let bastion: Client | undefined;
  let sock: ClientChannel | undefined;
  if (c.bastion) {
    if (c.bastion.bastion) throw new Error("Only one bastion hop is supported");
    bastion = await connect(c.bastion, l);
    sock = await new Promise((resolve, reject) =>
      bastion!.forwardOut("127.0.0.1", 0, address, c.port, (e, s) =>
        e ? reject(e) : resolve(s),
      ),
    );
    client.once("close", () => bastion?.end());
  }
  return new Promise((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.on("error", (e) => {
      bastion?.end();
      reject(e);
    });
    client.connect({
      host: address,
      port: c.port,
      sock,
      username: c.username,
      ...c.credential,
      readyTimeout: l.connectTimeout,
      keepaliveInterval: 15000,
      keepaliveCountMax: 2,
      hostVerifier: (key: Buffer) => fingerprint(key) === c.fingerprint,
    });
  });
}
// Reads the host key a server presents without authenticating, so the user can
// compare it with a trusted value before it is pinned.
export async function scanHostKey(
  host: string,
  port: number,
  l: Limits,
): Promise<string> {
  const address = await resolveAllowed(host, l.cidrs);
  const client = new Client();
  return new Promise((resolve, reject) => {
    let seen: string | undefined;
    client.on("error", (e) => (seen ? resolve(seen) : reject(e)));
    client.on("close", () =>
      seen ? resolve(seen) : reject(new Error("No host key received")),
    );
    client.connect({
      host: address,
      port,
      username: "nexusssh-scan",
      readyTimeout: l.connectTimeout,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return false;
      },
    });
  });
}
export async function exec(
  client: Client,
  command: string,
  timeoutMs: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
}> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined,
      done = false,
      bytes = 0,
      truncated = false;
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      client.removeListener("close", closed);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      channel?.close();
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(
        new Error("Operation cancelled; remote child processes may continue"),
      );
    const closed = () => fail(new Error("SSH connection closed"));
    const timer = setTimeout(
      () =>
        fail(
          new Error("Command timed out; remote child processes may continue"),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    client.once("close", closed);
    if (signal?.aborted) {
      abort();
      return;
    }
    client.exec(
      command,
      { env: { LANG: "C", LC_ALL: "C" } },
      (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        channel = stream;
        if (done) {
          stream.close();
          return;
        }
        const collect = (dest: Buffer[], data: Buffer) => {
          const remaining = limit - bytes;
          if (data.length > remaining) truncated = true;
          if (remaining > 0) {
            const part = data.subarray(0, remaining);
            dest.push(part);
            bytes += part.length;
          }
        };
        stream.on("data", (d: Buffer) => collect(stdout, d));
        stream.stderr.on("data", (d: Buffer) => collect(stderr, d));
        stream.once("error", fail);
        stream.once("close", (code: number | null) => {
          if (done) return;
          done = true;
          cleanup();
          resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
            exitCode: code ?? null,
            truncated,
            durationMs: Date.now() - started,
          });
        });
      },
    );
  });
}
export async function sftp(client: Client) {
  return new Promise<SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s))),
  );
}
export function inside(root: string, path: string) {
  return path === root || path.startsWith(root === "/" ? "/" : root + "/");
}
function invoke<T>(
  s: SFTPWrapper,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return new Promise((resolve, reject) =>
    (s as any)[method](...args, (e: Error | null, result: T) =>
      e ? reject(e) : resolve(result),
    ),
  );
}
export async function safePath(
  s: SFTPWrapper,
  root: string,
  path: string,
  create = false,
) {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new Error("Invalid remote path");
  const base = await invoke<string>(s, "realpath", root);
  const normalized = posix.normalize(path);
  if (!inside(base, normalized))
    throw new Error("Path is outside the permitted root");
  // Resolve the parent for both existing and new files. Never follow a final symlink on writes.
  const parent = await invoke<string>(s, "realpath", posix.dirname(normalized));
  if (!inside(base, parent) && normalized !== base)
    throw new Error("Symlink escapes permitted root");
  if (create) {
    try {
      const attr = await invoke<any>(s, "lstat", normalized);
      if (attr.isSymbolicLink())
        throw new Error("Writing through a symlink is forbidden");
    } catch (e) {
      if ((e as any).code !== 2) throw e;
    }
    return posix.join(parent, posix.basename(normalized));
  }
  const real = await invoke<string>(s, "realpath", normalized);
  if (!inside(base, real)) throw new Error("Symlink escapes permitted root");
  return real;
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function diagnostic(op: string, a: any): string | undefined {
  const fixed: Record<string, string> = {
    system_info: "uname -a; cat /etc/os-release",
  };
  if (fixed[op]) return fixed[op];
  if (op === "ssh_execute") return a.command;
  if (op === "system_logs")
    return `journalctl --no-pager -n ${a.lines}${a.service ? " -u " + quote(a.service) : ""}`;
  if (op.startsWith("service_"))
    return `systemctl ${op.slice(8)} -- ${quote(a.service)}`;
}
export async function operate(
  c: Connection,
  l: Limits,
  op: string,
  a: any,
  signal?: AbortSignal,
): Promise<any> {
  const client = await connect(c, l);
  const abort = () => client.end();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 65000);
  try {
    if (signal?.aborted) throw new Error("Operation cancelled");
    if (["server_test_connection", "ssh_connect"].includes(op))
      return {
        connected: true,
        mode: "operation-scoped",
        message: "Host key verified; connection closed after the check",
      };
    const command = diagnostic(op, a);
    if (command) {
      const result = await exec(
        client,
        command,
        a.timeoutMs || 30000,
        l.outputLimit,
        signal,
      );
      return result;
    }
    const s = await sftp(client);
    const writing = [
      "ssh_write_file",
      "ssh_upload_file",
      "ssh_create_directory",
      "ssh_rename_file",
    ].includes(op);
    const path = await safePath(s, c.fileRoot, a.path, writing);
    if (op === "ssh_list_directory") {
      const entries = await invoke<any[]>(s, "readdir", path);
      return {
        path,
        entries: entries.slice(0, 2000).map((e) => ({
          name: e.filename,
          size: e.attrs.size,
          mode: e.attrs.mode,
          modifiedAt: e.attrs.mtime,
          directory: e.attrs.isDirectory(),
          symlink: e.attrs.isSymbolicLink(),
        })),
        truncated: entries.length > 2000,
      };
    }
    if (["ssh_read_file", "ssh_download_file"].includes(op)) {
      const stat = await invoke<any>(s, "stat", path);
      if (!stat.isFile() || stat.size > l.outputLimit)
        throw new Error("Not a regular file or file exceeds transfer limit");
      const chunks: Buffer[] = [];
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        const stream = s.createReadStream(path);
        stream.on("data", (b: Buffer) => {
          size += b.length;
          if (size > l.outputLimit)
            stream.destroy(new Error("Transfer limit exceeded"));
          else chunks.push(b);
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      const data = Buffer.concat(chunks);
      return {
        path,
        content: data.toString(op === "ssh_download_file" ? "base64" : "utf8"),
        encoding: op === "ssh_download_file" ? "base64" : "utf8",
        bytes: size,
      };
    }
    if (["ssh_write_file", "ssh_upload_file"].includes(op)) {
      const data = Buffer.from(a.content, a.encoding);
      if (data.length > l.outputLimit)
        throw new Error("Transfer limit exceeded");
      const tmp = posix.join(posix.dirname(path), ".nexus-" + randomUUID());
      try {
        await new Promise<void>((resolve, reject) => {
          const stream = s.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
          stream.on("error", reject);
          stream.on("close", resolve);
          stream.end(data);
        });
        await invoke<void>(s, "ext_openssh_rename", tmp, path);
      } catch (e) {
        await invoke(s, "unlink", tmp).catch(() => {});
        throw e;
      }
      return { path, bytes: data.length, atomic: true };
    }
    if (op === "ssh_create_directory") {
      await invoke(s, "mkdir", path, { mode: 0o700 });
      return { path, created: true };
    }
    if (op === "ssh_delete_file") {
      if (path === (await invoke<string>(s, "realpath", c.fileRoot)))
        throw new Error("Cannot delete file root");
      const stat = await invoke<any>(s, "lstat", path);
      await invoke(s, stat.isDirectory() ? "rmdir" : "unlink", path);
      return { path, deleted: true };
    }
    if (op === "ssh_rename_file") {
      const destination = await safePath(s, c.fileRoot, a.destination, true);
      await invoke(s, "rename", path, destination);
      return { path, destination };
    }
    throw new Error("Unsupported SSH operation");
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    client.end();
  }
}
