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

  it('keeps the hold through slow wheel notches up to 600 ms apart', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(400);
    f.zoomBlocked(C4);
    expect(f.current()).toBe(C4);
  });

  it('restarts the hold after a gap of more than 600 ms', () => {
    vi.useFakeTimers();
    const f = start();
    f.zoomBlocked(C4);
    vi.advanceTimersByTime(601);
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
