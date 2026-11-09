import type { Request } from "express";
import type { Principal } from "../../../packages/policy-engine/index.js";

export type RevalidatedShell = {
  serverId: string;
  sessionId: string;
  authReq: Request;
};
export type RevalidateDeps = {
  authenticate(req: Request): Promise<Principal>;
  authorize(p: Principal, serverId: string): Promise<unknown>;
  // Ids among those given whose terminal session row is still active.
  activeSessions(ids: string[]): Promise<Set<string>>;
};
// One pass over every open shell: a single session-status query for all of
// them, one authentication per browser session and one authorization per
// person and server, instead of three queries per shell every few seconds.
// Returns the shells that must end. Any failure fails closed for the shells
// it covers, as the per-shell check did.
export async function revalidateShells<T extends RevalidatedShell>(
  shells: T[],
  deps: RevalidateDeps,
): Promise<T[]> {
  if (!shells.length) return [];
  let active: Set<string>;
  try {
    active = await deps.activeSessions([...new Set(shells.map((s) => s.sessionId))]);
  } catch {
    return shells;
  }
  const principals = new Map<unknown, Promise<Principal>>();
  const grants = new Map<string, Promise<unknown>>();
  const verdicts = await Promise.all(
    shells.map(async (shell) => {
      if (!active.has(shell.sessionId)) return false;
      try {
        // Users authenticate by session cookie alone, so shells opened from
        // the same browser session share one lookup.
        const cookie: unknown = shell.authReq.cookies?.nexus_session;
        const key = typeof cookie === "string" && cookie ? cookie : shell.authReq;
        let principal = principals.get(key);
        if (!principal) principals.set(key, (principal = deps.authenticate(shell.authReq)));
        const fresh = await principal;
        const grantKey = fresh.id + ":" + shell.serverId;
        let grant = grants.get(grantKey);
        if (!grant) grants.set(grantKey, (grant = deps.authorize(fresh, shell.serverId)));
        await grant;
        return true;
      } catch {
        return false;
      }
    }),
  );
  return shells.filter((_, i) => !verdicts[i]);
}
