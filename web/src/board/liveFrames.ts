import { SLOT_COUNT } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { Rect, SlotIndex, TileView } from '@class-board/shared/types';
import { originOf } from '@class-board/shared/urls';
import type { LiveFramesApi, LiveFramesDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { serverHref } from '../util/url';
import { chooseLive, EMPTY_MEMORY, liveEligible, type LiveCandidate, type LiveMemory } from './chooseLive';
import './frames.css';

const SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
  'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads',
];
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen';
const OFF_SCREEN: Rect = { x: -1e9, y: -1e9, w: 0, h: 0 };

interface Mounted {
  /** version + src: a change means the iframe must be replaced. */
  key: string;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  shield: HTMLDivElement;
  hint: HTMLButtonElement;
}

function frameSrc(view: TileView, serverUrl: string): string | null {
  if (view.kind === 'html') return view.fileUrl === null ? null : serverHref(serverUrl, view.fileUrl);
  return view.embedUrl;
}

function sandboxFor(view: TileView, src: string, boardOrigin: string): string {
  // Uploads never get allow-same-origin; neither do pages on the board's own origin,
  // which could otherwise script the board.
  const drop = view.kind === 'html' || originOf(src) === boardOrigin;
  return (drop ? SANDBOX.filter((t) => t !== 'allow-same-origin') : SANDBOX).join(' ');
}

export function createLiveFrames(deps: LiveFramesDeps): LiveFramesApi {
  const { grid, camera, state, serverUrl, boardOrigin } = deps;
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(() => fn()); });
  const deviceMemory = deps.deviceMemory ?? (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  const mounted = new Map<SlotIndex, Mounted>();
  const pinned = new Set<SlotIndex>();
  const listeners = new Set<(slot: SlotIndex | null) => void>();
  let memory: LiveMemory = EMPTY_MEMORY;
  let activeSlot: SlotIndex | null = null;
  let queued = false;
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function update(): void {
    if (queued || destroyed) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (!destroyed) run();
    });
  }

  function run(): void {
    const candidates: LiveCandidate[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const eligible = liveEligible(state.tile(slot));
      candidates.push({ slot, eligible, rect: eligible ? camera.slotScreenRect(slot) : OFF_SCREEN });
    }
    const forced = new Set(pinned);
    if (activeSlot !== null) forced.add(activeSlot);
    const result = chooseLive({ candidates, viewport: camera.viewport(), forced, deviceMemory, now: now(), memory });
    memory = result.memory;

    for (const slot of result.unmount) unmount(slot);
    for (const slot of result.live) if (mounted.has(slot)) refresh(slot);
    for (const slot of result.mount) mount(slot);
    if (activeSlot !== null && !mounted.has(activeSlot)) setActive(null);

    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (result.retryInMs !== null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        update();
      }, result.retryInMs);
    }
  }

  function makeIframe(view: TileView, src: string): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    // sandbox and allow must be in place before src starts the navigation.
    iframe.setAttribute('sandbox', sandboxFor(view, src, boardOrigin));
    iframe.setAttribute('allow', ALLOW);
    iframe.title = view.title ?? (view.label || slotName(view.slot));
    iframe.src = src;
    return iframe;
  }

  function mount(slot: SlotIndex): void {
    const view = state.tile(slot);
    const src = frameSrc(view, serverUrl);
    if (src === null) return;
    const host = grid.frameHost(slot);
    const iframe = makeIframe(view, src);
    const shield = h('div', { class: 'tile-shield' }) as HTMLDivElement;
    const hint = h('button', {
      type: 'button',
      class: 'tile-blank-hint',
      dataset: { action: 'open' },
      textContent: 'Blank? Open in new tab',
    }) as HTMLButtonElement;
    hint.hidden = view.embeddable !== 'unknown';
    host.append(iframe);
    if (slot !== activeSlot) host.append(shield);
    host.append(hint);
    mounted.set(slot, { key: `${view.version}|${src}`, host, iframe, shield, hint });
    applyClasses(slot);
  }

  function unmount(slot: SlotIndex): void {
    const m = mounted.get(slot);
    if (!m) return;
    m.iframe.remove();
    m.shield.remove();
    m.hint.remove();
    mounted.delete(slot);
    grid.tileEl(slot).classList.remove('is-live', 'is-active');
  }

  /** Re-check a mounted tile: new version or a re-rendered host → new iframe; hint and classes re-applied. */
  function refresh(slot: SlotIndex): void {
    const m = mounted.get(slot);
    if (!m) return;
    const view = state.tile(slot);
    const src = frameSrc(view, serverUrl);
    if (src === null) {
      unmount(slot);
      return;
    }
    if (m.key !== `${view.version}|${src}` || m.host !== grid.frameHost(slot) || !m.host.isConnected) {
      unmount(slot);
      mount(slot);
      return;
    }
    m.hint.hidden = view.embeddable !== 'unknown';
    applyClasses(slot);
  }

  /** Grid may rewrite a tile's classes when it re-renders, so these are re-applied on every pass. */
  function applyClasses(slot: SlotIndex): void {
    const tile = grid.tileEl(slot);
    tile.classList.add('is-live');
    tile.classList.toggle('is-active', slot === activeSlot);
  }

  function setActive(slot: SlotIndex | null): void {
    if (activeSlot === slot) return;
    const prev = activeSlot;
    activeSlot = slot;
    if (prev !== null) {
      const m = mounted.get(prev);
      if (m) m.host.insertBefore(m.shield, m.hint);
      grid.tileEl(prev).classList.remove('is-active');
    }
    if (slot !== null) {
      mounted.get(slot)?.shield.remove();
      grid.tileEl(slot).classList.add('is-active');
    }
    for (const fn of listeners) fn(slot);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && activeSlot !== null) api.deactivate();
  }

  const unsubs: Unsubscribe[] = [
    camera.onChange(() => update()),
    state.on('snapshot', () => update()),
    state.on('tile', () => update()),
  ];
  document.addEventListener('keydown', onKeyDown);

  const api: LiveFramesApi = {
    update,
    isLive: (slot) => mounted.has(slot),
    active: () => activeSlot,
    activate(slot) {
      if (!mounted.has(slot)) return;
      setActive(slot);
    },
    deactivate() {
      if (activeSlot === null) return;
      setActive(null);
      update();
    },
    pin(slot) {
      pinned.add(slot);
      update();
    },
    unpin(slot) {
      pinned.delete(slot);
      update();
    },
    onActiveChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      for (const u of unsubs) u();
      document.removeEventListener('keydown', onKeyDown);
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      for (const slot of [...mounted.keys()]) unmount(slot);
      activeSlot = null;
      listeners.clear();
    },
  };

  update();
  return api;
}
