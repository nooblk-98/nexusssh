import { createHash } from "node:crypto";
export const fileVersion = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const locks = new Map<string, Promise<void>>();
export async function withFileLock<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
