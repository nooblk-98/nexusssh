import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { seal } from "../../packages/shared/crypto.js";
import { totp } from "../../apps/api/src/totp.js";
const f = vi.hoisted(() => ({
  store: new Map<string, string>(),
  user: undefined as any,
  mapping: undefined as any,
  authorize: vi.fn(),
  session: vi.fn(),
  audit: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../packages/shared/config.js", () => ({
  config: {
    APP_URL: "https://nexus.example.test",
    OIDC_ISSUER: "https://idp.example.test",
    OIDC_CLIENT_ID: "client",
    OIDC_CLIENT_SECRET: "fixture",
    OIDC_LABEL: "SSO",
    ENCRYPTION_KEY: "ab".repeat(32),
  },
}));
vi.mock("openid-client", () => ({
  discovery: async () => ({
    serverMetadata: () => ({ issuer: "https://idp.example.test" }),
  }),
  randomState: () => crypto.randomUUID(),
  randomNonce: () => crypto.randomUUID(),
  randomPKCECodeVerifier: () => crypto.randomUUID(),
  calculatePKCECodeChallenge: async (v: string) => "challenge-" + v,
  buildAuthorizationUrl: (_: unknown, params: Record<string, string>) =>
    new URL("https://idp.example.test/auth?" + new URLSearchParams(params)),
  authorizationCodeGrant: f.authorize,
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  audit: f.audit,
  queue: {
    client: Promise.resolve({
      set: async (key: string, value: string) => {
        f.store.set(key, value);
      },
      get: async (key: string) => f.store.get(key) ?? null,
      defineCommand: () => {},
      runCommand: async (_: string, [key, expected]: string[]) => {
        if (f.store.get(key) !== expected) return 0;
        f.store.delete(key);
        return 1;
      },
    }),
  },
}));
vi.mock("../../packages/database/index.js", () => ({
  db: {
    oidcIdentity: {
      findUnique: async () => f.mapping,
      findFirst: async () => f.mapping,
    },
    user: { findUnique: async () => f.user, updateMany: f.update },
  },
}));
vi.mock("../../apps/api/src/sessions.js", () => ({
  createWebSession: f.session,
}));
import { OidcController } from "../../apps/api/src/oidc.js";
const controller = new OidcController();
function response() {
  const cookies: Record<string, string> = {};
  const res = {
    cookie: vi.fn((key, value) => {
      cookies[key] = value;
    }),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };
  return { res: res as unknown as Response, cookies, redirect: res.redirect };
}
async function start() {
  const r = response();
  await controller.start(r.res);
  const url = new URL(r.redirect.mock.calls[0][0]);
  return {
    state: url.searchParams.get("state")!,
    browser: r.cookies.nexus_oidc,
    url,
  };
}
function request(
  flow: Awaited<ReturnType<typeof start>>,
  browser = flow.browser,
) {
  return {
    query: { state: flow.state, code: "fixture-code" },
    cookies: { nexus_oidc: browser },
  } as unknown as Request;
}
beforeEach(() => {
  f.store.clear();
  vi.clearAllMocks();
  f.user = {
    id: randomUUID(),
    organizationId: randomUUID(),
    role: "operator",
    disabled: false,
    totpSecret: null,
    recoveryCodes: "[]",
  };
  f.mapping = { id: randomUUID(), userId: f.user.id };
  f.authorize.mockResolvedValue({
    claims: () => ({ iss: "https://idp.example.test", sub: "subject" }),
  });
  f.update.mockResolvedValue({ count: 1 });
});
describe("OIDC authorization flow", () => {
  it("binds PKCE, nonce, state and browser, consumes once and signs in only a mapped account", async () => {
    const flow = await start();
    const r = response();
    expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
    await controller.callback(request(flow), r.res);
    expect(f.authorize.mock.calls[0][2]).toMatchObject({
      expectedState: flow.state,
      expectedNonce: expect.any(String),
      pkceCodeVerifier: expect.any(String),
      idTokenExpected: true,
    });
    expect(f.session).toHaveBeenCalledTimes(1);
    await controller.callback(request(flow), response().res);
    expect(f.session).toHaveBeenCalledTimes(1);
  });
  it("rejects a different browser without consuming the legitimate login", async () => {
    const flow = await start();
    await controller.callback(request(flow, "attacker"), response().res);
    expect(f.authorize).not.toHaveBeenCalled();
    await controller.callback(request(flow), response().res);
    expect(f.session).toHaveBeenCalledTimes(1);
  });
  it.each(["unmapped", "disabled", "invalid-token"])(
    "rejects %s without creating a session",
    async (kind) => {
      const flow = await start();
      if (kind === "unmapped") f.mapping = null;
      if (kind === "disabled") f.user.disabled = true;
      if (kind === "invalid-token")
        f.authorize.mockRejectedValueOnce(new Error("invalid signature"));
      const r = response();
      await controller.callback(request(flow), r.res);
      expect(f.session).not.toHaveBeenCalled();
      expect(r.redirect).toHaveBeenCalledWith(
        "https://nexus.example.test/?sso=failed",
      );
    },
  );
  it("requires local MFA, rejects replay and checks that the identity mapping still exists", async () => {
    const key = "ABCDEFGHIJKLMNOPQRSTUVWX234567AB";
    f.user.totpSecret = seal(key, "ab".repeat(32), f.user.id);
    const flow = await start(),
      r = response();
    await controller.callback(request(flow), r.res);
    expect(f.session).not.toHaveBeenCalled();
    const req = {
      cookies: { nexus_oidc_mfa: r.cookies.nexus_oidc_mfa },
    } as unknown as Request;
    const code = totp(key, Math.floor(Date.now() / 30000));
    await controller.complete(req, response().res, { code });
    expect(f.session).toHaveBeenCalledTimes(1);
    await expect(
      controller.complete(req, response().res, { code }),
    ).rejects.toThrow("expired");
    const flow2 = await start(),
      r2 = response();
    await controller.callback(request(flow2), r2.res);
    f.mapping = null;
    await expect(
      controller.complete(
        {
          cookies: { nexus_oidc_mfa: r2.cookies.nexus_oidc_mfa },
        } as unknown as Request,
        response().res,
        { code },
      ),
    ).rejects.toThrow("expired");
    expect(f.session).toHaveBeenCalledTimes(1);
  });
});
