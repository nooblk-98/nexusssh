import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  value: null as string | null,
  execute: vi.fn(),
  notify: vi.fn(),
  enabled: true,
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => {}, { [promisify.custom]: f.execute });
  return { execFile };
});
vi.mock("../../packages/shared/config.js", () => ({
  config: {
    get BACKUP_DIRECTORY() {
      return f.enabled ? "/protected/backups" : undefined;
    },
    BACKUP_ENCRYPTION_KEY: "ab".repeat(32),
    BACKUP_INTERVAL_HOURS: 24,
    BACKUP_RETAIN_COUNT: 14,
    ENCRYPTION_KEY: "cd".repeat(32),
  },
}));
vi.mock("../../packages/database/index.js", () => ({
  db: {
    organization: { findMany: async () => [{ id: "org" }] },
    systemSetting: {
      findFirst: async () => (f.value ? { value: f.value } : null),
      upsert: async ({ create }: any) => {
        f.value = create.value;
      },
    },
    user: { findMany: async () => [{ id: "owner", organizationId: "org" }] },
    notification: { createMany: f.notify },
  },
}));
import {
  backupStatus,
  runManagedBackup,
} from "../../apps/api/src/backup-manager.js";
beforeEach(() => {
  f.value = null;
  f.enabled = true;
  f.execute.mockReset();
  f.notify.mockReset();
});
it("coalesces simultaneous requests and persists only completed verification metadata", async () => {
  f.execute.mockResolvedValue({
    stdout: JSON.stringify({
      lastSuccessAt: "2026-11-02T00:00:00Z",
      lastRehearsedAt: "2026-11-02T00:01:00Z",
      file: "fixture.nexusbackup",
    }),
  });
  await Promise.all([runManagedBackup(), runManagedBackup()]);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(await backupStatus()).toMatchObject({
    running: false,
    configured: true,
    lastRehearsedAt: "2026-11-02T00:01:00Z",
    error: null,
  });
  expect(JSON.parse(f.value!)).not.toHaveProperty("running");
});
it("preserves the last verified backup and notifies administrators after failure", async () => {
  f.value = JSON.stringify({
    lastSuccessAt: "2026-11-01T00:00:00Z",
    lastRehearsedAt: "2026-11-01T00:01:00Z",
  });
  f.execute.mockRejectedValue(new Error("fixture-secret-must-not-be-shown"));
  await runManagedBackup();
  const status = await backupStatus();
  expect(status.lastSuccessAt).toBe("2026-11-01T00:00:00Z");
  expect(status.error).toContain("Backup failed");
  expect(JSON.stringify(status)).not.toContain("fixture-secret");
  expect(f.notify).toHaveBeenCalledTimes(1);
});
it("requires explicit configuration before starting backups", async () => {
  f.enabled = false;
  await expect(runManagedBackup()).rejects.toThrow("Configure");
  expect(f.execute).not.toHaveBeenCalled();
});
