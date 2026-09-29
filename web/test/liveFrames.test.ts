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
