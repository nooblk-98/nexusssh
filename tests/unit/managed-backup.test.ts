import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seal } from "../../packages/shared/crypto.js";
import {
  createBackup,
  decryptBackup,
  encryptBackup,
  unpackBackup,
} from "../../infrastructure/scripts/managed-backup.mjs";
const key = Buffer.alloc(32, 7);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("managed backup encryption and restore", () => {
  it("authenticates the archive and rejects tampering and wrong keys", () => {
    const text = encryptBackup(
      { database: "fixture", secrets: { ENCRYPTION_KEY: "ab".repeat(32) } },
      key,
    );
    expect(text).not.toContain("fixture");
    expect(decryptBackup(text, key).database).toBe("fixture");
    expect(() => decryptBackup(text, Buffer.alloc(32, 8))).toThrow();
    const value = JSON.parse(text);
    value.body = value.body.slice(0, -8) + "AAAAAAAA";
    expect(() => decryptBackup(JSON.stringify(value), key)).toThrow();
  });
  it("backs up committed WAL data, rehearses decryption, retains archives and refuses overwrite on unpack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-backup-test-"));
    const file = join(directory, "live.db"),
      destination = join(directory, "archives");
    const db = new DatabaseSync(file);
    try {
      db.exec(
        'PRAGMA journal_mode=WAL; CREATE TABLE "SSHIdentity" (id TEXT, organizationId TEXT, encryptedSecret TEXT);',
      );
      db.prepare('INSERT INTO "SSHIdentity" VALUES (?, ?, ?)').run(
        "identity",
        "org",
        seal({ password: "fixture-secret" }, "ab".repeat(32), "org:identity"),
      );
      vi.stubEnv("DATABASE_URL", "file:" + file);
      vi.stubEnv("BACKUP_DIRECTORY", destination);
      vi.stubEnv("BACKUP_ENCRYPTION_KEY", key.toString("hex"));
      vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
      vi.stubEnv("SECRETS_FILE", "");
      vi.stubEnv("BACKUP_UPLOAD_URL", "");
      vi.stubEnv("BACKUP_RETAIN_COUNT", "1");
      const first = await createBackup();
      expect(first.lastRehearsedAt).toBeTruthy();
      const archive = join(destination, first.file),
        text = await readFile(archive, "utf8");
      expect(text).not.toContain("fixture-secret");
      const restored = join(directory, "unpacked");
      await expect(unpackBackup(archive, restored)).resolves.toMatchObject({
        verified: true,
      });
      const copy = new DatabaseSync(join(restored, "nexusssh.db"), {
        readOnly: true,
      });
      try {
        expect(
          copy.prepare('SELECT COUNT(*) AS n FROM "SSHIdentity"').get().n,
        ).toBe(1);
      } finally {
        copy.close();
      }
      await expect(unpackBackup(archive, restored)).rejects.toThrow();
      await createBackup();
      expect(
        (await readdir(destination)).filter((name) =>
          name.endsWith(".nexusbackup"),
        ),
      ).toHaveLength(1);
      vi.stubEnv("BACKUP_UPLOAD_URL", "https://backup.example.test/archives");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unreachable");
        }),
      );
      await expect(createBackup()).rejects.toThrow("unreachable");
      expect(
        (await readdir(destination)).filter((name) =>
          name.endsWith(".nexusbackup"),
        ),
      ).toHaveLength(1);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM "SSHIdentity"').get().n,
      ).toBe(1);
    } finally {
      db.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()))
        throw new Error("Unexpected test directory");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
