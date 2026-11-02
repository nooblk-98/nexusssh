import { beforeEach, expect, it, vi } from "vitest";
import type { Request } from "express";
const f = vi.hoisted(() => ({ session: {} as any, mapping: vi.fn() }));
vi.mock("../../packages/database/index.js", () => ({
  db: {
    webSession: { findUnique: async () => f.session },
    oidcIdentity: { findFirst: f.mapping },
  },
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: {},
  mcpAudience: "test",
}));
import { authenticate } from "../../apps/api/src/auth.js";
const req = {
  headers: {},
  cookies: { nexus_session: "opaque-session" },
} as unknown as Request;
beforeEach(() => {
  f.mapping.mockReset();
  f.session = {
    userId: "user",
    expiresAt: new Date(Date.now() + 10000),
    user: { disabled: false, organizationId: "org", role: "operator" },
    oidcIdentityId: "mapping",
  };
});
it("rejects an SSO session after its mapping is removed, including late-created sessions", async () => {
  f.mapping.mockResolvedValue(null);
  await expect(authenticate(req)).rejects.toThrow("no longer authorized");
  f.mapping.mockResolvedValue({ id: "mapping", userId: "user" });
  await expect(authenticate(req)).resolves.toMatchObject({
    id: "user",
    organizationId: "org",
  });
});
it("keeps local sessions independent of provider mappings", async () => {
  f.session.oidcIdentityId = null;
  await expect(authenticate(req)).resolves.toMatchObject({ id: "user" });
  expect(f.mapping).not.toHaveBeenCalled();
});
