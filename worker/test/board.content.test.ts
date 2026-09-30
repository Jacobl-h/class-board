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

describe('link check retry', () => {
  it('tries a failed link check once more before settling on unknown', async () => {
    const board = uniqueBoard();
    const a = await openClient(board);
    await hello(a, 'Ana');
    let calls = 0;
    await inBoard(board, (b) => b.setSeams({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('cold connection timed out');
        return page();
      },
    }));
    postLink(a, 41, 'https://slow.example/');
    const checked = await tileWhere(a, 41, (v) => v.embeddable !== 'pending');
    expect(checked.embeddable).toBe('yes');
    expect(checked.title).toBe('Example page');
  });
});
