import { evictDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { COLORS, SLOT_COUNT } from '@class-board/shared/constants';
import { defaultProfile } from '@class-board/shared/protocol';
import { stateOf } from '../src/board';
import { closeAll, hello, inBoard, openClient, sleep, stubFor, uniqueBoard } from './helpers';

afterEach(() => closeAll());

describe('routing', () => {
  it('rejects a WebSocket upgrade from an origin that is not allowed', async () => {
    const res = await SELF.fetch(`http://localhost/parties/board/${uniqueBoard()}`, {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it('rejects a WebSocket upgrade without an Origin header', async () => {
    const res = await SELF.fetch(`http://localhost/parties/board/${uniqueBoard()}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts the development origin', async () => {
    const c = await openClient(uniqueBoard(), { origin: 'http://localhost:5173' });
    const snap = await hello(c, 'Dev');
    expect(snap.type).toBe('snapshot');
  });

  it('returns 404 for a bad board name, another party, a plain GET and unknown paths', async () => {
    const ws = { Upgrade: 'websocket', Origin: 'https://jacobl-h.github.io' };
    const bad = await SELF.fetch('http://localhost/parties/board/Bad_Name', { headers: ws });
    const long = await SELF.fetch(`http://localhost/parties/board/${'a'.repeat(41)}`, { headers: ws });
    const party = await SELF.fetch('http://localhost/parties/other/main', { headers: ws });
    const plain = await SELF.fetch('http://localhost/parties/board/main');
    const root = await SELF.fetch('http://localhost/');
    expect([bad.status, long.status, party.status, plain.status, root.status]).toEqual([404, 404, 404, 404, 404]);
  });
});

describe('hello and snapshot', () => {
  it('answers hello with a snapshot of 80 empty tiles, the lock, people and the rate', async () => {
    const board = uniqueBoard();
    const c = await openClient(board);
    const snap = await hello(c, 'Ana');
    expect(snap.board).toBe(board);
    expect(snap.you).toBe(c.id);
    expect(snap.tiles).toHaveLength(SLOT_COUNT);
    expect(snap.tiles[23]).toMatchObject({ slot: 23, version: 0, kind: 'empty' });
    expect(snap.locked).toBe(false);
    expect(snap.rate).toBe(5);
    expect(snap.people).toEqual([
      { id: c.id, clientId: 'client-Ana', profile: defaultProfile('Ana'), presence: { at: 'board' } },
    ]);
  });

  it('answers anything before hello with not_ready', async () => {
    const c = await openClient(uniqueBoard());
    c.send({ type: 'cursor', x: 1, y: 2 });
    c.send({ type: 'history', reqId: 'r1', slot: 0 });
    const first = await c.next('error');
    const second = await c.next('error');
    expect(first).toMatchObject({ code: 'not_ready', reqId: null });
    expect(second).toMatchObject({ code: 'not_ready', reqId: 'r1' });
  });

  it('answers an invalid message with invalid', async () => {
    const c = await openClient(uniqueBoard());
    await hello(c, 'Ana');
    c.send('not json');
    c.send({ type: 'cursor', x: 'left' });
    c.send({ type: 'nope' });
    for (let i = 0; i < 3; i++) expect(await c.next('error')).toMatchObject({ code: 'invalid', reqId: null });
    await sleep(100);
    expect(c.all('error')).toHaveLength(3);
  });
});

describe('people', () => {
  it('tells the others when someone joins, and not the joiner', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    const snap = await hello(b, 'Ben');
    const joined = await a.next('person');
    expect(joined).toMatchObject({ event: 'joined', person: { id: b.id, clientId: 'client-Ben', presence: { at: 'board' } } });
    expect(joined.person.profile.name).toBe('Ben');
    expect(snap.people.map((p) => p.profile.name).sort()).toEqual(['Ana', 'Ben']);
    expect(b.all('person')).toEqual([]);
  });

  it('tells the others when someone leaves', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    b.close();
    expect(await a.next('personLeft')).toEqual({ type: 'personLeft', id: b.id });
  });

  it('keeps a person who reconnected with the same id when the old socket closes late', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    // PartySocket reuses its _pk across reconnects, so the replacement carries the same id.
    const old = await openClient(`${board}?_pk=student-1`);
    await hello(old, 'Ben');
    const fresh = await openClient(`${board}?_pk=student-1`);
    const snap = await hello(fresh, 'Ben');
    expect(fresh.id).toBe('student-1');
    expect(snap.people.filter((p) => p.id === 'student-1')).toHaveLength(1);
    old.close();
    await sleep(150);
    expect(a.all('personLeft')).toEqual([]);
    fresh.close();
    expect(await a.next('personLeft')).toEqual({ type: 'personLeft', id: 'student-1' });
  });

  it('does not announce a connection that never said hello', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const lurker = await openClient(board);
    lurker.close();
    await sleep(150);
    expect(a.all('personLeft')).toEqual([]);
    expect(a.all('person')).toEqual([]);
  });

  it('broadcasts a profile update to everyone', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    await a.next('person');
    const profile = { name: 'Ana B', color: COLORS[3], cursor: { kind: 'shape', shape: 'star' } };
    a.send({ type: 'profile', profile });
    const seenByB = await b.next('person');
    const seenByA = await a.next('person');
    expect(seenByB).toEqual({ type: 'person', event: 'updated', person: { id: a.id, clientId: 'client-Ana', profile, presence: { at: 'board' } } });
    expect(seenByA).toEqual(seenByB);
  });

  it('rate-limits profile changes to 10 a minute', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    await inBoard(board, (b) => b.setSeams({ now: () => 1_000_000 }));
    for (let i = 0; i < 11; i++) a.send({ type: 'profile', profile: defaultProfile(`Ana ${i}`) });
    expect(await a.next('error')).toMatchObject({ code: 'rate_limited', reqId: null });
    expect(a.all('person')).toHaveLength(10);
  });

  it('marks a person docked on a tile, away, and back on the board when the cursor moves', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    a.send({ type: 'dock', slot: 23, mode: 'using' });
    expect((await b.next('person')).person.presence).toEqual({ at: 'tile', slot: 23, mode: 'using' });
    a.send({ type: 'dock', slot: 5, mode: 'viewing' });
    expect((await b.next('person')).person.presence).toEqual({ at: 'tile', slot: 5, mode: 'viewing' });
    a.send({ type: 'away' });
    expect((await b.next('person')).person.presence).toEqual({ at: 'away' });
    a.send({ type: 'cursor', x: 10, y: 20 });
    expect((await b.next('person')).person.presence).toEqual({ at: 'board' });
    expect(await b.next('cursors')).toEqual({ type: 'cursors', moves: [[a.id, 10, 20]] });
  });
});

describe('cursors', () => {
  it('batches moves into one message per connection, never echoing your own', async () => {
    const board = uniqueBoard();
    const [a, b, c] = await Promise.all([openClient(board), openClient(board), openClient(board)]);
    await hello(a!, 'Ana');
    await hello(b!, 'Ben');
    await hello(c!, 'Cai');
    a!.send({ type: 'cursor', x: 1, y: 1 });
    a!.send({ type: 'cursor', x: 2, y: 2 });
    b!.send({ type: 'cursor', x: 30, y: 40 });

    const toC = await c!.next('cursors', 2000, (m) => m.moves.length === 2);
    expect(toC.moves).toEqual(expect.arrayContaining([[a!.id, 2, 2], [b!.id, 30, 40]]));
    const toA = await a!.next('cursors');
    expect(toA.moves).toEqual([[b!.id, 30, 40]]);
    const toB = await b!.next('cursors');
    expect(toB.moves).toEqual([[a!.id, 2, 2]]);
    await sleep(250);
    for (const client of [a!, b!, c!]) {
      for (const m of client.all('cursors')) expect(m.moves.some(([id]) => id === client.id)).toBe(false);
    }
    expect(c!.all('cursors')).toHaveLength(1);
  });

  it('sends nothing to a lone mover', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    a.send({ type: 'cursor', x: 5, y: 5 });
    await sleep(250);
    expect(a.all('cursors')).toEqual([]);
  });

  it('drops cursor messages beyond the burst of 10', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    await inBoard(board, (brd) => brd.setSeams({ now: () => 5_000_000 }));
    for (let i = 1; i <= 15; i++) a.send({ type: 'cursor', x: i, y: i });
    const batch = await b.next('cursors');
    expect(batch.moves).toEqual([[a.id, 10, 10]]);
    await sleep(250);
    expect(b.all('cursors')).toHaveLength(1);
    expect(a.all('error')).toEqual([]);
  });
});

describe('daily budget', () => {
  it('slows cursors at 80%, pauses them at 90%, and ignores cursors while paused', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    // A fresh 10-message budget: every message below counts one.
    await inBoard(board, (brd) => brd.setSeams({ dailyBudget: 10 }));
    for (let i = 0; i < 8; i++) a.send({ type: 'away' });
    expect(await b.next('rate')).toEqual({ type: 'rate', hz: 2 });
    a.send({ type: 'away' });
    expect(await a.next('rate', 2000, (m) => m.hz === 0)).toEqual({ type: 'rate', hz: 0 });
    await b.next('rate', 2000, (m) => m.hz === 0);

    a.send({ type: 'cursor', x: 1, y: 1 });
    await sleep(250);
    expect(b.all('cursors')).toEqual([]);

    const c = await openClient(board);
    const snap = await hello(c, 'Cai');
    expect(snap.rate).toBe(0);
  });

  it('persists the count to meta when the last connection closes', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    a.send({ type: 'away' });
    await a.next('person');
    a.close();
    await sleep(100);
    const saved = await inBoard(board, (b) => ({ day: b.store.getMeta('budget_day'), count: b.store.getMeta('budget_count') }));
    expect(saved.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(saved.count)).toBe(2);
  });
});

describe('connections', () => {
  it('refuses connections over the cap with full, then closes them', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    await inBoard(board, (b) => b.setSeams({ maxConnections: 2 }));
    const b = await openClient(board);
    await hello(b, 'Ben');
    const c = await openClient(board);
    const closed = new Promise<number>((resolve) => c.ws.addEventListener('close', (e) => resolve(e.code)));
    expect(await c.next('error')).toMatchObject({ code: 'full', reqId: null });
    expect(await closed).toBe(1013);
  });

  it('keeps identity in connection state, which survives hibernation', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const b = await openClient(board);
    await hello(b, 'Ben');
    await a.next('person');

    const states = await inBoard(board, (brd) => [...brd.getConnections()].map((c) => stateOf(c)));
    expect(states.map((s) => s?.profile.name).sort()).toEqual(['Ana', 'Ben']);
    expect(states.every((s) => s?.ready === true && s.teacher === false)).toBe(true);

    // A seam marks this instance; after eviction a new instance must serve the same sockets.
    await inBoard(board, (brd) => brd.setSeams({ maxConnections: 99 }));
    await evictDurableObject(stubFor(board));
    a.send({ type: 'dock', slot: 3, mode: 'viewing' });
    const update = await b.next('person');
    expect(update.person).toEqual({
      id: a.id, clientId: 'client-Ana', profile: defaultProfile('Ana'), presence: { at: 'tile', slot: 3, mode: 'viewing' },
    });
    expect(await inBoard(board, (brd) => brd.seams.maxConnections)).toBeUndefined();
    b.send({ type: 'cursor', x: 7, y: 8 });
    expect(await a.next('cursors')).toEqual({ type: 'cursors', moves: [[b.id, 7, 8]] });
  });
});
