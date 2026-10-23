import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { db } from "../../../packages/database/index.js";
import { preflightAffected } from "./metadata.js";
import { closeSftp } from "./sftp.js";

function subtreeServerIds(folders: { id: string; parentId: string | null }[], servers: { id: string; groupId: string | null }[], root: string) {
  const members = new Set([root]);
  let size = -1;
  while (size !== members.size) {
    size = members.size;
    for (const folder of folders) if (folder.parentId && members.has(folder.parentId)) members.add(folder.id);
  }
  return servers.filter((server) => server.groupId && members.has(server.groupId)).map((server) => server.id);
}

export async function saveFolder(
  organizationId: string,
  input: { name?: string; parentId?: string | null },
  id?: string,
) {
  const result = await db.$transaction(async (tx) => {
    const folders = await tx.serverGroup.findMany({
      where: { organizationId },
    });
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const current = id ? byId.get(id) : undefined;
    if (id && !current) throw new NotFoundException("Folder unavailable");
    const name = input.name ?? current!.name;
    const parentId =
      input.parentId === undefined
        ? (current?.parentId ?? null)
        : input.parentId;
    const visited = new Set<string>();
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === id || visited.has(ancestor))
        throw new BadRequestException(
          "A folder cannot be moved inside itself or its subfolders",
        );
      visited.add(ancestor);
      const parent = byId.get(ancestor);
      if (!parent) throw new BadRequestException("Parent folder unavailable");
      ancestor = parent.parentId;
    }
    if (
      folders.some(
        (f) => f.id !== id && f.parentId === parentId && f.name === name,
      )
    )
      throw new ConflictException(
        "A folder with this name already exists in the destination",
      );
    const affected = id && current?.parentId !== parentId
      ? subtreeServerIds(folders, await tx.server.findMany({ where: { organizationId }, select: { id: true, groupId: true } }), id)
      : [];
    const folder = id
      ? await tx.serverGroup.update({ where: { id }, data: { name, parentId } })
      : await tx.serverGroup.create({ data: { organizationId, name, parentId } });
    const invalidated = affected.length ? await preflightAffected(tx, organizationId, affected) : [];
    return { folder, invalidated };
  });
  for (const serverId of result.invalidated) closeSftp(serverId);
  return result.folder;
}

export async function deleteFolder(organizationId: string, id: string) {
  const affected = await db.$transaction(async (tx) => {
    const folders = await tx.serverGroup.findMany({
      where: { organizationId },
    });
    if (!folders.some((f) => f.id === id))
      throw new NotFoundException("Folder unavailable");
    const topLevelNames = new Set(
      folders.filter((f) => f.id !== id && !f.parentId).map((f) => f.name),
    );
    const children = folders.filter((f) => f.parentId === id);
    if (children.some((child) => topLevelNames.has(child.name)))
      throw new ConflictException(
        "Rename or move subfolders that share a name with a top-level folder before deleting this folder",
      );
    const impacted = subtreeServerIds(folders, await tx.server.findMany({ where: { organizationId }, select: { id: true, groupId: true } }), id);
    await tx.server.updateMany({
      where: { groupId: id, organizationId },
      data: { groupId: null },
    });
    // The self-relation promotes direct children after removing this row.
    // This also allows a child to take its deleted parent's top-level name.
    await tx.serverGroup.delete({ where: { id } });
    return impacted.length ? preflightAffected(tx, organizationId, impacted) : [];
  });
  for (const serverId of affected) closeSftp(serverId);
}
