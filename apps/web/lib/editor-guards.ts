export const editorGuards = new Map<string, () => Promise<boolean>>();
let pending = Promise.resolve(true);
export function confirmEditorClose(id: string): Promise<boolean> {
  const next = pending.then(() => editorGuards.get(id)?.() ?? true);
  pending = next.catch(() => false);
  return next;
}
