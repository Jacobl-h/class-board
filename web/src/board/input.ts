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
