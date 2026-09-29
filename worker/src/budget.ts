import { BUDGET, RATES } from '@class-board/shared/constants';

export interface BudgetState {
  day: string;
  count: number;
}

/** The UTC calendar day of a timestamp, as 'YYYY-MM-DD'. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Counts incoming WebSocket messages per UTC day and turns the count into a cursor rate.
 * The count lives in memory; `flush` persists it through `save` at most once per
 * BUDGET.persistEveryMs, so a busy class costs a couple of row writes a minute, not one per message.
 */
export class DailyBudget {
  private current: BudgetState;
  private lastSave: number;

  constructor(
    private readonly opts: {
      limit: number;
      now: () => number;
      load: () => BudgetState | null;
      save: (s: BudgetState) => void;
    },
  ) {
    const today = utcDay(opts.now());
    const loaded = opts.load();
    this.current = loaded && loaded.day === today ? { day: loaded.day, count: loaded.count } : { day: today, count: 0 };
    this.lastSave = opts.now();
  }

  /** Counts `n` messages. The first call after UTC midnight starts a new day at zero. */
  add(n = 1): void {
    this.rollOver();
    this.current.count += n;
  }

  /** Cursor rate for now: full below 80% of the limit, slow from 80%, paused from 90%. */
  hz(): number {
    this.rollOver();
    const { count } = this.current;
    if (count >= this.opts.limit * BUDGET.pauseAt) return 0;
    if (count >= this.opts.limit * BUDGET.slowAt) return RATES.cursorSlowHz;
    return RATES.cursorHz;
  }

  /**
   * Saves the count once BUDGET.persistEveryMs has passed since the last save (or since
   * construction). `force` saves right away.
   */
  flush(force = false): void {
    this.rollOver();
    const t = this.opts.now();
    if (!force && t - this.lastSave < BUDGET.persistEveryMs) return;
    this.opts.save({ ...this.current });
    this.lastSave = t;
  }

  state(): BudgetState {
    this.rollOver();
    return { ...this.current };
  }

  private rollOver(): void {
    const today = utcDay(this.opts.now());
    if (today !== this.current.day) {
      this.current = { day: today, count: 0 };
    }
  }
}
