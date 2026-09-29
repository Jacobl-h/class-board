import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadError, uploadHtml } from '../src/net/upload';

const SERVER = 'http://localhost:8787';

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('uploadHtml', () => {
  it('POSTs the blob to /boards/<board>/files with the html headers and returns the fileId', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'a'.repeat(32) }));
    const blob = new Blob(['<p>hi</p>'], { type: 'text/html' });
    const id = await uploadHtml(SERVER, 'week-3', blob, 'My page.html');
    expect(id).toBe('a'.repeat(32));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/boards/week-3/files');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect(init.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'X-File-Name': encodeURIComponent('My page.html'),
    });
  });

  it('percent-encodes file names so the header stays ASCII', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'f' }));
    await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'café ☕.html');
    const headers = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-File-Name']).toBe('caf%C3%A9%20%E2%98%95.html');
    expect(headers['X-File-Name']).toMatch(/^[\x20-\x7e]+$/);
  });

  it('copes with a trailing slash on the server url', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'f' }));
    await uploadHtml('https://board.example.workers.dev/', 'main', new Blob(['<p>']), 'a.html');
    expect(fetchFn.mock.calls[0]![0]).toBe('https://board.example.workers.dev/boards/main/files');
  });

  it.each([
    [413, 'too_large'],
    [400, 'invalid'],
    [429, 'rate_limited'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    stubFetch(() => jsonResponse({ error: code }, status));
    const error = await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toBeInstanceOf(Error);
    expect((error as UploadError).code).toBe(code);
  });

  it.each([403, 500, 502])('maps HTTP %i to network', async (status) => {
    stubFetch(() => jsonResponse({ error: 'x' }, status));
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a fetch failure to network', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a success reply without a usable fileId to network', async () => {
    for (const body of [{}, { fileId: 7 }, { fileId: '' }, null]) {
      stubFetch(() => jsonResponse(body));
      await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
    }
    stubFetch(() => new Response('<html>', { status: 200 }));
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('gives every failure a message that says what to do', async () => {
    for (const [status, text] of [[413, /smaller/], [400, /\.html/], [429, /wait/i], [500, /try again/i]] as const) {
      stubFetch(() => jsonResponse({}, status));
      const error = (await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html').catch((e: unknown) => e)) as UploadError;
      expect(error.message).toMatch(text);
    }
  });
});
