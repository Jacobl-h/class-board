import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLink } from '../../src/linkCheck';

const BOARD = 'https://jacobl-h.github.io';

type Reply = Response | Error | (() => Response);

interface Call { url: string; init: RequestInit | undefined }

/** A fetch that answers from a table of URL to response and records every call. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (init?.signal?.aborted) throw init.signal.reason;
    const reply = routes[url];
    if (reply === undefined) throw new Error(`unexpected fetch of ${url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  }) as typeof fetch;
  return { impl, calls };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

async function check(page: Response, url = 'https://site.example/') {
  const { impl } = fakeFetch({ [url]: page });
  return checkLink(url, BOARD, impl);
}

afterEach(() => vi.restoreAllMocks());

describe('checkLink: title', () => {
  it('uses the <title> text', async () => {
    const r = await check(html('<html><head><title>Maya\'s game</title></head></html>'));
    expect(r.title).toBe("Maya's game");
  });

  it('collapses whitespace and trims', async () => {
    const r = await check(html('<title>\n   Space \t  quiz \n</title>'));
    expect(r.title).toBe('Space quiz');
  });

  it('decodes entities', async () => {
    const r = await check(html('<title>Cats &amp; dogs &#39;24 &#x2713;</title>'));
    expect(r.title).toBe("Cats & dogs '24 ✓");
  });

  it('keeps markup inside <title> as text, as browsers do', async () => {
    const r = await check(html('<title>a <b>b</b> c</title>'));
    expect(r.title).toBe('a <b>b</b> c');
  });

  it('prefers og:title over <title>, whichever comes first', async () => {
    const a = await check(html('<title>Plain</title><meta property="og:title" content="Fancy">'));
    const b = await check(html('<meta property="og:title" content="Fancy"><title>Plain</title>'));
    expect(a.title).toBe('Fancy');
    expect(b.title).toBe('Fancy');
  });

  it('accepts og:title given as name=, and cleans it up', async () => {
    const r = await check(html('<meta name="OG:Title" content="  Tom &amp;\n Jerry ">'));
    expect(r.title).toBe('Tom & Jerry');
  });

  it('falls back to <title> when og:title is empty', async () => {
    const r = await check(html('<meta property="og:title" content="  "><title>Plain</title>'));
    expect(r.title).toBe('Plain');
  });

  it('uses the first <title> only', async () => {
    const r = await check(html('<title>First</title><svg><title>Icon</title></svg>'));
    expect(r.title).toBe('First');
  });

  it('gives null when there is no title', async () => {
    expect((await check(html('<p>hello</p>'))).title).toBeNull();
    expect((await check(html('<title>   </title>'))).title).toBeNull();
  });

  it('reads multi-byte characters', async () => {
    const r = await check(html('<title>日本語 ✓ café</title>'));
    expect(r.title).toBe('日本語 ✓ café');
  });

  it('cuts a very long title to 200 characters', async () => {
    const r = await check(html(`<title>${'a'.repeat(500)}</title>`));
    expect(r.title).toHaveLength(200);
  });
});

describe('checkLink: icon', () => {
  it('resolves a relative icon against the page URL', async () => {
    const r = await check(html('<link rel="icon" href="/img/f.png">'), 'https://site.example/a/b');
    expect(r.icon).toBe('https://site.example/img/f.png');
  });

  it('resolves a path relative to the page directory', async () => {
    const r = await check(html('<link rel="icon" href="f.png">'), 'https://site.example/a/b');
    expect(r.icon).toBe('https://site.example/a/f.png');
  });

  it('keeps an absolute icon URL and resolves a protocol-relative one', async () => {
    expect((await check(html('<link rel="icon" href="https://cdn.example/i.png">'))).icon).toBe('https://cdn.example/i.png');
    expect((await check(html('<link rel="icon" href="//cdn.example/i.png">'))).icon).toBe('https://cdn.example/i.png');
  });

  it('accepts "shortcut icon" in any case, with the attributes in any order', async () => {
    const r = await check(html('<link href="/s.ico" type="image/x-icon" REL="Shortcut ICON">'));
    expect(r.icon).toBe('https://site.example/s.ico');
  });

  it('uses the first icon in the document', async () => {
    const r = await check(html('<link rel="icon" href="/one.png"><link rel="icon" href="/two.png">'));
    expect(r.icon).toBe('https://site.example/one.png');
  });

  it('ignores links that are not icons', async () => {
    const r = await check(html('<link rel="stylesheet" href="/s.css"><link rel="mask-icon" href="/m.svg"><link rel="apple-touch-icon" href="/a.png">'));
    expect(r.icon).toBe('https://site.example/favicon.ico');
  });

  it('skips an icon with no usable href and takes the next one', async () => {
    const r = await check(html('<link rel="icon"><link rel="icon" href=" "><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="/ok.png">'));
    expect(r.icon).toBe('https://site.example/ok.png');
  });

  it('decodes entities in the href', async () => {
    const r = await check(html('<link rel="icon" href="/i.png?a=1&amp;b=2">'));
    expect(r.icon).toBe('https://site.example/i.png?a=1&b=2');
  });

  it('falls back to /favicon.ico on the origin when the page has no icon link', async () => {
    const r = await check(html('<title>x</title>'), 'https://site.example:8443/deep/page?q=1');
    expect(r.icon).toBe('https://site.example:8443/favicon.ico');
  });

});

describe('checkLink: non-HTML and large pages', () => {
  it('gives no title and the favicon fallback for a non-HTML content type', async () => {
    const r = await check(new Response('{"title":"x"}', { headers: { 'content-type': 'application/json' } }));
    expect(r).toEqual({ embeddable: 'yes', title: null, icon: 'https://site.example/favicon.ico' });
  });

  it('treats a missing content type as non-HTML', async () => {
    const r = await check(new Response('<title>x</title>'), 'https://site.example/');
    expect(r.title).toBeNull();
    expect(r.icon).toBe('https://site.example/favicon.ico');
  });

  it('accepts application/xhtml+xml as HTML', async () => {
    const r = await check(new Response('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head></html>', {
      headers: { 'content-type': 'application/xhtml+xml' },
    }));
    expect(r.title).toBe('X');
  });

  it('reads at most 256 KiB, so a title after that is not found', async () => {
    const pad = '<!-- ' + 'x'.repeat(262_144) + ' -->';
    const r = await check(html(`<head>${pad}<title>Too late</title>`));
    expect(r.title).toBeNull();
  });

  it('finds a title inside the first 256 KiB', async () => {
    const pad = '<!-- ' + 'x'.repeat(200_000) + ' -->';
    const r = await check(html(`<head><title>In time</title>${pad}`));
    expect(r.title).toBe('In time');
  });

  it('stops reading the body after the limit', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('<!--' + 'x'.repeat(65_532));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) return controller.close();
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await check(new Response(body, { headers: { 'content-type': 'text/html' } }));
    expect(r.embeddable).toBe('yes');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

});
