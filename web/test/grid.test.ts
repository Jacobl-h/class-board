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
