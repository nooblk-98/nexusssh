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
import { markSshReachable } from "./connection-health.js";
import { revalidateShells } from "./terminal-revalidate.js";
import type { Principal } from "../../../packages/policy-engine/index.js";

// A shell outlives its WebSocket for a short grace period so a page reload or
// a network blip can resume it with a resume token. The most recent output is
// kept (bounded) and replayed to a resuming browser so its screen comes back.
const GRACE_MS = 120000;
const REPLAY_BYTES = 256 * 1024;
// Output arriving within a few milliseconds is sent as one frame, so bulk output
// does not become thousands of tiny base64 messages. Large bursts flush early.
const OUTPUT_FLUSH_MS = 5;
const OUTPUT_FRAME_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25000;
const METRICS_MS = 30000;
const METRICS_TIMEOUT_MS = 5000;
// Sign-out, lost access or an administrator ending the session closes the
// shell within this interval.
const REVALIDATE_MS = 5000;
const METRICS_OUTPUT_BYTES = 8192;
const METRICS_COMMAND = "head -n 1 /proc/stat; cat /proc/meminfo; df -P /";
const INITIAL_METRICS_COMMAND = "head -n 1 /proc/stat; sleep 1; head -n 1 /proc/stat; cat /proc/meminfo; df -P /";
type CpuSample = { idle: bigint; total: bigint };
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
  metricsTimer?: NodeJS.Timeout;
  metricsChannel?: ClientChannel;
  metricsTimeout?: NodeJS.Timeout;
  metricsPending?: symbol;
  metricsEpoch?: number;
  cpuSample?: CpuSample;
  pending?: Buffer[];
  pendingBytes?: number;
  flushTimer?: NodeJS.Timeout;
  ended: boolean;
};
export function parseMetrics(raw: string, previous?: CpuSample) {
  const cpuLines = [...raw.matchAll(/^cpu\s+((?:\d+\s+){3,}\d+)\s*$/gm)];
  const samples = cpuLines.map((line) => {
    const fields = line[1].trim().split(/\s+/).map((v) => BigInt(v));
    // Linux includes guest and guest_nice in user and nice already.
    return { total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0n), idle: fields[3] + (fields[4] || 0n) };
  });
  const sample = samples.at(-1);
  if (!sample) return;
  const memory = raw.match(/^MemTotal:\s+(-?\d+) kB$/m);
  const available = raw.match(/^MemAvailable:\s+(-?\d+) kB$/m);
  const disk = raw.match(/^\S+\s+(-?\d+)\s+(-?\d+)\s+\d+\s+\d+%\s+\/$/m);
  if (!memory || !available || !disk) return;
  const memTotal = Number(memory[1]);
  const memAvailable = Number(available[1]);
  const diskTotal = Number(disk[1]);
  const diskUsed = Number(disk[2]);
  if (!Number.isSafeInteger(memTotal) || memTotal <= 0 || !Number.isSafeInteger(memAvailable) || memAvailable < 0 || memAvailable > memTotal ||
      !Number.isSafeInteger(diskTotal) || diskTotal <= 0 || !Number.isSafeInteger(diskUsed) || diskUsed < 0 || diskUsed > diskTotal) return;
  const baseline = previous || samples.at(-2);
  const deltaTotal = baseline ? sample.total - baseline.total : 0n;
  const deltaIdle = baseline ? sample.idle - baseline.idle : 0n;
  const cpu = deltaTotal > 0n && deltaIdle >= 0n && deltaIdle <= deltaTotal
    ? Math.max(0, Math.min(100, Math.round(100 * (1 - Number(deltaIdle) / Number(deltaTotal))))) : null;
  return { sample, frame: { type: "metrics", cpu, memory: Math.max(0, Math.min(100, Math.round(100 * (memTotal - memAvailable) / memTotal))), storage: Math.max(0, Math.min(100, Math.round(100 * diskUsed / diskTotal))) } };
}
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
  // Startups between the capacity check and registration, so concurrent
  // connects cannot all pass the check and overshoot SSH_MAX_SESSIONS.
  let startups = 0;
  // Ends shells whose user signed out, lost access, or whose session an
  // administrator terminated: one batched pass for all shells per interval.
  let revalidating = false;
  const revalidation = setInterval(() => {
    if (revalidating || !shells.size) return;
    revalidating = true;
    void revalidateShells([...shells.values()], {
      authenticate,
      authorize: (p, serverId) => authorize(p, serverId, "terminal"),
      activeSessions: async (ids) =>
        new Set(
          (
            await db.sSHSession.findMany({
              where: { id: { in: ids }, status: "active" },
              select: { id: true },
            })
          ).map((row) => row.id),
        ),
    })
      .then((stale) => {
        for (const shell of stale) end(shell, "Session terminated");
      })
      .catch(() => {})
      .finally(() => (revalidating = false));
  }, REVALIDATE_MS);
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
  function stopMetrics(shell: Shell) {
    shell.metricsEpoch = (shell.metricsEpoch || 0) + 1;
    clearInterval(shell.metricsTimer);
    clearTimeout(shell.metricsTimeout);
    shell.metricsTimer = undefined;
    shell.metricsTimeout = undefined;
    shell.metricsPending = undefined;
    shell.metricsChannel?.close();
    shell.metricsChannel = undefined;
    shell.cpuSample = undefined;
  }
  function pollMetrics(shell: Shell) {
    if (shell.ended || !shell.ws || shell.ws.readyState !== WebSocket.OPEN || shell.metricsPending || shell.metricsChannel || shell.metricsTimeout) return;
    let output = "";
    let finished = false;
    const request = Symbol("metrics request");
    const epoch = shell.metricsEpoch;
    const ws = shell.ws;
    const finish = (valid: boolean) => {
      if (finished || shell.metricsEpoch !== epoch || shell.metricsPending !== request) return;
      finished = true;
      shell.metricsPending = undefined;
      clearTimeout(shell.metricsTimeout);
      shell.metricsTimeout = undefined;
      shell.metricsChannel?.close();
      shell.metricsChannel = undefined;
      if (shell.ended || shell.ws !== ws) return;
      const parsed = valid ? parseMetrics(output, shell.cpuSample) : undefined;
      if (parsed) {
        shell.cpuSample = parsed.sample;
        send(ws, parsed.frame);
      } else {
        shell.cpuSample = undefined;
        send(ws, { type: "metrics", cpu: null, memory: null, storage: null });
      }
    };
    shell.metricsTimeout = setTimeout(() => finish(false), METRICS_TIMEOUT_MS);
    shell.metricsPending = request;
    shell.client.exec(shell.cpuSample ? METRICS_COMMAND : INITIAL_METRICS_COMMAND, (error, channel) => {
      if (shell.metricsEpoch !== epoch || shell.metricsPending !== request) { channel?.close(); return; }
      if (finished || shell.ended || shell.ws !== ws) { channel?.close(); return; }
      if (error || !channel) return finish(false);
      shell.metricsChannel = channel;
      channel.on("data", (data: Buffer) => {
        if (output.length + data.length > METRICS_OUTPUT_BYTES) return finish(false);
        output += data.toString("utf8");
      });
      channel.stderr.on("data", () => finish(false));
      channel.on("close", (code: number) => finish(code === 0));
      channel.on("error", () => finish(false));
    });
  }
  function end(shell: Shell, reason = "Session ended") {
    if (shell.ended) return;
    shell.ended = true;
    shells.delete(shell.token);
    clearTimeout(shell.grace);
    clearTimeout(shell.idle);
    stopMetrics(shell);
    flush(shell);
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
    if (shell.ws?.readyState === WebSocket.OPEN) return;
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
    // A resuming browser gets everything through the replay below.
    dropPending(shell);
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
    stopMetrics(shell);
    pollMetrics(shell);
    shell.metricsTimer = setInterval(() => pollMetrics(shell), METRICS_MS);
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
      stopMetrics(shell);
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
    if (shell.ws?.readyState !== WebSocket.OPEN) return;
    (shell.pending ??= []).push(data);
    shell.pendingBytes = (shell.pendingBytes || 0) + data.length;
    if (shell.pendingBytes >= OUTPUT_FRAME_BYTES) flush(shell);
    else shell.flushTimer ??= setTimeout(() => flush(shell), OUTPUT_FLUSH_MS);
  }
  // Pending output is already in the replay buffer, so dropping it is safe.
  function dropPending(shell: Shell) {
    clearTimeout(shell.flushTimer);
    shell.flushTimer = undefined;
    shell.pending = undefined;
    shell.pendingBytes = 0;
  }
  function flush(shell: Shell) {
    const pending = shell.pending;
    dropPending(shell);
    const ws = shell.ws;
    if (!pending?.length || ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.SSH_OUTPUT_LIMIT) {
      send(ws, {
        type: "error",
        message: "Terminal output buffer exceeded; session closed",
      });
      return end(shell);
    }
    send(ws, { type: "output", data: Buffer.concat(pending).toString("base64") });
  }
  server.on("upgrade", async (req, socket, head) => {
    let ws: WebSocket | undefined;
    const starting: { client?: Client } = {};
    let reserved = false;
    const unreserve = () => {
      if (reserved) startups--;
      reserved = false;
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
      if (shells.size + startups >= config.SSH_MAX_SESSIONS)
        throw new Error("Session capacity reached");
      startups++;
      reserved = true;
      const socketClosed = new Promise<void>((resolve) =>
        ws!.once("close", () => resolve()),
      );
      let gone = false;
      void socketClosed.then(() => (gone = true));
      const target = await connection(id, p.organizationId);
      const client = await connect(
        target,
        await sshLimits(p.organizationId),
      );
      starting.client = client;
      if (gone) return void client.end();
      await markSshReachable(p.organizationId, id, target).catch(() => {});
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
      unreserve();
      shells.set(shell.token, shell);
      stream.on("data", (d: Buffer) => output(shell, d));
      stream.stderr.on("data", (d: Buffer) => output(shell, d));
      stream.on("close", () => end(shell));
      stream.on("error", () => end(shell));
      client.on("close", () => end(shell));
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
    } finally {
      unreserve();
    }
  });
  const closeAll = () => {
    clearInterval(heartbeat);
    clearInterval(revalidation);
    for (const shell of shells.values()) end(shell, "Server shutting down");
  };
  return Object.assign(wss, { closeAll });
}
