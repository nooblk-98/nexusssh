import { describe, expect, it, vi } from "vitest";

const { db, state } = vi.hoisted(() => {
  const state = { task: "running", lease: "valid", execution: "running" };
  const db = {
    $transaction: async (work: (tx: any) => Promise<unknown>) => work({
      backgroundTask: {
        updateMany: async ({ where, data }: any) => {
          // Cancellation commits after finish's earlier read, before its CAS.
          if (state.task === "running") state.task = "cancelled";
          if (state.task !== where.status || state.lease !== where.leaseHash)
            return { count: 0 };
          if (data.status) state.task = data.status;
          if (data.leaseHash === null) state.lease = "";
          return { count: 1 };
        },
      },
      commandExecution: {
        update: async ({ data }: any) => { state.execution = data.status; },
      },
    }),
  };
  return { db, state };
});
vi.mock("../../packages/database/index.js", () => ({ db }));

import { finishTask } from "../../apps/api/src/task-finish.js";

describe("task finish and cancel race", () => {
  it("preserves cancellation in both records when it commits before finish", async () => {
    state.task = "running";
    state.lease = "valid";
    state.execution = "running";
    const status = await finishTask("task", "valid", { status: "completed" });
    expect(status).toBe("cancelled");
    expect(state.task).toBe("cancelled");
    expect(state.execution).toBe("cancelled");
    expect(state.lease).toBe("");
  });
});
