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
import {
  config,
  generatedSecrets,
  sameOrigin,
} from "../../../packages/shared/config.js";
import { db, initializeDatabase } from "../../../packages/database/index.js";
import { terminals } from "./terminal.js";
import { queue, events } from "./domain.js";
@Module({ controllers: [AppController] })
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
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
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
  for (const client of wss.clients) client.close();
  await queue.close();
  await events.close();
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
