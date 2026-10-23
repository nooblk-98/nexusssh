import { z } from "zod";
import { readOperations, writeOperations } from "../policy-engine/index.js";
const id = z.uuid(),
  path = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (v) =>
        v.startsWith("/") && !v.includes("\0") && !v.split("/").includes(".."),
      "Absolute paths without traversal required",
    );
const target = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$/);
const common = {
  serverId: id,
  approvalId: id.optional(),
  async: z.boolean().default(false),
};
export const schemas: Record<string, z.ZodObject<any>> = {};
for (const op of [...readOperations, ...writeOperations])
  schemas[op] = z.object(common).strict();
schemas.servers_list = z.object({}).strict();
schemas.ssh_execute = z
  .object({
    ...common,
    command: z.string().min(1).max(8192),
    timeoutMs: z.number().int().min(100).max(60000).default(30000),
  })
  .strict();
for (const op of [
  "ssh_list_directory",
  "ssh_read_file",
  "ssh_download_file",
  "ssh_create_directory",
  "ssh_delete_file",
])
  schemas[op] = z.object({ ...common, path }).strict();
for (const op of ["ssh_write_file", "ssh_upload_file"])
  schemas[op] = z
    .object({
      ...common,
      path,
      content: z.string().max(1400000),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    })
    .strict();
schemas.ssh_rename_file = z
  .object({ ...common, path, destination: path })
  .strict();
for (const op of [
  "service_status",
  "service_start",
  "service_stop",
  "service_restart",
])
  schemas[op] = z.object({ ...common, service: target }).strict();
schemas.system_logs = z
  .object({
    ...common,
    service: target.optional(),
    lines: z.number().int().min(1).max(500).default(100),
  })
  .strict();
for (const op of ["task_status", "task_cancel"])
  schemas[op] = z.object({ taskId: id }).strict();
schemas.approval_get_status = z.object({ approvalId: id }).strict();
export function parseOperation(op: string, args: unknown): any {
  if (!schemas[op]) throw new Error("Unknown operation");
  return schemas[op].parse(args);
}
export function executionArgs(args: Record<string, unknown>) {
  const { approvalId: _approval, async: _async, ...rest } = args;
  return rest;
}
