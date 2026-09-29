import { describe, expect, it } from 'vitest';
import { KeyedLimiter, TokenBucket, createConnLimits } from '../../src/limits';

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

function drain(bucket: TokenBucket): number {
  let n = 0;
  while (bucket.take()) {
    n += 1;
    if (n > 1000) throw new Error('bucket never emptied');
  }
  return n;
}

describe('TokenBucket', () => {
  it('starts full and allows a burst', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 4, clock.now);
    expect(drain(bucket)).toBe(4);
  });

  it('refuses when empty and does not spend anything on a refusal', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock.now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.take()).toBe(false);
    clock.advance(500); // exactly one token at 2 per second
    expect(bucket.take()).toBe(true);
  });

  it('refills continuously, not in whole ticks', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 4, clock.now);
    drain(bucket);
    clock.advance(250); // half a token
    expect(bucket.take()).toBe(false);
    clock.advance(250); // the half-token is remembered, so now there is one
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never holds more than the burst, however long it idles', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 3, clock.now);
    drain(bucket);
    clock.advance(60 * 60_000);
    expect(drain(bucket)).toBe(3);
  });

  it('gives back the rate over one second', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(6, 10, clock.now);
    drain(bucket);
    clock.advance(1000);
    expect(drain(bucket)).toBe(6);
  });

  it('handles a clock that steps backwards without losing or minting tokens', () => {
    const clock = fakeClock(10_000);
    const bucket = new TokenBucket(1, 2, clock.now);
    drain(bucket);
    clock.set(5_000);
    expect(bucket.take()).toBe(false);
    clock.set(6_000); // one second after the step back
    expect(bucket.take()).toBe(true);
  });
});

describe('createConnLimits', () => {
  it('allows a burst of 10 cursor messages, then 6 per second', () => {
    const clock = fakeClock();
    const { cursor } = createConnLimits(clock.now);
    expect(drain(cursor)).toBe(10);
    clock.advance(1000);
    expect(drain(cursor)).toBe(6);
  });

  it('allows 10 edits in a burst, then one every 6 seconds', () => {
    const clock = fakeClock();
    const { edit } = createConnLimits(clock.now);
    expect(drain(edit)).toBe(10);
    clock.advance(5_999);
    expect(edit.take()).toBe(false);
    clock.advance(1);
    expect(edit.take()).toBe(true);
  });

  it('allows 30 history requests a minute', () => {
    const clock = fakeClock();
    const { history } = createConnLimits(clock.now);
    expect(drain(history)).toBe(30);
    clock.advance(60_000);
    expect(drain(history)).toBe(30);
  });

  it('allows 10 profile updates a minute', () => {
    const clock = fakeClock();
    const { profile } = createConnLimits(clock.now);
    expect(drain(profile)).toBe(10);
    clock.advance(60_000);
    expect(drain(profile)).toBe(10);
  });

  it('keeps the four buckets independent', () => {
    const clock = fakeClock();
    const limits = createConnLimits(clock.now);
    drain(limits.cursor);
    expect(limits.edit.take()).toBe(true);
    expect(limits.history.take()).toBe(true);
    expect(limits.profile.take()).toBe(true);
  });

  it('gives each connection its own buckets', () => {
    const clock = fakeClock();
    const a = createConnLimits(clock.now);
    const b = createConnLimits(clock.now);
    drain(a.edit);
    expect(b.edit.take()).toBe(true);
  });
});

describe('KeyedLimiter', () => {
  it('allows perMinute calls per key and then refuses', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    for (let i = 0; i < 5; i += 1) expect(limiter.allow('1.2.3.4')).toBe(true);
    expect(limiter.allow('1.2.3.4')).toBe(false);
  });

  it('counts each key separately', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(1, clock.now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('uses a sliding 60 second window: a call frees its slot exactly 60 s later', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(2, clock.now);
    expect(limiter.allow('k')).toBe(true); // t = 0
    clock.advance(30_000);
    expect(limiter.allow('k')).toBe(true); // t = 30 s
    expect(limiter.allow('k')).toBe(false);
    clock.advance(29_999); // t = 59.999 s: the first call is still inside the window
    expect(limiter.allow('k')).toBe(false);
    clock.advance(1); // t = 60 s: the first call has left the window
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false); // the t = 30 s call still counts
  });

  it('does not extend the window for refused calls', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(1, clock.now);
    expect(limiter.allow('k')).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      clock.advance(5_000);
      expect(limiter.allow('k')).toBe(false);
    }
    clock.advance(10_000); // 60 s after the only allowed call
    expect(limiter.allow('k')).toBe(true);
  });

  it('evicts keys whose calls have all left the window', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    for (let i = 0; i < 100; i += 1) limiter.allow(`ip-${i}`);
    expect(limiter.size).toBe(100);
    clock.advance(60_000);
    limiter.allow('someone-new'); // triggers the sweep
    expect(limiter.size).toBe(1);
  });

  it('keeps keys that still have a call inside the window when it sweeps', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    limiter.allow('old');
    clock.advance(40_000);
    limiter.allow('recent');
    clock.advance(20_000); // 'old' is 60 s old, 'recent' is 20 s old
    limiter.allow('trigger');
    expect(limiter.size).toBe(2); // 'recent' and 'trigger'
    expect(limiter.allow('recent')).toBe(true);
  });

  it('never allows anything when perMinute is 0', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(0, clock.now);
    expect(limiter.allow('k')).toBe(false);
  });
});
