# Web tiles: live frames, focus mode, post and history dialogs

These tasks build everything that happens inside and around a tile's content. `chooseLive`
(T1) is a pure function that picks which tiles run as live iframes (spec §5.3).
`createLiveFrames` (T2) uses it to mount and remove sandboxed iframes, shields and the
"Blank? Open in new tab" hint, and handles the in-use tile. The post dialog (T3) posts links
and HTML uploads, including replace mode, a live link preview and conflict errors. The history
panel (T4) lists versions and restores them. Focus mode (T5) promotes a tile's `.tile-body`
to the top layer with the Popover API, and keeps the `#C4` hash in sync with browser history.
All five follow the contracts in master plan §3 and §5. They import only
`web/src/contracts.ts` types, `web/src/ui/*` and `web/src/util/*` helpers (U1), and shared
subpath modules (F2–F4). Wiring into `main.ts` is U9's job.

**Third-party APIs used**

- **happy-dom 20.14.5** (the web test environment; https://github.com/capricorn86/happy-dom/wiki).
  Confirmed by experiment on 2026-09-29:
  - **Iframes load for real.** An `<iframe src>` attached to the document fetches the URL over
    the network (a local test server got 1 hit). Setting
    `window.happyDOM.settings.navigation.disableChildFrameNavigation = true` stops that (0 hits).
    The setting is documented under `IOptionalBrowserSettings` in the happy-dom wiki. The
    `liveFrames` test sets it in `beforeAll`.
  - **No Popover API.** `HTMLElement.prototype.showPopover` and `hidePopover` are undefined.
    Setting the `popover` attribute works, and `el.popover` reflects it. The focus test
    installs stubs.
  - **`new DragEvent('drop', { dataTransfer })` drops the `dataTransfer`.** Tests create an
    `Event('drop')` and attach `dataTransfer` with `Object.defineProperty` instead.
  - **What does work:** `new DataTransfer()` with `items.add(file)`; assigning `input.files = dt.files`;
    `File.text()`; `Blob.size` counting UTF-8 bytes; and `button.click()` on a
    `type="submit"` button, which fires the form's `submit` event.
  - **`navigator.deviceMemory` is undefined.** Tests pass `deviceMemory` explicitly.
- **Vitest 5.0.2** (https://vitest.dev/api/vi.html#vi-usefaketimers).
  - `vi.useFakeTimers()` fakes `Date` as well as timers, so `Date.now()` advances with
    `vi.advanceTimersByTime`.
  - `vi.useFakeTimers({ toFake: ['Date'] })` together with `vi.setSystemTime(t)` pins the clock
    and leaves promises and `setTimeout` real.
  - A missing module fails with `Error: Failed to resolve import "<path>" from "<test file>". Does the file exist?`.
  - A missing named export fails at the call with `TypeError: <name> is not a function`.
- **Popover API** (https://developer.mozilla.org/en-US/docs/Web/API/Popover_API). The
  `popover="manual"` attribute plus `showPopover()` and `hidePopover()` put the element in the
  top layer, and `:popover-open` matches while it's shown. The UA stylesheet gives `[popover]`
  a border, padding, `margin: auto`, `width` and `height: fit-content`, and `overflow: auto`,
  so `focus.css` overrides every one of them. Master plan §10 spike 1 verified the approach in
  Chromium. `showPopover()` on an already-open popover, or `hidePopover()` on a closed one,
  may throw `InvalidStateError` (older spec text), so `focus.ts` guards both. TypeScript 7.0.2's
  `lib.dom` declares both methods.
- **TypeScript 7.0.2 and Vite 8.3.1:** the versions npm resolves today. Every file below
  type-checks under `strict` with `noUncheckedIndexedAccess`, `noUnusedLocals` and
  `noUnusedParameters`. CSS files are imported for their side effects (`import './focus.css'`);
  Vitest doesn't process CSS by default, but the file must exist.

**Assumptions about other workstreams (from the contracts):**
- `h()` (U1) may be typed to return a generic `HTMLElement`. Every element whose specific
  properties are used (`.value`, `.files`, `.disabled`) is cast (`as HTMLInputElement`),
  which compiles whichever way U1 types it.
- `openModal().close()` (U1) removes the `.modal` element from `#modal-root`, and the tests
  check for that.
- `errorText` (U1) is imported by the tests, so they don't depend on its wording.
- Grid (U6) handles clicks on any `[data-action]` inside a tile, including the hint button
  that LiveFrames adds inside `.tile-frame` (`data-action="open"`).
- Grid never replaces `.tile-body` or `.tile-frame` on a `'tile'` update. If it does, both
  LiveFrames and Focus recover on their next pass, and both re-apply their own classes after
  Grid in case Grid rewrites `className`.

---

### Task T1: chooseLive (pure selection)

**Wave:** 2 · **Tier:** T2 (`sonnet`, `medium`) · **Depends on:** F2

**Files:**
- Create: `web/src/board/chooseLive.ts`
- Test: `web/test/chooseLive.test.ts`

`chooseLive` is pure: the caller passes candidates (slot, eligibility, on-screen rect), the
viewport, the forced slots (pinned and active), the clock, and the `memory` from the previous
call. It returns what to mount, what to unmount, what's deferred by pacing, and when to call
again. Only T2 uses it; the types are defined here.

Rules (spec §5.3, `LIVE` constants):
- **Eligible:** `liveEligible(view)`.
- **Qualifies:** eligible, intersects the viewport, and at least `LIVE.minWidthPx` wide.
- **Cap:** `liveCap(deviceMemory)`. Rank by the distance from the tile's center to the
  viewport center, with ties broken by slot.
- **Forced** slots are live whenever they're eligible, outside the cap and outside pacing.
- **Linger:** a slot that was live stays for `lingerMs` after it last qualified. Ineligible
  slots drop at once. Qualifying slots rank ahead of lingering ones.
- **Pacing:** at most `mountBatch` paced mounts per `mountIntervalMs`. Tiles waiting for
  pacing are `deferred`. While they wait, displaced live tiles fill any spare cap places, so
  the live count doesn't dip.

- [ ] **Step 1: Write the failing test for eligibility and the cap**

`web/test/chooseLive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TileView } from '@class-board/shared/types';
import { liveCap, liveEligible } from '../src/board/chooseLive';

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- chooseLive`
Expected: FAIL, `Failed to resolve import "../src/board/chooseLive" from "web/test/chooseLive.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `liveEligible` and `liveCap`**

`web/src/board/chooseLive.ts`:

```ts
import { LIVE } from '@class-board/shared/constants';
import type { TileView } from '@class-board/shared/types';

/** Spec §5.3 rule 1: content that can run in an iframe at all. */
export function liveEligible(view: TileView): boolean {
  if (view.kind === 'html') return view.fileUrl !== null;
  if (view.kind === 'link') {
    return view.embedUrl !== null && (view.embeddable === 'yes' || view.embeddable === 'unknown');
  }
  return false;
}

/** 12 live tiles, or 6 when the browser reports 4 GB of memory or less. */
export function liveCap(deviceMemory?: number): number {
  return deviceMemory !== undefined && deviceMemory <= LIVE.lowMemoryGb ? LIVE.maxLiveLowMemory : LIVE.maxLive;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- chooseLive`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing tests for selection, cap, linger and pacing**

Replace `web/test/chooseLive.test.ts` with:

```ts
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
```

- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm test -w web -- chooseLive`
Expected: FAIL, `13 failed | 3 passed (16)`, each with `TypeError: chooseLive is not a function`.

- [ ] **Step 7: Implement `chooseLive`**

Replace `web/src/board/chooseLive.ts` with:

```ts
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
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- chooseLive`
Expected: PASS (16 tests).

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add web/src/board/chooseLive.ts web/test/chooseLive.test.ts
git commit -m "feat(web): chooseLive (pure selection) (T1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task T2: Live frames manager

**Wave:** 3 · **Tier:** T3 (`opus`, `medium`) · **Depends on:** T1, U1, F3, F4

**Files:**
- Create: `web/src/board/liveFrames.ts`, `web/src/board/frames.css`
- Test: `web/test/liveFrames.test.ts`

How it works:
- **Each pass** (`run`) builds candidates for all 80 slots from `state.tile(slot)` and
  `camera.slotScreenRect(slot)`, then calls `chooseLive` with `forced` = the pinned slots
  plus the active slot. It applies the unmounts, then refreshes the mounted tiles, then does
  the mounts.
- **`update()`** is coalesced: one `schedule()` callback per burst of calls.
  `schedule` defaults to `requestAnimationFrame`.
- **Retries:** when `chooseLive` returns `retryInMs`, a `setTimeout` calls `update()` again,
  for pacing and for lingers running out.
- **Iframes** get `sandbox` and `allow` before `src`, and never get a `referrerpolicy`.
  - `src` is `embedUrl` for links, or `serverHref(serverUrl, fileUrl)` for uploads.
  - `allow-same-origin` is left out for uploads, and for any `src` whose `originOf` equals
    `boardOrigin`.
  - A new `version` (or a new `src`) replaces the iframe. A re-rendered frame host gets a
    fresh iframe.
- **Shield and hint:** a `.tile-shield` sits over every live iframe except the active one. The
  hint, `button.tile-blank-hint[data-action="open"]`, shows only while `embeddable` is
  `unknown`; Grid's delegated click handler opens the tile.
- **Classes and active state:** `is-live` and `is-active` go on `grid.tileEl(slot)`, and are
  re-applied on every pass. `activate(slot)` only works on a live tile. `deactivate()` and Esc
  (a `keydown` on `document`) put the shield back.
- **`destroy()`** unsubscribes, clears the timer and removes every iframe.

- [ ] **Step 1: Write the failing test**

`web/test/liveFrames.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Rect, TileView } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, CameraApi, GridApi, LiveFramesApi } from '../src/contracts';
import { createLiveFrames } from '../src/board/liveFrames';

const SERVER = 'http://localhost:8787';
const BOARD_ORIGIN = 'https://jacobl-h.github.io';
const FULL_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const NO_SAME_ORIGIN =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen';

beforeAll(() => {
  // happy-dom would otherwise fetch every iframe src over the real network.
  const happy = (window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM;
  happy.settings.navigation.disableChildFrameNavigation = true;
});

function emptyView(slot: number): TileView {
  return {
    slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

function linkView(slot: number, patch: Partial<TileView> = {}): TileView {
  return {
    ...emptyView(slot), version: 1, kind: 'link', label: 'Maya', url: 'https://game.example.test/play',
    embedUrl: 'https://game.example.test/play', title: 'Space game', embeddable: 'yes', ...patch,
  };
}

function htmlView(slot: number, patch: Partial<TileView> = {}): TileView {
  return {
    ...emptyView(slot), version: 2, kind: 'html', label: 'Ana', fileUrl: '/boards/main/files/abc123',
    title: 'My page', embeddable: 'yes', ...patch,
  };
}

function makeState() {
  const tiles = Array.from({ length: SLOT_COUNT }, (_, i) => emptyView(i));
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const api = {
    ready: () => true,
    tiles: () => tiles,
    tile: (slot: number) => tiles[slot],
    locked: () => false,
    on(event: keyof BoardStateEvents, fn: (p: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return () => handlers.get(event)!.delete(fn);
    },
  } as unknown as BoardStateApi;
  return {
    api,
    set(view: TileView) {
      tiles[view.slot] = view;
      for (const fn of handlers.get('tile') ?? []) fn(view);
    },
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

function makeCamera() {
  const rects = new Map<number, Rect>();
  const listeners = new Set<() => void>();
  const api = {
    viewport: () => ({ w: 1600, h: 1000 }),
    slotScreenRect: (slot: number) => rects.get(slot) ?? { x: 9000, y: 9000, w: 480, h: 300 },
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as CameraApi;
  return {
    api,
    show(slot: number, x = 560) {
      rects.set(slot, { x, y: 350, w: 480, h: 300 });
    },
    hide(slot: number) {
      rects.delete(slot);
    },
    move() {
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
}

function makeGrid() {
  const tiles = new Map<number, HTMLElement>();
  const ensure = (slot: number): HTMLElement => {
    let tile = tiles.get(slot);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.slot = String(slot);
      tile.innerHTML = '<div class="tile-body"><div class="tile-card"></div><div class="tile-frame"></div></div>';
      document.body.append(tile);
      tiles.set(slot, tile);
    }
    return tile;
  };
  const api = {
    tileEl: (slot: number) => ensure(slot),
    bodyEl: (slot: number) => ensure(slot).querySelector('.tile-body') as HTMLElement,
    frameHost: (slot: number) => ensure(slot).querySelector('.tile-frame') as HTMLElement,
  } as unknown as GridApi;
  return {
    api,
    /** Simulates Grid re-rendering a tile's body, which replaces its frame host. */
    rerender(slot: number) {
      ensure(slot).innerHTML = '<div class="tile-body"><div class="tile-card"></div><div class="tile-frame"></div></div>';
    },
  };
}

let state: ReturnType<typeof makeState>;
let camera: ReturnType<typeof makeCamera>;
let grid: ReturnType<typeof makeGrid>;
let live: LiveFramesApi | null = null;

function start(extra: { now?: () => number; schedule?: (fn: () => void) => void } = {}): LiveFramesApi {
  live = createLiveFrames({
    grid: grid.api, camera: camera.api, state: state.api, serverUrl: SERVER, boardOrigin: BOARD_ORIGIN,
    deviceMemory: 8, schedule: (fn) => fn(), ...extra,
  });
  return live;
}

const frameOf = (slot: number) => grid.api.frameHost(slot).querySelector('iframe');
const shieldOf = (slot: number) => grid.api.frameHost(slot).querySelector('.tile-shield');
const hintOf = (slot: number) => grid.api.frameHost(slot).querySelector<HTMLButtonElement>('.tile-blank-hint');

beforeEach(() => {
  document.body.innerHTML = '';
  state = makeState();
  camera = makeCamera();
  grid = makeGrid();
});

afterEach(() => {
  live?.destroy();
  live = null;
  vi.useRealTimers();
});

describe('createLiveFrames', () => {
  it('mounts an iframe for an on-screen link with the embed URL, the full sandbox and a shield', () => {
    state.set(linkView(23));
    camera.show(23);
    const lf = start();
    const iframe = frameOf(23)!;
    expect(iframe.getAttribute('src')).toBe('https://game.example.test/play');
    expect(iframe.getAttribute('sandbox')).toBe(FULL_SANDBOX);
    expect(iframe.getAttribute('allow')).toBe(ALLOW);
    expect(iframe.title).toBe('Space game');
    expect(iframe.hasAttribute('referrerpolicy')).toBe(false);
    expect(shieldOf(23)).not.toBeNull();
    expect(grid.api.tileEl(23).classList.contains('is-live')).toBe(true);
    expect(lf.isLive(23)).toBe(true);
  });

  it('frames uploads from the server without allow-same-origin', () => {
    state.set(htmlView(5));
    camera.show(5);
    start();
    const iframe = frameOf(5)!;
    expect(iframe.getAttribute('src')).toBe('http://localhost:8787/boards/main/files/abc123');
    expect(iframe.getAttribute('sandbox')).toBe(NO_SAME_ORIGIN);
  });

  it("drops allow-same-origin for links on the board's own origin", () => {
    state.set(linkView(6, { embedUrl: 'https://jacobl-h.github.io/other-project/' }));
    camera.show(6);
    start();
    expect(frameOf(6)!.getAttribute('sandbox')).toBe(NO_SAME_ORIGIN);
  });

  it('does not mount blocked, pending or off-screen tiles', () => {
    state.set(linkView(1, { embeddable: 'no' }));
    state.set(linkView(2, { embeddable: 'pending' }));
    state.set(linkView(3));
    camera.show(1, 0);
    camera.show(2, 500);
    const lf = start();
    expect(frameOf(1)).toBeNull();
    expect(frameOf(2)).toBeNull();
    expect(frameOf(3)).toBeNull();
    expect(lf.isLive(3)).toBe(false);
  });

  it('shows the blank hint only while a live tile is embeddable unknown', () => {
    state.set(linkView(8, { embeddable: 'unknown' }));
    camera.show(8);
    start();
    expect(hintOf(8)!.hidden).toBe(false);
    expect(hintOf(8)!.dataset.action).toBe('open');
    expect(hintOf(8)!.textContent).toBe('Blank? Open in new tab');
    const before = frameOf(8);
    state.set(linkView(8, { embeddable: 'yes' }));
    expect(hintOf(8)!.hidden).toBe(true);
    expect(frameOf(8)).toBe(before);
  });

  it('replaces the iframe when the tile version changes', () => {
    state.set(linkView(23));
    camera.show(23);
    start();
    const old = frameOf(23)!;
    state.set(linkView(23, { version: 2, embedUrl: 'https://other.example.test/', title: 'Other' }));
    const next = frameOf(23)!;
    expect(next).not.toBe(old);
    expect(old.isConnected).toBe(false);
    expect(next.getAttribute('src')).toBe('https://other.example.test/');
    expect(grid.api.frameHost(23).querySelectorAll('iframe')).toHaveLength(1);
  });

  it('removes the iframe when the content becomes ineligible', () => {
    state.set(linkView(23));
    camera.show(23);
    const lf = start();
    state.set(emptyView(23));
    expect(frameOf(23)).toBeNull();
    expect(shieldOf(23)).toBeNull();
    expect(grid.api.tileEl(23).classList.contains('is-live')).toBe(false);
    expect(lf.isLive(23)).toBe(false);
  });

  it('remounts into a new frame host after Grid re-renders the tile', () => {
    state.set(linkView(23));
    camera.show(23);
    start();
    grid.rerender(23);
    state.set(linkView(23));
    expect(frameOf(23)!.getAttribute('src')).toBe('https://game.example.test/play');
  });

  it('activate removes the shield and marks the tile; deactivate puts both back', () => {
    state.set(linkView(23));
    camera.show(23);
    const lf = start();
    const seen: Array<number | null> = [];
    lf.onActiveChange((s) => seen.push(s));
    lf.activate(23);
    expect(shieldOf(23)).toBeNull();
    expect(grid.api.tileEl(23).classList.contains('is-active')).toBe(true);
    expect(lf.active()).toBe(23);
    lf.deactivate();
    expect(shieldOf(23)).not.toBeNull();
    expect(grid.api.tileEl(23).classList.contains('is-active')).toBe(false);
    expect(lf.active()).toBeNull();
    expect(seen).toEqual([23, null]);
  });

  it('ignores activate on a tile that is not live', () => {
    const lf = start();
    lf.activate(4);
    expect(lf.active()).toBeNull();
  });

  it('deactivates on Escape', () => {
    state.set(linkView(23));
    camera.show(23);
    const lf = start();
    lf.activate(23);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(lf.active()).toBeNull();
  });

  it('keeps a pinned tile live off screen, and lets it go 2 s after unpin', () => {
    let t = 0;
    state.set(linkView(40));
    const lf = start({ now: () => t });
    lf.pin(40);
    expect(frameOf(40)).not.toBeNull();
    lf.unpin(40);
    expect(frameOf(40)).not.toBeNull();
    t = 2_000;
    camera.move();
    expect(frameOf(40)).toBeNull();
  });

  it('coalesces update calls through schedule', () => {
    const queue: Array<() => void> = [];
    state.set(linkView(23));
    camera.show(23);
    start({ schedule: (fn) => queue.push(fn) });
    camera.move();
    camera.move();
    state.set(linkView(23));
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(frameOf(23)).not.toBeNull();
  });

  it('mounts at most 2 iframes per 250 ms and mounts the rest later', () => {
    vi.useFakeTimers();
    for (const s of [1, 2, 3]) {
      state.set(linkView(s));
      camera.show(s, 200 + s * 100);
    }
    start();
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(document.querySelectorAll('iframe')).toHaveLength(3);
  });

  it('destroy removes every iframe and stops listening', () => {
    state.set(linkView(23));
    camera.show(23);
    const lf = start();
    lf.destroy();
    live = null;
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(grid.api.tileEl(23).classList.contains('is-live')).toBe(false);
    expect(camera.listenerCount()).toBe(0);
    expect(state.listenerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- liveFrames`
Expected: FAIL, `Failed to resolve import "../src/board/liveFrames" from "web/test/liveFrames.test.ts". Does the file exist?`

- [ ] **Step 3: Create the styles**

`web/src/board/frames.css`:

```css
/* Live tiles: the iframe, its shield and the "Blank?" hint (LiveFrames owns .tile-frame). */

.tile-frame {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none; /* an empty frame host never blocks the card underneath */
}

.tile-frame > * {
  pointer-events: auto;
}

.tile-frame iframe {
  position: absolute;
  left: 0;
  top: 0;
  width: 1280px;
  height: 800px;
  border: 0;
  transform: scale(0.375);
  transform-origin: 0 0;
  background: #fff;
}

.tile-shield {
  position: absolute;
  inset: 0;
  cursor: pointer;
  background: transparent;
}

.tile.is-live .tile-card {
  visibility: hidden;
}

.tile.is-live .tile-actions {
  z-index: 3;
}

.tile.is-active .tile-body {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.tile-blank-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: 500 12px/1.4 var(--font);
  cursor: pointer;
}

.tile-blank-hint[hidden] {
  display: none;
}
```

- [ ] **Step 4: Implement the manager**

`web/src/board/liveFrames.ts`:

```ts
import { SLOT_COUNT } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { Rect, SlotIndex, TileView } from '@class-board/shared/types';
import { originOf } from '@class-board/shared/urls';
import type { LiveFramesApi, LiveFramesDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { serverHref } from '../util/url';
import { chooseLive, EMPTY_MEMORY, liveEligible, type LiveCandidate, type LiveMemory } from './chooseLive';
import './frames.css';

const SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
  'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads',
];
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen';
const OFF_SCREEN: Rect = { x: -1e9, y: -1e9, w: 0, h: 0 };

interface Mounted {
  /** version + src: a change means the iframe must be replaced. */
  key: string;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  shield: HTMLDivElement;
  hint: HTMLButtonElement;
}

function frameSrc(view: TileView, serverUrl: string): string | null {
  if (view.kind === 'html') return view.fileUrl === null ? null : serverHref(serverUrl, view.fileUrl);
  return view.embedUrl;
}

function sandboxFor(view: TileView, src: string, boardOrigin: string): string {
  // Uploads never get allow-same-origin; neither do pages on the board's own origin,
  // which could otherwise script the board.
  const drop = view.kind === 'html' || originOf(src) === boardOrigin;
  return (drop ? SANDBOX.filter((t) => t !== 'allow-same-origin') : SANDBOX).join(' ');
}

export function createLiveFrames(deps: LiveFramesDeps): LiveFramesApi {
  const { grid, camera, state, serverUrl, boardOrigin } = deps;
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(() => fn()); });
  const deviceMemory = deps.deviceMemory ?? (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  const mounted = new Map<SlotIndex, Mounted>();
  const pinned = new Set<SlotIndex>();
  const listeners = new Set<(slot: SlotIndex | null) => void>();
  let memory: LiveMemory = EMPTY_MEMORY;
  let activeSlot: SlotIndex | null = null;
  let queued = false;
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function update(): void {
    if (queued || destroyed) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (!destroyed) run();
    });
  }

  function run(): void {
    const candidates: LiveCandidate[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const eligible = liveEligible(state.tile(slot));
      candidates.push({ slot, eligible, rect: eligible ? camera.slotScreenRect(slot) : OFF_SCREEN });
    }
    const forced = new Set(pinned);
    if (activeSlot !== null) forced.add(activeSlot);
    const result = chooseLive({ candidates, viewport: camera.viewport(), forced, deviceMemory, now: now(), memory });
    memory = result.memory;

    for (const slot of result.unmount) unmount(slot);
    for (const slot of result.live) if (mounted.has(slot)) refresh(slot);
    for (const slot of result.mount) mount(slot);
    if (activeSlot !== null && !mounted.has(activeSlot)) setActive(null);

    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (result.retryInMs !== null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        update();
      }, result.retryInMs);
    }
  }

  function makeIframe(view: TileView, src: string): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    // sandbox and allow must be in place before src starts the navigation.
    iframe.setAttribute('sandbox', sandboxFor(view, src, boardOrigin));
    iframe.setAttribute('allow', ALLOW);
    iframe.title = view.title ?? (view.label || slotName(view.slot));
    iframe.src = src;
    return iframe;
  }

  function mount(slot: SlotIndex): void {
    const view = state.tile(slot);
    const src = frameSrc(view, serverUrl);
    if (src === null) return;
    const host = grid.frameHost(slot);
    const iframe = makeIframe(view, src);
    const shield = h('div', { class: 'tile-shield' }) as HTMLDivElement;
    const hint = h('button', {
      type: 'button',
      class: 'tile-blank-hint',
      dataset: { action: 'open' },
      textContent: 'Blank? Open in new tab',
    }) as HTMLButtonElement;
    hint.hidden = view.embeddable !== 'unknown';
    host.append(iframe);
    if (slot !== activeSlot) host.append(shield);
    host.append(hint);
    mounted.set(slot, { key: `${view.version}|${src}`, host, iframe, shield, hint });
    applyClasses(slot);
  }

  function unmount(slot: SlotIndex): void {
    const m = mounted.get(slot);
    if (!m) return;
    m.iframe.remove();
    m.shield.remove();
    m.hint.remove();
    mounted.delete(slot);
    grid.tileEl(slot).classList.remove('is-live', 'is-active');
  }

  /** Re-check a mounted tile: new version or a re-rendered host → new iframe; hint and classes re-applied. */
  function refresh(slot: SlotIndex): void {
    const m = mounted.get(slot);
    if (!m) return;
    const view = state.tile(slot);
    const src = frameSrc(view, serverUrl);
    if (src === null) {
      unmount(slot);
      return;
    }
    if (m.key !== `${view.version}|${src}` || m.host !== grid.frameHost(slot) || !m.host.isConnected) {
      unmount(slot);
      mount(slot);
      return;
    }
    m.hint.hidden = view.embeddable !== 'unknown';
    applyClasses(slot);
  }

  /** Grid may rewrite a tile's classes when it re-renders, so these are re-applied on every pass. */
  function applyClasses(slot: SlotIndex): void {
    const tile = grid.tileEl(slot);
    tile.classList.add('is-live');
    tile.classList.toggle('is-active', slot === activeSlot);
  }

  function setActive(slot: SlotIndex | null): void {
    if (activeSlot === slot) return;
    const prev = activeSlot;
    activeSlot = slot;
    if (prev !== null) {
      const m = mounted.get(prev);
      if (m) m.host.insertBefore(m.shield, m.hint);
      grid.tileEl(prev).classList.remove('is-active');
    }
    if (slot !== null) {
      mounted.get(slot)?.shield.remove();
      grid.tileEl(slot).classList.add('is-active');
    }
    for (const fn of listeners) fn(slot);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && activeSlot !== null) api.deactivate();
  }

  const unsubs: Unsubscribe[] = [
    camera.onChange(() => update()),
    state.on('snapshot', () => update()),
    state.on('tile', () => update()),
  ];
  document.addEventListener('keydown', onKeyDown);

  const api: LiveFramesApi = {
    update,
    isLive: (slot) => mounted.has(slot),
    active: () => activeSlot,
    activate(slot) {
      if (!mounted.has(slot)) return;
      setActive(slot);
    },
    deactivate() {
      if (activeSlot === null) return;
      setActive(null);
      update();
    },
    pin(slot) {
      pinned.add(slot);
      update();
    },
    unpin(slot) {
      pinned.delete(slot);
      update();
    },
    onActiveChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      for (const u of unsubs) u();
      document.removeEventListener('keydown', onKeyDown);
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      for (const slot of [...mounted.keys()]) unmount(slot);
      activeSlot = null;
      listeners.clear();
    },
  };

  update();
  return api;
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- liveFrames`
Expected: PASS (15 tests). If a test hangs or logs a fetch error, check that the `beforeAll`
that sets `disableChildFrameNavigation` is present. Without it, happy-dom loads iframe URLs
over the network.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/board/liveFrames.ts web/src/board/frames.css web/test/liveFrames.test.ts
git commit -m "feat(web): live frames manager (T2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task T3: Post dialog

**Wave:** 4 · **Tier:** T2 (`sonnet`, `medium`) · **Depends on:** U1, F2, F3, F4

**Files:**
- Create: `web/src/tiles/postDialog.ts`, `web/src/tiles/postDialog.css`
- Test: `web/test/postDialog.test.ts`

How it works:
- **Opening:** `openPostDialog(deps, slot, mode)` captures
  `baseVersion = state.tile(slot).version` and opens `openModal({ dialog: 'post' })` with a
  `<form>` body.
- **Tabs:**
  - `[data-tab="link"]` has `input[name="url"]` and a `.link-preview`, which runs `planLink`
    on every input.
  - `[data-tab="html"]` has `input[name="file"]` and `textarea[name="html"]`.
  - Dropping a file anywhere on the modal switches to the HTML tab and chooses the file.
  - Typing in the textarea clears a chosen file.
- **Submit** (`[data-action="submit"]`, `type="submit"`) is disabled while sending.
  - A link posts `{ kind: 'link', url: plan.url }`.
  - HTML is checked on the client: `.html` or `.htm` name, and at most `LIMITS.htmlMaxBytes`.
    It's uploaded with `deps.upload(blob, name)`, where pasted text becomes `pasted.html`, and
    then posted as `{ kind: 'html', fileId }`.
  - If the upload succeeded but the post failed, a retry reuses the file id.
  - An empty label falls back to `defaultLabel()`.
  - `ok` closes the modal.
- **Errors** go in `.dialog-error`:
  - A conflict gets the exact spec sentence, with `slotName(slot)`.
  - Any other server error uses `errorText(code)`.
  - Upload failures, which arrive before any request is sent, use their own messages keyed by
    `UploadError.code`. The code is read by duck typing, so this file doesn't import U3's
    module.
- **`reqId`:** a private helper makes it (12 base36 characters, the same format as
  `newReqId`), because only `main.ts` may import `net/socket.ts`.

- [ ] **Step 1: Write the failing test**

`web/test/postDialog.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { ErrorCode, RequestMsg, ServerMsg, TileView } from '@class-board/shared/types';
import { NOTES } from '@class-board/shared/urls';
import type { BoardSocket, BoardStateApi, PostDialogDeps } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { openPostDialog } from '../src/tiles/postDialog';

const C4 = 23;

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

function emptyView(slot: number): TileView {
  return {
    slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

function serverError(code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(code), { code });
}

function uploadError(code: 'too_large' | 'invalid' | 'rate_limited' | 'network'): Error & { code: string } {
  return Object.assign(new Error(code), { name: 'UploadError', code });
}

/** Resolves only when the test says so, to observe the dialog mid-request. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(tile: TileView = emptyView(C4)) {
  const tiles = Array.from({ length: SLOT_COUNT }, (_, i) => emptyView(i));
  tiles[tile.slot] = tile;
  const sent: RequestMsg[] = [];
  let reply: (msg: RequestMsg) => Promise<Reply> = async (msg) => ({ type: 'ok', reqId: msg.reqId });
  const socket = {
    request: vi.fn((msg: RequestMsg) => {
      sent.push(msg);
      return reply(msg);
    }),
  } as unknown as BoardSocket;
  const state = { tile: (slot: number) => tiles[slot] } as unknown as BoardStateApi;
  const uploads: Array<{ html: Blob; fileName: string }> = [];
  let uploadImpl: (html: Blob, fileName: string) => Promise<string> = async () => 'f'.repeat(32);
  const deps: PostDialogDeps = {
    socket,
    state,
    upload: vi.fn((html: Blob, fileName: string) => {
      uploads.push({ html, fileName });
      return uploadImpl(html, fileName);
    }),
    defaultLabel: () => 'Maya',
  };
  return {
    deps,
    sent,
    uploads,
    tiles,
    setReply(fn: (msg: RequestMsg) => Promise<Reply>) {
      reply = fn;
    },
    setUpload(fn: (html: Blob, fileName: string) => Promise<string>) {
      uploadImpl = fn;
    },
  };
}

const dialog = () => document.querySelector<HTMLElement>('.modal[data-dialog="post"]');
const q = <T extends Element>(sel: string) => dialog()!.querySelector<T>(sel)!;
const submitBtn = () => q<HTMLButtonElement>('[data-action="submit"]');
const errorEl = () => q<HTMLElement>('.dialog-error');
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function type(sel: string, value: string): void {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function chooseFile(file: File): void {
  const input = q<HTMLInputElement>('input[name="file"]');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dropFile(file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  // happy-dom's DragEvent ignores dataTransfer in its init dict, so attach it directly.
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  q<HTMLElement>('.post-form').dispatchEvent(ev);
}

async function submit(): Promise<void> {
  submitBtn().click();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});

describe('openPostDialog: layout', () => {
  it('opens the post modal on the link tab with the label prefilled from the cursor name', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    expect(dialog()).not.toBeNull();
    expect(q('[data-tab="link"]').getAttribute('aria-selected')).toBe('true');
    expect(q<HTMLElement>('[data-panel="link"]').hidden).toBe(false);
    expect(q<HTMLElement>('[data-panel="html"]').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="label"]').value).toBe('Maya');
    expect(q<HTMLInputElement>('input[name="label"]').maxLength).toBe(40);
    expect(dialog()!.textContent).not.toContain('This replaces');
  });

  it('switches to the HTML tab with a file input and a paste area', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    expect(q<HTMLElement>('[data-panel="html"]').hidden).toBe(false);
    expect(q<HTMLElement>('[data-panel="link"]').hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="file"]').accept).toBe('.html,.htm,text/html');
    expect(q('textarea[name="html"]')).not.toBeNull();
  });

  it("warns in replace mode, naming the tile's label", () => {
    const { deps } = makeDeps({ ...emptyView(C4), version: 7, kind: 'link', label: 'Maya', authorName: 'Maya R' });
    openPostDialog(deps, C4, 'replace');
    expect(q('.post-warning').textContent).toBe("This replaces Maya's tile. Their version stays in History.");
  });

  it('falls back to the author name when the tile has no label', () => {
    const { deps } = makeDeps({ ...emptyView(C4), version: 7, kind: 'link', label: '', authorName: 'Ben' });
    openPostDialog(deps, C4, 'replace');
    expect(q('.post-warning').textContent).toBe("This replaces Ben's tile. Their version stays in History.");
  });
});

describe('openPostDialog: link preview', () => {
  it('explains a rejected link as the student types', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'ftp://files.example.com/x');
    expect(q('.link-preview').textContent).toBe('Only http and https links can be posted.');
    type('input[name="url"]', 'http://localhost:3000/');
    expect(q('.link-preview').textContent).toContain("Links to local or private addresses can't be shown");
  });

  it('says early that a newer Claude artifact cannot be embedded', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'https://claude.ai/artifact/abc-123');
    expect(q('.link-preview').textContent).toBe(NOTES.claudeNew);
    expect(q<HTMLElement>('.link-preview').dataset.tone).toBe('warn');
  });

  it('names the host of an ordinary link and clears when emptied', () => {
    const { deps } = makeDeps();
    openPostDialog(deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/play');
    expect(q('.link-preview').textContent).toContain('game.example.com');
    type('input[name="url"]', '');
    expect(q('.link-preview').textContent).toBe('');
  });
});

describe('openPostDialog: posting a link', () => {
  it('sends a post with the base version captured at open and closes on ok', async () => {
    const env = makeDeps({ ...emptyView(C4), version: 5, kind: 'link', label: 'Old' });
    openPostDialog(env.deps, C4, 'replace');
    env.tiles[C4] = { ...env.tiles[C4]!, version: 6 }; // a later update must not change baseVersion
    type('input[name="url"]', 'https://game.example.com/play');
    type('input[name="label"]', '  Team rocket  ');
    await submit();
    expect(env.sent).toHaveLength(1);
    const msg = env.sent[0] as Extract<RequestMsg, { type: 'post' }>;
    expect(msg).toMatchObject({
      type: 'post', slot: C4, baseVersion: 5, label: 'Team rocket',
      content: { kind: 'link', url: 'https://game.example.com/play' },
    });
    expect(msg.reqId).toMatch(/^[0-9a-z]{12}$/);
    expect(dialog()).toBeNull();
  });

  it('uses the cursor name when the label is left empty', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    type('input[name="label"]', '   ');
    await submit();
    expect((env.sent[0] as Extract<RequestMsg, { type: 'post' }>).label).toBe('Maya');
  });

  it('does not send a rejected or empty link', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    await submit();
    expect(errorEl().textContent).toBe('Paste a link to post.');
    type('input[name="url"]', 'not a link');
    await submit();
    expect(env.sent).toHaveLength(0);
    expect(errorEl().hidden).toBe(false);
    expect(errorEl().textContent).toContain("doesn't look like a link");
  });

  it('disables submit while sending and ignores a second click', async () => {
    const env = makeDeps();
    const pending = deferred<Reply>();
    env.setReply(() => pending.promise);
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(submitBtn().disabled).toBe(true);
    await submit();
    expect(env.sent).toHaveLength(1);
    pending.resolve({ type: 'ok', reqId: env.sent[0]!.reqId });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('shows the conflict message with the slot name and stays open', async () => {
    const env = makeDeps();
    env.setReply(async () => {
      throw serverError('conflict');
    });
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(errorEl().textContent).toBe('Someone just posted to C4. Pick another tile or replace theirs.');
    expect(dialog()).not.toBeNull();
    expect(submitBtn().disabled).toBe(false);
  });

  it('shows errorText for other server errors', async () => {
    const env = makeDeps();
    env.setReply(async () => {
      throw serverError('locked');
    });
    openPostDialog(env.deps, C4, 'add');
    type('input[name="url"]', 'https://game.example.com/');
    await submit();
    expect(errorEl().textContent).toBe(errorText('locked'));
  });
});

describe('openPostDialog: posting HTML', () => {
  it('uploads a chosen file, then posts its file id', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    const file = new File(['<title>Game</title><p>hi</p>'], 'game.html', { type: 'text/html' });
    chooseFile(file);
    await submit();
    expect(env.uploads).toEqual([{ html: file, fileName: 'game.html' }]);
    expect(env.sent[0]).toMatchObject({ type: 'post', content: { kind: 'html', fileId: 'f'.repeat(32) } });
    expect(dialog()).toBeNull();
  });

  it('uploads pasted HTML as pasted.html', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    type('textarea[name="html"]', '<h1>Hello</h1>');
    await submit();
    expect(env.uploads).toHaveLength(1);
    expect(env.uploads[0]!.fileName).toBe('pasted.html');
    expect(await env.uploads[0]!.html.text()).toBe('<h1>Hello</h1>');
  });

  it('accepts a file dropped anywhere on the dialog and switches to the HTML tab', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    dropFile(new File(['<p>drop</p>'], 'dropped.htm', { type: 'text/html' }));
    expect(q('[data-tab="html"]').getAttribute('aria-selected')).toBe('true');
    expect(q('.post-file-name').textContent).toBe('dropped.htm');
    await submit();
    expect(env.uploads[0]!.fileName).toBe('dropped.htm');
  });

  it('rejects files over 1 MB before uploading', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['<' + 'a'.repeat(1_000_000)], 'big.html', { type: 'text/html' }));
    await submit();
    expect(env.uploads).toHaveLength(0);
    expect(errorEl().textContent).toBe('That file is over 1 MB. Upload a smaller HTML file.');
  });

  it('rejects files that are not .html or .htm', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['x'], 'app.jsx'));
    await submit();
    expect(env.uploads).toHaveLength(0);
    expect(errorEl().textContent).toBe('Only .html or .htm files can be uploaded.');
  });

  it('asks for HTML when nothing was chosen or pasted', async () => {
    const env = makeDeps();
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    await submit();
    expect(errorEl().textContent).toBe('Choose an HTML file, drop one here, or paste HTML.');
  });

  it.each([
    ['too_large', 'That file is over 1 MB. Upload a smaller HTML file.'],
    ['invalid', "That file isn't an HTML page. Choose a .html or .htm file saved as UTF-8."],
    ['rate_limited', 'Too many uploads in the last minute. Wait a moment, then press Post to try again.'],
    ['network', "The upload didn't reach the board server. Check your connection, then press Post to try again."],
  ] as const)('explains an upload error %s and posts nothing', async (code, text) => {
    const env = makeDeps();
    env.setUpload(async () => {
      throw uploadError(code);
    });
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    type('textarea[name="html"]', '<p>x</p>');
    await submit();
    expect(errorEl().textContent).toBe(text);
    expect(env.sent).toHaveLength(0);
    expect(submitBtn().disabled).toBe(false);
  });

  it('does not upload the same file twice when only the post failed', async () => {
    const env = makeDeps();
    let first = true;
    env.setReply(async (msg) => {
      if (first) {
        first = false;
        throw serverError('rate_limited');
      }
      return { type: 'ok', reqId: msg.reqId };
    });
    openPostDialog(env.deps, C4, 'add');
    q<HTMLButtonElement>('[data-tab="html"]').click();
    chooseFile(new File(['<p>x</p>'], 'page.html', { type: 'text/html' }));
    await submit();
    expect(errorEl().textContent).toBe(errorText('rate_limited'));
    await submit();
    expect(env.uploads).toHaveLength(1);
    expect(env.sent).toHaveLength(2);
    expect(dialog()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- postDialog`
Expected: FAIL, `Failed to resolve import "../src/tiles/postDialog" from "web/test/postDialog.test.ts". Does the file exist?`

- [ ] **Step 3: Create the styles**

`web/src/tiles/postDialog.css`:

```css
/* The post / replace dialog (.modal[data-dialog="post"]). */

.post-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: min(480px, 90vw);
}

.post-warning {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--danger);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  color: var(--text);
}

.post-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.post-tab {
  padding: 6px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
}

.post-tab.is-selected {
  border-bottom-color: var(--accent);
  color: var(--text);
  font-weight: 600;
}

.post-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.post-panel[hidden] {
  display: none;
}

.post-form input[type='url'],
.post-form input[type='text'],
.post-form textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font: inherit;
}

.post-form textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}

.link-preview {
  min-height: 1.4em;
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

.link-preview[data-tone='warn'] {
  color: var(--text);
}

.link-preview[data-tone='error'] {
  color: var(--danger);
}

.post-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px;
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  text-align: center;
  cursor: pointer;
}

.modal[data-dialog='post'].is-dragging .post-drop {
  border-color: var(--accent);
  color: var(--text);
}

.post-file-name {
  color: var(--text);
  font-weight: 600;
}

.post-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-muted);
}

.post-form .dialog-error {
  margin: 0;
  color: var(--danger);
}

.post-form .dialog-error[hidden] {
  display: none;
}

.post-footer {
  display: flex;
  justify-content: flex-end;
}

.post-submit {
  padding: 8px 20px;
  border: 0;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font: 600 14px/1.4 var(--font);
  cursor: pointer;
}

.post-submit:disabled {
  opacity: 0.6;
  cursor: progress;
}
```

- [ ] **Step 4: Implement the dialog**

`web/src/tiles/postDialog.ts`:

```ts
import { LIMITS } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, PostContent, SlotIndex } from '@class-board/shared/types';
import { NOTES, planLink, type LinkPlan } from '@class-board/shared/urls';
import type { PostDialogDeps } from '../contracts';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';
import './postDialog.css';

type Tab = 'link' | 'html';
type UploadCode = 'too_large' | 'invalid' | 'rate_limited' | 'network';

const REJECTED: Record<Extract<LinkPlan, { ok: false }>['reason'], string> = {
  invalid: "That doesn't look like a link. Paste the full address, starting with https://.",
  scheme: 'Only http and https links can be posted.',
  host: "Links to local or private addresses can't be shown. Post a public link, or upload the HTML file.",
  too_long: 'That link is longer than 2,048 characters. Post a shorter link.',
};

const UPLOAD_ERRORS: Record<UploadCode, string> = {
  too_large: 'That file is over 1 MB. Upload a smaller HTML file.',
  invalid: "That file isn't an HTML page. Choose a .html or .htm file saved as UTF-8.",
  rate_limited: 'Too many uploads in the last minute. Wait a moment, then press Post to try again.',
  network: "The upload didn't reach the board server. Check your connection, then press Post to try again.",
};

const NO_HTML = 'Choose an HTML file, drop one here, or paste HTML.';
const NOT_HTML_FILE = 'Only .html or .htm files can be uploaded.';
const NO_LINK = 'Paste a link to post.';
const UNKNOWN_ERROR = 'Something went wrong. Press Post to try again.';

function reqId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function codeOf(e: unknown): string | null {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;
}

function isHtmlName(name: string): boolean {
  return /\.html?$/i.test(name);
}

function previewOf(plan: LinkPlan): { text: string; tone: 'ok' | 'warn' | 'error' } {
  if (!plan.ok) return { text: REJECTED[plan.reason], tone: 'error' };
  switch (plan.kind) {
    case 'claude-new':
      return { text: NOTES.claudeNew, tone: 'warn' };
    case 'claude-published':
      return {
        text: "Published Claude artifact. It shows live only if its owner added this board to the artifact's Allowed domains.",
        tone: 'ok',
      };
    case 'youtube':
      return { text: 'YouTube video. It plays in the tile.', tone: 'ok' };
    default:
      return { text: `Link to ${new URL(plan.url).host}. The board checks whether it can run in the tile.`, tone: 'ok' };
  }
}

export function openPostDialog(deps: PostDialogDeps, slot: SlotIndex, mode: 'add' | 'replace'): void {
  const { socket, state } = deps;
  const view = state.tile(slot);
  const baseVersion = view.version;
  const name = slotName(slot);

  let tab: Tab = 'link';
  let chosenFile: File | null = null;
  let sending = false;
  let closed = false;
  /** Keeps the file id of an upload whose post failed, so a retry doesn't upload it again. */
  let uploaded: { source: File | string; fileId: string } | null = null;

  const tabButton = (id: Tab, text: string) =>
    h('button', { type: 'button', class: 'post-tab', dataset: { tab: id }, textContent: text, attrs: { role: 'tab' } }) as HTMLButtonElement;
  const linkTab = tabButton('link', 'Link');
  const htmlTab = tabButton('html', 'HTML file');

  const urlInput = h('input', {
    type: 'url',
    name: 'url',
    placeholder: 'https://…',
    autocomplete: 'off',
    attrs: { 'aria-label': 'Link' },
  }) as HTMLInputElement;
  const preview = h('p', { class: 'link-preview', attrs: { 'aria-live': 'polite' } });
  const linkPanel = h('div', { class: 'post-panel', dataset: { panel: 'link' } }, urlInput, preview);

  const fileInput = h('input', { type: 'file', name: 'file', accept: '.html,.htm,text/html' }) as HTMLInputElement;
  const fileName = h('span', { class: 'post-file-name' });
  const pasteArea = h('textarea', {
    name: 'html',
    rows: 6,
    placeholder: 'Or paste HTML here',
    attrs: { 'aria-label': 'HTML', spellcheck: 'false' },
  }) as HTMLTextAreaElement;
  const dropZone = h(
    'label',
    { class: 'post-drop' },
    h('span', { class: 'post-drop-text', textContent: 'Choose an .html file or drop it here' }),
    fileInput,
    fileName,
  );
  const htmlPanel = h('div', { class: 'post-panel', dataset: { panel: 'html' }, hidden: true }, dropZone, pasteArea);

  const labelInput = h('input', {
    type: 'text',
    name: 'label',
    value: deps.defaultLabel(),
    maxLength: LIMITS.labelMax,
    autocomplete: 'off',
  }) as HTMLInputElement;
  const labelField = h('label', { class: 'post-label' }, h('span', { textContent: 'Name above the tile' }), labelInput);

  const owner = view.label || view.authorName;
  const warning =
    mode === 'replace'
      ? h('p', {
          class: 'post-warning',
          textContent: owner
            ? `This replaces ${owner}'s tile. Their version stays in History.`
            : `This replaces what's in ${name}. The current version stays in History.`,
        })
      : null;
  const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' }, hidden: true });
  const submit = h('button', {
    type: 'submit',
    class: 'post-submit',
    dataset: { action: 'submit' },
    textContent: mode === 'replace' ? 'Replace' : 'Post',
  }) as HTMLButtonElement;

  const form = h(
    'form',
    { class: 'post-form', attrs: { novalidate: '' } },
    warning,
    h('div', { class: 'post-tabs', attrs: { role: 'tablist' } }, linkTab, htmlTab),
    linkPanel,
    htmlPanel,
    labelField,
    error,
    h('div', { class: 'post-footer' }, submit),
  );

  const modal = openModal({
    title: mode === 'replace' ? `Replace ${name}` : `Add to ${name}`,
    body: form,
    dialog: 'post',
    onClose: () => {
      closed = true;
    },
  });

  function showError(text: string | null): void {
    error.textContent = text ?? '';
    error.hidden = text === null;
  }

  function selectTab(next: Tab): void {
    tab = next;
    linkTab.setAttribute('aria-selected', String(next === 'link'));
    htmlTab.setAttribute('aria-selected', String(next === 'html'));
    linkTab.classList.toggle('is-selected', next === 'link');
    htmlTab.classList.toggle('is-selected', next === 'html');
    linkPanel.hidden = next !== 'link';
    htmlPanel.hidden = next !== 'html';
    showError(null);
  }

  function chooseFile(file: File | null): void {
    chosenFile = file;
    fileName.textContent = file ? file.name : '';
    if (file) pasteArea.value = '';
    showError(null);
  }

  function updatePreview(): void {
    const text = urlInput.value.trim();
    if (text === '') {
      preview.textContent = '';
      delete preview.dataset.tone;
      return;
    }
    const { text: message, tone } = previewOf(planLink(text));
    preview.textContent = message;
    preview.dataset.tone = tone;
  }

  function uploadMessage(e: unknown): string {
    const code = codeOf(e);
    return code !== null && code in UPLOAD_ERRORS ? UPLOAD_ERRORS[code as UploadCode] : UPLOAD_ERRORS.network;
  }

  function requestMessage(e: unknown): string {
    const code = codeOf(e);
    if (code === 'conflict') return `Someone just posted to ${name}. Pick another tile or replace theirs.`;
    return code !== null ? errorText(code as ErrorCode) : UNKNOWN_ERROR;
  }

  /** Returns the content to post, or null after showing why it can't be posted. */
  async function prepareContent(): Promise<PostContent | null> {
    if (tab === 'link') {
      const text = urlInput.value.trim();
      if (text === '') {
        showError(NO_LINK);
        return null;
      }
      const plan = planLink(text);
      if (!plan.ok) {
        showError(REJECTED[plan.reason]);
        return null;
      }
      return { kind: 'link', url: plan.url };
    }

    const pasted = pasteArea.value;
    const source: File | string | null = chosenFile ?? (pasted.trim() === '' ? null : pasted);
    if (source === null) {
      showError(NO_HTML);
      return null;
    }
    if (typeof source !== 'string' && !isHtmlName(source.name)) {
      showError(NOT_HTML_FILE);
      return null;
    }
    const blob = typeof source === 'string' ? new Blob([source], { type: 'text/html;charset=utf-8' }) : source;
    if (blob.size > LIMITS.htmlMaxBytes) {
      showError(UPLOAD_ERRORS.too_large);
      return null;
    }
    if (uploaded && uploaded.source === source) return { kind: 'html', fileId: uploaded.fileId };
    try {
      const fileId = await deps.upload(blob, typeof source === 'string' ? 'pasted.html' : source.name);
      uploaded = { source, fileId };
      return { kind: 'html', fileId };
    } catch (e) {
      showError(uploadMessage(e));
      return null;
    }
  }

  async function send(): Promise<void> {
    if (sending) return;
    sending = true;
    submit.disabled = true;
    showError(null);
    try {
      const content = await prepareContent();
      if (content === null || closed) return;
      const label = (labelInput.value.trim() || deps.defaultLabel()).slice(0, LIMITS.labelMax);
      await socket.request({ type: 'post', reqId: reqId(), slot, baseVersion, content, label });
      modal.close();
    } catch (e) {
      showError(requestMessage(e));
    } finally {
      sending = false;
      submit.disabled = false;
    }
  }

  linkTab.addEventListener('click', () => selectTab('link'));
  htmlTab.addEventListener('click', () => selectTab('html'));
  urlInput.addEventListener('input', () => {
    updatePreview();
    showError(null);
  });
  fileInput.addEventListener('change', () => chooseFile(fileInput.files?.[0] ?? null));
  pasteArea.addEventListener('input', () => {
    if (chosenFile !== null) {
      chosenFile = null;
      fileInput.value = '';
      fileName.textContent = '';
    }
    showError(null);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });

  // Dropping a file anywhere on the dialog switches to the HTML tab and chooses it.
  modal.el.addEventListener('dragover', (e) => {
    e.preventDefault();
    modal.el.classList.add('is-dragging');
  });
  modal.el.addEventListener('dragleave', () => modal.el.classList.remove('is-dragging'));
  modal.el.addEventListener('drop', (e) => {
    e.preventDefault();
    modal.el.classList.remove('is-dragging');
    const file = (e as DragEvent).dataTransfer?.files?.[0] ?? null;
    if (!file) return;
    selectTab('html');
    chooseFile(file);
  });

  selectTab('link');
  urlInput.focus();
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- postDialog`
Expected: PASS (24 tests).

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/tiles/postDialog.ts web/src/tiles/postDialog.css web/test/postDialog.test.ts
git commit -m "feat(web): post dialog (T3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task T4: History panel

**Wave:** 4 · **Tier:** T1 (`sonnet`, `low`) · **Depends on:** U1, F2, F3

**Files:**
- Create: `web/src/tiles/historyPanel.ts`, `web/src/tiles/history.css`
- Test: `web/test/historyPanel.test.ts`

How it works:
- **Loading:** `openHistory(deps, slot)` opens `openModal({ dialog: 'history' })`, showing
  "Loading history…", and sends `{ type: 'history', reqId, slot }`.
- **Rows** are sorted by id, newest first. Each is a `.history-row[data-version]` holding:
  - a thumbnail: an `img` through `serverHref`, or a blank box
  - the title, falling back to "HTML page", the link's host, or "Cleared"
  - the label
  - "who · relative time"
- **Restore:** the current version (`state.tile(slot).version`) gets `.is-current` and a
  "Current" badge. The other rows get `[data-action="restore"]` only when `canRestore()` is
  true. Restore sends `{ type: 'restore', …, baseVersion: state.tile(slot).version }`, reading
  the version at click time, and closes on `ok`.
- **Errors** show in `.dialog-error`.
- The clock is `Date.now()`, so tests pin it with `vi.setSystemTime`.

- [ ] **Step 1: Write the failing test**

`web/test/historyPanel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { ErrorCode, RequestMsg, ServerMsg, TileView, VersionSummary } from '@class-board/shared/types';
import type { BoardSocket, BoardStateApi, HistoryDeps } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { openHistory } from '../src/tiles/historyPanel';

const C4 = 23;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const SERVER = 'http://localhost:8787';

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

function tile(version: number): TileView {
  return {
    slot: C4, version, kind: 'link', label: 'Maya', url: 'https://game.example.com/', embedUrl: 'https://game.example.com/',
    fileUrl: null, title: 'Game', icon: null, embeddable: 'yes', note: null, shotUrl: null, authorName: 'Maya',
    createdAt: NOW,
  };
}

function version(id: number, patch: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id, slot: C4, kind: 'link', label: 'Maya', title: `Version ${id}`, url: 'https://game.example.com/',
    fileUrl: null, shotUrl: null, authorName: 'Maya', createdAt: NOW - 5 * 60_000, ...patch,
  };
}

function serverError(code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(code), { code });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(opts: { current?: number; canRestore?: boolean } = {}) {
  const tiles = Array.from({ length: SLOT_COUNT }, () => tile(0));
  tiles[C4] = tile(opts.current ?? 3);
  const sent: RequestMsg[] = [];
  const replies: Array<(msg: RequestMsg) => Promise<Reply>> = [];
  const socket = {
    request: vi.fn((msg: RequestMsg) => {
      sent.push(msg);
      const next = replies.shift();
      return next ? next(msg) : Promise.resolve({ type: 'ok', reqId: msg.reqId } as Reply);
    }),
  } as unknown as BoardSocket;
  const deps: HistoryDeps = {
    socket,
    state: { tile: (slot: number) => tiles[slot] } as unknown as BoardStateApi,
    serverUrl: SERVER,
    canRestore: () => opts.canRestore ?? true,
  };
  return {
    deps,
    sent,
    tiles,
    /** Queue the reply for the next request. */
    reply(fn: (msg: RequestMsg) => Promise<Reply>) {
      replies.push(fn);
    },
    history(versions: VersionSummary[]) {
      replies.push(async (msg) => ({ type: 'historyResult', reqId: msg.reqId, slot: C4, versions }));
    },
  };
}

const dialog = () => document.querySelector<HTMLElement>('.modal[data-dialog="history"]');
const rows = () => [...dialog()!.querySelectorAll<HTMLElement>('.history-row')];
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="modal-root"></div>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openHistory', () => {
  it('opens the history modal in a loading state and requests the slot history', () => {
    const env = makeDeps();
    env.reply(() => new Promise<Reply>(() => {}));
    openHistory(env.deps, C4);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('.history-status')!.textContent).toBe('Loading history…');
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]).toMatchObject({ type: 'history', slot: C4 });
    expect(env.sent[0]!.reqId).toMatch(/^[0-9a-z]{12}$/);
  });

  it('lists versions newest first with who, when and the title', async () => {
    const env = makeDeps({ current: 3 });
    env.history([
      version(1, { authorName: 'Ben', createdAt: NOW - 2 * 3_600_000, title: null, kind: 'html', url: null }),
      version(3, { authorName: 'Maya', createdAt: NOW - 10_000 }),
      version(2, { authorName: 'Ana', createdAt: NOW - 3 * 86_400_000, title: null }),
    ]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows().map((r) => r.dataset.version)).toEqual(['3', '2', '1']);
    const [newest, middle, oldest] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(newest.querySelector('.history-title')!.textContent).toBe('Version 3');
    expect(newest.querySelector('.history-meta')!.textContent).toBe('Maya · just now');
    expect(middle.querySelector('.history-title')!.textContent).toBe('game.example.com');
    expect(middle.querySelector('.history-meta')!.textContent).toBe('Ana · 3 days ago');
    expect(oldest.querySelector('.history-title')!.textContent).toBe('HTML page');
    expect(oldest.querySelector('.history-meta')!.textContent).toBe('Ben · 2 h ago');
    expect(dialog()!.querySelector<HTMLElement>('.history-status')!.hidden).toBe(true);
  });

  it('shows a thumbnail resolved against the server URL', async () => {
    const env = makeDeps();
    env.history([
      version(2, { shotUrl: '/boards/main/shots/abc' }),
      version(1, { shotUrl: 'https://i.ytimg.com/vi/xyz/hqdefault.jpg' }),
    ]);
    openHistory(env.deps, C4);
    await flush();
    const [a, b] = rows().map((r) => r.querySelector<HTMLImageElement>('img.history-thumb')!) as [HTMLImageElement, HTMLImageElement];
    expect(a.getAttribute('src')).toBe('http://localhost:8787/boards/main/shots/abc');
    expect(b.getAttribute('src')).toBe('https://i.ytimg.com/vi/xyz/hqdefault.jpg');
  });

  it('marks the current version and offers Restore only on the others', async () => {
    const env = makeDeps({ current: 2 });
    env.history([version(3), version(2), version(1)]);
    openHistory(env.deps, C4);
    await flush();
    const current = dialog()!.querySelector<HTMLElement>('.history-row[data-version="2"]')!;
    expect(current.classList.contains('is-current')).toBe(true);
    expect(current.querySelector('.history-current')!.textContent).toBe('Current');
    expect(current.querySelector('[data-action="restore"]')).toBeNull();
    expect(dialog()!.querySelectorAll('[data-action="restore"]')).toHaveLength(2);
  });

  it('hides Restore when restoring is not allowed', async () => {
    const env = makeDeps({ canRestore: false });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows()).toHaveLength(2);
    expect(dialog()!.querySelectorAll('[data-action="restore"]')).toHaveLength(0);
  });

  it('restores against the tile version at click time and closes on ok', async () => {
    const env = makeDeps({ current: 3 });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    env.tiles[C4] = tile(4); // someone posted while the panel was open
    const pending = deferred<Reply>();
    env.reply(() => pending.promise);
    dialog()!.querySelector<HTMLButtonElement>('.history-row[data-version="2"] [data-action="restore"]')!.click();
    expect(env.sent[1]).toMatchObject({ type: 'restore', slot: C4, versionId: 2, baseVersion: 4 });
    expect(dialog()!.querySelector<HTMLButtonElement>('[data-action="restore"]')!.disabled).toBe(true);
    pending.resolve({ type: 'ok', reqId: env.sent[1]!.reqId });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('shows a restore error and re-enables the buttons', async () => {
    const env = makeDeps({ current: 3 });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    env.reply(async () => {
      throw serverError('locked');
    });
    const button = dialog()!.querySelector<HTMLButtonElement>('[data-action="restore"]')!;
    button.click();
    await flush();
    const error = dialog()!.querySelector<HTMLElement>('.dialog-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(errorText('locked'));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Restore');
  });

  it('shows an error when the history cannot be loaded', async () => {
    const env = makeDeps();
    env.reply(async () => {
      throw serverError('rate_limited');
    });
    openHistory(env.deps, C4);
    await flush();
    const error = dialog()!.querySelector<HTMLElement>('.dialog-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(errorText('rate_limited'));
    expect(dialog()!.querySelector<HTMLElement>('.history-status')!.hidden).toBe(true);
  });

  it('says so when the tile has no versions', async () => {
    const env = makeDeps({ current: 0 });
    env.history([]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows()).toHaveLength(0);
    expect(dialog()!.querySelector('.history-status')!.textContent).toBe('Nothing has been posted here yet.');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- historyPanel`
Expected: FAIL, `Failed to resolve import "../src/tiles/historyPanel" from "web/test/historyPanel.test.ts". Does the file exist?`

- [ ] **Step 3: Create the styles**

`web/src/tiles/history.css`:

```css
/* The history dialog (.modal[data-dialog="history"]). */

.history-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: min(520px, 90vw);
  max-height: 70vh;
  overflow-y: auto;
}

.history-status {
  margin: 0;
  color: var(--text-muted);
}

.history-status[hidden],
.history-body .dialog-error[hidden] {
  display: none;
}

.history-body .dialog-error {
  margin: 0;
  color: var(--danger);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-row {
  display: grid;
  grid-template-columns: 96px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.history-row.is-current {
  border-color: var(--accent);
}

.history-thumb {
  width: 96px;
  height: 60px;
  border-radius: calc(var(--radius) / 2);
  background: var(--bg);
  object-fit: cover;
}

.history-thumb.is-blank {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
}

.history-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.history-title {
  overflow: hidden;
  color: var(--text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-label,
.history-meta {
  color: var(--text-muted);
  font-size: 12px;
}

.history-current {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.history-restore {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.history-restore:disabled {
  opacity: 0.6;
  cursor: progress;
}
```

- [ ] **Step 4: Implement the panel**

`web/src/tiles/historyPanel.ts`:

```ts
import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, SlotIndex, VersionSummary } from '@class-board/shared/types';
import type { HistoryDeps } from '../contracts';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';
import { serverHref } from '../util/url';
import './history.css';

const LOAD_FAILED = "Couldn't load this tile's history. Close this and try again.";
const RESTORE_FAILED = "Couldn't restore that version. Try again.";

function reqId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function messageFor(e: unknown, fallback: string): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? errorText(code as ErrorCode) : fallback;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function summaryTitle(v: VersionSummary): string {
  if (v.title) return v.title;
  if (v.kind === 'html') return 'HTML page';
  if (v.kind === 'link' && v.url) {
    try {
      return new URL(v.url).host;
    } catch {
      return 'Link';
    }
  }
  return 'Cleared';
}

export function openHistory(deps: HistoryDeps, slot: SlotIndex): void {
  const { socket, state, serverUrl } = deps;
  const status = h('p', { class: 'history-status', textContent: 'Loading history…' });
  const list = h('ul', { class: 'history-list' });
  const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' }, hidden: true });
  const body = h('div', { class: 'history-body' }, status, error, list);
  let closed = false;
  let busy = false;

  const modal = openModal({
    title: `History of ${slotName(slot)}`,
    body,
    dialog: 'history',
    onClose: () => {
      closed = true;
    },
  });

  function showError(text: string | null): void {
    error.textContent = text ?? '';
    error.hidden = text === null;
  }

  async function restore(versionId: number, button: HTMLButtonElement): Promise<void> {
    if (busy) return;
    busy = true;
    const buttons = list.querySelectorAll<HTMLButtonElement>('[data-action="restore"]');
    for (const b of buttons) b.disabled = true;
    button.textContent = 'Restoring…';
    showError(null);
    try {
      await socket.request({
        type: 'restore',
        reqId: reqId(),
        slot,
        baseVersion: state.tile(slot).version,
        versionId,
      });
      modal.close();
    } catch (e) {
      showError(messageFor(e, RESTORE_FAILED));
      button.textContent = 'Restore';
      for (const b of buttons) b.disabled = false;
    } finally {
      busy = false;
    }
  }

  function row(v: VersionSummary, currentId: number, canRestore: boolean, now: number): HTMLElement {
    const thumb = v.shotUrl
      ? h('img', { class: 'history-thumb', src: serverHref(serverUrl, v.shotUrl), alt: '', loading: 'lazy' })
      : h('div', { class: 'history-thumb is-blank', textContent: v.kind === 'html' ? 'HTML' : v.kind === 'link' ? 'Link' : '' });
    const who = v.authorName ?? 'Someone';
    const info = h(
      'div',
      { class: 'history-info' },
      h('span', { class: 'history-title', textContent: summaryTitle(v) }),
      v.label ? h('span', { class: 'history-label', textContent: v.label }) : null,
      h('span', { class: 'history-meta', textContent: `${who} · ${relativeTime(v.createdAt, now)}` }),
    );
    const isCurrent = v.id === currentId;
    let action: HTMLElement | null = null;
    if (isCurrent) {
      action = h('span', { class: 'history-current', textContent: 'Current' });
    } else if (canRestore) {
      const button = h('button', {
        type: 'button',
        class: 'history-restore',
        dataset: { action: 'restore' },
        textContent: 'Restore',
      }) as HTMLButtonElement;
      button.addEventListener('click', () => void restore(v.id, button));
      action = button;
    }
    const li = h('li', { class: 'history-row', dataset: { version: String(v.id) } }, thumb, info, action);
    li.classList.toggle('is-current', isCurrent);
    return li;
  }

  function render(versions: VersionSummary[]): void {
    const sorted = [...versions].sort((a, b) => b.id - a.id);
    const currentId = state.tile(slot).version;
    const canRestore = deps.canRestore();
    const now = Date.now();
    status.hidden = sorted.length > 0;
    status.textContent = sorted.length > 0 ? '' : 'Nothing has been posted here yet.';
    list.replaceChildren(...sorted.map((v) => row(v, currentId, canRestore, now)));
  }

  socket
    .request({ type: 'history', reqId: reqId(), slot })
    .then((reply) => {
      if (closed) return;
      if (reply.type !== 'historyResult') {
        status.hidden = true;
        showError(LOAD_FAILED);
        return;
      }
      render(reply.versions);
    })
    .catch((e: unknown) => {
      if (closed) return;
      status.hidden = true;
      showError(messageFor(e, LOAD_FAILED));
    });
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- historyPanel`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/tiles/historyPanel.ts web/src/tiles/history.css web/test/historyPanel.test.ts
git commit -m "feat(web): history panel (T4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task T5: Focus mode

**Wave:** 4 · **Tier:** T3 (`opus`, `medium`) · **Depends on:** F2, F3 (it uses T2 and U6 only through `LiveFramesApi` and `GridApi`)

**Files:**
- Create: `web/src/board/focus.ts`, `web/src/board/focus.css`
- Test: `web/test/focus.test.ts`

How it works (spec §5.5, master plan §10 spike 1):
- **`enter(slot, opts)`:**
  1. `live.pin(slot)`.
  2. On `grid.bodyEl(slot)`: `setAttribute('popover', 'manual')`, then `showPopover()`.
  3. Add `.is-focus` to the tile and `is-focusing` to `document.body`.
  4. Un-hide `[data-action="back"]`.
  5. `pushState` with `#<slotName>`, keeping the path and query, unless `opts.push === false`.
  6. Notify.

  Entering a different tile while focused switches over and replaces the hash rather than
  pushing a second entry.
- **`exit(opts)`:** `hidePopover()`, remove the attribute, `live.unpin`, remove the classes,
  hide Back. Then:
  - if this module pushed the entry and the exit isn't from history: `history.back()`
  - if it isn't from history and nothing was pushed (a deep link): `replaceState` without the hash
  - after a `popstate`: leave history alone, because the browser already moved the URL. The
    brief said to call `replaceState` here too. That would be a no-op after Back, but would
    wipe the target hash when the user goes forward onto another `#D6`.

  Then notify.
- **`zoomBlocked(slot)`:**
  - The hint `#hint.is-visible` reads "Keep zooming to open C4" and hides after 600 ms
    without calls.
  - The hold starts on the first call and restarts on a different slot or a gap over 250 ms.
  - Focus mode starts when a call arrives `FOCUS.holdMs` or more after the hold started.
- **`start()`:** honors the initial hash with `parseSlotName` (`push: false`), then listens
  for `popstate` and `keydown` (Esc exits) on `deps.win`.
- **State updates:** a `'tile'` update for the focused slot, or a `'snapshot'`, re-applies the
  full-bleed state. That covers Grid rewriting classes or replacing elements.
- **Tiles that can't go live:** CSS alone handles them. `.tile.is-focus:not(.is-live)` shows
  the card edge to edge, with the tile's own `[data-action="open"]` button centered.

- [ ] **Step 1: Write the failing test**

`web/test/focus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TileView } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, CameraApi, FocusApi, GridApi, LiveFramesApi } from '../src/contracts';
import { createFocus } from '../src/board/focus';

const C4 = 23;
const D6 = 35;

/** happy-dom has no Popover API: record calls on the element instead. */
const opened = new Set<Element>();
const original = {
  show: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover'),
  hide: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover'),
};

function installPopoverStubs(): void {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement) {
      if (this.getAttribute('popover') === null) throw new DOMException('not a popover', 'NotSupportedError');
      if (opened.has(this)) throw new DOMException('already open', 'InvalidStateError');
      opened.add(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement) {
      if (!opened.has(this)) throw new DOMException('not open', 'InvalidStateError');
      opened.delete(this);
    },
  });
}

function restorePopover(): void {
  for (const [name, desc] of [['showPopover', original.show], ['hidePopover', original.hide]] as const) {
    if (desc) Object.defineProperty(HTMLElement.prototype, name, desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  opened.clear();
}

function tileMarkup(): string {
  return (
    '<div class="tile-label"><button class="tile-name" data-action="rename">Maya</button></div>' +
    '<div class="tile-body"><div class="tile-card"></div><div class="tile-frame"></div>' +
    '<button class="focus-back" data-action="back" hidden>← Back</button></div>'
  );
}

function makeGrid() {
  const tiles = new Map<number, HTMLElement>();
  const ensure = (slot: number): HTMLElement => {
    let tile = tiles.get(slot);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.slot = String(slot);
      tile.innerHTML = tileMarkup();
      document.body.append(tile);
      tiles.set(slot, tile);
    }
    return tile;
  };
  const api = {
    tileEl: (slot: number) => ensure(slot),
    bodyEl: (slot: number) => ensure(slot).querySelector('.tile-body') as HTMLElement,
    frameHost: (slot: number) => ensure(slot).querySelector('.tile-frame') as HTMLElement,
  } as unknown as GridApi;
  return {
    api,
    /** Simulates Grid rebuilding a tile's contents and class list. */
    rerender(slot: number) {
      const tile = ensure(slot);
      tile.className = 'tile';
      tile.innerHTML = tileMarkup();
    },
  };
}

function makeLive() {
  return {
    pin: vi.fn(),
    unpin: vi.fn(),
  } as unknown as LiveFramesApi & { pin: ReturnType<typeof vi.fn>; unpin: ReturnType<typeof vi.fn> };
}

function makeState() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const empties = new Set<number>();
  const api = {
    on(event: keyof BoardStateEvents, fn: (p: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return () => handlers.get(event)!.delete(fn);
    },
    tile: (slot: number) => ({ slot, kind: empties.has(slot) ? 'empty' : 'html' }),
  } as unknown as BoardStateApi;
  return {
    api,
    emit(event: keyof BoardStateEvents, payload?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
    markEmpty(slot: number) {
      empties.add(slot);
    },
  };
}

/** A fake window: history and location that stay in sync, plus an event target for popstate and keydown. */
function makeWin(initialHash = '') {
  const target = new EventTarget();
  const location = { pathname: '/class-board/', search: '?board=week-3', hash: initialHash };
  const entries: string[] = [`${location.pathname}${location.search}${initialHash}`];
  let index = 0;
  const setUrl = (url: string) => {
    const i = url.indexOf('#');
    location.hash = i === -1 ? '' : url.slice(i);
  };
  const history = {
    state: null,
    pushState: vi.fn((_s: unknown, _t: string, url: string) => {
      entries.splice(index + 1);
      entries.push(url);
      index += 1;
      setUrl(url);
    }),
    replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
      entries[index] = url;
      setUrl(url);
    }),
    back: vi.fn(() => {
      if (index === 0) return;
      index -= 1;
      setUrl(entries[index]!);
      // Browsers fire popstate asynchronously; tests call firePopState() to deliver it.
    }),
  };
  const win = Object.assign(target, { history, location }) as unknown as Window;
  return {
    win,
    history,
    location,
    url: () => entries[index],
    /** The user pressed the browser's back button. */
    userBack() {
      history.back();
      target.dispatchEvent(new Event('popstate'));
    },
    firePopState() {
      target.dispatchEvent(new Event('popstate'));
    },
    key(key: string) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key }));
    },
  };
}

let grid: ReturnType<typeof makeGrid>;
let live: ReturnType<typeof makeLive>;
let state: ReturnType<typeof makeState>;
let hintEl: HTMLElement;
let fakeWin: ReturnType<typeof makeWin>;
let focus: FocusApi | null = null;

function start(hash = ''): FocusApi {
  fakeWin = makeWin(hash);
  focus = createFocus({
    grid: grid.api,
    live,
    camera: {} as CameraApi,
    state: state.api,
    hintEl,
    serverUrl: 'http://localhost:8787',
    win: fakeWin.win,
    now: () => Date.now(),
  });
  return focus;
}

const body = (slot: number) => grid.api.bodyEl(slot);
const back = (slot: number) => body(slot).querySelector<HTMLButtonElement>('[data-action="back"]')!;

beforeEach(() => {
  installPopoverStubs();
  document.body.innerHTML = '<div id="hint"></div>';
  document.body.className = '';
  hintEl = document.getElementById('hint')!;
  grid = makeGrid();
  live = makeLive();
  state = makeState();
});

afterEach(() => {
  focus?.destroy();
  focus = null;
  vi.useRealTimers();
  restorePopover();
});

describe('createFocus: entering and leaving', () => {
  it('enter pins the tile, shows its body as a manual popover and marks the page', () => {
    const f = start();
    f.enter(C4);
    expect(live.pin).toHaveBeenCalledWith(C4);
    expect(body(C4).getAttribute('popover')).toBe('manual');
    expect(opened.has(body(C4))).toBe(true);
    expect(grid.api.tileEl(C4).classList.contains('is-focus')).toBe(true);
    expect(document.body.classList.contains('is-focusing')).toBe(true);
    expect(back(C4).hidden).toBe(false);
    expect(f.current()).toBe(C4);
  });

  it('enter pushes #C4 onto the history, keeping the path and query', () => {
    const f = start();
    f.enter(C4);
    expect(fakeWin.history.pushState).toHaveBeenCalledTimes(1);
    expect(fakeWin.url()).toBe('/class-board/?board=week-3#C4');
  });

  it('enter with push: false leaves the history alone', () => {
    const f = start();
    f.enter(C4, { push: false });
    expect(fakeWin.history.pushState).not.toHaveBeenCalled();
  });

  it('notifies onChange on enter and exit', () => {
    const f = start();
    const seen: Array<number | null> = [];
    f.onChange((s) => seen.push(s));
    f.enter(C4);
    f.exit();
    expect(seen).toEqual([C4, null]);
  });

  it('exit hides the popover, removes the attribute, unpins and clears the classes', () => {
    const f = start();
    f.enter(C4);
    f.exit();
    expect(opened.has(body(C4))).toBe(false);
    expect(body(C4).hasAttribute('popover')).toBe(false);
    expect(live.unpin).toHaveBeenCalledWith(C4);
    expect(grid.api.tileEl(C4).classList.contains('is-focus')).toBe(false);
    expect(document.body.classList.contains('is-focusing')).toBe(false);
    expect(back(C4).hidden).toBe(true);
    expect(f.current()).toBeNull();
  });

  it('exit after its own push goes back in history instead of adding an entry', () => {
    const f = start();
    f.enter(C4);
    f.exit();
    expect(fakeWin.history.back).toHaveBeenCalledTimes(1);
    expect(fakeWin.url()).toBe('/class-board/?board=week-3');
    // The popstate that follows history.back() must not re-enter or exit anything.
    fakeWin.firePopState();
    expect(f.current()).toBeNull();
  });

  it('exit without its own push clears the hash with replaceState', () => {
    const f = start('#C4');
    f.start();
    f.exit();
    expect(fakeWin.history.back).not.toHaveBeenCalled();
    expect(fakeWin.history.replaceState).toHaveBeenCalledTimes(1);
    expect(fakeWin.url()).toBe('/class-board/?board=week-3');
  });

  it("the browser's back button exits without touching history again", () => {
    const f = start();
    f.start();
    f.enter(C4);
    fakeWin.userBack();
    expect(f.current()).toBeNull();
    expect(document.body.classList.contains('is-focusing')).toBe(false);
    expect(fakeWin.history.back).toHaveBeenCalledTimes(1); // the user's, not ours
    expect(fakeWin.history.replaceState).not.toHaveBeenCalled();
  });

  it('entering another tile while focused switches without a second history entry', () => {
    const f = start();
    f.enter(C4);
    f.enter(D6);
    expect(opened.has(body(C4))).toBe(false);
    expect(opened.has(body(D6))).toBe(true);
    expect(live.unpin).toHaveBeenCalledWith(C4);
    expect(fakeWin.history.pushState).toHaveBeenCalledTimes(1);
    expect(fakeWin.url()).toBe('/class-board/?board=week-3#D6');
    expect(f.current()).toBe(D6);
  });

  it('entering the focused tile again does nothing', () => {
    const f = start();
    f.enter(C4);
    f.enter(C4);
    expect(live.pin).toHaveBeenCalledTimes(1);
    expect(fakeWin.history.pushState).toHaveBeenCalledTimes(1);
  });
});

describe('createFocus: start, keys and state updates', () => {
  it('start honors a #C4 hash without pushing', () => {
    const f = start('#c4');
    f.start();
    expect(f.current()).toBe(C4);
    expect(fakeWin.history.pushState).not.toHaveBeenCalled();
  });

  it('start ignores a hash that is not a slot name', () => {
    const f = start('#Z99');
    f.start();
    expect(f.current()).toBeNull();
  });

  it('a popstate onto a slot hash enters focus mode (the forward button)', () => {
    const f = start();
    f.start();
    fakeWin.location.hash = '#D6';
    fakeWin.firePopState();
    expect(f.current()).toBe(D6);
    expect(fakeWin.history.pushState).not.toHaveBeenCalled();
  });

  it('Escape exits while focus mode is on', () => {
    const f = start();
    f.start();
    f.enter(C4);
    fakeWin.key('Escape');
    expect(f.current()).toBeNull();
  });

  it("re-applies the full-bleed state when the focused tile's view changes", () => {
    const f = start();
    f.enter(C4);
    grid.rerender(C4);
    state.emit('tile', { slot: C4 } as TileView);
    expect(grid.api.tileEl(C4).classList.contains('is-focus')).toBe(true);
    expect(body(C4).getAttribute('popover')).toBe('manual');
    expect(opened.has(body(C4))).toBe(true);
    expect(back(C4).hidden).toBe(false);
  });

  it('ignores tile updates for other slots', () => {
    const f = start();
    f.enter(C4);
    state.emit('tile', { slot: D6 } as TileView);
    expect(grid.api.tileEl(D6).classList.contains('is-focus')).toBe(false);
  });

  it('destroy leaves focus mode and stops listening', () => {
    const f = start();
    f.start();
    f.enter(C4);
    f.destroy();
    focus = null;
    expect(document.body.classList.contains('is-focusing')).toBe(false);
    fakeWin.location.hash = '#D6';
    fakeWin.firePopState();
    expect(f.current()).toBeNull();
  });
});

describe('createFocus: zooming past the maximum', () => {
  it('shows the hint at once and enters after 300 ms of continued blocked zoom-ins', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    expect(hintEl.classList.contains('is-visible')).toBe(true);
    expect(hintEl.textContent).toBe('Keep zooming to open C4');
    for (let t = 0; t < 5; t++) {
      vi.advanceTimersByTime(50);
      f.zoomBlocked(C4);
    }
    expect(f.current()).toBeNull(); // 250 ms so far
    vi.advanceTimersByTime(50);
    f.zoomBlocked(C4);
    expect(f.current()).toBe(C4);
    expect(hintEl.classList.contains('is-visible')).toBe(false);
  });

  it('restarts the hold when the slot changes', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(200);
    f.zoomBlocked(D6);
    vi.advanceTimersByTime(200);
    f.zoomBlocked(D6);
    expect(f.current()).toBeNull();
    expect(hintEl.textContent).toBe('Keep zooming to open D6');
    vi.advanceTimersByTime(100);
    f.zoomBlocked(D6);
    expect(f.current()).toBe(D6);
  });

  it('restarts the hold after a gap of more than 250 ms', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(251);
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(200);
    f.zoomBlocked(C4);
    expect(f.current()).toBeNull();
    vi.advanceTimersByTime(100);
    f.zoomBlocked(C4);
    expect(f.current()).toBe(C4);
  });

  it('hides the hint 600 ms after the last blocked zoom-in', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(599);
    expect(hintEl.classList.contains('is-visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hintEl.classList.contains('is-visible')).toBe(false);
  });

  it('ignores blocked zoom-ins while already focused', () => {
    vi.useFakeTimers();
    const f = start();
    f.enter(C4);
    f.zoomBlocked(D6);
    expect(hintEl.classList.contains('is-visible')).toBe(false);
    expect(f.current()).toBe(C4);
  });

  it('never opens an empty tile, whether by zooming or by enter', () => {
    vi.useFakeTimers();
    state.markEmpty(C4);
    const f = start();
    f.zoomBlocked(C4);
    expect(hintEl.classList.contains('is-visible')).toBe(false);
    f.enter(C4);
    expect(f.current()).toBeNull();
    expect(live.pin).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- focus`
Expected: FAIL, `Failed to resolve import "../src/board/focus" from "web/test/focus.test.ts". Does the file exist?`

- [ ] **Step 3: Create the styles**

`web/src/board/focus.css`:

```css
/* Focus mode: the tile's .tile-body is promoted to the top layer with popover="manual". */

.tile-body:popover-open {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  margin: 0;
  border: 0;
  padding: 0;
  max-width: none;
  max-height: none;
  overflow: hidden;
  border-radius: 0;
  outline: none;
  background: var(--surface);
  color: var(--text);
}

.tile-body:popover-open::backdrop {
  background: transparent;
}

.tile-body:popover-open .tile-frame {
  position: absolute;
  inset: 0;
}

.tile-body:popover-open iframe {
  width: 100%;
  height: 100%;
  transform: none;
}

/* The page is fully usable in focus mode, so there's no shield. */
.tile-body:popover-open .tile-shield {
  display: none;
}

.focus-back {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 5;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: 600 14px/1.4 var(--font);
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.2);
}

.focus-back[hidden] {
  display: none;
}

.tile.is-focus .tile-label,
.tile.is-focus .tile-actions {
  visibility: hidden;
}

/* A tile that can't run live: its card fills the page, with Open in new tab centred. */
.tile.is-focus:not(.is-live) .tile-card {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  visibility: visible;
}

.tile.is-focus:not(.is-live) .tile-card img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.tile.is-focus:not(.is-live) .tile-actions {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  visibility: visible;
  opacity: 1;
  background: transparent;
  pointer-events: none;
}

.tile.is-focus:not(.is-live) .tile-actions > * {
  display: none;
}

.tile.is-focus:not(.is-live) .tile-actions > [data-action="open"] {
  display: inline-flex;
  padding: 10px 20px;
  font-size: 16px;
  pointer-events: auto;
}
```

- [ ] **Step 4: Implement focus mode**

`web/src/board/focus.ts`:

```ts
import { FOCUS } from '@class-board/shared/constants';
import { parseSlotName, slotName } from '@class-board/shared/slots';
import type { SlotIndex } from '@class-board/shared/types';
import type { FocusApi, FocusDeps, Unsubscribe } from '../contracts';
import './focus.css';

/** A gap longer than this between blocked zoom-ins restarts the hold. */
const HOLD_GAP_MS = 250;
/** The "Keep zooming" hint hides after this long without blocked zoom-ins. */
const HINT_HIDE_MS = 600;

export function createFocus(deps: FocusDeps): FocusApi {
  const { grid, live, state, hintEl } = deps;
  const win = deps.win ?? window;
  const now = deps.now ?? (() => Date.now());

  const listeners = new Set<(slot: SlotIndex | null) => void>();
  let current: SlotIndex | null = null;
  /** The .tile-body currently promoted to the top layer. */
  let shownBody: HTMLElement | null = null;
  /** True when enter() pushed the #C4 history entry that exit() should pop. */
  let pushed = false;
  let started = false;
  let holdSlot: SlotIndex | null = null;
  let holdStart = 0;
  let lastBlocked = -Infinity;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;

  function notify(): void {
    for (const fn of listeners) fn(current);
  }

  function backButton(slot: SlotIndex): HTMLElement | null {
    return grid.bodyEl(slot).querySelector<HTMLElement>('[data-action="back"]');
  }

  function hideHint(): void {
    if (hintTimer !== null) clearTimeout(hintTimer);
    hintTimer = null;
    hintEl.classList.remove('is-visible');
  }

  function showBody(body: HTMLElement): void {
    body.setAttribute('popover', 'manual');
    try {
      body.showPopover();
    } catch {
      // Already open, or the element was detached by a re-render; the next refresh retries.
    }
    shownBody = body;
  }

  function hideBody(): void {
    const body = shownBody;
    shownBody = null;
    if (!body) return;
    try {
      body.hidePopover();
    } catch {
      // Not open (detached or never shown): removing the attribute is enough.
    }
    body.removeAttribute('popover');
  }

  /** Puts the focused tile in its full-bleed state; safe to call repeatedly (Grid may re-render the tile). */
  function apply(slot: SlotIndex): void {
    const body = grid.bodyEl(slot);
    if (body !== shownBody) {
      hideBody();
      showBody(body);
    }
    grid.tileEl(slot).classList.add('is-focus');
    document.body.classList.add('is-focusing');
    const back = backButton(slot);
    if (back) back.hidden = false;
  }

  /** Undoes apply() without touching browser history. */
  function teardown(slot: SlotIndex): void {
    hideBody();
    live.unpin(slot);
    grid.tileEl(slot).classList.remove('is-focus');
    document.body.classList.remove('is-focusing');
    const back = backButton(slot);
    if (back) back.hidden = true;
  }

  function hashUrl(slot: SlotIndex | null): string {
    const { pathname, search } = win.location;
    return slot === null ? `${pathname}${search}` : `${pathname}${search}#${slotName(slot)}`;
  }

  function slotFromHash(): SlotIndex | null {
    const hash = win.location.hash.replace(/^#/, '');
    return hash === '' ? null : parseSlotName(hash);
  }

  function onPopState(): void {
    const target = slotFromHash();
    if (current !== null && target !== current) {
      api.exit({ fromHistory: true });
    }
    if (target !== null && current === null) {
      api.enter(target, { push: false });
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && current !== null) api.exit();
  }

  const unsubs: Unsubscribe[] = [
    state.on('tile', (view) => {
      if (view.slot === current) apply(current);
    }),
    state.on('snapshot', () => {
      if (current !== null) apply(current);
    }),
  ];

  const api: FocusApi = {
    current: () => current,

    enter(slot, opts = {}) {
      // Empty tiles have nothing to look at full-bleed; posting happens from the board.
      if (slot === current || state.tile(slot).kind === 'empty') return;
      hideHint();
      holdSlot = null;
      const switching = current !== null;
      if (current !== null) teardown(current);
      current = slot;
      live.pin(slot);
      apply(slot);
      if (opts.push !== false) {
        if (switching && pushed) {
          win.history.replaceState(win.history.state, '', hashUrl(slot));
        } else {
          win.history.pushState(win.history.state, '', hashUrl(slot));
          pushed = true;
        }
      } else if (!switching) {
        pushed = false;
      }
      notify();
    },

    exit(opts = {}) {
      if (current === null) return;
      const slot = current;
      current = null;
      teardown(slot);
      // After a popstate the URL already shows where the browser went, so history is left alone.
      if (!opts.fromHistory) {
        if (pushed) win.history.back();
        else win.history.replaceState(win.history.state, '', hashUrl(null));
      }
      pushed = false;
      notify();
    },

    zoomBlocked(slot) {
      if (current !== null || state.tile(slot).kind === 'empty') return;
      const t = now();
      if (slot !== holdSlot || t - lastBlocked > HOLD_GAP_MS) {
        holdSlot = slot;
        holdStart = t;
      }
      lastBlocked = t;
      if (t - holdStart >= FOCUS.holdMs) {
        api.enter(slot);
        return;
      }
      hintEl.textContent = `Keep zooming to open ${slotName(slot)}`;
      hintEl.classList.add('is-visible');
      if (hintTimer !== null) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => {
        hintTimer = null;
        hintEl.classList.remove('is-visible');
        holdSlot = null;
      }, HINT_HIDE_MS);
    },

    start() {
      if (started) return;
      started = true;
      win.addEventListener('popstate', onPopState);
      win.addEventListener('keydown', onKeyDown as EventListener);
      const slot = slotFromHash();
      if (slot !== null) api.enter(slot, { push: false });
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    destroy() {
      for (const u of unsubs) u();
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('keydown', onKeyDown as EventListener);
      hideHint();
      if (current !== null) teardown(current);
      current = null;
      listeners.clear();
    },
  };

  return api;
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- focus`
Expected: PASS (23 tests).

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/board/focus.ts web/src/board/focus.css web/test/focus.test.ts
git commit -m "feat(web): focus mode (T5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
