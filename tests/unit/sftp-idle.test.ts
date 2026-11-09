import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { idleLease, releaseWithResponse } from "../../apps/api/src/sftp-idle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("never closes while a lease is held, then closes after the idle period", () => {
  const onIdle = vi.fn();
  const lease = idleLease(onIdle, 60000);
  const release = lease.acquire();
  vi.advanceTimersByTime(600000);
  expect(onIdle).not.toHaveBeenCalled();
  release();
  vi.advanceTimersByTime(59999);
  expect(onIdle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onIdle).toHaveBeenCalledOnce();
});
it("waits for the last of overlapping requests and ignores double releases", () => {
  const onIdle = vi.fn();
  const lease = idleLease(onIdle, 1000);
  const first = lease.acquire();
  const second = lease.acquire();
  first();
  first();
  expect(lease.active).toBe(1);
  vi.advanceTimersByTime(5000);
  expect(onIdle).not.toHaveBeenCalled();
  second();
  vi.advanceTimersByTime(1000);
  expect(onIdle).toHaveBeenCalledOnce();
});
it("cancels a pending idle close when a new request arrives", () => {
  const onIdle = vi.fn();
  const lease = idleLease(onIdle, 1000);
  lease.acquire()();
  vi.advanceTimersByTime(900);
  const release = lease.acquire();
  vi.advanceTimersByTime(5000);
  expect(onIdle).not.toHaveBeenCalled();
  release();
  vi.advanceTimersByTime(1000);
  expect(onIdle).toHaveBeenCalledOnce();
});
it("releases when the response closes, or at once if it already closed", () => {
  const release = vi.fn();
  const res = new EventEmitter();
  releaseWithResponse(res, release);
  expect(release).not.toHaveBeenCalled();
  res.emit("close");
  expect(release).toHaveBeenCalledOnce();
  const late = vi.fn();
  releaseWithResponse(Object.assign(new EventEmitter(), { closed: true }), late);
  expect(late).toHaveBeenCalledOnce();
  const none = vi.fn();
  releaseWithResponse(undefined, none);
  expect(none).toHaveBeenCalledOnce();
});
