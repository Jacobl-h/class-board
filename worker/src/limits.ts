import { RATES } from '@class-board/shared/constants';

const EPSILON = 1e-9;

/**
 * Classic token bucket: holds up to `burst` tokens and refills continuously at
 * `ratePerSecond`, so a client that pauses gets its allowance back gradually
 * rather than at a fixed tick.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Spends one token. Returns false, and spends nothing, when the bucket is empty. */
  take(): boolean {
    const t = this.now();
    const elapsedMs = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.ratePerSecond);
    // The epsilon absorbs floating-point error, so a token that is due exactly now isn't refused.
    if (this.tokens < 1 - EPSILON) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }
}

export interface ConnLimits {
  cursor: TokenBucket;
  edit: TokenBucket;
  history: TokenBucket;
  profile: TokenBucket;
}

/** One set of buckets per connection. Per-minute limits allow a burst of a full minute's worth. */
export function createConnLimits(now: () => number): ConnLimits {
  return {
    cursor: new TokenBucket(RATES.cursorPerSecond, RATES.cursorBurst, now),
    edit: new TokenBucket(RATES.editsPerMinute / 60, RATES.editsPerMinute, now),
    history: new TokenBucket(RATES.historyPerMinute / 60, RATES.historyPerMinute, now),
    profile: new TokenBucket(RATES.profilePerMinute / 60, RATES.profilePerMinute, now),
  };
}

const WINDOW_MS = 60_000;

/**
 * At most `perMinute` calls per key in any sliding 60 s window (each allowed call is
 * remembered for 60 s). Keys with nothing left in the window are evicted, at most once
 * per window, so a stream of one-off keys (uploads from many IPs) can't grow the map forever.
 */
export class KeyedLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {
    this.lastSweep = now();
  }

  allow(key: string): boolean {
    const t = this.now();
    if (t - this.lastSweep >= WINDOW_MS) this.sweep(t);

    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Number of keys currently remembered. */
  get size(): number {
    return this.hits.size;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, times] of this.hits) {
      if (times.every((at) => t - at >= WINDOW_MS)) this.hits.delete(key);
    }
  }
}
