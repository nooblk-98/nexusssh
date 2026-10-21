import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { Client, SFTPWrapper } from "ssh2";
import posix from "node:path/posix";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { authenticate, human } from "./auth.js";
import { audit, authorize, connection, sshLimits } from "./domain.js";
import { config } from "../../../packages/shared/config.js";
import {
  connect,
  connectionFailures,
  inside,
  invoke,
  safePath,
  sftp as openSftp,
} from "../../../packages/ssh-core/index.js";
import type { Principal } from "../../../packages/policy-engine/index.js";

// Interactive SFTP for signed-in people, alongside the interactive terminal:
// the same per-operation permissions and audit, but no approval step (that
// gate is for agents, which keep using /operations and MCP). One SFTP channel
// per person and server is reused and closed after a minute without use.
const IDLE_MS = 60000;
const EDIT_LIMIT = 5 * 1024 * 1024;
const CHUNK_LIMIT = 8 * 1024 * 1024;
const WALK_LIMIT = 20000;
type Session = {
  client: Client;
  sftp: SFTPWrapper;
  root: string;
  timer?: NodeJS.Timeout;
};
const pool = new Map<string, Promise<Session>>();
async function session(p: Principal, serverId: string): Promise<Session> {
  const key = p.id + ":" + serverId;
  let pending = pool.get(key);
  if (!pending) {
    pending = (async () => {
      const c = await connection(serverId, p.organizationId);
      const client = await connect(c, await sshLimits(p.organizationId));
      client.on("close", () => pool.delete(key));
      client.on("error", () => pool.delete(key));
      return { client, sftp: await openSftp(client), root: c.fileRoot };
    })();
    pool.set(key, pending);
    pending.catch(() => pool.delete(key));
  }
  const s = await pending;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => s.client.end(), IDLE_MS);
  return s;
}
// Ends pooled channels for a server, e.g. after its address or credential changed.
export function closeSftp(serverId: string) {
  for (const [key, s] of pool)
    if (key.endsWith(":" + serverId))
      void s.then((x) => x.client.end()).catch(() => {});
}
const sftpErrors: Record<number, string> = {
  2: "No such file or directory",
  3: "Permission denied",
  4: "The server could not complete the operation",
};
function failure(e: unknown): never {
  if (e instanceof BadRequestException) throw e;
  const err = e as { code?: number; message?: string };
  const message = err.message || "";
  if (typeof err.code === "number" && sftpErrors[err.code])
    throw new BadRequestException(sftpErrors[err.code]);
  if (
    connectionFailures.some((r) => r.test(message)) ||
    /root|path|symlink|large|binary/i.test(message)
  )
    throw new BadRequestException(message);
  throw new BadRequestException("SFTP request failed");
}
async function open(req: Request, serverId: string, op: string) {
  const p = await authenticate(req);
  human(p);
  z.uuid().parse(serverId);
  await authorize(p, serverId, op);
  try {
    return { p, ...(await session(p, serverId)) };
  } catch (e) {
    failure(e);
  }
}
// Resolves a path inside the root without following its last component, so
// links themselves can be renamed or removed.
async function entryPath(s: SFTPWrapper, root: string, path: string) {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new BadRequestException("Invalid remote path");
  const base = await invoke<string>(s, "realpath", root);
  const normalized = posix.normalize(path);
  if (normalized === base)
    throw new BadRequestException("The SFTP root itself cannot be changed");
  const parent = await invoke<string>(s, "realpath", posix.dirname(normalized));
  if (!inside(base, parent))
    throw new BadRequestException("Path is outside the permitted root");
  return posix.join(parent, posix.basename(normalized));
}
const path = z.string().min(1).max(4096);
type Entry = {
  name: string;
  size: number;
  mode: number;
  modifiedAt: number;
  directory: boolean;
  symlink: boolean;
};
async function list(s: SFTPWrapper, dir: string): Promise<Entry[]> {
  const entries = await invoke<any[]>(s, "readdir", dir);
  return entries.map((e) => ({
    name: e.filename,
    size: e.attrs.size,
    mode: e.attrs.mode,
    modifiedAt: e.attrs.mtime,
    directory: e.attrs.isDirectory(),
    symlink: e.attrs.isSymbolicLink(),
  }));
}
// Depth-first walk that never follows symbolic links.
async function* walk(
  s: SFTPWrapper,
  dir: string,
  budget = { n: 0 },
): AsyncGenerator<{ path: string; entry: Entry }> {
  for (const entry of await list(s, dir)) {
    if (++budget.n > WALK_LIMIT)
      throw new BadRequestException(
        "Too many files (limit " + WALK_LIMIT + ")",
      );
    const full = posix.join(dir, entry.name);
    yield { path: full, entry };
    if (entry.directory && !entry.symlink) yield* walk(s, full, budget);
  }
}
async function replace(s: SFTPWrapper, from: string, to: string) {
  try {
    await invoke(s, "ext_openssh_rename", from, to);
  } catch {
    // Servers without the posix-rename extension need the target removed first.
    await invoke(s, "unlink", to).catch(() => {});
    await invoke(s, "rename", from, to);
  }
}
async function readAll(s: SFTPWrapper, file: string, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = s.createReadStream(file);
    stream.on("data", (b: Buffer) => {
      size += b.length;
      if (size > limit)
        stream.destroy(
          new BadRequestException("File is too large to open here"),
        );
      else chunks.push(b);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return Buffer.concat(chunks);
}
async function writeAtomic(s: SFTPWrapper, target: string, data: Buffer) {
  let mode = 0o644;
  try {
    mode = (await invoke<any>(s, "stat", target)).mode & 0o7777;
  } catch {}
  const tmp = posix.join(posix.dirname(target), ".nexus-" + randomUUID());
  try {
    await new Promise<void>((resolve, reject) => {
      const w = s.createWriteStream(tmp, { flags: "wx", mode });
      w.on("error", reject);
      w.on("close", resolve);
      w.end(data);
    });
    await replace(s, tmp, target);
  } catch (e) {
    await invoke(s, "unlink", tmp).catch(() => {});
    throw e;
  }
}
// Minimal streaming tar (ustar with GNU long names), gzip-compressed by the caller.
function tarHeader(
  name: string,
  size: number,
  mode: number,
  mtime: number,
  type: "0" | "5" | "L",
) {
  const h = Buffer.alloc(512);
  const put = (v: string, at: number, len: number) =>
    h.write(v.slice(0, len), at, len, "utf8");
  const oct = (v: number, at: number, len: number) =>
    put(v.toString(8).padStart(len - 1, "0") + "\0", at, len);
  put(name, 0, 100);
  oct(mode & 0o7777, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(Math.floor(mtime), 136, 12);
  h.fill(" ", 148, 156);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  oct(sum, 148, 7);
  return h;
}
function tarEntry(
  name: string,
  size: number,
  mode: number,
  mtime: number,
  type: "0" | "5",
) {
  const raw = Buffer.from(name, "utf8");
  if (raw.length <= 100) return tarHeader(name, size, mode, mtime, type);
  const long = Buffer.concat([raw, Buffer.alloc(1)]);
  const pad = Buffer.alloc((512 - (long.length % 512)) % 512);
  return Buffer.concat([
    tarHeader("././@LongLink", long.length, 0, 0, "L"),
    long,
    pad,
    tarHeader(raw.subarray(0, 100).toString("utf8"), size, mode, mtime, type),
  ]);
}

@ApiTags("SFTP")
@Controller("api/sftp/:serverId")
export class SftpController {
  @Get("list") async list(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Query("path") dir?: string,
  ) {
    const { sftp, root } = await open(req, id, "ssh_list_directory");
    try {
      const real = await safePath(sftp, root, dir || root);
      const entries = await list(sftp, real);
      return {
        path: real,
        root: await invoke<string>(sftp, "realpath", root),
        entries: entries.slice(0, 5000),
        truncated: entries.length > 5000,
      };
    } catch (e) {
      failure(e);
    }
  }
  @Get("search") async search(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Query("path") dir: string,
    @Query("q") q: string,
  ) {
    const term = z.string().trim().min(1).max(200).parse(q).toLowerCase();
    const { sftp, root } = await open(req, id, "ssh_list_directory");
    try {
      const matches: { path: string; directory: boolean; size: number }[] = [];
      for await (const { path: p, entry } of walk(
        sftp,
        await safePath(sftp, root, dir || root),
      )) {
        if (entry.name.toLowerCase().includes(term))
          matches.push({
            path: p,
            directory: entry.directory,
            size: entry.size,
          });
        if (matches.length >= 200) break;
      }
      return { matches };
    } catch (e) {
      failure(e);
    }
  }
  @Get("read") async read(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Query("path") file: string,
  ) {
    const { sftp, root } = await open(req, id, "ssh_read_file");
    try {
      const real = await safePath(sftp, root, path.parse(file));
      const stat = await invoke<any>(sftp, "stat", real);
      if (!stat.isFile()) throw new BadRequestException("Not a regular file");
      if (stat.size > EDIT_LIMIT)
        throw new BadRequestException(
          "File is too large to edit here (5 MB limit); download it instead",
        );
      const data = await readAll(sftp, real, EDIT_LIMIT);
      if (data.subarray(0, 8192).includes(0))
        throw new BadRequestException(
          "This looks like a binary file; download it instead",
        );
      return { path: real, content: data.toString("utf8"), size: data.length };
    } catch (e) {
      failure(e);
    }
  }
  @Post("write") async write(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z
      .object({ path, content: z.string().max(EDIT_LIMIT) })
      .strict()
      .parse(body);
    const { p, sftp, root } = await open(req, id, "ssh_write_file");
    try {
      const target = await safePath(sftp, root, a.path, true);
      await writeAtomic(sftp, target, Buffer.from(a.content, "utf8"));
      await audit(p, "sftp_write", "success", id);
      return { path: target, bytes: Buffer.byteLength(a.content) };
    } catch (e) {
      failure(e);
    }
  }
  @Post("mkdir") async mkdir(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z.object({ path }).strict().parse(body);
    const { p, sftp, root } = await open(req, id, "ssh_create_directory");
    try {
      const target = await safePath(sftp, root, a.path, true);
      await invoke(sftp, "mkdir", target, { mode: 0o755 });
      await audit(p, "sftp_mkdir", "success", id);
      return { path: target };
    } catch (e) {
      failure(e);
    }
  }
  @Post("delete") async remove(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z
      .object({ paths: z.array(path).min(1).max(500) })
      .strict()
      .parse(body);
    const { p, sftp, root } = await open(req, id, "ssh_delete_file");
    try {
      let removed = 0;
      for (const item of a.paths) {
        const target = await entryPath(sftp, root, item);
        const stat = await invoke<any>(sftp, "lstat", target);
        if (stat.isDirectory()) {
          const all: { path: string; entry: Entry }[] = [];
          for await (const x of walk(sftp, target)) all.push(x);
          // Children first: files, then directories deepest first.
          for (const x of all.reverse()) {
            await invoke(
              sftp,
              x.entry.directory && !x.entry.symlink ? "rmdir" : "unlink",
              x.path,
            );
            removed++;
          }
          await invoke(sftp, "rmdir", target);
        } else await invoke(sftp, "unlink", target);
        removed++;
      }
      await audit(p, "sftp_delete", "success", id);
      return { removed };
    } catch (e) {
      failure(e);
    }
  }
  @Post("rename") async rename(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z.object({ path, destination: path }).strict().parse(body);
    const { p, sftp, root } = await open(req, id, "ssh_rename_file");
    try {
      const from = await entryPath(sftp, root, a.path);
      const to = await safePath(sftp, root, a.destination, true);
      await invoke(sftp, "rename", from, to);
      await audit(p, "sftp_rename", "success", id);
      return { path: to };
    } catch (e) {
      failure(e);
    }
  }
  @Post("chmod") async chmod(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z
      .object({
        paths: z.array(path).min(1).max(500),
        mode: z.number().int().min(0).max(0o7777),
      })
      .strict()
      .parse(body);
    const { p, sftp, root } = await open(req, id, "ssh_write_file");
    try {
      for (const item of a.paths)
        await invoke(sftp, "chmod", await safePath(sftp, root, item), a.mode);
      await audit(p, "sftp_chmod", "success", id);
      return { mode: a.mode };
    } catch (e) {
      failure(e);
    }
  }
  // Resumable chunked upload: each chunk is written at its offset into a hidden
  // part file next to the target, which replaces the target after the last chunk.
  @Get("upload") async uploadStatus(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Query("path") file: string,
    @Query("uploadId") uploadId: string,
  ) {
    const { sftp, root } = await open(req, id, "ssh_upload_file");
    try {
      const target = await safePath(sftp, root, path.parse(file), true);
      const part = posix.join(
        posix.dirname(target),
        ".nexus-part-" +
          z
            .string()
            .regex(/^[a-f0-9]{32}$/)
            .parse(uploadId),
      );
      const stat = await invoke<any>(sftp, "stat", part).catch(() => null);
      return { offset: stat?.size ?? 0 };
    } catch (e) {
      failure(e);
    }
  }
  @Post("upload") async upload(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Query() query: unknown,
  ) {
    const q = z
      .object({
        path,
        uploadId: z.string().regex(/^[a-f0-9]{32}$/),
        offset: z.coerce.number().int().min(0),
        size: z.coerce.number().int().min(0).max(config.SFTP_MAX_FILE_BYTES),
        cancel: z.literal("1").optional(),
      })
      .parse(query);
    const { p, sftp, root } = await open(req, id, "ssh_upload_file");
    try {
      const target = await safePath(sftp, root, q.path, true);
      const part = posix.join(
        posix.dirname(target),
        ".nexus-part-" + q.uploadId,
      );
      if (q.cancel) {
        await invoke(sftp, "unlink", part).catch(() => {});
        return { cancelled: true };
      }
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        const w = sftp.createWriteStream(part, {
          flags: q.offset ? "r+" : "w",
          start: q.offset,
          mode: 0o600,
        });
        w.on("error", reject);
        w.on("close", resolve);
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > CHUNK_LIMIT || q.offset + received > q.size) {
            req.destroy();
            w.destroy();
            reject(
              new BadRequestException("Chunk does not match the declared size"),
            );
          }
        });
        req.on("error", reject);
        req.pipe(w);
      });
      const offset = q.offset + received;
      if (offset < q.size) return { offset };
      let mode = 0o644;
      try {
        mode = (await invoke<any>(sftp, "stat", target)).mode & 0o7777;
      } catch {}
      await invoke(sftp, "chmod", part, mode);
      await replace(sftp, part, target);
      await audit(p, "sftp_upload", "success", id);
      return { offset, done: true, path: target };
    } catch (e) {
      failure(e);
    }
  }
  // One file streams as-is; a folder or several items stream as a .tar.gz.
  @Get("download") async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param("serverId") id: string,
    @Query("path") raw: string | string[],
  ) {
    const paths = z.array(path).min(1).max(500).parse([raw].flat());
    const { p, sftp, root } = await open(req, id, "ssh_download_file");
    try {
      const items = await Promise.all(
        paths.map(async (item) => {
          const real = await safePath(sftp, root, item);
          return {
            real,
            name: posix.basename(item),
            stat: await invoke<any>(sftp, "stat", real),
          };
        }),
      );
      const disposition = (name: string) =>
        `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
      if (items.length === 1 && items[0].stat.isFile()) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(items[0].stat.size));
        res.setHeader("Content-Disposition", disposition(items[0].name));
        await audit(p, "sftp_download", "success", id);
        await pipeline(sftp.createReadStream(items[0].real), res);
        return;
      }
      const archive =
        (items.length === 1 ? items[0].name : "download") + ".tar.gz";
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", disposition(archive));
      await audit(p, "sftp_download", "success", id);
      const gzip = createGzip();
      const done = pipeline(gzip, res);
      const write = (b: Buffer) =>
        gzip.write(b)
          ? Promise.resolve()
          : new Promise<void>((r) => gzip.once("drain", r));
      const addFile = async (
        file: string,
        name: string,
        size: number,
        mode: number,
        mtime: number,
      ) => {
        await write(tarEntry(name, size, mode, mtime, "0"));
        let sent = 0;
        for await (const chunk of sftp.createReadStream(
          file,
        ) as AsyncIterable<Buffer>) {
          const part = chunk.subarray(0, Math.max(0, size - sent));
          sent += part.length;
          if (part.length) await write(part);
        }
        // Keep the archive valid if the file shrank while it was read.
        if (sent < size) await write(Buffer.alloc(size - sent));
        await write(Buffer.alloc((512 - (size % 512)) % 512));
      };
      for (const item of items) {
        if (item.stat.isFile()) {
          await addFile(
            item.real,
            item.name,
            item.stat.size,
            item.stat.mode,
            item.stat.mtime,
          );
          continue;
        }
        await write(
          tarEntry(item.name + "/", 0, item.stat.mode, item.stat.mtime, "5"),
        );
        for await (const { path: full, entry } of walk(sftp, item.real)) {
          const name = item.name + "/" + posix.relative(item.real, full);
          if (entry.symlink) continue;
          if (entry.directory)
            await write(
              tarEntry(name + "/", 0, entry.mode, entry.modifiedAt, "5"),
            );
          else
            await addFile(full, name, entry.size, entry.mode, entry.modifiedAt);
        }
      }
      gzip.end(Buffer.alloc(1024));
      await done;
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      try {
        failure(e);
      } catch (err) {
        const status = err instanceof BadRequestException ? 400 : 500;
        res.status(status).json({ message: (err as Error).message });
      }
    }
  }
  // Copies or moves items to a folder on this or another server.
  @Post("transfer") async transfer(
    @Req() req: Request,
    @Param("serverId") id: string,
    @Body() body: unknown,
  ) {
    const a = z
      .object({
        paths: z.array(path).min(1).max(500),
        toServerId: z.uuid(),
        toPath: path,
        move: z.boolean().default(false),
      })
      .strict()
      .parse(body);
    const src = await open(
      req,
      id,
      a.move ? "ssh_delete_file" : "ssh_download_file",
    );
    if (a.move) await authorize(src.p, id, "ssh_download_file");
    const dst =
      a.toServerId === id
        ? src
        : await open(req, a.toServerId, "ssh_upload_file");
    if (a.toServerId === id) await authorize(src.p, id, "ssh_upload_file");
    try {
      const destDir = await safePath(dst.sftp, dst.root, a.toPath);
      let copied = 0;
      for (const item of a.paths) {
        const from = await entryPath(src.sftp, src.root, item);
        const to = await safePath(
          dst.sftp,
          dst.root,
          posix.join(destDir, posix.basename(from)),
          true,
        );
        if (a.move && a.toServerId === id) {
          await invoke(src.sftp, "rename", from, to);
          copied++;
          continue;
        }
        const copyFile = async (f: string, t: string, mode: number) => {
          const tmp = posix.join(posix.dirname(t), ".nexus-" + randomUUID());
          await pipeline(
            src.sftp.createReadStream(f),
            dst.sftp.createWriteStream(tmp, {
              flags: "wx",
              mode: mode & 0o7777,
            }),
          );
          await replace(dst.sftp, tmp, t);
          copied++;
        };
        const stat = await invoke<any>(src.sftp, "lstat", from);
        if (stat.isDirectory()) {
          await invoke(dst.sftp, "mkdir", to, {
            mode: stat.mode & 0o7777,
          }).catch(() => {});
          for await (const { path: full, entry } of walk(src.sftp, from)) {
            const target = posix.join(to, posix.relative(from, full));
            if (entry.symlink) continue;
            if (entry.directory)
              await invoke(dst.sftp, "mkdir", target, {
                mode: entry.mode & 0o7777,
              }).catch(() => {});
            else await copyFile(full, target, entry.mode);
          }
        } else if (stat.isFile()) await copyFile(from, to, stat.mode);
        if (a.move) {
          const all: { path: string; entry: Entry }[] = [];
          if (stat.isDirectory())
            for await (const x of walk(src.sftp, from)) all.push(x);
          for (const x of all.reverse())
            await invoke(
              src.sftp,
              x.entry.directory && !x.entry.symlink ? "rmdir" : "unlink",
              x.path,
            );
          await invoke(src.sftp, stat.isDirectory() ? "rmdir" : "unlink", from);
        }
      }
      await audit(src.p, a.move ? "sftp_move" : "sftp_copy", "success", id);
      if (a.toServerId !== id)
        await audit(src.p, "sftp_receive", "success", a.toServerId);
      return { copied };
    } catch (e) {
      failure(e);
    }
  }
}
