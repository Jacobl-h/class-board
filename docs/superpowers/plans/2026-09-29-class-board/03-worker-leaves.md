# Worker leaf modules

Six small modules that the Board Durable Object (W2-W4) calls but that never touch a Durable Object themselves, so each one is tested on its own inside workerd:

- **X1** `frameHeaders.ts`: decides from a response's `Content-Security-Policy` and `X-Frame-Options` headers whether the board may frame the page.
- **X2** `limits.ts` and `budget.ts`: per-connection token buckets, a per-key rate limiter for uploads, and the daily WebSocket message budget with its UTC rollover and 80% / 90% thresholds.
- **X3** `teacher.ts`: constant-time passcode comparison and the wrong-guess lockout.
- **X4** `files.ts`: ids, the origin allowlist, upload validation with title extraction, the sandboxed file response, the screenshot response, CORS headers and a JSON helper.
- **X5** `linkCheck.ts`: fetches a link with manual redirects and one timeout, judges framing with X1, and reads the title and icon with `HTMLRewriter`.
- **X6** `shots.ts`: the screenshot queue runner, the screenshot target rules and a thin `@cloudflare/puppeteer` shooter.

All exports match master plan section 4 exactly. Tests live in `worker/test/unit/*.test.ts` and run with `npm run test:unit -w worker -- <name>`. That command uses `worker/vitest.unit.config.ts`, which runs in workerd without the Worker's main module, so there is no `SELF` and no Durable Object. `HTMLRewriter`, `Headers`, `Response`, `TextDecoder` and `crypto` are available. No test touches the network: X5 uses a fake `fetch` and X6 uses a fake store and a fake `Shooter`.

**How the steps are organised.** A module larger than about 100 lines is built in cycles of write tests, see them fail, implement, see them pass. Later cycles append to files the earlier cycles created. Where a step says "append", paste the block at the end of the file after one blank line; where it says "replace", the whole block is given. The failure and pass counts in every step come from running exactly that code with Vitest 4.1.11 and `@cloudflare/vitest-pool-workers` 0.22.0, so a different count means the pasted code differs.

## Third-party APIs used

Confirmed on 2026-09-29 by running the code in a scratch workspace and reading the docs.

- **Vitest 4.1.11** with **@cloudflare/vitest-pool-workers 0.22.0** (https://developers.cloudflare.com/workers/testing/vitest-integration/). Facts the tests rely on:
  - Test files run inside workerd, so `HTMLRewriter`, `AbortSignal.timeout`, `Response.json` and `new TextDecoder('utf-8', { fatal: true })` exist.
  - `console.log` output from inside a test is not shown by the runner. To see a value, put it in an assertion.
  - `vi.spyOn(AbortSignal, 'timeout')` works, and `AbortSignal.abort(reason)` gives a signal that is already aborted. workerd's `AbortSignal.timeout` is not driven by `vi.useFakeTimers`, so X5 injects a signal instead of advancing time.
  - A missing module prints `Error: Cannot find module '../../src/<name>'` and `Tests  no tests`.
  - When a response body stream errors while `HTMLRewriter` is reading it, workerd prints `uncaught exception; source = Uncaught (in promise)` blocks. The run still passes with exit code 0. X5 has one test that causes this on purpose.
  - Importing `@cloudflare/puppeteer` in a unit test works with or without the `nodejs_compat` flag. Deploying it needs `nodejs_compat` (see X6).
- **`HTMLRewriter`** (https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/). Confirmed by experiment:
  - `text()` chunks arrive in pieces, and `lastInTextNode` marks the last one. Text inside `<title>` is raw source: `&amp;` stays `&amp;`, and `<b>` inside a title arrives as text.
  - `getAttribute()` returns attribute values with entities undecoded, too (`content="A &amp; B"` gives `A &amp; B`). X5 decodes both itself.
  - `el.onEndTag(fn)` runs when the element closes.
- **`fetch` with `redirect: 'manual'`** (https://developers.cloudflare.com/workers/runtime-apis/request/). The 3xx response is returned as is, with a readable `Location` header. Confirmed from the docs only, because no test uses the network.
- **`@cloudflare/puppeteer` 1.4.0** (https://developers.cloudflare.com/browser-rendering/puppeteer/, https://developers.cloudflare.com/browser-rendering/workers-bindings/reuse-sessions/, https://developers.cloudflare.com/browser-rendering/limits/). Confirmed from the docs and the package's own types and source:
  - `puppeteer.launch(binding, { keep_alive: ms })` starts a browser that stays up for `ms` of inactivity (max 600000). `puppeteer.sessions(binding)` returns `ActiveSession[]` of `{ sessionId, startTime, connectionId?, connectionStartTime? }`; a session with `connectionId` already has a client. `puppeteer.connect(binding, sessionId)` attaches to one.
  - `browser.disconnect()` leaves the browser running so the next run can reuse it; `browser.close()` ends it.
  - Failures are plain `Error`s whose message carries the HTTP status. The free-plan daily limit reads `Unable to create new browser: code: 429: message: Browser time limit exceeded for today`. Other 429s (rate limits) have different text.
  - `page.screenshot({ type: 'jpeg', quality })` resolves to a `Buffer`, which is a `Uint8Array`. `page.goto(url, { waitUntil, timeout })` rejects with an error named `TimeoutError` when the wait runs out.
  - `browser.connected` is the current property (`isConnected()` is deprecated).
  - The binding type `Fetcher` from `@cloudflare/workers-types` is accepted where puppeteer wants a `BrowserWorker` (`{ fetch }`).
- **`@cloudflare/workers-types` 5.20260929.1**: `TextDecoderConstructorOptions` requires both keys, so write `{ fatal: true, ignoreBOM: true }`.

---

### Task X1: Frame-header evaluation

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F1

**Files:**
- Create: `worker/src/frameHeaders.ts`
- Test: `worker/test/unit/frameHeaders.test.ts`

**What it decides.** `evaluateFraming(headers, pageUrl, boardOrigin)` answers "may the board frame this page?" the way a browser would, following CSP Level 3 (https://www.w3.org/TR/CSP3/#directive-frame-ancestors). The rules, each covered by tests:

- `Headers.get('content-security-policy')` joins repeated headers with `, `, and a comma also separates policies inside one header, so the value is split on commas. Every policy that has a `frame-ancestors` directive must allow the board; a policy without one is ignored. Only the first `frame-ancestors` in a policy counts. `Content-Security-Policy-Report-Only` is ignored.
- A CSP with `frame-ancestors` overrides `X-Frame-Options`. A CSP without it falls back to `X-Frame-Options`.
- Sources: `*` matches network schemes; `'none'` and unknown keywords match nothing (so `'none'` next to another source is ignored, as in browsers); scheme sources such as `https:` (`http:` also matches an https board); host sources with an optional scheme, a wildcard subdomain (`*.github.io` does not match `github.io` itself) and a port (`:*` for any, no port means the default port only); a source with no scheme takes the framed page's scheme; `'self'` matches only when the page's origin equals the board's origin; paths in sources are ignored.
- `X-Frame-Options`: `DENY` means no; `SAMEORIGIN` means no unless the page is on the board's origin; `ALLOW-FROM` and unknown values are ignored; with several values any restricting one wins. Values are case-insensitive and trimmed.
- No header at all means yes. An unparseable board origin matches no CSP source.

- [ ] **Step 1: Write the failing test (cycle 1 of 2: no restrictions and X-Frame-Options)**

Create `worker/test/unit/frameHeaders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateFraming } from '../../src/frameHeaders';

const BOARD = 'https://jacobl-h.github.io';
const PAGE = 'https://example.com/some/page';
const DEV = 'http://localhost:5173';

/** Builds Headers from name/value pairs, so a name can repeat. */
function hdrs(...pairs: Array<[string, string]>): Headers {
  return new Headers(pairs);
}
const csp = (value: string) => hdrs(['Content-Security-Policy', value]);
const xfo = (value: string) => hdrs(['X-Frame-Options', value]);
const framing = (h: Headers, page = PAGE, board = BOARD) => evaluateFraming(h, page, board);

describe('evaluateFraming: no restrictions', () => {
  it('allows a page with neither header', () => {
    expect(framing(new Headers())).toBe('yes');
  });

  it('allows a page whose CSP has no frame-ancestors', () => {
    expect(framing(csp("default-src 'self'; script-src 'none'"))).toBe('yes');
  });

  it('ignores Content-Security-Policy-Report-Only', () => {
    expect(framing(hdrs(['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"]))).toBe('yes');
  });
});

describe('evaluateFraming: X-Frame-Options', () => {
  it('rejects DENY', () => {
    expect(framing(xfo('DENY'))).toBe('no');
  });

  it('rejects SAMEORIGIN for another origin', () => {
    expect(framing(xfo('SAMEORIGIN'))).toBe('no');
  });

  it('allows SAMEORIGIN when the page is on the board origin', () => {
    expect(framing(xfo('SAMEORIGIN'), 'https://jacobl-h.github.io/other/')).toBe('yes');
  });

  it('reads values case-insensitively and ignores spaces', () => {
    expect(framing(xfo('  deny '))).toBe('no');
    expect(framing(xfo('sameorigin'))).toBe('no');
    expect(framing(hdrs(['x-frame-options', 'DENY']))).toBe('no');
  });

  it('ignores ALLOW-FROM, as browsers do', () => {
    expect(framing(xfo('ALLOW-FROM https://jacobl-h.github.io'))).toBe('yes');
    expect(framing(xfo('ALLOW-FROM https://other.example'))).toBe('yes');
  });

  it('ignores unknown values', () => {
    expect(framing(xfo('garbage'))).toBe('yes');
    expect(framing(xfo('ALLOWALL'))).toBe('yes');
    expect(framing(xfo(''))).toBe('yes');
  });

  it('rejects when any of several values restricts', () => {
    expect(framing(xfo('SAMEORIGIN, DENY'))).toBe('no');
    expect(framing(hdrs(['X-Frame-Options', 'garbage'], ['X-Frame-Options', 'DENY']))).toBe('no');
  });
});
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- frameHeaders`

Expected: FAIL, `Error: Cannot find module '../../src/frameHeaders'` and `Tests  no tests`.


- [ ] **Step 3: Implement (cycle 1 of 2: no restrictions and X-Frame-Options)**

Create `worker/src/frameHeaders.ts`:

```ts
/**
 * Decides whether a page may be framed by the board, from its response headers.
 * This first version reads X-Frame-Options only.
 */

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function evaluateFraming(headers: Headers, pageUrl: string, boardOrigin: string): 'yes' | 'no' {
  const ancestor = parseUrl(boardOrigin);
  const page = parseUrl(pageUrl);

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
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- frameHeaders`

Expected: PASS, `Tests  10 passed (10)`.


- [ ] **Step 5: Write the next failing tests (cycle 2 of 2: CSP frame-ancestors, several policies, precedence)**

Append this to the end of the file, after a blank line:

```ts
describe('evaluateFraming: CSP frame-ancestors', () => {
  it("rejects 'none'", () => {
    expect(framing(csp("frame-ancestors 'none'"))).toBe('no');
  });

  it('allows *', () => {
    expect(framing(csp('frame-ancestors *'))).toBe('yes');
  });

  it('rejects an empty source list', () => {
    expect(framing(csp('frame-ancestors'))).toBe('no');
  });

  it("ignores 'none' when other sources are listed", () => {
    expect(framing(csp("frame-ancestors 'none' https://jacobl-h.github.io"))).toBe('yes');
  });

  it('matches the directive name and keywords case-insensitively', () => {
    expect(framing(csp('FRAME-ANCESTORS HTTPS://JACOBL-H.GITHUB.IO'))).toBe('yes');
    expect(framing(csp("Frame-Ancestors 'NONE'"))).toBe('no');
  });

  it('finds frame-ancestors among other directives', () => {
    expect(framing(csp("default-src 'self'; frame-ancestors https://jacobl-h.github.io; img-src *"))).toBe('yes');
  });

  it('uses only the first frame-ancestors directive of a policy', () => {
    expect(framing(csp("frame-ancestors 'none'; frame-ancestors *"))).toBe('no');
  });

  describe('scheme sources', () => {
    it('allows https: for an https board', () => {
      expect(framing(csp('frame-ancestors https:'))).toBe('yes');
    });

    it('lets http: match an https board (the CSP upgrade rule)', () => {
      expect(framing(csp('frame-ancestors http:'))).toBe('yes');
    });

    it('rejects https: for an http board', () => {
      expect(framing(csp('frame-ancestors https:'), PAGE, DEV)).toBe('no');
    });

    it('rejects an unrelated scheme', () => {
      expect(framing(csp('frame-ancestors data:'))).toBe('no');
    });
  });

  describe('host sources', () => {
    it('allows the exact host', () => {
      expect(framing(csp('frame-ancestors jacobl-h.github.io'))).toBe('yes');
    });

    it('allows the exact host with a scheme', () => {
      expect(framing(csp('frame-ancestors https://jacobl-h.github.io'))).toBe('yes');
    });

    it('rejects a different host', () => {
      expect(framing(csp('frame-ancestors https://other.github.io'))).toBe('no');
    });

    it('rejects a host that only shares a suffix', () => {
      expect(framing(csp('frame-ancestors https://l-h.github.io'))).toBe('no');
    });

    it('allows a wildcard subdomain', () => {
      expect(framing(csp('frame-ancestors *.github.io'))).toBe('yes');
      expect(framing(csp('frame-ancestors https://*.github.io'))).toBe('yes');
    });

    it('does not let a wildcard subdomain match the bare domain', () => {
      expect(framing(csp('frame-ancestors *.io'), PAGE, 'https://io')).toBe('no');
      expect(framing(csp('frame-ancestors *.jacobl-h.github.io'))).toBe('no');
    });

    it('does not let a wildcard match a look-alike suffix', () => {
      expect(framing(csp('frame-ancestors *.hub.io'))).toBe('no');
    });

    it('compares hosts case-insensitively', () => {
      expect(framing(csp('frame-ancestors https://JacobL-H.GitHub.IO'))).toBe('yes');
    });

    it('ignores a path on the source', () => {
      expect(framing(csp('frame-ancestors https://jacobl-h.github.io/class-board/'))).toBe('yes');
    });

    it('rejects a source whose scheme differs from the board', () => {
      expect(framing(csp('frame-ancestors https://localhost:5173'), PAGE, DEV)).toBe('no');
    });

    it('applies the framed page scheme to a source without a scheme', () => {
      expect(framing(csp('frame-ancestors localhost:5173'), 'http://example.com/', DEV)).toBe('yes');
      expect(framing(csp('frame-ancestors localhost:5173'), 'https://example.com/', DEV)).toBe('no');
    });

    it('does not let a partial host slip through', () => {
      expect(framing(csp('frame-ancestors https://jacobl-h.github.io.evil.com'))).toBe('no');
    });
  });

  describe('ports', () => {
    it('requires the port to match when one is given', () => {
      expect(framing(csp('frame-ancestors http://localhost:5173'), PAGE, DEV)).toBe('yes');
      expect(framing(csp('frame-ancestors http://localhost:3000'), PAGE, DEV)).toBe('no');
    });

    it('treats a missing port as the default port only', () => {
      expect(framing(csp('frame-ancestors http://localhost'), PAGE, DEV)).toBe('no');
      expect(framing(csp('frame-ancestors http://localhost'), PAGE, 'http://localhost')).toBe('yes');
      expect(framing(csp('frame-ancestors https://jacobl-h.github.io'), PAGE, 'https://jacobl-h.github.io:8443')).toBe('no');
    });

    it('accepts the default port written out', () => {
      expect(framing(csp('frame-ancestors https://jacobl-h.github.io:443'))).toBe('yes');
    });

    it('accepts any port with :*', () => {
      expect(framing(csp('frame-ancestors http://localhost:*'), PAGE, DEV)).toBe('yes');
      expect(framing(csp('frame-ancestors localhost:*'), 'http://example.com/', DEV)).toBe('yes');
    });
  });

  describe("'self'", () => {
    it('allows the board framing its own origin', () => {
      expect(framing(csp("frame-ancestors 'self'"), 'https://jacobl-h.github.io/other-project/')).toBe('yes');
    });

    it('rejects the board framing another origin', () => {
      expect(framing(csp("frame-ancestors 'self'"))).toBe('no');
    });

    it('rejects the board framing the same host on another port', () => {
      expect(framing(csp("frame-ancestors 'self'"), 'http://localhost:8787/x', DEV)).toBe('no');
    });

    it("lets another source in the list allow it when 'self' does not", () => {
      expect(framing(csp("frame-ancestors 'self' https://jacobl-h.github.io"))).toBe('yes');
    });

    it('rejects when the page URL cannot be parsed', () => {
      expect(framing(csp("frame-ancestors 'self'"), 'not a url')).toBe('no');
    });
  });

  describe('lists and unknown tokens', () => {
    it('allows when any source in the list matches', () => {
      expect(framing(csp("frame-ancestors 'self' https://a.example https://jacobl-h.github.io"))).toBe('yes');
    });

    it('separates sources on any whitespace', () => {
      expect(framing(csp('frame-ancestors\thttps://a.example \t https://jacobl-h.github.io'))).toBe('yes');
    });

    it('ignores tokens it does not understand', () => {
      expect(framing(csp("frame-ancestors 'unsafe-inline' 'nonce-abc' sha256-xyz ???"))).toBe('no');
    });
  });
});

describe('evaluateFraming: several policies', () => {
  it('requires every policy with frame-ancestors to allow the board', () => {
    const h = hdrs(
      ['Content-Security-Policy', 'frame-ancestors https://jacobl-h.github.io'],
      ['Content-Security-Policy', "frame-ancestors 'none'"],
    );
    expect(framing(h)).toBe('no');
  });

  it('allows when every policy with frame-ancestors allows the board', () => {
    const h = hdrs(
      ['Content-Security-Policy', 'frame-ancestors https://jacobl-h.github.io'],
      ['Content-Security-Policy', "default-src 'self'"],
      ['Content-Security-Policy', 'frame-ancestors *'],
    );
    expect(framing(h)).toBe('yes');
  });

  it('splits several policies inside one header on commas', () => {
    expect(framing(csp("frame-ancestors *, frame-ancestors 'none'"))).toBe('no');
    expect(framing(csp("default-src 'self', frame-ancestors https://jacobl-h.github.io"))).toBe('yes');
  });

  it('ignores a policy without frame-ancestors when another one restricts', () => {
    expect(framing(csp("default-src 'self', frame-ancestors 'none'"))).toBe('no');
  });
});

describe('evaluateFraming: CSP overrides X-Frame-Options', () => {
  it('lets frame-ancestors allow a page that X-Frame-Options would block', () => {
    const h = hdrs(['X-Frame-Options', 'DENY'], ['Content-Security-Policy', 'frame-ancestors https://jacobl-h.github.io']);
    expect(framing(h)).toBe('yes');
  });

  it('lets frame-ancestors block a page that X-Frame-Options would allow', () => {
    const h = hdrs(['X-Frame-Options', 'ALLOW-FROM https://jacobl-h.github.io'], ['Content-Security-Policy', "frame-ancestors 'none'"]);
    expect(framing(h)).toBe('no');
  });

  it('falls back to X-Frame-Options when the CSP has no frame-ancestors', () => {
    const h = hdrs(['X-Frame-Options', 'DENY'], ['Content-Security-Policy', "default-src 'self'"]);
    expect(framing(h)).toBe('no');
  });
});

describe('evaluateFraming: a board origin that cannot be parsed', () => {
  it('matches no source, so a CSP restricts and X-Frame-Options alone does not', () => {
    expect(framing(csp('frame-ancestors *'), PAGE, 'not an origin')).toBe('no');
    expect(framing(new Headers(), PAGE, 'not an origin')).toBe('yes');
  });
});
```


- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- frameHeaders`

Expected: FAIL, `Tests  25 failed | 28 passed (53)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 7: Implement (cycle 2 of 2: CSP frame-ancestors, several policies, precedence)**

Replace the whole of `worker/src/frameHeaders.ts` with:

```ts
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
```


- [ ] **Step 8: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- frameHeaders`

Expected: PASS, `Tests  53 passed (53)`.


- [ ] **Step 9: Commit (orchestrator)**

```bash
git add worker/src/frameHeaders.ts worker/test/unit/frameHeaders.test.ts
git commit -m "feat(worker): frame-header evaluation (X1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task X2: Token buckets and daily budget

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F1, F2

**Files:**
- Create: `worker/src/limits.ts`
- Create: `worker/src/budget.ts`
- Test: `worker/test/unit/limits.test.ts`
- Test: `worker/test/unit/budget.test.ts`

**Choices worth knowing.**

- `TokenBucket` refills continuously (fractional tokens are kept), holds at most `burst`, starts full, and ignores a clock that steps backwards. A refused `take()` spends nothing. A tiny epsilon stops a token that is due exactly now from being refused because of floating-point error.
- `createConnLimits` builds `cursor` from `RATES.cursorPerSecond` and `RATES.cursorBurst`, and builds `edit`, `history` and `profile` as "N per minute" buckets whose burst is N. A client may spend a minute's allowance at once, then gets one token every 60/N seconds.
- **`KeyedLimiter` window: a sliding 60 s log.** Each allowed call is remembered for exactly 60 s (a call at t frees its slot at t + 60 s). Refused calls are not recorded, so hammering does not extend the wait. Keys with nothing left in the window are evicted by a sweep that runs from `allow()` at most once per 60 s. The extra `size` getter exists for the eviction test.
- `DailyBudget.flush(force)` follows the contract literally: it calls `save()` once `BUDGET.persistEveryMs` has passed since the last save (the clock starts at construction), or immediately when forced, whether or not the count changed. That is at most two row writes a minute while W2 keeps calling it. `add()`, `hz()`, `flush()` and `state()` all roll the day over first, so the rate resets at 00:00 UTC even before the first message of the new day. A count stored on an earlier day is discarded at construction. Thresholds use `>=`: exactly 80% of the limit gives `RATES.cursorSlowHz`, and exactly 90% gives 0.

- [ ] **Step 1: Write the failing test (cycle 1 of 2: TokenBucket and createConnLimits)**

Create `worker/test/unit/limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TokenBucket, createConnLimits } from '../../src/limits';

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

function drain(bucket: TokenBucket): number {
  let n = 0;
  while (bucket.take()) {
    n += 1;
    if (n > 1000) throw new Error('bucket never emptied');
  }
  return n;
}

describe('TokenBucket', () => {
  it('starts full and allows a burst', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 4, clock.now);
    expect(drain(bucket)).toBe(4);
  });

  it('refuses when empty and does not spend anything on a refusal', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock.now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.take()).toBe(false);
    clock.advance(500); // exactly one token at 2 per second
    expect(bucket.take()).toBe(true);
  });

  it('refills continuously, not in whole ticks', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 4, clock.now);
    drain(bucket);
    clock.advance(250); // half a token
    expect(bucket.take()).toBe(false);
    clock.advance(250); // the half-token is remembered, so now there is one
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never holds more than the burst, however long it idles', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 3, clock.now);
    drain(bucket);
    clock.advance(60 * 60_000);
    expect(drain(bucket)).toBe(3);
  });

  it('gives back the rate over one second', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(6, 10, clock.now);
    drain(bucket);
    clock.advance(1000);
    expect(drain(bucket)).toBe(6);
  });

  it('handles a clock that steps backwards without losing or minting tokens', () => {
    const clock = fakeClock(10_000);
    const bucket = new TokenBucket(1, 2, clock.now);
    drain(bucket);
    clock.set(5_000);
    expect(bucket.take()).toBe(false);
    clock.set(6_000); // one second after the step back
    expect(bucket.take()).toBe(true);
  });
});

describe('createConnLimits', () => {
  it('allows a burst of 10 cursor messages, then 6 per second', () => {
    const clock = fakeClock();
    const { cursor } = createConnLimits(clock.now);
    expect(drain(cursor)).toBe(10);
    clock.advance(1000);
    expect(drain(cursor)).toBe(6);
  });

  it('allows 10 edits in a burst, then one every 6 seconds', () => {
    const clock = fakeClock();
    const { edit } = createConnLimits(clock.now);
    expect(drain(edit)).toBe(10);
    clock.advance(5_999);
    expect(edit.take()).toBe(false);
    clock.advance(1);
    expect(edit.take()).toBe(true);
  });

  it('allows 30 history requests a minute', () => {
    const clock = fakeClock();
    const { history } = createConnLimits(clock.now);
    expect(drain(history)).toBe(30);
    clock.advance(60_000);
    expect(drain(history)).toBe(30);
  });

  it('allows 10 profile updates a minute', () => {
    const clock = fakeClock();
    const { profile } = createConnLimits(clock.now);
    expect(drain(profile)).toBe(10);
    clock.advance(60_000);
    expect(drain(profile)).toBe(10);
  });

  it('keeps the four buckets independent', () => {
    const clock = fakeClock();
    const limits = createConnLimits(clock.now);
    drain(limits.cursor);
    expect(limits.edit.take()).toBe(true);
    expect(limits.history.take()).toBe(true);
    expect(limits.profile.take()).toBe(true);
  });

  it('gives each connection its own buckets', () => {
    const clock = fakeClock();
    const a = createConnLimits(clock.now);
    const b = createConnLimits(clock.now);
    drain(a.edit);
    expect(b.edit.take()).toBe(true);
  });
});
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- limits`

Expected: FAIL, `Error: Cannot find module '../../src/limits'` and `Tests  no tests`.


- [ ] **Step 3: Implement (cycle 1 of 2: TokenBucket and createConnLimits)**

Create `worker/src/limits.ts`:

```ts
import { RATES } from '@class-board/shared/constants';

const EPSILON = 1e-9;

/**
 * Classic token bucket: holds up to `burst` tokens and refills continuously at
 * `ratePerSecond`, so a client that pauses gets its allowance back gradually
 * rather than at a fixed tick.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Spends one token. Returns false, and spends nothing, when the bucket is empty. */
  take(): boolean {
    const t = this.now();
    const elapsedMs = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.ratePerSecond);
    // The epsilon absorbs floating-point error, so a token that is due exactly now isn't refused.
    if (this.tokens < 1 - EPSILON) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }
}

export interface ConnLimits {
  cursor: TokenBucket;
  edit: TokenBucket;
  history: TokenBucket;
  profile: TokenBucket;
}

/** One set of buckets per connection. Per-minute limits allow a burst of a full minute's worth. */
export function createConnLimits(now: () => number): ConnLimits {
  return {
    cursor: new TokenBucket(RATES.cursorPerSecond, RATES.cursorBurst, now),
    edit: new TokenBucket(RATES.editsPerMinute / 60, RATES.editsPerMinute, now),
    history: new TokenBucket(RATES.historyPerMinute / 60, RATES.historyPerMinute, now),
    profile: new TokenBucket(RATES.profilePerMinute / 60, RATES.profilePerMinute, now),
  };
}
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- limits`

Expected: PASS, `Tests  12 passed (12)`.


- [ ] **Step 5: Write the next failing tests (cycle 2 of 2: KeyedLimiter)**

Replace the import lines at the top of `worker/test/unit/limits.test.ts` (everything above the first blank line) with:

```ts
import { describe, expect, it } from 'vitest';
import { KeyedLimiter, TokenBucket, createConnLimits } from '../../src/limits';
```

Then append this to the end of the file, after a blank line:

```ts
describe('KeyedLimiter', () => {
  it('allows perMinute calls per key and then refuses', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    for (let i = 0; i < 5; i += 1) expect(limiter.allow('1.2.3.4')).toBe(true);
    expect(limiter.allow('1.2.3.4')).toBe(false);
  });

  it('counts each key separately', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(1, clock.now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('uses a sliding 60 second window: a call frees its slot exactly 60 s later', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(2, clock.now);
    expect(limiter.allow('k')).toBe(true); // t = 0
    clock.advance(30_000);
    expect(limiter.allow('k')).toBe(true); // t = 30 s
    expect(limiter.allow('k')).toBe(false);
    clock.advance(29_999); // t = 59.999 s: the first call is still inside the window
    expect(limiter.allow('k')).toBe(false);
    clock.advance(1); // t = 60 s: the first call has left the window
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false); // the t = 30 s call still counts
  });

  it('does not extend the window for refused calls', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(1, clock.now);
    expect(limiter.allow('k')).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      clock.advance(5_000);
      expect(limiter.allow('k')).toBe(false);
    }
    clock.advance(10_000); // 60 s after the only allowed call
    expect(limiter.allow('k')).toBe(true);
  });

  it('evicts keys whose calls have all left the window', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    for (let i = 0; i < 100; i += 1) limiter.allow(`ip-${i}`);
    expect(limiter.size).toBe(100);
    clock.advance(60_000);
    limiter.allow('someone-new'); // triggers the sweep
    expect(limiter.size).toBe(1);
  });

  it('keeps keys that still have a call inside the window when it sweeps', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(5, clock.now);
    limiter.allow('old');
    clock.advance(40_000);
    limiter.allow('recent');
    clock.advance(20_000); // 'old' is 60 s old, 'recent' is 20 s old
    limiter.allow('trigger');
    expect(limiter.size).toBe(2); // 'recent' and 'trigger'
    expect(limiter.allow('recent')).toBe(true);
  });

  it('never allows anything when perMinute is 0', () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(0, clock.now);
    expect(limiter.allow('k')).toBe(false);
  });
});
```


- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- limits`

Expected: FAIL, `Tests  7 failed | 12 passed (19)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 7: Implement (cycle 2 of 2: KeyedLimiter)**

Append this to the end of `worker/src/limits.ts`:

```ts
const WINDOW_MS = 60_000;

/**
 * At most `perMinute` calls per key in any sliding 60 s window (each allowed call is
 * remembered for 60 s). Keys with nothing left in the window are evicted, at most once
 * per window, so a stream of one-off keys (uploads from many IPs) can't grow the map forever.
 */
export class KeyedLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {
    this.lastSweep = now();
  }

  allow(key: string): boolean {
    const t = this.now();
    if (t - this.lastSweep >= WINDOW_MS) this.sweep(t);

    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Number of keys currently remembered. */
  get size(): number {
    return this.hits.size;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, times] of this.hits) {
      if (times.every((at) => t - at >= WINDOW_MS)) this.hits.delete(key);
    }
  }
}
```


- [ ] **Step 8: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- limits`

Expected: PASS, `Tests  19 passed (19)`.


- [ ] **Step 9: Write the failing test (cycle 1 of 2: counting, UTC rollover and thresholds)**

Create `worker/test/unit/budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DailyBudget, utcDay, type BudgetState } from '../../src/budget';

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0); // 2026-09-29 12:00 UTC

function setup(opts: { limit?: number; stored?: BudgetState | null; start?: number } = {}) {
  let t = opts.start ?? T0;
  const saves: BudgetState[] = [];
  const budget = new DailyBudget({
    limit: opts.limit ?? 1000,
    now: () => t,
    load: () => opts.stored ?? null,
    save: (s) => saves.push(s),
  });
  return { budget, saves, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

describe('utcDay', () => {
  it('formats a timestamp as a UTC calendar day', () => {
    expect(utcDay(Date.UTC(2026, 8, 29, 0, 0, 0))).toBe('2026-09-29');
    expect(utcDay(Date.UTC(2026, 8, 29, 23, 59, 59, 999))).toBe('2026-09-29');
    expect(utcDay(Date.UTC(2026, 8, 30, 0, 0, 0))).toBe('2026-09-30');
  });

  it('zero-pads month and day', () => {
    expect(utcDay(Date.UTC(2027, 0, 5, 3))).toBe('2027-01-05');
  });
});

describe('DailyBudget counting', () => {
  it('starts at zero for today', () => {
    const { budget } = setup();
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 0 });
  });

  it('adds one message by default and n when given', () => {
    const { budget } = setup();
    budget.add();
    budget.add(4);
    expect(budget.state().count).toBe(5);
  });

  it('resumes from a count stored earlier today', () => {
    const { budget } = setup({ stored: { day: '2026-09-29', count: 700 } });
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 700 });
  });

  it("discards a count stored on an earlier day", () => {
    const { budget } = setup({ stored: { day: '2026-09-28', count: 1_999_999 } });
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 0 });
    expect(budget.hz()).toBe(5);
  });

  it('returns a copy of its state', () => {
    const { budget } = setup();
    const s = budget.state();
    s.count = 999;
    expect(budget.state().count).toBe(0);
  });
});

describe('DailyBudget UTC rollover', () => {
  it('starts a new day at zero when the first message arrives after midnight UTC', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 23, 59, 59) });
    budget.add(950);
    expect(budget.hz()).toBe(0);
    set(Date.UTC(2026, 8, 30, 0, 0, 0));
    budget.add();
    expect(budget.state()).toEqual({ day: '2026-09-30', count: 1 });
    expect(budget.hz()).toBe(5);
  });

  it('resets the rate at midnight even when no message has arrived yet', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 23, 59, 59) });
    budget.add(950);
    expect(budget.hz()).toBe(0);
    set(Date.UTC(2026, 8, 30, 0, 0, 1));
    expect(budget.hz()).toBe(5);
    expect(budget.state().count).toBe(0);
  });

  it('does not roll over before midnight', () => {
    const { budget, set } = setup({ start: Date.UTC(2026, 8, 29, 0, 0, 0) });
    budget.add(10);
    set(Date.UTC(2026, 8, 29, 23, 59, 59, 999));
    budget.add(10);
    expect(budget.state()).toEqual({ day: '2026-09-29', count: 20 });
  });
});

describe('DailyBudget rate thresholds', () => {
  it('sends cursors at 5 Hz below 80% of the limit', () => {
    const { budget } = setup({ limit: 1000 });
    expect(budget.hz()).toBe(5);
    budget.add(799);
    expect(budget.hz()).toBe(5);
  });

  it('drops to 2 Hz at exactly 80%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(800);
    expect(budget.hz()).toBe(2);
  });

  it('stays at 2 Hz just below 90%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(899);
    expect(budget.hz()).toBe(2);
  });

  it('pauses at exactly 90%', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(900);
    expect(budget.hz()).toBe(0);
  });

  it('stays paused over the limit', () => {
    const { budget } = setup({ limit: 1000 });
    budget.add(5000);
    expect(budget.hz()).toBe(0);
  });

  it('uses the same thresholds at the real 2,000,000 limit', () => {
    const { budget } = setup({ limit: 2_000_000 });
    budget.add(1_599_999);
    expect(budget.hz()).toBe(5);
    budget.add();
    expect(budget.hz()).toBe(2);
    budget.add(199_999);
    expect(budget.hz()).toBe(2);
    budget.add();
    expect(budget.hz()).toBe(0);
  });
});
```


- [ ] **Step 10: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- budget`

Expected: FAIL, `Error: Cannot find module '../../src/budget'` and `Tests  no tests`.


- [ ] **Step 11: Implement (cycle 1 of 2: counting, UTC rollover and thresholds)**

Create `worker/src/budget.ts`:

```ts
import { BUDGET, RATES } from '@class-board/shared/constants';

export interface BudgetState {
  day: string;
  count: number;
}

/** The UTC calendar day of a timestamp, as 'YYYY-MM-DD'. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Counts incoming WebSocket messages per UTC day and turns the count into a cursor rate.
 */
export class DailyBudget {
  private current: BudgetState;

  constructor(
    private readonly opts: {
      limit: number;
      now: () => number;
      load: () => BudgetState | null;
      save: (s: BudgetState) => void;
    },
  ) {
    const today = utcDay(opts.now());
    const loaded = opts.load();
    this.current = loaded && loaded.day === today ? { day: loaded.day, count: loaded.count } : { day: today, count: 0 };
  }

  /** Counts `n` messages. The first call after UTC midnight starts a new day at zero. */
  add(n = 1): void {
    this.rollOver();
    this.current.count += n;
  }

  /** Cursor rate for now: full below 80% of the limit, slow from 80%, paused from 90%. */
  hz(): number {
    this.rollOver();
    const { count } = this.current;
    if (count >= this.opts.limit * BUDGET.pauseAt) return 0;
    if (count >= this.opts.limit * BUDGET.slowAt) return RATES.cursorSlowHz;
    return RATES.cursorHz;
  }


  state(): BudgetState {
    this.rollOver();
    return { ...this.current };
  }

  private rollOver(): void {
    const today = utcDay(this.opts.now());
    if (today !== this.current.day) {
      this.current = { day: today, count: 0 };
    }
  }
}
```


- [ ] **Step 12: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- budget`

Expected: PASS, `Tests  16 passed (16)`.


- [ ] **Step 13: Write the next failing tests (cycle 2 of 2: persistence with flush)**

Append this to the end of the file, after a blank line:

```ts
describe('DailyBudget persistence', () => {
  it('does not save on each message', () => {
    const { budget, saves, advance } = setup();
    for (let i = 0; i < 50; i += 1) {
      advance(10);
      budget.add();
      budget.flush();
    }
    expect(saves).toEqual([]);
  });

  it('saves once 30 seconds have passed since the start', () => {
    const { budget, saves, advance } = setup();
    budget.add(3);
    advance(29_999);
    budget.flush();
    expect(saves).toEqual([]);
    advance(1);
    budget.flush();
    expect(saves).toEqual([{ day: '2026-09-29', count: 3 }]);
  });

  it('waits another 30 seconds after each save', () => {
    const { budget, saves, advance } = setup();
    budget.add();
    advance(30_000);
    budget.flush();
    budget.add();
    advance(29_999);
    budget.flush();
    expect(saves).toHaveLength(1);
    advance(1);
    budget.flush();
    expect(saves).toEqual([
      { day: '2026-09-29', count: 1 },
      { day: '2026-09-29', count: 2 },
    ]);
  });

  it('saves again after each interval even when nothing changed, so a restart loses at most 30 s', () => {
    const { budget, saves, advance } = setup();
    budget.add();
    advance(30_000);
    budget.flush();
    advance(30_000);
    budget.flush();
    expect(saves).toEqual([
      { day: '2026-09-29', count: 1 },
      { day: '2026-09-29', count: 1 },
    ]);
  });

  it('saves right away when forced, changed or not', () => {
    const { budget, saves } = setup({ stored: { day: '2026-09-29', count: 12 } });
    budget.flush(true);
    budget.add();
    budget.flush(true);
    expect(saves).toEqual([
      { day: '2026-09-29', count: 12 },
      { day: '2026-09-29', count: 13 },
    ]);
  });

  it('hands save a copy that later messages do not change', () => {
    const { budget, saves } = setup();
    budget.add(5);
    budget.flush(true);
    budget.add(5);
    expect(saves[0]).toEqual({ day: '2026-09-29', count: 5 });
  });

  it('saves the new day after a rollover', () => {
    const { budget, saves, set } = setup({ start: Date.UTC(2026, 8, 29, 23, 59, 50), stored: { day: '2026-09-29', count: 40 } });
    set(Date.UTC(2026, 8, 30, 0, 0, 30));
    budget.flush();
    expect(saves).toEqual([{ day: '2026-09-30', count: 0 }]);
  });
});
```


- [ ] **Step 14: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- budget`

Expected: FAIL, `Tests  7 failed | 16 passed (23)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 15: Implement (cycle 2 of 2: persistence with flush)**

Replace the whole of `worker/src/budget.ts` with:

```ts
import { BUDGET, RATES } from '@class-board/shared/constants';

export interface BudgetState {
  day: string;
  count: number;
}

/** The UTC calendar day of a timestamp, as 'YYYY-MM-DD'. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Counts incoming WebSocket messages per UTC day and turns the count into a cursor rate.
 * The count lives in memory; `flush` persists it through `save` at most once per
 * BUDGET.persistEveryMs, so a busy class costs a couple of row writes a minute, not one per message.
 */
export class DailyBudget {
  private current: BudgetState;
  private lastSave: number;

  constructor(
    private readonly opts: {
      limit: number;
      now: () => number;
      load: () => BudgetState | null;
      save: (s: BudgetState) => void;
    },
  ) {
    const today = utcDay(opts.now());
    const loaded = opts.load();
    this.current = loaded && loaded.day === today ? { day: loaded.day, count: loaded.count } : { day: today, count: 0 };
    this.lastSave = opts.now();
  }

  /** Counts `n` messages. The first call after UTC midnight starts a new day at zero. */
  add(n = 1): void {
    this.rollOver();
    this.current.count += n;
  }

  /** Cursor rate for now: full below 80% of the limit, slow from 80%, paused from 90%. */
  hz(): number {
    this.rollOver();
    const { count } = this.current;
    if (count >= this.opts.limit * BUDGET.pauseAt) return 0;
    if (count >= this.opts.limit * BUDGET.slowAt) return RATES.cursorSlowHz;
    return RATES.cursorHz;
  }

  /**
   * Saves the count once BUDGET.persistEveryMs has passed since the last save (or since
   * construction). `force` saves right away.
   */
  flush(force = false): void {
    this.rollOver();
    const t = this.opts.now();
    if (!force && t - this.lastSave < BUDGET.persistEveryMs) return;
    this.opts.save({ ...this.current });
    this.lastSave = t;
  }

  state(): BudgetState {
    this.rollOver();
    return { ...this.current };
  }

  private rollOver(): void {
    const today = utcDay(this.opts.now());
    if (today !== this.current.day) {
      this.current = { day: today, count: 0 };
    }
  }
}
```


- [ ] **Step 16: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- budget`

Expected: PASS, `Tests  23 passed (23)`.


- [ ] **Step 17: Commit (orchestrator)**

```bash
git add worker/src/limits.ts worker/src/budget.ts worker/test/unit/limits.test.ts worker/test/unit/budget.test.ts
git commit -m "feat(worker): token buckets and daily budget (X2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task X3: Teacher gate

**Wave:** 2 · **Tier:** T0 (haiku) · **Depends on:** F1, F2

**Files:**
- Create: `worker/src/teacher.ts`
- Test: `worker/test/unit/teacher.test.ts`

**Choices worth knowing.** `TeacherGate` keeps the times of each key's wrong tries. Five wrong tries (`RATES.teacherAttempts`) inside any `RATES.teacherWindowMs` lock the key out, and the lockout ends when the oldest of those tries is 10 minutes old (a sliding window, not a fixed 10 minute ban). A call made while locked out returns `locked_out` even with the right code, and is not recorded, so a student who keeps guessing cannot extend the lockout. A right code while not locked out returns `ok` and clears that key's history. Idle keys are swept at most once per window. `safeEqual` compares UTF-8 bytes and always loops over the longer length, folding the length difference into the result instead of returning early. W3 chooses the key (a connection id, or the client IP for a limit that survives reconnecting) and must refuse to run the gate at all when `TEACHER_CODE` is empty.

- [ ] **Step 1: Write the failing test**

Create `worker/test/unit/teacher.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TeacherGate, safeEqual } from '../../src/teacher';

const WINDOW = 10 * 60_000;

function setup(code = 'letmein') {
  let t = 5_000_000;
  const gate = new TeacherGate(code, () => t);
  return { gate, advance: (ms: number) => void (t += ms) };
}

function failTimes(gate: TeacherGate, key: string, n: number) {
  for (let i = 0; i < n; i += 1) expect(gate.check(key, 'wrong')).toBe('bad');
}

describe('safeEqual', () => {
  it('accepts equal strings', () => {
    expect(safeEqual('letmein', 'letmein')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(safeEqual('letmein', 'letmeix')).toBe(false);
    expect(safeEqual('Abc', 'abc')).toBe(false);
  });

  it('rejects a prefix in either direction', () => {
    expect(safeEqual('letmein', 'letme')).toBe(false);
    expect(safeEqual('letme', 'letmein')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('is not fooled by a NUL added to reach the same length', () => {
    expect(safeEqual('abc', 'abc\u0000')).toBe(false);
    expect(safeEqual('abc\u0000', 'abc')).toBe(false);
  });

  it('compares non-ASCII text by its UTF-8 bytes', () => {
    expect(safeEqual('pässwörd', 'pässwörd')).toBe(true);
    expect(safeEqual('pässwörd', 'passwörd')).toBe(false);
  });
});

describe('TeacherGate', () => {
  it('accepts the right code', () => {
    const { gate } = setup();
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('reports a wrong code as bad', () => {
    const { gate } = setup();
    expect(gate.check('a', 'nope')).toBe('bad');
    expect(gate.check('a', '')).toBe('bad');
  });

  it('reports five wrong tries as bad and locks out from the sixth', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
  });

  it('does not accept the correct code once locked out', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'letmein')).toBe('locked_out');
  });

  it('still accepts the correct code after four wrong tries', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 4);
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('forgets earlier wrong tries after a success', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 4);
    expect(gate.check('a', 'letmein')).toBe('ok');
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
  });

  it('counts keys separately', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
    expect(gate.check('b', 'letmein')).toBe('ok');
  });

  it('lifts the lockout when the wrong tries leave the 10 minute window', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 5);
    advance(WINDOW - 1);
    expect(gate.check('a', 'letmein')).toBe('locked_out');
    advance(1);
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('does not extend the lockout when a locked-out key keeps trying', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 5);
    for (let i = 0; i < 9; i += 1) {
      advance(60_000);
      expect(gate.check('a', 'wrong')).toBe('locked_out');
    }
    advance(60_000); // 10 minutes after the wrong tries
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('never locks out a key whose wrong tries are spread out', () => {
    const { gate, advance } = setup();
    for (let i = 0; i < 30; i += 1) {
      expect(gate.check('a', 'wrong')).toBe('bad');
      advance(WINDOW / 4 + 1); // at most 4 wrong tries fit in any window
    }
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('frees one try at a time as the window slides', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 3);
    advance(WINDOW / 2);
    failTimes(gate, 'a', 2);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
    advance(WINDOW / 2); // the first three have now left the window
    expect(gate.check('a', 'wrong')).toBe('bad');
  });

  it('forgets idle keys, so a key that was almost locked out starts fresh', () => {
    const { gate, advance } = setup();
    for (let i = 0; i < 50; i += 1) failTimes(gate, `ip-${i}`, 4);
    advance(WINDOW);
    expect(gate.check('someone-new', 'letmein')).toBe('ok'); // triggers the sweep
    failTimes(gate, 'ip-0', 5);
    expect(gate.check('ip-0', 'wrong')).toBe('locked_out');
  });

  it('accepts nothing, not even an empty code, when no passcode is configured', () => {
    const unset = new TeacherGate('', () => 0);
    expect(unset.check('a', '')).toBe('bad');
    expect(unset.check('a', 'anything')).toBe('bad');
  });
});
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- teacher`

Expected: FAIL, `Error: Cannot find module '../../src/teacher'` and `Tests  no tests`.


- [ ] **Step 3: Implement**

Create `worker/src/teacher.ts`:

```ts
import { RATES } from '@class-board/shared/constants';

export type TeacherCheck = 'ok' | 'bad' | 'locked_out';

/** Compares two strings without stopping at the first difference. Runs over the longer length. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Checks teacher passcodes. Each key (a connection id or IP) may make RATES.teacherAttempts
 * wrong tries in any RATES.teacherWindowMs; after that it is locked out until the oldest of
 * those tries leaves the window. Attempts made while locked out are not recorded, so
 * hammering a locked key can't extend its lockout, and a correct code doesn't lift it.
 */
export class TeacherGate {
  private readonly failures = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly code: string,
    private readonly now: () => number,
  ) {
    this.lastSweep = now();
  }

  check(key: string, attempt: string): TeacherCheck {
    const t = this.now();
    if (t - this.lastSweep >= RATES.teacherWindowMs) this.sweep(t);

    const recent = (this.failures.get(key) ?? []).filter((at) => t - at < RATES.teacherWindowMs);
    if (recent.length >= RATES.teacherAttempts) {
      this.failures.set(key, recent);
      return 'locked_out';
    }
    // An unset TEACHER_CODE secret must never let an empty attempt in.
    if (this.code !== '' && safeEqual(attempt, this.code)) {
      this.failures.delete(key);
      return 'ok';
    }
    recent.push(t);
    this.failures.set(key, recent);
    return 'bad';
  }

  /** Drops keys with no wrong try left in the window, at most once per window. */
  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, times] of this.failures) {
      if (times.every((at) => t - at >= RATES.teacherWindowMs)) this.failures.delete(key);
    }
  }
}
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- teacher`

Expected: PASS, `Tests  18 passed (18)`.


- [ ] **Step 5: Commit (orchestrator)**

```bash
git add worker/src/teacher.ts worker/test/unit/teacher.test.ts
git commit -m "feat(worker): teacher gate (X3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task X4: Upload checks and file responses

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F1, F2

**Files:**
- Create: `worker/src/files.ts`
- Test: `worker/test/unit/files.test.ts`

**Choices worth knowing.**

- `checkUpload` checks the size first (`LIMITS.htmlMaxBytes`; exactly 1,000,000 bytes is allowed), then decodes with a fatal UTF-8 decoder, then requires a `<`. It uses `ignoreBOM: true`, so a byte order mark stays in the string and the file is served back exactly as uploaded. The title is the first `<title>` element's text with entities decoded (`&amp; &lt; &gt; &quot; &apos; &nbsp;` and numeric ones), whitespace collapsed and cut to 200 characters; else the file name without directory and extension; else `HTML page`. It finds the title with two bounded regex searches, so a megabyte of unclosed tags can't make it slow.
- `parseOrigins` keeps only http(s) entries, reduces each to its origin (lowercase host, no path, no default port) and removes duplicates, so a stray trailing slash in `ALLOWED_ORIGINS` can't break the CSP or the CORS comparison. `corsHeaders` compares the request origin to that list exactly.
- `htmlFileResponse` uses the exact headers of spec section 5.8. With an empty origin list it writes `frame-ancestors 'none'`, so a misconfiguration fails closed. `shotResponse` adds `X-Content-Type-Options: nosniff` to the type and cache headers.
- The first version of the file already contains the `LIMITS` import, which `checkUpload` uses from cycle 2. Later cycles only append.

- [ ] **Step 1: Write the failing test (cycle 1 of 3: ids and origins)**

Create `worker/test/unit/files.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ID_RE, newId, parseOrigins } from '../../src/files';

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
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- files`

Expected: FAIL, `Error: Cannot find module '../../src/files'` and `Tests  no tests`.


- [ ] **Step 3: Implement (cycle 1 of 3: ids and origins)**

Create `worker/src/files.ts`:

```ts
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
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- files`

Expected: PASS, `Tests  9 passed (9)`.


- [ ] **Step 5: Write the next failing tests (cycle 2 of 3: checkUpload)**

Replace the import lines at the top of `worker/test/unit/files.test.ts` (everything above the first blank line) with:

```ts
import { describe, expect, it } from 'vitest';
import { ID_RE, checkUpload, newId, parseOrigins } from '../../src/files';
```

Then append this to the end of the file, after a blank line:

```ts
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
```


- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- files`

Expected: FAIL, `Tests  22 failed | 9 passed (31)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 7: Implement (cycle 2 of 3: checkUpload)**

Append this to the end of `worker/src/files.ts`:

```ts
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
```


- [ ] **Step 8: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- files`

Expected: PASS, `Tests  31 passed (31)`.


- [ ] **Step 9: Write the next failing tests (cycle 3 of 3: responses, CORS and json)**

Replace the import lines at the top of `worker/test/unit/files.test.ts` (everything above the first blank line) with:

```ts
import { describe, expect, it } from 'vitest';
import {
  ID_RE, checkUpload, corsHeaders, htmlFileResponse, json, newId, parseOrigins, shotResponse,
} from '../../src/files';
```

Then append this to the end of the file, after a blank line:

```ts
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
      'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
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
    expect(h['Access-Control-Allow-Headers']).toBe('Content-Type, X-File-Name');
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
```


- [ ] **Step 10: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- files`

Expected: FAIL, `Tests  14 failed | 31 passed (45)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 11: Implement (cycle 3 of 3: responses, CORS and json)**

Append this to the end of `worker/src/files.ts`:

```ts
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
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
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
```


- [ ] **Step 12: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- files`

Expected: PASS, `Tests  45 passed (45)`.


- [ ] **Step 13: Commit (orchestrator)**

```bash
git add worker/src/files.ts worker/test/unit/files.test.ts
git commit -m "feat(worker): upload checks and file responses (X4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task X5: Link check

**Wave:** 3 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2, X1

**Files:**
- Create: `worker/src/linkCheck.ts`
- Test: `worker/test/unit/linkCheck.test.ts`

**Behaviour.** `checkLink(embedUrl, boardOrigin, fetchImpl = fetch)`:

- One `AbortSignal.timeout(LINK_CHECK.timeoutMs)` covers the whole check: every redirect hop and the body read. Each hop is a `GET` with `redirect: 'manual'`. A 301, 302, 303, 307 or 308 with a `Location` is followed, with the location resolved against the current URL. After `LINK_CHECK.maxRedirects` (5) redirects, a sixth redirect gives `unknown`, and so does a redirect to a non-http(s) URL. A 3xx with no `Location` is treated as the final response.
- Any thrown error, or a timeout before the headers arrive, gives `{ embeddable: 'unknown', title: null, icon: null }`.
- `evaluateFraming` (X1) judges only the final response and uses the final URL, so `'self'` and `SAMEORIGIN` are matched against where the redirects ended. Error pages (404) are judged by their headers like any other page.
- A content type without `html` in it (or none) gives `title: null` and the `<final origin>/favicon.ico` icon, without reading the body.
- For HTML, the body is cut to `LINK_CHECK.maxHtmlBytes` (the rest of the stream is cancelled) and read with `HTMLRewriter`. The title is `og:title` (from `property=` or `name=`), else the first `<title>`. Entities are decoded, whitespace collapsed and the result cut to 200 characters. The icon is the first `<link>` whose `rel` has an `icon` token (so `icon` and `shortcut icon`, not `mask-icon` or `apple-touch-icon`) with a non-empty `http(s)` href resolved against the final URL; otherwise `/favicon.ico` on the final origin. If the body fails after the headers arrived, the framing answer is kept and the title is null.
- The first version already imports `evaluateFraming` and declares `UNKNOWN`; they are used from cycle 2. Later cycles replace only the `checkLink` function.

- [ ] **Step 1: Write the failing test (cycle 1 of 3: title and icon extraction)**

Create `worker/test/unit/linkCheck.test.ts`:

```ts
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
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: FAIL, `Error: Cannot find module '../../src/linkCheck'` and `Tests  no tests`.


- [ ] **Step 3: Implement (cycle 1 of 3: title and icon extraction)**

Create `worker/src/linkCheck.ts`:

```ts
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

/** First version: one plain request, always framable. Framing, errors and redirects come next. */
export async function checkLink(embedUrl: string, _boardOrigin: string, fetchImpl: typeof fetch = fetch): Promise<LinkCheckResult> {
  const url = new URL(embedUrl);
  const res = await fetchImpl(url.href, {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  const fallbackIcon = `${url.origin}/favicon.ico`;
  if (!isHtml(res)) {
    await res.body?.cancel().catch(() => {});
    return { embeddable: 'yes', title: null, icon: fallbackIcon };
  }
  const meta = await readMetadata(res, url);
  return { embeddable: 'yes', title: meta.title, icon: meta.icon ?? fallbackIcon };
}
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: PASS, `Tests  26 passed (26)`.


- [ ] **Step 5: Write the next failing tests (cycle 2 of 3: framing verdict and network errors)**

Append this to the end of the file, after a blank line:

```ts
describe('checkLink: framing', () => {
  it('says yes when the page sets no framing headers', async () => {
    expect((await check(html('<p>x</p>'))).embeddable).toBe('yes');
  });

  it('says no for X-Frame-Options DENY, and still reads the title', async () => {
    const r = await check(html('<title>Blocked</title>', { 'x-frame-options': 'DENY' }));
    expect(r.embeddable).toBe('no');
    expect(r.title).toBe('Blocked');
  });

  it("says no for frame-ancestors 'self' and yes when it lists the board", async () => {
    expect((await check(html('<p/>', { 'content-security-policy': "frame-ancestors 'self'" }))).embeddable).toBe('no');
    expect((await check(html('<p/>', { 'content-security-policy': `frame-ancestors ${BOARD}` }))).embeddable).toBe('yes');
  });

  it('lets CSP override X-Frame-Options', async () => {
    const r = await check(html('<p/>', { 'x-frame-options': 'DENY', 'content-security-policy': `frame-ancestors ${BOARD}` }));
    expect(r.embeddable).toBe('yes');
  });

  it('still judges an error page by its headers', async () => {
    const r = await check(new Response('<title>Not found</title>', {
      status: 404,
      headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' },
    }));
    expect(r.embeddable).toBe('no');
    expect(r.title).toBe('Not found');
  });

  it('still judges framing for a non-HTML response', async () => {
    const r = await check(new Response('%PDF', { headers: { 'content-type': 'application/pdf', 'x-frame-options': 'DENY' } }));
    expect(r).toEqual({ embeddable: 'no', title: null, icon: 'https://site.example/favicon.ico' });
  });

  it('keeps the framing answer when the body fails after the headers', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error('connection reset'));
        sent = true;
        controller.enqueue(new TextEncoder().encode('<title>Half'));
      },
    });
    const r = await check(new Response(body, { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } }));
    expect(r).toEqual({ embeddable: 'no', title: null, icon: 'https://site.example/favicon.ico' });
  });
});

describe('checkLink: network errors', () => {
  it('gives unknown when the network fails', async () => {
    const { impl } = fakeFetch({ 'https://down.example/': new TypeError('fetch failed') });
    expect(await checkLink('https://down.example/', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
  });

  it('gives unknown for a URL that cannot be parsed, without fetching', async () => {
    const { impl, calls } = fakeFetch({});
    expect(await checkLink('not a url', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
    expect(calls).toHaveLength(0);
  });
});
```


- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: FAIL, `Tests  7 failed | 28 passed (35)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 7: Implement (cycle 2 of 3: framing verdict and network errors)**

In `worker/src/linkCheck.ts`, replace the `checkLink` function (from its `/**` doc comment to the end of the file) with:

```ts
/**
 * Fetches a link the way a browser would frame it and reports whether the site allows that,
 * with its title and icon. A network error before the headers arrive gives 'unknown'.
 */
export async function checkLink(embedUrl: string, boardOrigin: string, fetchImpl: typeof fetch = fetch): Promise<LinkCheckResult> {
  let url: URL;
  try {
    url = new URL(embedUrl);
  } catch {
    return UNKNOWN;
  }

  let res: Response;
  try {
    res = await fetchImpl(url.href, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
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
    // The headers already answered the question; a body cut off early only costs the title.
    return { embeddable, title: null, icon: fallbackIcon };
  }
}
```


- [ ] **Step 8: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: PASS, `Tests  35 passed (35)`.
One test (the response body that fails after its headers) makes workerd print two `uncaught exception; source = Uncaught (in promise); ... Error: connection reset` blocks. That is the runtime logging the deliberately broken stream, not a failure: the run still ends with PASS and exit code 0.


- [ ] **Step 9: Write the next failing tests (cycle 3 of 3: redirects and the timeout)**

Append this to the end of the file, after a blank line:

```ts
describe('checkLink: redirects', () => {
  it('asks for the page with GET, manual redirects and a timeout signal', async () => {
    const { impl, calls } = fakeFetch({ 'https://site.example/': html('<p/>') });
    await checkLink('https://site.example/', BOARD, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows absolute, root-relative and path-relative Location headers', async () => {
    const { impl, calls } = fakeFetch({
      'https://a.example/start/x': redirect('https://b.example/one/two'),
      'https://b.example/one/two': redirect('/three'),
      'https://b.example/three': redirect('four', 301),
      'https://b.example/four': redirect('../five', 307),
      'https://b.example/five': html('<title>Arrived</title>'),
    });
    const r = await checkLink('https://a.example/start/x', BOARD, impl);
    expect(r.title).toBe('Arrived');
    expect(calls.map((c) => c.url)).toEqual([
      'https://a.example/start/x',
      'https://b.example/one/two',
      'https://b.example/three',
      'https://b.example/four',
      'https://b.example/five',
    ]);
  });

  it('follows 301, 302, 303, 307 and 308', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { impl } = fakeFetch({
        'https://a.example/': redirect('https://b.example/', status),
        'https://b.example/': html('<title>Ok</title>'),
      });
      expect((await checkLink('https://a.example/', BOARD, impl)).title).toBe('Ok');
    }
  });

  function chain(redirects: number) {
    const routes: Record<string, Reply> = {};
    for (let i = 0; i < redirects; i += 1) routes[`https://r.example/${i}`] = redirect(`/${i + 1}`);
    routes[`https://r.example/${redirects}`] = html('<title>End</title>');
    return fakeFetch(routes);
  }

  it('follows exactly 5 redirects', async () => {
    const { impl, calls } = chain(5);
    const r = await checkLink('https://r.example/0', BOARD, impl);
    expect(r.title).toBe('End');
    expect(calls).toHaveLength(6);
  });

  it('gives unknown after more than 5 redirects, without fetching a 7th time', async () => {
    const { impl, calls } = chain(6);
    const r = await checkLink('https://r.example/0', BOARD, impl);
    expect(r).toEqual({ embeddable: 'unknown', title: null, icon: null });
    expect(calls).toHaveLength(6);
  });

  it('gives unknown for a redirect loop', async () => {
    const { impl } = fakeFetch({
      'https://a.example/': redirect('https://b.example/'),
      'https://b.example/': redirect('https://a.example/'),
    });
    expect(await checkLink('https://a.example/', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
  });

  it('gives unknown when a redirect leads to a non-http URL', async () => {
    for (const to of ['ftp://files.example/x', 'javascript:alert(1)', 'data:text/html,hi']) {
      const { impl } = fakeFetch({ 'https://a.example/': redirect(to) });
      expect(await checkLink('https://a.example/', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
    }
  });

  it('treats a 3xx without Location as the final response', async () => {
    const r = await check(new Response('<title>Moved</title>', { status: 300, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } }));
    expect(r.embeddable).toBe('no');
  });

  it('uses one timeout signal for the whole chain', async () => {
    const { impl, calls } = fakeFetch({
      'https://a.example/': redirect('https://b.example/'),
      'https://b.example/': html('<p/>'),
    });
    await checkLink('https://a.example/', BOARD, impl);
    expect(calls[0]!.init?.signal).toBe(calls[1]!.init?.signal);
  });

  it('resolves against the final URL after redirects, not the first one', async () => {
    const { impl } = fakeFetch({
      'https://short.example/x': redirect('https://long.example/dir/page'),
      'https://long.example/dir/page': html('<link rel="icon" href="i.png"><title>Long</title>'),
    });
    const r = await checkLink('https://short.example/x', BOARD, impl);
    expect(r).toEqual({ embeddable: 'yes', title: 'Long', icon: 'https://long.example/dir/i.png' });
  });

  it('uses the final origin for the /favicon.ico fallback', async () => {
    const { impl } = fakeFetch({
      'https://short.example/x': redirect('https://long.example/page'),
      'https://long.example/page': html('<p>none</p>'),
    });
    expect((await checkLink('https://short.example/x', BOARD, impl)).icon).toBe('https://long.example/favicon.ico');
  });

  it('judges the final response, not a redirect on the way', async () => {
    const { impl } = fakeFetch({
      'https://a.example/': new Response(null, { status: 301, headers: { location: 'https://b.example/', 'x-frame-options': 'DENY' } }),
      'https://b.example/': html('<p>ok</p>'),
    });
    expect((await checkLink('https://a.example/', BOARD, impl)).embeddable).toBe('yes');
  });

  it("matches 'self' and SAMEORIGIN against the final URL", async () => {
    const { impl } = fakeFetch({
      'https://a.example/': redirect(`${BOARD}/other/page`),
      [`${BOARD}/other/page`]: html('<p>mine</p>', { 'x-frame-options': 'SAMEORIGIN' }),
    });
    expect((await checkLink('https://a.example/', BOARD, impl)).embeddable).toBe('yes');
  });

  it('gives unknown when a later hop fails', async () => {
    const { impl } = fakeFetch({
      'https://a.example/': redirect('https://down.example/'),
      'https://down.example/': new TypeError('fetch failed'),
    });
    expect(await checkLink('https://a.example/', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
  });
});

describe('checkLink: timeout', () => {
  it('starts the timeout with LINK_CHECK.timeoutMs and gives unknown when it fires', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('The operation timed out', 'TimeoutError')));
    const { impl, calls } = fakeFetch({ 'https://slow.example/': html('<p/>') });
    const r = await checkLink('https://slow.example/', BOARD, impl);
    expect(spy).toHaveBeenCalledWith(5000);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    expect(r).toEqual({ embeddable: 'unknown', title: null, icon: null });
  });

  it('gives unknown when the timeout fires between redirects', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { impl } = fakeFetch({
      'https://a.example/': () => {
        controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
        return redirect('https://b.example/');
      },
      'https://b.example/': html('<p/>'),
    });
    expect(await checkLink('https://a.example/', BOARD, impl)).toEqual({ embeddable: 'unknown', title: null, icon: null });
  });
});
```


- [ ] **Step 10: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: FAIL, `Tests  14 failed | 37 passed (51)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 11: Implement (cycle 3 of 3: redirects and the timeout)**

In `worker/src/linkCheck.ts`, replace the `checkLink` function (from its `/**` doc comment to the end of the file) with:

```ts
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
```


- [ ] **Step 12: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- linkCheck`

Expected: PASS, `Tests  51 passed (51)`.


- [ ] **Step 13: Commit (orchestrator)**

```bash
git add worker/src/linkCheck.ts worker/test/unit/linkCheck.test.ts
git commit -m "feat(worker): link check (X5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task X6: Screenshot queue

**Wave:** 3 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2, X4, W1

**Files:**
- Create: `worker/src/shots.ts`
- Test: `worker/test/unit/shots.test.ts`

**Behaviour.**

- `shotTarget`: a link is photographed at its `embed_url` when that is a `claude.ai/public/artifacts/<id>/embed` address, otherwise at `url`. An upload is photographed at `${publicUrl}${filePath(board, file_id)}` (a trailing slash on `publicUrl` is ignored). Nothing is photographed for empty tiles, rows with a `thumb_url` (YouTube), links with no `url`, uploads with no file, and **newer Claude artifacts** (`claude.ai/artifact/...` and `claude.ai/code/artifact/...`). The last case deviates from the contract text ("else url"). A browser with no Claude account only sees a sign-in page there, and the free plan has 10 browser minutes a day.
- `runShotQueue` takes at most `maxJobs` real screenshots per call. A job is dropped without counting toward `maxJobs` when its version is missing, no longer current, already has a `shot_id`, has no target, or (in local dev) there is no shooter. On success it saves the JPEG under `newId()`, patches `shot_id`, drops the job and calls `onUpdated(row)`. If the version stopped being current while it was being photographed, the picture is still saved for History but `onUpdated` is not called, so W4 never broadcasts a stale tile. A `DailyLimitError` sends this job **and every other due job** to 00:05 UTC the next day without spending an attempt, then stops. Any other error retries after 1 minute, then 5 minutes, and drops the job after `SHOTS.maxAttempts` (3) failures. It returns `store.nextShotAt()`.
- `runShotQueue` asks `deps.shooter()` at most once per call (only when a real shot is needed) and calls `close()` on it before returning, even after an error. `createBrowserShooter().close()` only disconnects, so the kept-alive browser survives for the next alarm.
- `createBrowserShooter` reuses the browser it has. Otherwise it connects to the first `sessions()` entry with no `connectionId`, and otherwise launches with `keep_alive: SHOTS.keepAliveMs`. It waits for `networkidle2` (at most two open connections) for up to `SHOTS.maxWaitMs`, and if that runs out it still takes the screenshot, because pages with analytics never go fully quiet. Any error drops the cached browser, so the next call starts again from `sessions()`. A message containing `time limit exceeded` becomes `DailyLimitError`. Every other error, including other 429s, is rethrown as is and gets the retry schedule. The unit tests exercise it against a fake binding that answers only the REST calls; opening a real websocket is left to the first deploy (spike 2).
- At deploy time the file needs `nodejs_compat` in `worker/wrangler.jsonc` and a `browser` binding named `BROWSER` (`Env.BROWSER`).
- The imports for all three cycles are in the first version of the file, and every later cycle only appends.

- [ ] **Step 1: Write the failing test (cycle 1 of 3: shotTarget)**

Create `worker/test/unit/shots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shotTarget } from '../../src/shots';
import type { VersionRow } from '../../src/store';

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
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:unit -w worker -- shots`

Expected: FAIL, `Error: Cannot find module '../../src/shots'` and `Tests  no tests`.


- [ ] **Step 3: Implement (cycle 1 of 3: shotTarget)**

Create `worker/src/shots.ts`:

```ts
import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import { SHOTS } from '@class-board/shared/constants';
import { newId } from './files';
import { filePath, type BoardStore, type VersionRow } from './store';

export interface Shooter { shoot(url: string): Promise<ArrayBuffer>; close(): Promise<void>; }

/** Browser Rendering's free daily browser time is used up. Nothing works until 00:00 UTC. */
export class DailyLimitError extends Error {}

const CLAUDE_EMBED_PATH = /^\/public\/artifacts\/[^/]+\/embed\/?$/;
const CLAUDE_NEW_PATH = /^\/(?:code\/)?artifact\//;

function hostAndPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * The URL to photograph for a version, or null when there is nothing to photograph:
 * empty tiles, YouTube (its thumbnail is already there), uploads without a file, and
 * newer Claude artifacts, which only show a sign-in page to a browser with no account.
 */
export function shotTarget(row: VersionRow, board: string, publicUrl: string): string | null {
  if (row.kind === 'empty' || row.thumb_url) return null;
  if (row.kind === 'html') {
    return row.file_id ? `${publicUrl.replace(/\/+$/, '')}${filePath(board, row.file_id)}` : null;
  }
  const embed = row.embed_url ? hostAndPath(row.embed_url) : null;
  if (row.embed_url && embed?.host === 'claude.ai' && CLAUDE_EMBED_PATH.test(embed.path)) return row.embed_url;
  if (!row.url) return null;
  const page = hostAndPath(row.url);
  if (page?.host === 'claude.ai' && CLAUDE_NEW_PATH.test(page.path)) return null;
  return row.url;
}
```


- [ ] **Step 4: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- shots`

Expected: PASS, `Tests  8 passed (8)`.


- [ ] **Step 5: Write the next failing tests (cycle 2 of 3: runShotQueue)**

Replace the import lines at the top of `worker/test/unit/shots.test.ts` (everything above the first blank line) with:

```ts
import { describe, expect, it } from 'vitest';
import { DailyLimitError, runShotQueue, shotTarget, type ShotDeps, type Shooter } from '../../src/shots';
import type { BoardStore, VersionRow } from '../../src/store';
```

Then append this to the end of the file, after a blank line:

```ts
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
```


- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- shots`

Expected: FAIL, `Tests  26 failed | 8 passed (34)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 7: Implement (cycle 2 of 3: runShotQueue)**

Append this to the end of `worker/src/shots.ts`:

```ts
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];

export interface ShotDeps {
  store: BoardStore; board: string; publicUrl: string;
  shooter: () => Shooter | null; now: () => number;
  onUpdated: (row: VersionRow) => void;   // called after shot_id is patched
}

/** 00:05 UTC on the day after `now`, when the daily browser time is back. */
function tomorrowAfterMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
}

/**
 * Works through the shots that are due, at most `maxJobs` real screenshots per call (rows that
 * are skipped don't count). Returns when to call again, or null when the queue is empty.
 * It closes the shooter it asked for before returning.
 */
export async function runShotQueue(deps: ShotDeps, maxJobs = 3): Promise<number | null> {
  const { store } = deps;
  const isCurrent = (row: VersionRow) => store.current(row.slot)?.id === row.id;
  let shooter: Shooter | null | undefined;
  let taken = 0;

  try {
    while (taken < maxJobs) {
      const job = store.dueShot(deps.now());
      if (!job) break;

      const row = store.get(job.versionId);
      const target = row && !row.shot_id && isCurrent(row) ? shotTarget(row, deps.board, deps.publicUrl) : null;
      if (!row || !target) {
        store.dropShot(job.versionId);
        continue;
      }
      if (shooter === undefined) shooter = deps.shooter();
      if (!shooter) {
        store.dropShot(job.versionId); // no browser here (local dev): screenshots are skipped
        continue;
      }

      taken += 1;
      try {
        const jpeg = await shooter.shoot(target);
        const shotId = newId();
        store.putShot(shotId, jpeg, deps.now());
        const patched = store.patch(row.id, { shot_id: shotId });
        // A version that was replaced while it was being photographed keeps its picture for
        // History, but the tile on the board must not be redrawn with it.
        if (patched && isCurrent(patched)) deps.onUpdated(patched);
        store.dropShot(job.versionId);
      } catch (err) {
        if (err instanceof DailyLimitError) {
          // Everything else that is due would fail the same way, so move it all to tomorrow.
          const retryAt = tomorrowAfterMidnight(deps.now());
          store.retryShot(job.versionId, job.attempts, retryAt);
          for (let next = store.dueShot(deps.now()); next; next = store.dueShot(deps.now())) {
            store.retryShot(next.versionId, next.attempts, retryAt);
          }
          break;
        }
        const attempts = job.attempts + 1;
        if (attempts >= SHOTS.maxAttempts) {
          store.dropShot(job.versionId);
        } else {
          const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!;
          store.retryShot(job.versionId, attempts, deps.now() + delay);
        }
      }
    }
  } finally {
    await shooter?.close().catch(() => {});
  }
  return store.nextShotAt();
}
```


- [ ] **Step 8: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- shots`

Expected: PASS, `Tests  34 passed (34)`.


- [ ] **Step 9: Write the next failing tests (cycle 3 of 3: createBrowserShooter)**

Replace the import lines at the top of `worker/test/unit/shots.test.ts` (everything above the first blank line) with:

```ts
import { describe, expect, it } from 'vitest';
import {
  DailyLimitError, createBrowserShooter, runShotQueue, shotTarget, type ShotDeps, type Shooter,
} from '../../src/shots';
import type { BoardStore, VersionRow } from '../../src/store';
```

Then append this to the end of the file, after a blank line:

```ts
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

  it('launches a kept-alive browser when there is no session to reuse', async () => {
    const { fetcher, calls } = binding({ acquire: () => new Response('Browser time limit exceeded for today', { status: 429 }) });
    await createBrowserShooter(fetcher).shoot('https://site.example/').catch(() => {});
    expect(calls).toEqual(['GET /v1/sessions', 'POST /v1/devtools/browser?keep_alive=600000']);
  });

  it('leaves other launch errors as ordinary errors, so the job is retried', async () => {
    const { fetcher } = binding({ acquire: () => new Response('Too many requests', { status: 429 }) });
    const err = await createBrowserShooter(fetcher).shoot('https://site.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DailyLimitError);
    expect((err as Error).message).toContain('429');
  });

  it('closes cleanly when it never connected', async () => {
    const { fetcher } = binding({});
    await expect(createBrowserShooter(fetcher).close()).resolves.toBeUndefined();
  });
});
```


- [ ] **Step 10: Run it and confirm the new tests fail**

Run: `npm run test:unit -w worker -- shots`

Expected: FAIL, `Tests  4 failed | 34 passed (38)`. The new tests fail and the earlier ones still pass.


- [ ] **Step 11: Implement (cycle 3 of 3: createBrowserShooter)**

Append this to the end of `worker/src/shots.ts`:

```ts
const DAILY_LIMIT_RE = /time limit exceeded/i;

/**
 * Screenshots through Browser Rendering. It keeps one browser alive (SHOTS.keepAliveMs) and
 * finds it again with sessions() and connect(), so a Durable Object that wakes up later
 * doesn't spend the "1 new browser every 20 s" allowance. close() only disconnects; the
 * browser itself stays up for the next run.
 */
export function createBrowserShooter(binding: Fetcher): Shooter {
  let browser: Browser | null = null;

  async function acquire(): Promise<Browser> {
    if (browser?.connected) return browser;
    browser = null;
    for (const session of await puppeteer.sessions(binding)) {
      if (session.connectionId) continue; // someone else is connected to it
      try {
        browser = await puppeteer.connect(binding, session.sessionId);
        return browser;
      } catch {
        // it closed since it was listed; try the next one
      }
    }
    browser = await puppeteer.launch(binding, { keep_alive: SHOTS.keepAliveMs });
    return browser;
  }

  async function disconnect(): Promise<void> {
    const b = browser;
    browser = null;
    await b?.disconnect().catch(() => {});
  }

  return {
    async shoot(url) {
      try {
        const b = await acquire();
        const page = await b.newPage();
        try {
          await page.setViewport({ width: SHOTS.viewportW, height: SHOTS.viewportH });
          try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: SHOTS.maxWaitMs });
          } catch (err) {
            // A page that never goes quiet (analytics, polling) is still worth a picture.
            if (!(err instanceof Error && err.name === 'TimeoutError')) throw err;
          }
          const bytes: Uint8Array = await page.screenshot({ type: 'jpeg', quality: SHOTS.jpegQuality });
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        } finally {
          await page.close().catch(() => {});
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The session may be gone; the next call starts from sessions() again.
        await disconnect();
        if (DAILY_LIMIT_RE.test(message)) throw new DailyLimitError(message);
        throw err;
      }
    },
    close: disconnect,
  };
}
```


- [ ] **Step 12: Run it and confirm it passes**

Run: `npm run test:unit -w worker -- shots`

Expected: PASS, `Tests  38 passed (38)`.


- [ ] **Step 13: Commit (orchestrator)**

```bash
git add worker/src/shots.ts worker/test/unit/shots.test.ts
git commit -m "feat(worker): screenshot queue (X6)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

