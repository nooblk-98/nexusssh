import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Request } from "express";
import type { Client, ClientChannel } from "ssh2";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate } from "./auth.js";
import { authorize, connection, audit, sshLimits } from "./domain.js";
import { connect } from "../../../packages/ssh-core/index.js";
import { config, sameOrigin } from "../../../packages/shared/config.js";
import { db } from "../../../packages/database/index.js";
import type { Principal } from "../../../packages/policy-engine/index.js";

// A shell outlives its WebSocket for a short grace period so a page reload or
// a network blip can resume it with a resume token. The most recent output is
// kept (bounded) and replayed to a resuming browser so its screen comes back.
const GRACE_MS = 120000;
const REPLAY_BYTES = 256 * 1024;
const HEARTBEAT_MS = 25000;
type Shell = {
  token: string;
  principal: Principal;
  serverId: string;
  sessionId: string;
  client: Client;
  stream: ClientChannel;
  authReq: Request;
  ws?: WebSocket;
  replay: Buffer[];
  replayBytes: number;
  grace?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  revalidate?: NodeJS.Timeout;
  ended: boolean;
};
const frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(16384) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(2).max(200),
  }),
  z.object({ type: z.literal("disconnect") }),
]);
export function terminals(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const shells = new Map<string, Shell>();
  const responsive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!responsive.has(ws)) {
        ws.terminate();
        continue;
      }
      responsive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const watchSocket = (ws: WebSocket) => {
    responsive.add(ws);
    ws.on("pong", () => responsive.add(ws));
  };
  const send = (ws: WebSocket | undefined, value: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  function end(shell: Shell, reason = "Session ended") {
    if (shell.ended) return;
    shell.ended = true;
    shells.delete(shell.token);
    clearTimeout(shell.grace);
    clearTimeout(shell.idle);
    clearInterval(shell.revalidate);
    shell.stream.close();
    shell.client.end();
    if (shell.ws?.readyState === WebSocket.OPEN) shell.ws.close(1000, reason);
    void db.sSHSession
      .updateMany({
        where: { id: shell.sessionId, status: "active" },
        data: { status: "closed", endedAt: new Date() },
      })
      .catch(() => {});
  }
  const touch = (shell: Shell) => {
    clearTimeout(shell.idle);
    shell.idle = setTimeout(() => end(shell), config.SSH_IDLE_TIMEOUT);
  };
  function attach(
    shell: Shell,
    ws: WebSocket,
    authReq: Request,
    resumed: boolean,
  ) {
    // A newer browser connection takes over; the old one is told why.
    if (shell.ws && shell.ws !== ws && shell.ws.readyState === WebSocket.OPEN) {
      send(shell.ws, {
        type: "error",
        message: "Session opened in another window",
      });
      shell.ws.close(1000, "Taken over");
    }
    clearTimeout(shell.grace);
    shell.ws = ws;
    shell.authReq = authReq;
    send(ws, {
      type: "ready",
      sessionId: shell.sessionId,
      resume: shell.token,
      resumed,
    });
    if (resumed && shell.replayBytes)
      send(ws, {
        type: "output",
        data: Buffer.concat(shell.replay).toString("base64"),
      });
    touch(shell);
    ws.on("message", (raw) => {
      if (shell.ws !== ws) return;
      try {
        touch(shell);
        const msg = frame.parse(JSON.parse(raw.toString()));
        if (msg.type === "input") {
          if ((shell.stream.writableLength || 0) > 65536)
            return end(shell, "Input backlog exceeded");
          shell.stream.write(msg.data);
        } else if (msg.type === "resize")
          shell.stream.setWindow(msg.rows, msg.cols, 0, 0);
        else end(shell);
      } catch {
        send(ws, { type: "error", message: "Invalid terminal frame" });
        end(shell);
      }
    });
    const detach = () => {
      if (shell.ws !== ws || shell.ended) return;
      shell.ws = undefined;
      shell.grace = setTimeout(() => end(shell, "Not resumed"), GRACE_MS);
    };
    ws.on("close", detach);
    ws.on("error", detach);
  }
  function output(shell: Shell, data: Buffer) {
    shell.replay.push(data);
    shell.replayBytes += data.length;
    while (shell.replayBytes > REPLAY_BYTES && shell.replay.length > 1)
      shell.replayBytes -= shell.replay.shift()!.length;
    const ws = shell.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.SSH_OUTPUT_LIMIT) {
      send(ws, {
        type: "error",
        message: "Terminal output buffer exceeded; session closed",
      });
      return end(shell);
    }
    send(ws, { type: "output", data: data.toString("base64") });
  }
  server.on("upgrade", async (req, socket, head) => {
    let ws: WebSocket | undefined;
    const starting: { client?: Client } = {};
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
      const token = url.searchParams.get("resume");
      const existing = token ? shells.get(token) : undefined;
      wss.handleUpgrade(req, socket, head, (accepted) => {
        ws = accepted;
        watchSocket(accepted);
      });
      if (!ws) throw new Error("Upgrade failed");
      if (
        existing &&
        !existing.ended &&
        existing.principal.id === p.id &&
        existing.serverId === id
      ) {
        attach(existing, ws, authReq, true);
        return;
      }
      if (shells.size >= config.SSH_MAX_SESSIONS)
        throw new Error("Session capacity reached");
      const socketClosed = new Promise<void>((resolve) =>
        ws!.once("close", () => resolve()),
      );
      let gone = false;
      void socketClosed.then(() => (gone = true));
      const client = await connect(
        await connection(id, p.organizationId),
        await sshLimits(p.organizationId),
      );
      starting.client = client;
      if (gone) return void client.end();
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (e, s) =>
          e ? reject(e) : resolve(s),
        ),
      );
      if (gone) {
        stream.close();
        return void client.end();
      }
      const session = await db.sSHSession.create({
        data: {
          serverId: id,
          principalId: p.id,
          organizationId: p.organizationId,
          status: "active",
        },
      });
      await db.sSHConnectionHistory.create({
        data: {
          serverId: id,
          principalId: p.id,
          organizationId: p.organizationId,
          status: "connected",
        },
      });
      await audit(p, "terminal_connect", "success", id, session.id);
      const shell: Shell = {
        token: randomBytes(24).toString("hex"),
        principal: p,
        serverId: id,
        sessionId: session.id,
        client,
        stream,
        authReq,
        replay: [],
        replayBytes: 0,
        ended: false,
      };
      shells.set(shell.token, shell);
      stream.on("data", (d: Buffer) => output(shell, d));
      stream.stderr.on("data", (d: Buffer) => output(shell, d));
      stream.on("close", () => end(shell));
      stream.on("error", () => end(shell));
      client.on("close", () => end(shell));
      // Ends the shell when its user signs out, loses access, or an
      // administrator terminates the session.
      shell.revalidate = setInterval(() => {
        void authenticate(shell.authReq)
          .then(async (fresh) => {
            await authorize(fresh, id, "terminal");
            const row = await db.sSHSession.findUnique({
              where: { id: shell.sessionId },
            });
            if (row?.status !== "active") throw new Error("Session terminated");
          })
          .catch(() => end(shell, "Session terminated"));
      }, 5000);
      attach(shell, ws, authReq, false);
    } catch (e) {
      starting.client?.end();
      if (ws?.readyState === WebSocket.OPEN) {
        send(ws, {
          type: "error",
          message: e instanceof Error ? e.message : "Connection failed",
        });
        ws.close(1000);
      } else if (!ws) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    }
  });
  const closeAll = () => {
    clearInterval(heartbeat);
    for (const shell of shells.values()) end(shell, "Server shutting down");
  };
  return Object.assign(wss, { closeAll });
}
