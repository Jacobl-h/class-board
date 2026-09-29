import { LIVE } from '@class-board/shared/constants';
import type { Rect, SlotIndex, TileView } from '@class-board/shared/types';

/** Spec §5.3 rule 1: content that can run in an iframe at all. */
export function liveEligible(view: TileView): boolean {
  if (view.kind === 'html') return view.fileUrl !== null;
  if (view.kind === 'link') {
    return view.embedUrl !== null && (view.embeddable === 'yes' || view.embeddable === 'unknown');
  }
  return false;
}

export interface LiveCandidate {
  slot: SlotIndex;
  /** liveEligible() of the tile's current content. */
  eligible: boolean;
  /** Tile body in viewport pixels (camera.slotScreenRect). */
  rect: Rect;
}

/** What chooseLive carries between calls: pass the previous result's `memory` back in. */
export interface LiveMemory {
  /** Slots that have an iframe right now. */
  live: ReadonlySet<SlotIndex>;
  /** When each live slot last qualified (or was forced). Drives the linger. */
  lastQualified: ReadonlyMap<SlotIndex, number>;
  /** Times of recent paced mounts. */
  mountTimes: readonly number[];
}

export interface ChooseLiveInput {
  candidates: readonly LiveCandidate[];
  viewport: { w: number; h: number };
  /** Pinned (focus mode) and active (in use) slots: live whenever eligible, outside the cap and pacing. */
  forced: ReadonlySet<SlotIndex>;
  /** navigator.deviceMemory in GB, when the browser reports it. */
  deviceMemory?: number;
  now: number;
  memory: LiveMemory;
}

export interface ChooseLiveResult {
  /** Every slot that has an iframe after this call (kept + mount), ascending. */
  live: SlotIndex[];
  /** Slots to mount now, forced first, then closest to the viewport centre first. */
  mount: SlotIndex[];
  /** Slots whose iframe must be removed, ascending. */
  unmount: SlotIndex[];
  /** Slots that should be live but wait for the pacing window. */
  deferred: SlotIndex[];
  /** Call again after this many ms (pacing or a linger running out); null when nothing is pending. */
  retryInMs: number | null;
  memory: LiveMemory;
}

export const EMPTY_MEMORY: LiveMemory = { live: new Set(), lastQualified: new Map(), mountTimes: [] };

/** 12 live tiles, or 6 when the browser reports 4 GB of memory or less. */
export function liveCap(deviceMemory?: number): number {
  return deviceMemory !== undefined && deviceMemory <= LIVE.lowMemoryGb ? LIVE.maxLiveLowMemory : LIVE.maxLive;
}

function onScreen(r: Rect, vw: number, vh: number): boolean {
  return r.x < vw && r.x + r.w > 0 && r.y < vh && r.y + r.h > 0;
}

export function chooseLive(input: ChooseLiveInput): ChooseLiveResult {
  const { candidates, viewport, forced, now, memory } = input;
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  const dist = (r: Rect): number => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
  const byRank = (a: LiveCandidate, b: LiveCandidate): number => dist(a.rect) - dist(b.rect) || a.slot - b.slot;

  const forcedLive: SlotIndex[] = [];
  const qualifying: LiveCandidate[] = [];
  const lingering: LiveCandidate[] = [];
  for (const c of candidates) {
    if (!c.eligible) continue; // ineligible tiles drop at once, linger or not
    if (forced.has(c.slot)) {
      forcedLive.push(c.slot);
    } else if (onScreen(c.rect, viewport.w, viewport.h) && c.rect.w >= LIVE.minWidthPx) {
      qualifying.push(c);
    } else if (memory.live.has(c.slot)) {
      const last = memory.lastQualified.get(c.slot);
      if (last !== undefined && now - last < LIVE.lingerMs) lingering.push(c);
    }
  }
  qualifying.sort(byRank);
  lingering.sort(byRank);
  // Qualifying tiles outrank lingering ones, so a linger never pushes a qualifying tile out.
  const ranked = [...qualifying, ...lingering].map((c) => c.slot);
  const cap = liveCap(input.deviceMemory);
  const top = ranked.slice(0, cap);

  const recentMounts = memory.mountTimes.filter((t) => now - t < LIVE.mountIntervalMs);
  let budget = Math.max(0, LIVE.mountBatch - recentMounts.length);
  const mount: SlotIndex[] = forcedLive.filter((s) => !memory.live.has(s));
  const paced: SlotIndex[] = [];
  const kept: SlotIndex[] = [];
  const deferred: SlotIndex[] = [];
  for (const s of top) {
    if (memory.live.has(s)) kept.push(s);
    else if (budget > 0) {
      paced.push(s);
      budget -= 1;
    } else deferred.push(s);
  }
  mount.push(...paced);

  // While replacements wait for pacing, keep displaced tiles that still qualify or linger,
  // so the number of live tiles doesn't dip.
  const spare = cap - kept.length - paced.length;
  const displaced = ranked.slice(cap).filter((s) => memory.live.has(s)).slice(0, Math.max(0, spare));

  const liveSet = new Set<SlotIndex>([...forcedLive, ...kept, ...displaced, ...paced]);
  const unmount = [...memory.live].filter((s) => !liveSet.has(s)).sort((a, b) => a - b);

  const fresh = new Set<SlotIndex>([...forcedLive, ...qualifying.map((c) => c.slot)]);
  const lastQualified = new Map<SlotIndex, number>();
  let retryAt = Infinity;
  for (const s of liveSet) {
    if (fresh.has(s)) {
      lastQualified.set(s, now);
    } else {
      const last = memory.lastQualified.get(s) ?? now;
      lastQualified.set(s, last);
      retryAt = Math.min(retryAt, last + LIVE.lingerMs);
    }
  }
  const mountTimes = [...recentMounts, ...paced.map(() => now)];
  if (deferred.length > 0) {
    retryAt = Math.min(retryAt, Math.min(...mountTimes) + LIVE.mountIntervalMs);
  }

  return {
    live: [...liveSet].sort((a, b) => a - b),
    mount,
    unmount,
    deferred,
    retryInMs: retryAt === Infinity ? null : Math.max(0, retryAt - now),
    memory: { live: liveSet, lastQualified, mountTimes },
  };
}
