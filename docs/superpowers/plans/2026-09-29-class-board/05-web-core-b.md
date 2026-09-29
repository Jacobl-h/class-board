# Web core B: input, page shell and grid, main.ts wiring

These tasks build the board's page and the code that joins the web modules together. U5 turns pointer, wheel, touch and keyboard input on `#viewport` into camera moves and the `InputHandlers` calls (tap, double-tap, zoom blocked, board pointer). U6 writes `web/index.html` (the exact structure of master plan §5.1), `base.css` (the only file that defines CSS variables) and the Grid: 80 tiles with their labels, cards, hover buttons, rename flow and state classes. U8 is a first `main.ts` that shows the board, pans, zooms and renames with a Guest profile, so the board can be tried by the end of wave 4. U9 replaces it with the complete wiring of master plan §5.6, once every module exists.

**Third-party APIs used** (checked on 2026-09-29, by running every test and build below in a scratch copy with the versions F1 pins):

- **happy-dom 20.14.5** (web test environment), https://github.com/capricorn86/happy-dom/wiki. Confirmed by experiment:
  - `new PointerEvent(type, { pointerId, pointerType, clientX, clientY, button, buttons, bubbles, cancelable })` sets every field, so no `MouseEvent` fallback is needed.
  - `WheelEvent` extends `UIEvent`: `deltaY` and `deltaMode` come from the init dict, but `clientX`, `clientY` and `ctrlKey` do **not** (they read `undefined`). The input tests patch them on with `Object.defineProperty`.
  - `KeyboardEvent`, `MouseEvent('dblclick')`, `FocusEvent('blur')`, `element.focus()`/`select()` and `document.activeElement` behave as in browsers for these tests. `Element.setPointerCapture` exists and doesn't throw; `input.ts` still wraps it in try/catch because browsers throw for a pointer that's gone.
- **Vitest 4.1.11** (https://vitest.dev/config/): `npm test -w web -- <name>` runs one file. A module's `import './grid.css'` needs nothing in tests (CSS isn't processed by default). A missing module fails the suite with `Error: Failed to resolve import "../src/board/grid" from "test/grid.test.ts". Does the file exist?`.
- **Vite 8.3.1** (https://vite.dev/guide/build): `vite build` bundles `index.html` → `/src/main.ts`, including an inline `data:image/svg+xml` favicon, which it leaves untouched. With no `src/main.ts` the build fails with `Failed to resolve /src/main.ts from …/web/index.html`. `import.meta.env.DEV` is typed by `vite/client` (already in `web/tsconfig.json`).
- **TypeScript** 7.0.2 per F1. The code was checked with `tsc --noEmit` in strict mode; it uses no syntax newer than ES2022.
- **Browser APIs** (MDN): Pointer Events with `setPointerCapture`, `WheelEvent.deltaMode` (0 pixels, 1 lines, 2 pages), `wheel` listeners registered with `{ passive: false }` so `preventDefault()` stops page zoom and scroll, `ResizeObserver`, and `window.open(url, '_blank', 'noopener,noreferrer')`.

Notes for executors:

- `input.ts` and `grid.ts` import only `web/src/contracts.ts`, the U1 helpers and `@class-board/shared/*`. Only `main.ts` imports concrete modules.
- Grid owns the `is-empty`, `is-link`, `is-html`, `is-checking` and `is-blocked` classes and the content of `.tile-card`, the label and `.tile-actions`. It never touches `.tile-frame` (LiveFrames), the `popover` attribute of `.tile-body`, or the `hidden` state of `.focus-back` after creating it (Focus). A re-render only toggles its own classes, so `is-live`, `is-active` and `is-focus` survive.
- `base.css` makes `[hidden]` always win (`display: none !important`), because the grid, the cursors and the e2e locked-board check (`[data-action="add"]:visible` must be 0) all rely on the `hidden` property.

---

### Task U5: Input (pan, zoom, tap, keys, touch)

**Wave:** 3 · **Tier:** T3 (opus, medium) · **Depends on:** F1, F2

**Files:**
- Create: `web/src/board/input.ts`
- Test: `web/test/input.test.ts`

What it does:
- A mouse or single-finger press that moves more than 4 px pans the camera by the movement (`camera.panBy`); one that doesn't is a tap, reported as `handlers.tap(slot)` with the slot from `closest('.tile')?.dataset.slot`, or `null` on the background. Pointer capture starts only once a drag starts, so a click keeps its real target.
- Presses and double-clicks that start inside `[data-action]`, `input`, `textarea`, `select` or `.modal` are ignored. The wheel is ignored only over text fields and modals, so it still zooms over tile buttons.
- Wheel: `preventDefault()`, lines × 16 and pages × viewport height, `factor = exp(-deltaY × 0.0015)`, or `× 0.01` with ctrl (trackpad pinch). A clamped zoom-in calls `handlers.zoomBlocked(slot)`.
- `pointermove` with no buttons down reports `handlers.boardPointer(bx, by)` in board units (also over tile buttons). `pointerleave` reports `pointerLeft()`.
- Touch: two pointers pinch. Each move pans by the midpoint's movement, then zooms around the new midpoint by the distance ratio. When one finger lifts, the other keeps panning and never taps.
- Keys on `document` (not while typing, not with ctrl/meta/alt, not while a `.modal` exists): `+`/`=` zoom ×1.25 and `-` ×0.8 around the viewport center, `0` fits the board, arrows pan 120 px with the view moving in the arrow's direction.
- While `body.is-focusing` is set (focus mode), presses, double-clicks, the wheel and keys are all ignored; the focused page and the Back button own the input.
- Returns a function that removes every listener.

- [ ] **Step 1: Write the failing test (mouse, wheel, keyboard)**

Create `web/test/input.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotIndex } from '@class-board/shared/types';
import { attachInput } from '../src/board/input';
import type { CameraApi, CameraState, InputHandlers, Unsubscribe } from '../src/contracts';

type Call = [name: string, ...args: unknown[]];

/** A camera that records calls. toBoard uses s = 0.5, tx = 10, ty = 20. */
function fakeCamera(zoomResult: { blockedIn: boolean; slot: SlotIndex } = { blockedIn: false, slot: 0 }) {
  const calls: Call[] = [];
  const st: CameraState = { s: 0.5, tx: 10, ty: 20 };
  const camera: CameraApi = {
    state: () => st,
    viewport: () => ({ w: 1000, h: 800 }),
    setViewport: (w, h) => { calls.push(['setViewport', w, h]); },
    minScale: () => 0.1,
    maxScaleForSlot: () => 2,
    toScreen: (bx, by) => ({ x: bx * st.s + st.tx, y: by * st.s + st.ty }),
    toBoard: (sx, sy) => ({ x: (sx - st.tx) / st.s, y: (sy - st.ty) / st.s }),
    zoomAt: (sx, sy, factor) => { calls.push(['zoomAt', sx, sy, factor]); return zoomResult; },
    panBy: (dx, dy) => { calls.push(['panBy', dx, dy]); },
    fitBoard: () => { calls.push(['fitBoard']); },
    fitSlot: (slot) => { calls.push(['fitSlot', slot]); },
    centerOn: (bx, by) => { calls.push(['centerOn', bx, by]); },
    slotScreenRect: () => ({ x: 0, y: 0, w: 480, h: 300 }),
    onChange: () => () => {},
  };
  return { camera, calls };
}

function recordingHandlers() {
  const calls: Call[] = [];
  const handlers: InputHandlers = {
    boardPointer: (bx, by) => { calls.push(['boardPointer', bx, by]); },
    tap: (slot) => { calls.push(['tap', slot]); },
    doubleTap: (slot) => { calls.push(['doubleTap', slot]); },
    zoomBlocked: (slot) => { calls.push(['zoomBlocked', slot]); },
    pointerLeft: () => { calls.push(['pointerLeft']); },
  };
  return { handlers, calls };
}

function pointer(target: EventTarget, type: string, init: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

/** happy-dom's WheelEvent extends UIEvent, so clientX/clientY/ctrlKey are patched on. */
function wheel(target: EventTarget, init: { deltaY: number; deltaMode?: number; clientX?: number; clientY?: number; ctrlKey?: boolean }): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: init.deltaY, deltaMode: init.deltaMode ?? 0 });
  Object.defineProperty(e, 'clientX', { value: init.clientX ?? 0 });
  Object.defineProperty(e, 'clientY', { value: init.clientY ?? 0 });
  Object.defineProperty(e, 'ctrlKey', { value: init.ctrlKey ?? false });
  target.dispatchEvent(e);
  return e;
}

function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

let viewport: HTMLElement;
let tile: HTMLElement;
let tileChild: HTMLElement;
let detach: Unsubscribe | null = null;

beforeEach(() => {
  document.body.innerHTML = `
    <main id="viewport">
      <div id="world"><div id="tiles">
        <div class="tile" data-slot="23"><div class="tile-body"><div class="tile-card"><p>Card</p>
          <button data-action="add">Add to C4</button></div></div>
          <input class="tile-name-input"></div>
      </div></div>
    </main>`;
  viewport = document.getElementById('viewport')!;
  tile = viewport.querySelector('.tile')!;
  tileChild = tile.querySelector('p')!;
});

afterEach(() => {
  detach?.();
  detach = null;
  document.body.className = '';
});

function setup(zoomResult?: { blockedIn: boolean; slot: SlotIndex }) {
  const cam = fakeCamera(zoomResult);
  const h = recordingHandlers();
  detach = attachInput(viewport, cam.camera, h.handlers);
  return { cam: cam.calls, handler: h.calls };
}

describe('attachInput: mouse drag and tap', () => {
  it('pans by the pointer movement once a drag passes 4 px, and does not tap', () => {
    const { cam, handler } = setup();
    pointer(tileChild, 'pointerdown', { clientX: 100, clientY: 100 });
    pointer(viewport, 'pointermove', { clientX: 102, clientY: 101 });
    expect(cam).toEqual([]);
    pointer(viewport, 'pointermove', { clientX: 110, clientY: 100 });
    pointer(viewport, 'pointermove', { clientX: 115, clientY: 105 });
    pointer(viewport, 'pointerup', { clientX: 115, clientY: 105 });
    expect(cam).toEqual([['panBy', 10, 0], ['panBy', 5, 5]]);
    expect(handler.filter(([n]) => n === 'tap')).toEqual([]);
  });

  it('reports a tap on a tile with its slot', () => {
    const { handler } = setup();
    pointer(tileChild, 'pointerdown', { clientX: 50, clientY: 50 });
    pointer(tileChild, 'pointerup', { clientX: 50, clientY: 50 });
    expect(handler).toEqual([['tap', 23]]);
  });

  it('treats movement of 4 px or less as a tap', () => {
    const { cam, handler } = setup();
    pointer(tileChild, 'pointerdown', { clientX: 50, clientY: 50 });
    pointer(viewport, 'pointermove', { clientX: 53, clientY: 52 });
    pointer(viewport, 'pointerup', { clientX: 53, clientY: 52 });
    expect(cam).toEqual([]);
    expect(handler).toEqual([['tap', 23]]);
  });

  it('reports a tap on the background as null', () => {
    const { handler } = setup();
    pointer(viewport, 'pointerdown', { clientX: 5, clientY: 5 });
    pointer(viewport, 'pointerup', { clientX: 5, clientY: 5 });
    expect(handler).toEqual([['tap', null]]);
  });

  it('does not tap when the pointer is cancelled', () => {
    const { handler } = setup();
    pointer(tileChild, 'pointerdown', { clientX: 5, clientY: 5 });
    pointer(tileChild, 'pointercancel', { clientX: 5, clientY: 5 });
    expect(handler).toEqual([]);
  });

  it('ignores presses that start on buttons, inputs and modals', () => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const field = document.createElement('textarea');
    modal.append(field);
    viewport.append(modal);
    const { cam, handler } = setup();
    for (const target of [tile.querySelector('[data-action]')!, tile.querySelector('input')!, field]) {
      pointer(target, 'pointerdown', { clientX: 0, clientY: 0 });
      pointer(viewport, 'pointermove', { clientX: 40, clientY: 0 });
      pointer(target, 'pointerup', { clientX: 40, clientY: 0 });
    }
    expect(cam).toEqual([]);
    expect(handler.filter(([n]) => n === 'tap')).toEqual([]);
  });

  it('ignores mouse buttons other than the primary one', () => {
    const { cam, handler } = setup();
    pointer(tileChild, 'pointerdown', { button: 2, buttons: 2, clientX: 0, clientY: 0 });
    pointer(viewport, 'pointermove', { buttons: 2, clientX: 50, clientY: 0 });
    pointer(tileChild, 'pointerup', { button: 2, clientX: 50, clientY: 0 });
    expect(cam).toEqual([]);
    expect(handler).toEqual([]);
  });
});

describe('attachInput: double-click, hover and leave', () => {
  it('double-clicking a tile reports doubleTap with its slot', () => {
    const { handler } = setup();
    tileChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    tile.querySelector('[data-action]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(handler).toEqual([['doubleTap', 23]]);
  });

  it('reports hover moves in board coordinates', () => {
    const { handler } = setup();
    pointer(viewport, 'pointermove', { buttons: 0, clientX: 110, clientY: 220 });
    expect(handler).toEqual([['boardPointer', 200, 400]]);
  });

  it('still reports hover moves over tile buttons', () => {
    const { handler } = setup();
    pointer(tile.querySelector('[data-action]')!, 'pointermove', { buttons: 0, clientX: 10, clientY: 20 });
    expect(handler).toEqual([['boardPointer', 0, 0]]);
  });

  it('reports pointerleave as pointerLeft', () => {
    const { handler } = setup();
    viewport.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }));
    expect(handler).toEqual([['pointerLeft']]);
  });

  it('the returned function removes every listener', () => {
    const { cam, handler } = setup();
    detach!();
    detach = null;
    pointer(tileChild, 'pointerdown', { clientX: 0, clientY: 0 });
    pointer(tileChild, 'pointerup', { clientX: 0, clientY: 0 });
    pointer(viewport, 'pointermove', { buttons: 0, clientX: 10, clientY: 10 });
    wheel(viewport, { deltaY: 100 });
    key('0');
    expect(cam).toEqual([]);
    expect(handler).toEqual([]);
  });
});

describe('attachInput: wheel', () => {
  it('zooms around the pointer with factor exp(-deltaY * 0.0015) and prevents scrolling', () => {
    const { cam } = setup();
    const e = wheel(tileChild, { deltaY: 100, clientX: 300, clientY: 200 });
    expect(e.defaultPrevented).toBe(true);
    expect(cam).toHaveLength(1);
    const [name, x, y, factor] = cam[0]!;
    expect([name, x, y]).toEqual(['zoomAt', 300, 200]);
    expect(factor).toBeCloseTo(Math.exp(-0.15), 10);
  });

  it('scales line deltas by 16 px and page deltas by the viewport height', () => {
    const { cam } = setup();
    wheel(viewport, { deltaY: 3, deltaMode: 1 });
    wheel(viewport, { deltaY: -1, deltaMode: 2 });
    expect(cam[0]![3]).toBeCloseTo(Math.exp(-48 * 0.0015), 10);
    expect(cam[1]![3]).toBeCloseTo(Math.exp(800 * 0.0015), 10);
  });

  it('treats ctrl+wheel as a trackpad pinch with factor exp(-deltaY * 0.01)', () => {
    const { cam } = setup();
    wheel(viewport, { deltaY: -10, ctrlKey: true, clientX: 1, clientY: 2 });
    expect(cam[0]![3]).toBeCloseTo(Math.exp(0.1), 10);
  });

  it('reports zoomBlocked with the slot when the camera clamps a zoom-in', () => {
    const { handler } = setup({ blockedIn: true, slot: 42 });
    wheel(viewport, { deltaY: -50 });
    expect(handler).toEqual([['zoomBlocked', 42]]);
  });

  it('leaves the wheel alone over text fields', () => {
    const { cam } = setup();
    const e = wheel(tile.querySelector('input')!, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    expect(cam).toEqual([]);
  });
});

describe('attachInput: keyboard', () => {
  it('zooms around the viewport center with + = and -, and fits with 0', () => {
    const { cam } = setup();
    for (const k of ['+', '=', '-', '0']) expect(key(k).defaultPrevented).toBe(true);
    expect(cam).toEqual([
      ['zoomAt', 500, 400, 1.25],
      ['zoomAt', 500, 400, 1.25],
      ['zoomAt', 500, 400, 0.8],
      ['fitBoard'],
    ]);
  });

  it('pans 120 px with the arrow keys, moving the view in the arrow direction', () => {
    const { cam } = setup();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) key(k);
    expect(cam).toEqual([['panBy', 120, 0], ['panBy', -120, 0], ['panBy', 0, 120], ['panBy', 0, -120]]);
  });

  it('ignores keys while typing, while a modal is open, and with modifier keys', () => {
    const { cam } = setup();
    const input = tile.querySelector('input')!;
    input.focus();
    expect(key('0', {}, input).defaultPrevented).toBe(false);
    input.blur();
    key('+', { ctrlKey: true });
    key('-', { metaKey: true });
    const modal = document.createElement('div');
    modal.className = 'modal';
    document.body.append(modal);
    key('0');
    modal.remove();
    expect(cam).toEqual([]);
  });

  it('leaves other keys alone', () => {
    const { cam } = setup();
    expect(key('a').defaultPrevented).toBe(false);
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(cam).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- input`
Expected: FAIL, `Error: Failed to resolve import "../src/board/input" from "test/input.test.ts". Does the file exist?`

- [ ] **Step 3: Implement mouse, wheel and keyboard input**

Create `web/src/board/input.ts`:

```ts
import type { SlotIndex } from '@class-board/shared/types';
import type { CameraApi, InputHandlers, Unsubscribe } from '../contracts';

/** Movement (screen px) before a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD_PX = 4;
const LINE_PX = 16;
const WHEEL_SPEED = 0.0015;
/** Ctrl+wheel is how trackpads report a pinch; its deltas are much smaller. */
const PINCH_WHEEL_SPEED = 0.01;
const KEY_ZOOM_IN = 1.25;
const KEY_ZOOM_OUT = 0.8;
const KEY_PAN_PX = 120;

/** Presses (pointerdown, dblclick) that start here belong to the control, not the board. */
const PRESS_IGNORE = '[data-action], input, textarea, select, .modal';
/** The wheel still zooms over buttons, but not over text fields or dialogs. */
const WHEEL_IGNORE = 'input, textarea, select, .modal';
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

interface Point { x: number; y: number }

interface Press {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  slot: SlotIndex | null;
  dragging: boolean;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function inside(target: EventTarget | null, selector: string): boolean {
  return asElement(target)?.closest(selector) != null;
}

function slotOf(target: EventTarget | null): SlotIndex | null {
  const raw = asElement(target)?.closest<HTMLElement>('.tile')?.dataset.slot;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function attachInput(viewport: HTMLElement, camera: CameraApi, handlers: InputHandlers): Unsubscribe {
  const doc = viewport.ownerDocument;
  const pointers = new Map<number, Point>();
  let press: Press | null = null;

  function local(e: { clientX: number; clientY: number }): Point {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function capture(id: number): void {
    try {
      viewport.setPointerCapture(id);
    } catch {
      // The pointer may already be gone; the drag still works while it stays over the viewport.
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (inside(e.target, PRESS_IGNORE)) return;
    if (pointers.size >= 1) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    press = { id: e.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, slot: slotOf(e.target), dragging: false };
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) {
      if (e.buttons === 0) {
        const p = local(e);
        const b = camera.toBoard(p.x, p.y);
        handlers.boardPointer(b.x, b.y);
      }
      return;
    }
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (!press || press.id !== e.pointerId) return;
    if (!press.dragging) {
      if (Math.hypot(p.x - press.startX, p.y - press.startY) <= DRAG_THRESHOLD_PX) return;
      press.dragging = true;
      // Capture only once dragging, so a plain click or double-click keeps its real target.
      capture(e.pointerId);
    }
    camera.panBy(p.x - press.lastX, p.y - press.lastY);
    press.lastX = p.x;
    press.lastY = p.y;
  }

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (press && press.id === e.pointerId) {
      const tapped = !press.dragging && !cancelled;
      const slot = press.slot;
      press = null;
      if (tapped) handlers.tap(slot);
    }
  }

  const onPointerUp = (e: PointerEvent): void => endPointer(e, false);
  const onPointerCancel = (e: PointerEvent): void => endPointer(e, true);
  const onPointerLeave = (): void => handlers.pointerLeft();

  function onDoubleClick(e: MouseEvent): void {
    if (inside(e.target, PRESS_IGNORE)) return;
    const slot = slotOf(e.target);
    if (slot !== null) handlers.doubleTap(slot);
  }

  function zoom(x: number, y: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const { blockedIn, slot } = camera.zoomAt(x, y, factor);
    if (blockedIn) handlers.zoomBlocked(slot);
  }

  function onWheel(e: WheelEvent): void {
    if (inside(e.target, WHEEL_IGNORE)) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= LINE_PX;
    else if (e.deltaMode === 2) dy *= camera.viewport().h;
    const p = local(e);
    zoom(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED)));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inside(e.target, TYPING) || inside(doc.activeElement, TYPING)) return;
    if (doc.querySelector('.modal')) return;
    const { w, h } = camera.viewport();
    switch (e.key) {
      case '+':
      case '=':
        camera.zoomAt(w / 2, h / 2, KEY_ZOOM_IN);
        break;
      case '-':
        camera.zoomAt(w / 2, h / 2, KEY_ZOOM_OUT);
        break;
      case '0':
        camera.fitBoard();
        break;
      // Arrow keys move the view, so the board content moves the opposite way.
      case 'ArrowLeft':
        camera.panBy(KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        camera.panBy(-KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        camera.panBy(0, KEY_PAN_PX);
        break;
      case 'ArrowDown':
        camera.panBy(0, -KEY_PAN_PX);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('pointerleave', onPointerLeave);
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('keydown', onKeyDown);

  return () => {
    viewport.removeEventListener('pointerdown', onPointerDown);
    viewport.removeEventListener('pointermove', onPointerMove);
    viewport.removeEventListener('pointerup', onPointerUp);
    viewport.removeEventListener('pointercancel', onPointerCancel);
    viewport.removeEventListener('pointerleave', onPointerLeave);
    viewport.removeEventListener('dblclick', onDoubleClick);
    viewport.removeEventListener('wheel', onWheel);
    doc.removeEventListener('keydown', onKeyDown);
    pointers.clear();
    press = null;
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- input`
Expected: PASS, `Tests  21 passed (21)`.

- [ ] **Step 5: Add the failing tests for touch pinch and focus mode**

Append to the end of `web/test/input.test.ts` (after a blank line):

```ts
describe('attachInput: touch', () => {
  const touch = (target: EventTarget, type: string, id: number, x: number, y: number) =>
    pointer(target, type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 });

  it('pans with a one-finger drag', () => {
    const { cam, handler } = setup();
    touch(tileChild, 'pointerdown', 1, 100, 100);
    touch(viewport, 'pointermove', 1, 100, 130);
    touch(viewport, 'pointerup', 1, 100, 130);
    expect(cam).toEqual([['panBy', 0, 30]]);
    expect(handler).toEqual([]);
  });

  it('pinches: pans by the midpoint movement, then zooms around the new midpoint by the distance ratio', () => {
    const { cam, handler } = setup();
    touch(tileChild, 'pointerdown', 1, 100, 100);
    touch(tileChild, 'pointerdown', 2, 200, 100);
    touch(viewport, 'pointermove', 2, 300, 100);
    expect(cam).toEqual([['panBy', 50, 0], ['zoomAt', 200, 100, 2]]);
    touch(viewport, 'pointerup', 2, 300, 100);
    touch(viewport, 'pointerup', 1, 100, 100);
    expect(handler).toEqual([]);
  });

  it('keeps panning with the finger that stays down after a pinch, without tapping', () => {
    const { cam, handler } = setup();
    touch(tileChild, 'pointerdown', 1, 100, 100);
    touch(tileChild, 'pointerdown', 2, 200, 100);
    touch(viewport, 'pointerup', 2, 200, 100);
    touch(viewport, 'pointermove', 1, 110, 100);
    touch(viewport, 'pointerup', 1, 110, 100);
    expect(cam).toEqual([['panBy', 10, 0]]);
    expect(handler).toEqual([]);
  });

  it('reports zoomBlocked when a pinch zoom-in is clamped', () => {
    const { handler } = setup({ blockedIn: true, slot: 7 });
    touch(viewport, 'pointerdown', 1, 100, 100);
    touch(viewport, 'pointerdown', 2, 200, 100);
    touch(viewport, 'pointermove', 2, 250, 100);
    expect(handler).toEqual([['zoomBlocked', 7]]);
  });
});

describe('attachInput: focus mode', () => {
  it('ignores presses, double-clicks, wheel and keys while body.is-focusing is set', () => {
    const { cam, handler } = setup();
    document.body.classList.add('is-focusing');
    pointer(tileChild, 'pointerdown', { clientX: 0, clientY: 0 });
    pointer(viewport, 'pointermove', { clientX: 40, clientY: 0 });
    pointer(tileChild, 'pointerup', { clientX: 40, clientY: 0 });
    tileChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const e = wheel(viewport, { deltaY: 100 });
    key('0');
    expect(e.defaultPrevented).toBe(false);
    expect(cam).toEqual([]);
    expect(handler).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it and confirm the new behavior fails**

Run: `npm test -w web -- input`
Expected: FAIL, `Tests  3 failed | 23 passed (26)`. The failures are "pinches: pans by the midpoint movement, then zooms around the new midpoint by the distance ratio", "reports zoomBlocked when a pinch zoom-in is clamped" and "ignores presses, double-clicks, wheel and keys while body.is-focusing is set". (One-finger panning and "keeps panning with the finger that stays down" already pass, because the second finger is ignored.)

- [ ] **Step 7: Implement pinch and the focus-mode guard**

Replace the whole of `web/src/board/input.ts` with:

```ts
import type { SlotIndex } from '@class-board/shared/types';
import type { CameraApi, InputHandlers, Unsubscribe } from '../contracts';

/** Movement (screen px) before a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD_PX = 4;
const LINE_PX = 16;
const WHEEL_SPEED = 0.0015;
/** Ctrl+wheel is how trackpads report a pinch; its deltas are much smaller. */
const PINCH_WHEEL_SPEED = 0.01;
const KEY_ZOOM_IN = 1.25;
const KEY_ZOOM_OUT = 0.8;
const KEY_PAN_PX = 120;

/** Presses (pointerdown, dblclick) that start here belong to the control, not the board. */
const PRESS_IGNORE = '[data-action], input, textarea, select, .modal';
/** The wheel still zooms over buttons, but not over text fields or dialogs. */
const WHEEL_IGNORE = 'input, textarea, select, .modal';
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

interface Point { x: number; y: number }

interface Press {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  slot: SlotIndex | null;
  dragging: boolean;
}

interface Pinch { dist: number; midX: number; midY: number }

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function inside(target: EventTarget | null, selector: string): boolean {
  return asElement(target)?.closest(selector) != null;
}

function slotOf(target: EventTarget | null): SlotIndex | null {
  const raw = asElement(target)?.closest<HTMLElement>('.tile')?.dataset.slot;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function attachInput(viewport: HTMLElement, camera: CameraApi, handlers: InputHandlers): Unsubscribe {
  const doc = viewport.ownerDocument;
  const pointers = new Map<number, Point>();
  let press: Press | null = null;
  let pinch: Pinch | null = null;

  const focusing = (): boolean => doc.body.classList.contains('is-focusing');

  function local(e: { clientX: number; clientY: number }): Point {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pinchOf(): Pinch {
    const [a, b] = [...pointers.values()] as [Point, Point];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }

  function capture(id: number): void {
    try {
      viewport.setPointerCapture(id);
    } catch {
      // The pointer may already be gone; the drag still works while it stays over the viewport.
    }
  }

  function zoom(x: number, y: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const { blockedIn, slot } = camera.zoomAt(x, y, factor);
    if (blockedIn) handlers.zoomBlocked(slot);
  }

  function onPointerDown(e: PointerEvent): void {
    if (focusing()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (inside(e.target, PRESS_IGNORE)) return;
    if (pointers.size >= 2) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      press = { id: e.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, slot: slotOf(e.target), dragging: false };
      return;
    }
    // A second finger turns the gesture into a pinch; it can no longer end as a tap.
    pinch = pinchOf();
    if (press) press.dragging = true;
    for (const id of pointers.keys()) capture(id);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) {
      if (e.buttons === 0) {
        const p = local(e);
        const b = camera.toBoard(p.x, p.y);
        handlers.boardPointer(b.x, b.y);
      }
      return;
    }
    const p = local(e);
    pointers.set(e.pointerId, p);

    if (pinch && pointers.size === 2) {
      const next = pinchOf();
      // Pan first so the board point under the old midpoint follows the fingers, then zoom around it.
      camera.panBy(next.midX - pinch.midX, next.midY - pinch.midY);
      if (pinch.dist > 0) zoom(next.midX, next.midY, next.dist / pinch.dist);
      pinch = next;
      return;
    }

    if (!press || press.id !== e.pointerId) return;
    if (!press.dragging) {
      if (Math.hypot(p.x - press.startX, p.y - press.startY) <= DRAG_THRESHOLD_PX) return;
      press.dragging = true;
      // Capture only once dragging, so a plain click or double-click keeps its real target.
      capture(e.pointerId);
    }
    camera.panBy(p.x - press.lastX, p.y - press.lastY);
    press.lastX = p.x;
    press.lastY = p.y;
  }

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (pinch) {
      pinch = null;
      const rest = [...pointers.entries()][0];
      // The finger left on the glass keeps panning from where it is.
      press = rest ? { id: rest[0], startX: rest[1].x, startY: rest[1].y, lastX: rest[1].x, lastY: rest[1].y, slot: null, dragging: true } : null;
      return;
    }

    if (press && press.id === e.pointerId) {
      const tapped = !press.dragging && !cancelled;
      const slot = press.slot;
      press = null;
      if (tapped) handlers.tap(slot);
    }
  }

  const onPointerUp = (e: PointerEvent): void => endPointer(e, false);
  const onPointerCancel = (e: PointerEvent): void => endPointer(e, true);
  const onPointerLeave = (): void => handlers.pointerLeft();

  function onDoubleClick(e: MouseEvent): void {
    if (focusing() || inside(e.target, PRESS_IGNORE)) return;
    const slot = slotOf(e.target);
    if (slot !== null) handlers.doubleTap(slot);
  }

  function onWheel(e: WheelEvent): void {
    if (focusing() || inside(e.target, WHEEL_IGNORE)) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= LINE_PX;
    else if (e.deltaMode === 2) dy *= camera.viewport().h;
    const p = local(e);
    zoom(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? PINCH_WHEEL_SPEED : WHEEL_SPEED)));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inside(e.target, TYPING) || inside(doc.activeElement, TYPING)) return;
    if (doc.querySelector('.modal') || focusing()) return;
    const { w, h } = camera.viewport();
    switch (e.key) {
      case '+':
      case '=':
        camera.zoomAt(w / 2, h / 2, KEY_ZOOM_IN);
        break;
      case '-':
        camera.zoomAt(w / 2, h / 2, KEY_ZOOM_OUT);
        break;
      case '0':
        camera.fitBoard();
        break;
      // Arrow keys move the view, so the board content moves the opposite way.
      case 'ArrowLeft':
        camera.panBy(KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        camera.panBy(-KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        camera.panBy(0, KEY_PAN_PX);
        break;
      case 'ArrowDown':
        camera.panBy(0, -KEY_PAN_PX);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('pointerleave', onPointerLeave);
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('keydown', onKeyDown);

  return () => {
    viewport.removeEventListener('pointerdown', onPointerDown);
    viewport.removeEventListener('pointermove', onPointerMove);
    viewport.removeEventListener('pointerup', onPointerUp);
    viewport.removeEventListener('pointercancel', onPointerCancel);
    viewport.removeEventListener('pointerleave', onPointerLeave);
    viewport.removeEventListener('dblclick', onDoubleClick);
    viewport.removeEventListener('wheel', onWheel);
    doc.removeEventListener('keydown', onKeyDown);
    pointers.clear();
    press = null;
    pinch = null;
  };
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- input`
Expected: PASS, `Tests  26 passed (26)`.

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add web/src/board/input.ts web/test/input.test.ts
git commit -m "feat(web): input for pan, zoom, tap, keys and touch (U5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U6: Page shell, base styles, grid

**Wave:** 3 · **Tier:** T2 (sonnet, medium) · **Depends on:** F1, F2, F3, F5, U1

**Files:**
- Create: `web/index.html`, `web/src/styles/base.css`, `web/src/board/grid.ts`, `web/src/board/grid.css`
- Test: `web/test/grid.test.ts`

Tile markup follows master plan §5.2. The details this task fixes:
- The tile's `left`/`top` come from `labelRect(slot)`; it's 480 wide and 332 high (label 32 + body 300).
- Empty tile: `.tile-card` holds `button.tile-add[data-action="add"]` "Add to C4". It's hidden while the board is locked, unless the grid is in teacher mode. The name button is hidden (there's no name to edit), and History shows only when the slot has versions (`version > 0`, a cleared tile).
- Checking (a link with `embeddable: 'pending'`): a spinner and "Checking link…".
- Link or upload card: `img.tile-shot` (through `serverHref`) when `shotUrl` is set, otherwise `.tile-info` with `img.tile-icon`, `.tile-title` (title, else label, else domain) and `.tile-domain` (the host without `www.`, or "HTML page" for uploads); then `p.tile-note` when there's a note; and for a link whose `embeddable` is `unknown`, `button.tile-hint[data-action="open"]` "Blank? Open in new tab". A screenshot that fails to load is replaced by the title card.
- Label: `button.tile-name[data-action="rename"]` (disabled while locked for students), `span.tile-slot`, and `span.tile-badge` "HTML", shown for uploads only.
- `.tile-actions`: Open, Replace (hidden for empty tiles and for students while locked), History, Clear (teacher only, filled tiles only). Each has an `aria-label` naming the slot.
- `aria-label` on the tile: "C4, empty", or the slot, label and title (or domain) joined with commas, for example "C4, Maya, Example page".
- Rename: clicking the name swaps it for `input.tile-name-input` (max 40). Enter saves `cleanText(value, 40)` through `actions.rename` when it's non-empty and changed; Esc and blur cancel. The name button comes back showing the current label; the server's `tile` message brings the new one. A tile update during an edit refreshes the card but keeps the input.
- Enter on the focused `.tile` itself calls `actions.focus(slot)`; Enter on a button inside it doesn't.
- Grid subscribes to `state` itself: `'snapshot'` → `setLocked(state.locked())` (which re-renders every tile), `'tile'` → `update(view.slot)` (only that tile), `'locked'` → `setLocked`.

- [ ] **Step 1: Write the failing check for the page shell**

This check has no dependencies. Run it from the repo root:

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
node -e '
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { console.error("FAIL: " + p + " is missing"); process.exit(1); } };
const html = read("web/index.html");
const css = read("web/src/styles/base.css");
const body = html.replace(/\s+/g, " ");
const checks = {
  "title": /<title>Class board<\/title>/.test(html),
  "viewport meta": /<meta name="viewport" content="width=device-width, initial-scale=1"/.test(html),
  "svg favicon": /<link[^>]*rel="icon"[^>]*href="data:image\/svg\+xml,/.test(body),
  "page structure": body.includes("<div id=\"app\"> <header id=\"topbar\"></header> <main id=\"viewport\"> <div id=\"world\"><div id=\"tiles\"></div></div> <div id=\"cursor-layer\"></div> <div id=\"hint\"></div> </main> <div id=\"banner\"></div> <div id=\"modal-root\"></div> </div>"),
  "entry script": /<script type="module" src="\/src\/main.ts"><\/script>/.test(html),
};
for (const v of ["--bg", "--surface", "--border", "--text", "--text-muted", "--accent", "--danger", "--radius", "--font"]) checks["var " + v] = css.includes(v + ":");
for (const [v, n] of [["--z-world", 1], ["--z-cursors", 10], ["--z-hint", 15], ["--z-topbar", 20], ["--z-banner", 25], ["--z-modal", 30]]) checks["var " + v] = css.includes(v + ": " + n + ";");
checks["viewport rules"] = /#viewport \{[^}]*position: relative;[^}]*overflow: hidden;[^}]*touch-action: none;[^}]*background: var\(--bg\);/.test(css);
checks["world rules"] = /#world \{[^}]*position: absolute;[^}]*transform-origin: 0 0;[^}]*will-change: transform;/.test(css);
checks["cursor layer"] = /#cursor-layer \{[^}]*pointer-events: none;/.test(css);
checks["hint visible class"] = /#hint\.is-visible \{/.test(css);
checks["hidden wins"] = /\[hidden\] \{\s*display: none !important;/.test(css);
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) { console.error("FAIL: " + failed.join(", ")); process.exit(1); }
console.log("shell ok (" + Object.keys(checks).length + " checks)");
'
```

Expected: FAIL, `FAIL: web/index.html is missing`, exit code 1.

- [ ] **Step 2: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="A shared board for the class: post a link or an HTML page into a tile." />
    <link
      rel="icon"
      type="image/svg+xml"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23378ADD'/%3E%3Cpath fill='%23fff' d='M7 7h8v8H7zM17 7h8v8h-8zM7 17h8v8H7zM17 17h8v8h-8z'/%3E%3C/svg%3E"
    />
    <title>Class board</title>
  </head>
  <body>
    <div id="app">
      <header id="topbar"></header>
      <main id="viewport">
        <div id="world"><div id="tiles"></div></div>
        <div id="cursor-layer"></div>
        <div id="hint"></div>
      </main>
      <div id="banner"></div>
      <div id="modal-root"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `web/src/styles/base.css`**

```css
/* The only file that defines variables. Every module's CSS uses these. */
:root {
  --bg: #f3f2ee;
  --surface: #ffffff;
  --border: #d6d3cb;
  --text: #1f1e1c;
  --text-muted: #6b6963;
  --accent: #378add;
  --danger: #c93b3a;
  --radius: 8px;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --topbar-h: 48px;

  --z-world: 1;
  --z-cursors: 10;
  --z-hint: 15;
  --z-topbar: 20;
  --z-banner: 25;
  --z-modal: 30;

  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1b1a;
    --surface: #262624;
    --border: #3d3c39;
    --text: #ecebe7;
    --text-muted: #a3a19b;
    --accent: #5fa3e8;
    --danger: #f07170;
  }
}

/* Reset */
*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  height: 100%;
}

body {
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.4 var(--font);
  -webkit-font-smoothing: antialiased;
}

h1,
h2,
h3,
p {
  margin: 0;
}

button,
input,
textarea,
select {
  font: inherit;
  color: inherit;
}

button {
  cursor: pointer;
}

img {
  display: block;
  max-width: 100%;
}

/* Modules toggle the hidden property; no display rule may override it. */
[hidden] {
  display: none !important;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Page shell */
#app {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
}

#topbar {
  position: relative;
  z-index: var(--z-topbar);
  flex: none;
  height: var(--topbar-h);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

#viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  background: var(--bg);
  user-select: none;
  -webkit-user-select: none;
}

#world {
  position: absolute;
  left: 0;
  top: 0;
  z-index: var(--z-world);
  transform-origin: 0 0;
  will-change: transform;
}

/* BOARD_W × BOARD_H; the tiles inside are absolutely positioned. */
#tiles {
  position: relative;
  width: 5232px;
  height: 2992px;
}

#cursor-layer {
  position: absolute;
  inset: 0;
  z-index: var(--z-cursors);
  overflow: hidden;
  pointer-events: none;
}

#hint {
  position: absolute;
  left: 50%;
  bottom: 24px;
  z-index: var(--z-hint);
  max-width: calc(100% - 32px);
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(31, 30, 28, 0.88);
  color: #fff;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.15s ease, visibility 0s linear 0.15s;
}

#hint.is-visible {
  visibility: visible;
  opacity: 1;
  transition: opacity 0.15s ease;
}

/* A stack of banners at the top center, under the top bar. The #app prefix outranks any
   single-id #banner rule in module CSS, whatever order the stylesheets load in. */
#app > #banner {
  position: fixed;
  top: calc(var(--topbar-h) + 8px);
  bottom: auto;
  left: 50%;
  z-index: var(--z-banner);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: min(560px, calc(100% - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}

#app > #banner > * {
  pointer-events: auto;
}

#modal-root {
  position: relative;
  z-index: var(--z-modal);
}
```

- [ ] **Step 4: Run the shell check again**

Run the same command as Step 1.
Expected: `shell ok (25 checks)`.

(`npm run build -w web` can't run yet: `src/main.ts` arrives with U8 in wave 4.)

- [ ] **Step 5: Write the failing grid test**

Create `web/test/grid.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { SlotIndex, TileView } from '@class-board/shared/types';
import { createGrid } from '../src/board/grid';
import type { BoardStateApi, BoardStateEvents, GridActions, GridApi } from '../src/contracts';
import { createEmitter } from '../src/util/emitter';

const SERVER = 'http://localhost:8787';
const C4 = 23;

function emptyView(slot: SlotIndex, version = 0): TileView {
  return {
    slot, version, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

function linkView(slot: SlotIndex, over: Partial<TileView> = {}): TileView {
  return {
    ...emptyView(slot, 7),
    kind: 'link',
    label: 'Maya',
    url: 'https://www.example.com/page',
    embedUrl: 'https://www.example.com/page',
    title: 'Example page',
    embeddable: 'yes',
    authorName: 'Maya',
    createdAt: 1,
    ...over,
  };
}

/** A state holder with the real event shape; tests change tiles and emit events directly. */
function fakeState() {
  const events = createEmitter<BoardStateEvents>();
  const tiles: TileView[] = Array.from({ length: SLOT_COUNT }, (_, s) => emptyView(s));
  let locked = false;
  const api: BoardStateApi = {
    board: () => 'main',
    you: () => 'me',
    locked: () => locked,
    rate: () => 5,
    ready: () => true,
    tiles: () => tiles,
    tile: (slot) => tiles[slot]!,
    people: () => [],
    person: () => undefined,
    me: () => undefined,
    apply: () => {},
    on: events.on,
  };
  return {
    api,
    setTile(view: TileView) {
      tiles[view.slot] = view;
      events.emit('tile', view);
    },
    /** Changes a tile without an event, as a snapshot does before it emits. */
    putTile(view: TileView) {
      tiles[view.slot] = view;
    },
    setLocked(on: boolean) {
      locked = on;
      events.emit('locked', on);
    },
    snapshot(on: boolean) {
      locked = on;
      events.emit('snapshot');
    },
  };
}

type Call = [name: string, ...args: unknown[]];

function recordingActions() {
  const calls: Call[] = [];
  const actions: GridActions = {
    add: (s) => { calls.push(['add', s]); },
    replace: (s) => { calls.push(['replace', s]); },
    history: (s) => { calls.push(['history', s]); },
    open: (s) => { calls.push(['open', s]); },
    clear: (s) => { calls.push(['clear', s]); },
    rename: (s, label) => { calls.push(['rename', s, label]); },
    focus: (s) => { calls.push(['focus', s]); },
    back: () => { calls.push(['back']); },
  };
  return { actions, calls };
}

let root: HTMLElement;
let grid: GridApi | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="tiles"></div>';
  root = document.getElementById('tiles')!;
});

afterEach(() => {
  grid?.destroy();
  grid = null;
});

function setup() {
  const state = fakeState();
  const rec = recordingActions();
  grid = createGrid(root, state.api, rec.actions, SERVER);
  return { state, calls: rec.calls, grid };
}

const q = <T extends Element = HTMLElement>(slot: SlotIndex, sel: string) =>
  root.querySelector<T>(`.tile[data-slot="${slot}"] ${sel}`);

function press(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('grid: tiles and layout', () => {
  it('creates 80 focusable tiles positioned from the label and tile rects', () => {
    setup();
    const tiles = root.querySelectorAll<HTMLElement>('.tile');
    expect(tiles).toHaveLength(80);
    const c4 = tiles[C4]!;
    expect(c4.dataset.slot).toBe('23');
    expect(c4.getAttribute('tabindex')).toBe('0');
    expect(c4.style.left).toBe('1584px');
    expect(c4.style.top).toBe('760px');
    expect(c4.style.width).toBe('480px');
    expect(c4.style.height).toBe('332px');
    expect(tiles[79]!.style.left).toBe('4752px');
    expect(tiles[79]!.style.top).toBe('2660px');
  });

  it('builds the label, body, card, frame host, actions and a hidden Back button', () => {
    const { grid } = setup();
    expect(q(C4, '.tile-label .tile-slot')!.textContent).toBe('C4');
    expect(q(C4, '.tile-label .tile-name[data-action="rename"]')).not.toBeNull();
    expect(grid.bodyEl(C4).classList.contains('tile-body')).toBe(true);
    expect(grid.frameHost(C4).classList.contains('tile-frame')).toBe(true);
    expect(grid.frameHost(C4).parentElement).toBe(grid.bodyEl(C4));
    expect(grid.tileEl(C4)).toBe(root.children[C4]);
    const back = q<HTMLButtonElement>(C4, '.tile-body > .focus-back[data-action="back"]')!;
    expect(back.hidden).toBe(true);
    expect(back.textContent).toBe('← Back');
    for (const a of ['open', 'replace', 'history', 'clear']) {
      expect(q(C4, `.tile-actions [data-action="${a}"]`)!.getAttribute('aria-label')).toMatch(/C4/);
    }
  });
});

describe('grid: tile states', () => {
  it('shows an empty tile with an Add button and no filled-tile buttons', () => {
    setup();
    const tile = root.children[C4]!;
    expect(tile.className).toBe('tile is-empty');
    expect(tile.getAttribute('aria-label')).toBe('C4, empty');
    const add = q<HTMLButtonElement>(C4, '.tile-card [data-action="add"]')!;
    expect(add.textContent).toBe('Add to C4');
    expect(add.hidden).toBe(false);
    for (const a of ['open', 'replace', 'history', 'clear']) {
      expect(q<HTMLButtonElement>(C4, `[data-action="${a}"]`)!.hidden).toBe(true);
    }
    expect(q<HTMLButtonElement>(C4, '.tile-name')!.hidden).toBe(true);
  });

  it('shows History on an empty tile that has versions (a cleared tile)', () => {
    const { state } = setup();
    state.setTile(emptyView(C4, 12));
    expect(q<HTMLButtonElement>(C4, '[data-action="history"]')!.hidden).toBe(false);
  });

  it('shows a spinner while a link is being checked', () => {
    const { state } = setup();
    state.setTile(linkView(C4, { embeddable: 'pending', title: null }));
    const tile = root.children[C4]!;
    expect(tile.classList.contains('is-link')).toBe(true);
    expect(tile.classList.contains('is-checking')).toBe(true);
    expect(q(C4, '.tile-card .tile-spinner')).not.toBeNull();
    expect(q(C4, '.tile-card')!.textContent).toBe('Checking link…');
  });

  it('shows a link card with title, icon and domain when there is no screenshot', () => {
    const { state } = setup();
    state.setTile(linkView(C4, { icon: 'https://www.example.com/favicon.ico' }));
    const tile = root.children[C4]!;
    expect(tile.className).toBe('tile is-link');
    expect(tile.getAttribute('aria-label')).toBe('C4, Maya, Example page');
    expect(q(C4, '.tile-title')!.textContent).toBe('Example page');
    expect(q(C4, '.tile-domain')!.textContent).toBe('example.com');
    expect(q<HTMLImageElement>(C4, 'img.tile-icon')!.src).toBe('https://www.example.com/favicon.ico');
    expect(q(C4, '.tile-name')!.textContent).toBe('Maya');
    expect(q(C4, '.tile-shot')).toBeNull();
  });

  it('shows the screenshot through the server URL when there is one', () => {
    const { state } = setup();
    state.setTile(linkView(C4, { shotUrl: '/boards/main/shots/abc' }));
    expect(q<HTMLImageElement>(C4, 'img.tile-shot')!.src).toBe('http://localhost:8787/boards/main/shots/abc');
    expect(q(C4, '.tile-info')).toBeNull();
  });

  it('marks a link that cannot be embedded as blocked and shows its note', () => {
    const { state } = setup();
    state.setTile(linkView(C4, { embeddable: 'no', note: "This site doesn't allow embedding. Open it in a new tab." }));
    expect(root.children[C4]!.classList.contains('is-blocked')).toBe(true);
    expect(q(C4, '.tile-note')!.textContent).toBe("This site doesn't allow embedding. Open it in a new tab.");
    expect(q(C4, '.tile-hint')).toBeNull();
  });

  it('offers "Blank? Open in new tab" when embedding is unknown', () => {
    const { state, calls } = setup();
    state.setTile(linkView(C4, { embeddable: 'unknown' }));
    const hint = q(C4, '.tile-card .tile-hint[data-action="open"]')!;
    expect(hint.textContent).toBe('Blank? Open in new tab');
    press(hint);
    expect(calls).toEqual([['open', C4]]);
  });

  it('shows an upload with the HTML badge', () => {
    const { state } = setup();
    state.setTile(linkView(C4, { kind: 'html', url: null, embedUrl: null, fileUrl: '/boards/main/files/f1', title: 'My artifact' }));
    const tile = root.children[C4]!;
    expect(tile.className).toBe('tile is-html');
    expect(q<HTMLElement>(C4, '.tile-badge')!.hidden).toBe(false);
    expect(q(C4, '.tile-domain')!.textContent).toBe('HTML page');
    expect(q<HTMLElement>(0, '.tile-badge')!.hidden).toBe(true);
  });

  it('keeps classes and frame content owned by other modules when a tile re-renders', () => {
    const { state, grid } = setup();
    state.setTile(linkView(C4));
    grid.tileEl(C4).classList.add('is-live', 'is-active');
    grid.frameHost(C4).append(document.createElement('iframe'));
    state.setTile(linkView(C4, { embeddable: 'no' }));
    expect(grid.tileEl(C4).className).toBe('tile is-live is-active is-link is-blocked');
    expect(grid.frameHost(C4).querySelector('iframe')).not.toBeNull();
  });
});

describe('grid: actions', () => {
  it('dispatches each tile button to its GridActions method', () => {
    const { state, calls, grid } = setup();
    state.setTile(linkView(C4));
    grid.setTeacher(true);
    press(q(0, '[data-action="add"]')!);
    for (const a of ['open', 'replace', 'history', 'clear', 'back']) press(q(C4, `[data-action="${a}"]`)!);
    expect(calls).toEqual([['add', 0], ['open', C4], ['replace', C4], ['history', C4], ['clear', C4], ['back']]);
  });

  it('ignores clicks outside buttons', () => {
    const { calls } = setup();
    press(q(C4, '.tile-card')!);
    press(root);
    expect(calls).toEqual([]);
  });

  it('asks to focus a tile when Enter is pressed on the tile itself', () => {
    const { calls, grid } = setup();
    const tile = grid.tileEl(C4);
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    tile.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    q(C4, '[data-action="add"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    tile.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(calls).toEqual([['focus', C4]]);
  });
});

describe('grid: rename', () => {
  function startRename() {
    const s = setup();
    s.state.setTile(linkView(C4));
    press(q(C4, '.tile-name')!);
    const input = q<HTMLInputElement>(C4, '.tile-label input.tile-name-input')!;
    return { ...s, input };
  }
  const keydown = (el: Element, key: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('swaps the name for an input holding the current name', () => {
    const { input } = startRename();
    expect(input.value).toBe('Maya');
    expect(input.maxLength).toBe(40);
    expect(q(C4, '.tile-name')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('saves a cleaned name with Enter and puts the name button back', () => {
    const { input, calls } = startRename();
    input.value = '  Maya   and   Ben ';
    keydown(input, 'Enter');
    expect(calls).toEqual([['rename', C4, 'Maya and Ben']]);
    expect(q(C4, '.tile-name-input')).toBeNull();
    expect(q(C4, '.tile-name')!.textContent).toBe('Maya');
  });

  it('does not save an unchanged or blank name', () => {
    const { input, calls } = startRename();
    keydown(input, 'Enter');
    press(q(C4, '.tile-name')!);
    const again = q<HTMLInputElement>(C4, '.tile-name-input')!;
    again.value = '   ';
    keydown(again, 'Enter');
    expect(calls).toEqual([]);
  });

  it('cancels with Escape and with blur', () => {
    const { input, calls } = startRename();
    input.value = 'Other';
    keydown(input, 'Escape');
    expect(q(C4, '.tile-name-input')).toBeNull();
    press(q(C4, '.tile-name')!);
    const again = q<HTMLInputElement>(C4, '.tile-name-input')!;
    again.value = 'Other';
    again.dispatchEvent(new FocusEvent('blur'));
    expect(q(C4, '.tile-name-input')).toBeNull();
    expect(q(C4, '.tile-name')!.textContent).toBe('Maya');
    expect(calls).toEqual([]);
  });

  it('keeps the input when the tile updates while editing', () => {
    const { input, state } = startRename();
    state.setTile(linkView(C4, { title: 'Changed' }));
    expect(input.isConnected).toBe(true);
    expect(q(C4, '.tile-title')!.textContent).toBe('Changed');
  });
});

describe('grid: locked and teacher', () => {
  it('hides Add, Replace and Rename from students while locked', () => {
    const { state, grid } = setup();
    state.setTile(linkView(C4));
    state.setLocked(true);
    expect(root.classList.contains('is-locked')).toBe(true);
    expect(q<HTMLButtonElement>(0, '[data-action="add"]')!.hidden).toBe(true);
    expect(q<HTMLButtonElement>(C4, '[data-action="replace"]')!.hidden).toBe(true);
    expect(q<HTMLButtonElement>(C4, '.tile-name')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>(C4, '[data-action="history"]')!.hidden).toBe(false);
    expect(q<HTMLButtonElement>(C4, '[data-action="open"]')!.hidden).toBe(false);
    grid.setLocked(false);
    expect(root.classList.contains('is-locked')).toBe(false);
    expect(q<HTMLButtonElement>(0, '[data-action="add"]')!.hidden).toBe(false);
  });

  it('lets the teacher edit a locked board and shows Clear only to the teacher', () => {
    const { state, grid } = setup();
    state.setTile(linkView(C4));
    expect(q<HTMLButtonElement>(C4, '[data-action="clear"]')!.hidden).toBe(true);
    grid.setLocked(true);
    grid.setTeacher(true);
    expect(q<HTMLButtonElement>(0, '[data-action="add"]')!.hidden).toBe(false);
    expect(q<HTMLButtonElement>(C4, '[data-action="replace"]')!.hidden).toBe(false);
    expect(q<HTMLButtonElement>(C4, '[data-action="clear"]')!.hidden).toBe(false);
    expect(q<HTMLButtonElement>(0, '[data-action="clear"]')!.hidden).toBe(true);
    grid.setTeacher(false);
    expect(q<HTMLButtonElement>(C4, '[data-action="clear"]')!.hidden).toBe(true);
  });

  it('does not start a rename while locked', () => {
    const { state } = setup();
    state.setTile(linkView(C4));
    state.setLocked(true);
    press(q(C4, '.tile-name')!);
    expect(q(C4, '.tile-name-input')).toBeNull();
  });
});

describe('grid: state events', () => {
  it('re-renders only the changed tile on a tile event', () => {
    const { state } = setup();
    const otherCard = q(24, '.tile-card')!.firstElementChild;
    const before = q(C4, '.tile-card')!.firstElementChild;
    state.setTile(linkView(C4));
    expect(q(24, '.tile-card')!.firstElementChild).toBe(otherCard);
    expect(q(C4, '.tile-card')!.firstElementChild).not.toBe(before);
  });

  it('re-renders every tile and the lock on a snapshot', () => {
    const { state } = setup();
    state.putTile(linkView(3));
    state.putTile(linkView(70, { kind: 'html', url: null }));
    state.snapshot(true);
    expect(root.children[3]!.classList.contains('is-link')).toBe(true);
    expect(root.children[70]!.classList.contains('is-html')).toBe(true);
    expect(root.classList.contains('is-locked')).toBe(true);
  });

  it('destroy removes the tiles and stops listening', () => {
    const { state, calls } = setup();
    const add = q(0, '[data-action="add"]')!;
    grid!.destroy();
    grid = null;
    expect(root.children).toHaveLength(0);
    state.setTile(linkView(C4));
    root.append(add);
    press(add);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test -w web -- grid`
Expected: FAIL, `Error: Failed to resolve import "../src/board/grid" from "test/grid.test.ts". Does the file exist?`

- [ ] **Step 7: Create `web/src/board/grid.css`**

```css
/* Tiles, labels, cards and hover buttons (Grid). .tile-frame belongs to frames.css, focus mode to focus.css. */

.tile {
  position: absolute;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius);
}

.tile:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 4px;
}

/* Label strip: 32 board units above the tile body. */
.tile-label {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 2px 4px;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
}

.tile-name {
  overflow: hidden;
  max-width: 340px;
  padding: 3px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  /* --cam-s is the camera scale, set on #world by main.ts. Zoomed out, names grow in board
     units, up to what fits the 32-unit strip, so they stay readable on the overview. */
  font-size: clamp(18px, calc(12px / var(--cam-s, 1)), 26px);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-name:hover:not(:disabled) {
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--border);
}

.tile-name:disabled {
  cursor: default;
  opacity: 1;
}

.tile-name-input {
  width: 260px;
  height: 26px;
  padding: 2px 6px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
}

.tile-slot {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.tile-badge {
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

/* Tile body: exactly 480×300, so a 1280×800 iframe at scale 0.375 fills it. The outline is a
   shadow rather than a border so it doesn't take space from the frame. */
.tile-body {
  position: relative;
  flex: none;
  width: 480px;
  height: 300px;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--border), 0 1px 3px rgba(0, 0, 0, 0.06);
}

.tile.is-empty .tile-body {
  background: transparent;
  box-shadow: none;
  outline: 2px dashed var(--border);
  outline-offset: -2px;
}

/* Grid owns the card: empty, checking, and the screenshot or title card. */
.tile-card {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
}

.tile-add {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  font-size: 20px;
  font-weight: 500;
}

.tile-add:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
}

.tile-checking {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 16px;
}

.tile-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: tile-spin 0.8s linear infinite;
}

@keyframes tile-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tile-spinner {
    animation-duration: 2.4s;
  }
}

.tile-shot {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  -webkit-user-drag: none;
}

.tile-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  padding: 24px 28px;
}

.tile-icon {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.tile-title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.tile-domain {
  color: var(--text-muted);
  font-size: 14px;
}

/* Over a screenshot the note sits on a strip at the bottom; on a title card it flows below. */
.tile-note {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  border-top: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
}

.tile-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
}

/* Hover buttons: shown on hover and while anything in the tile has keyboard focus. */
.tile-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  gap: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.tile:hover .tile-actions,
.tile:focus-within .tile-actions {
  opacity: 1;
  pointer-events: auto;
}

.tile-action {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  font-weight: 500;
}

.tile-action:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.tile-action[data-action='clear']:hover {
  border-color: var(--danger);
  color: var(--danger);
}

/* Focus mode's Back button; focus.ts un-hides it, focus.css places it in the top layer. */
.focus-back {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 4;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-weight: 600;
}

.tile.is-blocked .tile-shot {
  filter: saturate(0.85);
}
```

- [ ] **Step 8: Create `web/src/board/grid.ts`**

```ts
import { LIMITS, SLOT_COUNT } from '@class-board/shared/constants';
import { cleanText } from '@class-board/shared/protocol';
import { labelRect, slotName, tileRect } from '@class-board/shared/slots';
import type { SlotIndex, TileView } from '@class-board/shared/types';
import type { BoardStateApi, GridActions, GridApi, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { serverHref } from '../util/url';
import './grid.css';

/** Classes Grid owns on `.tile`. Other modules add is-live, is-active and is-focus; those are never touched here. */
const STATE_CLASSES = ['is-empty', 'is-link', 'is-html', 'is-checking', 'is-blocked'] as const;

interface TileParts {
  tile: HTMLElement;
  name: HTMLButtonElement;
  badge: HTMLElement;
  body: HTMLElement;
  card: HTMLElement;
  frame: HTMLElement;
  open: HTMLButtonElement;
  replace: HTMLButtonElement;
  history: HTMLButtonElement;
  clear: HTMLButtonElement;
}

function domainOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function actionButton(action: string, text: string, label: string): HTMLButtonElement {
  return h('button', { type: 'button', class: 'tile-action', dataset: { action }, attrs: { 'aria-label': label } }, text);
}

export function createGrid(root: HTMLElement, state: BoardStateApi, actions: GridActions, serverUrl: string): GridApi {
  const parts: TileParts[] = [];
  let locked = state.locked();
  let teacher = false;
  /** The slot whose name is being edited, so a re-render doesn't throw the edit away. */
  let editing: SlotIndex | null = null;

  const canEdit = (): boolean => !locked || teacher;

  function build(slot: SlotIndex): TileParts {
    const id = slotName(slot);
    const label = labelRect(slot);
    const body = tileRect(slot);
    const name = h('button', { type: 'button', class: 'tile-name', dataset: { action: 'rename' } });
    const badge = h('span', { class: 'tile-badge', hidden: true }, 'HTML');
    const card = h('div', { class: 'tile-card' });
    const frame = h('div', { class: 'tile-frame' });
    const open = actionButton('open', 'Open', `Open ${id} in a new tab`);
    const replace = actionButton('replace', 'Replace', `Replace ${id}`);
    const history = actionButton('history', 'History', `History of ${id}`);
    const clear = actionButton('clear', 'Clear', `Clear ${id}`);
    const back = h('button', { type: 'button', class: 'focus-back', dataset: { action: 'back' }, hidden: true }, '← Back');
    const bodyEl = h(
      'div',
      { class: 'tile-body' },
      card,
      frame,
      h('div', { class: 'tile-actions' }, open, replace, history, clear),
      back,
    );
    const tile = h(
      'div',
      { class: 'tile', dataset: { slot: String(slot) }, attrs: { tabindex: '0' } },
      h('div', { class: 'tile-label' }, name, h('span', { class: 'tile-slot' }, id), badge),
      bodyEl,
    );
    tile.style.left = `${label.x}px`;
    tile.style.top = `${label.y}px`;
    tile.style.width = `${label.w}px`;
    tile.style.height = `${body.y + body.h - label.y}px`;
    return { tile, name, badge, body: bodyEl, card, frame, open, replace, history, clear };
  }

  function cardContent(view: TileView): Node[] {
    const id = slotName(view.slot);
    if (view.kind === 'empty') {
      return [h('button', { type: 'button', class: 'tile-add', dataset: { action: 'add' }, hidden: !canEdit() }, `Add to ${id}`)];
    }
    if (view.kind === 'link' && view.embeddable === 'pending') {
      return [
        h('div', { class: 'tile-checking', attrs: { role: 'status' } },
          h('span', { class: 'tile-spinner', attrs: { 'aria-hidden': 'true' } }),
          h('span', null, 'Checking link…')),
      ];
    }
    const nodes: Node[] = [];
    const info = (): HTMLElement => {
      const domain = view.kind === 'html' ? 'HTML page' : domainOf(view.url);
      const icon = view.icon
        ? h('img', { class: 'tile-icon', src: serverHref(serverUrl, view.icon), alt: '', draggable: false, referrerPolicy: 'no-referrer' })
        : null;
      icon?.addEventListener('error', () => icon.remove());
      return h('div', { class: 'tile-info' },
        icon,
        h('div', { class: 'tile-title' }, view.title || view.label || domain),
        h('div', { class: 'tile-domain' }, domain));
    };
    if (view.shotUrl) {
      const shot = h('img', { class: 'tile-shot', src: serverHref(serverUrl, view.shotUrl), alt: '', draggable: false, loading: 'lazy' });
      // A missing screenshot falls back to the title card.
      shot.addEventListener('error', () => shot.replaceWith(info()));
      nodes.push(shot);
    } else {
      nodes.push(info());
    }
    if (view.note) nodes.push(h('p', { class: 'tile-note' }, view.note));
    if (view.kind === 'link' && view.embeddable === 'unknown') {
      nodes.push(h('button', { type: 'button', class: 'tile-hint', dataset: { action: 'open' } }, 'Blank? Open in new tab'));
    }
    return nodes;
  }

  function ariaLabel(view: TileView): string {
    const id = slotName(view.slot);
    if (view.kind === 'empty') return `${id}, empty`;
    const what = view.title || (view.kind === 'html' ? 'HTML page' : domainOf(view.url));
    return [id, view.label, what].filter((s) => s).join(', ');
  }

  function renderTile(slot: SlotIndex): void {
    const p = parts[slot];
    if (!p) return;
    const view = state.tile(slot);
    const filled = view.kind !== 'empty';
    const edit = canEdit();

    p.tile.classList.remove(...STATE_CLASSES);
    p.tile.classList.add(`is-${view.kind}`);
    if (view.kind === 'link' && view.embeddable === 'pending') p.tile.classList.add('is-checking');
    if (filled && view.embeddable === 'no') p.tile.classList.add('is-blocked');
    p.tile.setAttribute('aria-label', ariaLabel(view));

    if (editing !== slot) {
      p.name.textContent = view.label;
      p.name.hidden = !filled;
      p.name.disabled = !edit;
      p.name.setAttribute('aria-label', `Rename ${slotName(slot)}: ${view.label}`);
    }
    p.badge.hidden = view.kind !== 'html';
    p.card.replaceChildren(...cardContent(view));

    p.open.hidden = !filled;
    p.replace.hidden = !filled || !edit;
    p.history.hidden = view.version === 0;
    p.clear.hidden = !filled || !teacher;
  }

  function render(): void {
    for (let slot = 0; slot < SLOT_COUNT; slot++) renderTile(slot);
  }

  function startRename(slot: SlotIndex): void {
    const p = parts[slot];
    if (!p || editing !== null || !canEdit()) return;
    const view = state.tile(slot);
    if (view.kind === 'empty') return;
    editing = slot;
    const input = h('input', {
      class: 'tile-name-input',
      type: 'text',
      value: view.label,
      maxLength: LIMITS.labelMax,
      attrs: { 'aria-label': `Name for ${slotName(slot)}`, autocomplete: 'off' },
    });
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const next = cleanText(input.value, LIMITS.labelMax);
      editing = null;
      input.replaceWith(p.name);
      renderTile(slot);
      if (save && next && next !== view.label) actions.rename(slot, next);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
        p.tile.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        p.tile.focus();
      }
    });
    input.addEventListener('blur', () => finish(false));
    p.name.replaceWith(input);
    input.focus();
    input.select();
  }

  function slotOf(el: Element): SlotIndex | null {
    const raw = el.closest<HTMLElement>('.tile')?.dataset.slot;
    const n = Number(raw);
    return raw !== undefined && Number.isInteger(n) && n >= 0 && n < SLOT_COUNT ? n : null;
  }

  function onClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const button = target?.closest<HTMLElement>('[data-action]');
    if (!button || !root.contains(button)) return;
    const slot = slotOf(button);
    if (slot === null) return;
    switch (button.dataset.action) {
      case 'add':
        actions.add(slot);
        break;
      case 'replace':
        actions.replace(slot);
        break;
      case 'history':
        actions.history(slot);
        break;
      case 'open':
        actions.open(slot);
        break;
      case 'clear':
        actions.clear(slot);
        break;
      case 'rename':
        startRename(slot);
        break;
      case 'back':
        actions.back();
        break;
      default:
        return;
    }
    e.stopPropagation();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLElement) || !e.target.classList.contains('tile')) return;
    const slot = slotOf(e.target);
    if (slot === null) return;
    e.preventDefault();
    actions.focus(slot);
  }

  function setLocked(on: boolean): void {
    locked = on;
    root.classList.toggle('is-locked', on);
    render();
  }

  for (let slot = 0; slot < SLOT_COUNT; slot++) parts.push(build(slot));
  root.replaceChildren(...parts.map((p) => p.tile));
  root.classList.toggle('is-locked', locked);
  render();
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  const subs: Unsubscribe[] = [
    state.on('snapshot', () => setLocked(state.locked())),
    state.on('tile', (view) => renderTile(view.slot)),
    state.on('locked', (on) => setLocked(on)),
  ];

  const part = (slot: SlotIndex): TileParts => {
    const p = parts[slot];
    if (!p) throw new RangeError(`No tile for slot ${slot}`);
    return p;
  };

  return {
    tileEl: (slot) => part(slot).tile,
    bodyEl: (slot) => part(slot).body,
    frameHost: (slot) => part(slot).frame,
    render,
    update: renderTile,
    setLocked,
    setTeacher(on: boolean) {
      teacher = on;
      render();
    },
    destroy() {
      for (const off of subs) off();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      root.replaceChildren();
      root.classList.remove('is-locked');
      parts.length = 0;
    },
  };
}
```

- [ ] **Step 9: Run it and confirm it passes**

Run: `npm test -w web -- grid`
Expected: PASS, `Tests  25 passed (25)`.

- [ ] **Step 10: Commit (orchestrator)**

```bash
git add web/index.html web/src/styles/base.css web/src/board/grid.ts web/src/board/grid.css web/test/grid.test.ts
git commit -m "feat(web): page shell, base styles and grid (U6)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U8: main.ts stage 1: board, camera, grid, socket, top bar

**Wave:** 4 · **Tier:** T2 (sonnet, medium) · **Depends on:** U1, U2, U3, U4, U5, U6, U7, C3, F5

**Files:**
- Create: `web/src/main.ts`

Stage 1 does master plan §5.6 startup steps 2–5 with no profile panel: the saved profile if there is one (`loadIdentity`, C3), otherwise `defaultProfile('Guest')`. Input only pans and zooms (`attachInput` does that itself); `doubleTap` fits the tile and the other handlers do nothing. Of the grid actions only `open` and `rename` work. It imports only modules from waves 2 and 3. There's no unit test for `main.ts`, and no web-wide `tsc` in wave 4 (other agents are writing web files); the check is a production build, which only follows `main.ts`'s own imports.

- [ ] **Step 1: Run the failing check**

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
npm run build -w web
```

Expected: FAIL, `[plugin vite:build-html] …/web/index.html` then `Error: Failed to resolve /src/main.ts from …/web/index.html`.

- [ ] **Step 2: Create `web/src/main.ts`**

```ts
import './styles/base.css';
import { defaultProfile } from '@class-board/shared/protocol';
import type { ErrorCode, Profile, SlotIndex } from '@class-board/shared/types';
import { createCamera } from './board/camera';
import { createGrid } from './board/grid';
import { attachInput } from './board/input';
import { BOARD, BOARD_ORIGIN, SERVER_URL } from './config';
import type { CameraState, GridActions, InputHandlers } from './contracts';
import { connectBoard, newReqId } from './net/socket';
import { loadIdentity } from './profile/storage';
import { createBoardState } from './state/boardState';
import { hideBanner, showBanner } from './ui/banner';
import { errorText, toast } from './ui/errors';
import { openHelp } from './ui/help';
import { mountTopBar } from './ui/topBar';
import { serverHref } from './util/url';

const UNREACHABLE_AFTER_MS = 8_000;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el;
}

/** Shows a toast for a failed request: the server's error text when there is a code, else a generic one. */
function report(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  const text = typeof code === 'string' ? errorText(code as ErrorCode) : undefined;
  toast(text || "That didn't work. Check your connection and try again.");
}

const topbarEl = byId('topbar');
const viewport = byId('viewport');
const world = byId('world');
const tilesEl = byId('tiles');

const { clientId, profile: saved } = loadIdentity();
// Stage 1 has no profile panel yet: a first visit joins as Guest.
const current: Profile = saved ?? defaultProfile('Guest');

const state = createBoardState(BOARD);
const camera = createCamera(viewport.clientWidth, viewport.clientHeight);

const socket = connectBoard({
  serverUrl: SERVER_URL,
  board: BOARD,
  hello: () => ({ type: 'hello', clientId, profile: current }),
});
socket.onMessage((m) => state.apply(m));

function openTile(slot: SlotIndex): void {
  const t = state.tile(slot);
  const href = t.url ?? (t.fileUrl ? serverHref(SERVER_URL, t.fileUrl) : null);
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

const actions: GridActions = {
  add: () => {},
  replace: () => {},
  history: () => {},
  open: openTile,
  clear: () => {},
  rename: (slot, label) => {
    socket
      .request({ type: 'rename', reqId: newReqId(), slot, baseVersion: state.tile(slot).version, label })
      .catch(report);
  },
  focus: () => {},
  back: () => {},
};

createGrid(tilesEl, state, actions, SERVER_URL);

const handlers: InputHandlers = {
  boardPointer: () => {},
  tap: () => {},
  doubleTap: (slot) => camera.fitSlot(slot),
  zoomBlocked: () => {},
  pointerLeft: () => {},
};
attachInput(viewport, camera, handlers);

const center = (factor: number): void => {
  const { w, h } = camera.viewport();
  camera.zoomAt(w / 2, h / 2, factor);
};
const topBar = mountTopBar(topbarEl, {
  zoomIn: () => center(1.25),
  zoomOut: () => center(0.8),
  fit: () => camera.fitBoard(),
  profile: () => {},
  help: () => openHelp(new URL(BOARD_ORIGIN).host),
});
topBar.setBoardName(BOARD);

function applyCamera({ s, tx, ty }: CameraState): void {
  world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  world.style.setProperty('--cam-s', String(s));
  topBar.setZoom(s);
}
camera.onChange(applyCamera);
applyCamera(camera.state());
new ResizeObserver(() => camera.setViewport(viewport.clientWidth, viewport.clientHeight)).observe(viewport);

function syncLocked(): void {
  if (state.locked()) showBanner('locked', 'The board is locked.', 'info');
  else hideBanner('locked');
}
function syncRate(): void {
  if (state.rate() === 0) {
    showBanner('cursors-paused', 'Cursors are paused until midnight UTC to stay within the free limit.', 'info');
  } else {
    hideBanner('cursors-paused');
  }
}
function syncPeople(): void {
  topBar.setPeopleCount(state.people().length);
}

let fitted = false;
state.on('snapshot', () => {
  if (!fitted) {
    fitted = true;
    camera.fitBoard();
  }
  syncLocked();
  syncRate();
  syncPeople();
});
state.on('locked', syncLocked);
state.on('rate', syncRate);
state.on('people', syncPeople);

let everOpen = false;
const unreachable = setTimeout(() => {
  if (!everOpen) {
    showBanner('unreachable', `Can't reach the board server at ${SERVER_URL}. If you're on a school network, ask IT to allow this address.`, 'error');
  }
}, UNREACHABLE_AFTER_MS);
socket.onStatus((status) => {
  if (status === 'open') {
    everOpen = true;
    clearTimeout(unreachable);
    hideBanner('unreachable');
    hideBanner('reconnecting');
  } else if (status === 'closed' && everOpen) {
    showBanner('reconnecting', 'Reconnecting…', 'warn');
  }
});
```

- [ ] **Step 3: Run the build and confirm it passes**

Run: `npm run build -w web`
Expected: PASS, `✓ built in …`, listing `dist/index.html`, one `dist/assets/index-*.css` and one `dist/assets/index-*.js`. (`web/dist` is gitignored by F1.) If the build reports an unresolved import, the module it names is from another workstream; report it as `blocked` instead of editing that module.

- [ ] **Step 4: Commit (orchestrator)**

```bash
git add web/src/main.ts
git commit -m "feat(web): main.ts stage 1 with board, camera, grid, socket and top bar (U8)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U9: main.ts stage 2: live frames, focus, dialogs, cursors, profile, people, teacher, banners

**Wave:** 5 · **Tier:** T4 (opus, high) · **Depends on:** U8, T2, T3, T4, T5, C2, C5, C6, C7, C8, C9, U7

**Files:**
- Modify: `web/src/main.ts`

This is the complete wiring of master plan §5.6. Decisions it makes where §5.6 leaves room:
- First visit: nothing is created until the profile panel's `onSave` has run `saveProfile(p)`. Then `start(clientId, profile)` builds everything.
- Order inside `start`: state, camera, socket, teacher, then grid (its actions reach `live` and `focus` through `let` bindings set right after), live frames, focus, local and remote cursors, and only then `socket.onMessage(m => state.apply(m))`. Every subscriber exists before the first message can arrive (messages are asynchronous).
- Adopting a teacher's cursor reset: main keeps a list of profiles it has sent. When `state.me()`'s profile matches one of them, it's an echo: that entry and older ones are dropped. Anything else that differs from `current` is adopted (`saveProfile`, `applyDesign`, top-bar preview). Comparing against "what I sent" rather than "what I have" means another person's update, or an old echo arriving after a newer save, can't revert the profile.
- Tapping a tile while a different tile is in use deactivates it first. An empty tile opens the post dialog when the board is unlocked or you're the teacher, which matches Grid's Add button.
- A server `error` with `reqId: null` answers no request: `full` shows the `limit` banner (`errorText('full')`), `not_ready` is ignored, and anything else is a toast.
- `pointerLeft` does nothing. `LocalCursorApi` has no "left" call, and others keep seeing the last position until the next move or `away`.
- `onJump`: a person on a tile → `camera.fitSlot`; otherwise → `camera.centerOn` at their last position from `'cursors'` events (pruned when people leave). Someone who hasn't moved yet can't be jumped to.

- [ ] **Step 1: Write the failing wiring check**

The check has no dependencies. Run it from the repo root:

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
node -e '
const src = require("fs").readFileSync("web/src/main.ts", "utf8");
const need = ["createLiveFrames", "createFocus", "openPostDialog", "openHistory", "createLocalCursor", "createRemoteCursors", "cursorImage", "openProfilePanel", "saveProfile", "createTeacher", "openTeacherPanel", "mountPeoplePanel", "uploadHtml", "window.__classBoard", "focus.start()"];
const missing = need.filter((n) => !src.includes(n));
if (missing.length) { console.error("FAIL: main.ts does not use " + missing.join(", ")); process.exit(1); }
console.log("wiring ok (" + need.length + " names)");
'
```

Expected: FAIL, `FAIL: main.ts does not use createLiveFrames, createFocus, openPostDialog, openHistory, createLocalCursor, createRemoteCursors, cursorImage, openProfilePanel, saveProfile, createTeacher, openTeacherPanel, mountPeoplePanel, uploadHtml, window.__classBoard, focus.start()`.

- [ ] **Step 2: Replace `web/src/main.ts` with the complete wiring**

```ts
import './styles/base.css';
import { tileRect } from '@class-board/shared/slots';
import type { ErrorCode, Person, Profile, ServerMsg, SlotIndex } from '@class-board/shared/types';
import { createCamera } from './board/camera';
import { createFocus } from './board/focus';
import { createGrid } from './board/grid';
import { attachInput } from './board/input';
import { createLiveFrames } from './board/liveFrames';
import { BOARD, BOARD_ORIGIN, SERVER_URL } from './config';
import type {
  CameraState, FocusApi, GridActions, HistoryDeps, InputHandlers, LiveFramesApi, LocalCursorApi, PostDialogDeps,
} from './contracts';
import { createLocalCursor } from './cursors/local';
import { createRemoteCursors } from './cursors/remote';
import { cursorImage } from './cursors/render';
import { connectBoard, newReqId } from './net/socket';
import { uploadHtml } from './net/upload';
import { mountPeoplePanel } from './people/peoplePanel';
import { openProfilePanel } from './profile/panel';
import { loadIdentity, saveProfile } from './profile/storage';
import { createBoardState } from './state/boardState';
import { createTeacher } from './teacher/teacher';
import { openTeacherPanel } from './teacher/teacherPanel';
import { openHistory } from './tiles/historyPanel';
import { openPostDialog } from './tiles/postDialog';
import { hideBanner, showBanner } from './ui/banner';
import { errorText, toast } from './ui/errors';
import { openHelp } from './ui/help';
import { mountTopBar } from './ui/topBar';
import { serverHref } from './util/url';

const UNREACHABLE_AFTER_MS = 8_000;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el;
}

/** Shows a toast for a failed request: the server's error text when there is a code, else a generic one. */
function report(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  const text = typeof code === 'string' ? errorText(code as ErrorCode) : undefined;
  toast(text || "That didn't work. Check your connection and try again.");
}

function sameProfile(a: Profile, b: Profile): boolean {
  if (a.name !== b.name || a.color !== b.color || a.cursor.kind !== b.cursor.kind) return false;
  if (a.cursor.kind === 'shape' && b.cursor.kind === 'shape') return a.cursor.shape === b.cursor.shape;
  if (a.cursor.kind === 'pixels' && b.cursor.kind === 'pixels') {
    return a.cursor.art === b.cursor.art && a.cursor.tip[0] === b.cursor.tip[0] && a.cursor.tip[1] === b.cursor.tip[1];
  }
  return false;
}

const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function start(clientId: string, initial: Profile): void {
  const topbarEl = byId('topbar');
  const viewport = byId('viewport');
  const world = byId('world');
  const tilesEl = byId('tiles');
  const cursorLayer = byId('cursor-layer');
  const hintEl = byId('hint');

  let current = initial;

  const state = createBoardState(BOARD);
  const camera = createCamera(viewport.clientWidth, viewport.clientHeight);
  const socket = connectBoard({
    serverUrl: SERVER_URL,
    board: BOARD,
    hello: () => ({ type: 'hello', clientId, profile: current }),
  });
  const teacher = createTeacher(socket);

  const postDeps: PostDialogDeps = {
    socket,
    state,
    upload: (html, fileName) => uploadHtml(SERVER_URL, BOARD, html, fileName),
    defaultLabel: () => current.name,
  };
  const historyDeps: HistoryDeps = {
    socket,
    state,
    serverUrl: SERVER_URL,
    canRestore: () => !state.locked() || teacher.active(),
  };
  const canEdit = (): boolean => !state.locked() || teacher.active();

  // Grid needs its actions before live frames and focus exist (both need the grid), so the
  // actions reach them through these bindings, which are set right after.
  let live: LiveFramesApi;
  let focus: FocusApi;
  let localCursor: LocalCursorApi;

  function openTile(slot: SlotIndex): void {
    const t = state.tile(slot);
    const href = t.url ?? (t.fileUrl ? serverHref(SERVER_URL, t.fileUrl) : null);
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }

  const actions: GridActions = {
    add: (slot) => openPostDialog(postDeps, slot, 'add'),
    replace: (slot) => openPostDialog(postDeps, slot, 'replace'),
    history: (slot) => openHistory(historyDeps, slot),
    open: openTile,
    clear: (slot) => {
      teacher.clear(slot).catch(report);
    },
    rename: (slot, label) => {
      socket
        .request({ type: 'rename', reqId: newReqId(), slot, baseVersion: state.tile(slot).version, label })
        .catch(report);
    },
    focus: (slot) => focus.enter(slot),
    back: () => focus.exit(),
  };

  const grid = createGrid(tilesEl, state, actions, SERVER_URL);
  live = createLiveFrames({
    grid,
    camera,
    state,
    serverUrl: SERVER_URL,
    boardOrigin: BOARD_ORIGIN,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
  focus = createFocus({ grid, live, camera, state, hintEl, serverUrl: SERVER_URL });
  localCursor = createLocalCursor({ viewport, socket });
  createRemoteCursors({ layer: cursorLayer, camera, state }).start();

  // Messages go to the state only after every subscriber above exists, so none misses the first snapshot.
  socket.onMessage((m: ServerMsg) => {
    state.apply(m);
    // Errors without a reqId aren't answers to a request, so no dialog will show them.
    if (m.type === 'error' && m.reqId === null) {
      if (m.code === 'full') showBanner('limit', errorText('full'), 'error');
      else if (m.code !== 'not_ready') toast(errorText(m.code));
    }
  });

  const handlers: InputHandlers = {
    boardPointer: (bx, by) => {
      if (focus.current() === null) localCursor.boardMove(bx, by);
      const active = live.active();
      // The board only sees moves once the pointer has left the in-use iframe.
      if (active !== null && !inRect(tileRect(active), bx, by)) live.deactivate();
    },
    tap: (slot) => {
      const active = live.active();
      if (slot === null) {
        live.deactivate();
        return;
      }
      if (active !== null && active !== slot) live.deactivate();
      if (state.tile(slot).kind === 'empty' && canEdit()) openPostDialog(postDeps, slot, 'add');
      else if (live.isLive(slot)) live.activate(slot);
    },
    doubleTap: (slot) => camera.fitSlot(slot),
    zoomBlocked: (slot) => focus.zoomBlocked(slot),
    // Nothing to send: other people keep seeing the last position until the next move or 'away'.
    pointerLeft: () => {},
  };
  attachInput(viewport, camera, handlers);

  /* ---------- top bar and camera ---------- */

  /** Profiles sent to the server whose echo hasn't come back yet. */
  const sent: Profile[] = [];

  async function showDesign(p: Profile): Promise<void> {
    await localCursor.applyDesign(p);
    topBar.setCursorPreview((await cursorImage(p)).url);
  }

  function adopt(p: Profile): void {
    current = p;
    saveProfile(p);
    showDesign(p).catch(() => topBar.setCursorPreview(null));
  }

  const center = (factor: number): void => {
    const { w, h } = camera.viewport();
    camera.zoomAt(w / 2, h / 2, factor);
  };
  const topBar = mountTopBar(topbarEl, {
    zoomIn: () => center(1.25),
    zoomOut: () => center(0.8),
    fit: () => camera.fitBoard(),
    profile: () =>
      openProfilePanel({
        initial: current,
        requireName: true,
        onSave: (p) => {
          adopt(p);
          sent.push(p);
          socket.send({ type: 'profile', profile: p });
        },
      }),
    help: () => openHelp(new URL(BOARD_ORIGIN).host),
  });
  topBar.setBoardName(BOARD);
  showDesign(current).catch(() => topBar.setCursorPreview(null));

  function applyCamera({ s, tx, ty }: CameraState): void {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  world.style.setProperty('--cam-s', String(s));
    topBar.setZoom(s);
  }
  camera.onChange(applyCamera);
  applyCamera(camera.state());
  new ResizeObserver(() => camera.setViewport(viewport.clientWidth, viewport.clientHeight)).observe(viewport);

  /* ---------- docking your cursor ---------- */

  live.onActiveChange((slot) => {
    if (slot !== null) localCursor.dock(slot, 'using');
    else if (focus.current() === null) localCursor.undock();
  });
  focus.onChange((slot) => {
    if (slot !== null) localCursor.dock(slot, 'viewing');
    else localCursor.undock();
  });

  /* ---------- teacher and people ---------- */

  function applyTeacher(on: boolean): void {
    grid.setTeacher(on);
    topBar.setTeacher(on);
    document.body.classList.toggle('is-teacher', on);
  }
  teacher.onChange(applyTeacher);
  applyTeacher(teacher.active());

  const lastPos = new Map<string, { x: number; y: number }>();
  state.on('cursors', (moves) => {
    for (const [id, x, y] of moves) lastPos.set(id, { x, y });
  });

  function onJump(person: Person): void {
    const at = person.presence;
    if (at.at === 'tile') {
      camera.fitSlot(at.slot);
      return;
    }
    const pos = lastPos.get(person.id);
    if (pos) camera.centerOn(pos.x, pos.y);
  }
  mountPeoplePanel({
    button: topBar.peopleButton,
    state,
    teacher,
    onJump,
    onTeacher: () => openTeacherPanel(teacher, state),
  });

  /* ---------- state → banners, rate, people ---------- */

  function syncLocked(): void {
    if (state.locked()) showBanner('locked', 'The board is locked.', 'info');
    else hideBanner('locked');
  }
  function syncRate(): void {
    const hz = state.rate();
    localCursor.setRate(hz);
    if (hz === 0) {
      showBanner('cursors-paused', 'Cursors are paused until midnight UTC to stay within the free limit.', 'info');
    } else {
      hideBanner('cursors-paused');
    }
  }
  function syncPeople(): void {
    topBar.setPeopleCount(state.people().length);
    const here = new Set(state.people().map((p) => p.id));
    for (const id of lastPos.keys()) if (!here.has(id)) lastPos.delete(id);
    adoptServerProfile();
  }
  // My profile as the server has it changes in two ways: an echo of a 'profile' message I sent,
  // and a teacher's cursor reset. Echoes are skipped (even an older one arriving after a newer
  // save); anything else that differs from `current` is adopted.
  function adoptServerProfile(): void {
    const mine = state.me()?.profile;
    if (!mine) return;
    const echo = sent.findIndex((p) => sameProfile(p, mine));
    if (echo !== -1) {
      sent.splice(0, echo + 1);
      return;
    }
    if (!sameProfile(mine, current)) adopt(mine);
  }

  let fitted = false;
  state.on('snapshot', () => {
    hideBanner('limit');
    syncLocked();
    syncRate();
    syncPeople();
    if (!fitted) {
      fitted = true;
      camera.fitBoard();
      focus.start();
    }
  });
  state.on('locked', syncLocked);
  state.on('rate', syncRate);
  state.on('people', syncPeople);

  /* ---------- connection banners ---------- */

  let everOpen = false;
  const unreachable = setTimeout(() => {
    if (!everOpen) {
      showBanner('unreachable', `Can't reach the board server at ${SERVER_URL}. If you're on a school network, ask IT to allow this address.`, 'error');
    }
  }, UNREACHABLE_AFTER_MS);
  socket.onStatus((status) => {
    if (status === 'open') {
      everOpen = true;
      clearTimeout(unreachable);
      hideBanner('unreachable');
      hideBanner('reconnecting');
    } else if (status === 'closed' && everOpen) {
      showBanner('reconnecting', 'Reconnecting…', 'warn');
    }
  });

  if (import.meta.env.DEV) window.__classBoard = { camera, state, live, focus };
}

const identity = loadIdentity();
if (identity.profile) {
  start(identity.clientId, identity.profile);
} else {
  // First visit: nothing connects until there's a name.
  openProfilePanel({
    initial: null,
    requireName: true,
    onSave: (p) => {
      saveProfile(p);
      start(identity.clientId, p);
    },
  });
}
```

- [ ] **Step 3: Run the wiring check again**

Run the same command as Step 1.
Expected: `wiring ok (15 names)`.

- [ ] **Step 4: Typecheck and build the web package**

Both are allowed in wave 5, because no other web task runs then.

```bash
npm run typecheck -w web
npm run build -w web
```

Expected: `typecheck` exits 0 with no output from `tsc`; `build` prints `✓ built in …`. A type error in another module's file is reported as `blocked` with the output, not fixed here.

- [ ] **Step 5: Manual smoke check (orchestrator, after the wave-5 barrier)**

Not for the executor. Start the servers in two terminals from the repo root (with `worker/.dev.vars` copied from `.dev.vars.example`, passcode `letmein`):

```bash
npm run dev:worker
npm run dev:web
```

Open `http://localhost:5173/?board=smoke` in two separate browser profiles or windows (A and B; one can be a private window so the saved profiles differ), then check:

1. **First run:** A shows the "Your cursor" panel, which Esc and the backdrop can't close. Save "Ana" with a color: the panel closes, the board fits the window, and the top bar shows "smoke" and "1 here". Reload: no panel.
2. **Cursors:** B saves "Ben". Both show "2 here". Moving the mouse over A's board shows Ana's cursor and name tag moving smoothly in B, and the other way round. Hiding A's tab hides Ana's cursor in B.
3. **Post and replace:** in A, click Add on C4 and post the link `https://example.com`. B sees C4 go to "Checking link…", then a card or a live page. Replace it from B's hover buttons: the dialog warns that it replaces Ana's tile, and A sees Ben's version.
4. **History restore:** open C4's History, restore Ana's version, and both windows show it. History now has three rows.
5. **Live embed click-to-use:** double-click C4 to zoom to it. Once it's live, click it: the border turns accent, the page takes the input, and B shows "Ana · using C4". Move the pointer off the tile, or press Esc: the tile is shielded again.
6. **Focus mode:** keep wheeling up over C4. "Keep zooming to open" appears, then the tile fills the window with only "← Back" and the URL ends in `#C4`. B shows "Ana · viewing C4". Back leaves; enter again and the browser's back button leaves too. Loading `http://localhost:5173/?board=smoke#C4` in a new tab opens focus mode once the board loads.
7. **Upload HTML:** Add on D1, HTML tab, paste `<!doctype html><title>Hi</title><h1>Hello</h1><script>try{localStorage.x=1;document.body.append(' storage open')}catch{document.body.append(' storage blocked')}</script>`. The tile shows the HTML badge and, when live, "Hello storage blocked". Open in new tab opens the Worker's copy.
8. **Teacher lock:** in A, people list → Teacher → passcode `letmein` → Lock. B shows "The board is locked." and no Add, Replace or rename; History still opens and its Restore is hidden. A (teacher) still sees Add and Clear. Unlock and both return to normal.
9. **Reconnect:** stop `dev:worker`. Both windows show "Reconnecting…" within a few seconds. Start it again: the banner clears and the tiles come back.
10. **Keyboard:** with the board focused, `+`, `-`, `0` and the arrow keys zoom, fit and pan. Tab to a tile and press Enter: focus mode opens.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add web/src/main.ts
git commit -m "feat(web): main.ts stage 2 with complete wiring (U9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
