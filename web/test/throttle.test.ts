import { describe, expect, it } from 'vitest';
import { createThrottle } from '../src/cursors/throttle';

/** A manual clock: timers only fire when the test advances time. */
function makeClock() {
  let time = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    pendingTimers: () => timers.size,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = end;
    },
  };
}

function setup(hz = 5) {
  const clock = makeClock();
  const sent: Array<{ v: number; at: number }> = [];
  const throttle = createThrottle<number>((v) => sent.push({ v, at: clock.now() }), { hz, ...clock });
  return { clock, sent, throttle };
}

describe('createThrottle', () => {
  it('sends the first value immediately', () => {
    const { sent, throttle } = setup();
    throttle.push(1);
    expect(sent).toEqual([{ v: 1, at: 1_000 }]);
  });

  it('keeps only the newest value pushed inside the interval and sends it when the interval ends', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.push(1);
    clock.advance(50);
    throttle.push(2);
    clock.advance(50);
    throttle.push(3);
    expect(sent.map((s) => s.v)).toEqual([1]);
    clock.advance(99);
    expect(sent.map((s) => s.v)).toEqual([1]);
    clock.advance(1);
    expect(sent).toEqual([{ v: 1, at: 1_000 }, { v: 3, at: 1_200 }]);
  });

  it('sends the final value once, about 200 ms after movement stops, and then nothing more', () => {
    const { clock, sent, throttle } = setup(5);
    for (let i = 1; i <= 4; i++) {
      throttle.push(i);
      clock.advance(60);
    }
    clock.advance(1_000);
    expect(sent.at(-1)!.v).toBe(4);
    const count = sent.length;
    clock.advance(5_000);
    expect(sent).toHaveLength(count);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('never sends faster than the interval', () => {
    const { clock, sent, throttle } = setup(5);
    for (let i = 0; i < 100; i++) {
      throttle.push(i);
      clock.advance(10);
    }
    clock.advance(500);
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(200);
  });

  it('sends immediately again once the interval has passed', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.push(1);
    clock.advance(250);
    throttle.push(2);
    expect(sent.map((s) => s.v)).toEqual([1, 2]);
  });

  it('uses a longer interval after setHz(2)', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.setHz(2);
    throttle.push(1);
    clock.advance(300);
    throttle.push(2);
    clock.advance(199);
    expect(sent.map((s) => s.v)).toEqual([1]);
    clock.advance(1);
    expect(sent.map((s) => s.v)).toEqual([1, 2]);
  });

  it('reschedules a pending send when the rate changes', () => {
    const { clock, sent, throttle } = setup(2);
    throttle.push(1);
    clock.advance(100);
    throttle.push(2);
    throttle.setHz(5);
    clock.advance(100);
    expect(sent.map((s) => s.v)).toEqual([1, 2]);
  });

  it('drops pushes and anything pending while paused at 0 Hz', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.push(1);
    clock.advance(50);
    throttle.push(2);
    throttle.setHz(0);
    expect(clock.pendingTimers()).toBe(0);
    throttle.push(3);
    clock.advance(5_000);
    expect(sent.map((s) => s.v)).toEqual([1]);
  });

  it('resumes after being paused', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.setHz(0);
    throttle.push(1);
    throttle.setHz(5);
    throttle.push(2);
    clock.advance(1_000);
    expect(sent.map((s) => s.v)).toEqual([2]);
  });

  it('cancel drops the pending value and lets the next push send at once', () => {
    const { clock, sent, throttle } = setup(5);
    throttle.push(1);
    clock.advance(50);
    throttle.push(2);
    throttle.cancel();
    clock.advance(1_000);
    expect(sent.map((s) => s.v)).toEqual([1]);
    throttle.push(3);
    throttle.push(4);
    expect(sent.map((s) => s.v)).toEqual([1, 3]);
  });
});
