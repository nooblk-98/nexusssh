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
import { AppController } from "./controller.js";
import { VpnController } from "./vpn.js";
import {
  config,
  generatedSecrets,
  sameOrigin,
} from "../../../packages/shared/config.js";
import { db, initializeDatabase } from "../../../packages/database/index.js";
import { terminals } from "./terminal.js";
import { SftpController } from "./sftp.js";
import { queue, events } from "./domain.js";
import { reconcileRunningTasks } from "./task-recovery.js";
import { startHealthWorker, enqueuePeriodicHealth, healthQueue } from "./health.js";
@Module({ controllers: [AppController, SftpController, VpnController] })
class AppModule {}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
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
    if (status === 500)
      console.error(
        "Request failed",
        error instanceof Error ? error.name : "unknown",
      );
    res
      .status(status)
      .json(typeof message === "string" ? { message } : message);
  }
}
await initializeDatabase();
const interruptedTasks = await reconcileRunningTasks();
if (interruptedTasks) console.warn(`Interrupted ${interruptedTasks} running SSH tasks after restart`);
if (generatedSecrets.includes("SETUP_TOKEN") && (await db.user.count()) === 0)
  console.log(`First-run setup token: ${process.env.SETUP_TOKEN}`);
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use((req: any, res: any, next: any) => {
  res.setHeader("X-Correlation-ID", randomUUID());
  res.setHeader("Cache-Control", "no-store");
  if (
    ["POST", "PATCH", "DELETE", "PUT"].includes(req.method) &&
    !req.headers.authorization &&
    !req.path.startsWith("/api/internal/") &&
    !sameOrigin(req.headers)
  ) {
    res.status(403).json({ message: "Invalid request origin" });
    return;
  }
  next();
});
// Guards credential attempts; reading the session or setup state is not one.
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
app.useGlobalFilters(new Errors());
const spec = SwaggerModule.createDocument(
  app,
  new DocumentBuilder()
    .setTitle("NexusSSH API")
    .setVersion("0.1.0")
    .addCookieAuth("nexus_session")
    .addBearerAuth()
    .build(),
);
SwaggerModule.setup("api/docs", app, spec);
await app.listen(config.API_PORT, "0.0.0.0");
const healthWorker = startHealthWorker();
const healthRefresh = setInterval(() => { void enqueuePeriodicHealth().catch((error) => console.error("Health refresh failed:", error instanceof Error ? error.name : "unknown")); }, 5 * 60_000);
void enqueuePeriodicHealth().catch((error) => console.error("Initial health refresh failed:", error instanceof Error ? error.name : "unknown"));
const wss = terminals(app.getHttpServer());
const retention = setInterval(() => {
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
  clearInterval(healthRefresh);
  wss.closeAll();
  for (const client of wss.clients) client.close();
  await queue.close();
  await events.close();
  await healthWorker.close();
  await healthQueue.close();
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
