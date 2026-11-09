import { expect, it } from "vitest";
import { finishedStatus } from "../../workers/ssh-worker/src/finish-status.js";

it("honours the status the API persisted", () => {
  expect(finishedStatus({ status: "cancelled" }, "completed")).toBe("cancelled");
  expect(finishedStatus({ status: "completed" }, "completed")).toBe("completed");
});
it("falls back to the requested status for older APIs or unexpected values", () => {
  expect(finishedStatus({}, "completed")).toBe("completed");
  expect(finishedStatus(undefined, "failed")).toBe("failed");
  expect(finishedStatus({ status: "interrupted" }, "completed")).toBe("completed");
});
