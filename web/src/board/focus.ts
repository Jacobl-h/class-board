import { FOCUS } from '@class-board/shared/constants';
import { parseSlotName, slotName } from '@class-board/shared/slots';
import type { SlotIndex } from '@class-board/shared/types';
import type { FocusApi, FocusDeps, Unsubscribe } from '../contracts';
import './focus.css';

/**
 * A gap longer than this between blocked zoom-ins restarts the hold. It matches the hint's
 * lifetime, so slow mouse-wheel notches (often 300–500 ms apart) still count as one push.
 */
const HOLD_GAP_MS = 600;
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
