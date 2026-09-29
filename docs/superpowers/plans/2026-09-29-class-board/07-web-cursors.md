# Web cursors, profile, people, teacher

This workstream builds everything on the browser side that is about people: how your own cursor is sent and drawn, how everyone else's cursor is smoothed and shown, the saved profile, the cursor-design panel with its pixel editor, the people list, and the teacher session and panel. It has nine tasks (C1 to C9). They import only the frozen contracts (`web/src/contracts.ts`, `@class-board/shared/*`) plus the `web/src/ui/*` helpers from Task U1 (`h`, `openModal`, `errorText`, `toast`). Only `web/src/main.ts` (Tasks U8 and U9) imports the factories these tasks export, exactly as master plan §5.6 describes. The pixel editor (C4) is internal to this workstream and is used only by the profile panel (C8).

Every module takes its clock, timers or animation-frame function as an injectable option, so tests never wait on real time and never touch the network.

## Third-party APIs used

This workstream has no runtime dependencies. It uses only browser APIs and the dev tools F1 installs. The versions below are what the plan's code and tests were written and run against, in a scratch project outside the repo (Node 24.16, npm 11.13). All 242 tests in this file pass there, and the modules typecheck with `tsc --noEmit` under `strict` and `noUncheckedIndexedAccess`.

- **Vitest 5.0.2**: https://vitest.dev/. Used: `vi.useFakeTimers`, `vi.setSystemTime`, `vi.mock` with `importOriginal` to wrap (not replace) `cursorImage` in C7, `vi.fn`, `vi.spyOn`, `it.each`. A run filter is a case-insensitive substring of the file path, so `-- panel.test` also matches `peoplePanel.test.ts` and `teacherPanel.test.ts`. Every command in this file therefore uses `test/<name>.test.ts`, which matches one file.
- **happy-dom 20.14.5**: https://github.com/capricorn86/happy-dom. Confirmed behaviors the tests rely on:
  - `PointerEvent`, `KeyboardEvent`, `MutationObserver`, `element.dataset`, `element.hidden`, `classList.toggle` and `element.closest` all work.
  - `element.style.background = '#EF9F27'` reads back as `#EF9F27`, not `rgb(...)`. A real browser reads back `rgb(239, 159, 39)`. Tests that compare colors therefore set the same value on a scratch element and compare what it reads back, so they pass either way.
  - `svg.innerHTML` re-serializes an empty element as `<path ...></path>`, not `<path .../>`. Tests that compare markup pass it through a scratch element first.
  - `document.visibilityState` is a getter on `Document.prototype`. `Object.defineProperty(document, 'visibilityState', { configurable: true, get })` overrides it, and `delete document.visibilityState` restores it.
- **TypeScript 7.0.2** (current `latest`): `baseUrl` is removed, so any `paths` mapping in a tsconfig must start with `./`. The code here has no other dependence on the TypeScript version. CSS side-effect imports (`import './cursors.css'`) typecheck only because F1's `web/src/vite-env.d.ts` has `/// <reference types="vite/client" />`.
- **CSS `cursor: url(...) x y, auto`**: https://developer.mozilla.org/en-US/docs/Web/CSS/cursor. Checked in Chromium (Browser pane): a value of the form `url("data:image/svg+xml;utf8,%3Csvg…") 2 2, auto` is accepted by `CSS.supports('cursor', …)` and kept by `getComputedStyle`, for all six shapes and for a pixel-art image. The SVG has explicit `width="32" height="32"`, which Firefox requires for SVG cursors. The MDN page could not be fetched from this environment, so the size limit (browsers cap cursor images at 128×128) comes from earlier knowledge. 32×32 is well inside it. Firefox and Safari were not run; E1 or V1 should look at the cursor once in each if they are available.
- **Page Visibility API** (`visibilitychange`, `document.visibilityState`) and **`requestAnimationFrame`**: standard browser APIs, no gotchas beyond the happy-dom note above.

## Notes that apply to every task

- Test files build their own small fakes (a fake `BoardStateApi`, `CameraApi`, `BoardSocket`, `TeacherApi`, `Storage`). Those fakes implement only the members the module under test reads, and are cast to the contract type. They live inside each test file because the file lists don't allow a shared helper.
- `errorText` from `web/src/ui/errors.ts` (U1) is never compared with a literal string in these tests. They call `errorText(code)` and compare with that, so the tests hold whatever copy U1 chose.
- `openModal` (U1) is used as the master plan §5 table describes. Tests that check a dialog "can't be closed" press Esc and click `[data-action="close"]` if it exists, and expect the modal to still be there, so they don't depend on whether U1 hides the button when `closable` is `false`.
- Code doesn't rely on `h()` returning a specific element type: where a module needs `.value`, `.disabled` or `.select()`, it casts (`as HTMLInputElement`).
- UI copy is sentence case with no "please" or exclamation marks.

---

### Task C1: Throttle and interpolation

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F2

**Files:**
- Create: `web/src/cursors/throttle.ts`
- Create: `web/src/cursors/interpolate.ts`
- Test: `web/test/throttle.test.ts`
- Test: `web/test/interpolate.test.ts`

Two small pure modules. `createThrottle` is a leading-and-trailing throttle with an injectable clock and timers. `createInterpolator` keeps a buffer of timestamped positions for one remote person and answers "where do I draw them at time t".

- [ ] **Step 1: Write the failing throttle test**

`web/test/throttle.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/throttle.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/cursors/throttle" from "test/throttle.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `throttle.ts`**

How it behaves: a push sends at once if the interval has passed. Otherwise the newest value is kept, and one timer sends it when the interval ends, which is the final send about 200 ms after the mouse stops at 5 Hz. `setHz(0)` drops anything pending and ignores pushes. `cancel()` drops anything pending and forgets the last send time.

`web/src/cursors/throttle.ts`:

```ts
export interface ThrottleOpts {
  /** Sends per second. 0 (or less) pauses: everything pushed is dropped. */
  hz: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Throttle<T> {
  /** Sends now if the interval has passed, otherwise keeps only the newest value for a trailing send. */
  push(value: T): void;
  /** Changes the interval. 0 pauses and drops anything pending. */
  setHz(hz: number): void;
  /** Drops anything pending and forgets the last send time, so the next push sends at once. */
  cancel(): void;
}

export function createThrottle<T>(send: (value: T) => void, opts: ThrottleOpts): Throttle<T> {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let hz = opts.hz;
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let pending: { value: T } | null = null;

  const interval = () => 1000 / hz;

  function dropPending(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  }

  function schedule(): void {
    if (timer !== null) clearTimer(timer);
    const wait = Math.max(0, lastSent + interval() - now());
    timer = setTimer(fire, wait);
  }

  function fire(): void {
    timer = null;
    if (pending === null || hz <= 0) return;
    const { value } = pending;
    pending = null;
    lastSent = now();
    send(value);
  }

  return {
    push(value) {
      if (hz <= 0) return;
      if (now() - lastSent >= interval()) {
        dropPending();
        lastSent = now();
        send(value);
        return;
      }
      pending = { value };
      if (timer === null) schedule();
    },
    setHz(next) {
      hz = next;
      if (hz <= 0) dropPending();
      else if (pending !== null) schedule();
    },
    cancel() {
      dropPending();
      lastSent = Number.NEGATIVE_INFINITY;
    },
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- test/throttle.test.ts`

Expected: PASS, 10 tests in 1 file.

- [ ] **Step 5: Write the failing interpolator test**

`web/test/interpolate.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test -w web -- test/interpolate.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/cursors/interpolate" from "test/interpolate.test.ts". Does the file exist?`

- [ ] **Step 7: Implement `interpolate.ts`**

How it behaves: `sample(t)` looks at the path `CURSOR.renderDelayMs` (200 ms) behind `t`, interpolating linearly between the two samples around that time. It discards samples the path has already passed. It returns the last sample when it runs out of data, and a lone sample at once. A push more than `CURSOR.jumpGapMs` after the previous one replaces the whole buffer, so the cursor jumps instead of gliding. The buffer is capped at 64 samples for the case where nothing samples it, such as a hidden tab.

`web/src/cursors/interpolate.ts`:

```ts
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
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- test/interpolate.test.ts`

Expected: PASS, 11 tests in 1 file.

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add web/src/cursors/throttle.ts web/src/cursors/interpolate.ts web/test/throttle.test.ts web/test/interpolate.test.ts
git commit -m "feat(cursors): Throttle and interpolation (C1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C3: Profile storage

**Wave:** 3 · **Tier:** T0 (haiku) · **Depends on:** F2, F5

**Files:**
- Create: `web/src/profile/storage.ts`
- Test: `web/test/storage.test.ts`

`loadIdentity` returns the saved `clientId` (creating and saving one with `crypto.randomUUID` on the first visit) and the saved profile if it is valid JSON that passes `isValidProfile`. `saveProfile` writes it. Every storage access is inside try/catch. When storage throws or is missing, the identity still works for the rest of the page load: the generated id is kept in a module variable, so two calls return the same id.

> **Ordering note.** This task's test and code import `isValidProfile` and `defaultProfile` from `shared/src/protocol.ts` and `emptyGrid` and `encodeArt` from `shared/src/pixelArt.ts`. F5 writes both in Wave 2, so C3 runs in Wave 3.

- [ ] **Step 1: Write the failing test**

`web/test/storage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { defaultProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import { loadIdentity, saveProfile } from '../src/profile/storage';

/** A Storage that keeps its data in a Map, so tests never touch the real localStorage. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** A Storage whose every method throws, like localStorage with site data blocked. */
function brokenStorage(): Storage {
  const fail = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

const pixelsProfile: Profile = {
  name: 'Maya',
  color: COLORS[3],
  cursor: { kind: 'pixels', art: encodeArt(emptyGrid()), tip: [8, 8] },
};

describe('loadIdentity', () => {
  it('creates a client id on the first visit and saves it', () => {
    const storage = memoryStorage();
    const { clientId, profile } = loadIdentity(storage);
    expect(clientId).toMatch(/^[0-9a-f-]{16,}$/);
    expect(profile).toBeNull();
    expect(storage.data.get('classBoard.clientId')).toBe(clientId);
  });

  it('returns the same client id on the next visit', () => {
    const storage = memoryStorage();
    const first = loadIdentity(storage).clientId;
    expect(loadIdentity(storage).clientId).toBe(first);
  });

  it('replaces a stored client id that is empty or absurdly long', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.clientId', 'x'.repeat(65));
    const { clientId } = loadIdentity(storage);
    expect(clientId).not.toBe('x'.repeat(65));
    expect(storage.data.get('classBoard.clientId')).toBe(clientId);
  });

  it('round-trips a shape profile', () => {
    const storage = memoryStorage();
    const profile = defaultProfile('Ana');
    saveProfile(profile, storage);
    expect(loadIdentity(storage).profile).toEqual(profile);
  });

  it('round-trips a pixel-art profile', () => {
    const storage = memoryStorage();
    saveProfile(pixelsProfile, storage);
    expect(loadIdentity(storage).profile).toEqual(pixelsProfile);
  });

  it('stores the profile as JSON under classBoard.profile', () => {
    const storage = memoryStorage();
    saveProfile(defaultProfile('Ana'), storage);
    expect(JSON.parse(storage.data.get('classBoard.profile')!)).toEqual(defaultProfile('Ana'));
  });

  it('ignores a profile that is not JSON', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.profile', '{not json');
    expect(loadIdentity(storage).profile).toBeNull();
  });

  it('ignores a profile that fails validation', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.profile', JSON.stringify({ name: '', color: '#123456', cursor: { kind: 'shape', shape: 'arrow' } }));
    expect(loadIdentity(storage).profile).toBeNull();
    storage.setItem('classBoard.profile', JSON.stringify({ name: 'Ana', color: COLORS[0], cursor: { kind: 'shape', shape: 'banana' } }));
    expect(loadIdentity(storage).profile).toBeNull();
  });

  it('still returns an identity when storage throws, and keeps the id for the rest of the page load', () => {
    const storage = brokenStorage();
    const first = loadIdentity(storage);
    expect(first.clientId.length).toBeGreaterThan(0);
    expect(first.profile).toBeNull();
    expect(loadIdentity(storage).clientId).toBe(first.clientId);
  });

  it('does not throw when storage is missing', () => {
    expect(loadIdentity(undefined).profile).toBeNull();
  });
});

describe('saveProfile', () => {
  it('does not throw when storage throws', () => {
    expect(() => saveProfile(defaultProfile('Ana'), brokenStorage())).not.toThrow();
  });

  it('overwrites the earlier profile', () => {
    const storage = memoryStorage();
    saveProfile(defaultProfile('Ana'), storage);
    saveProfile(defaultProfile('Ben'), storage);
    expect(loadIdentity(storage).profile?.name).toBe('Ben');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/storage.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/profile/storage" from "test/storage.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `storage.ts`**

`web/src/profile/storage.ts`:

```ts
import { isValidProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import type { StoredIdentity } from '../contracts';

const CLIENT_ID_KEY = 'classBoard.clientId';
const PROFILE_KEY = 'classBoard.profile';

/** Set only when the id couldn't be saved, so one page load still keeps one identity. */
let memoryId: string | null = null;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function readItem(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value couldn't be saved (storage full, blocked or missing). */
function writeItem(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadIdentity(storage: Storage | undefined = defaultStorage()): StoredIdentity {
  let clientId = readItem(storage, CLIENT_ID_KEY);
  if (!clientId || clientId.length > 64) {
    clientId = memoryId ?? newClientId();
    memoryId = writeItem(storage, CLIENT_ID_KEY, clientId) ? null : clientId;
  }

  let profile: Profile | null = null;
  const raw = readItem(storage, PROFILE_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isValidProfile(parsed)) profile = parsed;
    } catch {
      // A corrupt profile is treated like no profile.
    }
  }
  return { clientId, profile };
}

export function saveProfile(profile: Profile, storage: Storage | undefined = defaultStorage()): void {
  // A profile that can't be saved is simply asked for again on the next visit.
  writeItem(storage, PROFILE_KEY, JSON.stringify(profile));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- test/storage.test.ts`

Expected: PASS, 12 tests in 1 file.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add web/src/profile/storage.ts web/test/storage.test.ts
git commit -m "feat(profile): Profile storage (C3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C2: Cursor images

**Wave:** 3 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2, F5

**Files:**
- Create: `web/src/cursors/render.ts`
- Test: `web/test/render.test.ts`

`cursorImage(profile)` returns `{ url, tipX, tipY, size }` where `url` is an SVG data URL (no canvas, so it works in happy-dom and as a CSS `cursor` value). Six hand-designed 32×32 shapes are filled with the profile color and outlined in `#1A1A1A` so they show on any background. Pixel art is drawn as 2×2 `<rect>`s with `shape-rendering="crispEdges"`. `shapeSvg` returns the raw markup for previews, and `tagTextColor` picks white or `#1A1A1A` by WCAG relative luminance. A profile color that isn't `#rrggbb` is replaced before it goes into markup, and pixel art that can't be decoded falls back to the arrow.

Hot spots (in the 32×32 image): arrow (2, 2), hand (13, 2) at the fingertip, pencil (2, 30) at the point, star (16, 16), plane (2, 2), crosshair (16, 16). Pixel art: the art tip cell × 2. All six shapes were rendered in Chromium and checked by eye with the hot spot marked.

- [ ] **Step 1: Write the failing test**

`web/test/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COLORS, SHAPES } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import type { Profile } from '@class-board/shared/types';
import { cursorImage, shapeSvg, tagTextColor } from '../src/cursors/render';

const DATA_PREFIX = 'data:image/svg+xml;utf8,';

/** The SVG markup back out of a data URL. */
function svgOf(url: string): string {
  expect(url.startsWith(DATA_PREFIX)).toBe(true);
  return decodeURIComponent(url.slice(DATA_PREFIX.length));
}

function shapeProfile(shape: (typeof SHAPES)[number], color: string = COLORS[3]): Profile {
  return { name: 'Ana', color, cursor: { kind: 'shape', shape } };
}

describe('shapeSvg', () => {
  it.each(SHAPES)('draws %s at 32×32 with explicit width and height', (shape) => {
    const svg = shapeSvg(shape, COLORS[3]);
    expect(svg).toMatch(/^<svg [^>]*width="32"/);
    expect(svg).toContain('height="32"');
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it.each(SHAPES)('fills %s with the profile color and outlines it in a dark color', (shape) => {
    const svg = shapeSvg(shape, '#378ADD');
    expect(svg).toContain('#378ADD');
    expect(svg).toContain('#1A1A1A');
  });

  it('draws six different shapes', () => {
    const drawings = new Set(SHAPES.map((s) => shapeSvg(s, COLORS[0])));
    expect(drawings.size).toBe(6);
  });

  it('replaces a color that is not a plain hex value, so markup cannot be injected', () => {
    const svg = shapeSvg('arrow', '"/><script>alert(1)</script>');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('alert');
  });
});

describe('cursorImage for preset shapes', () => {
  it('returns an SVG data URL that a CSS url() value can hold', async () => {
    const img = await cursorImage(shapeProfile('arrow'));
    expect(img.url).toMatch(/^data:image\/svg\+xml;utf8,%3Csvg/);
    expect(img.url).not.toMatch(/["'()\s]/);
    expect(img.size).toBe(32);
    expect(svgOf(img.url)).toBe(shapeSvg('arrow', COLORS[3]));
  });

  it.each([
    ['arrow', 2, 2],
    ['hand', 13, 2],
    ['pencil', 2, 30],
    ['star', 16, 16],
    ['plane', 2, 2],
    ['crosshair', 16, 16],
  ] as const)('puts the %s hot spot at (%i, %i)', async (shape, x, y) => {
    const img = await cursorImage(shapeProfile(shape));
    expect([img.tipX, img.tipY]).toEqual([x, y]);
  });
});

describe('cursorImage for pixel art', () => {
  function pixelProfile(paint: (g: Uint8Array) => void, tip: [number, number] = [8, 8]): Profile {
    const grid = emptyGrid();
    paint(grid);
    return { name: 'Ben', color: '#D85A30', cursor: { kind: 'pixels', art: encodeArt(grid), tip } };
  }

  it('draws each filled cell as a 2×2 rect in its palette color and skips transparent cells', async () => {
    const img = await cursorImage(
      pixelProfile((g) => {
        g[0] = 1; // top-left, the profile color
        g[16 * 3 + 5] = 2; // row 3, column 5, black
        g[255] = 4; // bottom-right, red
      }),
    );
    const svg = svgOf(img.url);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('width="32" height="32"');
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg).toContain('<rect x="0" y="0" width="2" height="2" fill="#D85A30"/>');
    expect(svg).toContain('<rect x="10" y="6" width="2" height="2" fill="#000000"/>');
    expect(svg).toContain('<rect x="30" y="30" width="2" height="2" fill="#E24B4A"/>');
  });

  it('doubles the tip cell to get the hot spot in pixels', async () => {
    const img = await cursorImage(pixelProfile((g) => (g[0] = 1), [3, 5]));
    expect([img.tipX, img.tipY, img.size]).toEqual([6, 10, 32]);
  });

  it('recolors the drawing when the profile color changes', async () => {
    const art = pixelProfile((g) => (g[0] = 1));
    const recolored: Profile = { ...art, color: '#378ADD' };
    expect(svgOf((await cursorImage(recolored)).url)).toContain('fill="#378ADD"');
  });

  it('falls back to the arrow when the art cannot be decoded', async () => {
    const broken: Profile = { name: 'Ben', color: COLORS[0], cursor: { kind: 'pixels', art: 'not art', tip: [8, 8] } };
    const img = await cursorImage(broken);
    expect(svgOf(img.url)).toBe(shapeSvg('arrow', COLORS[0]));
    expect([img.tipX, img.tipY]).toEqual([2, 2]);
  });
});

describe('tagTextColor', () => {
  it('uses white on dark backgrounds', () => {
    expect(tagTextColor('#000000')).toBe('#FFFFFF');
    expect(tagTextColor('#534AB7')).toBe('#FFFFFF');
    expect(tagTextColor('#0F6E56')).toBe('#FFFFFF');
  });

  it('uses near-black on light backgrounds', () => {
    expect(tagTextColor('#FFFFFF')).toBe('#1A1A1A');
    expect(tagTextColor('#EF9F27')).toBe('#1A1A1A');
  });

  it('picks whichever of white and #1A1A1A has the higher contrast for all 12 profile colors', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const color of COLORS) {
      const chosen = tagTextColor(color);
      const other = chosen === '#FFFFFF' ? '#1A1A1A' : '#FFFFFF';
      expect(contrast(color, chosen)).toBeGreaterThanOrEqual(contrast(color, other));
    }
  });

  it('accepts short hex, and treats junk as a black background', () => {
    expect(tagTextColor('#fff')).toBe('#1A1A1A');
    expect(tagTextColor('#000')).toBe('#FFFFFF');
    expect(tagTextColor('not a color')).toBe('#FFFFFF');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/render.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/cursors/render" from "test/render.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `render.ts`**

`web/src/cursors/render.ts`:

```ts
import { ART_SIZE, CURSOR } from '@class-board/shared/constants';
import { decodeArt, paletteColors } from '@class-board/shared/pixelArt';
import type { Profile, ShapeName } from '@class-board/shared/types';
import type { CursorImage } from '../contracts';

const OUTLINE = '#1A1A1A';
const FALLBACK_COLOR = '#5F5E5A';

/** Where each preset's hot spot sits inside its 32×32 image. */
export const SHAPE_TIPS: Record<ShapeName, [number, number]> = {
  arrow: [2, 2],
  hand: [13, 2],
  pencil: [2, 30],
  star: [16, 16],
  plane: [2, 2],
  crosshair: [16, 16],
};

const OUTLINE_ATTRS = `stroke="${OUTLINE}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"`;

/** Inner markup for each shape, drawn in a 32×32 box. `c` is the profile color. */
const SHAPE_BODIES: Record<ShapeName, (c: string) => string> = {
  arrow: (c) => `<path d="M2 2 L2 25 L8 19.5 L12.5 29 L17.5 26.8 L13 17.5 L21.5 17.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  hand: (c) =>
    `<path d="M13.5 2 C15 2 16 3.2 16 5 V12.5 C17.6 11.8 19.6 12.3 20 14 C21.8 13.6 23.6 14.4 23.9 16.2 C25.6 16.2 27 17.4 27 19.5 V24 C27 27.8 24.2 30 20.5 30 H15.5 C12.6 30 11.2 28.8 9.6 26.6 L4.6 19.2 C3.8 17.9 4.8 16.4 6.3 16.4 C7.4 16.4 8.2 17 9.2 18 L11 19.8 V5 C11 3.2 12 2 13.5 2 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  pencil: (c) =>
    `<path d="M2 30 L4.5 21.5 L22 4 C23.6 2.4 25.6 2.4 27.2 4 L28 4.8 C29.6 6.4 29.6 8.4 28 10 L10.5 27.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>` +
    `<path d="M4.5 21.5 L10.5 27.5" fill="none" ${OUTLINE_ATTRS}/>` +
    `<path d="M2 30 L3.4 25.3 L6.7 28.6 Z" fill="${OUTLINE}" ${OUTLINE_ATTRS}/>`,
  star: (c) =>
    `<path d="M16 2.5 L19.6 11.5 L29.3 12.2 L21.9 18.4 L24.2 27.8 L16 22.7 L7.8 27.8 L10.1 18.4 L2.7 12.2 L12.4 11.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  plane: (c) =>
    `<path d="M2 2 L30 12 L20 30 L15 17.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>` +
    `<path d="M15 17.5 L30 12" fill="none" ${OUTLINE_ATTRS}/>`,
  crosshair: (c) => {
    const strokes = 'M16 2.5 V11 M16 21 V29.5 M2.5 16 H11 M21 16 H29.5';
    return (
      `<g fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"><circle cx="16" cy="16" r="9.5"/><path d="${strokes}"/></g>` +
      `<g fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"><circle cx="16" cy="16" r="9.5"/><path d="${strokes}"/></g>` +
      `<circle cx="16" cy="16" r="1.6" fill="${c}" ${OUTLINE_ATTRS}/>`
    );
  },
};

const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR.imageSize}" height="${CURSOR.imageSize}" viewBox="0 0 32 32"`;

/** Colors end up inside markup, so anything that isn't a plain hex color is replaced. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLOR;
}

/** Raw SVG markup for a preset shape, for previews. */
export function shapeSvg(shape: ShapeName, color: string): string {
  return `${SVG_OPEN}>${SHAPE_BODIES[shape](safeColor(color))}</svg>`;
}

function artSvg(art: string, color: string): string | null {
  const grid = decodeArt(art);
  if (!grid) return null;
  const palette = paletteColors(safeColor(color));
  const scale = CURSOR.imageSize / ART_SIZE;
  let rects = '';
  for (let i = 0; i < grid.length; i++) {
    const fill = palette[grid[i]!];
    if (!fill) continue;
    const x = (i % ART_SIZE) * scale;
    const y = Math.floor(i / ART_SIZE) * scale;
    rects += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="${fill}"/>`;
  }
  return `${SVG_OPEN} shape-rendering="crispEdges">${rects}</svg>`;
}

function toDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The cursor image for a profile. Pixel art that can't be decoded falls back to the arrow. */
export async function cursorImage(profile: Profile): Promise<CursorImage> {
  const { cursor, color } = profile;
  if (cursor.kind === 'pixels') {
    const svg = artSvg(cursor.art, color);
    if (svg) {
      const scale = CURSOR.imageSize / ART_SIZE;
      return { url: toDataUrl(svg), tipX: cursor.tip[0] * scale, tipY: cursor.tip[1] * scale, size: CURSOR.imageSize };
    }
  }
  const shape: ShapeName = cursor.kind === 'shape' ? cursor.shape : 'arrow';
  const [tipX, tipY] = SHAPE_TIPS[shape];
  return { url: toDataUrl(shapeSvg(shape, color)), tipX, tipY, size: CURSOR.imageSize };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** White or near-black, whichever contrasts more with the background (WCAG relative luminance). */
export function tagTextColor(bg: string): string {
  const l = luminance(bg);
  const contrastWithWhite = 1.05 / (l + 0.05);
  const contrastWithDark = (l + 0.05) / (luminance('#1A1A1A') + 0.05);
  return contrastWithWhite >= contrastWithDark ? '#FFFFFF' : '#1A1A1A';
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- test/render.test.ts`

Expected: PASS, 29 tests in 1 file.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add web/src/cursors/render.ts web/test/render.test.ts
git commit -m "feat(cursors): Cursor images (C2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C4: Pixel editor

**Wave:** 3 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2, F5, U1

**Files:**
- Create: `web/src/profile/pixelEditor.ts`
- Create: `web/src/profile/pixelEditor.css`
- Test: `web/test/pixelEditor.test.ts`

`createPixelEditor(root, { color, art?, tip? })` builds a 16×16 grid of `[data-cell="0..255"]` elements, nine palette swatches (index 0 transparent, 1 the profile color, 2 to 8 the fixed colors), the tools `[data-tool="pen|eraser|tip|clear"]` and 1× and 2× previews. Painting works by pointer drag: `pointerdown` on a cell starts a stroke and `pointerover` on other cells continues it until `pointerup` or `pointercancel` on the document. The tip cell carries `.is-tip`. It returns `{ getArt(), getTip(), setColor(c), onChange(fn), destroy() }`. It does not import `render.ts` (C2 is built in the same wave); its previews are its own small SVGs.

- [ ] **Step 1: Write the failing test**

`web/test/pixelEditor.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ART_FIXED_COLORS } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { createPixelEditor } from '../src/profile/pixelEditor';

const COLOR = '#378ADD';

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
});

const cell = (i: number) => root.querySelector<HTMLElement>(`.pixel-grid [data-cell="${i}"]`)!;
const tool = (name: string) => root.querySelector<HTMLElement>(`[data-tool="${name}"]`)!;
const swatch = (i: number) => root.querySelector<HTMLElement>(`[data-palette="${i}"]`)!;

function pointer(el: Element, type: string, init: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

function pixels(editor: { getArt(): string }): Uint8Array {
  return decodeArt(editor.getArt())!;
}

describe('createPixelEditor structure', () => {
  it('renders a 16×16 grid of numbered cells', () => {
    createPixelEditor(root, { color: COLOR });
    const cells = root.querySelectorAll('.pixel-grid [data-cell]');
    expect(cells).toHaveLength(256);
    expect(cells[0]!.getAttribute('data-cell')).toBe('0');
    expect(cells[255]!.getAttribute('data-cell')).toBe('255');
  });

  it('renders the four tools', () => {
    createPixelEditor(root, { color: COLOR });
    for (const name of ['pen', 'eraser', 'tip', 'clear']) expect(tool(name)).not.toBeNull();
  });

  it('shows nine palette swatches: transparent, the profile color, then the fixed colors', () => {
    createPixelEditor(root, { color: COLOR });
    expect(root.querySelectorAll('[data-palette]')).toHaveLength(9);
    expect(swatch(0).classList.contains('is-transparent')).toBe(true);
    expect(swatch(1).style.background).not.toBe('');
    expect(swatch(2).getAttribute('aria-label')).toBe('Color 2');
    expect(ART_FIXED_COLORS).toHaveLength(7);
  });

  it('starts blank with the pen on your color and the tip in the center', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([8, 8]);
    expect(swatch(1).getAttribute('aria-pressed')).toBe('true');
    expect(swatch(2).getAttribute('aria-pressed')).toBe('false');
    expect(tool('pen').getAttribute('aria-pressed')).toBe('true');
    expect(cell(8 * 16 + 8).classList.contains('is-tip')).toBe(true);
    expect(root.querySelectorAll('.is-tip')).toHaveLength(1);
  });

  it('starts from the art and tip it is given', () => {
    const grid = emptyGrid();
    grid[5] = 3;
    const editor = createPixelEditor(root, { color: COLOR, art: encodeArt(grid), tip: [2, 3] });
    expect(pixels(editor)[5]).toBe(3);
    expect(cell(5).dataset.value).toBe('3');
    expect(editor.getTip()).toEqual([2, 3]);
    expect(cell(3 * 16 + 2).classList.contains('is-tip')).toBe(true);
  });

  it('starts blank and centered when the art or tip it is given is invalid', () => {
    const editor = createPixelEditor(root, { color: COLOR, art: 'garbage', tip: [99, 0] });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([8, 8]);
  });

  it('draws 1× and 2× previews', () => {
    createPixelEditor(root, { color: COLOR });
    expect(root.querySelector('.pixel-preview[data-scale="1"] svg')!.getAttribute('width')).toBe('16');
    expect(root.querySelector('.pixel-preview[data-scale="2"] svg')!.getAttribute('width')).toBe('32');
  });
});

describe('painting', () => {
  it('paints a cell with the selected color on pointer down', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(17), 'pointerdown');
    expect(pixels(editor)[17]).toBe(1);
    expect(cell(17).dataset.value).toBe('1');
    pointer(document.body, 'pointerup');
  });

  it('paints with a fixed palette color after it is chosen', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    swatch(4).click();
    expect(swatch(4).getAttribute('aria-pressed')).toBe('true');
    expect(swatch(1).getAttribute('aria-pressed')).toBe('false');
    pointer(cell(0), 'pointerdown');
    expect(pixels(editor)[0]).toBe(4);
    pointer(document.body, 'pointerup');
  });

  it('paints every cell the pointer passes over while it is held down', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(cell(1), 'pointerover');
    pointer(cell(2), 'pointerover');
    pointer(document.body, 'pointerup');
    pointer(cell(3), 'pointerover');
    const g = pixels(editor);
    expect([g[0], g[1], g[2], g[3]]).toEqual([1, 1, 1, 0]);
  });

  it('ignores pointer moves when no stroke has started', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(5), 'pointerover');
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
  });

  it('ignores non-primary mouse buttons', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(5), 'pointerdown', { button: 2 });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
  });

  it('erases with the eraser tool', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(9), 'pointerdown');
    pointer(document.body, 'pointerup');
    tool('eraser').click();
    expect(tool('eraser').getAttribute('aria-pressed')).toBe('true');
    expect(tool('pen').getAttribute('aria-pressed')).toBe('false');
    pointer(cell(9), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(pixels(editor)[9]).toBe(0);
  });

  it('goes back to the pen when a palette color is chosen while erasing', () => {
    createPixelEditor(root, { color: COLOR });
    tool('eraser').click();
    swatch(2).click();
    expect(tool('pen').getAttribute('aria-pressed')).toBe('true');
  });

  it('clears the whole drawing', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(1), 'pointerdown');
    pointer(cell(2), 'pointerover');
    pointer(document.body, 'pointerup');
    tool('clear').click();
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(cell(1).dataset.value).toBe('0');
  });

  it('keeps the tip where it was when the drawing is cleared', () => {
    const editor = createPixelEditor(root, { color: COLOR, tip: [1, 1] });
    pointer(cell(40), 'pointerdown');
    pointer(document.body, 'pointerup');
    tool('clear').click();
    expect(editor.getTip()).toEqual([1, 1]);
  });
});

describe('the tip', () => {
  it('moves to the clicked cell and marks it', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    tool('tip').click();
    pointer(cell(2 * 16 + 5), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(editor.getTip()).toEqual([5, 2]);
    expect(cell(2 * 16 + 5).classList.contains('is-tip')).toBe(true);
    expect(cell(8 * 16 + 8).classList.contains('is-tip')).toBe(false);
    expect(root.querySelectorAll('.is-tip')).toHaveLength(1);
  });

  it('does not paint when the tip tool is used, even when dragging', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    tool('tip').click();
    pointer(cell(0), 'pointerdown');
    pointer(cell(1), 'pointerover');
    pointer(document.body, 'pointerup');
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([0, 0]);
  });
});

describe('setColor', () => {
  it('recolors the palette, the cells and the previews without changing the art', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    const before = editor.getArt();
    const swatchBefore = swatch(1).style.background;
    editor.setColor('#D85A30');
    expect(editor.getArt()).toBe(before);
    expect(swatch(1).style.background).not.toBe(swatchBefore);
    expect(root.querySelector('.pixel-preview[data-scale="1"]')!.innerHTML.toLowerCase()).toContain('#d85a30');
    expect(root.querySelector('.pixel-preview[data-scale="1"]')!.innerHTML.toLowerCase()).not.toContain('#378add');
  });
});

describe('onChange and destroy', () => {
  it('reports each change with the encoded art and the tip', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    const fn = vi.fn();
    editor.onChange(fn);
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith({ art: editor.getArt(), tip: [8, 8] });
  });

  it('does not report painting a cell with the color it already has', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    const fn = vi.fn();
    editor.onChange(fn);
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops reporting after the returned unsubscribe is called', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    const fn = vi.fn();
    const off = editor.onChange(fn);
    off();
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).not.toHaveBeenCalled();
  });

  it('removes its markup on destroy', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    editor.destroy();
    expect(root.children).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/pixelEditor.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/profile/pixelEditor" from "test/pixelEditor.test.ts". Does the file exist?`

- [ ] **Step 3: Create `pixelEditor.css`**

`web/src/profile/pixelEditor.css`:

```css
.pixel-editor {
  display: grid;
  gap: 10px;
  justify-items: start;
}

.pixel-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pixel-tool {
  font: inherit;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.pixel-tool.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.pixel-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pixel-swatch {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.pixel-swatch.is-transparent {
  background:
    linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%) 0 0 / 10px 10px,
    linear-gradient(45deg, #ccc 25%, #fff 25%, #fff 75%, #ccc 75%) 5px 5px / 10px 10px;
}

.pixel-swatch.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pixel-grid {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  width: min(100%, 320px);
  aspect-ratio: 1;
  border: 1px solid var(--border);
  background:
    linear-gradient(45deg, #e6e6e6 25%, transparent 25%, transparent 75%, #e6e6e6 75%) 0 0 / 20px 20px,
    linear-gradient(45deg, #e6e6e6 25%, #fff 25%, #fff 75%, #e6e6e6 75%) 10px 10px / 20px 20px;
  touch-action: none;
  user-select: none;
  cursor: crosshair;
}

.pixel-cell {
  position: relative;
  box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.12);
}

.pixel-cell.is-tip::after {
  content: '';
  position: absolute;
  inset: 25%;
  border: 2px solid #ff00aa;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.6);
  pointer-events: none;
}

.pixel-previews {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.pixel-preview {
  line-height: 0;
  border: 1px solid var(--border);
  background: #fff;
}
```

- [ ] **Step 4: Implement `pixelEditor.ts`**

`web/src/profile/pixelEditor.ts`:

```ts
import { ART_SIZE } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt, isValidTip, paletteColors, type PixelGrid } from '@class-board/shared/pixelArt';
import type { Unsubscribe } from '../contracts';
import { clear, h } from '../ui/dom';
import './pixelEditor.css';

export interface PixelEditorOpts {
  /** The profile color: palette index 1. */
  color: string;
  /** An encoded drawing to start from. Anything undecodable starts blank. */
  art?: string;
  /** Hot spot cell. Defaults to the center, (8, 8). */
  tip?: [number, number];
}

export interface PixelEditorChange { art: string; tip: [number, number] }

export interface PixelEditor {
  getArt(): string;
  getTip(): [number, number];
  /** Changes palette index 1 everywhere, so the drawing is recolored. */
  setColor(color: string): void;
  onChange(fn: (change: PixelEditorChange) => void): Unsubscribe;
  destroy(): void;
}

type Tool = 'pen' | 'eraser' | 'tip';

const TOOLS: Array<{ tool: Tool | 'clear'; label: string }> = [
  { tool: 'pen', label: 'Pen' },
  { tool: 'eraser', label: 'Eraser' },
  { tool: 'tip', label: 'Set tip' },
  { tool: 'clear', label: 'Clear' },
];

const CELL_COUNT = ART_SIZE * ART_SIZE;

export function createPixelEditor(root: HTMLElement, opts: PixelEditorOpts): PixelEditor {
  let color = opts.color;
  let grid: PixelGrid = (opts.art ? decodeArt(opts.art) : null) ?? emptyGrid();
  let tip: [number, number] = isValidTip(opts.tip) ? [opts.tip[0], opts.tip[1]] : [ART_SIZE / 2, ART_SIZE / 2];
  let tool: Tool = 'pen';
  let selected = 1;
  let drawing = false;
  const listeners = new Set<(change: PixelEditorChange) => void>();

  const cells: HTMLElement[] = [];
  const swatches: HTMLElement[] = [];
  const toolButtons = new Map<string, HTMLElement>();

  const gridEl = h('div', { class: 'pixel-grid', attrs: { role: 'group', 'aria-label': 'Cursor drawing, 16 by 16 cells' } });
  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = h('div', { class: 'pixel-cell', dataset: { cell: String(i) } });
    cells.push(cell);
    gridEl.append(cell);
  }

  const paletteEl = h('div', { class: 'pixel-palette', attrs: { role: 'group', 'aria-label': 'Colors' } });
  for (let i = 0; i <= 8; i++) {
    const swatch = h('button', {
      type: 'button',
      class: 'pixel-swatch',
      dataset: { palette: String(i) },
      attrs: { 'aria-label': i === 0 ? 'Transparent' : i === 1 ? 'Your color' : `Color ${i}` },
      on: { click: () => choosePalette(i) },
    });
    swatches.push(swatch);
    paletteEl.append(swatch);
  }

  const toolsEl = h('div', { class: 'pixel-tools', attrs: { role: 'group', 'aria-label': 'Tools' } });
  for (const { tool: name, label } of TOOLS) {
    const button = h('button', {
      type: 'button',
      class: 'pixel-tool',
      dataset: { tool: name },
      on: { click: () => (name === 'clear' ? clearGrid() : chooseTool(name)) },
    }, label);
    toolButtons.set(name, button);
    toolsEl.append(button);
  }

  const previewOne = h('div', { class: 'pixel-preview', dataset: { scale: '1' }, attrs: { 'aria-hidden': 'true' } });
  const previewTwo = h('div', { class: 'pixel-preview', dataset: { scale: '2' }, attrs: { 'aria-hidden': 'true' } });
  const previewsEl = h('div', { class: 'pixel-previews' },
    h('span', { class: 'pixel-preview-label' }, '1×'), previewOne,
    h('span', { class: 'pixel-preview-label' }, '2×'), previewTwo);

  const wrapper = h('div', { class: 'pixel-editor' }, toolsEl, paletteEl, gridEl, previewsEl);
  clear(root);
  root.append(wrapper);

  function palette(): Array<string | null> {
    return paletteColors(color);
  }

  function previewSvg(scale: number): string {
    const colors = palette();
    let rects = '';
    for (let i = 0; i < CELL_COUNT; i++) {
      const fill = colors[grid[i]!];
      if (fill) rects += `<rect x="${i % ART_SIZE}" y="${Math.floor(i / ART_SIZE)}" width="1" height="1" fill="${fill}"/>`;
    }
    const size = ART_SIZE * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${ART_SIZE} ${ART_SIZE}" shape-rendering="crispEdges">${rects}</svg>`;
  }

  function paintCell(i: number): void {
    const fill = palette()[grid[i]!];
    cells[i]!.style.background = fill ?? '';
    cells[i]!.dataset.value = String(grid[i]);
    cells[i]!.classList.toggle('is-tip', i === tip[1] * ART_SIZE + tip[0]);
  }

  function refreshPreviews(): void {
    previewOne.innerHTML = previewSvg(1);
    previewTwo.innerHTML = previewSvg(2);
  }

  function refreshPalette(): void {
    const colors = palette();
    swatches.forEach((swatch, i) => {
      const fill = colors[i];
      swatch.style.background = fill ?? '';
      swatch.classList.toggle('is-transparent', !fill);
      swatch.classList.toggle('is-selected', i === selected);
      swatch.setAttribute('aria-pressed', String(i === selected));
    });
  }

  function refreshTools(): void {
    for (const [name, button] of toolButtons) {
      if (name === 'clear') continue;
      button.classList.toggle('is-active', name === tool);
      button.setAttribute('aria-pressed', String(name === tool));
    }
  }

  function refreshAll(): void {
    for (let i = 0; i < CELL_COUNT; i++) paintCell(i);
    refreshPalette();
    refreshTools();
    refreshPreviews();
  }

  function emit(): void {
    const change = { art: encodeArt(grid), tip: [tip[0], tip[1]] as [number, number] };
    for (const fn of [...listeners]) fn(change);
  }

  function setCell(i: number, value: number): void {
    if (grid[i] === value) return;
    grid[i] = value;
    paintCell(i);
    refreshPreviews();
    emit();
  }

  function setTip(i: number): void {
    const next: [number, number] = [i % ART_SIZE, Math.floor(i / ART_SIZE)];
    if (next[0] === tip[0] && next[1] === tip[1]) return;
    const old = tip[1] * ART_SIZE + tip[0];
    tip = next;
    paintCell(old);
    paintCell(i);
    emit();
  }

  function apply(i: number): void {
    if (tool === 'tip') setTip(i);
    else setCell(i, tool === 'eraser' ? 0 : selected);
  }

  function choosePalette(i: number): void {
    selected = i;
    if (tool !== 'pen') tool = 'pen';
    refreshPalette();
    refreshTools();
  }

  function chooseTool(next: Tool): void {
    tool = next;
    refreshTools();
  }

  function clearGrid(): void {
    if (grid.every((v) => v === 0)) return;
    grid = emptyGrid();
    refreshAll();
    emit();
  }

  function cellOf(target: EventTarget | null): number | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-cell]') : null;
    return el && gridEl.contains(el) ? Number(el.dataset.cell) : null;
  }

  function onPointerDown(e: Event): void {
    const pe = e as PointerEvent;
    if (pe.button !== 0) return;
    const i = cellOf(e.target);
    if (i === null) return;
    // Touch pointers are captured by the first cell; release so later cells get pointerover.
    try {
      (e.target as Element).releasePointerCapture?.(pe.pointerId);
    } catch {
      // Not captured: nothing to release.
    }
    e.preventDefault();
    drawing = tool !== 'tip';
    apply(i);
  }

  function onPointerOver(e: Event): void {
    if (!drawing) return;
    const i = cellOf(e.target);
    if (i !== null) apply(i);
  }

  function endStroke(): void {
    drawing = false;
  }

  gridEl.addEventListener('pointerdown', onPointerDown);
  gridEl.addEventListener('pointerover', onPointerOver);
  const doc = root.ownerDocument;
  doc.addEventListener('pointerup', endStroke);
  doc.addEventListener('pointercancel', endStroke);

  refreshAll();

  return {
    getArt: () => encodeArt(grid),
    getTip: () => [tip[0], tip[1]],
    setColor(next) {
      color = next;
      refreshAll();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    destroy() {
      doc.removeEventListener('pointerup', endStroke);
      doc.removeEventListener('pointercancel', endStroke);
      listeners.clear();
      clear(root);
    },
  };
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- test/pixelEditor.test.ts`

Expected: PASS, 23 tests in 1 file.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/profile/pixelEditor.ts web/src/profile/pixelEditor.css web/test/pixelEditor.test.ts
git commit -m "feat(profile): Pixel editor (C4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C5: Teacher session

**Wave:** 3 · **Tier:** T1 (sonnet, low) · **Depends on:** F2

**Files:**
- Create: `web/src/teacher/teacher.ts`
- Test: `web/test/teacher.test.ts`

`createTeacher(socket, storage = sessionStorage)` implements `TeacherApi`. `login(code)` sends `{ type: 'teacher', action: 'check', code }` with `socket.request`. Success stores the code under `classBoard.teacher` and becomes active. `bad_code` resolves `'bad'`, `locked_out` resolves `'locked_out'`, and any other error is rethrown. `lock`, `unlock`, `clear(slot)` and `resetCursor(personId)` send teacher requests with the stored code. A `bad_code` rejection logs out and rethrows. The active state is restored from storage when the session is created, and `onChange` fires only when the active state actually changes. The passcode is also kept in memory, so a tab whose `sessionStorage` is blocked still works until it closes. The request id is generated locally (12 base36 characters, the same format as `newReqId`), so this module doesn't import `net/socket.ts` and its `partysocket` dependency.

- [ ] **Step 1: Write the failing test**

`web/test/teacher.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ErrorCode, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { BoardSocket, ServerErrorLike } from '../src/contracts';
import { createTeacher } from '../src/teacher/teacher';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function serverError(code: ErrorCode): ServerErrorLike {
  return Object.assign(new Error(code), { code });
}

/** A BoardSocket whose request() answers from a script, and remembers what it was asked. */
function fakeSocket(reply: (msg: RequestMsg) => ServerMsg | ServerErrorLike) {
  const requests: RequestMsg[] = [];
  const socket: BoardSocket = {
    send: vi.fn(),
    request: async (msg) => {
      requests.push(msg);
      const result = reply(msg);
      if (result instanceof Error) throw result;
      return result as Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;
    },
    onMessage: () => () => {},
    onStatus: () => () => {},
    status: () => 'open',
    close: vi.fn(),
  };
  return { socket, requests };
}

const ok = (msg: RequestMsg): ServerMsg => ({ type: 'ok', reqId: msg.reqId });

describe('createTeacher login', () => {
  it('sends a check request with the passcode and becomes active on ok', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage());
    expect(teacher.active()).toBe(false);
    await expect(teacher.login('letmein')).resolves.toBe('ok');
    expect(teacher.active()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'check', code: 'letmein' });
    expect(requests[0]!.reqId).toMatch(/^[0-9a-z]{12}$/);
  });

  it('stores the passcode in the storage it is given', async () => {
    const storage = memoryStorage();
    const teacher = createTeacher(fakeSocket(ok).socket, storage);
    await teacher.login('letmein');
    expect(storage.getItem('classBoard.teacher')).toBe('letmein');
  });

  it('answers bad and stays inactive on bad_code', async () => {
    const storage = memoryStorage();
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, storage);
    await expect(teacher.login('nope')).resolves.toBe('bad');
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('answers locked_out on locked_out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('locked_out')).socket, memoryStorage());
    await expect(teacher.login('nope')).resolves.toBe('locked_out');
    expect(teacher.active()).toBe(false);
  });

  it('rethrows any other error, such as rate_limited', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('rate_limited')).socket, memoryStorage());
    await expect(teacher.login('x')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(teacher.active()).toBe(false);
  });
});

describe('createTeacher session', () => {
  it('restores the active state from storage on creation', () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    expect(teacher.active()).toBe(true);
  });

  it('uses the stored passcode for later actions', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    await teacher.lock();
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'lock', code: 'letmein' });
  });

  it('forgets the passcode on logout', async () => {
    const storage = memoryStorage({ 'classBoard.teacher': 'letmein' });
    const teacher = createTeacher(fakeSocket(ok).socket, storage);
    teacher.logout();
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('works for the tab even when storage throws', async () => {
    const broken = new Proxy({}, { get: () => () => { throw new DOMException('blocked', 'SecurityError'); } }) as Storage;
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, broken);
    expect(teacher.active()).toBe(false);
    await teacher.login('letmein');
    expect(teacher.active()).toBe(true);
    await teacher.unlock();
    expect(requests.at(-1)).toMatchObject({ action: 'unlock', code: 'letmein' });
  });
});

describe('createTeacher actions', () => {
  async function signedIn() {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    return { teacher, requests, socket };
  }

  it('lock and unlock send their action', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.lock();
    await teacher.unlock();
    expect(requests.map((r) => (r as { action: string }).action)).toEqual(['lock', 'unlock']);
  });

  it('clear sends the slot', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.clear(23);
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'clear', slot: 23, code: 'letmein' });
  });

  it('resetCursor sends the person as the target', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.resetCursor('conn-7');
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'resetCursor', target: 'conn-7', code: 'letmein' });
  });

  it('gives every request its own id', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.lock();
    await teacher.lock();
    expect(requests[0]!.reqId).not.toBe(requests[1]!.reqId);
  });

  it('refuses to act without logging in, and sends nothing', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage());
    await expect(teacher.lock()).rejects.toThrow('Not signed in');
    expect(requests).toHaveLength(0);
  });

  it('logs out and rethrows when the server says the passcode is wrong', async () => {
    const storage = memoryStorage({ 'classBoard.teacher': 'old-code' });
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, storage);
    await expect(teacher.clear(3)).rejects.toMatchObject({ code: 'bad_code' });
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('stays logged in and rethrows on other errors', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('rate_limited')).socket, memoryStorage({ 'classBoard.teacher': 'x' }));
    await expect(teacher.lock()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(teacher.active()).toBe(true);
  });
});

describe('createTeacher onChange', () => {
  it('fires with true on login and false on logout', async () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage());
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.login('letmein');
    teacher.logout();
    expect(fn.mock.calls).toEqual([[true], [false]]);
  });

  it('does not fire for a failed login or for a logout that was already logged out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, memoryStorage());
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.login('nope');
    teacher.logout();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires false when a bad_code rejection logs out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, memoryStorage({ 'classBoard.teacher': 'old' }));
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.lock().catch(() => {});
    expect(fn.mock.calls).toEqual([[false]]);
  });

  it('stops firing after the returned unsubscribe is called', async () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage());
    const fn = vi.fn();
    const off = teacher.onChange(fn);
    off();
    await teacher.login('letmein');
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/teacher.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/teacher/teacher" from "test/teacher.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `teacher.ts`**

`web/src/teacher/teacher.ts`:

```ts
import type { ClientMsg, SlotIndex } from '@class-board/shared/types';
import type { BoardSocket, TeacherApi, Unsubscribe } from '../contracts';

const STORAGE_KEY = 'classBoard.teacher';

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** 12 random base36 characters, like newReqId() in net/socket.ts. */
function makeReqId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
}

type TeacherMsg = Extract<ClientMsg, { type: 'teacher' }>;

export function createTeacher(socket: BoardSocket, storage: Storage | undefined = defaultStorage()): TeacherApi {
  const listeners = new Set<(active: boolean) => void>();

  function read(): string | null {
    try {
      return storage?.getItem(STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  // Kept in memory too, so a tab whose sessionStorage is blocked still works until it closes.
  let code: string | null = read();

  function notify(): void {
    for (const fn of [...listeners]) fn(code !== null);
  }

  function setCode(next: string | null): void {
    const changed = (code === null) !== (next === null);
    code = next;
    try {
      if (next === null) storage?.removeItem(STORAGE_KEY);
      else storage?.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved: the passcode stays in memory for this page only.
    }
    if (changed) notify();
  }

  async function act(fields: Pick<TeacherMsg, 'action' | 'slot' | 'target'>): Promise<void> {
    if (code === null) throw new Error('Not signed in as the teacher.');
    try {
      await socket.request({ type: 'teacher', reqId: makeReqId(), code, ...fields });
    } catch (err) {
      if ((err as { code?: string }).code === 'bad_code') setCode(null);
      throw err;
    }
  }

  return {
    active: () => code !== null,

    async login(attempt) {
      try {
        await socket.request({ type: 'teacher', reqId: makeReqId(), code: attempt, action: 'check' });
      } catch (err) {
        const errorCode = (err as { code?: string }).code;
        if (errorCode === 'bad_code') return 'bad';
        if (errorCode === 'locked_out') return 'locked_out';
        throw err;
      }
      setCode(attempt);
      return 'ok';
    },

    logout: () => setCode(null),
    lock: () => act({ action: 'lock' }),
    unlock: () => act({ action: 'unlock' }),
    clear: (slot: SlotIndex) => act({ action: 'clear', slot }),
    resetCursor: (personId: string) => act({ action: 'resetCursor', target: personId }),

    onChange(fn): Unsubscribe {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- test/teacher.test.ts`

Expected: PASS, 20 tests in 1 file.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add web/src/teacher/teacher.ts web/test/teacher.test.ts
git commit -m "feat(teacher): Teacher session (C5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C6: Local cursor

**Wave:** 4 · **Tier:** T2 (sonnet, medium) · **Depends on:** C1, C2

**Files:**
- Create: `web/src/cursors/local.ts`
- Test: `web/test/local.test.ts`

`createLocalCursor({ viewport, socket, now?, doc? })`:

- `applyDesign(profile)` renders `cursorImage` and sets `viewport.style.cursor` to `url("<url>") <tipX> <tipY>, auto`. If a second design is applied before the first finishes rendering, the newer one wins.
- `boardMove(bx, by)` rounds to integers and sends `{ type: 'cursor', x, y }` through a throttle at the current rate. `setRate(hz)` changes the interval, and 0 pauses.
- `dock(slot, mode)` sends `{ type: 'dock', slot, mode }` once, skipping an identical dock the server already holds, and suppresses cursor sends (including a pending trailing send). `undock()` resumes, and the next move sends at once.
- When the document becomes hidden it sends `{ type: 'away' }` and drops any pending position. When it is visible again it resends the dock if docked, otherwise the last position.
- `destroy()` removes the `visibilitychange` listener.

- [ ] **Step 1: Write the failing test**

`web/test/local.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import type { ClientMsg, Profile } from '@class-board/shared/types';
import type { BoardSocket } from '../src/contracts';
import { createLocalCursor } from '../src/cursors/local';

let viewport: HTMLElement;
let sent: ClientMsg[];
let socket: BoardSocket;
let visibility: 'visible' | 'hidden';

function setVisibility(next: 'visible' | 'hidden'): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  viewport = document.createElement('div');
  sent = [];
  socket = {
    send: (m) => void sent.push(m),
    request: vi.fn(),
    onMessage: () => () => {},
    onStatus: () => () => {},
    status: () => 'open',
    close: vi.fn(),
  };
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('createLocalCursor cursor sending', () => {
  it('sends the first position at once, rounded to integers', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(100.4, 200.6);
    expect(sent).toEqual([{ type: 'cursor', x: 100, y: 201 }]);
    cursor.destroy();
  });

  it('sends at most 5 times a second and finishes with the final position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    for (let i = 0; i < 20; i++) {
      cursor.boardMove(i, i);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(1_000);
    const cursors = sent.filter((m) => m.type === 'cursor');
    expect(cursors.length).toBeLessThanOrEqual(6);
    expect(cursors.at(-1)).toEqual({ type: 'cursor', x: 19, y: 19 });
    cursor.destroy();
  });

  it('sends nothing while the pointer is still', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    cursor.destroy();
  });

  it('slows to 2 Hz when the server lowers the rate', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.setRate(2);
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(100);
    cursor.boardMove(2, 2);
    vi.advanceTimersByTime(399);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    cursor.destroy();
  });

  it('sends nothing at rate 0 and picks up again when the rate returns', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.setRate(0);
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(0);
    cursor.setRate(5);
    cursor.boardMove(2, 2);
    expect(sent).toEqual([{ type: 'cursor', x: 2, y: 2 }]);
    cursor.destroy();
  });
});

describe('createLocalCursor docking', () => {
  it('sends dock once and skips an identical dock', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(23, 'using');
    cursor.dock(23, 'using');
    expect(sent).toEqual([{ type: 'dock', slot: 23, mode: 'using' }]);
    cursor.destroy();
  });

  it('sends a new dock when the slot or mode changes', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(23, 'using');
    cursor.dock(23, 'viewing');
    cursor.dock(24, 'viewing');
    expect(sent.map((m) => JSON.stringify(m))).toEqual([
      '{"type":"dock","slot":23,"mode":"using"}',
      '{"type":"dock","slot":23,"mode":"viewing"}',
      '{"type":"dock","slot":24,"mode":"viewing"}',
    ]);
    cursor.destroy();
  });

  it('suppresses cursor sends while docked, including a pending trailing send', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.boardMove(2, 2);
    cursor.dock(5, 'using');
    cursor.boardMove(3, 3);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([
      { type: 'cursor', x: 1, y: 1 },
      { type: 'dock', slot: 5, mode: 'using' },
    ]);
    cursor.destroy();
  });

  it('sends the very next move after undock', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.dock(5, 'viewing');
    cursor.undock();
    cursor.boardMove(9, 9);
    expect(sent.at(-1)).toEqual({ type: 'cursor', x: 9, y: 9 });
    expect(sent).toHaveLength(3);
    cursor.destroy();
  });

  it('does not repeat a dock that the server already holds after an undock and dock without a move between', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(5, 'using');
    cursor.undock();
    cursor.dock(5, 'using');
    expect(sent).toHaveLength(1);
    cursor.destroy();
  });

  it('sends a dock again after a cursor message has replaced it', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(5, 'using');
    cursor.undock();
    cursor.boardMove(1, 1);
    cursor.dock(5, 'using');
    expect(sent.map((m) => m.type)).toEqual(['dock', 'cursor', 'dock']);
    cursor.destroy();
  });
});

describe('createLocalCursor tab visibility', () => {
  it('sends away when the tab is hidden and drops a pending position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.boardMove(2, 2);
    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{ type: 'cursor', x: 1, y: 1 }, { type: 'away' }]);
    cursor.destroy();
  });

  it('resends the last position when the tab is visible again', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(10, 20);
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent.map((m) => m.type)).toEqual(['cursor', 'away', 'cursor']);
    expect(sent.at(-1)).toEqual({ type: 'cursor', x: 10, y: 20 });
    cursor.destroy();
  });

  it('resends the dock instead when docked', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(10, 20);
    cursor.dock(5, 'viewing');
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent.map((m) => m.type)).toEqual(['cursor', 'dock', 'away', 'dock']);
    expect(sent.at(-1)).toEqual({ type: 'dock', slot: 5, mode: 'viewing' });
    cursor.destroy();
  });

  it('sends nothing on becoming visible when there was never a position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent).toEqual([{ type: 'away' }]);
    cursor.destroy();
  });

  it('stops listening after destroy', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.destroy();
    setVisibility('hidden');
    expect(sent).toHaveLength(0);
  });

  it('listens on the document it is given', () => {
    const other = document.implementation.createHTMLDocument('other');
    Object.defineProperty(other, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const cursor = createLocalCursor({ viewport, socket, doc: other });
    other.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toEqual([{ type: 'away' }]);
    cursor.destroy();
  });
});

describe('createLocalCursor applyDesign', () => {
  const profile: Profile = { name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'pencil' } };

  it('sets the CSS cursor from the rendered image with its hot spot', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    await cursor.applyDesign(profile);
    expect(viewport.style.cursor).toMatch(/^url\("data:image\/svg\+xml;utf8,%3Csvg[^"]+"\) 2 30, auto$/);
    cursor.destroy();
  });

  it('uses the pixel art hot spot, doubled', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    await cursor.applyDesign({ ...profile, cursor: { kind: 'pixels', art: encodeArt(emptyGrid()), tip: [3, 4] } });
    expect(viewport.style.cursor).toMatch(/\) 6 8, auto$/);
    cursor.destroy();
  });

  it('keeps the newest design when two are applied in quick succession', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    const first = cursor.applyDesign(profile);
    const second = cursor.applyDesign({ ...profile, cursor: { kind: 'shape', shape: 'hand' } });
    await Promise.all([first, second]);
    expect(viewport.style.cursor).toMatch(/\) 13 2, auto$/);
    cursor.destroy();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/local.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/cursors/local" from "test/local.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `local.ts`**

`web/src/cursors/local.ts`:

```ts
import { RATES } from '@class-board/shared/constants';
import type { SlotIndex } from '@class-board/shared/types';
import type { LocalCursorApi, LocalCursorDeps } from '../contracts';
import { cursorImage } from './render';
import { createThrottle } from './throttle';

interface Point { x: number; y: number }
interface Dock { slot: SlotIndex; mode: 'using' | 'viewing' }

export function createLocalCursor(deps: LocalCursorDeps): LocalCursorApi {
  const { viewport, socket } = deps;
  const doc = deps.doc ?? document;

  let rate: number = RATES.cursorHz;
  let last: Point | null = null;
  let docked: Dock | null = null;
  /** The dock the server currently holds for us; cleared once a cursor or away message replaces it. */
  let sentDock: string | null = null;
  let designSeq = 0;

  const throttle = createThrottle<Point>(
    (p) => {
      sentDock = null;
      socket.send({ type: 'cursor', x: p.x, y: p.y });
    },
    { hz: rate, now: deps.now },
  );

  function sendDock(d: Dock): void {
    sentDock = `${d.slot}:${d.mode}`;
    socket.send({ type: 'dock', slot: d.slot, mode: d.mode });
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'hidden') {
      throttle.cancel();
      sentDock = null;
      socket.send({ type: 'away' });
      return;
    }
    if (docked) sendDock(docked);
    else if (last && rate > 0) {
      sentDock = null;
      socket.send({ type: 'cursor', x: last.x, y: last.y });
    }
  }

  doc.addEventListener('visibilitychange', onVisibility);

  return {
    async applyDesign(profile) {
      const seq = ++designSeq;
      const img = await cursorImage(profile);
      if (seq !== designSeq) return;
      viewport.style.cursor = `url("${img.url}") ${img.tipX} ${img.tipY}, auto`;
    },

    boardMove(bx, by) {
      if (docked) return;
      last = { x: Math.round(bx), y: Math.round(by) };
      throttle.push(last);
    },

    dock(slot, mode) {
      docked = { slot, mode };
      throttle.cancel();
      if (sentDock !== `${slot}:${mode}`) sendDock(docked);
    },

    undock() {
      docked = null;
    },

    setRate(hz) {
      rate = hz;
      throttle.setHz(hz);
    },

    destroy() {
      doc.removeEventListener('visibilitychange', onVisibility);
      throttle.cancel();
    },
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- test/local.test.ts`

Expected: PASS, 20 tests in 1 file.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add web/src/cursors/local.ts web/test/local.test.ts
git commit -m "feat(cursors): Local cursor (C6)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C7: Remote cursors

**Wave:** 4 · **Tier:** T2 (sonnet, medium) · **Depends on:** C1, C2, U1, F3

**Files:**
- Create: `web/src/cursors/remote.ts`
- Create: `web/src/cursors/cursors.css`
- Test: `web/test/remote.test.ts`

`createRemoteCursors({ layer, camera, state, now? })` keeps one `.cursor[data-person]` in `#cursor-layer` for everyone except `state.you()`. Each holds an `img` (from `cursorImage`, cached by the profile's JSON, shifted so the hot spot sits on the cursor position) and a `.cursor-tag` colored with the profile color and `tagTextColor`.

- **Board presence:** the position comes from one interpolator per person, fed by `'cursors'` events and converted with `camera.toScreen`. A person who hasn't moved yet stays hidden.
- **Tile presence:** parked at the top-left of `camera.slotScreenRect(slot)`, tag "Name · using C4" or "Name · viewing C4".
- **Away:** hidden (the element is kept).
- **Idle:** a board cursor that hasn't moved for more than `CURSOR.idleMs` gets `.is-idle` and inline opacity `CURSOR.idleOpacity`, and the CSS hides its tag. A cursor parked on a tile never fades, so its "using C4" tag stays readable.
- **Loop:** a `requestAnimationFrame` loop with `start()` and `stop()`. It writes to the DOM only when something changed. It also redraws on `camera.onChange`, so cursors follow zoom and pan without waiting for a frame.
- **Test seams:** optional `raf` and `caf` on the deps object, in addition to `now`.
- Elements are removed when people leave. A `'cursors'` move for someone that `state.person(id)` knows but the `'people'` event hasn't announced yet creates the cursor.

`#cursor-layer` itself (position, pointer-events, z-index) is styled in `base.css` (U6). `cursors.css` only styles what's inside it.

- [ ] **Step 1: Write the failing test**

`web/test/remote.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS, CURSOR } from '@class-board/shared/constants';
import type { CursorMove, Person, Presence, Profile, SlotIndex } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, CameraApi, CameraState } from '../src/contracts';
import { createRemoteCursors } from '../src/cursors/remote';
import { cursorImage, shapeSvg } from '../src/cursors/render';

// Wraps the real renderer so the test can count how often an image is actually built.
vi.mock('../src/cursors/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/cursors/render')>();
  return { ...real, cursorImage: vi.fn(real.cursorImage) };
});

const ME = 'conn-me';
const ANA = 'conn-ana';
const BEN = 'conn-ben';

function profile(name: string, color: string = COLORS[3], shape: 'arrow' | 'star' = 'arrow'): Profile {
  return { name, color, cursor: { kind: 'shape', shape } };
}

function person(id: string, p: Profile, presence: Presence = { at: 'board' }): Person {
  return { id, clientId: `client-${id}`, profile: p, presence };
}

/** A BoardStateApi that only implements what the remote cursors read, with hand-driven events. */
function fakeState() {
  let people: Person[] = [];
  let you: string | null = ME;
  const listeners = new Map<keyof BoardStateEvents, Set<(payload: never) => void>>();
  const state = {
    you: () => you,
    people: () => people,
    person: (id: string) => people.find((p) => p.id === id),
    on(event: keyof BoardStateEvents, fn: (payload: never) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => void listeners.get(event)!.delete(fn);
    },
  } as unknown as BoardStateApi;
  const emit = <K extends keyof BoardStateEvents>(event: K, payload: BoardStateEvents[K]) => {
    for (const fn of [...(listeners.get(event) ?? [])]) (fn as (p: BoardStateEvents[K]) => void)(payload);
  };
  return {
    state,
    setPeople(next: Person[]) {
      people = next;
      emit('people', undefined);
    },
    /** Changes the list without announcing it, like a move that arrives ahead of its 'people' event. */
    setPeopleQuietly(next: Person[]) {
      people = next;
    },
    moves(list: CursorMove[]) {
      emit('cursors', list);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** A camera with a fixed transform that the test can change, and a tile at each slot's own place. */
function fakeCamera() {
  let cam: CameraState = { s: 1, tx: 0, ty: 0 };
  const listeners = new Set<(s: CameraState) => void>();
  const camera = {
    toScreen: (bx: number, by: number) => ({ x: bx * cam.s + cam.tx, y: by * cam.s + cam.ty }),
    slotScreenRect: (slot: SlotIndex) => ({ x: 100 + slot, y: 200 + slot, w: 480, h: 300 }),
    onChange(fn: (s: CameraState) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } as unknown as CameraApi;
  return {
    camera,
    set(next: CameraState) {
      cam = next;
      for (const fn of [...listeners]) fn(cam);
    },
    listenerCount: () => listeners.size,
  };
}

let time: number;
let frames: Array<() => void>;
let cancelled: number[];

const raf = (fn: () => void) => {
  frames.push(fn);
  return frames.length;
};
const caf = (id: number) => void cancelled.push(id);

/** Runs the animation frame that is currently queued. */
function frame(): void {
  const fn = frames.shift();
  fn?.();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let layer: HTMLElement;

function setup(initial: Person[] = []) {
  const s = fakeState();
  const c = fakeCamera();
  s.setPeople(initial);
  const cursors = createRemoteCursors({ layer, camera: c.camera, state: s.state, now: () => time, raf, caf });
  return { s, c, cursors };
}

/** A color as the DOM writes it back, so the test doesn't care whether it is stored as hex or rgb(). */
function asStyled(property: 'background' | 'color', value: string): string {
  const probe = document.createElement('i');
  probe.style[property] = value;
  return probe.style[property];
}

const cursorEl = (id: string) => layer.querySelector<HTMLElement>(`.cursor[data-person="${id}"]`);
const tagOf = (id: string) => cursorEl(id)!.querySelector<HTMLElement>('.cursor-tag')!;

beforeEach(() => {
  time = 10_000;
  frames = [];
  cancelled = [];
  layer = document.createElement('div');
  layer.id = 'cursor-layer';
  document.body.replaceChildren(layer);
  vi.mocked(cursorImage).mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('one cursor per other person', () => {
  it('adds a .cursor[data-person] for everyone except you', () => {
    const { cursors } = setup([person(ME, profile('Me')), person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    cursors.start();
    expect(layer.querySelectorAll('.cursor')).toHaveLength(2);
    expect(cursorEl(ME)).toBeNull();
    expect(cursorEl(ANA)).not.toBeNull();
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });

  it('holds an image and a name tag in each cursor', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    const el = cursorEl(ANA)!;
    expect(el.querySelector('img')).not.toBeNull();
    expect(el.querySelector('.cursor-tag')).not.toBeNull();
    cursors.stop();
  });

  it('adds a cursor when someone joins and removes it when they leave', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.setPeople([person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).not.toBeNull();
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(ANA)).toBeNull();
    expect(layer.querySelectorAll('.cursor')).toHaveLength(1);
    cursors.stop();
  });

  it('leaves the same element in place when the people list changes but the person does not', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    const before = cursorEl(ANA);
    s.setPeople([person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    expect(cursorEl(ANA)).toBe(before);
    cursors.stop();
  });

  it('ignores moves for people it has never heard of', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    s.moves([['conn-ghost', 5, 5]]);
    expect(layer.querySelectorAll('.cursor')).toHaveLength(0);
    cursors.stop();
  });
});

describe('cursor look', () => {
  it('colors the tag with the profile color and picks the text color for contrast', () => {
    const { cursors } = setup([person(ANA, profile('Ana', '#EF9F27')), person(BEN, profile('Ben', '#534AB7'))]);
    cursors.start();
    frame();
    expect(tagOf(ANA).style.background).toBe(asStyled('background', '#EF9F27'));
    expect(tagOf(ANA).style.color).toBe(asStyled('color', '#1A1A1A'));
    expect(tagOf(BEN).style.background).toBe(asStyled('background', '#534AB7'));
    expect(tagOf(BEN).style.color).toBe(asStyled('color', '#FFFFFF'));
    cursors.stop();
  });

  it('shows the cursor design from cursorImage, shifted so the hot spot sits on the cursor position', async () => {
    const { cursors } = setup([person(ANA, profile('Ana', COLORS[3], 'star'))]);
    cursors.start();
    await settle();
    const img = cursorEl(ANA)!.querySelector('img')!;
    expect(decodeURIComponent(img.getAttribute('src')!)).toContain(shapeSvg('star', COLORS[3]));
    expect(img.getAttribute('width')).toBe('32');
    expect(img.style.left).toBe('-16px');
    expect(img.style.top).toBe('-16px');
    cursors.stop();
  });

  it('builds one image for everyone who shares a profile design', async () => {
    const shared = profile('Sam', COLORS[1]);
    const { s, cursors } = setup([person(ANA, shared), person(BEN, { ...shared })]);
    cursors.start();
    await settle();
    s.setPeople([person(ANA, shared), person(BEN, { ...shared }), person('conn-cy', { ...shared })]);
    await settle();
    expect(vi.mocked(cursorImage)).toHaveBeenCalledTimes(1);
    s.setPeople([person(ANA, profile('Sam', COLORS[2]))]);
    await settle();
    expect(vi.mocked(cursorImage)).toHaveBeenCalledTimes(2);
    cursors.stop();
  });

  it('updates the tag and the image when a person changes their profile', async () => {
    const { s, cursors } = setup([person(ANA, profile('Ana', COLORS[3], 'arrow'))]);
    cursors.start();
    await settle();
    frame();
    s.setPeople([person(ANA, profile('Anna', COLORS[0], 'star'))]);
    await settle();
    frame();
    expect(tagOf(ANA).textContent).toBe('Anna');
    expect(decodeURIComponent(cursorEl(ANA)!.querySelector('img')!.getAttribute('src')!)).toContain(shapeSvg('star', COLORS[0]));
    cursors.stop();
  });
});

describe('cursors on the board', () => {
  it('stays hidden until the person has moved', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    cursors.stop();
  });

  it('shows the name in the tag and moves through the camera to screen pixels', () => {
    const { s, c, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    c.set({ s: 2, tx: 10, ty: -20 });
    s.moves([[ANA, 100, 50]]);
    time += CURSOR.renderDelayMs;
    frame();
    const el = cursorEl(ANA)!;
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toBe('translate3d(210.0px, 80.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana');
    cursors.stop();
  });

  it('draws the cursor 200 ms behind, moving in a straight line between received positions', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 0, 0]]);
    time += 200;
    s.moves([[ANA, 100, 200]]);
    time += 100;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(50.0px, 100.0px, 0)');
    time += 100;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(100.0px, 200.0px, 0)');
    cursors.stop();
  });

  it('jumps instead of gliding after a gap of more than a second', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 0, 0]]);
    time += CURSOR.jumpGapMs + 1;
    s.moves([[ANA, 400, 400]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(400.0px, 400.0px, 0)');
    cursors.stop();
  });

  it('keeps the cursor where it was when the camera moves', () => {
    const { s, c, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 100, 100]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(100.0px, 100.0px, 0)');
    c.set({ s: 0.5, tx: 0, ty: 0 });
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(50.0px, 50.0px, 0)');
    cursors.stop();
  });

  it('does not draw your own cursor even if a move for you arrives', () => {
    const { s, cursors } = setup([person(ME, profile('Me'))]);
    cursors.start();
    s.moves([[ME, 1, 1]]);
    expect(layer.querySelectorAll('.cursor')).toHaveLength(0);
    cursors.stop();
  });

  it('shows a cursor that a move mentions before the people list has caught up', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    s.setPeopleQuietly([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).toBeNull();
    s.moves([[BEN, 5, 5]]);
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });
});

describe('cursors parked on a tile', () => {
  it('sits at the top-left of the tile with a "using" tag', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 23, mode: 'using' })]);
    cursors.start();
    frame();
    const el = cursorEl(ANA)!;
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toBe('translate3d(123.0px, 223.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana · using C4');
    cursors.stop();
  });

  it('says "viewing" for focus mode', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 79, mode: 'viewing' })]);
    cursors.start();
    frame();
    expect(tagOf(ANA).textContent).toBe('Ana · viewing H10');
    cursors.stop();
  });

  it('follows the tile when the camera moves', () => {
    const { c, cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 0, mode: 'using' })]);
    cursors.start();
    frame();
    const before = cursorEl(ANA)!.style.transform;
    const rect = c.camera.slotScreenRect(0);
    c.camera.slotScreenRect = () => ({ ...rect, x: rect.x + 40, y: rect.y + 10 });
    c.set({ s: 1, tx: 0, ty: 0 });
    expect(cursorEl(ANA)!.style.transform).not.toBe(before);
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(140.0px, 210.0px, 0)');
    cursors.stop();
  });

  it('moves from the board to a tile and back when presence changes', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    s.setPeople([person(ANA, profile('Ana'), { at: 'tile', slot: 1, mode: 'using' })]);
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(101.0px, 201.0px, 0)');
    s.setPeople([person(ANA, profile('Ana'), { at: 'board' })]);
    s.moves([[ANA, 30, 40]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(30.0px, 40.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana');
    cursors.stop();
  });
});

describe('away', () => {
  it('hides a cursor whose tab is hidden and shows it again on return', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(false);
    s.setPeople([person(ANA, profile('Ana'), { at: 'away' })]);
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    s.setPeople([person(ANA, profile('Ana'), { at: 'board' })]);
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(false);
    cursors.stop();
  });

  it('keeps the element for an away person, so a returning cursor does not flash in the wrong place', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'away' })]);
    cursors.start();
    frame();
    expect(cursorEl(ANA)).not.toBeNull();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    cursors.stop();
  });
});

describe('idle cursors', () => {
  function movedOnce() {
    const ctx = setup([person(ANA, profile('Ana'))]);
    ctx.cursors.start();
    ctx.s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    return ctx;
  }

  it('is not idle right after moving', () => {
    const { cursors } = movedOnce();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    expect(cursorEl(ANA)!.style.opacity).toBe('');
    cursors.stop();
  });

  it('is not idle at exactly idleMs, and is idle after it, at reduced opacity', () => {
    const { cursors } = movedOnce();
    time = 10_000 + CURSOR.idleMs;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    time += 1;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(true);
    expect(cursorEl(ANA)!.style.opacity).toBe(String(CURSOR.idleOpacity));
    cursors.stop();
  });

  it('comes back at full opacity as soon as the person moves', () => {
    const { s, cursors } = movedOnce();
    time += CURSOR.idleMs + 1_000;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(true);
    s.moves([[ANA, 20, 20]]);
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    expect(cursorEl(ANA)!.style.opacity).toBe('');
    cursors.stop();
  });

  it('does not fade a cursor that is parked on a tile, so its "using" tag stays readable', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 5, mode: 'using' })]);
    cursors.start();
    frame();
    time += CURSOR.idleMs * 3;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    cursors.stop();
  });
});

describe('the animation loop', () => {
  it('draws once on start and queues the next frame', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    expect(frames).toHaveLength(0);
    cursors.start();
    expect(frames).toHaveLength(1);
    frame();
    expect(frames).toHaveLength(1);
    cursors.stop();
  });

  it('cancels the queued frame on stop', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    cursors.stop();
    expect(cancelled).toEqual([1]);
  });

  it('stops listening to state and camera on stop', () => {
    const { s, c, cursors } = setup([]);
    cursors.start();
    expect(s.listenerCount()).toBeGreaterThan(0);
    expect(c.listenerCount()).toBe(1);
    cursors.stop();
    expect(s.listenerCount()).toBe(0);
    expect(c.listenerCount()).toBe(0);
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).toBeNull();
  });

  it('subscribes only once when started twice', () => {
    const { s, c, cursors } = setup([]);
    cursors.start();
    const count = s.listenerCount();
    cursors.start();
    expect(s.listenerCount()).toBe(count);
    expect(c.listenerCount()).toBe(1);
    expect(frames).toHaveLength(1);
    cursors.stop();
  });

  it('can be started again after a stop', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    cursors.stop();
    cursors.start();
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });

  it('does not touch the DOM for a cursor that has not changed', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    const writes = vi.fn();
    new MutationObserver(writes).observe(layer, { attributes: true, subtree: true, childList: true, characterData: true });
    frame();
    frame();
    return Promise.resolve().then(() => {
      expect(writes).not.toHaveBeenCalled();
      cursors.stop();
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/remote.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/cursors/remote" from "test/remote.test.ts". Does the file exist?`

- [ ] **Step 3: Create `cursors.css`**

`web/src/cursors/cursors.css`:

```css
/* #cursor-layer itself (position, pointer-events, z-index) is styled in base.css. */

.cursor {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  will-change: transform;
  transition: opacity 0.4s ease;
}

.cursor[hidden] {
  display: none;
}

.cursor-img {
  position: absolute;
  display: block;
  width: 32px;
  height: 32px;
  max-width: none;
  user-select: none;
}

.cursor-tag {
  position: absolute;
  left: 14px;
  top: 20px;
  max-width: 220px;
  padding: 2px 8px;
  border-radius: 999px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 12px/1.4 var(--font, system-ui, sans-serif);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.cursor.is-idle .cursor-tag {
  display: none;
}
```

- [ ] **Step 4: Implement `remote.ts`**

`web/src/cursors/remote.ts`:

```ts
import { CURSOR } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { Person } from '@class-board/shared/types';
import type { CursorImage, RemoteCursorsApi, RemoteCursorsDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { createInterpolator, type Interpolator } from './interpolate';
import { cursorImage, tagTextColor } from './render';
import './cursors.css';

/** Optional test seams on top of the contract's deps. */
export interface RemoteCursorsSeams extends RemoteCursorsDeps {
  raf?: (fn: () => void) => number;
  caf?: (id: number) => void;
}

interface Entry {
  el: HTMLElement;
  img: HTMLElement;
  tag: HTMLElement;
  interp: Interpolator;
  person: Person;
  profileKey: string;
  presenceKey: string;
  /** Last time this person moved, joined or changed what they're doing. */
  lastActive: number;
  written: { visible: boolean; transform: string; idle: boolean; tagText: string };
}

const IMAGE_CACHE_LIMIT = 200;

export function createRemoteCursors(deps: RemoteCursorsSeams): RemoteCursorsApi {
  const { layer, camera, state } = deps;
  const now = deps.now ?? (() => Date.now());
  const raf = deps.raf ?? ((fn) => requestAnimationFrame(fn));
  const caf = deps.caf ?? ((id) => cancelAnimationFrame(id));

  const entries = new Map<string, Entry>();
  const images = new Map<string, Promise<CursorImage>>();
  let subscriptions: Unsubscribe[] = [];
  let frame: number | null = null;
  let running = false;

  function imageFor(key: string, person: Person): Promise<CursorImage> {
    let image = images.get(key);
    if (!image) {
      if (images.size >= IMAGE_CACHE_LIMIT) images.clear();
      image = cursorImage(person.profile);
      images.set(key, image);
    }
    return image;
  }

  function applyProfile(entry: Entry, person: Person, key: string): void {
    entry.profileKey = key;
    entry.tag.style.background = person.profile.color;
    entry.tag.style.color = tagTextColor(person.profile.color);
    void imageFor(key, person).then((image) => {
      if (entry.profileKey !== key) return;
      entry.img.setAttribute('src', image.url);
      entry.img.style.left = `${-image.tipX}px`;
      entry.img.style.top = `${-image.tipY}px`;
    });
  }

  function create(person: Person): Entry {
    const img = h('img', { class: 'cursor-img', attrs: { alt: '', draggable: 'false', width: String(CURSOR.imageSize), height: String(CURSOR.imageSize) } });
    const tag = h('span', { class: 'cursor-tag' });
    const el = h('div', { class: 'cursor', dataset: { person: person.id }, hidden: true }, img, tag);
    layer.append(el);
    const entry: Entry = {
      el, img, tag, person,
      interp: createInterpolator(),
      profileKey: '',
      presenceKey: JSON.stringify(person.presence),
      lastActive: now(),
      written: { visible: false, transform: '', idle: false, tagText: '' },
    };
    entries.set(person.id, entry);
    applyProfile(entry, person, JSON.stringify(person.profile));
    return entry;
  }

  function update(entry: Entry, person: Person): void {
    entry.person = person;
    const profileKey = JSON.stringify(person.profile);
    if (profileKey !== entry.profileKey) applyProfile(entry, person, profileKey);
    const presenceKey = JSON.stringify(person.presence);
    if (presenceKey !== entry.presenceKey) {
      entry.presenceKey = presenceKey;
      entry.lastActive = now();
    }
  }

  function reconcile(): void {
    const you = state.you();
    const present = new Set<string>();
    for (const person of state.people()) {
      if (person.id === you) continue;
      present.add(person.id);
      const entry = entries.get(person.id);
      if (entry) update(entry, person);
      else create(person);
    }
    for (const [id, entry] of entries) {
      if (present.has(id)) continue;
      entry.el.remove();
      entries.delete(id);
    }
  }

  function onMoves(moves: ReadonlyArray<readonly [string, number, number]>): void {
    const you = state.you();
    const t = now();
    for (const [id, x, y] of moves) {
      if (id === you) continue;
      let entry = entries.get(id);
      if (!entry) {
        const person = state.person(id);
        if (!person) continue;
        entry = create(person);
      }
      entry.interp.push(t, x, y);
      entry.lastActive = t;
    }
  }

  function tick(): void {
    const t = now();
    for (const entry of entries.values()) {
      const { presence, profile } = entry.person;
      let point: { x: number; y: number } | null = null;
      let tagText = profile.name;
      if (presence.at === 'tile') {
        const rect = camera.slotScreenRect(presence.slot);
        point = { x: rect.x, y: rect.y };
        tagText = `${profile.name} · ${presence.mode} ${slotName(presence.slot)}`;
      } else if (presence.at === 'board') {
        const sample = entry.interp.sample(t);
        if (sample) point = camera.toScreen(sample.x, sample.y);
      }

      const visible = point !== null;
      // A cursor parked on a tile keeps its "using C4" tag readable, so only board cursors fade.
      const idle = visible && presence.at === 'board' && t - entry.lastActive > CURSOR.idleMs;
      const w = entry.written;
      if (visible !== w.visible) {
        entry.el.hidden = !visible;
        w.visible = visible;
      }
      if (point) {
        const transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
        if (transform !== w.transform) {
          entry.el.style.transform = transform;
          w.transform = transform;
        }
      }
      if (idle !== w.idle) {
        entry.el.classList.toggle('is-idle', idle);
        entry.el.style.opacity = idle ? String(CURSOR.idleOpacity) : '';
        w.idle = idle;
      }
      if (tagText !== w.tagText) {
        entry.tag.textContent = tagText;
        w.tagText = tagText;
      }
    }
  }

  function loop(): void {
    tick();
    frame = raf(loop);
  }

  return {
    start() {
      if (running) return;
      running = true;
      subscriptions = [
        state.on('cursors', onMoves),
        state.on('people', reconcile),
        state.on('snapshot', reconcile),
        camera.onChange(tick),
      ];
      reconcile();
      loop();
    },

    stop() {
      if (!running) return;
      running = false;
      for (const off of subscriptions) off();
      subscriptions = [];
      if (frame !== null) caf(frame);
      frame = null;
    },
  };
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- test/remote.test.ts`

Expected: PASS, 32 tests in 1 file.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/cursors/remote.ts web/src/cursors/cursors.css web/test/remote.test.ts
git commit -m "feat(cursors): Remote cursors (C7)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C8: Profile panel

**Wave:** 4 · **Tier:** T2 (sonnet, medium) · **Depends on:** C2, C4, U1, F5

**Files:**
- Create: `web/src/profile/panel.ts`
- Create: `web/src/profile/panel.css`
- Test: `web/test/panel.test.ts`

`openProfilePanel(opts)` opens `openModal({ title: 'Your cursor', dialog: 'profile', closable })`. `closable` is `false` while `opts.requireName` is set and `opts.initial` is missing or isn't a valid profile.

- `input[name="name"]`, `maxLength` `LIMITS.nameMax`, cleaned with `cleanText` on save. Enter in the field saves.
- 12 color swatches `[data-color="#hex"]`, with `.is-selected` and `aria-pressed`.
- Tabs `[data-tab="shape|pixels"]`. The shape tab holds six `[data-shape]` buttons drawn with `shapeSvg` in the chosen color. The pixels tab holds the pixel editor (C4). The panel opens on the tab that matches the initial profile's cursor kind.
- A live preview: the `cursorImage` for the current design, plus the typed name in a tag colored like the cursor. Stale renders are ignored.
- `[data-action="save"]` builds the profile, validates it with `isValidProfile`, calls `onSave`, then closes. A missing name shows "Enter a name. Others see it next to your cursor." in `.dialog-error`. An empty drawing on the pixels tab is refused with "Your drawing is empty. Draw something or pick a shape." (a fully transparent cursor would be invisible, and the codec would accept it).
- On a first visit (`initial` is `null`) the starting color is random, so a whole class doesn't start with the same color. `random?: () => number` is an optional test seam.
- Closing the panel by any route destroys the pixel editor, which releases its document listeners.

- [ ] **Step 1: Write the failing test**

`web/test/panel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS, SHAPES } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { defaultProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import { cursorImage, shapeSvg } from '../src/cursors/render';
import { openProfilePanel } from '../src/profile/panel';

let saved: Profile[];
const onSave = (p: Profile) => void saved.push(p);

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  saved = [];
});

afterEach(() => {
  // Closing the open modal also releases the pixel editor's document listeners.
  document.querySelector<HTMLElement>('.modal [data-action="close"]')?.click();
  document.body.innerHTML = '';
});

const modal = () => document.querySelector<HTMLElement>('.modal[data-dialog="profile"]');
const q = <T extends HTMLElement = HTMLElement>(selector: string) => modal()!.querySelector<T>(selector)!;
const nameInput = () => q<HTMLInputElement>('input[name="name"]');
const error = () => q('.dialog-error');
const save = () => q('[data-action="save"]').click();

/** Every way a person can dismiss a modal. When the dialog is not closable none of them may work. */
function tryToClose(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  modal()?.querySelector<HTMLElement>('[data-action="close"]')?.click();
}

function typeName(value: string): void {
  nameInput().value = value;
  nameInput().dispatchEvent(new Event('input', { bubbles: true }));
}

function pointerDown(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

/** Markup as the DOM serializes it, so it can be compared with what an element holds. */
function serialized(markup: string): string {
  const scratch = document.createElement('div');
  scratch.innerHTML = markup;
  return scratch.innerHTML;
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('opening', () => {
  it('opens a modal for the profile dialog titled "Your cursor"', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    expect(modal()).not.toBeNull();
    expect(modal()!.textContent).toContain('Your cursor');
  });

  it('cannot be closed while a name is required and there is no valid profile yet', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    tryToClose();
    expect(modal()).not.toBeNull();
  });

  it('cannot be closed when the stored profile is invalid', () => {
    const broken = { name: '', color: COLORS[0], cursor: { kind: 'shape', shape: 'arrow' } } as Profile;
    openProfilePanel({ initial: broken, requireName: true, onSave });
    tryToClose();
    expect(modal()).not.toBeNull();
  });

  it('can be closed when editing an existing profile', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(modal()!.querySelector('[data-action="close"]')).not.toBeNull();
    tryToClose();
    expect(modal()).toBeNull();
    expect(saved).toEqual([]);
  });

  it('can be closed when no name is required', () => {
    openProfilePanel({ initial: null, requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(modal()).toBeNull();
  });

  it('prefills the name and limits it to 24 characters', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(nameInput().value).toBe('Ana');
    expect(nameInput().maxLength).toBe(24);
  });

  it('starts on a random color on a first visit and on your own color when editing', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[0]);
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0.999 });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[11]);
    openProfilePanel({ initial: { ...defaultProfile('Ana'), color: COLORS[4] }, requireName: true, onSave });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[4]);
  });
});

describe('colors, shapes and tabs', () => {
  it('offers the 12 colors as [data-color] swatches', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    const found = [...modal()!.querySelectorAll<HTMLElement>('[data-color]')].map((el) => el.dataset.color);
    expect(found).toEqual([...COLORS]);
  });

  it('selects the clicked color and marks only it', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q(`[data-color="${COLORS[5]}"]`).click();
    expect(modal()!.querySelectorAll('[data-color].is-selected')).toHaveLength(1);
    expect(q(`[data-color="${COLORS[5]}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(q(`[data-color="${COLORS[0]}"]`).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the six shapes drawn in the chosen color', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    const found = [...modal()!.querySelectorAll<HTMLElement>('[data-shape]')].map((el) => el.dataset.shape);
    expect(found).toEqual([...SHAPES]);
    expect(q('[data-shape="star"]').innerHTML).toBe(serialized(shapeSvg('star', COLORS[0])));
    q(`[data-color="${COLORS[3]}"]`).click();
    expect(q('[data-shape="star"]').innerHTML).toBe(serialized(shapeSvg('star', COLORS[3])));
  });

  it('marks the chosen shape', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(q('[data-shape="arrow"]').getAttribute('aria-pressed')).toBe('true');
    q('[data-shape="plane"]').click();
    expect(q('[data-shape="arrow"]').getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-shape="plane"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on the shape tab and switches to the pixel editor', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(q('[data-panel="shape"]').hidden).toBe(false);
    expect(q('[data-panel="pixels"]').hidden).toBe(true);
    q('[data-tab="pixels"]').click();
    expect(q('[data-panel="shape"]').hidden).toBe(true);
    expect(q('[data-panel="pixels"]').hidden).toBe(false);
    expect(q('[data-tab="pixels"]').getAttribute('aria-selected')).toBe('true');
    expect(modal()!.querySelectorAll('.pixel-grid [data-cell]')).toHaveLength(256);
    expect(modal()!.querySelectorAll('[data-tool]')).toHaveLength(4);
  });

  it('opens on the pixels tab when the profile has a drawing', () => {
    const grid = emptyGrid();
    grid[0] = 1;
    const initial: Profile = { name: 'Ben', color: COLORS[1], cursor: { kind: 'pixels', art: encodeArt(grid), tip: [2, 3] } };
    openProfilePanel({ initial, requireName: true, onSave });
    expect(q('[data-panel="pixels"]').hidden).toBe(false);
    save();
    expect(saved).toEqual([initial]);
  });
});

describe('saving', () => {
  it('saves the name, color and chosen shape, then closes', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    typeName('Ana');
    q(`[data-color="${COLORS[3]}"]`).click();
    q('[data-shape="star"]').click();
    save();
    expect(saved).toEqual([{ name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'star' } }]);
    expect(modal()).toBeNull();
  });

  it('saves a cleaned name: control characters removed, spaces collapsed, cut to 24', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName('  Ana \n\t  Lee  ');
    save();
    expect(saved[0]!.name).toBe('Ana Lee');
  });

  it('saves when Enter is pressed in the name field', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName('Ana');
    nameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(saved).toHaveLength(1);
  });

  it.each(['', '   ', ' \n\t '])('shows an inline error and stays open when the name is %j', (value) => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName(value);
    save();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe('Enter a name. Others see it next to your cursor.');
    expect(saved).toEqual([]);
    expect(modal()).not.toBeNull();
  });

  it('hides the error again once the person starts typing', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    save();
    expect(error().hidden).toBe(false);
    typeName('A');
    expect(error().hidden).toBe(true);
  });

  it('saves a pixel drawing with its tip', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    pointerDown(q('.pixel-grid [data-cell="17"]'));
    q('[data-tool="tip"]').click();
    pointerDown(q('.pixel-grid [data-cell="35"]'));
    save();
    expect(saved).toHaveLength(1);
    const cursor = saved[0]!.cursor;
    expect(cursor.kind).toBe('pixels');
    if (cursor.kind !== 'pixels') return;
    expect(cursor.tip).toEqual([3, 2]);
    expect(decodeArt(cursor.art)![17]).toBe(1);
  });

  it('keeps the drawing and saves the new color when the color changes on the pixels tab', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    pointerDown(q('.pixel-grid [data-cell="0"]'));
    q(`[data-color="${COLORS[6]}"]`).click();
    expect(q('[data-palette="1"]').style.background).not.toBe('');
    save();
    expect(saved[0]!.color).toBe(COLORS[6]);
    const cursor = saved[0]!.cursor;
    expect(cursor.kind === 'pixels' && decodeArt(cursor.art)![0]).toBe(1);
  });

  it('refuses an empty drawing, says why, and stays open', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    save();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe('Your drawing is empty. Draw something or pick a shape.');
    expect(saved).toEqual([]);
    expect(modal()).not.toBeNull();
  });

  it('saves a shape after switching back from an empty drawing', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    q('[data-tab="shape"]').click();
    save();
    expect(saved[0]!.cursor).toEqual({ kind: 'shape', shape: 'arrow' });
  });

  it('does not call onSave when it is closed instead', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(saved).toEqual([]);
  });
});

describe('preview', () => {
  const previewSrc = () => q<HTMLImageElement>('.profile-preview-img').getAttribute('src');

  it('shows the cursor image for the current design', async () => {
    openProfilePanel({ initial: { ...defaultProfile('Ana'), color: COLORS[3] }, requireName: true, onSave });
    await settle();
    const expected = await cursorImage({ name: 'x', color: COLORS[3], cursor: { kind: 'shape', shape: 'arrow' } });
    expect(previewSrc()).toBe(expected.url);
  });

  it('follows the color and the shape', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q(`[data-color="${COLORS[7]}"]`).click();
    q('[data-shape="hand"]').click();
    await settle();
    const expected = await cursorImage({ name: 'x', color: COLORS[7], cursor: { kind: 'shape', shape: 'hand' } });
    expect(previewSrc()).toBe(expected.url);
  });

  it('follows the drawing while it is being painted', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    await settle();
    const blank = previewSrc();
    pointerDown(q('.pixel-grid [data-cell="40"]'));
    await settle();
    expect(previewSrc()).not.toBe(blank);
  });

  it('shows the typed name in a tag colored like the cursor', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    expect(q('.profile-preview-tag').textContent).toBe('Your name');
    typeName('  Ana  ');
    expect(q('.profile-preview-tag').textContent).toBe('Ana');
    const probe = document.createElement('i');
    probe.style.background = COLORS[0];
    expect(q('.profile-preview-tag').style.background).toBe(probe.style.background);
  });

  it('stops updating after the panel is closed', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    const img = q<HTMLImageElement>('.profile-preview-img');
    q('[data-action="close"]').click();
    const src = img.getAttribute('src');
    await settle();
    expect(img.getAttribute('src')).toBe(src);
  });
});

describe('cleanup', () => {
  it('releases the pixel editor when the panel closes', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(remove.mock.calls.map((c) => c[0])).toContain('pointerup');
    remove.mockRestore();
  });

  it('closes itself after saving', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    save();
    expect(document.querySelector('.modal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/panel.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/profile/panel" from "test/panel.test.ts". Does the file exist?`

- [ ] **Step 3: Create `panel.css`**

`web/src/profile/panel.css`:

```css
.profile-panel {
  display: grid;
  gap: 14px;
  min-width: min(360px, 100%);
}

.profile-field {
  display: grid;
  gap: 6px;
}

.profile-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.profile-panel input[name='name'] {
  font: inherit;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}

.profile-panel .dialog-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.profile-panel .dialog-error[hidden] {
  display: none;
}

.profile-swatches {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.profile-swatch {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
}

.profile-swatch.is-selected {
  border-color: var(--text);
  outline: 2px solid var(--surface);
  outline-offset: -4px;
}

.profile-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.profile-tab {
  font: inherit;
  padding: 6px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.profile-tab.is-selected {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.profile-tabpanel[hidden] {
  display: none;
}

.profile-shapes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.profile-shape {
  display: grid;
  place-items: center;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
}

.profile-shape svg {
  width: 40px;
  height: 40px;
}

.profile-shape.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.profile-preview {
  display: grid;
  gap: 6px;
}

.profile-preview-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.profile-preview-img {
  width: 32px;
  height: 32px;
}

.profile-preview-tag {
  padding: 2px 8px;
  border-radius: 999px;
  font: 600 12px/1.4 var(--font, system-ui, sans-serif);
}

.profile-actions {
  display: flex;
  justify-content: flex-end;
}

.profile-save {
  font: inherit;
  padding: 6px 16px;
  border: 0;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
```

- [ ] **Step 4: Implement `panel.ts`**

`web/src/profile/panel.ts`:

```ts
import { COLORS, LIMITS, SHAPES } from '@class-board/shared/constants';
import { decodeArt } from '@class-board/shared/pixelArt';
import { cleanText, isValidProfile } from '@class-board/shared/protocol';
import type { CursorDesign, Profile, ShapeName } from '@class-board/shared/types';
import type { ProfilePanelOpts } from '../contracts';
import { cursorImage, shapeSvg, tagTextColor } from '../cursors/render';
import { h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { createPixelEditor } from './pixelEditor';
import './panel.css';

/** Optional test seam on top of the contract's options. */
export interface ProfilePanelSeams extends ProfilePanelOpts {
  /** Picks the starting color on a first visit. Defaults to Math.random. */
  random?: () => number;
}

type Tab = 'shape' | 'pixels';

const PLACEHOLDER_NAME = 'Your name';

export function openProfilePanel(opts: ProfilePanelSeams): void {
  const initial = opts.initial && isValidProfile(opts.initial) ? opts.initial : null;
  const closable = !(opts.requireName && !initial);
  const random = opts.random ?? Math.random;

  let color: string = initial?.color ?? COLORS[Math.floor(random() * COLORS.length)]!;
  let shape: ShapeName = initial?.cursor.kind === 'shape' ? initial.cursor.shape : 'arrow';
  let tab: Tab = initial?.cursor.kind === 'pixels' ? 'pixels' : 'shape';
  let previewSeq = 0;
  let cleanedUp = false;

  const nameInput = h('input', {
    type: 'text',
    name: 'name',
    value: initial?.name ?? '',
    maxLength: LIMITS.nameMax,
    autocomplete: 'off',
    attrs: { 'aria-label': 'Your name', placeholder: PLACEHOLDER_NAME },
    on: {
      input: () => {
        hideError();
        refreshTag();
      },
      keydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') save();
      },
    },
  }) as HTMLInputElement;

  const errorEl = h('p', { class: 'dialog-error', hidden: true, attrs: { role: 'alert' } });

  const swatches = COLORS.map((c, i) =>
    h('button', {
      type: 'button',
      class: 'profile-swatch',
      dataset: { color: c },
      style: { background: c },
      attrs: { 'aria-label': `Color ${i + 1}` },
      on: { click: () => chooseColor(c) },
    }),
  );

  const shapeButtons = SHAPES.map((s) =>
    h('button', {
      type: 'button',
      class: 'profile-shape',
      dataset: { shape: s },
      attrs: { 'aria-label': s },
      on: { click: () => chooseShape(s) },
    }),
  );

  const previewImg = h('img', { class: 'profile-preview-img', attrs: { alt: '', width: '32', height: '32' } });
  const previewTag = h('span', { class: 'profile-preview-tag' });

  const tabButtons = (['shape', 'pixels'] as const).map((t) =>
    h('button', {
      type: 'button',
      class: 'profile-tab',
      dataset: { tab: t },
      attrs: { role: 'tab' },
      on: { click: () => chooseTab(t) },
    }, t === 'shape' ? 'Pointer shapes' : 'Draw your own'),
  );

  const shapePanel = h('div', { class: 'profile-tabpanel', dataset: { panel: 'shape' }, attrs: { role: 'tabpanel' } },
    h('div', { class: 'profile-shapes' }, ...shapeButtons));
  const pixelsRoot = h('div', { class: 'profile-pixels' });
  const pixelsPanel = h('div', { class: 'profile-tabpanel', dataset: { panel: 'pixels' }, attrs: { role: 'tabpanel' } }, pixelsRoot);

  const editor = createPixelEditor(pixelsRoot, {
    color,
    art: initial?.cursor.kind === 'pixels' ? initial.cursor.art : undefined,
    tip: initial?.cursor.kind === 'pixels' ? initial.cursor.tip : undefined,
  });
  editor.onChange(() => {
    hideError();
    void refreshPreview();
  });

  const body = h('div', { class: 'profile-panel' },
    h('label', { class: 'profile-field' }, h('span', { class: 'profile-label' }, 'Name'), nameInput),
    errorEl,
    h('div', { class: 'profile-field' },
      h('span', { class: 'profile-label' }, 'Color'),
      h('div', { class: 'profile-swatches' }, ...swatches)),
    h('div', { class: 'profile-field' },
      h('div', { class: 'profile-tabs', attrs: { role: 'tablist' } }, ...tabButtons),
      shapePanel, pixelsPanel),
    h('div', { class: 'profile-preview' },
      h('span', { class: 'profile-label' }, 'Preview'),
      h('div', { class: 'profile-preview-box' }, previewImg, previewTag)),
    h('div', { class: 'profile-actions' },
      h('button', { type: 'button', class: 'profile-save', dataset: { action: 'save' }, on: { click: () => save() } }, 'Save')));

  const handle = openModal({
    title: 'Your cursor',
    dialog: 'profile',
    body,
    closable,
    onClose: cleanUp,
  });

  function cleanUp(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    previewSeq++;
    editor.destroy();
  }

  function currentCursor(): CursorDesign {
    return tab === 'pixels'
      ? { kind: 'pixels', art: editor.getArt(), tip: editor.getTip() }
      : { kind: 'shape', shape };
  }

  function showError(text: string): void {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function refreshTag(): void {
    previewTag.textContent = cleanText(nameInput.value, LIMITS.nameMax) || PLACEHOLDER_NAME;
    previewTag.style.background = color;
    previewTag.style.color = tagTextColor(color);
  }

  async function refreshPreview(): Promise<void> {
    const seq = ++previewSeq;
    const image = await cursorImage({ name: PLACEHOLDER_NAME, color, cursor: currentCursor() });
    if (seq !== previewSeq) return;
    previewImg.setAttribute('src', image.url);
  }

  function refreshControls(): void {
    for (const swatch of swatches) {
      const on = swatch.dataset.color === color;
      swatch.classList.toggle('is-selected', on);
      swatch.setAttribute('aria-pressed', String(on));
    }
    for (const button of shapeButtons) {
      const on = button.dataset.shape === shape;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
      button.innerHTML = shapeSvg(button.dataset.shape as ShapeName, color);
    }
    for (const button of tabButtons) {
      const on = button.dataset.tab === tab;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-selected', String(on));
    }
    shapePanel.hidden = tab !== 'shape';
    pixelsPanel.hidden = tab !== 'pixels';
    refreshTag();
  }

  function chooseColor(next: string): void {
    color = next;
    editor.setColor(next);
    refreshControls();
    void refreshPreview();
  }

  function chooseShape(next: ShapeName): void {
    shape = next;
    refreshControls();
    void refreshPreview();
  }

  function chooseTab(next: Tab): void {
    tab = next;
    hideError();
    refreshControls();
    void refreshPreview();
  }

  function save(): void {
    const name = cleanText(nameInput.value, LIMITS.nameMax);
    if (!name) {
      showError('Enter a name. Others see it next to your cursor.');
      nameInput.focus();
      return;
    }
    const cursor = currentCursor();
    if (cursor.kind === 'pixels' && decodeArt(cursor.art)?.every((v) => v === 0)) {
      showError('Your drawing is empty. Draw something or pick a shape.');
      return;
    }
    const profile: Profile = { name, color, cursor };
    if (!isValidProfile(profile)) {
      showError("That cursor isn't valid. Check the name and drawing, then try again.");
      return;
    }
    opts.onSave(profile);
    handle.close();
  }

  refreshControls();
  void refreshPreview();
  nameInput.focus();
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- test/panel.test.ts`

Expected: PASS, 32 tests in 1 file.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/profile/panel.ts web/src/profile/panel.css web/test/panel.test.ts
git commit -m "feat(profile): Profile panel (C8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task C9: People panel and teacher panel

**Wave:** 4 · **Tier:** T2 (sonnet, medium) · **Depends on:** U1, F3

**Files:**
- Create: `web/src/people/peoplePanel.ts`
- Create: `web/src/people/people.css`
- Create: `web/src/teacher/teacherPanel.ts`
- Test: `web/test/peoplePanel.test.ts`
- Test: `web/test/teacherPanel.test.ts`

Two UI modules and one stylesheet. `people.css` also styles the teacher dialog, and `teacherPanel.ts` imports it.

**`mountPeoplePanel(deps)`** attaches to the top bar's people button.

- Clicking the button toggles `.people-panel`, a `position: fixed` dropdown appended to `document.body` and placed under the button. Outside pointer presses (captured on the document) and Esc close it, and Esc returns focus to the button.
- People are sorted by name (case-insensitive). Each `.person[data-person]` row has a color swatch, the name (set as text, never as markup), a "you" mark on your own row, and the presence text "On the board", "Using C4", "Viewing C4" or "Away".
- `[data-action="jump"]` on each row calls `onJump(person)` with the latest details and closes the panel. A `[data-action="reset-cursor"]` button is shown only while the teacher session is active and calls `teacher.resetCursor(id)`. A rejection shows a toast.
- The footer `[data-action="teacher"]` reads "Teacher", or "Teacher tools" once signed in, and calls `onTeacher` after closing the panel.
- It re-renders on `'people'`, `'snapshot'` and teacher changes, reusing row elements by person id, so a click in progress isn't lost to a rebuild.

**`openTeacherPanel(teacher, state)`** opens `openModal({ dialog: 'teacher' })`.

- Signed out: `input[name="code"]` (a password field) and `[data-action="login"]`. Enter also signs in. Errors go in `.dialog-error`: "That passcode isn't right.", "Too many tries. Wait 10 minutes and try again.", "Enter the passcode." for an empty field, `errorText(code)` for other server rejections, and a "Couldn't reach the board…" line for failures without a code.
- Signed in: `[data-action="lock"]` or `[data-action="unlock"]` matching `state.locked()`, which swaps when the server's `'locked'` message arrives, and `[data-action="logout"]`, which signs out and closes.
- If the session ends while the dialog is open (a `bad_code` rejection), it goes back to the passcode form. Its listeners are removed when the dialog closes.

- [ ] **Step 1: Write the failing people panel test**

`web/test/peoplePanel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import type { Person, Presence } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, TeacherApi } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { mountPeoplePanel } from '../src/people/peoplePanel';

function person(id: string, name: string, presence: Presence = { at: 'board' }, color: string = COLORS[3]): Person {
  return { id, clientId: `client-${id}`, profile: { name, color, cursor: { kind: 'shape', shape: 'arrow' } }, presence };
}

function fakeState(initial: Person[], you: string | null = 'me') {
  let people = initial;
  const listeners = new Map<keyof BoardStateEvents, Set<() => void>>();
  const state = {
    you: () => you,
    people: () => people,
    on(event: keyof BoardStateEvents, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => void listeners.get(event)!.delete(fn);
    },
  } as unknown as BoardStateApi;
  return {
    state,
    set(next: Person[], event: keyof BoardStateEvents = 'people') {
      people = next;
      for (const fn of [...(listeners.get(event) ?? [])]) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

function fakeTeacher(active = false) {
  let on = active;
  const listeners = new Set<(a: boolean) => void>();
  const teacher: TeacherApi = {
    active: () => on,
    login: vi.fn(),
    logout: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
    clear: vi.fn(),
    resetCursor: vi.fn(async () => {}),
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return {
    teacher,
    setActive(next: boolean) {
      on = next;
      for (const fn of [...listeners]) fn(on);
    },
    listenerCount: () => listeners.size,
  };
}

let button: HTMLButtonElement;
let onJump: Mock<(person: Person) => void>;
let onTeacher: Mock<() => void>;

beforeEach(() => {
  document.body.innerHTML = '<div id="banner"></div>';
  button = document.createElement('button');
  button.dataset.action = 'people';
  document.body.prepend(button);
  onJump = vi.fn<(person: Person) => void>();
  onTeacher = vi.fn<() => void>();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(people: Person[], opts: { teacherActive?: boolean; you?: string | null } = {}) {
  const s = fakeState(people, opts.you === undefined ? 'me' : opts.you);
  const t = fakeTeacher(opts.teacherActive);
  const panel = mountPeoplePanel({ button, state: s.state, teacher: t.teacher, onJump, onTeacher });
  return { s, t, panel };
}

const panelEl = () => document.querySelector<HTMLElement>('.people-panel');
const rowEl = (id: string) => document.querySelector<HTMLElement>(`.people-panel .person[data-person="${id}"]`);
const names = () => [...document.querySelectorAll('.people-panel .person-name')].map((el) => el.textContent);
const open = () => button.click();

describe('opening and closing', () => {
  it('is closed until the button is clicked, then toggles', () => {
    mount([person('me', 'Me')]);
    expect(panelEl()).toBeNull();
    open();
    expect(panelEl()).not.toBeNull();
    open();
    expect(panelEl()).toBeNull();
  });

  it('marks the button expanded while open', () => {
    mount([person('me', 'Me')]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a pointer press outside, but not inside the panel or on the button', () => {
    mount([person('me', 'Me')]);
    open();
    panelEl()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).not.toBeNull();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).toBeNull();
  });

  it('closes on Escape and gives the focus back to the button', () => {
    mount([person('me', 'Me')]);
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panelEl()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('ignores other keys', () => {
    mount([person('me', 'Me')]);
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(panelEl()).not.toBeNull();
  });

  it('is anchored under the button', () => {
    mount([person('me', 'Me')]);
    button.getBoundingClientRect = () => ({ bottom: 50, right: 900, top: 10, left: 800, width: 100, height: 40, x: 800, y: 10, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    open();
    expect(panelEl()!.style.top).toBe('56px');
    expect(panelEl()!.style.right).toBe('100px');
  });
});

describe('the list', () => {
  it('shows how many people are here', () => {
    mount([person('me', 'Me'), person('a', 'Ana')]);
    open();
    expect(panelEl()!.querySelector('.people-head')!.textContent).toBe('2 here');
  });

  it('sorts people by name, ignoring case', () => {
    mount([person('1', 'zoe'), person('2', 'Ben'), person('3', 'ana'), person('me', 'Cy')]);
    open();
    expect(names()).toEqual(['ana', 'Ben', 'Cy', 'zoe']);
  });

  it('gives each person a row with their color, name and presence', () => {
    mount([person('a', 'Ana', { at: 'board' }, '#EF9F27')]);
    open();
    const row = rowEl('a')!;
    expect(row.querySelector('.person-name')!.textContent).toBe('Ana');
    expect(row.querySelector('.person-presence')!.textContent).toBe('On the board');
    const probe = document.createElement('i');
    probe.style.background = '#EF9F27';
    expect(row.querySelector<HTMLElement>('.person-swatch')!.style.background).toBe(probe.style.background);
  });

  it.each<[Presence, string]>([
    [{ at: 'board' }, 'On the board'],
    [{ at: 'tile', slot: 23, mode: 'using' }, 'Using C4'],
    [{ at: 'tile', slot: 79, mode: 'viewing' }, 'Viewing H10'],
    [{ at: 'away' }, 'Away'],
  ])('describes %j as "%s"', (presence, text) => {
    mount([person('a', 'Ana', presence)]);
    open();
    expect(rowEl('a')!.querySelector('.person-presence')!.textContent).toBe(text);
  });

  it('marks your own row', () => {
    mount([person('me', 'Me'), person('a', 'Ana')]);
    open();
    expect(rowEl('me')!.querySelector<HTMLElement>('.person-you')!.hidden).toBe(false);
    expect(rowEl('a')!.querySelector<HTMLElement>('.person-you')!.hidden).toBe(true);
  });

  it('puts names in as text, never as markup', () => {
    mount([person('a', '<img src=x onerror=alert(1)>')]);
    open();
    expect(panelEl()!.querySelector('img')).toBeNull();
    expect(names()).toEqual(['<img src=x onerror=alert(1)>']);
  });
});

describe('staying up to date while open', () => {
  it('adds, removes and updates rows when the people change', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    s.set([person('a', 'Ana', { at: 'away' }), person('b', 'Ben')]);
    expect(names()).toEqual(['Ana', 'Ben']);
    expect(rowEl('a')!.querySelector('.person-presence')!.textContent).toBe('Away');
    s.set([person('b', 'Ben')]);
    expect(rowEl('a')).toBeNull();
    expect(panelEl()!.querySelector('.people-head')!.textContent).toBe('1 here');
  });

  it('also refreshes on a new snapshot', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    s.set([person('a', 'Ana'), person('b', 'Ben')], 'snapshot');
    expect(names()).toEqual(['Ana', 'Ben']);
  });

  it('keeps the same row element when only its details change, so a click in progress is not lost', () => {
    const { s } = mount([person('a', 'Ana'), person('b', 'Ben')]);
    open();
    const before = rowEl('a');
    s.set([person('a', 'Ana', { at: 'tile', slot: 1, mode: 'using' }), person('b', 'Ben')]);
    expect(rowEl('a')).toBe(before);
  });

  it('reorders rows when a name changes', () => {
    const { s } = mount([person('a', 'Ana'), person('b', 'Ben')]);
    open();
    s.set([person('a', 'Zed'), person('b', 'Ben')]);
    expect(names()).toEqual(['Ben', 'Zed']);
  });

  it('stops listening once closed', () => {
    const { s, t } = mount([person('a', 'Ana')]);
    open();
    open();
    expect(s.listenerCount()).toBe(0);
    expect(t.listenerCount()).toBe(0);
  });
});

describe('jumping', () => {
  it('calls onJump with the person and closes the panel', () => {
    const ana = person('a', 'Ana', { at: 'tile', slot: 23, mode: 'using' });
    mount([ana, person('me', 'Me')]);
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="jump"]')!.click();
    expect(onJump).toHaveBeenCalledWith(ana);
    expect(panelEl()).toBeNull();
  });

  it('passes the latest details of the person after an update', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    const moved = person('a', 'Ana', { at: 'tile', slot: 5, mode: 'viewing' });
    s.set([moved]);
    rowEl('a')!.querySelector<HTMLElement>('[data-action="jump"]')!.click();
    expect(onJump).toHaveBeenCalledWith(moved);
  });
});

describe('teacher features', () => {
  it('hides Reset cursor from students', () => {
    mount([person('a', 'Ana')]);
    open();
    expect(rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden).toBe(true);
  });

  it('shows Reset cursor on every row for the teacher', () => {
    mount([person('a', 'Ana'), person('me', 'Me')], { teacherActive: true });
    open();
    for (const id of ['a', 'me']) {
      expect(rowEl(id)!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden).toBe(false);
    }
  });

  it('asks the teacher session to reset that person', () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    expect(t.teacher.resetCursor).toHaveBeenCalledWith('a');
    expect(panelEl()).not.toBeNull();
  });

  it('shows a toast when the reset is rejected', async () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    vi.mocked(t.teacher.resetCursor).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'not_found' }));
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('#banner [data-banner="toast"]')!.textContent).toBe(errorText('not_found'));
  });

  it('shows a general toast when the reset fails without a server code', async () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    vi.mocked(t.teacher.resetCursor).mockRejectedValueOnce(new Error('offline'));
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('#banner [data-banner="toast"]')!.textContent).toContain("Couldn't reset that cursor");
  });

  it('shows or hides Reset cursor as the teacher signs in or out while the panel is open', () => {
    const { t } = mount([person('a', 'Ana')]);
    open();
    const reset = () => rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden;
    expect(reset()).toBe(true);
    t.setActive(true);
    expect(reset()).toBe(false);
    t.setActive(false);
    expect(reset()).toBe(true);
  });

  it('has a footer link that says Teacher, then Teacher tools once signed in', () => {
    const { t } = mount([person('a', 'Ana')]);
    open();
    const footer = () => panelEl()!.querySelector('[data-action="teacher"]')!.textContent;
    expect(footer()).toBe('Teacher');
    t.setActive(true);
    expect(footer()).toBe('Teacher tools');
  });

  it('calls onTeacher and closes when the footer link is clicked', () => {
    mount([person('a', 'Ana')]);
    open();
    panelEl()!.querySelector<HTMLElement>('[data-action="teacher"]')!.click();
    expect(onTeacher).toHaveBeenCalledTimes(1);
    expect(panelEl()).toBeNull();
  });
});

describe('destroy', () => {
  it('removes the panel and stops responding to the button', () => {
    const { panel } = mount([person('a', 'Ana')]);
    open();
    panel.destroy();
    expect(panelEl()).toBeNull();
    open();
    expect(panelEl()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- test/peoplePanel.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/people/peoplePanel" from "test/peoplePanel.test.ts". Does the file exist?`

- [ ] **Step 3: Create `people.css`**

`web/src/people/people.css`:

```css
.people-panel {
  position: fixed;
  z-index: var(--z-banner, 25);
  width: min(320px, calc(100vw - 16px));
  max-height: min(70vh, 560px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-family: var(--font, system-ui, sans-serif);
}

.people-head {
  padding: 10px 12px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.people-list {
  margin: 0;
  padding: 0 4px;
  list-style: none;
  overflow-y: auto;
}

.person {
  display: flex;
  align-items: center;
  gap: 4px;
}

.person-jump {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  grid-template-areas:
    'swatch name you'
    'swatch presence presence';
  column-gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.person-jump:hover {
  background: rgba(127, 127, 127, 0.12);
}

.person-swatch {
  grid-area: swatch;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}

.person-name {
  grid-area: name;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.person-you {
  grid-area: you;
  font-size: 11px;
  color: var(--text-muted);
}

.person-you[hidden],
.person-reset[hidden] {
  display: none;
}

.person-presence {
  grid-area: presence;
  font-size: 12px;
  color: var(--text-muted);
}

.person-reset {
  flex: none;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.people-foot {
  padding: 6px 12px 10px;
  border-top: 1px solid var(--border);
  margin-top: 6px;
}

.people-teacher {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.teacher-panel {
  display: grid;
  gap: 12px;
  min-width: min(320px, 100%);
}

.teacher-panel input[name='code'] {
  font: inherit;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}

.teacher-panel .profile-field {
  display: grid;
  gap: 6px;
}

.teacher-panel .profile-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.teacher-help {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

.teacher-panel .dialog-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.teacher-panel .dialog-error[hidden] {
  display: none;
}

.teacher-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.teacher-actions button {
  font: inherit;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.teacher-actions .teacher-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.teacher-actions button:disabled {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 4: Implement `peoplePanel.ts`**

`web/src/people/peoplePanel.ts`:

```ts
import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, Person, Presence } from '@class-board/shared/types';
import type { PeoplePanelDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { errorText, toast } from '../ui/errors';
import './people.css';

export function presenceText(presence: Presence): string {
  if (presence.at === 'away') return 'Away';
  if (presence.at === 'tile') return `${presence.mode === 'using' ? 'Using' : 'Viewing'} ${slotName(presence.slot)}`;
  return 'On the board';
}

interface Row {
  el: HTMLElement;
  swatch: HTMLElement;
  name: HTMLElement;
  you: HTMLElement;
  presence: HTMLElement;
  jump: HTMLElement;
  reset: HTMLElement;
  person: Person;
}

function byName(a: Person, b: Person): number {
  return a.profile.name.localeCompare(b.profile.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

export function mountPeoplePanel(deps: PeoplePanelDeps): { destroy(): void } {
  const { button, state, teacher } = deps;
  const doc = button.ownerDocument;
  const rows = new Map<string, Row>();
  let panel: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let teacherButton: HTMLElement | null = null;
  let subscriptions: Unsubscribe[] = [];

  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  function makeRow(person: Person): Row {
    const swatch = h('span', { class: 'person-swatch', attrs: { 'aria-hidden': 'true' } });
    const name = h('span', { class: 'person-name' });
    const you = h('span', { class: 'person-you', hidden: true }, 'you');
    const presence = h('span', { class: 'person-presence' });
    const jump = h('button', {
      type: 'button',
      class: 'person-jump',
      dataset: { action: 'jump' },
      on: { click: () => { close(); deps.onJump(row.person); } },
    }, swatch, name, you, presence);
    const reset = h('button', {
      type: 'button',
      class: 'person-reset',
      dataset: { action: 'reset-cursor' },
      on: { click: () => resetCursor(row.person) },
    }, 'Reset cursor');
    const el = h('li', { class: 'person', dataset: { person: person.id } }, jump, reset);
    const row: Row = { el, swatch, name, you, presence, jump, reset, person };
    return row;
  }

  function resetCursor(person: Person): void {
    teacher.resetCursor(person.id).catch((err: unknown) => {
      const code = (err as { code?: ErrorCode }).code;
      toast(code ? errorText(code) : "Couldn't reset that cursor. Check your connection and try again.");
    });
  }

  function fill(row: Row, person: Person, isYou: boolean, isTeacher: boolean): void {
    row.person = person;
    row.el.dataset.person = person.id;
    row.swatch.style.background = person.profile.color;
    row.name.textContent = person.profile.name;
    row.you.hidden = !isYou;
    row.presence.textContent = presenceText(person.presence);
    row.jump.setAttribute('aria-label', `${person.profile.name}, ${presenceText(person.presence)}. Go to them.`);
    row.reset.hidden = !isTeacher;
    row.reset.setAttribute('aria-label', `Reset ${person.profile.name}'s cursor`);
  }

  function render(): void {
    if (!panel || !list || !heading || !teacherButton) return;
    const people = [...state.people()].sort(byName);
    const you = state.you();
    const isTeacher = teacher.active();

    heading.textContent = `${people.length} here`;
    teacherButton.textContent = isTeacher ? 'Teacher tools' : 'Teacher';

    const wanted = new Set(people.map((p) => p.id));
    for (const [id, row] of rows) {
      if (wanted.has(id)) continue;
      row.el.remove();
      rows.delete(id);
    }
    const ordered: HTMLElement[] = [];
    for (const person of people) {
      let row = rows.get(person.id);
      if (!row) {
        row = makeRow(person);
        rows.set(person.id, row);
      }
      fill(row, person, person.id === you, isTeacher);
      ordered.push(row.el);
    }
    const inPlace = ordered.length === list.children.length && ordered.every((el, i) => list!.children[i] === el);
    if (!inPlace) list.append(...ordered);
  }

  function place(): void {
    if (!panel) return;
    const rect = button.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.right = `${Math.max(8, Math.round((doc.defaultView?.innerWidth ?? rect.right) - rect.right))}px`;
  }

  function onOutsidePointer(e: Event): void {
    const target = e.target as Node | null;
    if (target && (panel?.contains(target) || button.contains(target))) return;
    close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    close();
    button.focus();
  }

  function open(): void {
    if (panel) return;
    heading = h('div', { class: 'people-head' });
    list = h('ul', { class: 'people-list' });
    teacherButton = h('button', {
      type: 'button',
      class: 'people-teacher',
      dataset: { action: 'teacher' },
      on: { click: () => { close(); deps.onTeacher(); } },
    });
    panel = h('div', { class: 'people-panel', attrs: { role: 'dialog', 'aria-label': 'People' } },
      heading, list, h('div', { class: 'people-foot' }, teacherButton));
    doc.body.append(panel);
    button.setAttribute('aria-expanded', 'true');
    render();
    place();
    subscriptions = [
      state.on('people', render),
      state.on('snapshot', render),
      teacher.onChange(render),
    ];
    doc.addEventListener('pointerdown', onOutsidePointer, true);
    doc.addEventListener('keydown', onKey);
    doc.defaultView?.addEventListener('resize', place);
  }

  function close(): void {
    if (!panel) return;
    for (const off of subscriptions) off();
    subscriptions = [];
    doc.removeEventListener('pointerdown', onOutsidePointer, true);
    doc.removeEventListener('keydown', onKey);
    doc.defaultView?.removeEventListener('resize', place);
    panel.remove();
    panel = list = heading = teacherButton = null;
    rows.clear();
    button.setAttribute('aria-expanded', 'false');
  }

  function toggle(): void {
    if (panel) close();
    else open();
  }

  button.addEventListener('click', toggle);

  return {
    destroy() {
      close();
      button.removeEventListener('click', toggle);
    },
  };
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npm test -w web -- test/peoplePanel.test.ts`

Expected: PASS, 31 tests in 1 file.

- [ ] **Step 6: Write the failing teacher panel test**

`web/test/teacherPanel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorText } from '../src/ui/errors';
import type { BoardStateApi, BoardStateEvents, TeacherApi, TeacherLogin } from '../src/contracts';
import { openTeacherPanel } from '../src/teacher/teacherPanel';

function fakeState(locked = false) {
  let isLocked = locked;
  const listeners = new Set<(locked: boolean) => void>();
  const state = {
    locked: () => isLocked,
    on(event: keyof BoardStateEvents, fn: (locked: boolean) => void) {
      if (event !== 'locked') return () => {};
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } as unknown as BoardStateApi;
  return {
    state,
    setLocked(next: boolean) {
      isLocked = next;
      for (const fn of [...listeners]) fn(isLocked);
    },
    listenerCount: () => listeners.size,
  };
}

function serverError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeTeacher(opts: { active?: boolean; login?: (code: string) => Promise<TeacherLogin> } = {}) {
  let on = opts.active ?? false;
  const listeners = new Set<(a: boolean) => void>();
  const setActive = (next: boolean) => {
    if (on === next) return;
    on = next;
    for (const fn of [...listeners]) fn(on);
  };
  const teacher: TeacherApi = {
    active: () => on,
    login: vi.fn(async (code: string) => {
      const result = await (opts.login ?? (async () => 'ok' as const))(code);
      if (result === 'ok') setActive(true);
      return result;
    }),
    logout: vi.fn(() => setActive(false)),
    lock: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    resetCursor: vi.fn(async () => {}),
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return { teacher, setActive, listenerCount: () => listeners.size };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});

afterEach(() => {
  document.querySelector<HTMLElement>('.modal [data-action="close"]')?.click();
  document.body.innerHTML = '';
});

const modal = () => document.querySelector<HTMLElement>('.modal[data-dialog="teacher"]');
const q = <T extends HTMLElement = HTMLElement>(selector: string) => modal()!.querySelector<T>(selector)!;
const has = (selector: string) => modal()!.querySelector(selector) !== null;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function enter(code: string): void {
  const input = q<HTMLInputElement>('input[name="code"]');
  input.value = code;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('signed out', () => {
  it('opens the teacher dialog with a passcode field and a sign-in button', () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    expect(modal()).not.toBeNull();
    expect(q<HTMLInputElement>('input[name="code"]').type).toBe('password');
    expect(has('[data-action="login"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
    expect(q('.dialog-error').hidden).toBe(true);
  });

  it('can be closed with the close button', () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    q('[data-action="close"]').click();
    expect(modal()).toBeNull();
  });

  it('sends the typed passcode', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    enter('letmein');
    q('[data-action="login"]').click();
    await flush();
    expect(t.teacher.login).toHaveBeenCalledWith('letmein');
  });

  it('signs in on Enter', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    enter('letmein');
    q('input[name="code"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(t.teacher.login).toHaveBeenCalledTimes(1);
  });

  it('asks for a passcode when the field is empty, without contacting the server', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe('Enter the passcode.');
    expect(t.teacher.login).not.toHaveBeenCalled();
  });

  it('says the passcode is wrong on bad', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'bad' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe("That passcode isn't right.");
    expect(has('input[name="code"]')).toBe(true);
  });

  it('says to wait when locked out', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'locked_out' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe('Too many tries. Wait 10 minutes and try again.');
  });

  it('hides the error again when the person types', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'bad' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    enter('nop');
    expect(q('.dialog-error').hidden).toBe(true);
  });

  it('shows the server message when sign-in is rejected for another reason', async () => {
    const login = async (): Promise<TeacherLogin> => {
      throw serverError('rate_limited');
    };
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe(errorText('rate_limited'));
  });

  it('says it could not reach the board when sign-in fails without a server code', async () => {
    const login = async (): Promise<TeacherLogin> => {
      throw new Error('offline');
    };
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe("Couldn't reach the board. Check your connection and try again.");
  });

  it('disables the button while the passcode is being checked', async () => {
    let finish!: (r: TeacherLogin) => void;
    const login = () => new Promise<TeacherLogin>((resolve) => (finish = resolve));
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    const button = q<HTMLButtonElement>('[data-action="login"]');
    button.click();
    expect(button.disabled).toBe(true);
    finish('bad');
    await flush();
    expect(button.disabled).toBe(false);
  });
});

describe('signed in', () => {
  it('shows Lock and Sign out on an open board', () => {
    openTeacherPanel(fakeTeacher({ active: true }).teacher, fakeState(false).state);
    expect(has('[data-action="lock"]')).toBe(true);
    expect(has('[data-action="unlock"]')).toBe(false);
    expect(has('[data-action="logout"]')).toBe(true);
    expect(has('input[name="code"]')).toBe(false);
  });

  it('shows Unlock on a locked board', () => {
    openTeacherPanel(fakeTeacher({ active: true }).teacher, fakeState(true).state);
    expect(has('[data-action="unlock"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
  });

  it('switches to the signed-in view after a successful sign-in, without closing', async () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    enter('letmein');
    q('[data-action="login"]').click();
    await flush();
    expect(modal()).not.toBeNull();
    expect(has('[data-action="lock"]')).toBe(true);
    expect(has('input[name="code"]')).toBe(false);
  });

  it('locks the board', async () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState(false).state);
    q('[data-action="lock"]').click();
    await flush();
    expect(t.teacher.lock).toHaveBeenCalledTimes(1);
    expect(t.teacher.unlock).not.toHaveBeenCalled();
  });

  it('unlocks the board', async () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState(true).state);
    q('[data-action="unlock"]').click();
    await flush();
    expect(t.teacher.unlock).toHaveBeenCalledTimes(1);
  });

  it('swaps Lock for Unlock when the server says the board is now locked', async () => {
    const s = fakeState(false);
    openTeacherPanel(fakeTeacher({ active: true }).teacher, s.state);
    s.setLocked(true);
    expect(has('[data-action="unlock"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
    s.setLocked(false);
    expect(has('[data-action="lock"]')).toBe(true);
  });

  it('shows the reason when locking is rejected', async () => {
    const t = fakeTeacher({ active: true });
    vi.mocked(t.teacher.lock).mockRejectedValueOnce(serverError('rate_limited'));
    openTeacherPanel(t.teacher, fakeState(false).state);
    const button = q<HTMLButtonElement>('[data-action="lock"]');
    button.click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe(errorText('rate_limited'));
    expect(button.disabled).toBe(false);
  });

  it('signs out and closes', () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState().state);
    q('[data-action="logout"]').click();
    expect(t.teacher.logout).toHaveBeenCalledTimes(1);
    expect(t.teacher.active()).toBe(false);
    expect(modal()).toBeNull();
  });

  it('goes back to the passcode form if the session ends while it is open', () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState().state);
    t.setActive(false);
    expect(has('input[name="code"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
  });
});

describe('cleanup', () => {
  it('stops listening to the board and the teacher session when closed', () => {
    const s = fakeState();
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, s.state);
    expect(s.listenerCount()).toBe(1);
    expect(t.listenerCount()).toBe(1);
    q('[data-action="close"]').click();
    expect(s.listenerCount()).toBe(0);
    expect(t.listenerCount()).toBe(0);
  });

  it('does not redraw a closed dialog when a late sign-in answer arrives', async () => {
    let finish!: (r: TeacherLogin) => void;
    const t = fakeTeacher({ login: () => new Promise<TeacherLogin>((resolve) => (finish = resolve)) });
    openTeacherPanel(t.teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    q('[data-action="close"]').click();
    finish('bad');
    await flush();
    expect(modal()).toBeNull();
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npm test -w web -- test/teacherPanel.test.ts`

Expected: FAIL. The suite doesn't load: `Failed to resolve import "../src/teacher/teacherPanel" from "test/teacherPanel.test.ts". Does the file exist?`

- [ ] **Step 8: Implement `teacherPanel.ts`**

`web/src/teacher/teacherPanel.ts`:

```ts
import type { ErrorCode } from '@class-board/shared/types';
import type { BoardStateApi, TeacherApi, Unsubscribe } from '../contracts';
import '../people/people.css';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';

const MESSAGES = {
  bad: "That passcode isn't right.",
  locked_out: 'Too many tries. Wait 10 minutes and try again.',
  empty: 'Enter the passcode.',
  network: "Couldn't reach the board. Check your connection and try again.",
} as const;

function failureText(err: unknown): string {
  const code = (err as { code?: ErrorCode }).code;
  return code ? errorText(code) : MESSAGES.network;
}

export function openTeacherPanel(teacher: TeacherApi, state: BoardStateApi): void {
  const body = h('div', { class: 'teacher-panel' });
  let subscriptions: Unsubscribe[] = [];
  let closed = false;

  const handle = openModal({
    title: 'Teacher',
    dialog: 'teacher',
    body,
    onClose: () => {
      closed = true;
      for (const off of subscriptions) off();
      subscriptions = [];
    },
  });

  function errorEl(): HTMLElement {
    return h('p', { class: 'dialog-error', hidden: true, attrs: { role: 'alert' } });
  }

  function show(error: HTMLElement, text: string): void {
    error.textContent = text;
    error.hidden = false;
  }

  function renderLogin(): void {
    const error = errorEl();
    const input = h('input', {
      type: 'password',
      name: 'code',
      autocomplete: 'off',
      attrs: { 'aria-label': 'Teacher passcode' },
      on: {
        input: () => { error.hidden = true; },
        keydown: (e) => { if ((e as KeyboardEvent).key === 'Enter') void submit(); },
      },
    }) as HTMLInputElement;
    const login = h('button', { type: 'button', class: 'teacher-primary', dataset: { action: 'login' }, on: { click: () => void submit() } }, 'Sign in') as HTMLButtonElement;

    async function submit(): Promise<void> {
      const code = input.value;
      if (!code) {
        show(error, MESSAGES.empty);
        return;
      }
      login.disabled = true;
      try {
        const result = await teacher.login(code);
        if (closed) return;
        if (result === 'ok') {
          render();
          return;
        }
        show(error, MESSAGES[result]);
        input.select();
      } catch (err) {
        if (!closed) show(error, failureText(err));
      } finally {
        login.disabled = false;
      }
    }

    body.replaceChildren(
      h('p', { class: 'teacher-help' }, 'Enter the teacher passcode to lock the board, clear tiles and reset cursors.'),
      h('label', { class: 'profile-field' }, h('span', { class: 'profile-label' }, 'Passcode'), input),
      error,
      h('div', { class: 'teacher-actions' }, login),
    );
    input.focus();
  }

  function renderActive(): void {
    const error = errorEl();
    const locked = state.locked();
    const toggle = h('button', {
      type: 'button',
      class: 'teacher-primary',
      dataset: { action: locked ? 'unlock' : 'lock' },
      on: {
        click: async () => {
          toggle.disabled = true;
          try {
            await (locked ? teacher.unlock() : teacher.lock());
          } catch (err) {
            if (!closed) show(error, failureText(err));
          } finally {
            toggle.disabled = false;
          }
        },
      },
    }, locked ? 'Unlock board' : 'Lock board') as HTMLButtonElement;
    const logout = h('button', {
      type: 'button',
      dataset: { action: 'logout' },
      on: { click: () => { teacher.logout(); handle.close(); } },
    }, 'Sign out');

    body.replaceChildren(
      h('p', { class: 'teacher-help' }, locked
        ? 'The board is locked. Students can look but not post, replace or rename.'
        : 'The board is open. Students can post, replace and rename tiles.'),
      error,
      h('div', { class: 'teacher-actions' }, toggle, logout),
    );
  }

  function render(): void {
    if (teacher.active()) renderActive();
    else renderLogin();
  }

  subscriptions = [state.on('locked', () => { if (teacher.active()) renderActive(); }), teacher.onChange(render)];
  render();
}
```

- [ ] **Step 9: Run it and confirm it passes**

Run: `npm test -w web -- test/teacherPanel.test.ts`

Expected: PASS, 22 tests in 1 file.

- [ ] **Step 10: Commit (orchestrator)**

```bash
git add web/src/people/peoplePanel.ts web/src/people/people.css web/src/teacher/teacherPanel.ts web/test/peoplePanel.test.ts web/test/teacherPanel.test.ts
git commit -m "feat(people): People panel and teacher panel (C9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
