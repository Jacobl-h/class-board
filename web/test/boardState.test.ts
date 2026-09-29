import { describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { CursorMove, Person, ServerMsg, TileView } from '@class-board/shared/types';
import { createBoardState } from '../src/state/boardState';

const tileView = (slot: number, over: Partial<TileView> = {}): TileView => ({
  slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
  icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null, ...over,
});

const person = (id: string, name = id, at: Person['presence'] = { at: 'board' }): Person => ({
  id, clientId: `client-${id}`, profile: { name, color: '#D85A30', cursor: { kind: 'shape', shape: 'arrow' } }, presence: at,
});

function snapshot(over: Partial<Extract<ServerMsg, { type: 'snapshot' }>> = {}): ServerMsg {
  return {
    type: 'snapshot', board: 'main', you: 'a',
    tiles: Array.from({ length: SLOT_COUNT }, (_, slot) => tileView(slot)),
    locked: false, people: [person('a', 'Ana')], rate: 5, ...over,
  };
}

describe('before the first snapshot', () => {
  it('is not ready and reports empty placeholders', () => {
    const state = createBoardState('week-3');
    expect(state.board()).toBe('week-3');
    expect(state.ready()).toBe(false);
    expect(state.you()).toBeNull();
    expect(state.locked()).toBe(false);
    expect(state.rate()).toBe(5);
    expect(state.people()).toEqual([]);
    expect(state.me()).toBeUndefined();
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(state.tile(23)).toEqual({
      slot: 23, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
      icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
    });
  });

  it('returns a placeholder for a slot outside the board instead of throwing', () => {
    expect(createBoardState('main').tile(500).kind).toBe('empty');
  });
});

describe('snapshot', () => {
  it('replaces tiles, people, you, locked and rate, and sets ready', () => {
    const state = createBoardState('main');
    const posted = tileView(23, { version: 7, kind: 'link', label: 'Maya', url: 'https://example.com', embeddable: 'yes' });
    state.apply(snapshot({
      tiles: Array.from({ length: SLOT_COUNT }, (_, s) => (s === 23 ? posted : tileView(s))),
      locked: true, rate: 2, you: 'b', people: [person('a', 'Ana'), person('b', 'Ben')],
    }));
    expect(state.ready()).toBe(true);
    expect(state.tile(23)).toEqual(posted);
    expect(state.locked()).toBe(true);
    expect(state.rate()).toBe(2);
    expect(state.you()).toBe('b');
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b']);
    expect(state.me()?.profile.name).toBe('Ben');
    expect(state.person('a')?.profile.name).toBe('Ana');
    expect(state.person('zzz')).toBeUndefined();
  });

  it('places each tile by its slot even if the list arrives out of order or incomplete', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ tiles: [tileView(5, { version: 2 }), tileView(1, { version: 9 })] }));
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(state.tile(1).version).toBe(9);
    expect(state.tile(5).version).toBe(2);
    expect(state.tile(0).version).toBe(0);
  });

  it('replaces the previous state completely, as after a reconnect', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ locked: true, rate: 0, people: [person('a'), person('b')] }));
    state.apply({ type: 'tile', view: tileView(3, { version: 4, kind: 'html', label: 'x' }) });
    state.apply(snapshot({ locked: false, rate: 5, people: [person('a')] }));
    expect(state.locked()).toBe(false);
    expect(state.rate()).toBe(5);
    expect(state.people()).toHaveLength(1);
    expect(state.tile(3).version).toBe(0);
  });

  it('emits locked, rate, people and finally snapshot, with the new state already readable', () => {
    const state = createBoardState('main');
    const order: string[] = [];
    state.on('locked', (v) => order.push(`locked:${v}:${state.locked()}`));
    state.on('rate', (v) => order.push(`rate:${v}:${state.rate()}`));
    state.on('people', () => order.push(`people:${state.people().length}`));
    state.on('snapshot', () => order.push(`snapshot:${state.ready()}`));
    state.apply(snapshot({ locked: true, rate: 2 }));
    expect(order).toEqual(['locked:true:true', 'rate:2:2', 'people:1', 'snapshot:true']);
  });
});

describe('tile', () => {
  it('replaces one tile, leaves the others, and emits the view', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const before = state.tiles();
    const seen = vi.fn();
    state.on('tile', seen);
    const view = tileView(23, { version: 3, kind: 'link', label: 'Maya', embeddable: 'pending' });
    state.apply({ type: 'tile', view });
    expect(state.tile(23)).toEqual(view);
    expect(state.tile(22)).toBe(before[22]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(view);
    expect(state.tiles()).not.toBe(before);
    expect(before[23]!.version).toBe(0);
  });

  it('ignores a tile for a slot that does not exist', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('tile', seen);
    state.apply({ type: 'tile', view: tileView(80, { version: 1 }) });
    state.apply({ type: 'tile', view: tileView(-1, { version: 1 }) });
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('people', () => {
  it('adds a joined person and emits people', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const seen = vi.fn();
    state.on('people', seen);
    state.apply({ type: 'person', event: 'joined', person: person('b', 'Ben') });
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b']);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('replaces an updated person in place, keeping the order', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ people: [person('a', 'Ana'), person('b', 'Ben'), person('c', 'Cy')] }));
    state.apply({ type: 'person', event: 'updated', person: person('b', 'Benjamin', { at: 'tile', slot: 4, mode: 'using' }) });
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(state.person('b')?.profile.name).toBe('Benjamin');
    expect(state.person('b')?.presence).toEqual({ at: 'tile', slot: 4, mode: 'using' });
  });

  it('adds an updated person it has not seen, so a missed join heals itself', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    state.apply({ type: 'person', event: 'updated', person: person('z', 'Zed') });
    expect(state.person('z')?.profile.name).toBe('Zed');
  });

  it('removes a person who left and emits people; an unknown id does nothing', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ people: [person('a'), person('b')] }));
    const seen = vi.fn();
    state.on('people', seen);
    state.apply({ type: 'personLeft', id: 'b' });
    expect(state.people().map((p) => p.id)).toEqual(['a']);
    expect(seen).toHaveBeenCalledTimes(1);
    state.apply({ type: 'personLeft', id: 'nobody' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('me() follows the updated profile of your own connection', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ you: 'a', people: [person('a', 'Ana')] }));
    state.apply({ type: 'person', event: 'updated', person: person('a', 'Ana Reset') });
    expect(state.me()?.profile.name).toBe('Ana Reset');
  });
});

describe('locked and rate', () => {
  it('sets locked and emits it', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('locked', seen);
    state.apply({ type: 'locked', locked: true });
    expect(state.locked()).toBe(true);
    state.apply({ type: 'locked', locked: false });
    expect(state.locked()).toBe(false);
    expect(seen.mock.calls).toEqual([[true], [false]]);
  });

  it('sets the cursor rate and emits it', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('rate', seen);
    state.apply({ type: 'rate', hz: 0 });
    expect(state.rate()).toBe(0);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(0);
  });
});

describe('cursors', () => {
  it('only emits the moves; positions are not stored', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const moves: CursorMove[] = [['a', 10, 20], ['b', 30, 40]];
    const seen = vi.fn();
    state.on('cursors', seen);
    state.apply({ type: 'cursors', moves });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(moves);
    expect(state.people()).toHaveLength(1);
    expect(Object.keys(state.person('a')!).sort()).toEqual(['clientId', 'id', 'presence', 'profile']);
  });
});

describe('messages the socket handles', () => {
  it('ignores ok, historyResult and error without changing anything or emitting', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const seen = vi.fn();
    for (const event of ['snapshot', 'tile', 'people', 'locked', 'rate', 'cursors'] as const) state.on(event, seen);
    const tiles = state.tiles();
    state.apply({ type: 'ok', reqId: 'r1' });
    state.apply({ type: 'historyResult', reqId: 'r2', slot: 3, versions: [] });
    state.apply({ type: 'error', reqId: 'r3', code: 'conflict', message: 'stale' });
    expect(seen).not.toHaveBeenCalled();
    expect(state.tiles()).toBe(tiles);
  });
});

describe('subscriptions', () => {
  it('on() returns an unsubscribe function', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    const off = state.on('locked', seen);
    state.apply({ type: 'locked', locked: true });
    off();
    state.apply({ type: 'locked', locked: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the other listeners when one throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createBoardState('main');
    const after = vi.fn();
    state.on('rate', () => {
      throw new Error('boom');
    });
    state.on('rate', after);
    state.apply({ type: 'rate', hz: 2 });
    expect(after).toHaveBeenCalledWith(2);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
