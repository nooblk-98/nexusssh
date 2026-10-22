import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { db } from "../../../packages/database/index.js";

export async function saveFolder(
  organizationId: string,
  input: { name?: string; parentId?: string | null },
  id?: string,
) {
  return db.$transaction(async (tx) => {
    const folders = await tx.serverGroup.findMany({
      where: { organizationId },
    });
    const current = id ? folders.find((f) => f.id === id) : undefined;
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
      const parent = folders.find((f) => f.id === ancestor);
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
    return id
      ? tx.serverGroup.update({ where: { id }, data: { name, parentId } })
      : tx.serverGroup.create({ data: { organizationId, name, parentId } });
  });
}

export async function deleteFolder(organizationId: string, id: string) {
  return db.$transaction(async (tx) => {
    const folders = await tx.serverGroup.findMany({
      where: { organizationId },
    });
    if (!folders.some((f) => f.id === id))
      throw new NotFoundException("Folder unavailable");
    const children = folders.filter((f) => f.parentId === id);
    if (
      children.some((child) =>
        folders.some(
          (f) => f.id !== id && !f.parentId && f.name === child.name,
        ),
      )
    )
      throw new ConflictException(
        "Rename or move subfolders that share a name with a top-level folder before deleting this folder",
      );
    await tx.server.updateMany({
      where: { groupId: id, organizationId },
      data: { groupId: null },
    });
    // The self-relation promotes direct children after removing this row.
    // This also allows a child to take its deleted parent's top-level name.
    await tx.serverGroup.delete({ where: { id } });
  });
}
