import { describe, expect, it } from 'vitest';
import { DailyBudget, utcDay, type BudgetState } from '../../src/budget';

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0); // 2026-09-29 12:00 UTC

function setup(opts: { limit?: number; stored?: BudgetState | null; start?: number } = {}) {
  let t = opts.start ?? T0;
  const saves: BudgetState[] = [];
  const budget = new DailyBudget({
    limit: opts.limit ?? 1000,
    now: () => t,
    load: () => opts.stored ?? null,
    save: (s) => saves.push(s),
  });
  return { budget, saves, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

describe('utcDay', () => {
  it('formats a timestamp as a UTC calendar day', () => {
    expect(utcDay(Date.UTC(2026, 8, 29, 0, 0, 0))).toBe('2026-09-29');
    expect(utcDay(Date.UTC(2026, 8, 29, 23, 59, 59, 999))).toBe('2026-09-29');
    expect(utcDay(Date.UTC(2026, 8, 30, 0, 0, 0))).toBe('2026-09-30');
  });

  it('zero-pads month and day', () => {
    expect(utcDay(Date.UTC(2027, 0, 5, 3))).toBe('2027-01-05');
  });
});

describe('DailyBudget counting', () => {
  it('starts at zero for today', () => {
    const { budget } = setup();
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 0 });
  });

  it('adds one message by default and n when given', () => {
    const { budget } = setup();
    budget.add();
    budget.add(4);
    expect(budget.state().count).toBe(5);
  });

  it('resumes from a count stored earlier today', () => {
    const { budget } = setup({ stored: { day: '2026-09-29', count: 700 } });
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 700 });
  });

  it("discards a count stored on an earlier day", () => {
    const { budget } = setup({ stored: { day: '2026-09-28', count: 1_999_999 } });
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 0 });
    expect(budget.hz()).toBe(5);
  });

  it('returns a copy of its state', () => {
    const { budget } = setup();
    const s = budget.state();
    s.count = 999;
    expect(budget.state().count).toBe(0);
  });
});

describe('DailyBudget UTC rollover', () => {
  it('starts a new day at zero when the first message arrives after midnight UTC', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 23, 59, 59) });
    budget.add(950);
    expect(budget.hz()).toBe(0);
    set(Date.UTC(2026, 8, 30, 0, 0, 0));
    budget.add();
    expect(budget.state()).toEqual({ day: '2026-09-30', count: 1 });
    expect(budget.hz()).toBe(5);
  });

  it('resets the rate at midnight even when no message has arrived yet', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 23, 59, 59) });
    budget.add(950);
    expect(budget.hz()).toBe(0);
    set(Date.UTC(2026, 8, 30, 0, 0, 1));
    expect(budget.hz()).toBe(5);
    expect(budget.state().count).toBe(0);
  });

  it('does not roll over before midnight', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 0, 0, 0) });
    budget.add(10);
    set(Date.UTC(2026, 8, 29, 23, 59, 59, 999));
    budget.add(10);
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 20 });
  });
});

describe('DailyBudget rate thresholds', () => {
  it('sends cursors at 5 Hz below 80% of the limit', () => {
    const { budget } = setup({ limit: 1000 });
    expect(budget.hz()).toBe(5);
    budget.add(799);
    expect(budget.hz()).toBe(5);
  });

  it('drops to 2 Hz at exactly 80%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(800);
    expect(budget.hz()).toBe(2);
  });

  it('stays at 2 Hz just below 90%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(899);
    expect(budget.hz()).toBe(2);
  });

  it('pauses at exactly 90%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(900);
    expect(budget.hz()).toBe(0);
  });

  it('stays paused over the limit', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(5000);
    expect(budget.hz()).toBe(0);
  });

  it('uses the same thresholds at the real 2,000,000 limit', () => {
    const { budget } = setup({ limit: 2_000_000 });
    budget.add(1_599_999);
    expect(budget.hz()).toBe(5);
    budget.add();
    expect(budget.hz()).toBe(2);
    budget.add(199_999);
    expect(budget.hz()).toBe(2);
    budget.add();
    expect(budget.hz()).toBe(0);
  });
});
