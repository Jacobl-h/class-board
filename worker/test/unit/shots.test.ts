import { describe, expect, it } from 'vitest';
import {
  BusyError, DailyLimitError, allowShotRequest, createBrowserShooter, runShotQueue, shotTarget, type ShotDeps, type Shooter,
} from '../../src/shots';
import type { BoardStore, VersionRow } from '../../src/store';

const BOARD = 'main';
const PUBLIC = 'https://board-api.example.workers.dev';
const FILE_ID = 'a'.repeat(32);
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

function row(over: Partial<VersionRow> = {}): VersionRow {
  return {
    id: 1, slot: 0, created_at: T0, author_client: 'c', author_name: 'Maya',
    kind: 'link', label: 'Maya', url: 'https://site.example/page', embed_url: 'https://site.example/page',
    file_id: null, title: null, icon: null, embeddable: 'yes', note: null, shot_id: null, thumb_url: null,
    ...over,
  };
}

describe('shotTarget', () => {
  it('photographs a link at its url', () => {
    expect(shotTarget(row(), BOARD, PUBLIC)).toBe('https://site.example/page');
  });

  it('photographs a published Claude artifact at its /embed address', () => {
    const r = row({
      url: 'https://claude.ai/public/artifacts/abc-123',
      embed_url: 'https://claude.ai/public/artifacts/abc-123/embed',
    });
    expect(shotTarget(r, BOARD, PUBLIC)).toBe('https://claude.ai/public/artifacts/abc-123/embed');
  });

  it('uses the url, not the rewritten embed address, for other rewrites', () => {
    const r = row({ url: 'https://example.org/a', embed_url: 'https://example.org/a?embed=1' });
    expect(shotTarget(r, BOARD, PUBLIC)).toBe('https://example.org/a');
  });

  it('skips a newer Claude artifact, which only shows a sign-in page', () => {
    for (const url of ['https://claude.ai/artifact/xyz', 'https://claude.ai/code/artifact/xyz']) {
      expect(shotTarget(row({ url, embed_url: null, embeddable: 'no' }), BOARD, PUBLIC)).toBeNull();
    }
  });

  it('skips YouTube, whose thumbnail needs no browser', () => {
    const r = row({
      url: 'https://youtu.be/abc', embed_url: 'https://www.youtube-nocookie.com/embed/abc',
      thumb_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    });
    expect(shotTarget(r, BOARD, PUBLIC)).toBeNull();
  });

  it('photographs an upload at the Worker public URL', () => {
    const r = row({ kind: 'html', url: null, embed_url: null, file_id: FILE_ID });
    expect(shotTarget(r, BOARD, PUBLIC)).toBe(`${PUBLIC}/boards/main/files/${FILE_ID}`);
  });

  it('ignores a trailing slash on the public URL', () => {
    const r = row({ kind: 'html', url: null, embed_url: null, file_id: FILE_ID });
    expect(shotTarget(r, BOARD, `${PUBLIC}/`)).toBe(`${PUBLIC}/boards/main/files/${FILE_ID}`);
  });

  it('skips empty tiles, links with no url, and uploads with no file', () => {
    expect(shotTarget(row({ kind: 'empty', url: null, embed_url: null }), BOARD, PUBLIC)).toBeNull();
    expect(shotTarget(row({ url: null, embed_url: null }), BOARD, PUBLIC)).toBeNull();
    expect(shotTarget(row({ kind: 'html', url: null, embed_url: null, file_id: null }), BOARD, PUBLIC)).toBeNull();
  });
});

/** The parts of BoardStore that runShotQueue calls, kept in memory. */
class FakeStore {
  rows = new Map<number, VersionRow>();
  currentIds = new Map<number, number>();
  queue = new Map<number, { attempts: number; notBefore: number }>();
  shots = new Map<string, ArrayBuffer>();
  patches: Array<{ id: number; shot_id: string | null | undefined }> = [];

  addRow(r: VersionRow, opts: { current?: boolean; queued?: boolean; attempts?: number; notBefore?: number } = {}) {
    this.rows.set(r.id, r);
    if (opts.current !== false) this.currentIds.set(r.slot, r.id);
    if (opts.queued !== false) this.queue.set(r.id, { attempts: opts.attempts ?? 0, notBefore: opts.notBefore ?? T0 });
    return r;
  }
  current(slot: number) { return this.rows.get(this.currentIds.get(slot) ?? -1) ?? null; }
  get(id: number) { return this.rows.get(id) ?? null; }
  patch(id: number, p: { shot_id?: string | null }) {
    const r = this.rows.get(id);
    if (!r) return null;
    const next = { ...r, ...p };
    this.rows.set(id, next);
    this.patches.push({ id, shot_id: p.shot_id });
    return next;
  }
  putShot(id: string, jpeg: ArrayBuffer) { this.shots.set(id, jpeg); }
  dueShot(now: number) {
    const due = [...this.queue].filter(([, q]) => q.notBefore <= now).sort((a, b) => a[1].notBefore - b[1].notBefore || a[0] - b[0]);
    return due[0] ? { versionId: due[0][0], attempts: due[0][1].attempts } : null;
  }
  retryShot(versionId: number, attempts: number, notBefore: number) { this.queue.set(versionId, { attempts, notBefore }); }
  dropShot(versionId: number) { this.queue.delete(versionId); }
  nextShotAt() {
    const times = [...this.queue.values()].map((q) => q.notBefore);
    return times.length ? Math.min(...times) : null;
  }
  asStore() { return this as unknown as BoardStore; }
}

type Outcome = ArrayBuffer | Error;

class FakeShooter implements Shooter {
  urls: string[] = [];
  closed = 0;
  constructor(private readonly outcomes: Outcome[] = [], private readonly before?: () => void) {}
  async shoot(url: string): Promise<ArrayBuffer> {
    this.urls.push(url);
    this.before?.();
    const next = this.outcomes.shift() ?? new Uint8Array([0xff, 0xd8]).buffer;
    if (next instanceof Error) throw next;
    return next;
  }
  async close() { this.closed += 1; }
}

function setup(opts: { shooter?: FakeShooter | null } = {}) {
  const store = new FakeStore();
  let now = T0;
  const updated: VersionRow[] = [];
  const shooter = opts.shooter === undefined ? new FakeShooter() : opts.shooter;
  let shooterCalls = 0;
  const deps: ShotDeps = {
    store: store.asStore(), board: BOARD, publicUrl: PUBLIC,
    shooter: () => { shooterCalls += 1; return shooter; },
    now: () => now,
    onUpdated: (r) => updated.push(r),
  };
  return { store, deps, shooter, updated, shooterCalls: () => shooterCalls, setNow: (t: number) => void (now = t) };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

describe('runShotQueue: a shot succeeds', () => {
  it('photographs the target, saves the picture, patches shot_id, announces it and drops the job', async () => {
    const { store, deps, shooter, updated } = setup({ shooter: new FakeShooter([JPEG]) });
    store.addRow(row({ id: 7, slot: 3 }));

    const next = await runShotQueue(deps);

    expect(shooter!.urls).toEqual(['https://site.example/page']);
    expect(store.shots.size).toBe(1);
    const [shotId, saved] = [...store.shots][0]!;
    expect(shotId).toMatch(/^[0-9a-f]{32}$/);
    expect(saved).toBe(JPEG);
    expect(store.get(7)!.shot_id).toBe(shotId);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.id).toBe(7);
    expect(updated[0]!.shot_id).toBe(shotId);
    expect(store.queue.size).toBe(0);
    expect(next).toBeNull();
  });

  it('photographs an upload through the Worker public URL', async () => {
    const { store, deps, shooter } = setup();
    store.addRow(row({ id: 2, kind: 'html', url: null, embed_url: null, file_id: FILE_ID }));
    await runShotQueue(deps);
    expect(shooter!.urls).toEqual([`${PUBLIC}/boards/main/files/${FILE_ID}`]);
  });

  it('does nothing and returns null when nothing is queued', async () => {
    const { deps, shooterCalls } = setup();
    expect(await runShotQueue(deps)).toBeNull();
    expect(shooterCalls()).toBe(0);
  });

  it('leaves jobs that are not due yet and returns when the first is due', async () => {
    const { store, deps, shooter } = setup();
    store.addRow(row({ id: 1, slot: 0 }), { notBefore: T0 + 5_000 });
    store.addRow(row({ id: 2, slot: 1 }), { notBefore: T0 + 9_000 });
    expect(await runShotQueue(deps)).toBe(T0 + 5_000);
    expect(shooter!.urls).toEqual([]);
  });
});

describe('runShotQueue: how many jobs per run', () => {
  function fiveRows(store: FakeStore) {
    for (let i = 1; i <= 5; i += 1) store.addRow(row({ id: i, slot: i, url: `https://site.example/${i}` }), { notBefore: T0 - 10 + i });
  }

  it('takes three by default and returns the time of the next one', async () => {
    const { store, deps, shooter } = setup();
    fiveRows(store);
    const next = await runShotQueue(deps);
    expect(shooter!.urls).toEqual(['https://site.example/1', 'https://site.example/2', 'https://site.example/3']);
    expect(next).toBe(T0 - 10 + 4);
  });

  it('takes as many as maxJobs says', async () => {
    const { store, deps, shooter } = setup();
    fiveRows(store);
    await runShotQueue(deps, 1);
    expect(shooter!.urls).toHaveLength(1);
    await runShotQueue(deps, 10);
    expect(shooter!.urls).toHaveLength(5);
    expect(store.queue.size).toBe(0);
  });

  it('does not count skipped rows against maxJobs', async () => {
    const { store, deps, shooter } = setup();
    store.addRow(row({ id: 1, slot: 1 }), { current: false, notBefore: T0 - 30 });
    store.addRow(row({ id: 2, slot: 1, url: 'https://site.example/two' }), { notBefore: T0 - 20 });
    store.addRow(row({ id: 3, slot: 2, kind: 'empty', url: null, embed_url: null }), { notBefore: T0 - 10 });
    store.addRow(row({ id: 4, slot: 4, url: 'https://site.example/four' }), { notBefore: T0 });
    await runShotQueue(deps, 2);
    expect(shooter!.urls).toEqual(['https://site.example/two', 'https://site.example/four']);
  });
});

describe('runShotQueue: rows that need no shot', () => {
  it('skips and drops a version that is no longer the tile\'s current one', async () => {
    const { store, deps, shooter, updated } = setup();
    store.addRow(row({ id: 1, slot: 5 }), { current: false });
    store.addRow(row({ id: 2, slot: 5, url: 'https://site.example/new' }), { queued: false });
    await runShotQueue(deps);
    expect(shooter!.urls).toEqual([]);
    expect(updated).toEqual([]);
    expect(store.queue.size).toBe(0);
  });

  it('drops a job whose version no longer exists', async () => {
    const { store, deps, shooter } = setup();
    store.queue.set(99, { attempts: 0, notBefore: T0 });
    await runShotQueue(deps);
    expect(shooter!.urls).toEqual([]);
    expect(store.queue.size).toBe(0);
  });

  it('drops a job for a version that already has a picture', async () => {
    const { store, deps, shooter } = setup();
    store.addRow(row({ id: 1, shot_id: 'b'.repeat(32) }));
    await runShotQueue(deps);
    expect(shooter!.urls).toEqual([]);
    expect(store.queue.size).toBe(0);
  });

  it('drops YouTube and empty tiles without asking for a browser', async () => {
    const { store, deps, shooterCalls } = setup();
    store.addRow(row({ id: 1, slot: 1, thumb_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }));
    store.addRow(row({ id: 2, slot: 2, kind: 'empty', url: null, embed_url: null }));
    await runShotQueue(deps);
    expect(store.queue.size).toBe(0);
    expect(shooterCalls()).toBe(0);
  });
});

describe('runShotQueue: no browser available', () => {
  it('drops the due jobs without failing when there is no shooter', async () => {
    const { store, deps, shooterCalls } = setup({ shooter: null });
    store.addRow(row({ id: 1, slot: 1 }));
    store.addRow(row({ id: 2, slot: 2 }));
    expect(await runShotQueue(deps)).toBeNull();
    expect(store.queue.size).toBe(0);
    expect(shooterCalls()).toBe(1);
  });
});

describe('runShotQueue: the daily browser limit', () => {
  it('retries at 00:05 UTC the next day with the same attempt count, and stops', async () => {
    const { store, deps, shooter } = setup({ shooter: new FakeShooter([new DailyLimitError('Browser time limit exceeded for today')]) });
    store.addRow(row({ id: 1, slot: 1 }), { attempts: 1, notBefore: T0 - 2 });
    store.addRow(row({ id: 2, slot: 2 }), { notBefore: T0 - 1 });

    const next = await runShotQueue(deps);

    const tomorrow = Date.UTC(2026, 8, 30, 0, 5, 0);
    expect(shooter!.urls).toHaveLength(1);
    expect(store.queue.get(1)).toEqual({ attempts: 1, notBefore: tomorrow });
    expect(next).toBe(tomorrow);
  });

  it('moves every other due job to tomorrow too, so the alarm does not spin', async () => {
    const { store, deps, shooter } = setup({ shooter: new FakeShooter([new DailyLimitError('limit')]) });
    for (let i = 1; i <= 4; i += 1) store.addRow(row({ id: i, slot: i }), { notBefore: T0 - 10 + i });
    await runShotQueue(deps);
    const tomorrow = Date.UTC(2026, 8, 30, 0, 5, 0);
    expect(shooter!.urls).toHaveLength(1);
    expect([...store.queue.values()].map((q) => q.notBefore)).toEqual([tomorrow, tomorrow, tomorrow, tomorrow]);
  });

  it('leaves jobs that were not due yet on their own schedule', async () => {
    const { store, deps } = setup({ shooter: new FakeShooter([new DailyLimitError('limit')]) });
    store.addRow(row({ id: 1, slot: 1 }));
    store.addRow(row({ id: 2, slot: 2 }), { notBefore: T0 + 3_600_000 });
    await runShotQueue(deps);
    expect(store.queue.get(2)!.notBefore).toBe(T0 + 3_600_000);
  });

  it('rolls over the month and the year', async () => {
    const { store, deps, setNow } = setup({ shooter: new FakeShooter([new DailyLimitError('limit')]) });
    const lateOnNewYearsEve = Date.UTC(2026, 11, 31, 23, 59, 30);
    setNow(lateOnNewYearsEve);
    store.addRow(row({ id: 1 }), { notBefore: lateOnNewYearsEve });
    expect(await runShotQueue(deps)).toBe(Date.UTC(2027, 0, 1, 0, 5, 0));
  });

  it('does not count the limit as a failed attempt', async () => {
    const { store, deps } = setup({ shooter: new FakeShooter([new DailyLimitError('limit')]) });
    store.addRow(row({ id: 1 }), { attempts: 2 });
    await runShotQueue(deps);
    expect(store.queue.get(1)!.attempts).toBe(2);
  });
});

describe('runShotQueue: Browser Rendering is busy', () => {
  it('moves every due job 30 seconds later without counting an attempt, and stops the run', async () => {
    const { store, deps, shooter } = setup({ shooter: new FakeShooter([new BusyError('429 Too many requests')]) });
    store.addRow(row({ id: 1, slot: 1 }), { attempts: 1, notBefore: T0 - 2 });
    store.addRow(row({ id: 2, slot: 2 }), { notBefore: T0 - 1 });

    const next = await runShotQueue(deps);

    expect(shooter!.urls).toHaveLength(1);
    expect(store.queue.get(1)).toEqual({ attempts: 1, notBefore: T0 + 30_000 });
    expect(store.queue.get(2)).toEqual({ attempts: 0, notBefore: T0 + 30_000 });
    expect(next).toBe(T0 + 30_000);
    expect(shooter!.closed).toBe(1);
  });
});

describe('runShotQueue: other failures', () => {
  it('retries after 1 minute, then 5 minutes, then gives up after the third failure', async () => {
    const fail = () => new Error('net::ERR_CONNECTION_REFUSED');
    const { store, deps, shooter, setNow, updated } = setup({ shooter: new FakeShooter([fail(), fail(), fail()]) });
    store.addRow(row({ id: 1 }));

    expect(await runShotQueue(deps)).toBe(T0 + 60_000);
    expect(store.queue.get(1)).toEqual({ attempts: 1, notBefore: T0 + 60_000 });

    setNow(T0 + 60_000);
    expect(await runShotQueue(deps)).toBe(T0 + 60_000 + 300_000);
    expect(store.queue.get(1)).toEqual({ attempts: 2, notBefore: T0 + 360_000 });

    setNow(T0 + 360_000);
    expect(await runShotQueue(deps)).toBeNull();
    expect(store.queue.size).toBe(0);
    expect(shooter!.urls).toHaveLength(3);
    expect(store.shots.size).toBe(0);
    expect(updated).toEqual([]);
  });

  it('does not run a retry before it is due', async () => {
    const { store, deps, shooter } = setup({ shooter: new FakeShooter([new Error('boom')]) });
    store.addRow(row({ id: 1 }));
    await runShotQueue(deps);
    await runShotQueue(deps);
    expect(shooter!.urls).toHaveLength(1);
  });

  it('carries on with the next job after a failure', async () => {
    const { store, deps, shooter, updated } = setup({ shooter: new FakeShooter([new Error('boom'), JPEG]) });
    store.addRow(row({ id: 1, slot: 1, url: 'https://site.example/bad' }), { notBefore: T0 - 2 });
    store.addRow(row({ id: 2, slot: 2, url: 'https://site.example/good' }), { notBefore: T0 - 1 });
    await runShotQueue(deps);
    expect(shooter!.urls).toEqual(['https://site.example/bad', 'https://site.example/good']);
    expect(updated.map((r) => r.id)).toEqual([2]);
    expect(store.queue.get(1)!.attempts).toBe(1);
  });

  it('gives up right away when the job already used its attempts', async () => {
    const { store, deps } = setup({ shooter: new FakeShooter([new Error('boom')]) });
    store.addRow(row({ id: 1 }), { attempts: 2 });
    expect(await runShotQueue(deps)).toBeNull();
    expect(store.queue.size).toBe(0);
  });
});

describe('runShotQueue: the browser session', () => {
  it('asks for the shooter once per run and closes it afterwards', async () => {
    const { store, deps, shooter, shooterCalls } = setup();
    for (let i = 1; i <= 3; i += 1) store.addRow(row({ id: i, slot: i }));
    await runShotQueue(deps);
    expect(shooterCalls()).toBe(1);
    expect(shooter!.closed).toBe(1);
  });

  it('closes the shooter after a failure too', async () => {
    const { store, deps, shooter } = setup({ shooter: new FakeShooter([new DailyLimitError('limit')]) });
    store.addRow(row({ id: 1 }));
    await runShotQueue(deps);
    expect(shooter!.closed).toBe(1);
  });

  it('does not close a shooter it never asked for', async () => {
    const { store, deps, shooter } = setup();
    store.addRow(row({ id: 1 }), { current: false });
    await runShotQueue(deps);
    expect(shooter!.closed).toBe(0);
  });

  it('keeps going when close itself fails', async () => {
    const shooter = new FakeShooter();
    shooter.close = async () => { throw new Error('already gone'); };
    const { store, deps } = setup({ shooter });
    store.addRow(row({ id: 1 }));
    await expect(runShotQueue(deps)).resolves.toBeNull();
  });
});

describe('runShotQueue: a version replaced while it is photographed', () => {
  it('keeps the picture for History but does not announce it for the tile', async () => {
    const holder: { store?: FakeStore } = {};
    const shooter = new FakeShooter([JPEG], () => {
      holder.store!.addRow(row({ id: 2, slot: 1, url: 'https://site.example/newer' }), { queued: false });
    });
    const { store, deps, updated } = setup({ shooter });
    holder.store = store;
    store.addRow(row({ id: 1, slot: 1 }));

    await runShotQueue(deps);

    expect(store.get(1)!.shot_id).toMatch(/^[0-9a-f]{32}$/);
    expect(updated).toEqual([]);
    expect(store.queue.size).toBe(0);
  });
});

describe('createBrowserShooter', () => {
  /** A Browser Rendering binding that answers the REST calls puppeteer makes before it opens a websocket. */
  function binding(handlers: { sessions?: () => Response; acquire?: () => Response }) {
    const calls: string[] = [];
    const fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
        if (url.includes('/v1/sessions')) return handlers.sessions?.() ?? Response.json({ sessions: [] });
        if (url.includes('/v1/devtools/browser')) return handlers.acquire?.() ?? new Response('unexpected', { status: 500 });
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;
    return { fetcher, calls };
  }

  it('turns "Browser time limit exceeded" into a DailyLimitError', async () => {
    const { fetcher } = binding({ acquire: () => new Response('Browser time limit exceeded for today', { status: 429 }) });
    await expect(createBrowserShooter(fetcher).shoot('https://site.example/')).rejects.toBeInstanceOf(DailyLimitError);
  });

  it('launches a browser with a short keep-alive when there is no session to reuse', async () => {
    const { fetcher, calls } = binding({ acquire: () => new Response('Browser time limit exceeded for today', { status: 429 }) });
    await createBrowserShooter(fetcher).shoot('https://site.example/').catch(() => {});
    expect(calls).toEqual(['GET /v1/sessions', 'POST /v1/devtools/browser?keep_alive=60000']);
  });

  it('turns other 429 refusals (too many browsers too fast) into a BusyError', async () => {
    const { fetcher } = binding({ acquire: () => new Response('Too many requests', { status: 429 }) });
    const err = await createBrowserShooter(fetcher).shoot('https://site.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(err).not.toBeInstanceOf(DailyLimitError);
    expect((err as Error).message).toContain('429');
  });

  it('leaves other launch errors as ordinary errors, so the job is retried', async () => {
    const { fetcher } = binding({ acquire: () => new Response('internal error', { status: 500 }) });
    const err = await createBrowserShooter(fetcher).shoot('https://site.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BusyError);
    expect(err).not.toBeInstanceOf(DailyLimitError);
  });

  it('closes cleanly when it never connected', async () => {
    const { fetcher } = binding({});
    await expect(createBrowserShooter(fetcher).close()).resolves.toBeUndefined();
  });
});

describe('allowShotRequest', () => {
  const PAGE = 'https://site.example/';
  it('allows ordinary public requests', () => {
    expect(allowShotRequest('https://cdn.example/a.js', PAGE)).toBe(true);
  });
  it('blocks private, local and IP targets, including redirect hops', () => {
    for (const u of ['http://127.0.0.1:8080/', 'http://192.168.1.1/', 'http://localhost/x', 'http://printer.local/', 'http://meta.internal/', 'http://[::1]/', 'ftp://site.example/'])
      expect(allowShotRequest(u, PAGE)).toBe(false);
  });
  it('allows the origin of the page being shot, even on localhost', () => {
    const dev = 'http://localhost:8787/boards/main/files/x';
    expect(allowShotRequest('http://localhost:8787/other.css', dev)).toBe(true);
    expect(allowShotRequest('http://localhost:9999/', dev)).toBe(false);
  });
  it('allows in-browser URLs', () => {
    expect(allowShotRequest('data:image/png;base64,AAAA', PAGE)).toBe(true);
  });
});
