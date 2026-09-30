import { LIMITS } from '@class-board/shared/constants';

export const ID_RE = /^[0-9a-f]{32}$/;

/** A random 128-bit id as 32 lowercase hex characters. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += b.toString(16).padStart(2, '0');
  return id;
}

/**
 * Turns the ALLOWED_ORIGINS variable into a list of origins. Entries that aren't
 * http(s) URLs are dropped, and paths and trailing slashes are removed.
 */
export function parseOrigins(csv: string): string[] {
  const origins: string[] = [];
  for (const raw of csv.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      const url = new URL(entry);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      // not a URL: skip it
    }
  }
  return origins;
}

export type UploadCheck = { ok: true; html: string; title: string } | { ok: false; code: 'too_large' | 'invalid' };

const TITLE_MAX = 200;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

function tidy(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
}

/** Text of the first <title> element, or '' when there is none or it never closes. */
function titleOf(html: string): string {
  const open = /<title(?:\s[^>]*)?>/i.exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const close = /<\/title\s*>/i;
  const rest = html.slice(start);
  const end = close.exec(rest);
  return end ? tidy(decodeEntities(rest.slice(0, end.index))) : '';
}

function nameWithoutExtension(fileName: string | null): string {
  if (!fileName) return '';
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return tidy(base.replace(/\.[^.]*$/, ''));
}

/**
 * Validates an upload. The html string is the file exactly as sent (a UTF-8 byte order
 * mark is kept), so serving it back reproduces the upload.
 */
export function checkUpload(body: ArrayBuffer, fileName: string | null): UploadCheck {
  if (body.byteLength > LIMITS.htmlMaxBytes) return { ok: false, code: 'too_large' };
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (!html.includes('<')) return { ok: false, code: 'invalid' };
  return { ok: true, html, title: titleOf(html) || nameWithoutExtension(fileName) || 'HTML page' };
}

const NOSNIFF = 'nosniff';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * An upload, served so that its scripts run in an opaque origin and only the board can frame it.
 * With no allowed origins, frame-ancestors 'none' keeps every site out.
 */
export function htmlFileResponse(html: string, allowedOrigins: string[]): Response {
  const ancestors = allowedOrigins.length > 0 ? allowedOrigins.join(' ') : "'none'";
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors ${ancestors}`,
      'X-Content-Type-Options': NOSNIFF,
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': IMMUTABLE,
    },
  });
}

export function shotResponse(jpeg: ArrayBuffer): Response {
  return new Response(jpeg, {
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': NOSNIFF,
      'Cache-Control': IMMUTABLE,
    },
  });
}

/** CORS headers for the upload route. The origin is echoed back only when it is on the allowlist. */
export function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Client-Id',
  };
  if (origin !== null && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
