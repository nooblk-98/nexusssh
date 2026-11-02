import {
  recoverKubernetesExecutions,
  expireKubernetesResults,
} from "./kubernetes-operations.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  Module,
  type ExceptionFilter,
  Catch,
  type ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import express from "express";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import {
  requestContext,
  correlationId,
  logEvent,
} from "../../../packages/shared/request-context.js";
import { equal } from "../../../packages/shared/crypto.js";
import { WorkflowsController } from "./workflows.js";
import { OidcController } from "./oidc.js";
import { DiagnosticsController } from "./diagnostics.js";
import { OperationsStatusController } from "./operations-status.js";
import { startBackupScheduler } from "./backup-manager.js";
import { AppController } from "./controller.js";
import { VpnController } from "./vpn.js";
import { KubernetesController } from "./kubernetes.js";
import {
  config,
  generatedSecrets,
  sameOrigin,
} from "../../../packages/shared/config.js";
import { db, initializeDatabase } from "../../../packages/database/index.js";
import { terminals } from "./terminal.js";
import { SftpController } from "./sftp.js";
import { queue, events, batchQueue, batchEvents } from "./domain.js";
import { reconcileRunningTasks } from "./task-recovery.js";
import {
  startHealthWorker,
  enqueuePeriodicHealth,
  healthQueue,
} from "./health.js";
@Module({
  controllers: [
    AppController,
    SftpController,
    VpnController,
    KubernetesController,
    WorkflowsController,
    OidcController,
    DiagnosticsController,
    OperationsStatusController,
  ],
})
class AppModule {}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    const res = host.switchToHttp().getResponse();
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof ZodError
          ? 400
          : 500;
    const message =
      error instanceof ZodError
        ? "Invalid request: " +
          error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ")
        : error instanceof HttpException
          ? error.getResponse()
          : "Request failed";
    logEvent("request_failed", {
      status,
      method: req.method,
      path: req.path,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    const principal = req.nexusPrincipal;
    if ([401, 403].includes(status) && principal)
      void db.auditEvent
        .create({
          data: {
            organizationId: principal.organizationId,
            principalId: principal.id,
            action: `${req.method} ${req.path}`,
            status: "denied",
            correlationId: correlationId(),
            requestId: correlationId(),
          },
        })
        .catch(() => {});
    res
      .status(status)
      .json({
        ...(typeof message === "string" ? { message } : message),
        requestId: correlationId(),
      });
  }
}
await initializeDatabase();
await recoverKubernetesExecutions();
await expireKubernetesResults();
const interruptedTasks = await reconcileRunningTasks();
if (interruptedTasks)
  console.warn(
    `Interrupted ${interruptedTasks} running SSH tasks after restart`,
  );
if (generatedSecrets.includes("SETUP_TOKEN") && (await db.user.count()) === 0)
  console.log(`First-run setup token: ${process.env.SETUP_TOKEN}`);
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(helmet());
app.use((req: any, res: any, next: any) => {
  const forwarded = req.headers["x-nexus-correlation-id"];
  const id =
    typeof forwarded === "string" &&
    /^[a-f0-9-]{36}$/.test(forwarded) &&
    equal(req.headers["x-nexus-internal"] || "", config.INTERNAL_SECRET)
      ? forwarded
      : randomUUID();
  res.setHeader("X-Correlation-ID", id);
  res.setHeader("Cache-Control", "no-store");
  if (
    ["POST", "PATCH", "DELETE", "PUT"].includes(req.method) &&
    !req.headers.authorization &&
    !req.path.startsWith("/api/internal/") &&
    !sameOrigin(req.headers)
  ) {
    logEvent("request_denied", {
      correlationId: id,
      requestId: id,
      method: req.method,
      path: req.path,
      status: 403,
    });
    res.status(403).json({ message: "Invalid request origin", requestId: id });
    return;
  }
  requestContext.run({ correlationId: id }, () => {
    const started = Date.now();
    res.once("finish", () =>
      logEvent("request_completed", {
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      }),
    );
    next();
  });
});
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
// Guards credential attempts; reading the session or setup state is not one.
app.use(
  "/api/auth/oidc",
  rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 60000,
    limit: 20,
    skip: (req) => req.method === "GET",
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
// Host key scans open outbound connections, so they get a tighter budget.
app.use(
  "/api/servers/scan-host-key",
  rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many host key scans; try again in a minute" },
  }),
);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use(
  "/api/kubernetes",
  rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.useGlobalFilters(new Errors());
const spec = SwaggerModule.createDocument(
  app,
  new DocumentBuilder()
    .setTitle("NexusSSH API")
    .setVersion("0.2.0")
    .addCookieAuth("nexus_session")
    .addBearerAuth()
    .build(),
);
SwaggerModule.setup("api/docs", app, spec);
await app.listen(config.API_PORT, "0.0.0.0");
const healthWorker = startHealthWorker();
const healthRefresh = setInterval(() => {
  void enqueuePeriodicHealth().catch((error) =>
    console.error(
      "Health refresh failed:",
      error instanceof Error ? error.name : "unknown",
    ),
  );
}, 60_000);
void enqueuePeriodicHealth().catch((error) =>
  console.error(
    "Initial health refresh failed:",
    error instanceof Error ? error.name : "unknown",
  ),
);
const wss = terminals(app.getHttpServer());
const stopBackups = startBackupScheduler();
const retention = setInterval(() => {
  void expireKubernetesResults().catch(() => {});
  void db.fileRevision
    .deleteMany({
      where: {
        createdAt: {
          lt: new Date(Date.now() - config.SFTP_HISTORY_DAYS * 86400000),
        },
      },
    })
    .catch(() => {});
  void db.auditEvent
    .deleteMany({
      where: {
        createdAt: {
          lt: new Date(Date.now() - config.AUDIT_RETENTION_DAYS * 86400000),
        },
      },
    })
    .catch(() => {});
  void db.webSession
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});
}, 3600000);
async function shutdown() {
  clearInterval(retention);
  stopBackups();
  clearInterval(healthRefresh);
  wss.closeAll();
  for (const client of wss.clients) client.close();
  await queue.close();
  await events.close();
  await batchQueue.close();
  await batchEvents.close();
  await healthWorker.close();
  await healthQueue.close();
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
