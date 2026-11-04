import { describe, it, expect } from "vitest";
import { seal, unseal, canonical, hash } from "../../packages/shared/crypto.js";
import {
  permitted,
  needsApproval,
  readOperations,
  writeOperations,
  type Principal,
} from "../../packages/policy-engine/index.js";
import {
  allowedIP,
  inside,
  resolveAllowed,
} from "../../packages/ssh-core/index.js";
import { parseOperation, completedBatchResult, batchTokenAllowed } from "../../packages/shared/operations.js";
import { totp, verifyTotp, newTotp } from "../../apps/api/src/totp.js";
const p: Principal = {
  id: "a",
  organizationId: "o",
  kind: "agent",
  role: "operator",
  scopes: ["system_info", "ssh_execute"],
};
describe("credential encryption", () => {
  it("roundtrips and binds ciphertext to organization/identity", () => {
    const key = "ab".repeat(32);
    const value = seal({ password: "secret" }, key, "org:identity");
    expect(value).not.toContain("secret");
    expect(unseal(value, key, "org:identity")).toEqual({ password: "secret" });
    expect(() => unseal(value, key, "other:identity")).toThrow();
  });
  it("detects tampering", () => {
    const key = "ab".repeat(32),
      value = seal("secret", key, "context");
    expect(() =>
      unseal(value.slice(0, -6) + "AAAAAA", key, "context"),
    ).toThrow();
  });
});
describe("policy boundaries", () => {
  it("requires explicit agent scope and server grant", () => {
    expect(permitted(p, "o", "ssh_execute", [])).toBe(false);
    expect(permitted(p, "o", "ssh_execute", ["ssh_execute"])).toBe(true);
    expect(permitted(p, "other", "ssh_execute", ["ssh_execute"])).toBe(false);
    expect(
      permitted({ ...p, scopes: [] }, "o", "ssh_execute", ["ssh_execute"]),
    ).toBe(false);
  });
  it("never elevates viewer from grants", () =>
    expect(
      permitted({ ...p, role: "viewer" }, "o", "ssh_execute", ["ssh_execute"]),
    ).toBe(false));
  it("does not require human approval for any SSH operation", () => {
    for (const op of [...readOperations, ...writeOperations])
      expect(needsApproval(op)).toBe(false);
  });
  it("canonicalizes exact arguments", () => {
    expect(hash(canonical({ b: 2, a: 1 }))).toBe(
      hash(canonical({ a: 1, b: 2 })),
    );
    expect(hash(canonical({ command: "ls" }))).not.toBe(
      hash(canonical({ command: "ls; id" })),
    );
  });
  it("validates exact batch targets and rejects duplicates or oversized sets", () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    expect(parseOperation("ssh_execute_many", { serverIds: [a, b], command: "id" })).toMatchObject({
      serverIds: [a, b], command: "id", timeoutMs: 30000,
    });
    expect(() => parseOperation("ssh_execute_many", { serverIds: [a, a], command: "id" })).toThrow();
    expect(() => parseOperation("ssh_execute_many", { serverIds: Array(11).fill(a), command: "id" })).toThrow();
  });
  it("accepts only terminal worker output", () => {
    expect(() => completedBatchResult({ status: "queued", taskId: crypto.randomUUID() })).toThrow();
    expect(() => completedBatchResult({ status: "failed" })).toThrow();
    expect(completedBatchResult({ status: "completed", stdout: "x".repeat(20000) })).toMatchObject({ status: "completed", stdout: "x".repeat(16384) });
  });
  it("requires the original execution token and both batch and command scopes", () => {
    const original = crypto.randomUUID();
    const scopes = ["ssh_execute_many", "ssh_execute"];
    expect(batchTokenAllowed(original, { id: original, scopes })).toBe(true);
    expect(batchTokenAllowed(original, { id: crypto.randomUUID(), scopes })).toBe(false);
    expect(batchTokenAllowed(original, { id: original, scopes: ["ssh_execute"] })).toBe(false);
    expect(batchTokenAllowed(original, { id: original, scopes: ["ssh_execute_many"] })).toBe(false);
    expect(batchTokenAllowed(null, { id: original, scopes })).toBe(false);
  });
  it("rejects arbitrary destinations and malformed arguments", () => {
    expect(() =>
      parseOperation("system_info", {
        serverId: crypto.randomUUID(),
        host: "evil.test",
      }),
    ).toThrow();
    expect(() =>
      parseOperation("ssh_read_file", {
        serverId: crypto.randomUUID(),
        path: "/home/../etc/shadow",
      }),
    ).toThrow();
    expect(() =>
      parseOperation("service_restart", {
        serverId: crypto.randomUUID(),
        service: "nginx; id",
      }),
    ).toThrow();
  });
  it("never allows cloud metadata addresses, even with a catch-all allowlist", async () => {
    for (const address of ["169.254.169.254", "169.254.170.2", "fd00:ec2::254"])
      await expect(
        resolveAllowed(address, ["0.0.0.0/0", "::/0"]),
      ).rejects.toThrow("metadata");
    await expect(resolveAllowed("192.0.2.10", ["0.0.0.0/0"])).resolves.toBe(
      "192.0.2.10",
    );
  });
  it("pins IPv4 and IPv6 destinations to allowlists", () => {
    expect(allowedIP("127.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(allowedIP("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(allowedIP("::ffff:127.0.0.1", ["127.0.0.1/32"])).toBe(true);
    expect(allowedIP("::1", ["10.0.0.0/8"])).toBe(false);
  });
  it("does not confuse path prefixes", () => {
    expect(inside("/home/nexus", "/home/nexus2/secret")).toBe(false);
    expect(inside("/home/nexus", "/home/nexus/file")).toBe(true);
  });
  it("implements the RFC 6238 SHA1 test vector", () =>
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082"));
  it("validates current authenticator codes", () => {
    const key = newTotp();
    expect(verifyTotp(key, totp(key, Math.floor(Date.now() / 30000)))).toBe(
      true,
    );
    expect(verifyTotp(key, "abcdef")).toBe(false);
  });
});
