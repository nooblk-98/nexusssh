export type Folder = { id: string; name: string; parentId?: string | null };

export function folderPath(folders: Folder[], id?: string | null): Folder[] {
  const path: Folder[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders.find((f) => f.id === id);
    if (!folder) break;
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}

export const folderLabel = (folders: Folder[], id?: string | null) =>
  folderPath(folders, id)
    .map((f) => f.name)
    .join(" / ");

export const folderOptions = (folders: Folder[]) =>
  folders
    .map((f) => ({ ...f, label: folderLabel(folders, f.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
