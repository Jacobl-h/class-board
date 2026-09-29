import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS, CURSOR } from '@class-board/shared/constants';
import type { CursorMove, Person, Presence, Profile, SlotIndex } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, CameraApi, CameraState } from '../src/contracts';
import { createRemoteCursors } from '../src/cursors/remote';
import { cursorImage, shapeSvg } from '../src/cursors/render';

// Wraps the real renderer so the test can count how often an image is actually built.
vi.mock('../src/cursors/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/cursors/render')>();
  return { ...real, cursorImage: vi.fn(real.cursorImage) };
});

const ME = 'conn-me';
const ANA = 'conn-ana';
const BEN = 'conn-ben';

function profile(name: string, color: string = COLORS[3], shape: 'arrow' | 'star' = 'arrow'): Profile {
  return { name, color, cursor: { kind: 'shape', shape } };
}

function person(id: string, p: Profile, presence: Presence = { at: 'board' }): Person {
  return { id, clientId: `client-${id}`, profile: p, presence };
}

/** A BoardStateApi that only implements what the remote cursors read, with hand-driven events. */
function fakeState() {
  let people: Person[] = [];
  let you: string | null = ME;
  const listeners = new Map<keyof BoardStateEvents, Set<(payload: never) => void>>();
  const state = {
    you: () => you,
    people: () => people,
    person: (id: string) => people.find((p) => p.id === id),
    on(event: keyof BoardStateEvents, fn: (payload: never) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => void listeners.get(event)!.delete(fn);
    },
  } as unknown as BoardStateApi;
  const emit = <K extends keyof BoardStateEvents>(event: K, payload: BoardStateEvents[K]) => {
    for (const fn of [...(listeners.get(event) ?? [])]) (fn as (p: BoardStateEvents[K]) => void)(payload);
  };
  return {
    state,
    setPeople(next: Person[]) {
      people = next;
      emit('people', undefined);
    },
    /** Changes the list without announcing it, like a move that arrives ahead of its 'people' event. */
    setPeopleQuietly(next: Person[]) {
      people = next;
    },
    moves(list: CursorMove[]) {
      emit('cursors', list);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** A camera with a fixed transform that the test can change, and a tile at each slot's own place. */
function fakeCamera() {
  let cam: CameraState = { s: 1, tx: 0, ty: 0 };
  const listeners = new Set<(s: CameraState) => void>();
  const camera = {
    toScreen: (bx: number, by: number) => ({ x: bx * cam.s + cam.tx, y: by * cam.s + cam.ty }),
    slotScreenRect: (slot: SlotIndex) => ({ x: 100 + slot, y: 200 + slot, w: 480, h: 300 }),
    onChange(fn: (s: CameraState) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } as unknown as CameraApi;
  return {
    camera,
    set(next: CameraState) {
      cam = next;
      for (const fn of [...listeners]) fn(cam);
    },
    listenerCount: () => listeners.size,
  };
}

let time: number;
let frames: Array<() => void>;
let cancelled: number[];

const raf = (fn: () => void) => {
  frames.push(fn);
  return frames.length;
};
const caf = (id: number) => void cancelled.push(id);

/** Runs the animation frame that is currently queued. */
function frame(): void {
  const fn = frames.shift();
  fn?.();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let layer: HTMLElement;

function setup(initial: Person[] = []) {
  const s = fakeState();
  const c = fakeCamera();
  s.setPeople(initial);
  const cursors = createRemoteCursors({ layer, camera: c.camera, state: s.state, now: () => time, raf, caf });
  return { s, c, cursors };
}

/** A color as the DOM writes it back, so the test doesn't care whether it is stored as hex or rgb(). */
function asStyled(property: 'background' | 'color', value: string): string {
  const probe = document.createElement('i');
  probe.style[property] = value;
  return probe.style[property];
}

const cursorEl = (id: string) => layer.querySelector<HTMLElement>(`.cursor[data-person="${id}"]`);
const tagOf = (id: string) => cursorEl(id)!.querySelector<HTMLElement>('.cursor-tag')!;

beforeEach(() => {
  time = 10_000;
  frames = [];
  cancelled = [];
  layer = document.createElement('div');
  layer.id = 'cursor-layer';
  document.body.replaceChildren(layer);
  vi.mocked(cursorImage).mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('one cursor per other person', () => {
  it('adds a .cursor[data-person] for everyone except you', () => {
    const { cursors } = setup([person(ME, profile('Me')), person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    cursors.start();
    expect(layer.querySelectorAll('.cursor')).toHaveLength(2);
    expect(cursorEl(ME)).toBeNull();
    expect(cursorEl(ANA)).not.toBeNull();
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });

  it('holds an image and a name tag in each cursor', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    const el = cursorEl(ANA)!;
    expect(el.querySelector('img')).not.toBeNull();
    expect(el.querySelector('.cursor-tag')).not.toBeNull();
    cursors.stop();
  });

  it('adds a cursor when someone joins and removes it when they leave', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.setPeople([person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).not.toBeNull();
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(ANA)).toBeNull();
    expect(layer.querySelectorAll('.cursor')).toHaveLength(1);
    cursors.stop();
  });

  it('leaves the same element in place when the people list changes but the person does not', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    const before = cursorEl(ANA);
    s.setPeople([person(ANA, profile('Ana')), person(BEN, profile('Ben'))]);
    expect(cursorEl(ANA)).toBe(before);
    cursors.stop();
  });

  it('ignores moves for people it has never heard of', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    s.moves([['conn-ghost', 5, 5]]);
    expect(layer.querySelectorAll('.cursor')).toHaveLength(0);
    cursors.stop();
  });
});

describe('cursor look', () => {
  it('colors the tag with the profile color and picks the text color for contrast', () => {
    const { cursors } = setup([person(ANA, profile('Ana', '#EF9F27')), person(BEN, profile('Ben', '#534AB7'))]);
    cursors.start();
    frame();
    expect(tagOf(ANA).style.background).toBe(asStyled('background', '#EF9F27'));
    expect(tagOf(ANA).style.color).toBe(asStyled('color', '#1A1A1A'));
    expect(tagOf(BEN).style.background).toBe(asStyled('background', '#534AB7'));
    expect(tagOf(BEN).style.color).toBe(asStyled('color', '#FFFFFF'));
    cursors.stop();
  });

  it('shows the cursor design from cursorImage, shifted so the hot spot sits on the cursor position', async () => {
    const { cursors } = setup([person(ANA, profile('Ana', COLORS[3], 'star'))]);
    cursors.start();
    await settle();
    const img = cursorEl(ANA)!.querySelector('img')!;
    expect(decodeURIComponent(img.getAttribute('src')!)).toContain(shapeSvg('star', COLORS[3]));
    expect(img.getAttribute('width')).toBe('32');
    expect(img.style.left).toBe('-16px');
    expect(img.style.top).toBe('-16px');
    cursors.stop();
  });

  it('builds one image for everyone who shares a profile design', async () => {
    const shared = profile('Sam', COLORS[1]);
    const { s, cursors } = setup([person(ANA, shared), person(BEN, { ...shared })]);
    cursors.start();
    await settle();
    s.setPeople([person(ANA, shared), person(BEN, { ...shared }), person('conn-cy', { ...shared })]);
    await settle();
    expect(vi.mocked(cursorImage)).toHaveBeenCalledTimes(1);
    s.setPeople([person(ANA, profile('Sam', COLORS[2]))]);
    await settle();
    expect(vi.mocked(cursorImage)).toHaveBeenCalledTimes(2);
    cursors.stop();
  });

  it('updates the tag and the image when a person changes their profile', async () => {
    const { s, cursors } = setup([person(ANA, profile('Ana', COLORS[3], 'arrow'))]);
    cursors.start();
    await settle();
    frame();
    s.setPeople([person(ANA, profile('Anna', COLORS[0], 'star'))]);
    await settle();
    frame();
    expect(tagOf(ANA).textContent).toBe('Anna');
    expect(decodeURIComponent(cursorEl(ANA)!.querySelector('img')!.getAttribute('src')!)).toContain(shapeSvg('star', COLORS[0]));
    cursors.stop();
  });
});

describe('cursors on the board', () => {
  it('stays hidden until the person has moved', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    cursors.stop();
  });

  it('shows the name in the tag and moves through the camera to screen pixels', () => {
    const { s, c, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    c.set({ s: 2, tx: 10, ty: -20 });
    s.moves([[ANA, 100, 50]]);
    time += CURSOR.renderDelayMs;
    frame();
    const el = cursorEl(ANA)!;
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toBe('translate3d(210.0px, 80.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana');
    cursors.stop();
  });

  it('draws the cursor 200 ms behind, moving in a straight line between received positions', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 0, 0]]);
    time += 200;
    s.moves([[ANA, 100, 200]]);
    time += 100;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(50.0px, 100.0px, 0)');
    time += 100;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(100.0px, 200.0px, 0)');
    cursors.stop();
  });

  it('jumps instead of gliding after a gap of more than a second', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 0, 0]]);
    time += CURSOR.jumpGapMs + 1;
    s.moves([[ANA, 400, 400]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(400.0px, 400.0px, 0)');
    cursors.stop();
  });

  it('keeps the cursor where it was when the camera moves', () => {
    const { s, c, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 100, 100]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(100.0px, 100.0px, 0)');
    c.set({ s: 0.5, tx: 0, ty: 0 });
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(50.0px, 50.0px, 0)');
    cursors.stop();
  });

  it('does not draw your own cursor even if a move for you arrives', () => {
    const { s, cursors } = setup([person(ME, profile('Me'))]);
    cursors.start();
    s.moves([[ME, 1, 1]]);
    expect(layer.querySelectorAll('.cursor')).toHaveLength(0);
    cursors.stop();
  });

  it('shows a cursor that a move mentions before the people list has caught up', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    s.setPeopleQuietly([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).toBeNull();
    s.moves([[BEN, 5, 5]]);
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });
});

describe('cursors parked on a tile', () => {
  it('sits at the top-left of the tile with a "using" tag', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 23, mode: 'using' })]);
    cursors.start();
    frame();
    const el = cursorEl(ANA)!;
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toBe('translate3d(123.0px, 223.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana · using C4');
    cursors.stop();
  });

  it('says "viewing" for focus mode', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 79, mode: 'viewing' })]);
    cursors.start();
    frame();
    expect(tagOf(ANA).textContent).toBe('Ana · viewing H10');
    cursors.stop();
  });

  it('follows the tile when the camera moves', () => {
    const { c, cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 0, mode: 'using' })]);
    cursors.start();
    frame();
    const before = cursorEl(ANA)!.style.transform;
    const rect = c.camera.slotScreenRect(0);
    c.camera.slotScreenRect = () => ({ ...rect, x: rect.x + 40, y: rect.y + 10 });
    c.set({ s: 1, tx: 0, ty: 0 });
    expect(cursorEl(ANA)!.style.transform).not.toBe(before);
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(140.0px, 210.0px, 0)');
    cursors.stop();
  });

  it('moves from the board to a tile and back when presence changes', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    s.setPeople([person(ANA, profile('Ana'), { at: 'tile', slot: 1, mode: 'using' })]);
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(101.0px, 201.0px, 0)');
    s.setPeople([person(ANA, profile('Ana'), { at: 'board' })]);
    s.moves([[ANA, 30, 40]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.style.transform).toBe('translate3d(30.0px, 40.0px, 0)');
    expect(tagOf(ANA).textContent).toBe('Ana');
    cursors.stop();
  });
});

describe('away', () => {
  it('hides a cursor whose tab is hidden and shows it again on return', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(false);
    s.setPeople([person(ANA, profile('Ana'), { at: 'away' })]);
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    s.setPeople([person(ANA, profile('Ana'), { at: 'board' })]);
    frame();
    expect(cursorEl(ANA)!.hidden).toBe(false);
    cursors.stop();
  });

  it('keeps the element for an away person, so a returning cursor does not flash in the wrong place', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'away' })]);
    cursors.start();
    frame();
    expect(cursorEl(ANA)).not.toBeNull();
    expect(cursorEl(ANA)!.hidden).toBe(true);
    cursors.stop();
  });
});

describe('idle cursors', () => {
  function movedOnce() {
    const ctx = setup([person(ANA, profile('Ana'))]);
    ctx.cursors.start();
    ctx.s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    return ctx;
  }

  it('is not idle right after moving', () => {
    const { cursors } = movedOnce();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    expect(cursorEl(ANA)!.style.opacity).toBe('');
    cursors.stop();
  });

  it('is not idle at exactly idleMs, and is idle after it, at reduced opacity', () => {
    const { cursors } = movedOnce();
    time = 10_000 + CURSOR.idleMs;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    time += 1;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(true);
    expect(cursorEl(ANA)!.style.opacity).toBe(String(CURSOR.idleOpacity));
    cursors.stop();
  });

  it('comes back at full opacity as soon as the person moves', () => {
    const { s, cursors } = movedOnce();
    time += CURSOR.idleMs + 1_000;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(true);
    s.moves([[ANA, 20, 20]]);
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    expect(cursorEl(ANA)!.style.opacity).toBe('');
    cursors.stop();
  });

  it('does not fade a cursor that is parked on a tile, so its "using" tag stays readable', () => {
    const { cursors } = setup([person(ANA, profile('Ana'), { at: 'tile', slot: 5, mode: 'using' })]);
    cursors.start();
    frame();
    time += CURSOR.idleMs * 3;
    frame();
    expect(cursorEl(ANA)!.classList.contains('is-idle')).toBe(false);
    cursors.stop();
  });
});

describe('the animation loop', () => {
  it('draws once on start and queues the next frame', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    expect(frames).toHaveLength(0);
    cursors.start();
    expect(frames).toHaveLength(1);
    frame();
    expect(frames).toHaveLength(1);
    cursors.stop();
  });

  it('cancels the queued frame on stop', () => {
    const { cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    cursors.stop();
    expect(cancelled).toEqual([1]);
  });

  it('stops listening to state and camera on stop', () => {
    const { s, c, cursors } = setup([]);
    cursors.start();
    expect(s.listenerCount()).toBeGreaterThan(0);
    expect(c.listenerCount()).toBe(1);
    cursors.stop();
    expect(s.listenerCount()).toBe(0);
    expect(c.listenerCount()).toBe(0);
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).toBeNull();
  });

  it('subscribes only once when started twice', () => {
    const { s, c, cursors } = setup([]);
    cursors.start();
    const count = s.listenerCount();
    cursors.start();
    expect(s.listenerCount()).toBe(count);
    expect(c.listenerCount()).toBe(1);
    expect(frames).toHaveLength(1);
    cursors.stop();
  });

  it('can be started again after a stop', () => {
    const { s, cursors } = setup([]);
    cursors.start();
    cursors.stop();
    cursors.start();
    s.setPeople([person(BEN, profile('Ben'))]);
    expect(cursorEl(BEN)).not.toBeNull();
    cursors.stop();
  });

  it('does not touch the DOM for a cursor that has not changed', () => {
    const { s, cursors } = setup([person(ANA, profile('Ana'))]);
    cursors.start();
    s.moves([[ANA, 10, 10]]);
    time += CURSOR.renderDelayMs;
    frame();
    const writes = vi.fn();
    new MutationObserver(writes).observe(layer, { attributes: true, subtree: true, childList: true, characterData: true });
    frame();
    frame();
    return Promise.resolve().then(() => {
      expect(writes).not.toHaveBeenCalled();
      cursors.stop();
    });
  });
});
