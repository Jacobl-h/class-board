import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Board } from '../src/index';
import { BoardStore, filePath, shotPath, toSummary, toTileView, type NewVersion } from '../src/store';

let counter = 0;

/** Runs fn against a fresh, migrated store in its own Durable Object. */
function withStore<R>(fn: (store: BoardStore, sql: SqlStorage) => R | Promise<R>): Promise<R> {
  counter += 1;
  const stub = env.Board.get(env.Board.idFromName(`store-${counter}`)) as DurableObjectStub<Board>;
  return runInDurableObject(stub, async (_instance, state) => {
    const store = new BoardStore(state.storage.sql);
    store.migrate();
    return fn(store, state.storage.sql);
  });
}

function link(slot: number, over: Partial<NewVersion> = {}): NewVersion {
  return {
    slot, author_client: 'c1', author_name: 'Maya', kind: 'link', label: 'Maya',
    url: 'https://example.com/', embed_url: 'https://example.com/', file_id: null,
    title: null, icon: null, embeddable: 'pending', note: null, shot_id: null, thumb_url: null,
    ...over,
  };
}

describe('BoardStore', () => {
  it('migrates idempotently', async () => {
    const tables = await withStore((store, sql) => {
      store.migrate();
      store.migrate();
      return sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray().map((r) => r.name);
    });
    expect(tables).toEqual(expect.arrayContaining(['current', 'files', 'meta', 'shot_queue', 'shots', 'versions']));
  });

  it('inserts a version and makes it current', async () => {
    const out = await withStore((store) => {
      const row = store.insert(link(23), 1000);
      return { row, current: store.current(23), other: store.current(24), got: store.get(row.id) };
    });
    expect(out.row).toMatchObject({ slot: 23, created_at: 1000, kind: 'link', label: 'Maya', embeddable: 'pending' });
    expect(out.row.id).toBeGreaterThan(0);
    expect(out.current).toEqual(out.row);
    expect(out.got).toEqual(out.row);
    expect(out.other).toBeNull();
  });

  it('returns null for an unknown version id', async () => {
    expect(await withStore((store) => store.get(999))).toBeNull();
  });

  it('lists all current versions indexed by slot', async () => {
    const all = await withStore((store) => {
      store.insert(link(0), 1);
      const first = store.insert(link(79), 2);
      const second = store.insert(link(79, { label: 'Newer' }), 3);
      return { all: store.allCurrent(), first, second };
    });
    expect(all.all).toHaveLength(SLOT_COUNT);
    expect(all.all[0]?.slot).toBe(0);
    expect(all.all[79]?.id).toBe(all.second.id);
    expect(all.all[79]?.label).toBe('Newer');
    expect(all.all.filter((r) => r !== null)).toHaveLength(2);
  });

  it('patches only the given fields and returns the updated row', async () => {
    const out = await withStore((store) => {
      const row = store.insert(link(5), 1);
      const patched = store.patch(row.id, { embeddable: 'no', note: 'Blocked', title: 'Example' });
      const unchanged = store.patch(row.id, {});
      const missing = store.patch(12345, { title: 'x' });
      return { patched, unchanged, missing };
    });
    expect(out.patched).toMatchObject({ embeddable: 'no', note: 'Blocked', title: 'Example', icon: null, label: 'Maya' });
    expect(out.unchanged).toEqual(out.patched);
    expect(out.missing).toBeNull();
  });

  it('returns history newest first, limited', async () => {
    const out = await withStore((store) => {
      const ids = [1, 2, 3, 4].map((n) => store.insert(link(7, { label: `v${n}` }), n).id);
      store.insert(link(8), 5);
      return { ids, h: store.history(7, 3), all: store.history(7, 50) };
    });
    expect(out.h.map((r) => r.label)).toEqual(['v4', 'v3', 'v2']);
    expect(out.all.map((r) => r.id)).toEqual([...out.ids].reverse());
  });

  it('stores and returns uploaded files', async () => {
    const out = await withStore((store, sql) => {
      store.putFile('a'.repeat(32), '<p>héllo</p>', 'c1', 10);
      const size = sql.exec<{ size: number }>('SELECT size FROM files').one().size;
      return { html: store.getFile('a'.repeat(32)), missing: store.getFile('b'.repeat(32)), size };
    });
    expect(out.html).toBe('<p>héllo</p>');
    expect(out.missing).toBeNull();
    expect(out.size).toBe(13);
  });

  it('round-trips a binary JPEG', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0xff, 0xd9]);
    const out = await withStore((store) => {
      store.putShot('c'.repeat(32), bytes.buffer, 10);
      const got = store.getShot('c'.repeat(32));
      return { got: got ? [...new Uint8Array(got)] : null, missing: store.getShot('d'.repeat(32)) };
    });
    expect(out.got).toEqual([...bytes]);
    expect(out.missing).toBeNull();
  });

  it('runs the shot queue: due, retry, drop and next time', async () => {
    const out = await withStore((store) => {
      const empty = { due: store.dueShot(1000), next: store.nextShotAt() };
      store.enqueueShot(1, 500);
      store.enqueueShot(2, 2000);
      const firstDue = store.dueShot(1000);
      const notYet = store.dueShot(400);
      store.retryShot(1, 1, 3000);
      const afterRetry = { due: store.dueShot(1000), next: store.nextShotAt(), at3000: store.dueShot(3000) };
      store.dropShot(2);
      store.dropShot(1);
      store.enqueueShot(3, 100);
      store.enqueueShot(3, 50);
      return { empty, firstDue, notYet, afterRetry, requeued: store.dueShot(60), next: store.nextShotAt() };
    });
    expect(out.empty).toEqual({ due: null, next: null });
    expect(out.firstDue).toEqual({ versionId: 1, attempts: 0 });
    expect(out.notYet).toBeNull();
    expect(out.afterRetry.due).toBeNull();
    expect(out.afterRetry.next).toBe(2000);
    expect(out.afterRetry.at3000).toEqual({ versionId: 2, attempts: 0 });
    expect(out.requeued).toEqual({ versionId: 3, attempts: 0 });
    expect(out.next).toBe(50);
  });

  it('reads and overwrites meta values', async () => {
    const out = await withStore((store) => {
      const before = store.getMeta('locked');
      store.setMeta('locked', '1');
      store.setMeta('locked', '0');
      store.setMeta('budget_day', '2026-09-29');
      return { before, locked: store.getMeta('locked'), day: store.getMeta('budget_day') };
    });
    expect(out).toEqual({ before: null, locked: '0', day: '2026-09-29' });
  });
});

describe('paths and views', () => {
  const base = {
    id: 12, slot: 23, created_at: 5000, author_client: 'c1', author_name: 'Maya', label: 'My page',
    url: null, embed_url: null, file_id: null, title: null, icon: null, note: null, shot_id: null, thumb_url: null,
  } as const;

  it('builds file and shot paths', () => {
    expect(filePath('main', 'f1')).toBe('/boards/main/files/f1');
    expect(shotPath('week-3', 's1')).toBe('/boards/week-3/shots/s1');
  });

  it('shows a slot that was never posted to as empty version 0', () => {
    expect(toTileView('main', 4, null)).toEqual({
      slot: 4, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null,
      title: null, icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
    });
  });

  it('shows a cleared slot as empty with its version id', () => {
    const view = toTileView('main', 23, { ...base, kind: 'empty', label: '', embeddable: 'no' });
    expect(view).toMatchObject({ slot: 23, version: 12, kind: 'empty', label: '', authorName: null, createdAt: null });
  });

  it('shows a link with its screenshot path', () => {
    const view = toTileView('main', 23, {
      ...base, kind: 'link', url: 'https://example.com/', embed_url: 'https://example.com/',
      title: 'Example', icon: 'https://example.com/favicon.ico', embeddable: 'yes', shot_id: 'abc',
    });
    expect(view).toEqual({
      slot: 23, version: 12, kind: 'link', label: 'My page', url: 'https://example.com/',
      embedUrl: 'https://example.com/', fileUrl: null, title: 'Example', icon: 'https://example.com/favicon.ico',
      embeddable: 'yes', note: null, shotUrl: '/boards/main/shots/abc', authorName: 'Maya', createdAt: 5000,
    });
  });

  it('shows an html upload with its file path', () => {
    const view = toTileView('main', 23, { ...base, kind: 'html', file_id: 'f00d', title: 'Quiz', embeddable: 'yes' });
    expect(view).toMatchObject({ kind: 'html', fileUrl: '/boards/main/files/f00d', url: null, embedUrl: null, shotUrl: null });
  });

  it('uses the YouTube thumbnail when there is no screenshot', () => {
    const thumb = 'https://i.ytimg.com/vi/abc/hqdefault.jpg';
    const view = toTileView('main', 23, {
      ...base, kind: 'link', url: 'https://youtu.be/abc', embed_url: 'https://www.youtube-nocookie.com/embed/abc',
      embeddable: 'pending', thumb_url: thumb,
    });
    expect(view.shotUrl).toBe(thumb);
  });

  it('summarizes a version for history', () => {
    const summary = toSummary('main', { ...base, kind: 'html', file_id: 'f00d', title: 'Quiz', embeddable: 'yes', shot_id: 's9' });
    expect(summary).toEqual({
      id: 12, slot: 23, kind: 'html', label: 'My page', title: 'Quiz', url: null,
      fileUrl: '/boards/main/files/f00d', shotUrl: '/boards/main/shots/s9', authorName: 'Maya', createdAt: 5000,
    });
  });
});
