import { LINK_CHECK } from '@class-board/shared/constants';
import { evaluateFraming } from './frameHeaders';

export interface LinkCheckResult { embeddable: 'yes' | 'no' | 'unknown'; title: string | null; icon: string | null }

const UNKNOWN: LinkCheckResult = { embeddable: 'unknown', title: null, icon: null };
const TITLE_MAX = 200;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTMLRewriter hands over text and attribute values exactly as written, entities included. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

function cleanTitle(raw: string): string | null {
  const t = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
  return t || null;
}

/** Passes on at most `max` bytes of the body, then ends the stream and cancels the rest. */
function limitBytes(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  reader.closed.catch(() => {}); // a stream that errors would otherwise report an unhandled rejection
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        controller.error(err);
        return;
      }
      const { done, value } = step;
      if (done) {
        controller.close();
        return;
      }
      const room = max - seen;
      if (value.byteLength >= room) {
        controller.enqueue(value.subarray(0, room));
        controller.close();
        await reader.cancel().catch(() => {});
        return;
      }
      seen += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function httpUrl(href: string, base: URL): URL | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Reads the title (og:title first) and the first usable icon link from the start of an HTML response. */
async function readMetadata(res: Response, finalUrl: URL): Promise<{ title: string | null; icon: string | null }> {
  let pageTitle = '';
  let titleState: 'idle' | 'open' | 'done' = 'idle';
  let ogTitle: string | null = null;
  let icon: string | null = null;

  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        if (titleState !== 'idle') return;
        titleState = 'open';
        el.onEndTag(() => {
          titleState = 'done';
        });
      },
      text(chunk) {
        if (titleState === 'open') pageTitle += chunk.text;
      },
    })
    .on('meta', {
      element(el) {
        if (ogTitle !== null) return;
        const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').trim().toLowerCase();
        if (key !== 'og:title') return;
        ogTitle = cleanTitle(el.getAttribute('content') ?? '');
      },
    })
    .on('link', {
      element(el) {
        if (icon !== null) return;
        const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        if (!rel.includes('icon')) return;
        const href = decodeEntities((el.getAttribute('href') ?? '').trim());
        const url = href ? httpUrl(href, finalUrl) : null;
        if (url) icon = url.href;
      },
    });

  const body = res.body ? limitBytes(res.body, LINK_CHECK.maxHtmlBytes) : null;
  const contentType = res.headers.get('content-type') ?? 'text/html';
  await rewriter.transform(new Response(body, { headers: { 'content-type': contentType } })).arrayBuffer();
  return { title: ogTitle ?? cleanTitle(pageTitle), icon };
}

function isHtml(res: Response): boolean {
  return /html/i.test(res.headers.get('content-type') ?? '');
}

/**
 * Fetches a link the way a browser would frame it and reports whether the site allows that,
 * with its title and icon. One timeout covers the whole check, redirects and body included.
 * A network error or timeout before the headers arrive gives 'unknown'.
 */
export async function checkLink(embedUrl: string, boardOrigin: string, fetchImpl: typeof fetch = fetch): Promise<LinkCheckResult> {
  let url: URL | null;
  try {
    url = new URL(embedUrl);
  } catch {
    return UNKNOWN;
  }

  const signal = AbortSignal.timeout(LINK_CHECK.timeoutMs);
  let res: Response;
  try {
    for (let hops = 0; ; hops += 1) {
      res = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) break;
      await res.body?.cancel().catch(() => {});
      if (hops >= LINK_CHECK.maxRedirects) return UNKNOWN;
      const next = httpUrl(location, url);
      if (!next) return UNKNOWN;
      url = next;
    }
  } catch {
    return UNKNOWN;
  }

  const embeddable = evaluateFraming(res.headers, url.href, boardOrigin);
  const fallbackIcon = `${url.origin}/favicon.ico`;
  if (!isHtml(res)) {
    await res.body?.cancel().catch(() => {});
    return { embeddable, title: null, icon: fallbackIcon };
  }
  try {
    const meta = await readMetadata(res, url);
    return { embeddable, title: meta.title, icon: meta.icon ?? fallbackIcon };
  } catch {
    // The headers already answered the question; a body cut off by the timeout only costs the title.
    return { embeddable, title: null, icon: fallbackIcon };
  }
}
