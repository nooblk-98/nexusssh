import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
const f = vi.hoisted(() => ({
  authorize: vi.fn(),
  connect: vi.fn(),
  resolve: vi.fn(),
  prepare: vi.fn(),
  connection: {} as any,
}));
vi.mock("../../apps/api/src/auth.js", () => ({
  authenticate: async () => ({ id: "person", organizationId: "org" }),
  human: () => {},
}));
vi.mock("../../apps/api/src/domain.js", () => ({
  audit: vi.fn(async () => {}),
  authorize: f.authorize,
  connection: async () => f.connection,
  sshLimits: async () => ({ cidrs: ["10.0.0.0/8"] }),
}));
vi.mock("../../apps/api/src/health.js", () => ({
  healthFailureCategory: () => "route",
}));
vi.mock("../../packages/ssh-core/index.js", () => ({
  connect: f.connect,
  resolveAllowed: f.resolve,
}));
vi.mock("../../packages/ssh-core/vpn.js", () => ({ prepareVpn: f.prepare }));
import { DiagnosticsController } from "../../apps/api/src/diagnostics.js";
const controller = new DiagnosticsController(),
  req = {} as Request;
beforeEach(() => {
  vi.resetAllMocks();
  f.connection = {
    host: "app.test",
    port: 22,
    username: "app",
    fingerprint: "pinned",
  };
  f.connect.mockResolvedValue({ end: vi.fn() });
});
it("verifies authentication without executing a command and labels unused route stages", async () => {
  const result = await controller.diagnose(req, randomUUID());
  expect(result.authenticationVerified).toBe(true);
  expect(result.steps.map((s) => s.status)).toEqual([
    "passed",
    "skipped",
    "passed",
    "skipped",
    "passed",
  ]);
  expect(f.connect).toHaveBeenCalledTimes(1);
});
it("stops at a failed VPN stage and does not claim downstream checks succeeded", async () => {
  f.connection.vpn = { id: "vpn" };
  f.prepare.mockRejectedValue(new Error("unavailable"));
  const result = await controller.diagnose(req, randomUUID());
  expect(result.authenticationVerified).toBe(false);
  expect(result.steps.map((s) => s.status)).toEqual([
    "passed",
    "failed",
    "not_run",
    "not_run",
    "not_run",
  ]);
  expect(result.steps[1].action).toContain("VPN");
  expect(f.connect).not.toHaveBeenCalled();
});
it("checks permissions before opening any outbound connection", async () => {
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(controller.diagnose(req, randomUUID())).rejects.toThrow(
    "denied",
  );
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});
