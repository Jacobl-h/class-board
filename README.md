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
cp worker/.dev.vars.example worker/.dev.vars   # then put your teacher passcode in it (gitignored)
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
- First e2e run: `npx playwright install chromium`. The teacher test reads the passcode from
  `worker/.dev.vars` (falling back to `letmein`), so it never has to be written into the repo.
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

1. Click **Your cursor** in the top bar, type the passcode under **Teacher passcode**, and press
   **Save**. (**Teacher sign-in** at the bottom of the people list opens the same panel.) The
   passcode is remembered for this browser tab only.
2. There is one passcode for every board: the Worker secret `TEACHER_CODE`. Share it with
   co-teachers and TAs. Any number of people can be signed in as teachers at once, and each one
   shows a **Teacher** tag in the people list.
3. In the same **Your cursor** panel, **Lock the board** so students can't add, replace, rename
   or restore tiles. Students see a banner, "The board is locked." **Unlock the board** to let
   them edit again. **Sign out** removes your Teacher tag.
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
- **Your cursor:** click **Your cursor** in the top bar to change your name, color and pointer
  (arrow, hand, pencil, star or plane), or to draw your own 16 by 16 pixel pointer.
