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
