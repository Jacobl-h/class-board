import { describe, expect, it } from 'vitest';
import { CURSOR } from '@class-board/shared/constants';
import { createInterpolator } from '../src/cursors/interpolate';

const D = CURSOR.renderDelayMs;

describe('createInterpolator', () => {
  it('has nothing to draw before the first sample', () => {
    expect(createInterpolator().sample(1_000)).toBeNull();
  });

  it('shows a lone sample straight away, even before the render delay has passed', () => {
    const i = createInterpolator();
    i.push(1_000, 50, 60);
    expect(i.sample(1_000)).toEqual({ x: 50, y: 60 });
  });

  it('draws a straight line between samples, D ms behind real time', () => {
    const i = createInterpolator();
    i.push(1_000, 0, 0);
    i.push(1_200, 100, 200);
    expect(i.sample(1_000 + D)).toEqual({ x: 0, y: 0 });
    expect(i.sample(1_100 + D)).toEqual({ x: 50, y: 100 });
    expect(i.sample(1_200 + D)).toEqual({ x: 100, y: 200 });
  });

  it('interpolates within the right segment of a longer path', () => {
    const i = createInterpolator();
    i.push(1_000, 0, 0);
    i.push(1_200, 100, 0);
    i.push(1_400, 100, 100);
    expect(i.sample(1_300 + D)).toEqual({ x: 100, y: 50 });
  });

  it('keeps the last sample when it runs out of data', () => {
    const i = createInterpolator();
    i.push(1_000, 0, 0);
    i.push(1_200, 100, 200);
    expect(i.sample(5_000)).toEqual({ x: 100, y: 200 });
    expect(i.sample(9_000)).toEqual({ x: 100, y: 200 });
  });

  it('jumps to the newest sample after a gap longer than jumpGapMs', () => {
    const i = createInterpolator();
    i.push(1_000, 0, 0);
    i.push(1_000 + CURSOR.jumpGapMs + 1, 500, 500);
    expect(i.sample(1_000 + CURSOR.jumpGapMs + 1)).toEqual({ x: 500, y: 500 });
  });

  it('still animates across a gap of exactly jumpGapMs', () => {
    const i = createInterpolator();
    i.push(1_000, 0, 0);
    i.push(1_000 + CURSOR.jumpGapMs, 100, 0);
    expect(i.sample(1_000 + CURSOR.jumpGapMs / 2 + D)).toEqual({ x: 50, y: 0 });
  });

  it('drops samples it has already passed', () => {
    const i = createInterpolator();
    for (let k = 0; k < 10; k++) i.push(1_000 + k * 100, k * 10, 0);
    i.sample(1_700 + D);
    expect(i.latest()).toEqual({ t: 1_900, x: 90, y: 0 });
    expect(i.sample(1_750 + D)).toEqual({ x: 75, y: 0 });
  });

  it('keeps a bounded buffer when nothing samples it', () => {
    const i = createInterpolator();
    for (let k = 0; k < 1_000; k++) i.push(1_000 + k * 50, k, 0);
    expect(i.sample(1_000 + 999 * 50 + D)).toEqual({ x: 999, y: 0 });
    expect(i.sample(1_000 + 990 * 50 + D)?.x).toBeGreaterThanOrEqual(936);
  });

  it('overwrites the newest sample when two arrive with the same timestamp', () => {
    const i = createInterpolator();
    i.push(1_000, 1, 1);
    i.push(1_000, 2, 2);
    expect(i.latest()).toEqual({ t: 1_000, x: 2, y: 2 });
  });

  it('reports the newest sample as latest', () => {
    const i = createInterpolator();
    expect(i.latest()).toBeNull();
    i.push(1_000, 3, 4);
    i.push(1_200, 5, 6);
    expect(i.latest()).toEqual({ t: 1_200, x: 5, y: 6 });
  });
});
