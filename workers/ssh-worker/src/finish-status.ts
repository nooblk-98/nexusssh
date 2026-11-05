export type FinishStatus = "completed" | "failed" | "cancelled";
// The API reports the status it actually persisted. A cancellation that
// committed before finish wins, so the worker must not report success then.
// Older APIs answer only { ok: true }, which means the requested status stuck.
export function finishedStatus(
  response: { status?: unknown } | undefined,
  requested: FinishStatus,
): FinishStatus {
  const status = response?.status;
  return status === "completed" || status === "failed" || status === "cancelled"
    ? status
    : requested;
}
