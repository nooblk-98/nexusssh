import { describe, expect, it, vi } from "vitest";

const { ssh, management, db } = vi.hoisted(() => {
const ssh: string[] = [];
const management: string[] = [];
let next = Promise.resolve();
const db = {
  $transaction: async (work: (tx: any) => Promise<unknown>) => {
    const previous = next;
    let release!: () => void;
    next = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const sshBefore = ssh.length;
    const managementBefore = management.length;
    try {
      return await work({
        agent: { update: async () => ({ maxCallsPerMinute: 2, maxCallsPerDay: 2 }) },
        commandExecution: {
          count: async () => ssh.length,
          create: async () => { ssh.push("ssh"); },
        },
        auditEvent: {
          count: async () => management.length,
          create: async () => { management.push("management"); },
        },
      });
    } catch (error) {
      ssh.length = sshBefore;
      management.length = managementBefore;
      throw error;
    } finally { release(); }
  },
};
return { ssh, management, db };
});
vi.mock("../../packages/database/index.js", () => ({ db }));

import { reserveAgentCall } from "../../apps/api/src/agent-quota.js";

describe("mixed agent call quota", () => {
  it("admits only two concurrent SSH and management reservations and rolls back failed records", async () => {
    ssh.length = 0;
    management.length = 0;
    await expect(reserveAgentCall("agent", async (tx) => {
      await tx.commandExecution.create();
      throw new Error("record failed");
    })).rejects.toThrow("record failed");
    expect(ssh).toHaveLength(0);
    const calls = [
      reserveAgentCall("agent", (tx) => tx.commandExecution.create()),
      reserveAgentCall("agent", (tx) => tx.auditEvent.create()),
      reserveAgentCall("agent", (tx) => tx.commandExecution.create()),
      reserveAgentCall("agent", (tx) => tx.auditEvent.create()),
    ];
    const results = await Promise.allSettled(calls);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled", "fulfilled", "rejected", "rejected",
    ]);
    expect(ssh).toHaveLength(1);
    expect(management).toHaveLength(1);
  });
});
