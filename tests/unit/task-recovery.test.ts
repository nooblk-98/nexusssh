import { describe, expect, it, vi } from "vitest";

const { tasks, executions, db } = vi.hoisted(() => {
  const tasks = new Map([["old", { status: "running", leaseHash: "lease" }], ["done", { status: "completed", leaseHash: null }]]);
  const executions = new Map([["old", "running"], ["done", "completed"]]);
  const db = {
    $transaction: async (work: (tx: any) => Promise<unknown>) => work({
      backgroundTask: {
        findMany: async () => [...tasks].filter(([, value]) => value.status === "running").map(([id]) => ({ id })),
        updateMany: async ({ where, data }: any) => {
          for (const id of where.id.in) {
            const task = tasks.get(id)!;
            if (task.status === where.status) Object.assign(task, data);
          }
        },
      },
      commandExecution: {
        updateMany: async ({ where, data }: any) => {
          for (const id of where.id.in) executions.set(id, data.status);
        },
      },
    }),
  };
  return { tasks, executions, db };
});
vi.mock("../../packages/database/index.js", () => ({ db }));

import { reconcileRunningTasks } from "../../apps/api/src/task-recovery.js";

describe("startup SSH task recovery", () => {
  it("invalidates running leases and matches execution status without changing finished tasks", async () => {
    expect(await reconcileRunningTasks()).toBe(1);
    expect(tasks.get("old")).toEqual({ status: "interrupted", leaseHash: null });
    expect(executions.get("old")).toBe("interrupted");
    expect(tasks.get("done")?.status).toBe("completed");
    expect(await reconcileRunningTasks()).toBe(0);
  });
});
