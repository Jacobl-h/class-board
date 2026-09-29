/**
 * Decides whether a page may be framed by the board, from its response headers.
 * CSP Level 3 `frame-ancestors` (https://www.w3.org/TR/CSP3/#directive-frame-ancestors)
 * takes precedence over `X-Frame-Options`, as in browsers.
 */

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ws:', 'wss:']);
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9_.-]+)(?::(\*|\d+))?(?:\/.*)?$/i;
const SCHEME_SOURCE = /^([a-z][a-z0-9+.-]*):$/i;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Scheme matching from CSP3: http: also matches https, ws: also matches wss. */
function schemeMatches(sourceScheme: string, actual: string): boolean {
  const s = sourceScheme.toLowerCase();
  if (s === actual) return true;
  return (s === 'http:' && actual === 'https:') || (s === 'ws:' && actual === 'wss:');
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.length > p.length - 1 && h.endsWith(p.slice(1));
  return p === h;
}

function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : u.protocol === 'http:' || u.protocol === 'ws:' ? '80' : '';
}

/** Does one source expression allow `ancestor` to frame `page`? */
function sourceAllows(token: string, ancestor: URL, page: URL | null): boolean {
  const lower = token.toLowerCase();
  if (lower === '*') return NETWORK_SCHEMES.has(ancestor.protocol);
  if (lower === "'self'") return page !== null && page.origin === ancestor.origin;
  if (lower.startsWith("'")) return false; // 'none' and keywords that don't apply to ancestors

  const schemeOnly = SCHEME_SOURCE.exec(token);
  if (schemeOnly) return schemeMatches(schemeOnly[1] + ':', ancestor.protocol);

  const m = HOST_SOURCE.exec(token);
  if (!m) return false;
  const [, scheme, host = '', port] = m;
  if (scheme) {
    if (!schemeMatches(scheme + ':', ancestor.protocol)) return false;
  } else {
    // A source without a scheme matches the scheme of the framed page (and its https upgrade).
    const pageScheme = page?.protocol ?? 'https:';
    if (ancestor.protocol !== pageScheme && !(pageScheme === 'http:' && ancestor.protocol === 'https:')) return false;
  }
  if (!hostMatches(host, ancestor.hostname)) return false;
  if (port === '*') return true;
  if (port) return port === effectivePort(ancestor);
  return ancestor.port === '';
}

/** The `frame-ancestors` source list of one policy, or null when the policy has none. */
function frameAncestorsOf(policy: string): string[] | null {
  for (const directive of policy.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === 'frame-ancestors') return parts.slice(1).filter(Boolean);
  }
  return null; // only the first frame-ancestors directive in a policy counts, so we return at once
}

function listAllows(sources: string[], ancestor: URL | null, page: URL | null): boolean {
  if (!ancestor) return false;
  return sources.some((s) => sourceAllows(s, ancestor, page));
}

export function evaluateFraming(headers: Headers, pageUrl: string, boardOrigin: string): 'yes' | 'no' {
  const ancestor = parseUrl(boardOrigin);
  const page = parseUrl(pageUrl);

  // Several CSP headers arrive joined with ", ", which is also the separator between policies.
  const csp = headers.get('content-security-policy');
  if (csp) {
    const lists = csp
      .split(',')
      .map(frameAncestorsOf)
      .filter((l): l is string[] => l !== null);
    if (lists.length > 0) {
      return lists.every((l) => listAllows(l, ancestor, page)) ? 'yes' : 'no';
    }
  }

  const xfo = headers.get('x-frame-options');
  if (xfo) {
    const sameOrigin = page !== null && ancestor !== null && page.origin === ancestor.origin;
    for (const raw of xfo.split(',')) {
      const value = raw.trim().toUpperCase();
      if (value === 'DENY') return 'no';
      if (value === 'SAMEORIGIN' && !sameOrigin) return 'no';
    }
  }
  return 'yes';
}
