// Counts in-flight requests on a pooled SFTP channel and closes it only after
// it has been unused for the idle period, so a long transfer or download is
// never cut off by a timer armed when its request started.
export type IdleLease = {
  acquire(): () => void;
  readonly active: number;
};
export function idleLease(onIdle: () => void, idleMs: number): IdleLease {
  let active = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (active === 0) onIdle();
    }, idleMs);
    timer.unref?.();
  };
  return {
    get active() {
      return active;
    },
    acquire() {
      active++;
      clearTimeout(timer);
      timer = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--active === 0) arm();
      };
    },
  };
}
// Releases when the HTTP response has finished or the client went away,
// including streamed downloads that outlive the handler's return.
export function releaseWithResponse(
  res: { once(event: "close", listener: () => void): unknown; closed?: boolean; destroyed?: boolean } | undefined,
  release: () => void,
) {
  if (!res || res.closed || res.destroyed) return release();
  res.once("close", release);
}
