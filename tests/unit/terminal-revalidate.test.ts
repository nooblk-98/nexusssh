import { expect, it, vi } from "vitest";
import type { Request } from "express";
import { revalidateShells } from "../../apps/api/src/terminal-revalidate.js";

const req = (cookie?: string) => ({ cookies: cookie ? { nexus_session: cookie } : {} }) as unknown as Request;
const principal = (id: string) => ({ id, organizationId: "org", kind: "user", role: "member", scopes: [] }) as any;

it("uses one status query, one authentication per browser session and one grant per server", async () => {
  const browser = req("cookie-a");
  const shells = [
    { serverId: "s1", sessionId: "a", authReq: browser },
    { serverId: "s1", sessionId: "b", authReq: req("cookie-a") },
    { serverId: "s2", sessionId: "c", authReq: browser },
  ];
  const deps = {
    authenticate: vi.fn(async () => principal("u1")),
    authorize: vi.fn(async () => {}),
    activeSessions: vi.fn(async (ids: string[]) => new Set(ids)),
  };
  await expect(revalidateShells(shells, deps)).resolves.toEqual([]);
  expect(deps.activeSessions).toHaveBeenCalledOnce();
  expect(deps.activeSessions).toHaveBeenCalledWith(["a", "b", "c"]);
  expect(deps.authenticate).toHaveBeenCalledOnce();
  expect(deps.authorize).toHaveBeenCalledTimes(2);
});
it("ends terminated, signed-out and unauthorized shells only", async () => {
  const shells = [
    { serverId: "s1", sessionId: "terminated", authReq: req("ok") },
    { serverId: "s1", sessionId: "signed-out", authReq: req("expired") },
    { serverId: "revoked", sessionId: "unauthorized", authReq: req("ok") },
    { serverId: "s1", sessionId: "healthy", authReq: req("ok") },
  ];
  const stale = await revalidateShells(shells, {
    authenticate: async (r) => {
      if (r.cookies.nexus_session === "expired") throw new Error("Unauthorized");
      return principal("u1");
    },
    authorize: async (_, serverId) => {
      if (serverId === "revoked") throw new Error("Forbidden");
    },
    activeSessions: async () => new Set(["signed-out", "unauthorized", "healthy"]),
  });
  expect(stale.map((s) => s.sessionId)).toEqual(["terminated", "signed-out", "unauthorized"]);
});
it("fails closed when the status query fails", async () => {
  const shells = [{ serverId: "s1", sessionId: "a", authReq: req("ok") }];
  const stale = await revalidateShells(shells, {
    authenticate: async () => principal("u1"),
    authorize: async () => {},
    activeSessions: async () => { throw new Error("database unavailable"); },
  });
  expect(stale).toEqual(shells);
});
it("does not share authentication between requests without a session cookie", async () => {
  const authenticate = vi.fn(async () => { throw new Error("Unauthorized"); });
  const shells = [
    { serverId: "s1", sessionId: "a", authReq: req() },
    { serverId: "s1", sessionId: "b", authReq: req() },
  ];
  const stale = await revalidateShells(shells, { authenticate, authorize: async () => {}, activeSessions: async (ids) => new Set(ids) });
  expect(stale).toHaveLength(2);
  expect(authenticate).toHaveBeenCalledTimes(2);
});
