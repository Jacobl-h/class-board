import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import type { ServerMsg, TileView } from '@class-board/shared/types';
import { NOTES } from '@class-board/shared/urls';
import { stateOf } from '../src/board';
import { closeAll, hello, inBoard, openClient, uniqueBoard, waitFor, type TestClient } from './helpers';

// Link checks (added in W4) run in the same isolate: never let them reach the real network.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<title>Stub</title>', { headers: { 'Content-Type': 'text/html' } })));
});
afterEach(() => {
  closeAll();
  vi.unstubAllGlobals();
});

const TEACHER = 'test-code';
let reqCounter = 0;

type Reply = Extract<ServerMsg, { type: 'ok' | 'error' | 'historyResult' }>;

/** Sends a request with a fresh reqId and resolves with the reply that carries it. */
async function request(c: TestClient, msg: Record<string, unknown>): Promise<Reply> {
  reqCounter += 1;
  const reqId = `r${reqCounter}`;
  c.send({ ...msg, reqId });
  let found: Reply | undefined;
  await waitFor(() => {
    found = c.log.find((m): m is Reply => 'reqId' in m && m.reqId === reqId);
    return found !== undefined;
  }, 2000, `reply to ${reqId}`);
  return found!;
}

async function setup(names: string[] = ['Ana']): Promise<{ board: string; clients: TestClient[] }> {
  const board = uniqueBoard();
  const clients: TestClient[] = [];
  for (const name of names) {
    const c = await openClient(board);
    await hello(c, name);
    clients.push(c);
  }
  return { board, clients };
}

function postLink(c: TestClient, slot: number, url: string, baseVersion = 0, label = 'My link') {
  return request(c, { type: 'post', slot, baseVersion, content: { kind: 'link', url }, label });
}

/**
 * The next `tile` broadcast for a slot with a version newer than `newerThan`. Link-check
 * results (W4) re-broadcast the same version, so they're skipped.
 */
async function nextTile(c: TestClient, slot: number, newerThan = 0): Promise<TileView> {
  return (await c.next('tile', 2000, (m) => m.view.slot === slot && m.view.version > newerThan)).view;
}

const FILE_ID = 'ab'.repeat(16);

describe('post', () => {
  it('posts a link, broadcasts the tile and replies ok', async () => {
    const { clients: [a, b] } = await setup(['Ana', 'Ben']);
    const reply = await postLink(a!, 23, ' https://example.com/page ', 0, 'Maya');
    expect(reply.type).toBe('ok');
    const view = await nextTile(b!, 23);
    expect(view).toMatchObject({
      slot: 23, kind: 'link', label: 'Maya', url: 'https://example.com/page', embedUrl: 'https://example.com/page',
      embeddable: 'pending', note: null, shotUrl: null, authorName: 'Ana', fileUrl: null,
    });
    expect(view.version).toBeGreaterThan(0);
    expect((await nextTile(a!, 23)).version).toBe(view.version);
  });

  it('defaults an empty label to the poster name', async () => {
    const { clients: [a] } = await setup(['Ana']);
    await postLink(a!, 1, 'https://example.com/', 0, '  \u0007 ');
    expect((await nextTile(a!, 1)).label).toBe('Ana');
  });

  it('keeps the YouTube thumbnail as the screenshot', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 2, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const view = await nextTile(a!, 2);
    expect(view).toMatchObject({
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', embeddable: 'pending',
      shotUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
  });

  it('marks a newer Claude artifact as not embeddable with a note', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 3, 'https://claude.ai/artifact/abc-123');
    const view = await nextTile(a!, 3);
    expect(view).toMatchObject({ url: 'https://claude.ai/artifact/abc-123', embedUrl: null, embeddable: 'no', note: NOTES.claudeNew });
  });

  it('embeds a published Claude artifact through /embed', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 4, 'https://claude.ai/public/artifacts/abc-123');
    expect((await nextTile(a!, 4)).embedUrl).toBe('https://claude.ai/public/artifacts/abc-123/embed');
  });

  it('rejects a link that fails the URL rules with invalid', async () => {
    const { clients: [a] } = await setup();
    expect(await postLink(a!, 5, 'ftp://example.com/')).toMatchObject({ type: 'error', code: 'invalid' });
    expect(await postLink(a!, 5, 'http://localhost:8080/')).toMatchObject({ type: 'error', code: 'invalid' });
    expect(a!.all('tile')).toEqual([]);
  });

  it('posts an uploaded HTML file with its title', async () => {
    const { board, clients: [a] } = await setup();
    await inBoard(board, (b) => b.store.putFile(FILE_ID, '<html><title> Quiz  time </title><p>hi</p></html>', 'c1', 1));
    const reply = await request(a!, { type: 'post', slot: 6, baseVersion: 0, content: { kind: 'html', fileId: FILE_ID }, label: 'Quiz' });
    expect(reply.type).toBe('ok');
    expect(await nextTile(a!, 6)).toMatchObject({
      // checkUpload collapses whitespace in titles, as browsers do when they show them.
      kind: 'html', title: 'Quiz time', embeddable: 'yes', url: null, embedUrl: null,
      fileUrl: `/boards/${board}/files/${FILE_ID}`,
    });
  });

  it('rejects an HTML post whose file does not exist with not_found', async () => {
    const { clients: [a] } = await setup();
    const missing = await request(a!, { type: 'post', slot: 6, baseVersion: 0, content: { kind: 'html', fileId: 'cd'.repeat(16) }, label: 'Quiz' });
    expect(missing).toMatchObject({ type: 'error', code: 'not_found' });
    expect(a!.all('tile')).toEqual([]);
  });

  it('rejects a post based on a stale version with conflict', async () => {
    const { clients: [a, b] } = await setup(['Ana', 'Ben']);
    await postLink(a!, 7, 'https://example.com/a');
    const first = await nextTile(b!, 7);
    expect(await postLink(b!, 7, 'https://example.com/b', 0)).toMatchObject({ type: 'error', code: 'conflict' });
    expect(await postLink(b!, 7, 'https://example.com/b', first.version + 1)).toMatchObject({ type: 'error', code: 'conflict' });
    expect(await postLink(b!, 7, 'https://example.com/b', first.version)).toMatchObject({ type: 'ok' });
  });

  it('rate-limits edits to 10 a minute', async () => {
    const { board, clients: [a] } = await setup();
    await inBoard(board, (b) => b.setSeams({ now: () => 2_000_000 }));
    for (let i = 0; i < 10; i++) expect((await postLink(a!, 10 + i, 'https://example.com/')).type).toBe('ok');
    expect(await postLink(a!, 30, 'https://example.com/')).toMatchObject({ type: 'error', code: 'rate_limited' });
  });
});

describe('rename and restore', () => {
  it('renames by saving a new version with the same content', async () => {
    const { clients: [a, b] } = await setup(['Ana', 'Ben']);
    await postLink(a!, 8, 'https://example.com/', 0, 'Old name');
    const v1 = await nextTile(a!, 8);
    expect(await request(b!, { type: 'rename', slot: 8, baseVersion: v1.version, label: 'New name' })).toMatchObject({ type: 'ok' });
    const v2 = await nextTile(a!, 8, v1.version);
    expect(v2.version).toBeGreaterThan(v1.version);
    expect(v2).toMatchObject({ label: 'New name', url: v1.url, embedUrl: v1.embedUrl, kind: 'link', authorName: 'Ben' });
  });

  it('rejects renaming an empty tile, an empty label, or a stale version', async () => {
    const { clients: [a] } = await setup();
    expect(await request(a!, { type: 'rename', slot: 9, baseVersion: 0, label: 'x' })).toMatchObject({ code: 'invalid' });
    await postLink(a!, 9, 'https://example.com/');
    const v1 = await nextTile(a!, 9);
    expect(await request(a!, { type: 'rename', slot: 9, baseVersion: v1.version, label: '   ' })).toMatchObject({ code: 'invalid' });
    expect(await request(a!, { type: 'rename', slot: 9, baseVersion: 0, label: 'x' })).toMatchObject({ code: 'conflict' });
  });

  it('restores an old version as a new version', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 11, 'https://example.com/one', 0, 'One');
    const v1 = await nextTile(a!, 11);
    await postLink(a!, 11, 'https://example.com/two', v1.version, 'Two');
    const v2 = await nextTile(a!, 11, v1.version);
    expect(await request(a!, { type: 'restore', slot: 11, baseVersion: v2.version, versionId: v1.version })).toMatchObject({ type: 'ok' });
    const v3 = await nextTile(a!, 11, v2.version);
    expect(v3.version).toBeGreaterThan(v2.version);
    expect(v3).toMatchObject({ label: 'One', url: 'https://example.com/one' });
  });

  it('rejects restoring a version from another slot or an unknown version with not_found', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 12, 'https://example.com/');
    const other = await nextTile(a!, 12);
    await postLink(a!, 13, 'https://example.com/');
    const mine = await nextTile(a!, 13);
    expect(await request(a!, { type: 'restore', slot: 13, baseVersion: mine.version, versionId: other.version })).toMatchObject({ code: 'not_found' });
    expect(await request(a!, { type: 'restore', slot: 13, baseVersion: mine.version, versionId: 99999 })).toMatchObject({ code: 'not_found' });
  });
});

describe('history', () => {
  it('returns the versions of a slot newest first', async () => {
    const { clients: [a] } = await setup();
    await postLink(a!, 14, 'https://example.com/1', 0, 'First');
    const v1 = await nextTile(a!, 14);
    await postLink(a!, 14, 'https://example.com/2', v1.version, 'Second');
    const v2 = await nextTile(a!, 14, v1.version);
    const reply = await request(a!, { type: 'history', slot: 14 });
    expect(reply.type).toBe('historyResult');
    if (reply.type !== 'historyResult') return;
    expect(reply.slot).toBe(14);
    expect(reply.versions.map((v) => [v.id, v.label])).toEqual([[v2.version, 'Second'], [v1.version, 'First']]);
    expect(reply.versions[0]).toMatchObject({ slot: 14, kind: 'link', url: 'https://example.com/2', authorName: 'Ana', fileUrl: null });
    expect((await request(a!, { type: 'history', slot: 15 }))).toMatchObject({ type: 'historyResult', versions: [] });
  });

  it('keeps at most 50 versions in the result', async () => {
    const { board, clients: [a] } = await setup();
    await inBoard(board, (b) => {
      for (let i = 0; i < 55; i++) {
        b.store.insert({
          slot: 16, author_client: 'c', author_name: 'Ana', kind: 'link', label: `v${i}`, url: 'https://example.com/',
          embed_url: 'https://example.com/', file_id: null, title: null, icon: null, embeddable: 'yes', note: null,
          shot_id: null, thumb_url: null,
        }, i);
      }
    });
    const reply = await request(a!, { type: 'history', slot: 16 });
    expect(reply.type === 'historyResult' && reply.versions.length).toBe(50);
    expect(reply.type === 'historyResult' && reply.versions[0]!.label).toBe('v54');
  });

  it('rate-limits history to 30 a minute', async () => {
    const { board, clients: [a] } = await setup();
    await inBoard(board, (b) => b.setSeams({ now: () => 3_000_000 }));
    for (let i = 0; i < 30; i++) expect((await request(a!, { type: 'history', slot: 0 })).type).toBe('historyResult');
    expect(await request(a!, { type: 'history', slot: 0 })).toMatchObject({ type: 'error', code: 'rate_limited' });
  });
});

describe('teacher', () => {
  it('checks the passcode and marks the connection as teacher', async () => {
    const { board, clients: [a] } = await setup();
    expect(await request(a!, { type: 'teacher', code: TEACHER, action: 'check' })).toMatchObject({ type: 'ok' });
    const teacher = await inBoard(board, (b) => [...b.getConnections()].map((c) => stateOf(c)?.teacher));
    expect(teacher).toEqual([true]);
  });

  it('rejects a wrong passcode with bad_code, then locks out after 5 wrong tries', async () => {
    const { clients: [a] } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(await request(a!, { type: 'teacher', code: 'nope', action: 'check' })).toMatchObject({ code: 'bad_code' });
    }
    expect(await request(a!, { type: 'teacher', code: TEACHER, action: 'check' })).toMatchObject({ code: 'locked_out' });
  });

  it('re-checks the passcode on every action', async () => {
    const { clients: [a] } = await setup();
    await request(a!, { type: 'teacher', code: TEACHER, action: 'check' });
    expect(await request(a!, { type: 'teacher', code: 'wrong', action: 'lock' })).toMatchObject({ code: 'bad_code' });
  });

  it('locks and unlocks the board for everyone, and remembers it', async () => {
    const { board, clients: [t, s] } = await setup(['Teacher', 'Sam']);
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'lock' })).toMatchObject({ type: 'ok' });
    expect(await s!.next('locked')).toEqual({ type: 'locked', locked: true });
    const late = await openClient(board);
    expect((await hello(late, 'Late')).locked).toBe(true);
    expect(await inBoard(board, (b) => b.store.getMeta('locked'))).toBe('1');
    await request(t!, { type: 'teacher', code: TEACHER, action: 'unlock' });
    expect(await s!.next('locked')).toEqual({ type: 'locked', locked: false });
  });

  it('blocks student edits on a locked board but lets the teacher edit', async () => {
    const { clients: [t, s] } = await setup(['Teacher', 'Sam']);
    await postLink(s!, 17, 'https://example.com/');
    const v1 = await nextTile(s!, 17);
    await request(t!, { type: 'teacher', code: TEACHER, action: 'lock' });
    expect(await postLink(s!, 18, 'https://example.com/')).toMatchObject({ code: 'locked' });
    expect(await request(s!, { type: 'rename', slot: 17, baseVersion: v1.version, label: 'x' })).toMatchObject({ code: 'locked' });
    expect(await request(s!, { type: 'restore', slot: 17, baseVersion: v1.version, versionId: v1.version })).toMatchObject({ code: 'locked' });
    expect((await request(s!, { type: 'history', slot: 17 })).type).toBe('historyResult');
    await request(t!, { type: 'teacher', code: TEACHER, action: 'check' });
    expect(await postLink(t!, 18, 'https://example.com/')).toMatchObject({ type: 'ok' });
  });

  it('clears a tile to a new empty version, even when locked, and the clear can be undone', async () => {
    const { clients: [t, s] } = await setup(['Teacher', 'Sam']);
    await postLink(s!, 19, 'https://example.com/', 0, 'Sam');
    const v1 = await nextTile(s!, 19);
    await request(t!, { type: 'teacher', code: TEACHER, action: 'lock' });
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'clear', slot: 19 })).toMatchObject({ type: 'ok' });
    const cleared = await nextTile(s!, 19, v1.version);
    expect(cleared).toMatchObject({ kind: 'empty', label: '', url: null });
    expect(cleared.version).toBeGreaterThan(v1.version);
    await request(t!, { type: 'teacher', code: TEACHER, action: 'check' });
    expect(await request(t!, { type: 'restore', slot: 19, baseVersion: cleared.version, versionId: v1.version })).toMatchObject({ type: 'ok' });
    expect(await nextTile(s!, 19, cleared.version)).toMatchObject({ kind: 'link', label: 'Sam' });
  });

  it('rejects clear without a slot and resetCursor without a target with invalid', async () => {
    const { clients: [t] } = await setup(['Teacher']);
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'clear' })).toMatchObject({ code: 'invalid' });
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'resetCursor' })).toMatchObject({ code: 'invalid' });
  });

  it('resets a person cursor to the arrow, keeping name and color', async () => {
    const { clients: [t, s] } = await setup(['Teacher', 'Sam']);
    const fancy = { name: 'Sam', color: COLORS[4], cursor: { kind: 'shape', shape: 'star' } };
    s!.send({ type: 'profile', profile: fancy });
    await t!.next('person', 2000, (m) => m.person.id === s!.id && m.event === 'updated');
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'resetCursor', target: s!.id })).toMatchObject({ type: 'ok' });
    const update = await s!.next('person', 2000, (m) => m.person.profile.cursor.kind === 'shape' && m.person.profile.cursor.shape === 'arrow');
    expect(update).toMatchObject({ event: 'updated', person: { id: s!.id, profile: { ...fancy, cursor: { kind: 'shape', shape: 'arrow' } } } });
  });

  it('rejects resetting an unknown person with not_found', async () => {
    const { clients: [t] } = await setup(['Teacher']);
    expect(await request(t!, { type: 'teacher', code: TEACHER, action: 'resetCursor', target: 'nobody' })).toMatchObject({ code: 'not_found' });
  });
});
