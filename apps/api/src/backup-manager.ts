import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../../../packages/database/index.js";
import { config } from "../../../packages/shared/config.js";
import { logEvent } from "../../../packages/shared/request-context.js";
const execute = promisify(execFile);
export const BACKUP_STATUS = "operations.backupStatus";
let running: Promise<void> | undefined;
export const backupConfigured = () =>
  !!(config.BACKUP_DIRECTORY && config.BACKUP_ENCRYPTION_KEY);
export async function backupStatus() {
  const row = await db.systemSetting.findFirst({
    where: { key: BACKUP_STATUS },
  });
  return {
    ...(row ? JSON.parse(row.value) : {}),
    configured: backupConfigured(),
    running: !!running,
    offHostConfigured: !!config.BACKUP_UPLOAD_URL,
    intervalHours: config.BACKUP_INTERVAL_HOURS,
  };
}
export function runManagedBackup() {
  if (running) return running;
  if (!backupConfigured())
    return Promise.reject(
      new Error("Configure BACKUP_DIRECTORY and BACKUP_ENCRYPTION_KEY first"),
    );
  running = (async () => {
    const organizations = await db.organization.findMany({
      select: { id: true },
    });
    const previous = await db.systemSetting.findFirst({
      where: { key: BACKUP_STATUS },
    });
    let status: Record<string, unknown> = {
      ...(previous ? JSON.parse(previous.value) : {}),
      lastAttemptAt: new Date().toISOString(),
    };
    try {
      const { stdout } = await execute(
        process.execPath,
        ["infrastructure/scripts/managed-backup.mjs", "create"],
        {
          env: {
            ...process.env,
            BACKUP_DIRECTORY: config.BACKUP_DIRECTORY,
            BACKUP_ENCRYPTION_KEY: config.BACKUP_ENCRYPTION_KEY,
            BACKUP_RETAIN_COUNT: String(config.BACKUP_RETAIN_COUNT),
            BACKUP_UPLOAD_URL: config.BACKUP_UPLOAD_URL,
            ENCRYPTION_KEY: config.ENCRYPTION_KEY,
          },
          timeout: 300000,
          maxBuffer: 65536,
        },
      );
      status = { ...status, ...JSON.parse(stdout), error: null };
      logEvent("backup_verified");
    } catch {
      status.error =
        "Backup failed. Check destination, key, database and upload configuration.";
      logEvent("backup_failed");
      const owners = await db.user.findMany({
        where: { disabled: false, role: { in: ["owner", "administrator"] } },
        select: { id: true, organizationId: true },
      });
      await db.notification.createMany({
        data: owners.map((u) => ({
          organizationId: u.organizationId,
          principalId: u.id,
          message: String(status.error),
        })),
      });
    }
    for (const org of organizations)
      await db.systemSetting.upsert({
        where: {
          organizationId_key: { organizationId: org.id, key: BACKUP_STATUS },
        },
        create: {
          organizationId: org.id,
          key: BACKUP_STATUS,
          value: JSON.stringify(status),
        },
        update: { value: JSON.stringify(status) },
      });
    if (config.BACKUP_WEBHOOK_URL) {
      try {
        const response = await fetch(config.BACKUP_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: status.error ? "backup_failed" : "backup_verified",
            time: status.lastAttemptAt,
          }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) logEvent("backup_notification_failed");
      } catch {
        logEvent("backup_notification_failed");
      }
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
}
export function startBackupScheduler() {
  const tick = async () => {
    if (!backupConfigured() || running) return;
    const status = await backupStatus();
    if (
      !status.lastAttemptAt ||
      Date.now() - new Date(status.lastAttemptAt).getTime() >=
        config.BACKUP_INTERVAL_HOURS * 3600000
    )
      await runManagedBackup();
  };
  const timer = setInterval(
    () => void tick().catch(() => logEvent("backup_scheduler_failed")),
    60000,
  );
  void tick().catch(() => logEvent("backup_scheduler_failed"));
  return () => clearInterval(timer);
}
