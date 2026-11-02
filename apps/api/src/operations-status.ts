import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { authenticate, admin, human } from "./auth.js";
import { readiness } from "./readiness.js";
import {
  backupConfigured,
  backupStatus,
  runManagedBackup,
} from "./backup-manager.js";
import { oidcEnabled } from "./oidc.js";
import { config } from "../../../packages/shared/config.js";
import { audit } from "./domain.js";
import { logEvent } from "../../../packages/shared/request-context.js";
@Controller("api/operations-status")
export class OperationsStatusController {
  @Get() async status(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    admin(p);
    return {
      readiness: await readiness(),
      backup: await backupStatus(),
      sso: { enabled: oidcEnabled(), label: config.OIDC_LABEL },
      fileHistory: {
        enabled: config.SFTP_FILE_HISTORY,
        retentionDays: config.SFTP_HISTORY_DAYS,
      },
    };
  }
  @Post("backup") async backup(@Req() req: Request) {
    const p = await authenticate(req);
    human(p);
    admin(p);
    if (!backupConfigured())
      throw new BadRequestException(
        "Configure BACKUP_DIRECTORY and BACKUP_ENCRYPTION_KEY on the deployment first",
      );
    await audit(p, "backup_requested", "success");
    void runManagedBackup().catch(() => logEvent("backup_failed"));
    return { status: "started" };
  }
}
