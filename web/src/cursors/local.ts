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
