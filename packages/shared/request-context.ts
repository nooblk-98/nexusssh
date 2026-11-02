import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const requestContext = new AsyncLocalStorage<{
  correlationId: string;
}>();
export const correlationId = () =>
  requestContext.getStore()?.correlationId ?? randomUUID();
// Only explicit metadata: never log credentials, request bodies or remote output.
export function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event,
      correlationId: correlationId(),
      ...fields,
    }),
  );
}
