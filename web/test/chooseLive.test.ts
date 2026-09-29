import { describe, expect, it } from 'vitest';
import type { TileView } from '@class-board/shared/types';
import {
  chooseLive, EMPTY_MEMORY, liveCap, liveEligible,
  type ChooseLiveInput, type LiveCandidate, type LiveMemory,
} from '../src/board/chooseLive';

const VIEWPORT = { w: 1600, h: 1000 }; // centre (800, 500)

/** A 480×300 on-screen tile whose centre is `offset` px right of the viewport centre. */
function near(slot: number, offset: number, eligible = true): LiveCandidate {
  return { slot, eligible, rect: { x: 800 + offset - 240, y: 350, w: 480, h: 300 } };
}

function off(slot: number, eligible = true): LiveCandidate {
  return { slot, eligible, rect: { x: 5000, y: 5000, w: 480, h: 300 } };
}

function memory(live: number[], lastQualified: Record<number, number> = {}, mountTimes: number[] = []): LiveMemory {
  return {
    live: new Set(live),
    lastQualified: new Map(Object.entries(lastQualified).map(([k, v]) => [Number(k), v])),
    mountTimes,
  };
}

function run(partial: Partial<ChooseLiveInput> & { candidates: LiveCandidate[] }) {
  return chooseLive({ viewport: VIEWPORT, forced: new Set(), now: 10_000, memory: EMPTY_MEMORY, ...partial });
}

function view(patch: Partial<TileView>): TileView {
  return {
    slot: 0, version: 1, kind: 'link', label: '', url: 'https://a.example/', embedUrl: 'https://a.example/',
    fileUrl: null, title: null, icon: null, embeddable: 'yes', note: null, shotUrl: null,
    authorName: null, createdAt: null, ...patch,
  };
}

describe('liveEligible', () => {
  it('accepts uploads and links that are embeddable yes or unknown', () => {
    expect(liveEligible(view({ kind: 'html', url: null, embedUrl: null, fileUrl: '/boards/main/files/f' }))).toBe(true);
    expect(liveEligible(view({ embeddable: 'yes' }))).toBe(true);
    expect(liveEligible(view({ embeddable: 'unknown' }))).toBe(true);
  });

  it('rejects empty tiles, blocked or pending links, and links without an embed URL', () => {
    expect(liveEligible(view({ kind: 'empty', url: null, embedUrl: null, embeddable: 'no' }))).toBe(false);
    expect(liveEligible(view({ embeddable: 'no' }))).toBe(false);
    expect(liveEligible(view({ embeddable: 'pending' }))).toBe(false);
    expect(liveEligible(view({ embedUrl: null, embeddable: 'unknown' }))).toBe(false);
  });
});

describe('liveCap', () => {
  it('allows 12 live tiles, or 6 when the device reports 4 GB or less', () => {
    expect(liveCap(undefined)).toBe(12);
    expect(liveCap(8)).toBe(12);
    expect(liveCap(4)).toBe(6);
    expect(liveCap(2)).toBe(6);
  });
});

describe('chooseLive', () => {
  it('mounts eligible tiles that are on screen and at least 240 px wide', () => {
    const narrow: LiveCandidate = { slot: 2, eligible: true, rect: { x: 700, y: 400, w: 200, h: 125 } };
    const r = run({ candidates: [near(1, 0), narrow, off(3), near(4, 100, false)] });
    expect(r.mount).toEqual([1]);
    expect(r.live).toEqual([1]);
    expect(r.unmount).toEqual([]);
  });

  it('counts a partly visible tile as on screen', () => {
    const edge: LiveCandidate = { slot: 5, eligible: true, rect: { x: -400, y: 100, w: 480, h: 300 } };
    expect(run({ candidates: [edge] }).live).toEqual([5]);
  });

  it('caps live tiles at 12 and keeps the ones closest to the viewport centre', () => {
    const candidates = Array.from({ length: 15 }, (_, i) => near(i, i * 10));
    const all = candidates.map((c) => c.slot);
    const r = run({ candidates, memory: memory(all, Object.fromEntries(all.map((s) => [s, 9_000]))) });
    expect(r.live).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.unmount).toEqual([12, 13, 14]);
  });

  it('uses the low-memory cap of 6 when deviceMemory is 4 or less', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => near(i, i * 10));
    const all = candidates.map((c) => c.slot);
    const r = run({ candidates, deviceMemory: 4, memory: memory(all, Object.fromEntries(all.map((s) => [s, 9_000]))) });
    expect(r.live).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.unmount).toEqual([6, 7]);
  });

  it('keeps pinned and active tiles live outside the cap and pacing, even off screen', () => {
    const candidates = [...Array.from({ length: 12 }, (_, i) => near(i, i * 10)), off(40)];
    const onScreen = candidates.slice(0, 12).map((c) => c.slot);
    const r = run({
      candidates,
      forced: new Set([40]),
      memory: memory(onScreen, Object.fromEntries(onScreen.map((s) => [s, 9_000])), [10_000, 10_000]),
    });
    expect(r.live).toHaveLength(13);
    expect(r.live).toContain(40);
    expect(r.mount).toEqual([40]);
    expect(r.unmount).toEqual([]);
  });

  it('never mounts a forced tile whose content is ineligible', () => {
    const r = run({ candidates: [near(7, 0, false)], forced: new Set([7]), memory: memory([7], { 7: 9_000 }) });
    expect(r.live).toEqual([]);
    expect(r.unmount).toEqual([7]);
  });

  it('keeps a tile live for 2 s after it stops qualifying, then drops it', () => {
    const during = run({ candidates: [off(9)], now: 2_500, memory: memory([9], { 9: 1_000 }) });
    expect(during.live).toEqual([9]);
    expect(during.retryInMs).toBe(500);
    const after = run({ candidates: [off(9)], now: 3_000, memory: during.memory });
    expect(after.live).toEqual([]);
    expect(after.unmount).toEqual([9]);
  });

  it('drops a tile that becomes ineligible immediately, even inside the linger window', () => {
    const r = run({ candidates: [near(9, 0, false)], now: 1_100, memory: memory([9], { 9: 1_000 }) });
    expect(r.live).toEqual([]);
    expect(r.unmount).toEqual([9]);
  });

  it('lets qualifying tiles beat lingering ones for the cap', () => {
    const candidates = [...Array.from({ length: 6 }, (_, i) => near(i, i * 10)), off(20)];
    const r = run({
      candidates,
      deviceMemory: 2,
      now: 10_000,
      memory: memory([0, 1, 2, 3, 4, 5, 20], { 0: 9_900, 1: 9_900, 2: 9_900, 3: 9_900, 4: 9_900, 5: 9_900, 20: 9_900 }),
    });
    expect(r.live).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.unmount).toEqual([20]);
  });

  it('mounts at most 2 new tiles per 250 ms, closest first, and says when to call again', () => {
    const candidates = [near(1, 400), near(2, 0), near(3, 100), near(4, 200), near(5, 300)];
    const first = run({ candidates, now: 0 });
    expect(first.mount).toEqual([2, 3]);
    expect(first.deferred).toEqual([4, 5, 1]);
    expect(first.retryInMs).toBe(250);

    const early = run({ candidates, now: 100, memory: first.memory });
    expect(early.mount).toEqual([]);
    expect(early.retryInMs).toBe(150);

    const later = run({ candidates, now: 250, memory: early.memory });
    expect(later.mount).toEqual([4, 5]);
    expect(later.deferred).toEqual([1]);
    expect(later.live).toEqual([2, 3, 4, 5]);
  });

  it('keeps displaced live tiles until their replacements can mount', () => {
    const old = [near(10, 500), near(11, 510), near(12, 520), near(13, 530), near(14, 540), near(15, 550)];
    const fresh = [near(1, 0), near(2, 10), near(3, 20)];
    const oldSlots = old.map((c) => c.slot);
    const r = run({
      candidates: [...old, ...fresh],
      deviceMemory: 2,
      now: 10_000,
      memory: memory(oldSlots, Object.fromEntries(oldSlots.map((s) => [s, 9_900]))),
    });
    expect(r.mount).toEqual([1, 2]);
    expect(r.deferred).toEqual([3]);
    // Top 6 = 1, 2, 3, 10, 11, 12; one spare place keeps 13 until 3 can mount.
    expect(r.live).toEqual([1, 2, 10, 11, 12, 13]);
    expect(r.unmount).toEqual([14, 15]);
  });

  it('returns no retry time when nothing is pending', () => {
    const r = run({ candidates: [near(1, 0)] });
    expect(r.retryInMs).toBeNull();
  });

  it('refreshes lastQualified for qualifying and forced tiles and keeps it for lingering ones', () => {
    const r = run({
      candidates: [near(1, 0), off(2), off(3)],
      forced: new Set([3]),
      now: 10_000,
      memory: memory([1, 2, 3], { 1: 9_000, 2: 9_000, 3: 9_000 }),
    });
    expect(r.memory.lastQualified.get(1)).toBe(10_000);
    expect(r.memory.lastQualified.get(2)).toBe(9_000);
    expect(r.memory.lastQualified.get(3)).toBe(10_000);
    expect(r.retryInMs).toBe(1_000);
  });
});
