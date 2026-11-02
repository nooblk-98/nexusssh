import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
const run = promisify(execFile);
const LIMIT = 256 * 1024 * 1024;
function backupKey() {
  const key = process.env.BACKUP_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error(
      "Set a separate 32-byte BACKUP_ENCRYPTION_KEY in hexadecimal.",
    );
  return Buffer.from(key, "hex");
}
export function encryptBackup(value, key = backupKey()) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("nexusssh-backup-v1"));
  const compressed = gzipSync(Buffer.from(JSON.stringify(value)));
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return JSON.stringify({
    format: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    body: body.toString("base64"),
  });
}
export function decryptBackup(text, key = backupKey()) {
  const value = JSON.parse(text);
  if (value.format !== 1) throw new Error("Unknown backup format");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAAD(Buffer.from("nexusssh-backup-v1"));
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const data = Buffer.concat([
    cipher.update(Buffer.from(value.body, "base64")),
    cipher.final(),
  ]);
  return JSON.parse(
    gunzipSync(data, { maxOutputLength: LIMIT * 2 }).toString(),
  );
}
export function verifyDatabase(database, secrets) {
  if (!/^[a-f0-9]{64}$/i.test(secrets.ENCRYPTION_KEY || ""))
    throw new Error("Snapshot encryption key missing");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Snapshot integrity check failed");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    if (!tables.has("SSHIdentity"))
      throw new Error("Snapshot is not a NexusSSH database");
    const sources = [
      ["SSHIdentity", "encryptedSecret", (r) => `${r.organizationId}:${r.id}`],
      [
        "VpnProfile",
        "encryptedConfig",
        (r) => `${r.organizationId}:vpn:${r.id}`,
      ],
      [
        "KubernetesCluster",
        "encryptedConfig",
        (r) => `${r.organizationId}:kubernetes:${r.id}`,
      ],
      [
        "FileRevision",
        "encryptedContent",
        (r) => `${r.organizationId}:file:${r.id}`,
      ],
    ];
    for (const [table, field, context] of sources) {
      if (!tables.has(table)) continue;
      for (const row of db
        .prepare(
          `SELECT id, organizationId, "${field}" AS envelope FROM "${table}"`,
        )
        .all()) {
        const [iv, tag, body] = row.envelope
          .split(".")
          .map((v) => Buffer.from(v, "base64url"));
        const cipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(secrets.ENCRYPTION_KEY, "hex"),
          iv,
        );
        cipher.setAAD(Buffer.from(context(row)));
        cipher.setAuthTag(tag);
        JSON.parse(
          Buffer.concat([cipher.update(body), cipher.final()]).toString(),
        );
      }
    }
  } finally {
    db.close();
  }
}
async function temporary(action) {
  const base = resolve(tmpdir()),
    directory = await mkdtemp(join(base, "nexus-backup-"));
  try {
    return await action(directory);
  } finally {
    if (
      dirname(resolve(directory)) !== base ||
      !basename(directory).startsWith("nexus-backup-")
    )
      throw new Error("Invalid temporary directory");
    await rm(directory, { recursive: true, force: true });
  }
}
export async function createBackup() {
  const key = backupKey();
  if (!process.env.BACKUP_DIRECTORY)
    throw new Error("BACKUP_DIRECTORY is required");
  const destination = resolve(process.env.BACKUP_DIRECTORY);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  return temporary(async (directory) => {
    const database = join(directory, "nexusssh.db");
    const source = process.env.DATABASE_URL?.replace(/^file:/, "");
    if (!source) throw new Error("DATABASE_URL is required");
    const sourcePath =
      source.startsWith("/") || /^[a-z]:/i.test(source)
        ? source
        : resolve("packages/database/prisma", source);
    if ((await stat(sourcePath)).size > LIMIT)
      throw new Error(
        "Managed backups currently support databases up to 256 MiB",
      );
    await run(
      process.platform === "win32" ? "python" : "python3",
      [
        "infrastructure/scripts/backup.py",
        "backup",
        "--database",
        sourcePath,
        "--backup",
        database,
      ],
      { timeout: 120000 },
    );
    if ((await stat(database)).size > LIMIT)
      throw new Error("Snapshot exceeds the 256 MiB managed-backup limit");
    let secrets = {};
    if (process.env.SECRETS_FILE)
      secrets = JSON.parse(await readFile(process.env.SECRETS_FILE, "utf8"));
    for (const name of [
      "ENCRYPTION_KEY",
      "SESSION_SECRET",
      "INTERNAL_SECRET",
      "SETUP_TOKEN",
    ])
      if (process.env[name]) secrets[name] = process.env[name];
    if (secrets.ENCRYPTION_KEY?.toLowerCase() === key.toString("hex"))
      throw new Error("Use a different key for backup encryption");
    verifyDatabase(database, secrets);
    const createdAt = new Date().toISOString();
    const payload = {
      format: 1,
      createdAt,
      revision: process.env.APP_REVISION || "unknown",
      database: (await readFile(database)).toString("base64"),
      secrets,
    };
    const encrypted = encryptBackup(payload, key);
    // Rehearse from decrypted copies, independently of the original snapshot.
    const restored = decryptBackup(encrypted, key),
      restoredPath = join(directory, "restored.db");
    await writeFile(restoredPath, Buffer.from(restored.database, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    verifyDatabase(restoredPath, restored.secrets);
    const name = `nexus-${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.nexusbackup`;
    const target = join(destination, name),
      part = target + ".part";
    await writeFile(part, encrypted, { mode: 0o600, flag: "wx" });
    await rename(part, target);
    const keep = Number(process.env.BACKUP_RETAIN_COUNT || 14);
    const files = (await readdir(destination))
      .filter((f) => /^nexus-[\dTZ-]+-[a-f0-9]{8}\.nexusbackup$/.test(f))
      .sort()
      .reverse();
    if (!Number.isInteger(keep) || keep < 1)
      throw new Error("Invalid retention count");
    for (const name of files.slice(keep)) await rm(join(destination, name));
    if (process.env.BACKUP_UPLOAD_URL) {
      const url = new URL(process.env.BACKUP_UPLOAD_URL);
      if (url.protocol !== "https:")
        throw new Error("Backup upload requires HTTPS");
      url.pathname = url.pathname.replace(/\/$/, "") + "/" + name;
      const response = await fetch(url, {
        method: "PUT",
        body: encrypted,
        headers: { "Content-Type": "application/octet-stream" },
        signal: AbortSignal.timeout(120000),
        redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Off-host backup upload failed");
    }
    return {
      lastSuccessAt: createdAt,
      lastRehearsedAt: new Date().toISOString(),
      file: name,
      offHostUploaded: !!process.env.BACKUP_UPLOAD_URL,
    };
  });
}
export async function unpackBackup(source, output) {
  if ((await stat(source)).size > LIMIT * 2)
    throw new Error("Backup exceeds supported size");
  const payload = decryptBackup(await readFile(source, "utf8"));
  const directory = resolve(output);
  await mkdir(directory, { mode: 0o700 }); // Refuse existing destinations; never replace a live database.
  const database = join(directory, "nexusssh.db");
  await writeFile(database, Buffer.from(payload.database, "base64"), {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(
    join(directory, "secrets.json"),
    JSON.stringify(payload.secrets),
    { mode: 0o600, flag: "wx" },
  );
  verifyDatabase(database, payload.secrets);
  return {
    verified: true,
    createdAt: payload.createdAt,
    revision: payload.revision,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    const result =
      process.argv[2] === "create"
        ? await createBackup()
        : process.argv[2] === "unpack" && process.argv[3] && process.argv[4]
          ? await unpackBackup(process.argv[3], process.argv[4])
          : (() => {
              throw new Error("Use create, or unpack <backup> <new-directory>");
            })();
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Managed backup failed. Check configuration, permissions, database integrity and key custody.",
    );
    process.exitCode = 1;
  }
}
