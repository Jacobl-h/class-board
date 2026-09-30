import { describe, expect, it } from 'vitest';
import {
  ID_RE, checkUpload, corsHeaders, htmlFileResponse, json, newId, parseOrigins, shotResponse,
} from '../../src/files';

describe('newId and ID_RE', () => {
  it('makes 32 lowercase hex characters', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(ID_RE.test(id)).toBe(true);
  });

  it('makes a different id each time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
  });

  it('rejects ids of the wrong shape', () => {
    expect(ID_RE.test('')).toBe(false);
    expect(ID_RE.test('a'.repeat(31))).toBe(false);
    expect(ID_RE.test('a'.repeat(33))).toBe(false);
    expect(ID_RE.test('A'.repeat(32))).toBe(false);
    expect(ID_RE.test('g'.repeat(32))).toBe(false);
    expect(ID_RE.test(`${'a'.repeat(32)}\n`)).toBe(false);
    expect(ID_RE.test('../'.repeat(11))).toBe(false);
  });
});

describe('parseOrigins', () => {
  it('splits on commas and trims', () => {
    expect(parseOrigins(' https://jacobl-h.github.io , http://localhost:5173 ')).toEqual([
      'https://jacobl-h.github.io',
      'http://localhost:5173',
    ]);
  });

  it('drops empty entries', () => {
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins(' , ,https://a.example,,')).toEqual(['https://a.example']);
  });

  it('removes a trailing slash and any path', () => {
    expect(parseOrigins('https://jacobl-h.github.io/, https://b.example/class-board/')).toEqual([
      'https://jacobl-h.github.io',
      'https://b.example',
    ]);
  });

  it('lowercases the host and drops default ports', () => {
    expect(parseOrigins('HTTPS://JacobL-H.github.io:443')).toEqual(['https://jacobl-h.github.io']);
  });

  it('skips entries that are not http or https URLs', () => {
    expect(parseOrigins('jacobl-h.github.io, ftp://a.example, javascript:alert(1), https://ok.example')).toEqual([
      'https://ok.example',
    ]);
  });

  it('lists each origin once', () => {
    expect(parseOrigins('https://a.example, https://a.example/')).toEqual(['https://a.example']);
  });
});

const bytes = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};


describe('checkUpload: size and encoding', () => {
  it('accepts a file of exactly 1,000,000 bytes', () => {
    const html = `<p>${'a'.repeat(1_000_000 - 7)}</p>`;
    expect(new TextEncoder().encode(html).length).toBe(1_000_000);
    expect(checkUpload(bytes(html), null).ok).toBe(true);
  });

  it('rejects a file one byte over', () => {
    const html = `<p>${'a'.repeat(1_000_000 - 6)}</p>`;
    expect(checkUpload(bytes(html), null)).toEqual({ ok: false, code: 'too_large' });
  });

  it('reports too_large before checking the content', () => {
    expect(checkUpload(new Uint8Array(1_000_001).fill(0xff).buffer, null)).toEqual({ ok: false, code: 'too_large' });
  });

  it('rejects bytes that are not valid UTF-8', () => {
    const bad = new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]);
    expect(checkUpload(bad.buffer, null)).toEqual({ ok: false, code: 'invalid' });
  });

  it('rejects text with no "<"', () => {
    expect(checkUpload(bytes('just some words'), 'notes.html')).toEqual({ ok: false, code: 'invalid' });
  });

  it('rejects an empty file', () => {
    expect(checkUpload(new ArrayBuffer(0), 'a.html')).toEqual({ ok: false, code: 'invalid' });
  });

  it('returns the file exactly as uploaded, including non-ASCII text', () => {
    const src = '<!doctype html>\r\n<p>héllo ✓ 日本</p>\n';
    const r = checkUpload(bytes(src), null);
    expect(r.ok && r.html).toBe(src);
  });

  it('keeps a UTF-8 byte order mark so serving the file reproduces the upload', () => {
    const src = '\uFEFF<p>x</p>';
    const r = checkUpload(bytes(src), null);
    expect(r.ok && r.html).toBe(src);
  });
});

describe('checkUpload: title', () => {
  const title = (html: string, fileName: string | null = null) => {
    const r = checkUpload(bytes(html), fileName);
    if (!r.ok) throw new Error(`upload rejected: ${r.code}`);
    return r.title;
  };

  it('uses the <title> text', () => {
    expect(title('<html><head><title>My game</title></head></html>')).toBe('My game');
  });

  it('reads the tag case-insensitively and with attributes', () => {
    expect(title('<HEAD><TITLE lang="en">Loud</TITLE ></HEAD>')).toBe('Loud');
  });

  it('collapses whitespace and trims', () => {
    expect(title('<title>\n   Pixel\t  art \n</title>')).toBe('Pixel art');
  });

  it('decodes common entities', () => {
    expect(title('<title>Cats &amp; dogs &lt;3 &#39;x&#39; &#x2713;</title>')).toBe("Cats & dogs <3 'x' \u2713");
  });

  it('leaves an unknown entity as written', () => {
    expect(title('<title>a &bogus; b</title>')).toBe('a &bogus; b');
  });

  it('uses the first <title> when there are several', () => {
    expect(title('<title>First</title><svg><title>Second</title></svg>')).toBe('First');
  });

  it('is not fooled by a tag whose name only starts with title', () => {
    expect(title('<titles>no</titles><p>x</p>', 'fallback.html')).toBe('fallback');
  });

  it('falls back to the file name without its extension when the title is empty', () => {
    expect(title('<title>   </title><p>x</p>', 'my-game.html')).toBe('my-game');
  });

  it('falls back to the file name when the title never closes', () => {
    expect(title('<title>Oops<p>x</p>', 'draft.htm')).toBe('draft');
  });

  it('falls back to the file name when there is no title', () => {
    expect(title('<p>x</p>', 'Weather Widget.v2.html')).toBe('Weather Widget.v2');
  });

  it('drops a directory from the file name', () => {
    expect(title('<p>x</p>', 'C:\\Users\\ana\\demo.html')).toBe('demo');
    expect(title('<p>x</p>', '/tmp/demo.html')).toBe('demo');
  });

  it('falls back to "HTML page" without a title or a usable file name', () => {
    expect(title('<p>x</p>')).toBe('HTML page');
    expect(title('<p>x</p>', '')).toBe('HTML page');
    expect(title('<p>x</p>', '.html')).toBe('HTML page');
  });

  it('cuts a very long title to 200 characters', () => {
    expect(title(`<title>${'a'.repeat(500)}</title>`)).toHaveLength(200);
  });

  it('stays fast on a large file full of unclosed title tags', () => {
    const html = `<title>${'<title>'.repeat(100_000)}`;
    const started = Date.now();
    title(html, 'x.html');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('htmlFileResponse', () => {
  const origins = ['https://jacobl-h.github.io', 'http://localhost:5173'];

  it('serves the html with the exact sandbox headers', async () => {
    const res = htmlFileResponse('<p>hi</p>', origins);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>hi</p>');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors https://jacobl-h.github.io http://localhost:5173',
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('never grants allow-same-origin or top navigation', () => {
    const csp = htmlFileResponse('<p></p>', origins).headers.get('Content-Security-Policy') ?? '';
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
  });

  it("lets no site frame the file when no origin is configured", () => {
    const csp = htmlFileResponse('<p></p>', []).headers.get('Content-Security-Policy') ?? '';
    expect(csp.endsWith("frame-ancestors 'none'")).toBe(true);
  });

  it('sends no CORS headers, because the file is loaded by frames and links', () => {
    expect(htmlFileResponse('<p></p>', origins).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('shotResponse', () => {
  it('serves a JPEG with an immutable cache', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    const res = shotResponse(jpeg);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  });
});

describe('corsHeaders', () => {
  const allowed = ['https://jacobl-h.github.io', 'http://localhost:5173'];

  it('echoes an allowed origin', () => {
    expect(corsHeaders('https://jacobl-h.github.io', allowed)).toEqual({
      'Access-Control-Allow-Origin': 'https://jacobl-h.github.io',
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Client-Id',
    });
  });

  it('echoes the second allowed origin too', () => {
    expect(corsHeaders('http://localhost:5173', allowed)['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('omits Allow-Origin for an origin that is not allowed, but keeps Vary', () => {
    const h = corsHeaders('https://evil.example', allowed);
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
    expect(h.Vary).toBe('Origin');
    expect(h['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(h['Access-Control-Allow-Headers']).toBe('Content-Type, X-File-Name, X-Client-Id');
  });

  it('omits Allow-Origin when there is no Origin header', () => {
    expect(corsHeaders(null, allowed)['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('matches origins exactly, not by prefix or case', () => {
    expect(corsHeaders('https://jacobl-h.github.io.evil.example', allowed)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('HTTPS://JACOBL-H.GITHUB.IO', allowed)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('null', allowed)['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('allows nothing when the allowlist is empty', () => {
    expect(corsHeaders('https://jacobl-h.github.io', [])['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('json', () => {
  it('serializes the body with a JSON content type and status 200', async () => {
    const res = json({ fileId: 'abc' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ fileId: 'abc' });
  });

  it('uses the given status', async () => {
    const res = json({ error: 'too_large' }, 413);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
  });

  it('adds extra headers, such as CORS', () => {
    const res = json({ ok: true }, 200, { 'Access-Control-Allow-Origin': 'https://jacobl-h.github.io', Vary: 'Origin' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jacobl-h.github.io');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });
});
