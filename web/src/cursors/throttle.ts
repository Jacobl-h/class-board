export interface ThrottleOpts {
  /** Sends per second. 0 (or less) pauses: everything pushed is dropped. */
  hz: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Throttle<T> {
  /** Sends now if the interval has passed, otherwise keeps only the newest value for a trailing send. */
  push(value: T): void;
  /** Changes the interval. 0 pauses and drops anything pending. */
  setHz(hz: number): void;
  /** Drops anything pending and forgets the last send time, so the next push sends at once. */
  cancel(): void;
}

export function createThrottle<T>(send: (value: T) => void, opts: ThrottleOpts): Throttle<T> {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let hz = opts.hz;
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let pending: { value: T } | null = null;

  const interval = () => 1000 / hz;

  function dropPending(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  }

  function schedule(): void {
    if (timer !== null) clearTimer(timer);
    const wait = Math.max(0, lastSent + interval() - now());
    timer = setTimer(fire, wait);
  }

  function fire(): void {
    timer = null;
    if (pending === null || hz <= 0) return;
    const { value } = pending;
    pending = null;
    lastSent = now();
    send(value);
  }

  return {
    push(value) {
      if (hz <= 0) return;
      if (now() - lastSent >= interval()) {
        dropPending();
        lastSent = now();
        send(value);
        return;
      }
      pending = { value };
      if (timer === null) schedule();
    },
    setHz(next) {
      hz = next;
      if (hz <= 0) dropPending();
      else if (pending !== null) schedule();
    },
    cancel() {
      dropPending();
      lastSent = Number.NEGATIVE_INFINITY;
    },
  };
}
