# End-to-end tests, CI and launch

These tasks build everything around the app that isn't app code: the GitHub Pages workflow (E2), the README, the owner's deploy runbook and the load-test script (E3), the Playwright end-to-end suite (E1), and the two final checks that run against the finished repo (V1, the orchestrator's manual browser check, and V2, one review agent). The last section, "Deploy (owner-run)", lists the steps only the owner can do.

E2 and E3 are Wave 5 (T0, plain copying of finished text and code). E1 is Wave 6 (T3), because it needs the whole app (W4 and U9). V1 and V2 are Wave 7.

**Third-party APIs used** (all checked on 2026-09-29):

- **`@playwright/test` 1.63.0**, https://playwright.dev/docs/test-webserver and https://playwright.dev/docs/test-configuration. Confirmed by running experiments:
  - `webServer` takes an **array**; each entry has `command`, `port` (or `url`), `cwd`, `env`, `timeout`, `reuseExistingServer`.
  - **Use `port`, not `url`.** With `url`, Playwright only treats 2xx, 3xx and 400–403 as "ready". The Worker answers `/` with 404, so a `url` check times out ("Timed out waiting ... from config.webServer"). `port` only waits for a TCP connection and worked against a server that returns 404.
  - A relative `webServer.cwd` resolves against the **config file's directory**, so `cwd: '..'` runs the command in the repo root.
  - `import.meta.url` and `__dirname` each fail in one of the two module modes of `e2e/package.json`. Use `test.info().project.testDir` to locate fixtures; it works in both modes.
  - `test.info()`, `test.skip(condition, reason)`, the `tag` test option, `context.addInitScript`, `page.mouse.wheel(dx, dy)` (wheel event at the current mouse position), `page.frameLocator()` and `expect.poll()` are all in 1.63.
- **GitHub Actions**, current majors (checked on each repository's page):
  - `actions/checkout@v7` (https://github.com/actions/checkout)
  - `actions/setup-node@v7`, with `node-version: 24` and `cache: npm` (https://github.com/actions/setup-node)
  - `actions/configure-pages@v6` (https://github.com/actions/configure-pages)
  - `actions/upload-pages-artifact@v5`, input `path` (https://github.com/actions/upload-pages-artifact). It leaves out hidden files by default; `web/dist` has none.
  - `actions/deploy-pages@v4`, which needs `pages: write` and `id-token: write` and a job with `environment: github-pages` (https://github.com/actions/deploy-pages).
- **Node 24 global `WebSocket`** (undici), for `scripts/loadtest.mjs`. Confirmed by running it against a local `ws` server: the constructor's second argument `{ headers: { Origin: '…' } }` is honored, so the load test can present an allowed origin to the Worker.
- **Cloudflare Browser Rendering REST `/screenshot`**, for the runbook's fallback (https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/):
  - `POST https://api.cloudflare.com/client/v4/accounts/<account id>/browser-run/screenshot`. Cloudflare's older docs call the path segment `browser-rendering`; use whichever the current docs page shows.
  - Auth: `Authorization: Bearer <token>`, with a custom API token that has the permission **Browser Rendering - Edit**.
  - Body: `url`, `viewport` (`width`, `height`), `screenshotOptions` (`type`, `quality`), `gotoOptions` (`waitUntil`, `timeout`). The response is the image bytes.
- **`wrangler dev`** runs the `browser` binding against a local headless Chrome by default (https://developers.cloudflare.com/browser-rendering/puppeteer/), so local screenshots need Chrome installed, not a Cloudflare login.

Notes for the executors of these tasks:

- The dev servers are started with `npm run dev -w worker` (its script already passes `--port 8787`; repeating the flag makes wrangler receive it twice) and `npm run dev -w web -- --port 5173 --strictPort`. `--strictPort` makes Vite fail instead of silently moving to another port, which would break `baseURL`.
- E1 needs `worker/.dev.vars` (copied from `worker/.dev.vars.example`, gitignored, teacher passcode `letmein`).
- The e2e tests are written against the finished app, so their first run is expected to pass. Step 2 of each E1 cycle still shows the failure that proves the test is real. If a test fails against the app, diagnose whether the selector or the app is wrong, and report `blocked` with the reason. Never edit app files from E1.

---

### Task E2: GitHub Pages workflow

**Wave:** 5 · **Tier:** T0 (haiku) · **Depends on:** F1

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Write the failing check**

The check reads the workflow and asserts every requirement. Run it from the repo root; it has no dependencies.

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
node -e '
const fs = require("fs");
let y;
try { y = fs.readFileSync(".github/workflows/pages.yml", "utf8"); } catch { console.error("FAIL: .github/workflows/pages.yml is missing"); process.exit(1); }
const checks = {
  "push to main": /push:\s*\n\s*branches: \[main\]/,
  "manual dispatch": /workflow_dispatch:/,
  "pages write": /pages: write/,
  "id-token write": /id-token: write/,
  "contents read": /contents: read/,
  "concurrency group": /concurrency:\s*\n\s*group: pages/,
  "checkout": /actions\/checkout@v7/,
  "node 24 with npm cache": /node-version: 24\s*\n\s*cache: npm/,
  "npm ci": /run: npm ci/,
  "web build": /run: npm run build -w web/,
  "base path": /BASE_PATH: \/class-board\//,
  "server url from variable": /VITE_SERVER_URL: \$\{\{ vars\.SERVER_URL \}\}/,
  "configure-pages": /actions\/configure-pages@v6/,
  "upload artifact from web/dist": /actions\/upload-pages-artifact@v5\s*\n\s*with:\s*\n\s*path: web\/dist/,
  "deploy-pages": /actions\/deploy-pages@v4/,
  "github-pages environment": /name: github-pages/,
};
const bad = Object.entries(checks).filter(([, re]) => !re.test(y)).map(([n]) => n);
if (/\t/.test(y)) bad.push("tab characters");
if (bad.length) { console.error("FAIL: " + bad.join(", ")); process.exit(1); }
console.log("pages.yml ok: " + Object.keys(checks).length + " checks");
'
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: `FAIL: .github/workflows/pages.yml is missing`, exit code 1.

- [ ] **Step 3: Create `.github/workflows/pages.yml`**

```yaml
name: Deploy site to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# One deployment at a time; a newer push waits instead of cancelling a deployment in progress.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      BASE_PATH: /class-board/
      VITE_SERVER_URL: ${{ vars.SERVER_URL }}
    steps:
      - name: Check the server URL is set
        run: |
          if [ -z "$VITE_SERVER_URL" ]; then
            echo "::error::Repository variable SERVER_URL is empty. Add it under Settings > Secrets and variables > Actions > Variables (docs/runbook.md, step 9)."
            exit 1
          fi
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build -w web
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: web/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

The workflow uses two jobs because `deploy-pages` must run in a job with the `github-pages` environment. The first step of `build` fails fast, with a message that names the fix, if the `SERVER_URL` variable was never set; otherwise the site would build and silently point at `http://localhost:8787`.

- [ ] **Step 4: Run the check and confirm it passes**

Run the same command as in Step 1.
Expected: `pages.yml ok: 16 checks`.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add .github/workflows/pages.yml
git commit -m "chore(ci): GitHub Pages deploy workflow (E2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task E3: README, runbook and load test

**Wave:** 5 · **Tier:** T0 (haiku) · **Depends on:** F1

**Files:**
- Create: `README.md`, `docs/runbook.md`, `scripts/loadtest.mjs`

The load test is the only code here. It has pure helpers (`parseArgs`, `wsUrl`, `budgetShare`) that the test below exercises without any network.

- [ ] **Step 1: Write the failing test for the load-test helpers**

Run from the repo root. Node 24 runs the inline module directly.

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
node --input-type=module -e '
import assert from "node:assert/strict";
const m = await import("./scripts/loadtest.mjs");
assert.deepEqual(m.parseArgs(["http://x"]), { server: "http://x", board: "loadtest", clients: 75, seconds: 60, hz: 5 });
assert.equal(m.parseArgs(["http://x", "b", "10", "5", "2"]).clients, 10);
assert.throws(() => m.parseArgs([]), /Usage/);
assert.throws(() => m.parseArgs(["http://x", "Bad Board"]), /board must match/);
assert.throws(() => m.parseArgs(["http://x", "b", "0"]), /clients must be/);
assert.equal(m.wsUrl("https://w.example.workers.dev/", "main"), "wss://w.example.workers.dev/parties/board/main");
assert.equal(m.wsUrl("http://localhost:8787", "main"), "ws://localhost:8787/parties/board/main");
const b = m.budgetShare(375);
assert.equal(b.perClass, 1_687_500);
assert.equal(Math.round(b.share * 1000), 844);
assert.equal(Math.round(b.minutesToPause), 80);
console.log("loadtest helpers ok");
'
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: an `ERR_MODULE_NOT_FOUND` error for `scripts/loadtest.mjs`, exit code 1.

- [ ] **Step 3: Create `scripts/loadtest.mjs`**

```js
#!/usr/bin/env node
// Load test for a deployed class-board Worker. No dependencies: uses Node 24's global WebSocket.
// Usage: node scripts/loadtest.mjs <server-url> [board=loadtest] [clients=75] [seconds=60] [hz=5]
// Set ORIGIN to change the Origin header (default https://jacobl-h.github.io, which the Worker allows).
import { pathToFileURL } from 'node:url';

export const DAILY_BUDGET = 2_000_000;
export const CLASS_MINUTES = 75;
const BOARD_W = 5232;
const BOARD_H = 2992;
const COLOR = '#D85A30';

export const USAGE =
  'Usage: node scripts/loadtest.mjs <server-url> [board=loadtest] [clients=75] [seconds=60] [hz=5]';

export function parseArgs(argv) {
  const [server, board = 'loadtest', clients = '75', seconds = '60', hz = '5'] = argv;
  if (!server) throw new Error(USAGE);
  const num = (name, value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}. ${USAGE}`);
    return n;
  };
  if (!/^[a-z0-9-]{1,40}$/.test(board)) throw new Error(`board must match [a-z0-9-]{1,40}. ${USAGE}`);
  return {
    server,
    board,
    clients: num('clients', clients, 1, 150),
    seconds: num('seconds', seconds, 1, 3600),
    hz: num('hz', hz, 0.1, 6),
  };
}

export function wsUrl(server, board) {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = `/parties/board/${board}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Projects the measured incoming rate onto a class-length session and onto the daily budget. */
export function budgetShare(incomingPerSecond, classMinutes = CLASS_MINUTES, budget = DAILY_BUDGET) {
  const perClass = incomingPerSecond * 60 * classMinutes;
  return {
    perClass,
    share: perClass / budget,
    minutesToPause: incomingPerSecond > 0 ? (budget * 0.9) / incomingPerSecond / 60 : Infinity,
  };
}

export function formatReport(r) {
  const b = budgetShare(r.sent / r.seconds);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const n = (x) => Math.round(x).toLocaleString('en-US');
  return [
    `clients: ${r.connected} connected of ${r.clients} requested, ${r.closedEarly} closed early`,
    `duration: ${r.seconds.toFixed(1)} s`,
    `sent: ${n(r.sent)} messages (${n(r.sent / r.seconds)}/s)`,
    `received: ${n(r.received)} messages (${n(r.received / r.seconds)}/s), of which ${n(r.cursorBatches)} cursor batches, ${n(r.errors)} errors`,
    `server rate changes seen: ${r.rateChanges}`,
    `A ${CLASS_MINUTES}-minute class at this rate sends ${n(b.perClass)} messages, ${pct(b.share)} of the ${n(DAILY_BUDGET)} daily budget.`,
    `Cursors would pause (90%) after ${Number.isFinite(b.minutesToPause) ? b.minutesToPause.toFixed(0) : 'never'} minutes.`,
    'This test moves every cursor nonstop, so real classes use less.',
  ].join('\n');
}

export function runLoadTest(opts, { origin = 'https://jacobl-h.github.io', log = console.log } = {}) {
  const url = wsUrl(opts.server, opts.board);
  const stats = { clients: opts.clients, connected: 0, closedEarly: 0, sent: 0, received: 0, cursorBatches: 0, errors: 0, rateChanges: 0, seconds: opts.seconds };
  const sockets = [];
  const timers = [];
  let finishing = false;

  return new Promise((resolve) => {
    const started = Date.now();
    const finish = () => {
      finishing = true;
      const seconds = (Date.now() - started) / 1000;
      timers.forEach(clearInterval);
      for (const s of sockets) if (s.readyState <= 1) s.close();
      setTimeout(() => resolve({ ...stats, seconds }), 500);
    };

    for (let i = 0; i < opts.clients; i++) {
      timers.push(setTimeout(() => connect(i), i * 20));
    }
    timers.push(setTimeout(finish, opts.seconds * 1000 + opts.clients * 20));

    function connect(i) {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      sockets.push(ws);
      let x = Math.floor(Math.random() * BOARD_W);
      let y = Math.floor(Math.random() * BOARD_H);
      let ticker = null;
      const send = (msg) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(msg));
        stats.sent++;
      };
      const startTicker = (hz) => {
        if (ticker) clearInterval(ticker);
        ticker = null;
        if (hz <= 0) return;
        ticker = setInterval(() => {
          x = Math.min(BOARD_W, Math.max(0, x + Math.round((Math.random() - 0.5) * 200)));
          y = Math.min(BOARD_H, Math.max(0, y + Math.round((Math.random() - 0.5) * 200)));
          send({ type: 'cursor', x, y });
        }, 1000 / hz);
        timers.push(ticker);
      };
      ws.onopen = () => {
        stats.connected++;
        send({ type: 'hello', clientId: crypto.randomUUID(), profile: { name: `Bot ${i + 1}`, color: COLOR, cursor: { kind: 'shape', shape: 'arrow' } } });
        startTicker(opts.hz);
      };
      ws.onmessage = (e) => {
        stats.received++;
        let m = null;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.type === 'cursors') stats.cursorBatches++;
        else if (m.type === 'error') { stats.errors++; if (stats.errors <= 3) log(`server error: ${m.code} ${m.message}`); }
        else if (m.type === 'rate') { stats.rateChanges++; startTicker(Math.min(opts.hz, m.hz)); }
      };
      ws.onerror = () => { if (!finishing) log(`client ${i + 1}: connection error`); };
      ws.onclose = () => {
        if (ticker) clearInterval(ticker);
        if (!finishing) stats.closedEarly++;
      };
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  console.log(`Connecting ${opts.clients} clients to board "${opts.board}" on ${opts.server} for ${opts.seconds} s at ${opts.hz} Hz`);
  runLoadTest(opts, { origin: process.env.ORIGIN ?? 'https://jacobl-h.github.io' }).then((r) => {
    console.log(formatReport(r));
    process.exit(0);
  });
}
```

Design notes:
- It sends `hello` first, as the protocol requires, then a `cursor` message every `1000 / hz` ms, as integers inside the board's bounds.
- It obeys the server's `rate` message the way a real browser does: `hz` 2 slows it down and `hz` 0 stops it. That makes the run show what happens at the 80% and 90% thresholds.
- The `Origin` header comes from the `ORIGIN` environment variable and defaults to `https://jacobl-h.github.io`, which the Worker allows. For a Worker you're running locally, `ORIGIN=http://localhost:5173` works too.
- It uses the board `loadtest` by default so the run never touches the class's real board.

- [ ] **Step 4: Run the helper test and confirm it passes**

Run the same command as in Step 1.
Expected: `loadtest helpers ok`.

- [ ] **Step 5: Check that running with no arguments prints the usage line**

```bash
node scripts/loadtest.mjs; echo "exit $?"
```

Expected: `Usage: node scripts/loadtest.mjs <server-url> [board=loadtest] [clients=75] [seconds=60] [hz=5]` and `exit 2`.

- [ ] **Step 6: Write the failing check for the documents**

```bash
node -e '
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { console.error("FAIL: " + p + " is missing"); process.exit(1); } };
const readme = read("README.md");
const runbook = read("docs/runbook.md");
const need = [
  ["README: architecture diagram", readme, /Durable Object/],
  ["README: npm install", readme, /npm install/],
  ["README: .dev.vars copy", readme, /cp worker\/\.dev\.vars\.example worker\/\.dev\.vars/],
  ["README: dev:worker", readme, /npm run dev:worker/],
  ["README: dev:web", readme, /npm run dev:web/],
  ["README: e2e", readme, /npm run e2e/],
  ["README: runbook link", readme, /docs\/runbook\.md/],
  ["README: teacher guide", readme, /## Teacher quick guide/],
  ["README: student guide", readme, /## Student quick guide/],
  ["runbook: cloudflare account", runbook, /Cloudflare account/],
  ["runbook: wrangler login", runbook, /wrangler login/],
  ["runbook: teacher secret", runbook, /wrangler secret put TEACHER_CODE/],
  ["runbook: deploy", runbook, /npm run deploy -w worker/],
  ["runbook: PUBLIC_URL", runbook, /PUBLIC_URL/],
  ["runbook: spike 2", runbook, /Spike 2/],
  ["runbook: REST fallback", runbook, /createRestShooter/],
  ["runbook: repo", runbook, /Jacobl-h\/class-board/],
  ["runbook: pages source", runbook, /Source: GitHub Actions/],
  ["runbook: SERVER_URL", runbook, /SERVER_URL/],
  ["runbook: origins", runbook, /ALLOWED_ORIGINS/],
  ["runbook: school network", runbook, /school network/],
  ["runbook: DNS fallback", runbook, /board-api\.jacoblehrer\.com/],
  ["runbook: allowed domains", runbook, /Allowed domains/],
  ["runbook: daily limits", runbook, /midnight UTC/],
];
const bad = need.filter(([, text, re]) => !re.test(text)).map(([n]) => n);
if (bad.length) { console.error("FAIL: " + bad.join(", ")); process.exit(1); }
console.log("docs ok: " + need.length + " checks");
'
```

- [ ] **Step 7: Run it and confirm it fails**

Expected: `FAIL: README.md is missing` (and exit code 1).

- [ ] **Step 8: Create `README.md`**

`````markdown
# class-board

A shared, Miro-style board for one class of up to 75 people. Students post a link or an HTML
file (for example a Claude artifact) into one of 80 tiles, 8 rows by 10 columns, and write
their name above it. A tile shows the page running live when the site allows embedding, and a
screenshot card when it doesn't. Everyone sees everyone else's cursor in real time. Any tile
can be opened in a new tab, or zoomed into until it fills the page (focus mode).

It costs nothing to run: the site is static files on GitHub Pages, and realtime sync, storage
and screenshots run on a Cloudflare Worker with one Durable Object per board, on Cloudflare's
free plan.

- Live site (after deploy): https://jacobl-h.github.io/class-board/
- Other boards: add `?board=<name>` to the address (letters, digits and dashes). The plain
  address opens the board `main`.
- Design: [docs/superpowers/specs/2026-09-29-class-board-design.md](docs/superpowers/specs/2026-09-29-class-board-design.md)

## Architecture

```
Browser (GitHub Pages, web/)
   │  WebSocket: cursors, tiles, presence          ┌──────────────────────────────┐
   ├──────────────────────────────────────────────►│ Worker (worker/src/index.ts) │
   │  HTTP POST: upload an HTML file               │  origin check, CORS, routing │
   │  HTTP GET: uploaded files, screenshots        └──────────────┬───────────────┘
   └──────────────────────────────────────────────────────────────┤
                                                                  ▼
                                              Board Durable Object (one per board name)
                                               ├─ SQLite: versions, files, screenshots, meta
                                               ├─ outbound fetch: is this link embeddable?
                                               └─ Browser Rendering: screenshots
```

| Folder | What it holds |
|---|---|
| `shared/` | Message types, validators, slot names, URL rules, pixel-art codec, limits |
| `worker/` | The Worker and the Board Durable Object (PartyServer), plus small modules for limits, teacher login, uploads, link checks and screenshots |
| `web/` | The static site: Vite and TypeScript, no UI framework |
| `e2e/` | Playwright tests: two browsers against local `wrangler dev` and `vite` |
| `scripts/` | `loadtest.mjs`, a 75-client load test |
| `docs/` | The design, the implementation plan and the deploy runbook |

## Run it locally

You need Node 24 and npm 11.

```bash
npm install
cp worker/.dev.vars.example worker/.dev.vars   # local teacher passcode: letmein
npm run dev:worker    # the Worker on http://localhost:8787
npm run dev:web       # the site on http://localhost:5173 (in a second terminal)
```

Open http://localhost:5173. Open it in a second window (or a private window) to see two
people on one board. Add `?board=test` to work on a separate board.

Local links to `localhost` are rejected on purpose. Post a public link, or upload an HTML file.

## Tests

```bash
npm run typecheck   # every package
npm test            # unit tests: shared, worker (inside workerd) and web
npm run e2e         # Playwright, Chromium; starts the Worker and the site itself
```

- One package: `npm test -w shared`, `npm test -w web -- camera`. Worker tests are split into
  `npm run test:unit -w worker` (pure modules) and `npm run test:do -w worker` (the Durable Object).
- First e2e run: `npx playwright install chromium`. The teacher test uses the passcode in
  `worker/.dev.vars` (`letmein` by default; set `E2E_TEACHER_CODE` if you changed it).
- `E2E_ALL_BROWSERS=1` also runs the focus-mode test in Firefox and WebKit (install them with
  `npx playwright install firefox webkit`). `E2E_NETWORK=1` also runs the test that posts a real link.
- Load test against a deployed Worker: `node scripts/loadtest.mjs https://<worker>.workers.dev loadtest 75 60 5`
  (server, board, clients, seconds, messages per second). It prints how much of the day's
  free message budget a class would use.

## Deploy

Deploying needs your own Cloudflare and GitHub accounts, so it is a manual, one-time process:
create the Cloudflare account, log in with `wrangler`, set the teacher passcode, deploy the
Worker, then create the GitHub repository and turn on Pages. Follow
[docs/runbook.md](docs/runbook.md), which also has the pre-class checklist and the free-plan
daily limits.

## Teacher quick guide

1. Click **N here** in the top bar to open the people list, then **Teacher** at the bottom.
2. Enter the passcode (the Worker secret `TEACHER_CODE`). It is remembered for this browser
   tab only.
3. **Lock** the board so students can't add, replace, rename or restore tiles. Students see a
   banner, "The board is locked." **Unlock** to let them edit again.
4. On any tile, **Clear** empties it. Nothing is lost: the tile's History keeps every version,
   and Restore brings one back.
5. In the people list, **Reset cursor** gives a person the plain arrow, for example if someone
   drew something inappropriate.
6. Share the link only with your class; anyone with the link can join.

## Student quick guide

- **Add something:** click an empty tile. Paste a link, or choose the HTML tab to upload an
  `.html` file or paste HTML. Your name is filled in above the tile; change it if you like, then
  press **Post**.
- **Claude artifacts:** upload the artifact's HTML file, or publish it and use the embed link.
  In Claude choose Publish → Get embed code, and add `jacobl-h.github.io` under **Allowed domains**.
  Newer artifacts (the Share button) can't be shown on the board.
- **Look around:** scroll to zoom, drag to move, `0` fits the whole board, `+` and `-` zoom.
  Double-click a tile to zoom to it. Keep zooming in and the tile fills the page; press
  **← Back** (or the browser's back button) to return.
- **Use a live page:** click it once. Click outside it, or press Esc, to go back to moving the board.
- **Replace or undo:** **Replace** on any tile swaps its content after a warning. **History**
  lists every earlier version, and **Restore** brings one back.
- **Your cursor:** click **Your cursor** in the top bar to change your name, color and pointer,
  or to draw your own 16 by 16 pixel pointer.
`````

- [ ] **Step 9: Create `docs/runbook.md`**

`````markdown
# Runbook: deploying class-board

This is the owner's step-by-step guide. Everything here is free: a Cloudflare account on the
free plan (no card), and a public GitHub repository with GitHub Pages. Plan on about 30
minutes, plus a wait while the first screenshot renders.

You need: Node 24 and npm 11 installed, and this repository on your computer with
dependencies installed (`npm install` in the repo root).

## 1. Create a Cloudflare account

Go to https://dash.cloudflare.com/sign-up and sign up with your email. You don't need to add a
card or a domain. Verify your email address.

## 2. Log in with wrangler

```bash
cd worker
npx wrangler login
```

A browser tab opens. Click **Allow**. The terminal prints "Successfully logged in".

## 3. Set the teacher passcode

```bash
npx wrangler secret put TEACHER_CODE
```

Type a passcode only you know when prompted (nothing is shown as you type). If asked to create
a new Worker for the secret, answer yes. Students never see this value. Pick something you can
type quickly in front of a class.

## 4. Deploy the Worker

```bash
cd ..                        # back to the repo root
npm run deploy -w worker
```

The last lines print your Worker's address, like
`https://class-board.<your-subdomain>.workers.dev`. Copy it.

## 5. Tell the Worker its own address

Open `worker/wrangler.jsonc`, find the variable `PUBLIC_URL` under `vars`, and set it to the
address you just copied (no trailing slash):

```jsonc
"PUBLIC_URL": "https://class-board.<your-subdomain>.workers.dev"
```

Deploy again:

```bash
npm run deploy -w worker
```

The Worker uses `PUBLIC_URL` to take screenshots of uploaded HTML files, so screenshots of
uploads won't work until this is set.

## 6. Spike 2 check: screenshots from the Durable Object

This is the one thing the tests can't prove, because it needs your Cloudflare account. Browser
Rendering is called from inside the board's Durable Object, and Cloudflare doesn't document
that for the free plan.

1. Open the deployed board. Until step 9 the site isn't on GitHub Pages yet, so run it locally
   against the deployed Worker: in `web/`, start it with
   `VITE_SERVER_URL=https://class-board.<your-subdomain>.workers.dev npm run dev` (from the repo
   root: `VITE_SERVER_URL=... npm run dev -w web`), and open http://localhost:5173/?board=spike.
   The deployed Worker allows the origin `http://localhost:5173`, because that's in `ALLOWED_ORIGINS`.
2. Click an empty tile and upload any small `.html` file (or paste `<title>Spike</title><h1>Hello</h1>`).
3. Wait about a minute. The tile's card should get a screenshot image, and the History
   dialog should show a thumbnail.

To watch what happens on the server, run `cd worker && npx wrangler tail` in a second
terminal while you upload.

**If a screenshot appears:** Spike 2 passes. Nothing to change.

**If no screenshot appears within a few minutes** and `wrangler tail` shows an error from the
browser call (for example that the binding isn't available, or an authorization or
"not supported" error), switch to Browser Rendering's REST endpoint, which is called from the Worker
with an API token:

1. Create the token: Cloudflare dashboard → My Profile → API Tokens → Create Token → Create
   Custom Token. Give it the permission **Account → Browser Rendering → Edit**, for your
   account. Copy the token. Also copy your **Account ID** (dashboard home, right side).
2. Store them:

   ```bash
   cd worker
   npx wrangler secret put CF_API_TOKEN     # paste the token
   ```

   In `worker/wrangler.jsonc`, add `"CF_ACCOUNT_ID": "<your account id>"` under `vars`.
3. In `worker/src/env.ts`, add two optional fields to `Env`:

   ```ts
   CF_ACCOUNT_ID?: string;
   CF_API_TOKEN?: string;
   ```
4. In `worker/src/shots.ts`, add this next to `createBrowserShooter` (it uses the file's
   existing `Shooter` and `DailyLimitError`):

   ```ts
   /** Screenshots through Browser Rendering's REST endpoint instead of the Durable Object binding. */
   export function createRestShooter(accountId: string, token: string, fetchImpl: typeof fetch = fetch): Shooter {
     let lastAt = 0;
     return {
       async shoot(url: string): Promise<ArrayBuffer> {
         // The free plan allows about one REST request every 10 seconds.
         const wait = lastAt + 10_000 - Date.now();
         if (wait > 0) await new Promise((r) => setTimeout(r, wait));
         lastAt = Date.now();
         const res = await fetchImpl(
           `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/screenshot`,
           {
             method: 'POST',
             headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
             body: JSON.stringify({
               url,
               viewport: { width: 1280, height: 800 },
               screenshotOptions: { type: 'jpeg', quality: 70 },
               gotoOptions: { waitUntil: 'networkidle2', timeout: 15000 },
             }),
           },
         );
         if (res.status === 429) throw new DailyLimitError('Browser Rendering daily limit reached');
         if (!res.ok) throw new Error(`Screenshot request failed: HTTP ${res.status}`);
         return res.arrayBuffer();
       },
       async close() {},
     };
   }
   ```

   Cloudflare has been renaming these docs from "Browser Rendering" to "Browser Run". If the
   request returns 404, use the URL shown on
   https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/ instead
   (the path segment `browser-run` may read `browser-rendering`).
5. Find where the Durable Object builds its shooter with
   `grep -rn createBrowserShooter worker/src`. Replace the call so it uses the REST shooter when the
   token is present:

   ```ts
   this.env.CF_API_TOKEN && this.env.CF_ACCOUNT_ID
     ? createRestShooter(this.env.CF_ACCOUNT_ID, this.env.CF_API_TOKEN)
     : createBrowserShooter(this.env.BROWSER!)
   ```
6. Deploy again (`npm run deploy -w worker`) and repeat the check.

A screenshot that never appears never breaks the board. The tile keeps working, and its card
shows the title, icon and domain instead.

## 7. Create the GitHub repository and push

Create a **public** repository named `class-board` under the account `Jacobl-h`
(https://github.com/new). Don't add a README or license; the repository already has them. Then,
from the repo root:

```bash
git remote add origin https://github.com/Jacobl-h/class-board.git
git push -u origin main
```

(The build branch is `build/v1`. Merge it into `main` first, or push it and open a pull
request. The Pages workflow runs on pushes to `main`.)

## 8. Turn on GitHub Pages

In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## 9. Point the site at your Worker

In the repository: **Settings → Secrets and variables → Actions → Variables → New repository
variable**. Name: `SERVER_URL`. Value: your Worker address from step 4 (for example
`https://class-board.<your-subdomain>.workers.dev`).

Then run the workflow again: **Actions → Deploy site to GitHub Pages → Run workflow**. When it
finishes (a minute or two), the board is at https://jacobl-h.github.io/class-board/.

If the workflow fails at "Check the server URL is set", the variable is missing or empty.

## 10. Custom domain (only if you use one)

The Worker only accepts connections and uploads from the origins in `ALLOWED_ORIGINS`, and it
decides whether a site allows framing by comparing with `BOARD_ORIGIN`. If the board's page is
served from a different address than `https://jacobl-h.github.io`, edit both in
`worker/wrangler.jsonc`:

```jsonc
"ALLOWED_ORIGINS": "https://board.example.com,http://localhost:5173",
"BOARD_ORIGIN": "https://board.example.com"
```

and deploy again. Students would then add that host, not `jacobl-h.github.io`, to their
Claude artifact's Allowed domains, and the help dialog shows the host the page is served from.

## Pre-class checklist

Do this the day before, from the classroom if you can:

- [ ] Open the board on the school network, on a student-type laptop, and confirm it connects
  (the top bar shows people, and there's no "Can't reach the board server" banner).
- [ ] Check that `*.workers.dev` is reachable from that network. Some school filters block it. Open
  `https://class-board.<your-subdomain>.workers.dev/boards/main/files/00000000000000000000000000000000`
  in a browser: a plain "not found" page means the network reaches the Worker; a filter or
  block page means it doesn't.
- [ ] **If `*.workers.dev` is blocked:** move `jacoblehrer.com`'s DNS from GoDaddy to
  Cloudflare, carrying the GitHub Pages records over unchanged, and give the Worker a custom
  domain such as `board-api.jacoblehrer.com`. Concretely:
  1. In Cloudflare, add the site `jacoblehrer.com` (free plan). It imports the existing records;
     compare them against GoDaddy's list and make sure the GitHub Pages records (the four `A`
     records for `@`, and the `CNAME` for `www`) are all there.
  2. At GoDaddy, change the domain's nameservers to the two Cloudflare gives you. Wait until
     Cloudflare says the site is active. The portfolio keeps working during this.
  3. In `worker/wrangler.jsonc`, add `"routes": [{ "pattern": "board-api.jacoblehrer.com", "custom_domain": true }]`,
     set `PUBLIC_URL` to `https://board-api.jacoblehrer.com`, and deploy.
  4. Change the repository variable `SERVER_URL` to `https://board-api.jacoblehrer.com` and re-run
     the Pages workflow.
- [ ] Run the load test against the deployed Worker, on its own board, so it doesn't touch the
  class's board:
  `node scripts/loadtest.mjs https://class-board.<your-subdomain>.workers.dev loadtest 75 60 5`.
  It prints how much of the day's 2,000,000-message budget a 75-minute class would use. Expect
  about a third of it with real students, and more with this test, because it moves every
  cursor nonstop.
- [ ] Open the board yourself, log in as teacher, and test Lock and Unlock once.
- [ ] Try one Claude artifact both ways: uploading its HTML file, and posting its published link
  after adding the board's host to Allowed domains.

## Student instructions

Put this on the whiteboard or in the class chat:

1. Open https://jacobl-h.github.io/class-board/ and type your name in the "Your cursor" panel.
2. Click an empty tile to add something.
3. **Easiest for a Claude artifact:** in Claude, download or copy the artifact's HTML, then choose
   **HTML** in the dialog and upload the file (or paste the HTML). Nothing else to set up.
4. **To post its link instead:** in Claude, **Publish → Get embed code → Allowed domains**, add
   `jacobl-h.github.io`, then paste the published link (the one that looks like
   `claude.ai/public/artifacts/…`). Newer artifacts made with the Share button can't be shown;
   upload their HTML file instead.

## Daily limits

The board runs entirely on Cloudflare's free plan. Going over a limit never costs money: the
feature just stops working until the limits reset at **00:00 UTC** (in the evening in the US:
8 pm Eastern in summer, 7 pm in winter). What students see:

| Limit (free plan) | What students see when it's reached |
|---|---|
| About 2,000,000 incoming realtime messages a day (cursor movement is nearly all of it). At 80%, cursors slow to 2 updates a second; at 90% they pause. | A notice: "Cursors are paused until midnight UTC to stay within the free limit." Posting, replacing and restoring keep working. |
| 100,000 Durable Object requests a day (20 incoming messages count as 1) and 100,000 Worker requests a day | Connections are refused. The page says: "The board has hit today's free limit. It'll be back at midnight UTC." |
| Browser Rendering: 10 minutes of browser time a day | New tiles get a card with the title, icon and domain instead of a screenshot. Queued screenshots are retried after 00:05 UTC. YouTube links use YouTube's own thumbnail and cost nothing. |
| Durable Object storage writes (100,000 rows a day) | Posts and edits fail with an error in the dialog. A normal class uses a tiny fraction. |

A normal 75-minute class uses about a third of the message budget. If cursors pause partway
through a class, cursors return at midnight UTC. Opening a second board doesn't help, because the
budget is per Worker, not per board. To reduce the load, ask students to keep their mouse still
when they aren't using the board.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "Can't reach the board server" | The Worker address is wrong or blocked. Check the `SERVER_URL` variable and the pre-class network check. |
| Page loads, nothing connects, the Worker log says origin | The page's address isn't in `ALLOWED_ORIGINS`. See step 10. |
| Teacher login says the code is wrong | Re-run `npx wrangler secret put TEACHER_CODE` in `worker/`, then deploy. Five wrong tries lock the login for 10 minutes. |
| A live tile is blank | The site allows framing but shows nothing for embedded visitors. Use the tile's "Open in new tab" button. |
| No screenshots | See step 6 (Spike 2) and run `npx wrangler tail` in `worker/` while a tile is posted. |
`````

- [ ] **Step 10: Run the document check and confirm it passes**

Run the same command as in Step 6.
Expected: `docs ok: 24 checks`.

- [ ] **Step 11: Commit (orchestrator)**

```bash
git add README.md docs/runbook.md scripts/loadtest.mjs
git commit -m "docs(launch): README, owner runbook and load-test script (E3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task E1: End-to-end tests

**Wave:** 6 · **Tier:** T3 (opus, medium) · **Depends on:** F1, W4, U9, E3

**Files:**
- Create: `e2e/playwright.config.ts`
- Create: `e2e/fixtures/helpers.ts`, `e2e/fixtures/upload-page.html`
- Create (tests): `e2e/tests/first-visit.spec.ts`, `e2e/tests/cursors.spec.ts`, `e2e/tests/upload.spec.ts`, `e2e/tests/replace-restore.spec.ts`, `e2e/tests/conflict.spec.ts`, `e2e/tests/teacher.spec.ts`, `e2e/tests/focus.spec.ts`, `e2e/tests/link.spec.ts`

Run one spec with (from the repo root):
`npx playwright test --config e2e/playwright.config.ts <name>` (for example `first-visit`).

What the suite does and doesn't do:
- Every test uses its own board name (`?board=e2e-<random>`), so no cleanup is needed and tests can run in parallel.
- Except the first-visit test, every test seeds a profile into `localStorage` with `context.addInitScript`, so the "Your cursor" panel doesn't open.
- Local links can't be tested: `planLink` rejects localhost by design. Link behavior is covered by the `@network` test, which is skipped unless `E2E_NETWORK` is set.
- A tile's live iframe only exists at 240 px screen width or more, so tests call `__classBoard.camera.fitSlot(slot)` before looking inside a tile.

- [ ] **Step 1: Prepare the environment (one time)**

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
test -f worker/.dev.vars || cp worker/.dev.vars.example worker/.dev.vars
grep -q "TEACHER_CODE" worker/.dev.vars && echo ".dev.vars ok"
npx playwright install chromium
```

Expected: `.dev.vars ok`, then Playwright downloads Chromium (or says it is already installed). To also run the focus test in Firefox and WebKit, run `npx playwright install firefox webkit` and set `E2E_ALL_BROWSERS=1` when running the suite.

- [ ] **Step 2: Write the failing check: no tests exist yet**

```bash
npx playwright test --config e2e/playwright.config.ts --list
```

Expected: FAIL with `Error: Cannot find ... playwright.config.ts` (the config doesn't exist yet), exit code 1.

- [ ] **Step 3: Create `e2e/playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

// Firefox and WebKit only run the focus-mode test (the Popover API is verified in Chromium only),
// and only when their browsers are installed: npx playwright install firefox webkit
const otherBrowsers = process.env.E2E_ALL_BROWSERS
  ? [
      { name: 'firefox', testMatch: /focus\.spec\.ts/, use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit', testMatch: /focus\.spec\.ts/, use: { ...devices['Desktop Safari'] } },
    ]
  : [];

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, ...otherBrowsers],
  webServer: [
    {
      // The Worker answers "/" with 404, so wait for the port; a `url` check would time out.
      command: 'npm run dev -w worker', // the script already passes --port 8787
      port: 8787,
      cwd: '..',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -w web -- --port 5173 --strictPort',
      port: 5173,
      cwd: '..',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

Why it looks this way:
- `port`, not `url`, for both servers (see the header: the Worker answers `/` with 404).
- Firefox and WebKit run only `focus.spec.ts`, only when `E2E_ALL_BROWSERS` is set, because those browsers may not be installed.
- `reuseExistingServer: !process.env.CI` lets you keep `npm run dev` running in other terminals.

- [ ] **Step 4: Confirm the config loads and lists no tests**

```bash
npx playwright test --config e2e/playwright.config.ts --list
```

Expected: `Error: No tests found` (exit code 1). The config parses; there are no specs yet. The list command doesn't start the servers.

- [ ] **Step 5: Create the shared helpers `e2e/fixtures/helpers.ts`**

```ts
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from '@playwright/test';
import path from 'node:path';

/** Slot index of tile C4 (row C = 2, column 4 = 3; 2 * 10 + 3). */
export const C4 = 23;
export const PROFILE_KEY = 'classBoard.profile';
export const TEACHER_CODE = process.env.E2E_TEACHER_CODE ?? 'letmein';

/** The dev-only debug handle from master plan section 5.4, reduced to what the tests use. */
interface DebugHandle {
  camera: { fitSlot(slot: number): void; fitBoard(): void };
  state: { ready(): boolean; you(): string | null };
  focus: { current(): number | null };
}
type WithHandle = { __classBoard?: DebugHandle };

/** A board name nobody else uses, so tests never share state and need no cleanup. */
export function newBoardName(): string {
  return `e2e-${Math.random().toString(36).slice(2, 10)}`;
}

/** Absolute path of a file in e2e/fixtures (works whatever module mode e2e/package.json uses). */
export function fixturePath(name: string): string {
  return path.resolve(test.info().project.testDir, '../fixtures', name);
}

/** Puts a saved profile in localStorage before the page loads, so the "Your cursor" panel stays closed. */
export async function seedProfile(context: BrowserContext, name: string, color = '#378ADD'): Promise<void> {
  const profile = JSON.stringify({ name, color, cursor: { kind: 'shape', shape: 'arrow' } });
  await context.addInitScript(
    ([key, value]: [string, string]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      } catch {
        // Sandboxed frames can't touch localStorage; the profile only matters for the top page.
      }
    },
    [PROFILE_KEY, profile] as [string, string],
  );
}

/** Opens the board and, unless told not to, waits for the first snapshot to render all 80 tiles. */
export async function openBoard(page: Page, board: string, opts: { hash?: string; ready?: boolean } = {}): Promise<void> {
  await page.goto(`/?board=${board}${opts.hash ?? ''}`);
  if (opts.ready === false) return;
  await page.waitForFunction(() => (window as unknown as WithHandle).__classBoard?.state.ready() === true);
  await expect(page.locator('#tiles .tile')).toHaveCount(80);
}

/** A new browser context with a seeded profile, already on the board. */
export async function joinBoard(
  browser: Browser,
  board: string,
  name: string,
  color?: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await seedProfile(context, name, color);
  const page = await context.newPage();
  await openBoard(page, board);
  return { context, page };
}

export function tileOf(page: Page, slot: number): Locator {
  return page.locator(`.tile[data-slot="${slot}"]`);
}

/** This tab's connection id, which is the `data-person` of its cursor on other people's screens. */
export function myId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as WithHandle).__classBoard!.state.you());
}

export async function zoomToSlot(page: Page, slot: number): Promise<void> {
  await page.evaluate((s) => (window as unknown as WithHandle).__classBoard!.camera.fitSlot(s), slot);
}

export async function fitBoard(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as WithHandle).__classBoard!.camera.fitBoard());
}

export function focusedSlot(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as WithHandle).__classBoard!.focus.current());
}

/** Moves the mouse in a straight line, slowly enough that the 5 Hz cursor sender sees several points. */
export async function sweepMouse(page: Page, x0: number, y0: number, x1: number, y1: number, steps = 25): Promise<void> {
  await page.mouse.move(x0, y0);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(40);
  }
}

/** Zooms to the tile and opens the post dialog from its Add (empty tile) or Replace (filled tile) button. */
export async function openPostDialog(page: Page, slot: number, mode: 'add' | 'replace'): Promise<Locator> {
  await zoomToSlot(page, slot);
  const tile = tileOf(page, slot);
  if (mode === 'replace') await tile.hover();
  await tile.locator(`[data-action="${mode}"]`).click();
  const dialog = page.locator('.modal[data-dialog="post"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fills the HTML tab with pasted HTML and presses Post. */
export async function submitHtmlText(dialog: Locator, html: string): Promise<void> {
  await dialog.locator('[data-tab="html"]').click();
  await dialog.locator('textarea[name="html"]').fill(html);
  await dialog.locator('[data-action="submit"]').click();
}

/** Chooses a file on the HTML tab and presses Post. */
export async function submitHtmlFile(dialog: Locator, file: string): Promise<void> {
  await dialog.locator('[data-tab="html"]').click();
  await dialog.locator('input[name="file"]').setInputFiles(file);
  await dialog.locator('[data-action="submit"]').click();
}

/** Uploads a fixture file into an empty tile and waits until the tile shows it as an HTML tile. */
export async function postHtmlFile(page: Page, slot: number, name = 'upload-page.html'): Promise<void> {
  const dialog = await openPostDialog(page, slot, 'add');
  await submitHtmlFile(dialog, fixturePath(name));
  await expect(dialog).toBeHidden();
  await expect(tileOf(page, slot)).toHaveClass(/is-html/);
}

/** The page running inside a tile's live iframe. */
export function liveFrame(page: Page, slot: number): FrameLocator {
  return page.frameLocator(`.tile[data-slot="${slot}"] iframe`);
}
```

- [ ] **Step 6: Create the upload fixture `e2e/fixtures/upload-page.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Fixture page</title>
  </head>
  <body>
    <p id="ran">not run</p>
    <p id="result">pending</p>
    <script>
      document.getElementById('ran').textContent = 'ran';
      var result;
      try {
        localStorage.setItem('x', '1');
        result = 'storage';
      } catch (e) {
        result = 'blocked';
      }
      document.title = result;
      document.getElementById('result').textContent = result;
    </script>
  </body>
</html>
```

The script sets the page title and body text to `storage` if `localStorage` works and `blocked` if it throws. An upload is served with a `sandbox` CSP, so it runs with an opaque origin and the access throws.

#### Cycle 1: first visit

- [ ] **Step 7: Write `e2e/tests/first-visit.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { joinBoard, newBoardName, openBoard } from '../fixtures/helpers';

test('first visit needs a name, and the saved name is shown to others', async ({ page, browser }) => {
  const board = newBoardName();
  // No seeded profile here: this is a first visit. The app doesn't connect until a name is saved.
  await openBoard(page, board, { ready: false });

  const panel = page.locator('.modal[data-dialog="profile"]');
  await expect(panel).toBeVisible();

  // It can't be dismissed without a name.
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await panel.locator('[data-action="save"]').click();
  await expect(panel).toBeVisible();

  // Saving a name closes it.
  await panel.locator('input[name="name"]').fill('Ana');
  await panel.locator('[data-action="save"]').click();
  await expect(panel).toBeHidden();

  // Another student on the same board sees Ana in the people list.
  const ben = await joinBoard(browser, board, 'Ben');
  await ben.page.locator('#topbar [data-action="people"]').click();
  await expect(ben.page.locator('.people-panel .person', { hasText: 'Ana' })).toHaveCount(1);
  await expect(ben.page.locator('[data-role="people-count"]')).toContainText('2');

  // The name is remembered: after a reload the panel stays closed.
  await page.reload();
  await expect(page.locator('#tiles .tile')).toHaveCount(80);
  await expect(page.locator('.modal[data-dialog="profile"]')).toHaveCount(0);

  await ben.context.close();
});
```

- [ ] **Step 8: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts first-visit
```

Expected: the servers start (this takes up to a minute the first time), then `1 passed`.

Check that the test is real: temporarily change `'Ana'` to `''` in the `fill` call, and confirm it fails at the `toBeHidden` assertion because the panel refuses an empty name. Then put `'Ana'` back.

#### Cycle 2: cursor sync

- [ ] **Step 9: Write `e2e/tests/cursors.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { joinBoard, myId, newBoardName, sweepMouse } from '../fixtures/helpers';

test('a cursor moved in one window appears and follows in another', async ({ browser }) => {
  const board = newBoardName();
  const a = await joinBoard(browser, board, 'Ana');
  const b = await joinBoard(browser, board, 'Ben', '#D85A30');

  const aId = await myId(a.page);
  expect(aId).toBeTruthy();
  const cursor = b.page.locator(`#cursor-layer .cursor[data-person="${aId}"]`);

  const box = (await a.page.locator('#viewport').boundingBox())!;
  const y = box.y + box.height * 0.5;
  const left = box.x + box.width * 0.2;
  const right = box.x + box.width * 0.8;

  // Ana moves over the left side of the board; Ben's screen shows her cursor with her name.
  await sweepMouse(a.page, left, y - 40, left + 30, y);
  await expect(cursor).toBeVisible();
  await expect(cursor.locator('.cursor-tag')).toContainText('Ana');

  // Let the smoothing (about 200 ms behind real time) settle, then note where it is.
  await a.page.waitForTimeout(600);
  const leftX = (await cursor.boundingBox())!.x;

  // Ana moves to the right side; the cursor on Ben's screen follows.
  await sweepMouse(a.page, left + 30, y, right, y);
  await expect.poll(async () => (await cursor.boundingBox())?.x ?? 0).toBeGreaterThan(leftX + 200);

  await a.context.close();
  await b.context.close();
});
```

- [ ] **Step 10: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts cursors
```

Expected: `1 passed`.

Check that the test is real: change `toBeGreaterThan(leftX + 200)` to `toBeGreaterThan(leftX + 5000)` and confirm the failure message shows a received value near the viewport's right side. Then revert.

#### Cycle 3: HTML upload

- [ ] **Step 11: Write `e2e/tests/upload.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { C4, fitBoard, liveFrame, newBoardName, openBoard, postHtmlFile, seedProfile, tileOf, zoomToSlot } from '../fixtures/helpers';

test('an uploaded HTML page runs live once zoomed in, in a sandbox without storage', async ({ page }) => {
  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  await postHtmlFile(page, C4);
  const tile = tileOf(page, C4);
  const iframe = tile.locator('iframe');

  // Zoomed out, the tile is narrower than 240 px on screen, so no iframe is mounted
  // (a tile stays live for 2 s after it stops qualifying, so this waits for that).
  await fitBoard(page);
  await expect(iframe).toHaveCount(0);

  // Zoomed in on the tile, it goes live.
  await zoomToSlot(page, C4);
  await expect(tile).toHaveClass(/is-live/);
  await expect(iframe).toHaveCount(1);

  // No allow-same-origin: the upload gets an opaque origin.
  const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');

  // The page's script ran, and localStorage was blocked.
  const frame = liveFrame(page, C4);
  await expect(frame.locator('#ran')).toHaveText('ran');
  await expect(frame.locator('#result')).toHaveText('blocked');
  const inner = await (await iframe.elementHandle())!.contentFrame();
  await expect.poll(() => inner!.title()).toBe('blocked');
});
```

- [ ] **Step 12: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts upload
```

Expected: `1 passed`.

Check that the test is real: change `'blocked'` in the two `toHaveText` assertions to `'storage'` and confirm both fail with "Expected: storage, Received: blocked". Then revert.

#### Cycle 4: replace and restore

- [ ] **Step 13: Write `e2e/tests/replace-restore.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import {
  C4, liveFrame, newBoardName, openBoard, openPostDialog, postHtmlFile, seedProfile, submitHtmlText, tileOf,
} from '../fixtures/helpers';

test('replacing a tile keeps the old version in history, and it can be restored', async ({ page }) => {
  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  // First version: the fixture page.
  await postHtmlFile(page, C4);
  const frame = liveFrame(page, C4);
  await expect(frame.locator('#result')).toHaveText('blocked');

  // Replace it. The dialog warns first.
  const dialog = await openPostDialog(page, C4, 'replace');
  await expect(dialog).toContainText('This replaces');
  await submitHtmlText(dialog, '<title>Second</title><h1 id="second">Second version</h1>');
  await expect(dialog).toBeHidden();
  await expect(frame.locator('#second')).toHaveText('Second version');
  await expect(frame.locator('#result')).toHaveCount(0);

  // History lists both versions, newest first.
  const tile = tileOf(page, C4);
  await tile.hover();
  await tile.locator('[data-action="history"]').click();
  const history = page.locator('.modal[data-dialog="history"]');
  await expect(history).toBeVisible();
  const rows = history.locator('.history-row');
  await expect(rows).toHaveCount(2);

  // Restore the older one: the fixture page is back.
  await rows.nth(1).locator('[data-action="restore"]').click();
  await expect(frame.locator('#result')).toHaveText('blocked');
  await expect(frame.locator('#second')).toHaveCount(0);

  // A restore is itself a new version, so it can be undone: history now has three.
  await page.keyboard.press('Escape');
  await tile.hover();
  await tile.locator('[data-action="history"]').click();
  await expect(page.locator('.modal[data-dialog="history"] .history-row')).toHaveCount(3);
});
```

- [ ] **Step 14: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts replace-restore
```

Expected: `1 passed`.

#### Cycle 5: conflict

- [ ] **Step 15: Write `e2e/tests/conflict.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { C4, joinBoard, newBoardName, openPostDialog, submitHtmlText, tileOf } from '../fixtures/helpers';

test('posting to a tile someone else just filled shows the conflict message', async ({ browser }) => {
  const board = newBoardName();
  const a = await joinBoard(browser, board, 'Ana');
  const b = await joinBoard(browser, board, 'Ben', '#D85A30');

  // Both open the post dialog on the same empty tile.
  const dialogA = await openPostDialog(a.page, C4, 'add');
  const dialogB = await openPostDialog(b.page, C4, 'add');

  // Ana posts first.
  await submitHtmlText(dialogA, '<title>From Ana</title><h1>Ana was first</h1>');
  await expect(dialogA).toBeHidden();
  await expect(tileOf(b.page, C4)).toHaveClass(/is-html/);

  // Ben posts second, from a dialog that still thinks the tile is empty.
  await submitHtmlText(dialogB, '<title>From Ben</title><h1>Ben was second</h1>');
  await expect(dialogB.locator('.dialog-error')).toContainText(/just posted/i);
  await expect(dialogB).toBeVisible();

  await a.context.close();
  await b.context.close();
});
```

- [ ] **Step 16: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts conflict
```

Expected: `1 passed`.

#### Cycle 6: teacher

- [ ] **Step 17: Write `e2e/tests/teacher.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { joinBoard, newBoardName, TEACHER_CODE } from '../fixtures/helpers';

test('the teacher can lock the board for students and unlock it again', async ({ browser }) => {
  const board = newBoardName();
  const teacher = await joinBoard(browser, board, 'Teacher');
  const student = await joinBoard(browser, board, 'Ben', '#D85A30');

  // Before locking, the student sees Add buttons and no banner.
  const studentAdd = student.page.locator('.tile[data-slot="0"] [data-action="add"]');
  await expect(studentAdd).toBeVisible();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();

  // The teacher opens the teacher panel from the people list.
  await teacher.page.locator('#topbar [data-action="people"]').click();
  await teacher.page.locator('.people-panel [data-action="teacher"]').click();
  const dialog = teacher.page.locator('.modal[data-dialog="teacher"]');
  await expect(dialog).toBeVisible();

  // A wrong passcode is refused.
  await dialog.locator('input[name="code"]').fill('not-the-code');
  await dialog.locator('[data-action="login"]').click();
  await expect(dialog.locator('.dialog-error')).toBeVisible();

  // The right one logs in.
  await dialog.locator('input[name="code"]').fill(TEACHER_CODE);
  await dialog.locator('[data-action="login"]').click();
  await expect(teacher.page.locator('[data-role="teacher-badge"]')).toBeVisible();
  await expect(teacher.page.locator('body')).toHaveClass(/is-teacher/);

  // Lock: the student loses the Add buttons and sees the banner.
  await dialog.locator('[data-action="lock"]').click();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeVisible();
  await expect(student.page.locator('#tiles')).toHaveClass(/is-locked/);
  await expect(student.page.locator('[data-action="add"]:visible')).toHaveCount(0);

  // Unlock: everything comes back.
  await dialog.locator('[data-action="unlock"]').click();
  await expect(student.page.locator('#banner [data-banner="locked"]')).toBeHidden();
  await expect(studentAdd).toBeVisible();

  await teacher.context.close();
  await student.context.close();
});
```

- [ ] **Step 18: Run it**

```bash
npx playwright test --config e2e/playwright.config.ts teacher
```

Expected: `1 passed`. If the login step fails with a bad code, check that `worker/.dev.vars` holds `TEACHER_CODE=letmein`, or set `E2E_TEACHER_CODE` to the value it holds.

#### Cycle 7: focus mode

- [ ] **Step 19: Write `e2e/tests/focus.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  C4, focusedSlot, newBoardName, openBoard, postHtmlFile, seedProfile, tileOf, zoomToSlot,
} from '../fixtures/helpers';

const focusing = (page: Page) => page.locator('body');

/** Zooms to the tile's maximum, then keeps scrolling up over it until focus mode starts (it needs about 300 ms of continued zoom). */
async function zoomIntoFocus(page: Page, slot: number): Promise<void> {
  await zoomToSlot(page, slot);
  const box = (await page.locator('#viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(60);
        return page.evaluate(() => document.body.classList.contains('is-focusing'));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe('focus mode', () => {
  test('zooming past a full-screen tile fills the page; Back and the browser back button leave', async ({ page }) => {
    await seedProfile(page.context(), 'Ana');
    await openBoard(page, newBoardName());
    await postHtmlFile(page, C4);
    const tile = tileOf(page, C4);

    await zoomIntoFocus(page, C4);
    await expect(focusing(page)).toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBe(C4);
    await expect(page).toHaveURL(/#C4$/);

    // The tile body covers the whole window.
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const box = (await tile.locator('.tile-body').boundingBox())!;
    expect(Math.abs(box.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - size.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - size.h)).toBeLessThanOrEqual(2);

    // The Back button leaves.
    await tile.locator('[data-action="back"]').click();
    await expect(focusing(page)).not.toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBeNull();
    await expect(page).not.toHaveURL(/#C4/);

    // Entering again, the browser's back button leaves too.
    await zoomIntoFocus(page, C4);
    await expect(page).toHaveURL(/#C4$/);
    await page.goBack();
    await expect(focusing(page)).not.toHaveClass(/is-focusing/);
    expect(await focusedSlot(page)).toBeNull();
  });

  test('a #C4 link opens focus mode once the board has loaded', async ({ page }) => {
    await seedProfile(page.context(), 'Ana');
    const board = newBoardName();
    await openBoard(page, board);
    await postHtmlFile(page, C4);

    // A fresh page load (not a hash change) on the deep link.
    const fresh = await page.context().newPage();
    await openBoard(fresh, board, { hash: '#C4' });
    await expect(focusing(fresh)).toHaveClass(/is-focusing/);
    expect(await focusedSlot(fresh)).toBe(C4);

    await fresh.locator('.tile[data-slot="23"] [data-action="back"]').click();
    await expect(focusing(fresh)).not.toHaveClass(/is-focusing/);
  });
});
```

- [ ] **Step 20: Run it in Chromium**

```bash
npx playwright test --config e2e/playwright.config.ts focus --project=chromium
```

Expected: `2 passed`. If you installed the other browsers, also run `E2E_ALL_BROWSERS=1 npx playwright test --config e2e/playwright.config.ts focus` and expect `6 passed` (2 tests × 3 browsers). A failure in Firefox or WebKit means the Popover-API focus mode needs its documented fallback (spec §12): report it in `notes`, don't edit app files.

#### Cycle 8: link post (needs the internet)

- [ ] **Step 21: Write `e2e/tests/link.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { liveFrame, newBoardName, openBoard, seedProfile, tileOf, zoomToSlot } from '../fixtures/helpers';

// The Worker fetches the link for real to check whether it can be embedded, so this needs the
// internet. Local links can't be tested at all: planLink rejects localhost by design.
test('a public link is posted, checked and shown live @network', async ({ page }) => {
  test.skip(!process.env.E2E_NETWORK, 'set E2E_NETWORK=1 to run tests that need the internet');
  test.setTimeout(90_000);

  await seedProfile(page.context(), 'Ana');
  await openBoard(page, newBoardName());

  await zoomToSlot(page, 0);
  const tile = tileOf(page, 0);
  await tile.locator('[data-action="add"]').click();
  const dialog = page.locator('.modal[data-dialog="post"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-tab="link"]').click();
  await dialog.locator('input[name="url"]').fill('https://example.com');
  await dialog.locator('[data-action="submit"]').click();
  await expect(dialog).toBeHidden();

  // The tile becomes a link tile, then the link check finishes (it is "checking" until then).
  await expect(tile).toHaveClass(/is-link/);
  await expect(tile).not.toHaveClass(/is-checking/, { timeout: 30_000 });
  await expect(tile).not.toHaveClass(/is-blocked/);

  // example.com allows framing, so zoomed in it runs live.
  await zoomToSlot(page, 0);
  await expect(tile).toHaveClass(/is-live/);
  await expect(liveFrame(page, 0).locator('h1')).toHaveText('Example Domain', { timeout: 30_000 });
});
```

- [ ] **Step 22: Run it without the flag, then with it**

```bash
npx playwright test --config e2e/playwright.config.ts link
E2E_NETWORK=1 npx playwright test --config e2e/playwright.config.ts link
```

Expected: the first run reports `1 skipped`; the second reports `1 passed` (the worker fetches `https://example.com` for real, so it needs internet access).

- [ ] **Step 23: Run the whole e2e suite once**

```bash
npx playwright test --config e2e/playwright.config.ts --project=chromium
```

Expected: 8 passed and 1 skipped (first-visit 1, cursors 1, upload 1, replace-restore 1, conflict 1, teacher 1, focus 2, link skipped).

- [ ] **Step 24: Commit (orchestrator)**

```bash
git add e2e/playwright.config.ts e2e/fixtures e2e/tests
git commit -m "test(e2e): Playwright suite with two browsers against wrangler dev and vite (E1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task V1: Full verification and manual browser check

**Wave:** 7 · **Tier:** orchestrator (no agent) · **Depends on:** E1, E2, E3

**Files:** none. The one config file this task touches lives outside the repo: `C:\Users\jacob\OneDrive\Documents\GitHub\.claude\launch.json`.

The orchestrator runs this itself, in the main session.

- [ ] **Step 1: Run the automated checks from the repo root**

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
npm run typecheck
npm test
npm run e2e
```

Expected: all three exit 0. `npm run e2e` runs the Playwright suite (F1 defines the script; if it isn't defined, run `npx playwright test --config e2e/playwright.config.ts --project=chromium`). If anything fails, send one fix-up agent the failure output and the owning task's section (T2, or T4 for code from a T3/T4 task), then re-run all three.

- [ ] **Step 2: Add the launch configs for the browser pane**

The session's project root is `C:\Users\jacob\OneDrive\Documents\GitHub`, so `launch.json` goes in `C:\Users\jacob\OneDrive\Documents\GitHub\.claude\launch.json`. If the file already exists, read it and add these two entries to `configurations` without removing the others; otherwise create it:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "class-board-worker",
      "runtimeExecutable": "npm.cmd",
      "runtimeArgs": ["--prefix", "C:/Users/jacob/OneDrive/Documents/GitHub/class-board", "run", "dev", "-w", "worker"],
      "port": 8787
    },
    {
      "name": "class-board-web",
      "runtimeExecutable": "npm.cmd",
      "runtimeArgs": ["--prefix", "C:/Users/jacob/OneDrive/Documents/GitHub/class-board", "run", "dev", "-w", "web", "--", "--port", "5173", "--strictPort"],
      "port": 5173
    }
  ]
}
```

If a server fails to start from these entries (the launch tool runs from the project root, not from `class-board`), start it with the Bash tool's `run_in_background` instead (`cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board" && npm run dev -w worker`, and likewise for web), and change that launch entry to attach: remove `runtimeExecutable` and `runtimeArgs` and add `"url": "http://localhost:8787"` (or `:5173`).

- [ ] **Step 3: Start both servers**

Call `preview_start` with `name: "class-board-worker"`, then `preview_start` with `name: "class-board-web"`. Check `preview_logs` for each: the worker log should say it is ready on `http://localhost:8787`, and Vite should print `Local: http://localhost:5173/`. Make sure `worker/.dev.vars` exists first (E1 Step 1).

- [ ] **Step 4: Open two tabs on a fresh board**

The preview tool strips URL paths and query strings when it opens a page, so open the origin and then navigate with script:

1. `navigate` to `http://localhost:5173`.
2. Seed a profile so the panel doesn't cover the page. Run with `javascript_tool` (`action: "javascript_exec"`):
   `localStorage.setItem('classBoard.profile', JSON.stringify({ name: 'Checker A', color: '#378ADD', cursor: { kind: 'shape', shape: 'arrow' } })); window.location.href = 'http://localhost:5173/?board=v1-check'`
3. `tabs_create` with `foreground: false` for a second tab, `navigate` it to `http://localhost:5173`, and run the same script with `Checker B`, color `#D85A30` and shape `star`.

Note: both tabs share one `localStorage`, so they share a profile and `clientId` unless the second tab is seeded before it loads; the seeding above overwrites A's saved profile. That's fine for this check: the two tabs are still two separate connections, and the people list shows both by connection.

- [ ] **Step 5: Check each of these, and note the result**

Use `read_page` or `get_page_text` for text, and `computer` with `screenshot` for how it looks.

1. The board shows an 8 × 10 grid of dashed empty tiles labeled `A1` to `H10`; the top bar shows the board name `v1-check`, the zoom percentage, "2 here", **Fit board**, **Your cursor** and **?** buttons; no banner is showing.
2. Mouse over the viewport in tab A: a colored cursor with a name tag appears in tab B and follows.
3. Scroll-wheel zoom and drag-to-pan work; **Fit board** returns to the whole board; `+`, `-` and `0` work.
4. Click an empty tile: the post dialog opens. Post the HTML `<title>Hello</title><h1>Hello from A</h1>` from the pasted-HTML tab. The tile fills in on both tabs, and after zooming in on it the page runs live.
5. Click the live tile once: the border turns accent (in use). Tab B shows Checker A's cursor parked on that tile with "using". Press Esc: it returns to normal.
6. Zoom in past the full-screen tile: the "Keep zooming to open" hint appears, then focus mode fills the page with only **← Back**. Back returns to the board. The browser back button does the same when re-entered. Loading `…/?board=v1-check#B1` (use the tile you posted to) opens focus mode directly.
7. Replace the tile from tab B (the dialog warns "This replaces …'s tile."), open **History**, and **Restore** the first version.
8. Open the **?** help dialog: it mentions `jacobl-h.github.io`, Allowed domains and uploading the HTML file.
9. Log in as teacher (`letmein`) from the people list, lock the board: tab B shows the "The board is locked." banner and no Add buttons. Unlock.
10. Stop the worker (`preview_stop`), and confirm tab A shows the "Reconnecting…" banner within a few seconds; start it again and confirm the banner clears and the tiles come back.
11. Open the browser console (`read_console_messages` with `onlyErrors: true`) in both tabs and confirm there are no errors other than the expected reconnect warnings.
12. Resize to `mobile` (`resize_window` preset), confirm the top bar doesn't overflow and touch-style panning works, then reset with preset `desktop`.

- [ ] **Step 6: Take the screenshot as proof**

With both tabs on the same board and the posted tile filled in, use `computer` with `screenshot` on tab A. The screenshot should show tile contents, the top bar, and the second person's cursor. Report what you checked and anything that didn't behave, as a list: item number, expected, actual.

- [ ] **Step 7: Stop the servers and commit**

`preview_stop` both servers. There is nothing to commit for V1 (`launch.json` is outside the repo).

---

### Task V2: Final single-pass review

**Wave:** 7 · **Tier:** T4 (opus, high) · **Depends on:** V1

**Files:** none (report only)

- [ ] **Step 1: Run one review agent with this exact prompt**

Run it through the Workflow tool (`agent(prompt, { model: 'opus', effort: 'high' })`; Fable is never used) with the schema below. One agent, one pass.

````text
You are the final reviewer for the class-board project. Review the WHOLE repository once,
against the approved design, and report only CRITICAL and IMPORTANT issues.

Repo: C:/Users/jacob/OneDrive/Documents/GitHub/class-board (branch build/v1)

Read first:
1. docs/superpowers/specs/2026-09-29-class-board-design.md (the approved design)
2. docs/superpowers/plans/2026-09-29-class-board.md sections 1-6 (execution rules and frozen contracts)
Then read every source file under shared/src, worker/src, web/src, the tests, e2e/,
.github/workflows/pages.yml, worker/wrangler.jsonc, README.md and docs/runbook.md.

Check, in this order:
1. SECURITY (critical if wrong):
   - Uploaded HTML is served with exactly the headers in spec section 5.8 (CSP sandbox WITHOUT allow-same-origin, frame-ancestors from ALLOWED_ORIGINS, nosniff, noindex, no-referrer, immutable cache).
   - Iframe sandbox/allow attributes match section 5.9; no allow-top-navigation; allow-same-origin is left out for the board's own origin and for uploads.
   - WebSocket upgrades and uploads check the origin allowlist; CORS is correct; board names are validated with BOARD_NAME_RE everywhere they enter a path or a Durable Object name.
   - The teacher passcode is compared in constant time, lockout works, the passcode is never logged, broadcast or stored anywhere but sessionStorage in the teacher's tab.
   - Every value from a client is validated before use (valibot schemas, label/name cleaning, URL rules from section 5.7 including IP/localhost rejection, art length and base64, tip range). No user text reaches the DOM through innerHTML.
   - Link checks and screenshots can't be pointed at localhost, private addresses or the Worker itself (SSRF): check redirects too.
   - File and screenshot ids come from crypto.getRandomValues, 128 bits.
2. CORRECTNESS against the spec:
   - Versions, restore (new version copying the old), conflicts through baseVersion, lock, clear (new empty version) in worker/src/tiles.ts and board.ts.
   - Cursor batching every 100 ms, rate messages at 80% and 90% of the daily budget, budget persisted at most every 30 s, per-connection token buckets, 150-connection cap.
   - Hibernation: connection state (profile) survives; nothing essential lives only in memory except cursor positions.
   - Screenshot queue: skips stale versions, 429 sets not_before to 00:05 UTC next day, 3 retries then give up.
   - Web: live-tile rules (section 5.3), shield and in-use behavior (5.4), focus mode with the Popover API and the iframe never moving in the DOM (5.5), hash and history behavior, deep link after the first snapshot.
   - Every error state in section 8 has UI, with the exact wording where the spec gives it.
3. BUGS that would show up in a live class of 75: memory or timer leaks (listeners, intervals, iframes that never get removed), unbounded growth, missing cleanup on disconnect, races between snapshot and tile messages, anything that breaks after a reconnect.
4. CI and docs: the Pages workflow works with base path /class-board/ and the SERVER_URL variable; the runbook's commands and file names match the repo (wrangler.jsonc keys, script names in package.json).

Do NOT report: style, naming, missing comments, minor refactors, extra tests, anything the spec
lists as out of scope (section 11), or anything you have not verified in the code. Read the code
that proves each finding; do not guess. You may run read-only commands (grep, tests for a single
file). Do not edit any file, do not commit.

For each finding return: severity (critical or important), file:line, what fails (the concrete input or
sequence and the wrong outcome), and a fix (the smallest change that resolves it, with code if short).
If you find nothing at these levels, return an empty list and say what you verified.
````

Result schema for the workflow call:

```js
const REVIEW = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'location', 'problem', 'fix'],
      },
    },
    verified: { type: 'string' },
  },
  required: ['findings', 'verified'],
}
```

- [ ] **Step 2: Triage the findings (orchestrator)**

For each finding, read the cited `file:line` and decide whether it's real. Send real ones to fix-up agents in one wave (T2, or T4 for code written by a T3/T4 task), each restricted to the files involved, then re-run the V1 Step 1 commands. Commit fixes per owning task:

```bash
git add <the fixed files>
git commit -m "fix(<area>): <what> (V2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

There is no other output: V2 changes no files by itself.

---

## Deploy (owner-run)

These steps need the owner's accounts, secrets or approval. The orchestrator never does them, and **asks before creating the GitHub repository or pushing anything**. The full commands and explanations are in `docs/runbook.md`.

- [ ] Create a free Cloudflare account (no card needed).
- [ ] `cd worker && npx wrangler login` (opens the browser).
- [ ] `npx wrangler secret put TEACHER_CODE` (type a passcode only you know).
- [ ] `npm run deploy -w worker`, then copy the printed `*.workers.dev` URL.
- [ ] Set `PUBLIC_URL` in `worker/wrangler.jsonc` to that URL and deploy again.
- [ ] **Spike 2 check:** upload an HTML file on the live board and confirm a screenshot appears on its card within about a minute. If not, switch to the REST fallback in the runbook (step 6).
- [ ] Create the public GitHub repository `Jacobl-h/class-board` and push `main` (the orchestrator asks first).
- [ ] Settings → Pages → Source: **GitHub Actions**.
- [ ] Settings → Secrets and variables → Actions → Variables: add `SERVER_URL` with the workers.dev URL, then re-run the "Deploy site to GitHub Pages" workflow.
- [ ] Custom domain only: update `ALLOWED_ORIGINS` and `BOARD_ORIGIN` in `worker/wrangler.jsonc` and redeploy.
- [ ] Before class: open the board on the school network, then run the load test: `node scripts/loadtest.mjs https://<your worker>.workers.dev loadtest 75 60 5`.
