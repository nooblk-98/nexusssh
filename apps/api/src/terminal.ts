import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Request } from "express";
import type { Client, ClientChannel } from "ssh2";
import { z } from "zod";
import { authenticate } from "./auth.js";
import { authorize, connection, audit } from "./domain.js";
import { connect } from "../../../packages/ssh-core/index.js";
import { config, sameOrigin } from "../../../packages/shared/config.js";
import { db } from "../../../packages/database/index.js";
export function terminals(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  let active = 0;
  server.on("upgrade", async (req, socket, head) => {
    let counted = false,
      client: Client | undefined,
      stream: ClientChannel | undefined,
      ws: WebSocket | undefined,
      sessionId: string | undefined;
    let idle: NodeJS.Timeout | undefined,
      revalidate: NodeJS.Timeout | undefined,
      closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (counted) {
        active--;
        counted = false;
      }
      clearTimeout(idle);
      clearInterval(revalidate);
      stream?.close();
      client?.end();
      if (ws?.readyState === WebSocket.OPEN) ws.close(1000, "Session ended");
      if (sessionId)
        void db.sSHSession
          .update({
            where: { id: sessionId },
            data: { status: "closed", endedAt: new Date() },
          })
          .catch(() => {});
    };
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/ws/terminal" || !sameOrigin(req.headers))
        throw new Error("Invalid WebSocket origin");
      const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").map((v) => v.trim().split("=")),
      );
      const authReq = Object.assign(req, { cookies }) as Request;
      const p = await authenticate(authReq);
      if (p.kind !== "user") throw new Error("Browser session required");
      const id = z.uuid().parse(url.searchParams.get("serverId"));
      await authorize(p, id, "terminal");
      if (active >= config.SSH_MAX_SESSIONS)
        throw new Error("Session capacity reached");
      active++;
      counted = true;
      wss.handleUpgrade(req, socket, head, (accepted) => {
        ws = accepted;
      });
      if (!ws) throw new Error("Upgrade failed");
      const send = (value: unknown) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
      idle = setTimeout(cleanup, config.SSH_IDLE_TIMEOUT);
      client = await connect(await connection(id, p.organizationId), {
        cidrs: config.SSH_ALLOWED_CIDRS.split(","),
        connectTimeout: config.SSH_CONNECT_TIMEOUT,
        outputLimit: config.SSH_OUTPUT_LIMIT,
      });
      if (closed) {
        client.end();
        return;
      }
      const session = await db.sSHSession.create({
        data: {
          serverId: id,
          principalId: p.id,
          organizationId: p.organizationId,
          status: "active",
        },
      });
      sessionId = session.id;
      await db.sSHConnectionHistory.create({
        data: {
          serverId: id,
          principalId: p.id,
          organizationId: p.organizationId,
          status: "connected",
        },
      });
      await audit(p, "terminal_connect", "success", id, session.id);
      stream = await new Promise<ClientChannel>((resolve, reject) =>
        client!.shell(
          { term: "xterm-256color", cols: 100, rows: 30 },
          (e, s) => (e ? reject(e) : resolve(s)),
        ),
      );
      if (closed) {
        stream.close();
        return;
      }
      send({ type: "ready", sessionId });
      stream.on("data", (data: Buffer) => {
        if (ws!.bufferedAmount > config.SSH_OUTPUT_LIMIT) {
          send({
            type: "error",
            message: "Terminal output buffer exceeded; session closed",
          });
          cleanup();
          return;
        }
        send({ type: "output", data: data.toString("base64") });
      });
      stream.stderr.on("data", (data: Buffer) =>
        send({ type: "output", data: data.toString("base64") }),
      );
      stream.on("close", cleanup);
      stream.on("error", cleanup);
      client.on("close", cleanup);
      ws.on("message", (raw) => {
        try {
          clearTimeout(idle);
          idle = setTimeout(cleanup, config.SSH_IDLE_TIMEOUT);
          const msg = z
            .discriminatedUnion("type", [
              z.object({
                type: z.literal("input"),
                data: z.string().max(16384),
              }),
              z.object({
                type: z.literal("resize"),
                cols: z.number().int().min(10).max(500),
                rows: z.number().int().min(2).max(200),
              }),
              z.object({ type: z.literal("disconnect") }),
            ])
            .parse(JSON.parse(raw.toString()));
          if (msg.type === "input") {
            if ((stream?.writableLength || 0) > 65536) {
              cleanup();
              return;
            }
            stream?.write(msg.data);
          } else if (msg.type === "resize")
            stream?.setWindow(msg.rows, msg.cols, 0, 0);
          else cleanup();
        } catch {
          send({ type: "error", message: "Invalid terminal frame" });
          cleanup();
        }
      });
      revalidate = setInterval(() => {
        void authenticate(authReq)
          .then(async (fresh) => {
            await authorize(fresh, id, "terminal");
            const session = await db.sSHSession.findUnique({
              where: { id: sessionId },
            });
            if (session?.status !== "active")
              throw new Error("Session terminated");
          })
          .catch(cleanup);
      }, 5000);
    } catch (e) {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: "error",
            message: e instanceof Error ? e.message : "Connection failed",
          }),
        );
      else socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      cleanup();
      if (!ws) socket.destroy();
    }
  });
  return wss;
}
