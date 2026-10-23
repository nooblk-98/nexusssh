// Runs only inside a disposable, network-isolated container using restored files.
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const secrets = JSON.parse(readFileSync("/app/secrets/secrets.json", "utf8"));
const key = Buffer.from(secrets.ENCRYPTION_KEY, "hex");
if (key.length !== 32) throw new Error("Invalid persisted encryption key");
const db = new DatabaseSync("/app/data/nexusssh.db", { readOnly: true });
try {
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("SQLite integrity failure");
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SSHIdentity'").get();
  if (!table) throw new Error("SSHIdentity table missing");
  const row = db.prepare('SELECT id, organizationId, encryptedSecret FROM "SSHIdentity" ORDER BY id LIMIT 1').get();
  if (row) {
    const parts = row.encryptedSecret.split(".").map((part) => Buffer.from(part, "base64url"));
    if (parts.length !== 3) throw new Error("Invalid credential envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, parts[0]);
    decipher.setAAD(Buffer.from(`${row.organizationId}:${row.id}`));
    decipher.setAuthTag(parts[1]);
    JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString());
  }
  console.log("Recovery probe passed");
} finally {
  db.close();
}
