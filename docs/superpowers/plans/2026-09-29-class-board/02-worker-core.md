# Worker core: the Board Durable Object

These four tasks build the server's heart: `BoardStore`, the typed SQLite layer every other
worker module reads and writes (W1); the `Board` Durable Object that accepts WebSockets,
answers `hello` with a snapshot, tracks people and presence in hibernation-safe connection
state, batches cursors and enforces the daily message budget (W2); the tile edits (post,
rename, restore, history and every teacher action) with conflicts, locks and rate limits (W3);
and the content pipeline: link checks after posting, the upload/file/screenshot HTTP routes
and the screenshot alarm (W4). Everything was built and run in a scratch copy of the repo
layout on 2026-09-29 before this plan was written: all 77 Durable Object tests below passed
at each stage (W1: 17, W2: +20, W3: +26, W4: +14), and `tsc --noEmit` was clean for `src` and `test`.

**Third-party APIs used**

- `partyserver` 0.5.10 — <https://github.com/cloudflare/partykit/tree/main/packages/partyserver> (README in the package). Confirmed by running it:
  - `class X extends Server<Env>` with `static options = { hibernate: true }`. Hooks: `onStart()`, `onConnect(conn, ctx)`, `onMessage(conn, message)`, `onClose(conn, code, reason, wasClean)`, `onError`, `onRequest(request)`, `onAlarm()`. Never override `alarm()`, `fetch()` or `webSocket*()`.
  - `onStart` runs lazily (inside `blockConcurrencyWhile`) on the first `fetch`, WebSocket event or alarm after the object starts or wakes from hibernation. **`runInDurableObject` does not run it**, so a seam call made before the first request sees an un-started board.
  - `this.name` comes from `ctx.id.name` (set by `idFromName`), and it's available after hibernation and in alarms.
  - `broadcast(msg, without?)`, `getConnections()` (only OPEN sockets, rebuilt from the runtime after hibernation), `getConnection(id)`.
  - `connection.setState(s)` / `connection.state` are stored in the WebSocket attachment and survive hibernation. The type is `ImmutableObject<T> | null` (deeply readonly), so `board.ts` reads it through a `stateOf()` cast.
  - The connection id is the client's `?_pk=` query parameter (PartySocket sets it), or a random nanoid.
  - `routePartykitRequest(req, env, { onBeforeConnect, onBeforeRequest, prefix })`: matches `/parties/<kebab binding>/<name>`. Returning a `Response` from either hook short-circuits; an unknown party returns 400, so `index.ts` pre-checks the path to answer 404.
  - `getServerByName(ns, name)` makes a `setName` RPC and then returns the stub, so each forwarded request costs two Durable Object calls.
  - `Server<Env extends Cloudflare.Env>`: our `Env` satisfies it. `env.Board` must be cast to `DurableObjectNamespace<Board>` for `getServerByName`.
  - A server-initiated `conn.close(1013, 'full')` reaches the client with code 1013.
- `@cloudflare/vitest-plugin` 1.3.3 (successor of `@cloudflare/vitest-pool-workers`, whose last release is 0.22.0) with `vitest` 4.1.11. Docs: <https://developers.cloudflare.com/workers/testing/vitest-integration/>. F1 owns the configs; these tests only rely on:
  - `import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test'` (`env` and `SELF` are marked deprecated in favour of `cloudflare:workers` but work).
  - `SELF.fetch(url, { headers: { Upgrade: 'websocket', Origin } })` returns status 101 with `res.webSocket`; call `accept()`, then send and receive.
  - `runInDurableObject(stub, (instance, state) => …)` gives the live instance and `state.storage.sql`. The instance's `ctx` is `protected` in the types, so use `state`.
  - `evictDurableObject(stub)` hibernates the object's WebSockets and drops the instance: used to prove connection state survives hibernation.
  - **Storage is isolated per test file, not per test**, so every test uses a unique board name.
  - Durable Objects run in the test's isolate: closures passed in through `runInDurableObject`, and `vi.stubGlobal('fetch', …)`, reach the object's code. But a promise created inside a Durable Object's I/O context can't be resolved from the test's context ("Cannot perform I/O on behalf of a different Durable Object"), so resolve such promises inside `runInDurableObject`.
- Workers runtime types (`@cloudflare/workers-types` 5.x): `SqlStorage.exec<T>()` requires `T` to have an index signature, so `store.ts` casts rows through one helper. `sql.exec(…, ArrayBuffer)` stores a BLOB and reads back an `ArrayBuffer`; `INSERT … RETURNING *` and `ON CONFLICT … DO UPDATE` work. `ctx.storage.getAlarm()` / `setAlarm(ms)` schedule the alarm.

**Test conventions for this file.** Durable Object tests live in `worker/test/*.test.ts` and run
with `npm run test:do -w worker -- <name>`. Every test uses a fresh board from `uniqueBoard()`.
Clocks that matter (token buckets, the upload limiter) are frozen through the Board's `now`
seam. Cursor batching uses the real 100 ms timer; tests wait for messages rather than sleeping,
except where they assert that nothing arrives. No test touches the network: link checks use a
seam or a stubbed global `fetch`, and screenshots use a fake `Shooter`.

**Internal interfaces defined here** (not used by other workstreams):
- `board.ts` exports `ConnState`, `BoardConn`, `stateOf()`, `BoardSeams`, `ERROR_TEXT` and `Board`. `Board` has the public fields `store`, `budget`, `locked` and `seams`, and the test seam `setSeams()`.
- `tiles.ts` exports `TileHost`, `TileMsg` and `handleTileMsg()`.
- `content.ts` exports `ContentHost`, `ShooterSession`, `createUploadLimiter()`, `afterPost()`, `runAlarm()` and `handleHttp()`.

---

### Task W1: BoardStore (SQLite)

**Wave:** 2 · **Tier:** T2 (sonnet, medium) · **Depends on:** F1, F2

**Files:**
- Create: `worker/src/store.ts`
- Test: `worker/test/store.test.ts`

The tests run inside the `Board` Durable Object through `runInDurableObject`. In wave 2 that's
F1's placeholder `Board` in `worker/src/index.ts`; later waves replace it and these tests keep
working, because they build their own `BoardStore` on `state.storage.sql`.

- [ ] **Step 1: Write the failing test**

Create `worker/test/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:do -w worker -- store`
Expected: FAIL. The suite doesn't load because `../src/store` doesn't exist yet ("Cannot find module '../src/store'" or "Failed to load url ../src/store"); 0 tests run.

- [ ] **Step 3: Implement `worker/src/store.ts`**

```ts
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Embeddable, TileKind, TileView, VersionSummary } from '@class-board/shared/types';

export interface VersionRow {
  id: number;
  slot: number;
  created_at: number;
  author_client: string;
  author_name: string;
  kind: TileKind;
  label: string;
  url: string | null;
  embed_url: string | null;
  file_id: string | null;
  title: string | null;
  icon: string | null;
  embeddable: Embeddable;
  note: string | null;
  shot_id: string | null;
  thumb_url: string | null;
}

export type NewVersion = Omit<VersionRow, 'id' | 'created_at'>;
export type VersionPatch = Partial<Pick<VersionRow, 'title' | 'icon' | 'embeddable' | 'note' | 'shot_id'>>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS versions (
     id INTEGER PRIMARY KEY, slot INTEGER NOT NULL, created_at INTEGER NOT NULL,
     author_client TEXT NOT NULL, author_name TEXT NOT NULL, kind TEXT NOT NULL,
     url TEXT, embed_url TEXT, file_id TEXT, label TEXT NOT NULL,
     title TEXT, icon TEXT, embeddable TEXT NOT NULL, note TEXT, shot_id TEXT, thumb_url TEXT)`,
  `CREATE INDEX IF NOT EXISTS versions_slot ON versions (slot, id)`,
  `CREATE TABLE IF NOT EXISTS current (slot INTEGER PRIMARY KEY, version_id INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, html TEXT NOT NULL, size INTEGER NOT NULL,
     created_at INTEGER NOT NULL, author_client TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, jpeg BLOB NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shot_queue (version_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL, not_before INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const PATCHABLE = ['title', 'icon', 'embeddable', 'note', 'shot_id'] as const;

// SqlStorage.exec<T> needs an index signature, which our row interfaces don't have.
function rows<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T[] {
  return cursor.toArray() as unknown as T[];
}

export class BoardStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  current(slot: number): VersionRow | null {
    return rows<VersionRow>(this.sql.exec(
      'SELECT v.* FROM current c JOIN versions v ON v.id = c.version_id WHERE c.slot = ?', slot,
    ))[0] ?? null;
  }

  allCurrent(): Array<VersionRow | null> {
    const out: Array<VersionRow | null> = new Array(SLOT_COUNT).fill(null);
    for (const row of rows<VersionRow>(this.sql.exec(
      'SELECT v.* FROM current c JOIN versions v ON v.id = c.version_id',
    ))) {
      if (row.slot >= 0 && row.slot < SLOT_COUNT) out[row.slot] = row;
    }
    return out;
  }

  insert(v: NewVersion, now: number): VersionRow {
    const row = rows<VersionRow>(this.sql.exec(
      `INSERT INTO versions (slot, created_at, author_client, author_name, kind, url, embed_url, file_id,
         label, title, icon, embeddable, note, shot_id, thumb_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      v.slot, now, v.author_client, v.author_name, v.kind, v.url, v.embed_url, v.file_id,
      v.label, v.title, v.icon, v.embeddable, v.note, v.shot_id, v.thumb_url,
    ))[0]!;
    this.sql.exec(
      `INSERT INTO current (slot, version_id) VALUES (?, ?)
       ON CONFLICT (slot) DO UPDATE SET version_id = excluded.version_id`,
      v.slot, row.id,
    );
    return row;
  }

  get(id: number): VersionRow | null {
    return rows<VersionRow>(this.sql.exec('SELECT * FROM versions WHERE id = ?', id))[0] ?? null;
  }

  patch(id: number, p: VersionPatch): VersionRow | null {
    const keys = PATCHABLE.filter((k) => p[k] !== undefined);
    if (keys.length === 0) return this.get(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => p[k] ?? null);
    return rows<VersionRow>(this.sql.exec(
      `UPDATE versions SET ${sets} WHERE id = ? RETURNING *`, ...values, id,
    ))[0] ?? null;
  }

  history(slot: number, limit: number): VersionRow[] {
    return rows<VersionRow>(this.sql.exec(
      'SELECT * FROM versions WHERE slot = ? ORDER BY id DESC LIMIT ?', slot, limit,
    ));
  }

  putFile(id: string, html: string, authorClient: string, now: number): void {
    const size = new TextEncoder().encode(html).byteLength;
    this.sql.exec(
      'INSERT INTO files (id, html, size, created_at, author_client) VALUES (?, ?, ?, ?, ?)',
      id, html, size, now, authorClient,
    );
  }

  getFile(id: string): string | null {
    return rows<{ html: string }>(this.sql.exec('SELECT html FROM files WHERE id = ?', id))[0]?.html ?? null;
  }

  putShot(id: string, jpeg: ArrayBuffer, now: number): void {
    this.sql.exec('INSERT INTO shots (id, jpeg, created_at) VALUES (?, ?, ?)', id, jpeg, now);
  }

  getShot(id: string): ArrayBuffer | null {
    return rows<{ jpeg: ArrayBuffer }>(this.sql.exec('SELECT jpeg FROM shots WHERE id = ?', id))[0]?.jpeg ?? null;
  }

  enqueueShot(versionId: number, notBefore: number): void {
    this.sql.exec(
      `INSERT INTO shot_queue (version_id, attempts, not_before) VALUES (?, 0, ?)
       ON CONFLICT (version_id) DO UPDATE SET attempts = 0, not_before = excluded.not_before`,
      versionId, notBefore,
    );
  }

  dueShot(now: number): { versionId: number; attempts: number } | null {
    const row = rows<{ version_id: number; attempts: number }>(this.sql.exec(
      'SELECT version_id, attempts FROM shot_queue WHERE not_before <= ? ORDER BY not_before, version_id LIMIT 1', now,
    ))[0];
    return row ? { versionId: row.version_id, attempts: row.attempts } : null;
  }

  retryShot(versionId: number, attempts: number, notBefore: number): void {
    this.sql.exec('UPDATE shot_queue SET attempts = ?, not_before = ? WHERE version_id = ?', attempts, notBefore, versionId);
  }

  dropShot(versionId: number): void {
    this.sql.exec('DELETE FROM shot_queue WHERE version_id = ?', versionId);
  }

  nextShotAt(): number | null {
    return rows<{ t: number | null }>(this.sql.exec('SELECT MIN(not_before) AS t FROM shot_queue'))[0]?.t ?? null;
  }

  getMeta(key: string): string | null {
    return rows<{ value: string }>(this.sql.exec('SELECT value FROM meta WHERE key = ?', key))[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, value,
    );
  }
}

export function filePath(board: string, fileId: string): string {
  return `/boards/${board}/files/${fileId}`;
}

export function shotPath(board: string, shotId: string): string {
  return `/boards/${board}/shots/${shotId}`;
}

export function toTileView(board: string, slot: number, row: VersionRow | null): TileView {
  if (!row || row.kind === 'empty') {
    return {
      slot, version: row?.id ?? 0, kind: 'empty', label: '',
      url: null, embedUrl: null, fileUrl: null, title: null, icon: null,
      embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
    };
  }
  return {
    slot,
    version: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    embedUrl: row.embed_url,
    fileUrl: row.file_id ? filePath(board, row.file_id) : null,
    title: row.title,
    icon: row.icon,
    embeddable: row.embeddable,
    note: row.note,
    shotUrl: row.shot_id ? shotPath(board, row.shot_id) : row.thumb_url,
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}

export function toSummary(board: string, row: VersionRow): VersionSummary {
  return {
    id: row.id,
    slot: row.slot,
    kind: row.kind,
    label: row.label,
    title: row.title,
    url: row.url,
    fileUrl: row.file_id ? filePath(board, row.file_id) : null,
    shotUrl: row.shot_id ? shotPath(board, row.shot_id) : row.thumb_url,
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:do -w worker -- store`
Expected: PASS, 17 tests in `test/store.test.ts`.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add worker/src/store.ts worker/test/store.test.ts
git commit -m "feat(worker): BoardStore (SQLite) (W1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task W2: Board Durable Object core: connect, hello, snapshot, profile, cursors, presence, budget, WS routing

**Wave:** 3 · **Tier:** T4 (opus, high) · **Depends on:** W1, F2, F5 (`parseClientMsg`, `defaultProfile`), X2 (`createConnLimits`, `DailyBudget`), X4 (`parseOrigins`)

**Files:**
- Create: `worker/src/board.ts`, `worker/test/board.session.test.ts`, `worker/test/helpers.ts`
- Modify: `worker/src/index.ts` (replaces F1's placeholder completely)

Design notes (the code below implements all of them):
- **Identity lives on the socket.** `onConnect` stores a `ConnState` with `ready: false`; `hello` replaces it with the client id, profile, `presence: { at: 'board' }` and `ready: true`. Every read goes through `stateOf(conn)`; there is no instance map of people. After hibernation, a new instance serves the same sockets with the same state (the test evicts the object to prove it).
- **In memory only:** per-connection `ConnLimits` (recreated lazily), pending cursor positions and the flush timer, and the budget counter (saved at most every `BUDGET.persistEveryMs`, and forced when the last connection closes).
- **Broadcasts go only to connections that have said hello.** `person joined` skips the joiner, who gets the snapshot instead. `person updated` goes to everyone, including the person, so a browser learns when the teacher resets its cursor. `personLeft` is only sent for connections that had said hello.
- **Cursors:** ignored while `budget.hz() === 0`; beyond the token bucket they're dropped silently. A cursor from someone not on the board first sets their presence to `board` and broadcasts it. Positions are queued, and a single timer flushes them every `RATES.cursorBatchMs`, sending each ready connection the moves of everyone else.
- **Budget:** `budget.add()` runs on every incoming message, including invalid ones and those sent before `hello`. A change in `hz()` broadcasts `rate`. `DAILY_MESSAGE_BUDGET` comes from env, falling back to `BUDGET.dailyMessages`.
- **Connection cap:** `onConnect` counts the open sockets, including the new one. Over the cap it sends `error` `full` and closes with code 1013.
- **Error messages** say what happened and what to do (`ERROR_TEXT`). W3 uses the same table.
- **Test seams** (`setSeams`): `now`, `maxConnections`, `dailyBudget` (starts a fresh count from zero). W4 adds `fetchImpl` and `shooter`. Call `setSeams` only after the board has handled a request, because `onStart` must have run.
- **`index.ts`:** `/parties/board/<name>` with a name failing `BOARD_NAME_RE` gets 404. A WebSocket upgrade whose `Origin` isn't in `ALLOWED_ORIGINS` gets 403 (through `onBeforeConnect`). A plain HTTP request to the party route gets 404 (`onBeforeRequest`), as do all other paths until W4 adds the HTTP routes.
- `post`, `rename`, `restore`, `history` and `teacher` messages get `error` `invalid` until W3.

- [ ] **Step 1: Write the test helpers**

Create `worker/test/helpers.ts`:

```ts
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { defaultProfile } from '@class-board/shared/protocol';
import type { ServerMsg } from '@class-board/shared/types';
import type { Board } from '../src/board';

export const ORIGIN = 'https://jacobl-h.github.io';

type MsgOf<T extends ServerMsg['type']> = Extract<ServerMsg, { type: T }>;

export interface TestClient {
  ws: WebSocket;
  /** Every message received, in order. */
  log: ServerMsg[];
  /** Connection id, known after hello(). */
  id: string;
  send(msg: unknown): void;
  /**
   * Resolves with the oldest message of this type (matching `where`, if given) that no
   * earlier next() call returned. Waits for it if it hasn't arrived yet.
   */
  next<T extends ServerMsg['type']>(type: T, timeoutMs?: number, where?: (m: MsgOf<T>) => boolean): Promise<MsgOf<T>>;
  /** All messages of this type received so far. */
  all<T extends ServerMsg['type']>(type: T): MsgOf<T>[];
  close(): void;
}

const open = new Set<TestClient>();

let boardCounter = 0;
/** A board name no other test in this file uses (storage is shared within a test file). */
export function uniqueBoard(prefix = 't'): string {
  boardCounter += 1;
  return `${prefix}-${boardCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stubFor(board: string): DurableObjectStub<Board> {
  return env.Board.get(env.Board.idFromName(board)) as DurableObjectStub<Board>;
}

/** Runs fn inside the board's Durable Object, for seams and for reading storage. */
export function inBoard<R>(board: string, fn: (b: Board) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stubFor(board), (instance) => fn(instance));
}

export async function openClient(board: string, opts: { origin?: string | null } = {}): Promise<TestClient> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.Origin = origin;
  const res = await SELF.fetch(`http://localhost/parties/board/${board}`, { headers });
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();

  const log: ServerMsg[] = [];
  const taken = new Set<number>();
  const waiters: Array<() => void> = [];
  ws.addEventListener('message', (e) => {
    log.push(JSON.parse(e.data as string) as ServerMsg);
    for (const wake of waiters.splice(0)) wake();
  });

  const find = <T extends ServerMsg['type']>(type: T, where?: (m: MsgOf<T>) => boolean): MsgOf<T> | undefined => {
    for (let i = 0; i < log.length; i++) {
      const m = log[i]!;
      if (taken.has(i) || m.type !== type) continue;
      if (where && !where(m as MsgOf<T>)) continue;
      taken.add(i);
      return m as MsgOf<T>;
    }
    return undefined;
  };

  const client: TestClient = {
    ws,
    log,
    id: '',
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: (type, timeoutMs = 2000, where) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for '${type}'; got ${JSON.stringify(log.map((m) => m.type))}`));
        }, timeoutMs);
        const check = () => {
          const found = find(type, where);
          if (found) {
            clearTimeout(timer);
            resolve(found);
          } else {
            waiters.push(check);
          }
        };
        check();
      }),
    all: (type) => log.filter((m) => m.type === type) as never,
    close: () => {
      open.delete(client);
      try {
        ws.close(1000, 'done');
      } catch {
        // already closed
      }
    },
  };
  open.add(client);
  return client;
}

/** Sends hello and waits for the snapshot; sets client.id. */
export async function hello(client: TestClient, name: string): Promise<MsgOf<'snapshot'>> {
  client.send({ type: 'hello', clientId: `client-${name}`, profile: defaultProfile(name) });
  const snap = await client.next('snapshot');
  client.id = snap.you;
  return snap;
}

/** Polls until check() returns true. */
export async function waitFor(check: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Closes every client opened by openClient (call in afterEach). */
export function closeAll(): void {
  for (const c of [...open]) c.close();
}
```

- [ ] **Step 2: Write the failing tests**

Create `worker/test/board.session.test.ts`:

```ts
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
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npm run test:do -w worker -- board.session`
Expected: FAIL. The suite doesn't load because `../src/board` doesn't exist yet ("Cannot find module '../src/board'" or "Failed to load url ../src/board"); 0 tests run.

- [ ] **Step 4: Implement `worker/src/board.ts`**

```ts
import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { BUDGET, LIMITS, RATES } from '@class-board/shared/constants';
import { defaultProfile, parseClientMsg } from '@class-board/shared/protocol';
import type {
  ClientMsg, CursorMove, ErrorCode, Person, Presence, Profile, ServerMsg,
} from '@class-board/shared/types';
import { DailyBudget, type BudgetState } from './budget';
import type { Env } from './env';
import { createConnLimits, type ConnLimits } from './limits';
import { BoardStore, toTileView } from './store';

/** Per-connection state, stored on the socket so it survives hibernation (keep it under 2 KB). */
export interface ConnState {
  clientId: string;
  profile: Profile;
  presence: Presence;
  /** True once the connection has sent hello. */
  ready: boolean;
  teacher: boolean;
}

export type BoardConn = Connection<ConnState>;

/**
 * partyserver types connection state as deeply readonly. We never mutate it (every change
 * goes through setState), so reading it as ConnState is safe.
 */
export function stateOf(conn: Connection): ConnState | null {
  return conn.state as unknown as ConnState | null;
}

/** Optional test seams (master plan §2). Production never sets them. */
export interface BoardSeams {
  maxConnections?: number;
  dailyBudget?: number;
  now?: () => number;
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid: "That request wasn't valid. Check it and try again.",
  locked: 'The board is locked. Ask the teacher to unlock it.',
  conflict: 'Someone else just changed this tile. Look at the new version and try again.',
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Upload a smaller file.',
  bad_code: "That passcode isn't right. Check it and try again.",
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "That doesn't exist any more. Refresh and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The connection isn\'t ready yet. Wait a moment and try again.',
};

const META_BUDGET_DAY = 'budget_day';
const META_BUDGET_COUNT = 'budget_count';
const META_LOCKED = 'locked';

export class Board extends Server<Env> {
  static options = { hibernate: true };

  store!: BoardStore;
  budget!: DailyBudget;
  locked = false;
  seams: BoardSeams = {};

  /** Rebuilt lazily after hibernation; never the source of truth for identity. */
  private limits = new Map<string, ConnLimits>();
  private pending = new Map<string, [number, number]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHz: number = RATES.cursorHz;

  now(): number {
    return this.seams.now ? this.seams.now() : Date.now();
  }

  /** Test seam: replace limits or the clock on a running board. */
  setSeams(seams: BoardSeams): void {
    this.seams = { ...this.seams, ...seams };
    if (seams.dailyBudget !== undefined) {
      this.budget.flush(true);
      this.budget = this.createBudget(true);
      this.lastHz = this.budget.hz();
    }
  }

  onStart(): void {
    this.store = new BoardStore(this.ctx.storage.sql);
    this.store.migrate();
    this.locked = this.store.getMeta(META_LOCKED) === '1';
    this.budget = this.createBudget();
    this.lastHz = this.budget.hz();
  }

  /** `fresh` starts from zero instead of the saved count (used by the test seam). */
  private createBudget(fresh = false): DailyBudget {
    const configured = Number(this.env.DAILY_MESSAGE_BUDGET);
    const limit = this.seams.dailyBudget
      ?? (Number.isFinite(configured) && configured > 0 ? configured : BUDGET.dailyMessages);
    return new DailyBudget({
      limit,
      now: () => this.now(),
      load: (): BudgetState | null => {
        if (fresh) return null;
        const day = this.store.getMeta(META_BUDGET_DAY);
        if (!day) return null;
        return { day, count: Number(this.store.getMeta(META_BUDGET_COUNT) ?? '0') || 0 };
      },
      save: (s) => {
        this.store.setMeta(META_BUDGET_DAY, s.day);
        this.store.setMeta(META_BUDGET_COUNT, String(s.count));
      },
    });
  }

  onConnect(conn: BoardConn, _ctx: ConnectionContext): void {
    const cap = this.seams.maxConnections ?? LIMITS.maxConnections;
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open > cap) {
      this.sendError(conn, null, 'full');
      conn.close(1013, 'full');
      return;
    }
    conn.setState({
      clientId: '',
      profile: defaultProfile(),
      presence: { at: 'board' },
      ready: false,
      teacher: false,
    });
  }

  onMessage(conn: BoardConn, raw: WSMessage): void {
    this.budget.add();
    this.checkRate();
    this.budget.flush();

    const msg = typeof raw === 'string' ? parseClientMsg(raw) : null;
    if (!msg) {
      this.sendError(conn, null, 'invalid');
      return;
    }
    const state = stateOf(conn);
    if (msg.type === 'hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!state?.ready) {
      this.sendError(conn, 'reqId' in msg ? msg.reqId : null, 'not_ready');
      return;
    }
    this.dispatch(conn, state, msg);
  }

  /** Every message type after hello. W3 adds the tile edits. */
  protected dispatch(conn: BoardConn, state: ConnState, msg: Exclude<ClientMsg, { type: 'hello' }>): void {
    switch (msg.type) {
      case 'profile':
        if (!this.limitsFor(conn.id).profile.take()) {
          this.sendError(conn, null, 'rate_limited');
          return;
        }
        this.updateState(conn, { profile: msg.profile });
        return;
      case 'cursor':
        this.onCursor(conn, state, msg.x, msg.y);
        return;
      case 'dock':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'tile', slot: msg.slot, mode: msg.mode } });
        return;
      case 'away':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'away' } });
        return;
      default:
        this.sendError(conn, msg.reqId, 'invalid');
    }
  }

  private onHello(conn: BoardConn, msg: Extract<ClientMsg, { type: 'hello' }>): void {
    const prev = stateOf(conn);
    const wasReady = prev?.ready === true;
    const next: ConnState = {
      clientId: msg.clientId,
      profile: msg.profile,
      presence: { at: 'board' },
      ready: true,
      teacher: prev?.teacher ?? false,
    };
    conn.setState(next);
    this.broadcastReady(
      { type: 'person', event: wasReady ? 'updated' : 'joined', person: this.personOf(conn.id, next) },
      conn.id,
    );
    this.send(conn, {
      type: 'snapshot',
      board: this.name,
      you: conn.id,
      tiles: this.store.allCurrent().map((row, slot) => toTileView(this.name, slot, row)),
      locked: this.locked,
      people: this.people(),
      rate: this.budget.hz(),
    });
  }

  private onCursor(conn: BoardConn, state: ConnState, x: number, y: number): void {
    if (this.budget.hz() === 0) return;
    if (!this.limitsFor(conn.id).cursor.take()) return;
    if (state.presence.at !== 'board') this.updateState(conn, { presence: { at: 'board' } });
    this.pending.set(conn.id, [x, y]);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushCursors(), RATES.cursorBatchMs);
    }
  }

  private flushCursors(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const moves: CursorMove[] = [...this.pending].map(([id, [x, y]]) => [id, x, y]);
    this.pending.clear();
    for (const conn of this.getConnections()) {
      if (!stateOf(conn)?.ready) continue;
      const others = moves.filter((m) => m[0] !== conn.id);
      if (others.length > 0) this.send(conn, { type: 'cursors', moves: others });
    }
  }

  onClose(conn: BoardConn): void {
    this.pending.delete(conn.id);
    this.limits.delete(conn.id);
    if (stateOf(conn)?.ready) this.broadcastReady({ type: 'personLeft', id: conn.id });
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open === 0) this.budget.flush(true);
  }

  /** Broadcasts `rate` when the budget crosses a threshold. */
  private checkRate(): void {
    const hz = this.budget.hz();
    if (hz === this.lastHz) return;
    this.lastHz = hz;
    this.broadcastReady({ type: 'rate', hz });
  }

  protected limitsFor(connId: string): ConnLimits {
    let limits = this.limits.get(connId);
    if (!limits) {
      limits = createConnLimits(() => this.now());
      this.limits.set(connId, limits);
    }
    return limits;
  }

  /** Merges into the connection's state and tells everyone about the person. */
  protected updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState {
    const next = { ...(stateOf(conn) as ConnState), ...patch };
    conn.setState(next);
    this.broadcastReady({ type: 'person', event: 'updated', person: this.personOf(conn.id, next) });
    return next;
  }

  protected personOf(id: string, s: ConnState): Person {
    return { id, clientId: s.clientId, profile: s.profile, presence: s.presence };
  }

  protected people(): Person[] {
    const out: Person[] = [];
    for (const conn of this.getConnections()) {
      const s = stateOf(conn);
      if (s?.ready) out.push(this.personOf(conn.id, s));
    }
    return out;
  }

  protected send(conn: Connection, msg: ServerMsg): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // The socket closed between the check and the send; onClose cleans up.
    }
  }

  protected sendError(conn: Connection, reqId: string | null, code: ErrorCode): void {
    this.send(conn, { type: 'error', reqId, code, message: ERROR_TEXT[code] });
  }

  /** Sends to every connection that has said hello, except `exceptId`. */
  protected broadcastReady(msg: ServerMsg, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const conn of this.getConnections()) {
      if (conn.id === exceptId || !stateOf(conn)?.ready) continue;
      try {
        conn.send(data);
      } catch {
        // Closed mid-broadcast; onClose cleans up.
      }
    }
  }
}
```

- [ ] **Step 5: Replace `worker/src/index.ts` completely**

```ts
import { routePartykitRequest } from 'partyserver';
import { BOARD_NAME_RE } from '@class-board/shared/constants';
import { Board } from './board';
import type { Env } from './env';
import { parseOrigins } from './files';

export { Board };

const PARTY_RE = /^\/parties\/board\/([^/]+)\/?$/;

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const party = PARTY_RE.exec(url.pathname);
    if (party) {
      if (!BOARD_NAME_RE.test(party[1]!)) return notFound();
      const response = await routePartykitRequest(request, env, {
        onBeforeConnect: (req) => {
          const origin = req.headers.get('Origin');
          if (!origin || !parseOrigins(env.ALLOWED_ORIGINS).includes(origin)) {
            return new Response('Origin not allowed', { status: 403 });
          }
        },
        // The realtime route only takes WebSocket upgrades.
        onBeforeRequest: () => notFound(),
      });
      return response ?? notFound();
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run test:do -w worker -- board.session`
Expected: PASS, 20 tests in `test/board.session.test.ts`.

Then run W1's tests, which now load the real `Board`:
Run: `npm run test:do -w worker -- store`
Expected: PASS, 17 tests.

- [ ] **Step 7: Commit (orchestrator)**

```bash
git add worker/src/board.ts worker/src/index.ts worker/test/board.session.test.ts worker/test/helpers.ts
git commit -m "feat(worker): Board Durable Object core: connect, hello, snapshot, profile, cursors, presence, budget, WS routing (W2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task W3: Tile edits: post, rename, restore, history, lock, clear, reset cursor

**Wave:** 4 · **Tier:** T3 (opus, medium) · **Depends on:** W2, F4 (`planLink`, `NOTES`), F5 (`cleanText`), X2 (`ConnLimits`), X3 (`TeacherGate`), X4 (`checkUpload`, `ID_RE`)

**Files:**
- Create: `worker/src/tiles.ts`
- Modify: `worker/src/board.ts`
- Test: `worker/test/board.tiles.test.ts`

Rules (implemented by `tiles.ts`):
- **post, rename and restore** run the same checks, in this order:
  1. The board is locked and the sender isn't a teacher → `locked`.
  2. The edit token bucket is empty → `rate_limited`.
  3. `baseVersion` isn't the slot's current version id (0 for a slot never posted to) → `conflict`.
- **post:**
  - The label goes through `cleanText(…, LIMITS.labelMax)`; when empty it becomes the poster's name.
  - Links go through `planLink`. Not ok → `invalid`. `claude-new` → embeddable `no`, with the note `NOTES.claudeNew` and no embed URL. Otherwise embeddable `pending` and `thumb_url = plan.thumbUrl` (set for YouTube).
  - HTML needs a stored file (`ID_RE` and `store.getFile`), otherwise `not_found`. Its title comes from `checkUpload` on the stored HTML, and embeddable is `yes`.
  - Then: insert, broadcast `tile`, reply `ok`, and call `afterPost(row)`.
- **rename:** copies the current version with the new label and the renamer as author. An empty tile or an empty cleaned label → `invalid`.
- **restore:** the version must exist and belong to the slot, otherwise `not_found`. It's copied as a new version (label and content fields included), with the restorer as author.
- **history:** the history token bucket, otherwise `rate_limited`; then up to `LIMITS.historyLimit` versions, newest first, as `toSummary`. Allowed on a locked board.
- **teacher:** every action first calls `TeacherGate.check(conn.id, code)` (`bad` → `bad_code`, `locked_out` → `locked_out`).
  - `check` sets `teacher: true` in the connection state.
  - `lock` / `unlock` write meta `locked` and broadcast `locked`.
  - `clear` needs `slot` (else `invalid`) and saves a new `empty` version, allowed even when locked.
  - `resetCursor` needs `target` (else `invalid`), which must be a connection that has said hello (else `not_found`). Its cursor is set to `{ kind: 'shape', shape: 'arrow' }`, keeping name and color, and `person` `updated` is broadcast.
  - Each success replies `ok`.
- `TeacherGate` lives in memory, created lazily, keyed by connection id (see `contractIssues`).

The test file stubs the global `fetch` in `beforeEach`. W3 itself never fetches, but once W4
lands, every link post starts a link check, and the stub keeps these tests offline and fast.
For the same reason, `nextTile()` waits for a version newer than a given one, skipping W4's
link-check broadcasts, which reuse the version id.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/board.tiles.test.ts`:

```ts
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
      kind: 'html', title: 'Quiz  time', embeddable: 'yes', url: null, embedUrl: null,
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm run test:do -w worker -- board.tiles`
Expected: FAIL. Most tests fail because W2 answers every tile message with `error` `invalid`, for example "expected { type: 'error', code: 'invalid', … } to match object { type: 'ok' }" or "timed out waiting for 'tile'". A few error-path tests may already pass by accident.

- [ ] **Step 3: Implement `worker/src/tiles.ts`**

```ts
import { LIMITS } from '@class-board/shared/constants';
import { cleanText } from '@class-board/shared/protocol';
import type { ClientMsg, ErrorCode, ServerMsg } from '@class-board/shared/types';
import { NOTES, planLink } from '@class-board/shared/urls';
import type { BoardConn, ConnState } from './board';
import { checkUpload, ID_RE } from './files';
import type { ConnLimits } from './limits';
import { toSummary, toTileView, type BoardStore, type NewVersion, type VersionRow } from './store';
import type { TeacherGate } from './teacher';

export type TileMsg = Extract<ClientMsg, { type: 'post' | 'rename' | 'restore' | 'history' | 'teacher' }>;

/** What the tile handlers need from the Board Durable Object. */
export interface TileHost {
  store: BoardStore;
  board: string;
  now(): number;
  isLocked(): boolean;
  setLocked(locked: boolean): void;
  gate(): TeacherGate;
  limits(connId: string): ConnLimits;
  send(conn: BoardConn, msg: ServerMsg): void;
  fail(conn: BoardConn, reqId: string | null, code: ErrorCode): void;
  /** To every connection that has said hello. */
  broadcast(msg: ServerMsg): void;
  /** A connection that has said hello, by connection id. */
  findPerson(id: string): { conn: BoardConn; state: ConnState } | null;
  /** Replaces part of a connection's state and broadcasts `person` `updated`. */
  updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState;
  /** Called after a successful post (W4 starts link checks and screenshots here). */
  afterPost(row: VersionRow): void;
}

export function handleTileMsg(host: TileHost, conn: BoardConn, state: ConnState, msg: TileMsg): void {
  switch (msg.type) {
    case 'post':
      return post(host, conn, state, msg);
    case 'rename':
      return rename(host, conn, state, msg);
    case 'restore':
      return restore(host, conn, state, msg);
    case 'history':
      return history(host, conn, msg);
    case 'teacher':
      return teacher(host, conn, state, msg);
  }
}

/** Shared checks for post, rename and restore. Returns the current row, or null after replying with an error. */
function checkEdit(
  host: TileHost, conn: BoardConn, state: ConnState,
  msg: { reqId: string; slot: number; baseVersion: number },
): { current: VersionRow | null } | null {
  if (host.isLocked() && !state.teacher) {
    host.fail(conn, msg.reqId, 'locked');
    return null;
  }
  if (!host.limits(conn.id).edit.take()) {
    host.fail(conn, msg.reqId, 'rate_limited');
    return null;
  }
  const current = host.store.current(msg.slot);
  if ((current?.id ?? 0) !== msg.baseVersion) {
    host.fail(conn, msg.reqId, 'conflict');
    return null;
  }
  return { current };
}

function save(host: TileHost, conn: BoardConn, reqId: string, v: NewVersion): VersionRow {
  const row = host.store.insert(v, host.now());
  host.broadcast({ type: 'tile', view: toTileView(host.board, row.slot, row) });
  host.send(conn, { type: 'ok', reqId });
  return row;
}

function authored(state: ConnState): Pick<NewVersion, 'author_client' | 'author_name'> {
  return { author_client: state.clientId, author_name: state.profile.name };
}

function post(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'post' }>): void {
  if (!checkEdit(host, conn, state, msg)) return;
  const label = cleanText(msg.label, LIMITS.labelMax) || state.profile.name;
  const base = { slot: msg.slot, label, ...authored(state), title: null, icon: null, shot_id: null };
  let v: NewVersion;
  if (msg.content.kind === 'link') {
    const plan = planLink(msg.content.url);
    if (!plan.ok) {
      host.fail(conn, msg.reqId, 'invalid');
      return;
    }
    v = plan.kind === 'claude-new'
      ? { ...base, kind: 'link', url: plan.url, embed_url: null, file_id: null, embeddable: 'no', note: NOTES.claudeNew, thumb_url: null }
      : { ...base, kind: 'link', url: plan.url, embed_url: plan.embedUrl, file_id: null, embeddable: 'pending', note: null, thumb_url: plan.thumbUrl };
  } else {
    const fileId = msg.content.fileId;
    const html = ID_RE.test(fileId) ? host.store.getFile(fileId) : null;
    if (html === null) {
      host.fail(conn, msg.reqId, 'not_found');
      return;
    }
    const checked = checkUpload(new TextEncoder().encode(html).buffer as ArrayBuffer, null);
    v = {
      ...base, kind: 'html', url: null, embed_url: null, file_id: fileId,
      title: checked.ok ? checked.title : 'HTML page', embeddable: 'yes', note: null, thumb_url: null,
    };
  }
  const row = save(host, conn, msg.reqId, v);
  host.afterPost(row);
}

function rename(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'rename' }>): void {
  const label = cleanText(msg.label, LIMITS.labelMax);
  const checked = checkEdit(host, conn, state, msg);
  if (!checked) return;
  const current = checked.current;
  if (!current || current.kind === 'empty' || !label) {
    host.fail(conn, msg.reqId, 'invalid');
    return;
  }
  save(host, conn, msg.reqId, { ...copyOf(current), ...authored(state), label });
}

function restore(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'restore' }>): void {
  if (!checkEdit(host, conn, state, msg)) return;
  const old = host.store.get(msg.versionId);
  if (!old || old.slot !== msg.slot) {
    host.fail(conn, msg.reqId, 'not_found');
    return;
  }
  save(host, conn, msg.reqId, { ...copyOf(old), ...authored(state) });
}

function history(host: TileHost, conn: BoardConn, msg: Extract<TileMsg, { type: 'history' }>): void {
  if (!host.limits(conn.id).history.take()) {
    host.fail(conn, msg.reqId, 'rate_limited');
    return;
  }
  const versions = host.store.history(msg.slot, LIMITS.historyLimit).map((row) => toSummary(host.board, row));
  host.send(conn, { type: 'historyResult', reqId: msg.reqId, slot: msg.slot, versions });
}

function teacher(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'teacher' }>): void {
  const check = host.gate().check(conn.id, msg.code);
  if (check !== 'ok') {
    host.fail(conn, msg.reqId, check === 'bad' ? 'bad_code' : 'locked_out');
    return;
  }
  switch (msg.action) {
    case 'check':
      conn.setState({ ...state, teacher: true });
      break;
    case 'lock':
    case 'unlock': {
      const locked = msg.action === 'lock';
      host.setLocked(locked);
      host.broadcast({ type: 'locked', locked });
      break;
    }
    case 'clear': {
      if (msg.slot === undefined) {
        host.fail(conn, msg.reqId, 'invalid');
        return;
      }
      save(host, conn, msg.reqId, {
        slot: msg.slot, kind: 'empty', label: '', ...authored(state),
        url: null, embed_url: null, file_id: null, title: null, icon: null,
        embeddable: 'no', note: null, shot_id: null, thumb_url: null,
      });
      return;
    }
    case 'resetCursor': {
      if (msg.target === undefined) {
        host.fail(conn, msg.reqId, 'invalid');
        return;
      }
      const target = host.findPerson(msg.target);
      if (!target) {
        host.fail(conn, msg.reqId, 'not_found');
        return;
      }
      host.updateState(target.conn, { profile: { ...target.state.profile, cursor: { kind: 'shape', shape: 'arrow' } } });
      break;
    }
  }
  host.send(conn, { type: 'ok', reqId: msg.reqId });
}

/** The content fields of a version, for rename and restore. */
function copyOf(row: VersionRow): NewVersion {
  return {
    slot: row.slot, author_client: row.author_client, author_name: row.author_name,
    kind: row.kind, label: row.label, url: row.url, embed_url: row.embed_url, file_id: row.file_id,
    title: row.title, icon: row.icon, embeddable: row.embeddable, note: row.note,
    shot_id: row.shot_id, thumb_url: row.thumb_url,
  };
}
```

- [ ] **Step 4: Replace `worker/src/board.ts` completely**

Compared with W2 there are three new imports (`VersionRow`, `TeacherGate`, `handleTileMsg`/`TileHost`), two fields (`teacherGate`, `host`), a new `default` branch in `dispatch`, and the methods `afterPost` (a no-op until W4), `tileHost` and `findPerson`. The full file:

```ts
import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { BUDGET, LIMITS, RATES } from '@class-board/shared/constants';
import { defaultProfile, parseClientMsg } from '@class-board/shared/protocol';
import type {
  ClientMsg, CursorMove, ErrorCode, Person, Presence, Profile, ServerMsg,
} from '@class-board/shared/types';
import { DailyBudget, type BudgetState } from './budget';
import type { Env } from './env';
import { createConnLimits, type ConnLimits } from './limits';
import { BoardStore, toTileView, type VersionRow } from './store';
import { TeacherGate } from './teacher';
import { handleTileMsg, type TileHost } from './tiles';

/** Per-connection state, stored on the socket so it survives hibernation (keep it under 2 KB). */
export interface ConnState {
  clientId: string;
  profile: Profile;
  presence: Presence;
  /** True once the connection has sent hello. */
  ready: boolean;
  teacher: boolean;
}

export type BoardConn = Connection<ConnState>;

/**
 * partyserver types connection state as deeply readonly. We never mutate it (every change
 * goes through setState), so reading it as ConnState is safe.
 */
export function stateOf(conn: Connection): ConnState | null {
  return conn.state as unknown as ConnState | null;
}

/** Optional test seams (master plan §2). Production never sets them. */
export interface BoardSeams {
  maxConnections?: number;
  dailyBudget?: number;
  now?: () => number;
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid: "That request wasn't valid. Check it and try again.",
  locked: 'The board is locked. Ask the teacher to unlock it.',
  conflict: 'Someone else just changed this tile. Look at the new version and try again.',
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Upload a smaller file.',
  bad_code: "That passcode isn't right. Check it and try again.",
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "That doesn't exist any more. Refresh and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The connection isn\'t ready yet. Wait a moment and try again.',
};

const META_BUDGET_DAY = 'budget_day';
const META_BUDGET_COUNT = 'budget_count';
const META_LOCKED = 'locked';

export class Board extends Server<Env> {
  static options = { hibernate: true };

  store!: BoardStore;
  budget!: DailyBudget;
  locked = false;
  seams: BoardSeams = {};

  /** Rebuilt lazily after hibernation; never the source of truth for identity. */
  private limits = new Map<string, ConnLimits>();
  private pending = new Map<string, [number, number]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHz: number = RATES.cursorHz;
  private teacherGate: TeacherGate | null = null;
  private host: TileHost | null = null;

  now(): number {
    return this.seams.now ? this.seams.now() : Date.now();
  }

  /** Test seam: replace limits or the clock on a running board. */
  setSeams(seams: BoardSeams): void {
    this.seams = { ...this.seams, ...seams };
    if (seams.dailyBudget !== undefined) {
      this.budget.flush(true);
      this.budget = this.createBudget(true);
      this.lastHz = this.budget.hz();
    }
  }

  onStart(): void {
    this.store = new BoardStore(this.ctx.storage.sql);
    this.store.migrate();
    this.locked = this.store.getMeta(META_LOCKED) === '1';
    this.budget = this.createBudget();
    this.lastHz = this.budget.hz();
  }

  /** `fresh` starts from zero instead of the saved count (used by the test seam). */
  private createBudget(fresh = false): DailyBudget {
    const configured = Number(this.env.DAILY_MESSAGE_BUDGET);
    const limit = this.seams.dailyBudget
      ?? (Number.isFinite(configured) && configured > 0 ? configured : BUDGET.dailyMessages);
    return new DailyBudget({
      limit,
      now: () => this.now(),
      load: (): BudgetState | null => {
        if (fresh) return null;
        const day = this.store.getMeta(META_BUDGET_DAY);
        if (!day) return null;
        return { day, count: Number(this.store.getMeta(META_BUDGET_COUNT) ?? '0') || 0 };
      },
      save: (s) => {
        this.store.setMeta(META_BUDGET_DAY, s.day);
        this.store.setMeta(META_BUDGET_COUNT, String(s.count));
      },
    });
  }

  onConnect(conn: BoardConn, _ctx: ConnectionContext): void {
    const cap = this.seams.maxConnections ?? LIMITS.maxConnections;
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open > cap) {
      this.sendError(conn, null, 'full');
      conn.close(1013, 'full');
      return;
    }
    conn.setState({
      clientId: '',
      profile: defaultProfile(),
      presence: { at: 'board' },
      ready: false,
      teacher: false,
    });
  }

  onMessage(conn: BoardConn, raw: WSMessage): void {
    this.budget.add();
    this.checkRate();
    this.budget.flush();

    const msg = typeof raw === 'string' ? parseClientMsg(raw) : null;
    if (!msg) {
      this.sendError(conn, null, 'invalid');
      return;
    }
    const state = stateOf(conn);
    if (msg.type === 'hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!state?.ready) {
      this.sendError(conn, 'reqId' in msg ? msg.reqId : null, 'not_ready');
      return;
    }
    this.dispatch(conn, state, msg);
  }

  /** Every message type after hello. */
  protected dispatch(conn: BoardConn, state: ConnState, msg: Exclude<ClientMsg, { type: 'hello' }>): void {
    switch (msg.type) {
      case 'profile':
        if (!this.limitsFor(conn.id).profile.take()) {
          this.sendError(conn, null, 'rate_limited');
          return;
        }
        this.updateState(conn, { profile: msg.profile });
        return;
      case 'cursor':
        this.onCursor(conn, state, msg.x, msg.y);
        return;
      case 'dock':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'tile', slot: msg.slot, mode: msg.mode } });
        return;
      case 'away':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'away' } });
        return;
      default:
        handleTileMsg(this.tileHost(), conn, state, msg);
    }
  }

  /** Runs after every successful post. W4 starts the link check and the screenshot here. */
  protected afterPost(_row: VersionRow): void {}

  private tileHost(): TileHost {
    this.host ??= {
      store: this.store,
      board: this.name,
      now: () => this.now(),
      isLocked: () => this.locked,
      setLocked: (locked) => {
        this.locked = locked;
        this.store.setMeta(META_LOCKED, locked ? '1' : '0');
      },
      gate: () => (this.teacherGate ??= new TeacherGate(this.env.TEACHER_CODE, () => this.now())),
      limits: (id) => this.limitsFor(id),
      send: (conn, msg) => this.send(conn, msg),
      fail: (conn, reqId, code) => this.sendError(conn, reqId, code),
      broadcast: (msg) => this.broadcastReady(msg),
      findPerson: (id) => this.findPerson(id),
      updateState: (conn, patch) => this.updateState(conn, patch),
      afterPost: (row) => this.afterPost(row),
    };
    return this.host;
  }

  private findPerson(id: string): { conn: BoardConn; state: ConnState } | null {
    for (const conn of this.getConnections()) {
      const state = stateOf(conn);
      if (conn.id === id && state?.ready) return { conn: conn as BoardConn, state };
    }
    return null;
  }

  private onHello(conn: BoardConn, msg: Extract<ClientMsg, { type: 'hello' }>): void {
    const prev = stateOf(conn);
    const wasReady = prev?.ready === true;
    const next: ConnState = {
      clientId: msg.clientId,
      profile: msg.profile,
      presence: { at: 'board' },
      ready: true,
      teacher: prev?.teacher ?? false,
    };
    conn.setState(next);
    this.broadcastReady(
      { type: 'person', event: wasReady ? 'updated' : 'joined', person: this.personOf(conn.id, next) },
      conn.id,
    );
    this.send(conn, {
      type: 'snapshot',
      board: this.name,
      you: conn.id,
      tiles: this.store.allCurrent().map((row, slot) => toTileView(this.name, slot, row)),
      locked: this.locked,
      people: this.people(),
      rate: this.budget.hz(),
    });
  }

  private onCursor(conn: BoardConn, state: ConnState, x: number, y: number): void {
    if (this.budget.hz() === 0) return;
    if (!this.limitsFor(conn.id).cursor.take()) return;
    if (state.presence.at !== 'board') this.updateState(conn, { presence: { at: 'board' } });
    this.pending.set(conn.id, [x, y]);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushCursors(), RATES.cursorBatchMs);
    }
  }

  private flushCursors(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const moves: CursorMove[] = [...this.pending].map(([id, [x, y]]) => [id, x, y]);
    this.pending.clear();
    for (const conn of this.getConnections()) {
      if (!stateOf(conn)?.ready) continue;
      const others = moves.filter((m) => m[0] !== conn.id);
      if (others.length > 0) this.send(conn, { type: 'cursors', moves: others });
    }
  }

  onClose(conn: BoardConn): void {
    this.pending.delete(conn.id);
    this.limits.delete(conn.id);
    if (stateOf(conn)?.ready) this.broadcastReady({ type: 'personLeft', id: conn.id });
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open === 0) this.budget.flush(true);
  }

  /** Broadcasts `rate` when the budget crosses a threshold. */
  private checkRate(): void {
    const hz = this.budget.hz();
    if (hz === this.lastHz) return;
    this.lastHz = hz;
    this.broadcastReady({ type: 'rate', hz });
  }

  protected limitsFor(connId: string): ConnLimits {
    let limits = this.limits.get(connId);
    if (!limits) {
      limits = createConnLimits(() => this.now());
      this.limits.set(connId, limits);
    }
    return limits;
  }

  /** Merges into the connection's state and tells everyone about the person. */
  protected updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState {
    const next = { ...(stateOf(conn) as ConnState), ...patch };
    conn.setState(next);
    this.broadcastReady({ type: 'person', event: 'updated', person: this.personOf(conn.id, next) });
    return next;
  }

  protected personOf(id: string, s: ConnState): Person {
    return { id, clientId: s.clientId, profile: s.profile, presence: s.presence };
  }

  protected people(): Person[] {
    const out: Person[] = [];
    for (const conn of this.getConnections()) {
      const s = stateOf(conn);
      if (s?.ready) out.push(this.personOf(conn.id, s));
    }
    return out;
  }

  protected send(conn: Connection, msg: ServerMsg): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // The socket closed between the check and the send; onClose cleans up.
    }
  }

  protected sendError(conn: Connection, reqId: string | null, code: ErrorCode): void {
    this.send(conn, { type: 'error', reqId, code, message: ERROR_TEXT[code] });
  }

  /** Sends to every connection that has said hello, except `exceptId`. */
  protected broadcastReady(msg: ServerMsg, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const conn of this.getConnections()) {
      if (conn.id === exceptId || !stateOf(conn)?.ready) continue;
      try {
        conn.send(data);
      } catch {
        // Closed mid-broadcast; onClose cleans up.
      }
    }
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run test:do -w worker -- board.tiles`
Expected: PASS, 26 tests in `test/board.tiles.test.ts`.

Then check that W2's tests still pass:
Run: `npm run test:do -w worker -- board.session`
Expected: PASS, 20 tests.

- [ ] **Step 6: Commit (orchestrator)**

```bash
git add worker/src/tiles.ts worker/src/board.ts worker/test/board.tiles.test.ts
git commit -m "feat(worker): Tile edits: post, rename, restore, history, lock, clear, reset cursor (W3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task W4: Content: link checks after posting, upload/file/shot routes, screenshot alarm

**Wave:** 5 · **Tier:** T3 (opus, medium) · **Depends on:** W3, X4 (`checkUpload`, `htmlFileResponse`, `shotResponse`, `corsHeaders`, `json`, `newId`, `ID_RE`, `parseOrigins`), X5 (`checkLink`), X6 (`runShotQueue`, `createBrowserShooter`, `Shooter`), X2 (`KeyedLimiter`)

**Files:**
- Create: `worker/src/content.ts`
- Modify: `worker/src/board.ts`, `worker/src/index.ts`
- Test: `worker/test/board.content.test.ts`

Rules (implemented by `content.ts`):
- **After a post:**
  - HTML → enqueue a screenshot now.
  - A link whose embeddable is `pending` → `checkLink(embed_url, BOARD_ORIGIN, fetchImpl)` under `ctx.waitUntil`, then patch `embeddable`, `title`, `icon` and `note`. The note is `NOTES.claudeAllow(host of BOARD_ORIGIN)` for a published Claude artifact that answers `no`, `NOTES.blocked` for any other `no`, and `null` otherwise.
  - Then broadcast `tile`, **only if the row is still its slot's current version**, so a late result can't overwrite a newer tile. If it's still current and has no `thumb_url`, enqueue a screenshot. `claude-new` links are posted as `no` and never checked.
- **Screenshots only run when there's a shooter:** the `shooter` seam, or `createBrowserShooter(env.BROWSER)` when that binding exists. Without one, nothing is queued and no alarm is set, so local dev and the W3 tests never schedule alarms.
- **Enqueueing** sets the alarm to "now" unless an earlier alarm is already set.
- **The alarm** runs `runShotQueue` with a lazily created shooter from `ShooterSession`. `onUpdated` broadcasts `tile` while the row is current. The session closes the shooter once nothing more is due. The alarm is rescheduled with the returned time, and `budget.flush()` runs.
- **HTTP**, handled by the Durable Object's `onRequest` and reached through the Worker:
  - `POST /boards/<b>/files`:
    - an origin that isn't allowed → 403 `{"error":"origin"}`
    - `KeyedLimiter(RATES.uploadsPerMinute)` keyed by `CF-Connecting-IP` → 429 `{"error":"rate_limited"}`
    - a `Content-Length` over the limit, or `checkUpload` → 413 `{"error":"too_large"}` / 400 `{"error":"invalid"}`
    - otherwise `putFile(newId())` → 200 `{"fileId"}`

    `X-File-Name` is optional and percent-decoded.
  - `GET /boards/<b>/files/<id>` → `htmlFileResponse`, and `GET /boards/<b>/shots/<id>` → `shotResponse`. An id failing `ID_RE`, an unknown id, or any other path → 404 `{"error":"not_found"}`.
- **`index.ts`:** `/boards/<b>/(files|shots)[/<id>]`. A bad board name → 404. `OPTIONS` → 204 with `corsHeaders`. Otherwise it forwards with `env.Board.get(env.Board.idFromName(b)).fetch(request)`, which is one Durable Object call instead of the two `getServerByName` makes, and adds `corsHeaders(origin, allowed)` to the response (`Access-Control-Allow-Origin` appears only for allowed origins).
- **Test seams** added to `BoardSeams`: `fetchImpl` and `shooter`. When no `fetchImpl` seam is set, the global `fetch` is looked up on every call, so a test's `vi.stubGlobal('fetch', …)` applies.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/board.content.test.ts`:

```ts
import { runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@class-board/shared/constants';
import type { TileView } from '@class-board/shared/types';
import { NOTES } from '@class-board/shared/urls';
import type { Shooter } from '../src/shots';
import { closeAll, hello, inBoard, openClient, ORIGIN, stubFor, uniqueBoard, waitFor, type TestClient } from './helpers';

beforeEach(() => {
  // Anything that forgets its seam fails loudly instead of reaching the network.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('unexpected network access');
  }));
});
afterEach(() => {
  closeAll();
  vi.unstubAllGlobals();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);

function fakeShooter(): { shooter: Shooter; shots: string[]; closed: number } {
  const state = { shots: [] as string[], closed: 0, shooter: null as unknown as Shooter };
  state.shooter = {
    shoot: async (url) => {
      state.shots.push(url);
      return JPEG.slice().buffer;
    },
    close: async () => {
      state.closed += 1;
    },
  };
  return state;
}

function page(headers: Record<string, string> = {}, title = 'Example page'): Response {
  return new Response(`<html><head><title>${title}</title></head></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

let reqCounter = 0;
function postLink(c: TestClient, slot: number, url: string, baseVersion = 0): void {
  reqCounter += 1;
  c.send({ type: 'post', reqId: `p${reqCounter}`, slot, baseVersion, content: { kind: 'link', url }, label: 'Link' });
}

async function tileWhere(c: TestClient, slot: number, where: (v: TileView) => boolean): Promise<TileView> {
  return (await c.next('tile', 3000, (m) => m.view.slot === slot && where(m.view))).view;
}

async function upload(board: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`http://localhost/boards/${board}/files`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/html', 'CF-Connecting-IP': '203.0.113.9', ...headers },
    body,
  });
}

describe('uploads and files', () => {
  it('stores an upload and serves it with sandbox headers', async () => {
    const board = uniqueBoard();
    const res = await upload(board, '<title>Quiz</title><p>hi</p>', { 'X-File-Name': encodeURIComponent('quiz é.html') });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const { fileId } = await res.json<{ fileId: string }>();
    expect(fileId).toMatch(/^[0-9a-f]{32}$/);

    const file = await SELF.fetch(`http://localhost/boards/${board}/files/${fileId}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('<title>Quiz</title><p>hi</p>');
    expect(file.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(file.headers.get('Content-Security-Policy')).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors https://jacobl-h.github.io http://localhost:5173',
    );
    expect(file.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(file.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(file.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(file.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers the CORS preflight for an allowed origin', async () => {
    const res = await SELF.fetch(`http://localhost/boards/${uniqueBoard()}/files`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('rejects uploads from other origins with 403 and no CORS allowance', async () => {
    const res = await upload(uniqueBoard(), '<p>x</p>', { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects files over 1 MB with 413 and non-HTML with 400', async () => {
    const board = uniqueBoard();
    const big = await upload(board, '<' + 'a'.repeat(LIMITS.htmlMaxBytes));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    const plain = await upload(board, 'no angle brackets here', { 'CF-Connecting-IP': '203.0.113.10' });
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({ error: 'invalid' });
  });

  it('allows 5 uploads a minute per IP, then answers 429', async () => {
    const board = uniqueBoard();
    await inBoard(board, (b) => b.setSeams({ now: () => 7_000_000 }));
    for (let i = 0; i < 5; i++) expect((await upload(board, '<p>ok</p>', { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(200);
    const limited = await upload(board, '<p>ok</p>', { 'CF-Connecting-IP': '198.51.100.1' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect((await upload(board, '<p>ok</p>', { 'CF-Connecting-IP': '198.51.100.2' })).status).toBe(200);
  });

  it('answers 404 for unknown or malformed ids and bad board names', async () => {
    const board = uniqueBoard();
    const urls = [
      `http://localhost/boards/${board}/files/${'0'.repeat(32)}`,
      `http://localhost/boards/${board}/files/not-an-id`,
      `http://localhost/boards/${board}/shots/${'0'.repeat(32)}`,
      'http://localhost/boards/Bad_Board/files/' + '0'.repeat(32),
      `http://localhost/boards/${board}/other`,
    ];
    for (const u of urls) expect((await SELF.fetch(u, { headers: { Origin: ORIGIN } })).status).toBe(404);
  });
});

describe('link checks', () => {
  it('updates a pending link with the check result', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const fetchImpl = vi.fn(async () => page({ 'X-Frame-Options': 'DENY' }, 'Blocked page'));
    await inBoard(board, (b) => b.setSeams({ fetchImpl }));
    postLink(a, 30, 'https://blocked.example/');
    const pending = await tileWhere(a, 30, (v) => v.embeddable === 'pending');
    const checked = await tileWhere(a, 30, (v) => v.embeddable !== 'pending');
    expect(checked).toMatchObject({ version: pending.version, embeddable: 'no', title: 'Blocked page', note: NOTES.blocked });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains how to allow a published Claude artifact that refuses to embed', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    await inBoard(board, (b) => b.setSeams({ fetchImpl: async () => page({ 'Content-Security-Policy': "frame-ancestors 'self'" }) }));
    postLink(a, 31, 'https://claude.ai/public/artifacts/abc');
    const checked = await tileWhere(a, 31, (v) => v.embeddable !== 'pending');
    expect(checked).toMatchObject({ embeddable: 'no', note: NOTES.claudeAllow('jacobl-h.github.io') });
  });

  it('uses the global fetch when no seam is set, so a stubbed fetch keeps tests offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page({}, 'From the stub')));
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    postLink(a, 32, 'https://embeddable.example/');
    expect(await tileWhere(a, 32, (v) => v.embeddable !== 'pending')).toMatchObject({ embeddable: 'yes', title: 'From the stub', note: null });
  });

  it('does not broadcast a result for a version that has been replaced', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const gates: Array<() => void> = [];
    await inBoard(board, (b) => b.setSeams({
      fetchImpl: () => new Promise<Response>((resolve) => gates.push(() => resolve(page()))),
    }));
    postLink(a, 33, 'https://first.example/');
    const first = await tileWhere(a, 33, () => true);
    await waitFor(() => gates.length === 1, 2000, 'first link check');
    postLink(a, 33, 'https://second.example/', first.version);
    const second = await tileWhere(a, 33, (v) => v.version !== first.version);
    await waitFor(() => gates.length === 2, 2000, 'second link check');
    // Resolve inside the Durable Object: a promise made there can't be settled from the test's context.
    await inBoard(board, () => {
      gates[0]!();
      gates[1]!();
    });
    const checked = await tileWhere(a, 33, (v) => v.embeddable === 'yes');
    expect(checked.version).toBe(second.version);
    expect(a.all('tile').filter((m) => m.view.version === first.version && m.view.embeddable !== 'pending')).toEqual([]);
  });
});

describe('screenshots', () => {
  it('screenshots a link after its check and broadcasts the tile with the shot', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const fake = fakeShooter();
    await inBoard(board, (b) => b.setSeams({ fetchImpl: async () => page(), shooter: () => fake.shooter }));
    postLink(a, 40, 'https://ok.example/page');
    await tileWhere(a, 40, (v) => v.embeddable === 'yes');
    await runDurableObjectAlarm(stubFor(board));
    const shot = await tileWhere(a, 40, (v) => v.shotUrl !== null);
    expect(shot.shotUrl).toMatch(new RegExp(`^/boards/${board}/shots/[0-9a-f]{32}$`));
    expect(fake.shots).toEqual(['https://ok.example/page']);
    await waitFor(() => fake.closed === 1, 2000, 'shooter closed');

    const img = await SELF.fetch(`http://localhost${shot.shotUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    expect(img.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([...JPEG]);
  });

  it('screenshots an HTML upload from its public URL straight away', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const fake = fakeShooter();
    await inBoard(board, (b) => b.setSeams({ shooter: () => fake.shooter }));
    const { fileId } = await (await upload(board, '<title>Page</title>')).json<{ fileId: string }>();
    a.send({ type: 'post', reqId: 'html1', slot: 41, baseVersion: 0, content: { kind: 'html', fileId }, label: 'Page' });
    await tileWhere(a, 41, (v) => v.kind === 'html');
    await runDurableObjectAlarm(stubFor(board));
    await tileWhere(a, 41, (v) => v.shotUrl !== null);
    expect(fake.shots).toEqual([`http://localhost:8787/boards/${board}/files/${fileId}`]);
  });

  it('never screenshots YouTube links, which use the thumbnail', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    const fake = fakeShooter();
    await inBoard(board, (b) => b.setSeams({ fetchImpl: async () => page(), shooter: () => fake.shooter }));
    postLink(a, 42, 'https://youtu.be/dQw4w9WgXcQ');
    await tileWhere(a, 42, (v) => v.embeddable === 'yes');
    await runDurableObjectAlarm(stubFor(board));
    expect(fake.shots).toEqual([]);
    expect(await inBoard(board, (b) => b.store.nextShotAt())).toBeNull();
  });

  it('queues nothing when screenshots are off', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    await inBoard(board, (b) => b.setSeams({ fetchImpl: async () => page() }));
    postLink(a, 43, 'https://ok.example/');
    await tileWhere(a, 43, (v) => v.embeddable === 'yes');
    expect(await inBoard(board, (b) => b.store.nextShotAt())).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm run test:do -w worker -- board.content`
Expected: FAIL. The upload and file tests get 404 ("expected 404 to be 200"), and the link-check and screenshot tests time out ("timed out waiting for 'tile'"), because W3 has no HTTP routes, link checks or alarm. The 404 test may already pass.

- [ ] **Step 3: Implement `worker/src/content.ts`**

```ts
import { LIMITS, RATES } from '@class-board/shared/constants';
import type { ServerMsg } from '@class-board/shared/types';
import { NOTES, planLink } from '@class-board/shared/urls';
import type { Env } from './env';
import { checkUpload, htmlFileResponse, ID_RE, json, newId, parseOrigins, shotResponse } from './files';
import { KeyedLimiter } from './limits';
import { checkLink } from './linkCheck';
import { runShotQueue, type Shooter } from './shots';
import { toTileView, type BoardStore, type VersionRow } from './store';

/** What the content handlers need from the Board Durable Object. */
export interface ContentHost {
  store: BoardStore;
  board: string;
  env: Env;
  now(): number;
  fetchImpl: typeof fetch;
  /** Null when screenshots are off (no Browser Rendering binding and no test shooter). */
  shots: ShooterSession | null;
  uploads: KeyedLimiter;
  /** To every connection that has said hello. */
  broadcast(msg: ServerMsg): void;
  /** Moves the alarm earlier if `at` is before the one already set. */
  scheduleAlarm(at: number): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
}

/** Creates the shooter on first use and closes it when the queue has drained. */
export class ShooterSession {
  private shooter: Shooter | null = null;

  constructor(private readonly create: () => Shooter | null) {}

  get(): Shooter | null {
    this.shooter ??= this.create();
    return this.shooter;
  }

  async close(): Promise<void> {
    const shooter = this.shooter;
    this.shooter = null;
    if (shooter) await shooter.close().catch(() => undefined);
  }
}

export function createUploadLimiter(now: () => number): KeyedLimiter {
  return new KeyedLimiter(RATES.uploadsPerMinute, now);
}

/** Broadcasts a row only while it's still its slot's current version. */
function broadcastIfCurrent(host: ContentHost, row: VersionRow): void {
  if (host.store.current(row.slot)?.id !== row.id) return;
  host.broadcast({ type: 'tile', view: toTileView(host.board, row.slot, row) });
}

async function queueShot(host: ContentHost, versionId: number): Promise<void> {
  if (!host.shots) return;
  const now = host.now();
  host.store.enqueueShot(versionId, now);
  await host.scheduleAlarm(now);
}

/** Runs after every successful post. */
export function afterPost(host: ContentHost, row: VersionRow): void {
  if (row.kind === 'html') {
    host.waitUntil(queueShot(host, row.id));
    return;
  }
  if (row.kind === 'link' && row.embeddable === 'pending' && row.embed_url) {
    host.waitUntil(checkAndUpdate(host, row, row.embed_url));
  }
}

async function checkAndUpdate(host: ContentHost, row: VersionRow, embedUrl: string): Promise<void> {
  const result = await checkLink(embedUrl, host.env.BOARD_ORIGIN, host.fetchImpl)
    .catch(() => ({ embeddable: 'unknown' as const, title: null, icon: null }));
  let note: string | null = null;
  if (result.embeddable === 'no') {
    const plan = row.url ? planLink(row.url) : null;
    note = plan?.ok && plan.kind === 'claude-published'
      ? NOTES.claudeAllow(new URL(host.env.BOARD_ORIGIN).host)
      : NOTES.blocked;
  }
  const patched = host.store.patch(row.id, {
    embeddable: result.embeddable, title: result.title, icon: result.icon, note,
  });
  if (!patched) return;
  broadcastIfCurrent(host, patched);
  if (host.store.current(patched.slot)?.id === patched.id && !patched.thumb_url) {
    await queueShot(host, patched.id);
  }
}

/** The alarm: works through the screenshot queue and returns when to run again (or null). */
export async function runAlarm(host: ContentHost): Promise<number | null> {
  const shots = host.shots;
  const next = await runShotQueue({
    store: host.store,
    board: host.board,
    publicUrl: host.env.PUBLIC_URL,
    shooter: () => shots?.get() ?? null,
    now: () => host.now(),
    onUpdated: (row) => broadcastIfCurrent(host, row),
  });
  if (shots && (next === null || next > host.now())) await shots.close();
  return next;
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

/** HTTP requests the Worker forwarded to this board: uploads, files and screenshots. */
export async function handleHttp(host: ContentHost, request: Request): Promise<Response> {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts[0] !== 'boards' || parts[1] !== host.board) return notFound();

  if (parts.length === 3 && parts[2] === 'files' && request.method === 'POST') {
    return upload(host, request);
  }
  if (parts.length === 4 && request.method === 'GET') {
    const id = parts[3]!;
    if (!ID_RE.test(id)) return notFound();
    if (parts[2] === 'files') {
      const html = host.store.getFile(id);
      return html === null ? notFound() : htmlFileResponse(html, parseOrigins(host.env.ALLOWED_ORIGINS));
    }
    if (parts[2] === 'shots') {
      const jpeg = host.store.getShot(id);
      return jpeg === null ? notFound() : shotResponse(jpeg);
    }
  }
  return notFound();
}

async function upload(host: ContentHost, request: Request): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (!origin || !parseOrigins(host.env.ALLOWED_ORIGINS).includes(origin)) return json({ error: 'origin' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!host.uploads.allow(ip)) return json({ error: 'rate_limited' }, 429);

  // Refuse obviously oversized bodies before reading them; checkUpload re-checks the real size.
  if (Number(request.headers.get('Content-Length') ?? '0') > LIMITS.htmlMaxBytes) return json({ error: 'too_large' }, 413);
  const checked = checkUpload(await request.arrayBuffer(), fileNameOf(request));
  if (!checked.ok) return json({ error: checked.code }, checked.code === 'too_large' ? 413 : 400);
  const fileId = newId();
  host.store.putFile(fileId, checked.html, '', host.now());
  return json({ fileId });
}

/** The optional X-File-Name header, which the browser may percent-encode. */
function fileNameOf(request: Request): string | null {
  const raw = request.headers.get('X-File-Name');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
```

- [ ] **Step 4: Replace `worker/src/board.ts` completely**

Compared with W3 there are new imports (`content.ts`, `KeyedLimiter`, `createBrowserShooter`/`Shooter`), the seams `fetchImpl` and `shooter`, the fields `shots` and `uploads`, a `setSeams` line that resets `shots`, the real `afterPost`, and `onRequest`, `onAlarm`, `contentHost`, `shotSession` and `scheduleAlarm`. The full file:

```ts
import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { BUDGET, LIMITS, RATES } from '@class-board/shared/constants';
import { defaultProfile, parseClientMsg } from '@class-board/shared/protocol';
import type {
  ClientMsg, CursorMove, ErrorCode, Person, Presence, Profile, ServerMsg,
} from '@class-board/shared/types';
import { DailyBudget, type BudgetState } from './budget';
import {
  afterPost as startContentChecks, createUploadLimiter, handleHttp, runAlarm, ShooterSession, type ContentHost,
} from './content';
import type { Env } from './env';
import { createConnLimits, type ConnLimits, type KeyedLimiter } from './limits';
import { createBrowserShooter, type Shooter } from './shots';
import { BoardStore, toTileView, type VersionRow } from './store';
import { TeacherGate } from './teacher';
import { handleTileMsg, type TileHost } from './tiles';

/** Per-connection state, stored on the socket so it survives hibernation (keep it under 2 KB). */
export interface ConnState {
  clientId: string;
  profile: Profile;
  presence: Presence;
  /** True once the connection has sent hello. */
  ready: boolean;
  teacher: boolean;
}

export type BoardConn = Connection<ConnState>;

/**
 * partyserver types connection state as deeply readonly. We never mutate it (every change
 * goes through setState), so reading it as ConnState is safe.
 */
export function stateOf(conn: Connection): ConnState | null {
  return conn.state as unknown as ConnState | null;
}

/** Optional test seams (master plan §2). Production never sets them. */
export interface BoardSeams {
  maxConnections?: number;
  dailyBudget?: number;
  now?: () => number;
  /** Replaces the global fetch for link checks. */
  fetchImpl?: typeof fetch;
  /** Replaces Browser Rendering for screenshots. */
  shooter?: () => Shooter | null;
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid: "That request wasn't valid. Check it and try again.",
  locked: 'The board is locked. Ask the teacher to unlock it.',
  conflict: 'Someone else just changed this tile. Look at the new version and try again.',
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Upload a smaller file.',
  bad_code: "That passcode isn't right. Check it and try again.",
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "That doesn't exist any more. Refresh and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The connection isn\'t ready yet. Wait a moment and try again.',
};

const META_BUDGET_DAY = 'budget_day';
const META_BUDGET_COUNT = 'budget_count';
const META_LOCKED = 'locked';

export class Board extends Server<Env> {
  static options = { hibernate: true };

  store!: BoardStore;
  budget!: DailyBudget;
  locked = false;
  seams: BoardSeams = {};

  /** Rebuilt lazily after hibernation; never the source of truth for identity. */
  private limits = new Map<string, ConnLimits>();
  private pending = new Map<string, [number, number]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHz: number = RATES.cursorHz;
  private teacherGate: TeacherGate | null = null;
  private host: TileHost | null = null;
  private shots: ShooterSession | null = null;
  private uploads: KeyedLimiter | null = null;

  now(): number {
    return this.seams.now ? this.seams.now() : Date.now();
  }

  /** Test seam: replace limits or the clock on a running board. */
  setSeams(seams: BoardSeams): void {
    this.seams = { ...this.seams, ...seams };
    if (seams.shooter !== undefined) this.shots = null;
    if (seams.dailyBudget !== undefined) {
      this.budget.flush(true);
      this.budget = this.createBudget(true);
      this.lastHz = this.budget.hz();
    }
  }

  onStart(): void {
    this.store = new BoardStore(this.ctx.storage.sql);
    this.store.migrate();
    this.locked = this.store.getMeta(META_LOCKED) === '1';
    this.budget = this.createBudget();
    this.lastHz = this.budget.hz();
  }

  /** `fresh` starts from zero instead of the saved count (used by the test seam). */
  private createBudget(fresh = false): DailyBudget {
    const configured = Number(this.env.DAILY_MESSAGE_BUDGET);
    const limit = this.seams.dailyBudget
      ?? (Number.isFinite(configured) && configured > 0 ? configured : BUDGET.dailyMessages);
    return new DailyBudget({
      limit,
      now: () => this.now(),
      load: (): BudgetState | null => {
        if (fresh) return null;
        const day = this.store.getMeta(META_BUDGET_DAY);
        if (!day) return null;
        return { day, count: Number(this.store.getMeta(META_BUDGET_COUNT) ?? '0') || 0 };
      },
      save: (s) => {
        this.store.setMeta(META_BUDGET_DAY, s.day);
        this.store.setMeta(META_BUDGET_COUNT, String(s.count));
      },
    });
  }

  onConnect(conn: BoardConn, _ctx: ConnectionContext): void {
    const cap = this.seams.maxConnections ?? LIMITS.maxConnections;
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open > cap) {
      this.sendError(conn, null, 'full');
      conn.close(1013, 'full');
      return;
    }
    conn.setState({
      clientId: '',
      profile: defaultProfile(),
      presence: { at: 'board' },
      ready: false,
      teacher: false,
    });
  }

  onMessage(conn: BoardConn, raw: WSMessage): void {
    this.budget.add();
    this.checkRate();
    this.budget.flush();

    const msg = typeof raw === 'string' ? parseClientMsg(raw) : null;
    if (!msg) {
      this.sendError(conn, null, 'invalid');
      return;
    }
    const state = stateOf(conn);
    if (msg.type === 'hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!state?.ready) {
      this.sendError(conn, 'reqId' in msg ? msg.reqId : null, 'not_ready');
      return;
    }
    this.dispatch(conn, state, msg);
  }

  /** Every message type after hello. */
  protected dispatch(conn: BoardConn, state: ConnState, msg: Exclude<ClientMsg, { type: 'hello' }>): void {
    switch (msg.type) {
      case 'profile':
        if (!this.limitsFor(conn.id).profile.take()) {
          this.sendError(conn, null, 'rate_limited');
          return;
        }
        this.updateState(conn, { profile: msg.profile });
        return;
      case 'cursor':
        this.onCursor(conn, state, msg.x, msg.y);
        return;
      case 'dock':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'tile', slot: msg.slot, mode: msg.mode } });
        return;
      case 'away':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'away' } });
        return;
      default:
        handleTileMsg(this.tileHost(), conn, state, msg);
    }
  }

  /** Runs after every successful post: link check and screenshot. */
  protected afterPost(row: VersionRow): void {
    startContentChecks(this.contentHost(), row);
  }

  onRequest(request: Request): Promise<Response> {
    return handleHttp(this.contentHost(), request);
  }

  async onAlarm(): Promise<void> {
    const next = await runAlarm(this.contentHost());
    if (next !== null) await this.ctx.storage.setAlarm(next);
    this.budget.flush();
  }

  private contentHost(): ContentHost {
    return {
      store: this.store,
      board: this.name,
      env: this.env,
      now: () => this.now(),
      // Looked up per call so a stubbed global fetch applies.
      fetchImpl: this.seams.fetchImpl ?? ((input, init) => fetch(input, init)),
      shots: this.shotSession(),
      uploads: (this.uploads ??= createUploadLimiter(() => this.now())),
      broadcast: (msg) => this.broadcastReady(msg),
      scheduleAlarm: (at) => this.scheduleAlarm(at),
      waitUntil: (p) => this.ctx.waitUntil(p.catch((e: unknown) => console.error('content task failed', e))),
    };
  }

  private shotSession(): ShooterSession | null {
    if (this.shots) return this.shots;
    const browser = this.env.BROWSER;
    const create = this.seams.shooter ?? (browser ? () => createBrowserShooter(browser) : null);
    if (!create) return null;
    this.shots = new ShooterSession(create);
    return this.shots;
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private tileHost(): TileHost {
    this.host ??= {
      store: this.store,
      board: this.name,
      now: () => this.now(),
      isLocked: () => this.locked,
      setLocked: (locked) => {
        this.locked = locked;
        this.store.setMeta(META_LOCKED, locked ? '1' : '0');
      },
      gate: () => (this.teacherGate ??= new TeacherGate(this.env.TEACHER_CODE, () => this.now())),
      limits: (id) => this.limitsFor(id),
      send: (conn, msg) => this.send(conn, msg),
      fail: (conn, reqId, code) => this.sendError(conn, reqId, code),
      broadcast: (msg) => this.broadcastReady(msg),
      findPerson: (id) => this.findPerson(id),
      updateState: (conn, patch) => this.updateState(conn, patch),
      afterPost: (row) => this.afterPost(row),
    };
    return this.host;
  }

  private findPerson(id: string): { conn: BoardConn; state: ConnState } | null {
    for (const conn of this.getConnections()) {
      const state = stateOf(conn);
      if (conn.id === id && state?.ready) return { conn: conn as BoardConn, state };
    }
    return null;
  }

  private onHello(conn: BoardConn, msg: Extract<ClientMsg, { type: 'hello' }>): void {
    const prev = stateOf(conn);
    const wasReady = prev?.ready === true;
    const next: ConnState = {
      clientId: msg.clientId,
      profile: msg.profile,
      presence: { at: 'board' },
      ready: true,
      teacher: prev?.teacher ?? false,
    };
    conn.setState(next);
    this.broadcastReady(
      { type: 'person', event: wasReady ? 'updated' : 'joined', person: this.personOf(conn.id, next) },
      conn.id,
    );
    this.send(conn, {
      type: 'snapshot',
      board: this.name,
      you: conn.id,
      tiles: this.store.allCurrent().map((row, slot) => toTileView(this.name, slot, row)),
      locked: this.locked,
      people: this.people(),
      rate: this.budget.hz(),
    });
  }

  private onCursor(conn: BoardConn, state: ConnState, x: number, y: number): void {
    if (this.budget.hz() === 0) return;
    if (!this.limitsFor(conn.id).cursor.take()) return;
    if (state.presence.at !== 'board') this.updateState(conn, { presence: { at: 'board' } });
    this.pending.set(conn.id, [x, y]);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushCursors(), RATES.cursorBatchMs);
    }
  }

  private flushCursors(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const moves: CursorMove[] = [...this.pending].map(([id, [x, y]]) => [id, x, y]);
    this.pending.clear();
    for (const conn of this.getConnections()) {
      if (!stateOf(conn)?.ready) continue;
      const others = moves.filter((m) => m[0] !== conn.id);
      if (others.length > 0) this.send(conn, { type: 'cursors', moves: others });
    }
  }

  onClose(conn: BoardConn): void {
    this.pending.delete(conn.id);
    this.limits.delete(conn.id);
    if (stateOf(conn)?.ready) this.broadcastReady({ type: 'personLeft', id: conn.id });
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open === 0) this.budget.flush(true);
  }

  /** Broadcasts `rate` when the budget crosses a threshold. */
  private checkRate(): void {
    const hz = this.budget.hz();
    if (hz === this.lastHz) return;
    this.lastHz = hz;
    this.broadcastReady({ type: 'rate', hz });
  }

  protected limitsFor(connId: string): ConnLimits {
    let limits = this.limits.get(connId);
    if (!limits) {
      limits = createConnLimits(() => this.now());
      this.limits.set(connId, limits);
    }
    return limits;
  }

  /** Merges into the connection's state and tells everyone about the person. */
  protected updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState {
    const next = { ...(stateOf(conn) as ConnState), ...patch };
    conn.setState(next);
    this.broadcastReady({ type: 'person', event: 'updated', person: this.personOf(conn.id, next) });
    return next;
  }

  protected personOf(id: string, s: ConnState): Person {
    return { id, clientId: s.clientId, profile: s.profile, presence: s.presence };
  }

  protected people(): Person[] {
    const out: Person[] = [];
    for (const conn of this.getConnections()) {
      const s = stateOf(conn);
      if (s?.ready) out.push(this.personOf(conn.id, s));
    }
    return out;
  }

  protected send(conn: Connection, msg: ServerMsg): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // The socket closed between the check and the send; onClose cleans up.
    }
  }

  protected sendError(conn: Connection, reqId: string | null, code: ErrorCode): void {
    this.send(conn, { type: 'error', reqId, code, message: ERROR_TEXT[code] });
  }

  /** Sends to every connection that has said hello, except `exceptId`. */
  protected broadcastReady(msg: ServerMsg, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const conn of this.getConnections()) {
      if (conn.id === exceptId || !stateOf(conn)?.ready) continue;
      try {
        conn.send(data);
      } catch {
        // Closed mid-broadcast; onClose cleans up.
      }
    }
  }
}
```

- [ ] **Step 5: Replace `worker/src/index.ts` completely**

```ts
import { routePartykitRequest } from 'partyserver';
import { BOARD_NAME_RE } from '@class-board/shared/constants';
import { Board } from './board';
import type { Env } from './env';
import { corsHeaders, parseOrigins } from './files';

export { Board };

const PARTY_RE = /^\/parties\/board\/([^/]+)\/?$/;
const HTTP_RE = /^\/boards\/([^/]+)\/(?:files|shots)(?:\/[^/]*)?$/;

function notFound(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowed = parseOrigins(env.ALLOWED_ORIGINS);

    const party = PARTY_RE.exec(url.pathname);
    if (party) {
      if (!BOARD_NAME_RE.test(party[1]!)) return notFound();
      const response = await routePartykitRequest(request, env, {
        onBeforeConnect: (req) => {
          const origin = req.headers.get('Origin');
          if (!origin || !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
        },
        // The realtime route only takes WebSocket upgrades.
        onBeforeRequest: () => notFound(),
      });
      return response ?? notFound();
    }

    const http = HTTP_RE.exec(url.pathname);
    if (http) {
      const cors = corsHeaders(request.headers.get('Origin'), allowed);
      if (!BOARD_NAME_RE.test(http[1]!)) return notFound(cors);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      // One Durable Object call: Server reads its name from ctx.id.name. getServerByName would add a setName RPC.
      const stub = env.Board.get(env.Board.idFromName(http[1]!));
      return withHeaders(await stub.fetch(request), cors);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run test:do -w worker -- board.content`
Expected: PASS, 14 tests in `test/board.content.test.ts`.

Then run all of this workstream's Durable Object tests. No other task touches these files in wave 5.
Run: `npm run test:do -w worker -- board store`
Expected: PASS, 77 tests in 4 files (session 20, tiles 26, content 14, store 17).

- [ ] **Step 7: Commit (orchestrator)**

```bash
git add worker/src/content.ts worker/src/board.ts worker/src/index.ts worker/test/board.content.test.ts
git commit -m "feat(worker): Content: link checks after posting, upload/file/shot routes, screenshot alarm (W4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
