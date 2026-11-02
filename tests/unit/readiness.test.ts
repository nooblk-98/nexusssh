import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  database: vi.fn(async () => 1),
  get: vi.fn(async (_key: string): Promise<string | null> =>
    String(Date.now()),
  ),
}));
vi.mock("../../packages/database/index.js", () => ({
  db: { $queryRaw: f.database },
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: { VPN_GATEWAY_URL: "http://gateway.test" },
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  queue: { client: Promise.resolve({ get: f.get }) },
}));
import { boundedCheck, readiness } from "../../apps/api/src/readiness.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("requires database, Redis, a live worker heartbeat and the VPN gateway", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true })),
  );
  expect(await readiness()).toMatchObject({
    status: "ready",
    checks: { database: true, redis: true, worker: true, vpn: true },
  });
  f.get.mockImplementation(async (key) =>
    key.includes("heartbeat") ? String(Date.now() - 60000) : null,
  );
  expect(await readiness()).toMatchObject({
    status: "degraded",
    checks: { worker: false },
  });
});
it("bounds hung checks and handles rejected dependency checks", async () => {
  await expect(boundedCheck(() => new Promise(() => {}), 10)).resolves.toBe(
    false,
  );
  await expect(
    boundedCheck(async () => {
      throw new Error("unavailable");
    }),
  ).resolves.toBe(false);
});
