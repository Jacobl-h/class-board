import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { ErrorCode, RequestMsg, ServerMsg, TileView, VersionSummary } from '@class-board/shared/types';
import type { BoardSocket, BoardStateApi, HistoryDeps } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { openHistory } from '../src/tiles/historyPanel';

const C4 = 23;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const SERVER = 'http://localhost:8787';

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

function tile(version: number): TileView {
  return {
    slot: C4, version, kind: 'link', label: 'Maya', url: 'https://game.example.com/', embedUrl: 'https://game.example.com/',
    fileUrl: null, title: 'Game', icon: null, embeddable: 'yes', note: null, shotUrl: null, authorName: 'Maya',
    createdAt: NOW,
  };
}

function version(id: number, patch: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id, slot: C4, kind: 'link', label: 'Maya', title: `Version ${id}`, url: 'https://game.example.com/',
    fileUrl: null, shotUrl: null, authorName: 'Maya', createdAt: NOW - 5 * 60_000, ...patch,
  };
}

function serverError(code: ErrorCode): Error & { code: ErrorCode } {
  return Object.assign(new Error(code), { code });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(opts: { current?: number; canRestore?: boolean } = {}) {
  const tiles = Array.from({ length: SLOT_COUNT }, () => tile(0));
  tiles[C4] = tile(opts.current ?? 3);
  const sent: RequestMsg[] = [];
  const replies: Array<(msg: RequestMsg) => Promise<Reply>> = [];
  const socket = {
    request: vi.fn((msg: RequestMsg) => {
      sent.push(msg);
      const next = replies.shift();
      return next ? next(msg) : Promise.resolve({ type: 'ok', reqId: msg.reqId } as Reply);
    }),
  } as unknown as BoardSocket;
  const deps: HistoryDeps = {
    socket,
    state: { tile: (slot: number) => tiles[slot] } as unknown as BoardStateApi,
    serverUrl: SERVER,
    canRestore: () => opts.canRestore ?? true,
  };
  return {
    deps,
    sent,
    tiles,
    /** Queue the reply for the next request. */
    reply(fn: (msg: RequestMsg) => Promise<Reply>) {
      replies.push(fn);
    },
    history(versions: VersionSummary[]) {
      replies.push(async (msg) => ({ type: 'historyResult', reqId: msg.reqId, slot: C4, versions }));
    },
  };
}

const dialog = () => document.querySelector<HTMLElement>('.modal[data-dialog="history"]');
const rows = () => [...dialog()!.querySelectorAll<HTMLElement>('.history-row')];
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="modal-root"></div>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openHistory', () => {
  it('opens the history modal in a loading state and requests the slot history', () => {
    const env = makeDeps();
    env.reply(() => new Promise<Reply>(() => {}));
    openHistory(env.deps, C4);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('.history-status')!.textContent).toBe('Loading history…');
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]).toMatchObject({ type: 'history', slot: C4 });
    expect(env.sent[0]!.reqId).toMatch(/^[0-9a-z]{12}$/);
  });

  it('lists versions newest first with who, when and the title', async () => {
    const env = makeDeps({ current: 3 });
    env.history([
      version(1, { authorName: 'Ben', createdAt: NOW - 2 * 3_600_000, title: null, kind: 'html', url: null }),
      version(3, { authorName: 'Maya', createdAt: NOW - 10_000 }),
      version(2, { authorName: 'Ana', createdAt: NOW - 3 * 86_400_000, title: null }),
    ]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows().map((r) => r.dataset.version)).toEqual(['3', '2', '1']);
    const [newest, middle, oldest] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(newest.querySelector('.history-title')!.textContent).toBe('Version 3');
    expect(newest.querySelector('.history-meta')!.textContent).toBe('Maya · just now');
    expect(middle.querySelector('.history-title')!.textContent).toBe('game.example.com');
    expect(middle.querySelector('.history-meta')!.textContent).toBe('Ana · 3 days ago');
    expect(oldest.querySelector('.history-title')!.textContent).toBe('HTML page');
    expect(oldest.querySelector('.history-meta')!.textContent).toBe('Ben · 2 h ago');
    expect(dialog()!.querySelector<HTMLElement>('.history-status')!.hidden).toBe(true);
  });

  it('shows a thumbnail resolved against the server URL', async () => {
    const env = makeDeps();
    env.history([
      version(2, { shotUrl: '/boards/main/shots/abc' }),
      version(1, { shotUrl: 'https://i.ytimg.com/vi/xyz/hqdefault.jpg' }),
    ]);
    openHistory(env.deps, C4);
    await flush();
    const [a, b] = rows().map((r) => r.querySelector<HTMLImageElement>('img.history-thumb')!) as [HTMLImageElement, HTMLImageElement];
    expect(a.getAttribute('src')).toBe('http://localhost:8787/boards/main/shots/abc');
    expect(b.getAttribute('src')).toBe('https://i.ytimg.com/vi/xyz/hqdefault.jpg');
  });

  it('marks the current version and offers Restore only on the others', async () => {
    const env = makeDeps({ current: 2 });
    env.history([version(3), version(2), version(1)]);
    openHistory(env.deps, C4);
    await flush();
    const current = dialog()!.querySelector<HTMLElement>('.history-row[data-version="2"]')!;
    expect(current.classList.contains('is-current')).toBe(true);
    expect(current.querySelector('.history-current')!.textContent).toBe('Current');
    expect(current.querySelector('[data-action="restore"]')).toBeNull();
    expect(dialog()!.querySelectorAll('[data-action="restore"]')).toHaveLength(2);
  });

  it('hides Restore when restoring is not allowed', async () => {
    const env = makeDeps({ canRestore: false });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows()).toHaveLength(2);
    expect(dialog()!.querySelectorAll('[data-action="restore"]')).toHaveLength(0);
  });

  it('restores against the tile version at click time and closes on ok', async () => {
    const env = makeDeps({ current: 3 });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    env.tiles[C4] = tile(4); // someone posted while the panel was open
    const pending = deferred<Reply>();
    env.reply(() => pending.promise);
    dialog()!.querySelector<HTMLButtonElement>('.history-row[data-version="2"] [data-action="restore"]')!.click();
    expect(env.sent[1]).toMatchObject({ type: 'restore', slot: C4, versionId: 2, baseVersion: 4 });
    expect(dialog()!.querySelector<HTMLButtonElement>('[data-action="restore"]')!.disabled).toBe(true);
    pending.resolve({ type: 'ok', reqId: env.sent[1]!.reqId });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('shows a restore error and re-enables the buttons', async () => {
    const env = makeDeps({ current: 3 });
    env.history([version(3), version(2)]);
    openHistory(env.deps, C4);
    await flush();
    env.reply(async () => {
      throw serverError('locked');
    });
    const button = dialog()!.querySelector<HTMLButtonElement>('[data-action="restore"]')!;
    button.click();
    await flush();
    const error = dialog()!.querySelector<HTMLElement>('.dialog-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(errorText('locked'));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Restore');
  });

  it('shows an error when the history cannot be loaded', async () => {
    const env = makeDeps();
    env.reply(async () => {
      throw serverError('rate_limited');
    });
    openHistory(env.deps, C4);
    await flush();
    const error = dialog()!.querySelector<HTMLElement>('.dialog-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(errorText('rate_limited'));
    expect(dialog()!.querySelector<HTMLElement>('.history-status')!.hidden).toBe(true);
  });

  it('says so when the tile has no versions', async () => {
    const env = makeDeps({ current: 0 });
    env.history([]);
    openHistory(env.deps, C4);
    await flush();
    expect(rows()).toHaveLength(0);
    expect(dialog()!.querySelector('.history-status')!.textContent).toBe('Nothing has been posted here yet.');
  });
});
