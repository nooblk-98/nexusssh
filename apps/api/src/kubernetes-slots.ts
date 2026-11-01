import { HttpException } from "@nestjs/common";
const active = new Map<string, number>();
export async function withKubernetesSlot<T>(
  organizationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const count = active.get(organizationId) || 0;
  if (count >= 4)
    throw new HttpException(
      "Too many active Kubernetes requests. Try again shortly.",
      429,
    );
  active.set(organizationId, count + 1);
  try {
    return await work();
  } finally {
    const left = (active.get(organizationId) || 1) - 1;
    if (left) active.set(organizationId, left);
    else active.delete(organizationId);
  }
}
