import { BOARD_H, BOARD_W } from '@class-board/shared/constants';
import { nearestSlot, tileRect } from '@class-board/shared/slots';
import type { Rect, SlotIndex } from '@class-board/shared/types';
import type { CameraApi, CameraState } from '../contracts';

/** Space kept around the board when it is fitted, in viewport px. */
export const FIT_MARGIN = 48;
/** Panning and zooming may never leave less than this share of the viewport (per axis) showing board. */
export const MIN_VISIBLE = 0.25;

export function createCamera(viewportW: number, viewportH: number): CameraApi {
  let vw = viewportW;
  let vh = viewportH;
  let s = 1;
  let tx = 0;
  let ty = 0;
  const listeners = new Set<(state: CameraState) => void>();

  const minScale = () => Math.max(0.01, Math.min((vw - 2 * FIT_MARGIN) / BOARD_W, (vh - 2 * FIT_MARGIN) / BOARD_H));
  // Every tile is the same size, so slot 0 stands in for all of them.
  const maxScaleForSlot = (slot: SlotIndex) => {
    const r = tileRect(slot);
    return Math.max(minScale(), Math.min(vw / r.w, vh / r.h));
  };
  const maxScale = () => maxScaleForSlot(0);

  /** Range of tx (or ty) that keeps at least `min(MIN_VISIBLE * viewport, board extent)` of the board on screen. */
  function panRange(viewport: number, boardExtent: number): [number, number] {
    const need = Math.min(MIN_VISIBLE * viewport, boardExtent * s);
    return [need - boardExtent * s, viewport - need];
  }

  function clampPan(): void {
    const [xLo, xHi] = panRange(vw, BOARD_W);
    const [yLo, yHi] = panRange(vh, BOARD_H);
    tx = Math.min(Math.max(tx, xLo), xHi);
    ty = Math.min(Math.max(ty, yLo), yHi);
  }

  const snapshot = (): CameraState => ({ s, tx, ty });

  function commit(before: CameraState, force = false): void {
    clampPan();
    if (!force && before.s === s && before.tx === tx && before.ty === ty) return;
    const state = snapshot();
    for (const fn of [...listeners]) fn({ ...state });
  }

  function setScaleAround(sx: number, sy: number, scale: number): void {
    const bx = (sx - tx) / s;
    const by = (sy - ty) / s;
    s = scale;
    tx = sx - bx * s;
    ty = sy - by * s;
  }

  function centerOnPoint(bx: number, by: number): void {
    tx = vw / 2 - bx * s;
    ty = vh / 2 - by * s;
  }

  function fitBoardState(): void {
    s = minScale();
    tx = (vw - BOARD_W * s) / 2;
    ty = (vh - BOARD_H * s) / 2;
  }

  fitBoardState();
  clampPan();

  const api: CameraApi = {
    state: snapshot,
    viewport: () => ({ w: vw, h: vh }),
    setViewport(w, h) {
      const before = snapshot();
      const changed = w !== vw || h !== vh;
      const wasFitted = Math.abs(s - minScale()) < 1e-9;
      const cx = (vw / 2 - tx) / s;
      const cy = (vh / 2 - ty) / s;
      vw = w;
      vh = h;
      if (wasFitted) {
        fitBoardState();
      } else {
        // The scale limits depend on the viewport; if the old scale is now out of range, keep the middle of the view fixed.
        const clamped = Math.min(Math.max(s, minScale()), maxScale());
        if (clamped !== s) {
          s = clamped;
          centerOnPoint(cx, cy);
        }
      }
      // Listeners always hear about a resized viewport, since what is on screen changed even if the camera did not.
      commit(before, changed);
    },
    minScale,
    maxScaleForSlot,
    toScreen: (bx, by) => ({ x: bx * s + tx, y: by * s + ty }),
    toBoard: (sx, sy) => ({ x: (sx - tx) / s, y: (sy - ty) / s }),
    zoomAt(sx, sy, factor) {
      const before = snapshot();
      const slot = nearestSlot((sx - tx) / s, (sy - ty) / s);
      const max = maxScale();
      const target = s * factor;
      setScaleAround(sx, sy, Math.min(Math.max(target, minScale()), max));
      commit(before);
      return { blockedIn: factor > 1 && target > max, slot };
    },
    panBy(dx, dy) {
      const before = snapshot();
      tx += dx;
      ty += dy;
      commit(before);
    },
    fitBoard() {
      const before = snapshot();
      fitBoardState();
      commit(before);
    },
    fitSlot(slot) {
      const before = snapshot();
      const r = tileRect(slot);
      s = maxScaleForSlot(slot);
      centerOnPoint(r.x + r.w / 2, r.y + r.h / 2);
      commit(before);
    },
    centerOn(bx, by) {
      const before = snapshot();
      centerOnPoint(bx, by);
      commit(before);
    },
    slotScreenRect(slot): Rect {
      const r = tileRect(slot);
      return { x: r.x * s + tx, y: r.y * s + ty, w: r.w * s, h: r.h * s };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return api;
}
