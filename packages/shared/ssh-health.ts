export const SSH_HEALTH_STALE_MS = 30 * 60_000;
export const SSH_HEALTH_RETRY_MS = 60_000;

// A failed route, permission check or local setup does not establish that the
// destination host is offline. Normalize older stored results as well.
const unavailable = new Set([
  "route",
  "policy",
  "dns",
  "configuration",
  "permission_changed",
  "queue_unavailable",
  "unavailable",
  "connection_failed",
]);
export function sshHealthState(
  server: {
    status?: string;
    lastCheckedAt?: Date | string | null;
    healthFailureCategory?: string | null;
  },
  now = Date.now(),
): "reachable" | "unreachable" | "unknown" {
  const checked = server.lastCheckedAt
    ? new Date(server.lastCheckedAt).getTime()
    : NaN;
  if (!Number.isFinite(checked) || now - checked > SSH_HEALTH_STALE_MS)
    return "unknown";
  if (
    server.status === "unreachable" &&
    unavailable.has(server.healthFailureCategory || "")
  )
    return "unknown";
  return server.status === "reachable" || server.status === "unreachable"
    ? server.status
    : "unknown";
}
