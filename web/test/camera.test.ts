import { describe, expect, it, vi } from 'vitest';
import { BOARD_H, BOARD_W } from '@class-board/shared/constants';
import { tileRect } from '@class-board/shared/slots';
import { createCamera } from '../src/board/camera';

const W = 1280;
const H = 800;
const C4 = 23;
const MIN_1280x800 = (W - 96) / BOARD_W; // width is the limiting side: 1184 / 5232
const MAX_1280x800 = 8 / 3; // a 480×300 tile exactly fits a 1280×800 viewport

describe('scale limits', () => {
  it('minScale fits the whole board with a 48 px margin on each side', () => {
    expect(createCamera(W, H).minScale()).toBeCloseTo(MIN_1280x800, 10);
    // Tall viewport: height is not the limit, width is.
    expect(createCamera(600, 1000).minScale()).toBeCloseTo((600 - 96) / BOARD_W, 10);
    // Very wide viewport: height is the limit.
    expect(createCamera(3000, 300).minScale()).toBeCloseTo((300 - 96) / BOARD_H, 10);
  });

  it('maxScaleForSlot makes a tile exactly fill the viewport on its limiting side, with no margin', () => {
    expect(createCamera(W, H).maxScaleForSlot(C4)).toBeCloseTo(MAX_1280x800, 10);
    expect(createCamera(1000, 800).maxScaleForSlot(C4)).toBeCloseTo(1000 / 480, 10);
    expect(createCamera(1600, 500).maxScaleForSlot(C4)).toBeCloseTo(500 / 300, 10);
  });

  it('maxScaleForSlot is the same for every slot', () => {
    const cam = createCamera(1111, 777);
    const values = [0, 9, 23, 70, 79].map((slot) => cam.maxScaleForSlot(slot));
    for (const v of values) expect(v).toBeCloseTo(values[0]!, 10);
  });

  it('never lets the largest scale fall below the smallest, even in a tiny viewport', () => {
    const cam = createCamera(50, 50);
    expect(cam.maxScaleForSlot(0)).toBeGreaterThanOrEqual(cam.minScale());
    expect(cam.minScale()).toBeGreaterThan(0);
  });
});


describe('initial state and conversions', () => {
  it('starts with the board fitted and centered', () => {
    const cam = createCamera(W, H);
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
    expect(tx).toBeCloseTo(48, 8);
  });

  it('toScreen and toBoard are inverses and follow x*s + tx', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(300, 200, 3);
    cam.panBy(-40, 25);
    const { s, tx, ty } = cam.state();
    const p = cam.toScreen(1000, 700);
    expect(p.x).toBeCloseTo(1000 * s + tx, 8);
    expect(p.y).toBeCloseTo(700 * s + ty, 8);
    const b = cam.toBoard(p.x, p.y);
    expect(b.x).toBeCloseTo(1000, 6);
    expect(b.y).toBeCloseTo(700, 6);
  });

  it('state() returns a copy and viewport() the current size', () => {
    const cam = createCamera(W, H);
    const copy = cam.state();
    copy.s = 99;
    expect(cam.state().s).not.toBe(99);
    expect(cam.viewport()).toEqual({ w: W, h: H });
  });
});


describe('zoomAt', () => {
  it('keeps the board point under the pointer fixed', () => {
    const cam = createCamera(W, H);
    for (const [sx, sy, factor] of [[400, 300, 2], [900, 500, 1.25], [640, 400, 0.8], [100, 700, 1.6]] as const) {
      const before = cam.toBoard(sx, sy);
      cam.zoomAt(sx, sy, factor);
      const after = cam.toBoard(sx, sy);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('multiplies the scale by the factor when it is inside the limits', () => {
    const cam = createCamera(W, H);
    const s0 = cam.state().s;
    const result = cam.zoomAt(600, 400, 2);
    expect(cam.state().s).toBeCloseTo(s0 * 2, 10);
    expect(result.blockedIn).toBe(false);
  });

  it('clamps zoom-out at minScale without reporting blockedIn', () => {
    const cam = createCamera(W, H);
    const before = cam.state();
    const result = cam.zoomAt(600, 400, 0.1);
    expect(cam.state()).toEqual(before);
    expect(result.blockedIn).toBe(false);
  });

  it('clamps zoom-in at the maximum and reports blockedIn', () => {
    const cam = createCamera(W, H);
    const result = cam.zoomAt(640, 400, 1000);
    expect(cam.state().s).toBeCloseTo(MAX_1280x800, 10);
    expect(result.blockedIn).toBe(true);
  });

  it('reports blockedIn again when already at the maximum, and does not change the camera', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(640, 400, 1000);
    const at = cam.state();
    const listener = vi.fn();
    cam.onChange(listener);
    expect(cam.zoomAt(640, 400, 1.05).blockedIn).toBe(true);
    expect(cam.zoomAt(640, 400, 1.0001).blockedIn).toBe(true);
    expect(cam.state()).toEqual(at);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not report blockedIn when zooming out from the maximum, or for a zoom-in that stops short of it', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(640, 400, 1000);
    expect(cam.zoomAt(640, 400, 0.5).blockedIn).toBe(false);
    expect(cam.zoomAt(640, 400, 1.2).blockedIn).toBe(false);
  });

  it('reports the slot nearest to the pointer', () => {
    const cam = createCamera(W, H);
    const r = tileRect(C4);
    const c = cam.toScreen(r.x + r.w / 2, r.y + r.h / 2);
    expect(cam.zoomAt(c.x, c.y, 1.5).slot).toBe(C4);
  });

  it('reports the nearest tile for a pointer that is off the board', () => {
    const cam = createCamera(W, H);
    expect(cam.toBoard(0, 0).x).toBeLessThan(0); // the top-left corner of the viewport is outside the board
    expect(cam.zoomAt(0, 0, 1.2).slot).toBe(0);
  });
});


describe('fit and center', () => {
  it('fitBoard returns to minScale with the board centered', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(200, 100, 5);
    cam.panBy(-300, 120);
    cam.fitBoard();
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
  });

  it('fitSlot goes to the maximum scale with the tile exactly filling a same-shaped viewport', () => {
    const cam = createCamera(W, H);
    cam.fitSlot(C4);
    expect(cam.state().s).toBeCloseTo(MAX_1280x800, 10);
    const r = cam.slotScreenRect(C4);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.w).toBeCloseTo(W, 6);
    expect(r.h).toBeCloseTo(H, 6);
  });

  it('fitSlot centers the tile in a viewport of a different shape', () => {
    const cam = createCamera(1000, 800);
    cam.fitSlot(0);
    const r = cam.slotScreenRect(0);
    expect(r.w).toBeCloseTo(1000, 6); // width is the limiting side
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y + r.h / 2).toBeCloseTo(400, 6);
    expect(r.h).toBeLessThan(800);
  });

  it('centerOn keeps the scale and puts the board point in the middle of the viewport', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    const s = cam.state().s;
    cam.centerOn(2000, 1500);
    expect(cam.state().s).toBe(s);
    const p = cam.toScreen(2000, 1500);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
  });

  it('slotScreenRect is the tile body in viewport pixels', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(500, 300, 3);
    const { s, tx, ty } = cam.state();
    const t = tileRect(C4);
    const r = cam.slotScreenRect(C4);
    expect(r.x).toBeCloseTo(t.x * s + tx, 8);
    expect(r.y).toBeCloseTo(t.y * s + ty, 8);
    expect(r.w).toBeCloseTo(480 * s, 8);
    expect(r.h).toBeCloseTo(300 * s, 8);
  });
});


describe('onChange', () => {
  it('fires after zoomAt, panBy, fitBoard, fitSlot and centerOn with the new state', () => {
    const cam = createCamera(W, H);
    const states: number[] = [];
    cam.onChange((st) => states.push(st.s));
    cam.zoomAt(600, 400, 2);
    cam.panBy(10, 10);
    cam.fitSlot(C4);
    cam.centerOn(100, 100);
    cam.fitBoard();
    expect(states).toHaveLength(5);
    expect(states[0]).toBeCloseTo(MIN_1280x800 * 2, 10);
    expect(states[2]).toBeCloseTo(MAX_1280x800, 10);
    expect(states[4]).toBeCloseTo(MIN_1280x800, 10);
  });

  it('passes a copy of the state', () => {
    const cam = createCamera(W, H);
    let seen: { s: number } | null = null;
    cam.onChange((st) => {
      seen = st;
    });
    cam.panBy(5, 5);
    seen!.s = 42;
    expect(cam.state().s).not.toBe(42);
  });

  it('does not fire when nothing changed', () => {
    const cam = createCamera(W, H);
    const fn = vi.fn();
    cam.onChange(fn);
    cam.panBy(0, 0);
    cam.zoomAt(600, 400, 1);
    cam.zoomAt(600, 400, 0.5); // already at minScale
    cam.fitBoard();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops after unsubscribe', () => {
    const cam = createCamera(W, H);
    const fn = vi.fn();
    const off = cam.onChange(fn);
    cam.panBy(5, 0);
    off();
    cam.panBy(5, 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/** Share of the viewport width (x) or height (y) that shows board. */
function visibleShare(cam: ReturnType<typeof createCamera>, axis: 'x' | 'y'): number {
  const { s, tx, ty } = cam.state();
  const { w, h } = cam.viewport();
  const [t, extent, size] = axis === 'x' ? [tx, BOARD_W * s, w] : [ty, BOARD_H * s, h];
  return Math.max(0, Math.min(t + extent, size) - Math.max(t, 0)) / size;
}

describe('pan limits', () => {
  it('keeps at least 25% of the viewport showing board after any pan', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, 1e6], [-1e6, -1e6]] as const) {
      cam.panBy(dx, dy);
      expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    }
  });

  it('stops exactly at the limit: tx in [need - boardW*s, viewportW - need] with need = min(0.25*viewportW, boardW*s)', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    const s = cam.state().s;
    cam.panBy(1e6, 1e6);
    expect(cam.state().tx).toBeCloseTo(W - 0.25 * W, 8);
    expect(cam.state().ty).toBeCloseTo(H - 0.25 * H, 8);
    cam.panBy(-1e6, -1e6);
    expect(cam.state().tx).toBeCloseTo(0.25 * W - BOARD_W * s, 6);
    expect(cam.state().ty).toBeCloseTo(0.25 * H - BOARD_H * s, 6);
  });

  it('never demands more than the whole board when the board is smaller than 25% of the viewport', () => {
    const cam = createCamera(3000, 300);
    const s = cam.state().s;
    const boardW = BOARD_W * s;
    expect(boardW).toBeLessThan(0.25 * 3000);
    cam.panBy(-1e6, 0);
    expect(cam.state().tx).toBeCloseTo(0, 8); // the board's right edge may not pass the viewport's left edge
    cam.panBy(1e6, 0);
    expect(cam.state().tx).toBeCloseTo(3000 - boardW, 8);
  });

  it('re-clamps after a zoom that would leave the board too far off screen', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    cam.panBy(-1e6, -1e6);
    cam.zoomAt(0, 0, 1 / 6); // zoom out: the same tx is now out of range for the smaller board
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('panBy moves the board by the given screen distance when inside the limits', () => {
    const cam = createCamera(W, H);
    const { tx, ty } = cam.state();
    cam.panBy(30, -20);
    expect(cam.state().tx).toBeCloseTo(tx + 30, 10);
    expect(cam.state().ty).toBeCloseTo(ty - 20, 10);
  });

  it('centerOn a point outside the board is limited by the pan limits', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    cam.centerOn(-50_000, -50_000);
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });
});

describe('setViewport', () => {
  it('refits the board when it was fitted before the resize', () => {
    const cam = createCamera(400, 300);
    cam.setViewport(W, H);
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
    expect(cam.viewport()).toEqual({ w: W, h: H });
  });

  it('re-clamps the scale to the new limits, keeping the middle of the view in the middle', () => {
    const cam = createCamera(W, H);
    cam.fitSlot(C4);
    const t = tileRect(C4);
    cam.setViewport(640, 400); // the maximum drops from 8/3 to 4/3
    expect(cam.state().s).toBeCloseTo(4 / 3, 10);
    const mid = cam.toBoard(320, 200);
    expect(mid.x).toBeCloseTo(t.x + t.w / 2, 6);
    expect(mid.y).toBeCloseTo(t.y + t.h / 2, 6);
  });

  it('re-clamps the pan for the new viewport', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    cam.panBy(1e6, 0); // board pushed as far right as allowed for a 1280 px wide viewport
    cam.setViewport(500, H);
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('notifies listeners when the size changed, even if the camera did not move, and stays quiet otherwise', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    const before = cam.state();
    const fn = vi.fn();
    cam.onChange(fn);
    cam.setViewport(W + 20, H);
    expect(cam.state().s).toBe(before.s);
    expect(fn).toHaveBeenCalledTimes(1);
    cam.setViewport(W + 20, H);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
