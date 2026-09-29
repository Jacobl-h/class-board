import { RATES } from '@class-board/shared/constants';

export type TeacherCheck = 'ok' | 'bad' | 'locked_out';

/** Compares two strings without stopping at the first difference. Runs over the longer length. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Checks teacher passcodes. Each key (a connection id or IP) may make RATES.teacherAttempts
 * wrong tries in any RATES.teacherWindowMs; after that it is locked out until the oldest of
 * those tries leaves the window. Attempts made while locked out are not recorded, so
 * hammering a locked key can't extend its lockout, and a correct code doesn't lift it.
 */
export class TeacherGate {
  private readonly failures = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly code: string,
    private readonly now: () => number,
  ) {
    this.lastSweep = now();
  }

  check(key: string, attempt: string): TeacherCheck {
    const t = this.now();
    if (t - this.lastSweep >= RATES.teacherWindowMs) this.sweep(t);

    const recent = (this.failures.get(key) ?? []).filter((at) => t - at < RATES.teacherWindowMs);
    if (recent.length >= RATES.teacherAttempts) {
      this.failures.set(key, recent);
      return 'locked_out';
    }
    // An unset TEACHER_CODE secret must never let an empty attempt in.
    if (this.code !== '' && safeEqual(attempt, this.code)) {
      this.failures.delete(key);
      return 'ok';
    }
    recent.push(t);
    this.failures.set(key, recent);
    return 'bad';
  }

  /** Drops keys with no wrong try left in the window, at most once per window. */
  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, times] of this.failures) {
      if (times.every((at) => t - at >= RATES.teacherWindowMs)) this.failures.delete(key);
    }
  }
}
