import { CURSOR } from '@class-board/shared/constants';

export interface CursorSample { t: number; x: number; y: number }

export interface Interpolator {
  /** Records a position received at time t (ms, non-decreasing). */
  push(t: number, x: number, y: number): void;
  /**
   * The position to draw at time t: the buffer's path at t - CURSOR.renderDelayMs.
   * Call with non-decreasing t; samples the path has already passed are discarded.
   */
  sample(t: number): { x: number; y: number } | null;
  latest(): CursorSample | null;
}

/** More samples than this can only pile up while nothing is sampling (a hidden tab). */
const MAX_SAMPLES = 64;

export function createInterpolator(): Interpolator {
  let samples: CursorSample[] = [];

  return {
    push(t, x, y) {
      const last = samples[samples.length - 1];
      if (last && t - last.t > CURSOR.jumpGapMs) {
        samples = [{ t, x, y }];
        return;
      }
      if (last && t <= last.t) {
        samples[samples.length - 1] = { t: last.t, x, y };
        return;
      }
      samples.push({ t, x, y });
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    },

    sample(t) {
      if (samples.length === 0) return null;
      const target = t - CURSOR.renderDelayMs;
      while (samples.length > 1 && samples[1]!.t <= target) samples.shift();
      const a = samples[0]!;
      const b = samples[1];
      if (!b || target <= a.t) return { x: a.x, y: a.y };
      const f = (target - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    },

    latest() {
      return samples[samples.length - 1] ?? null;
    },
  };
}
