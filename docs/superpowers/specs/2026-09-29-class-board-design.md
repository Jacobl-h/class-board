# Class Board: Design

- **Date:** 2026-09-29
- **Status:** Draft, awaiting review
- **Repo:** `class-board` (local only so far; GitHub remote `Jacobl-h/class-board` not created yet)
- **Site URL (planned):** `https://jacobl-h.github.io/class-board/`

## 1. Summary

A shared, Miro-style board for one class of up to 75 people at once. Students post a link
or an HTML file (for example a Claude artifact) into one of 80 tiles, 8 rows by 10 columns,
and write their name above it. A tile shows the page running live when the site allows
embedding, and a screenshot card when it doesn't. Everyone sees everyone else's
personalized cursor in real time. Any tile can be opened in a new tab, or zoomed into until
it fills the page ("focus mode").

It costs nothing to run. The site is static files on GitHub Pages. Realtime sync, storage
and screenshots run on a Cloudflare Worker with one Durable Object per board, on
Cloudflare's free plan.

## 2. Decisions made during brainstorming

| Question | Decision |
|---|---|
| Backend | Cloudflare Worker + Durable Object (free plan). Rejected: Firebase (its 10 GB/month download cap would be used up by 1–3 hours of cursor traffic from 75 people), peer-to-peer WebRTC (the board disappears when nobody has it open, and some networks block it), tldraw (free-form canvas that fights a fixed grid; production needs a license key and the free license shows a watermark), Yjs (the server relays updates it can't read, so it can't validate them, rate-limit them or keep history). |
| Audience | One class the teacher knows, up to 75 people at once. |
| Tile content | Links, plus single-file HTML uploads up to 1 MB. React (`.jsx`) artifacts aren't supported. |
| Replacing | Anyone can replace or rename any tile after a confirmation. Every version is kept and can be restored in one click. The teacher can lock the board. |
| Cursor customization | Name and color for everyone, plus either a preset pointer shape or a hand-drawn 16×16 pixel cursor. No emoji or image cursors. |
| Screenshots | Yes, through Cloudflare Browser Rendering. |
| Getting a closer look | An "Open in new tab" button, plus focus mode: zoom past a full-screen tile and it fills the page with only a Back button. The board never uses the browser's Fullscreen API. |
| Multiple boards | `?board=<name>` opens a separate board; the plain URL opens the default board `main`. No UI for managing boards. |
| Repo name | `class-board` |

## 3. Constraints and verified facts

All of these were checked on 2026-09-29.

### 3.1 Hosting

- GitHub Pages serves static files only: no server code and no WebSockets.
- `https://jacobl-h.github.io/` returns 404 (there's no user site), so the project is served at
  `https://jacobl-h.github.io/class-board/`. The origin `https://jacobl-h.github.io` is
  shared with the owner's other GitHub Pages projects.
- `jacoblehrer.com` is a separate GitHub Pages site (the portfolio), with DNS at GoDaddy
  (`domaincontrol.com`).

### 3.2 Cloudflare free plan

| Resource | Free allowance |
|---|---|
| Durable Object requests | 100,000/day. Each 20 incoming WebSocket messages count as 1 request (about 2,000,000 messages/day). Outgoing messages are free. |
| Durable Object duration | 13,000 GB-s/day, about 29 hours of one awake 128 MB object |
| Durable Object SQLite | 5M row reads/day, 100K row writes/day, 5 GB per account (1 GB per object), 2 MB per row or BLOB |
| Durable Object CPU | 30 s per request. Soft limit of 1,000 requests/s per object. |
| Worker requests | 100,000/day |
| Browser Rendering | 10 minutes of browser time/day, 3 concurrent browsers, 1 new browser every 20 s, 60 s idle timeout (`keep_alive` can extend it to 10 min). Over the limit, requests get HTTP 429 until the next UTC day. |

Going over any free limit makes operations fail with an error. The account is never
billed. Daily limits reset at 00:00 UTC.

### 3.3 Embedding

- Sites can forbid being framed with `X-Frame-Options` or CSP `frame-ancestors`. A page
  can't detect this from JavaScript: the frame's `load` event still fires and the frame's
  content is unreadable because it's cross-origin. So detection has to happen on the server.
- Claude artifacts, from their response headers:
  - `https://claude.ai/public/artifacts/<id>` sends `frame-ancestors 'self'`, so it can't be embedded.
  - `https://claude.ai/public/artifacts/<id>/embed` sends `frame-ancestors 'self' *.anthropic.com anthropic.com *.claude.com claude.com *.ant.dev`
    (checked with a made-up id). According to Claude's help center, other sites are allowed by the
    owner's **Allowed domains** list (Publish → Get embed code), which only exists for older
    ("legacy") published artifacts. The owner has to add `jacobl-h.github.io`.
  - Newer artifacts (`claude.ai/artifact/<id>`, shared with the Share button) can't be embedded,
    and viewers need a Claude account to open them.
- While the pointer is over an iframe, the parent page receives no pointer events, so cursor
  tracking can't rely on hovering over iframes.
- Each live iframe is a whole web page using tens to hundreds of MB. Running 80 at once
  isn't viable.
- Moving an iframe element within the DOM reloads it. A CSS transform on an ancestor
  changes what `position: fixed` descendants are positioned against.
- Browsers only open a new tab in response to a user action such as a click or key press,
  not a scroll.
- YouTube's embedded player needs a Referer header, so embeds must not use
  `referrerpolicy="no-referrer"`.

## 4. Architecture

### 4.1 Repository layout

```
class-board/
├─ web/          static site: Vite + TypeScript, no UI framework → GitHub Pages
├─ worker/       Cloudflare Worker + Board Durable Object (PartyServer) → *.workers.dev
├─ shared/       message types, validators, slot names, URL rules, pixel-art codec
├─ e2e/          Playwright tests: two browsers against local wrangler dev + vite
├─ docs/superpowers/specs/   this document
└─ .github/workflows/pages.yml
```

The root uses npm workspaces. `shared/` is imported by both `web/` and `worker/`. Runtime
dependencies: `partyserver` (Worker), `partysocket` (browser), `@cloudflare/puppeteer`
(screenshots) and `valibot` (message validation).

### 4.2 How data moves

```
Browser (GitHub Pages) ──WebSocket──► Worker ──► Board DO (one per board name)
        │                                          ├─ SQLite: versions, files, shots, meta
        ├──HTTP POST upload──► Worker ──► Board DO ├─ outbound fetch: link checks
        └──HTTP GET file/shot─► Worker ──► Board DO └─ Browser Rendering: screenshots
```

- **Opening the page:** the browser connects and sends `hello` with its profile. The server
  replies with a snapshot: all 80 tiles, the lock state, everyone's cursor profiles and the
  current cursor rate. Live updates follow.
- **Cursors:** each browser sends its position about 5 times a second while the mouse moves.
  Positions are in board coordinates, so they line up for everyone at any zoom. The server
  combines all changes into one `cursors` message every 100 ms.
- **Posting a link:** the server validates it, saves a new version and broadcasts it. It
  then checks the link (embeddable?, title, icon) and queues a screenshot, broadcasting each
  result as it arrives.
- **Uploading HTML:** HTTP POST to the Worker, which forwards it to the board's Durable Object.
  The response is a file id, and the tile's `post` points at it.

### 4.3 Units

| Unit | Responsibility |
|---|---|
| `shared/protocol.ts` | Every message type in both directions, with valibot schemas. The one place limits are defined (lengths, sizes, rates). |
| `shared/slots.ts` | Converts slot indexes 0–79 to and from `A1`–`H10`; grid geometry constants. |
| `shared/urls.ts` | URL normalization and known rewrites (YouTube, Claude). Pure functions. The server's result is authoritative; the dialog uses them for a preview. |
| `shared/pixelArt.ts` | Encodes, decodes and validates 16×16 cursor art. |
| `worker/index.ts` | HTTP routing, origin allowlist, CORS, handing WebSocket upgrades to the right Durable Object. |
| `worker/board.ts` | The Board Durable Object: connections, message dispatch, cursor batching, broadcasts, snapshots. |
| `worker/store.ts` | SQLite schema and typed queries. |
| `worker/frameHeaders.ts` | Pure evaluation of `X-Frame-Options` and CSP `frame-ancestors` against the board's origin. |
| `worker/linkCheck.ts` | Fetches a link, calls `frameHeaders`, extracts the title and icon. |
| `worker/shots.ts` | Screenshot queue; reuses one Browser Rendering session. |
| `worker/limits.ts` | Per-connection token buckets; the daily message budget and its thresholds. |
| `worker/teacher.ts` | Passcode check and lockout after wrong guesses. |
| `worker/files.ts` | Validates uploads and serves them with sandbox headers. |
| `web/net/socket.ts` | PartySocket wrapper: typed send, reconnecting, matching replies to requests by `reqId`. |
| `web/state/boardState.ts` | The browser's copy of tiles, people and the lock state. Applies server messages and emits changes. |
| `web/board/camera.ts` | Pan and zoom math, board↔screen conversion, input handling, fit and zoom-to-tile, the focus-mode threshold. |
| `web/board/grid.ts` | Draws tiles, labels, states and hover buttons. |
| `web/board/liveFrames.ts` | Decides which tiles are live; mounts and removes iframes; shields and "in use". |
| `web/board/focus.ts` | Focus mode, the `#C4` hash and browser history. |
| `web/tiles/postDialog.ts`, `web/tiles/historyPanel.ts` | Posting, replacing, uploading, history and restore. |
| `web/cursors/local.ts` | Throttled sending, your own CSS cursor, the docked state. |
| `web/cursors/remote.ts` | Other people's cursors: layer, smoothing, fading, name tags. |
| `web/profile/*` | Saved profile (localStorage), cursor panel, preset shapes, pixel editor. |
| `web/people/peoplePanel.ts`, `web/teacher/teacherPanel.ts` | People list; teacher controls. |
| `web/main.ts` | Wires everything together. |

## 5. Board and tiles

### 5.1 Grid and camera

- 80 slots: rows `A`–`H` × columns `1`–`10`. Slot index = row × 10 + (column − 1), so C4 is 23.
- Geometry in board units: each tile is 480 × 300 (16:10), with a 32-unit name label above
  it and 48-unit gutters. Iframes render at 1280 × 800 CSS px and are scaled down to fit the
  tile (scale 0.375).
- Zooming out stops when the whole board fits with a margin. Zooming in stops when the tile
  under (or nearest to) the pointer fills the viewport. Zooming in any further enters focus mode (§5.5).
- Input:
  - Mouse wheel or trackpad scroll zooms around the pointer. Pinch (ctrl+wheel or touch) also zooms.
  - Dragging anywhere pans (on a tile too, as long as the pointer moves more than 4 px). One-finger touch drag pans.
  - Keys: `+` and `-` zoom, `0` fits the board, arrow keys pan.
  - A **Fit board** button in the top bar. Double-clicking a tile zooms to fit it.

### 5.2 Tile states

| State | When | Looks like |
|---|---|---|
| Empty | No content | Dashed outline, "Add to C4" |
| Checking | Link check running (`embeddable` is `pending`) | Spinner, "Checking link…" |
| Live | Meets the live rules (§5.3) | The running page, with a transparent shield over it |
| Card | Not live | Screenshot if there is one, otherwise title, icon and domain. A note if the site can't be embedded. Open in new tab button. |
| In use | A live tile was clicked | Accent border; the page receives your input |

Above each tile: the name (click to edit), the slot id, and an `HTML` badge on uploads.
Hover buttons: Open in new tab, Replace, History, and Clear for the teacher.

### 5.3 Which tiles run live

A tile runs live only if all of these are true:

1. It holds an HTML upload, or a link whose `embeddable` is `yes` or `unknown`.
2. It's at least partly on screen.
3. It's at least 240 px wide on screen.
4. It's within the cap: 12 live tiles, or 6 when `navigator.deviceMemory` ≤ 4. The tiles
   closest to the center of the viewport win.

A tile stays live for 2 s after it stops qualifying, and at most 2 new iframes are mounted
per 250 ms, so zooming doesn't churn iframes. A tile that stops being live has its iframe
removed, losing that page's state, which is acceptable. The in-use tile and the
focus-mode tile are always live and don't count toward the cap. A live tile whose
`embeddable` is `unknown` shows a small "Blank? Open in new tab" hint.

### 5.4 Clicking into a live tile

- A transparent shield covers every live iframe. Clicking the shield without dragging (less
  than 4 px of movement) puts the tile in use: the shield is removed, the border turns
  accent, and everyone else sees your cursor parked on that tile as "Ana · using D6".
- The tile stops being in use when the board receives a pointer move outside it (the
  pointer has left the iframe), when you click elsewhere on the board, or when you press Esc
  while the board has keyboard focus.
- The wheel zooms the board over a shielded tile and scrolls the page over an in-use tile.

### 5.5 Focus mode

- **Entering:** keep zooming in on a tile after zoom-in has stopped. A "Keep zooming to open"
  hint appears. Focus mode starts after about 300 ms of continued zoom input, so a single
  overshoot doesn't trigger it. Pressing Enter on a tile that has keyboard focus also enters.
- **Look:** the tile fills the page edge to edge. The iframe is resized to the window at
  scale 1, so the page renders at its real size and is fully usable. The only other UI is a
  small **← Back** button in the top-left corner.
- **Leaving:** the Back button, or the browser's back button (entering pushes `#C4` onto the
  history). Esc also leaves while the board page has keyboard focus.
- **Deep link:** loading `…/class-board/?board=week-3#C4` opens focus mode on C4 once the
  first snapshot has arrived.
- **Tiles that can't be embedded:** focus mode shows the screenshot edge to edge, with an
  "Open in new tab" button in the center (a click, so the browser allows the new tab).
- **For everyone else:** your cursor is parked on the tile as "Ana · viewing C4".
- **Constraint:** the iframe element must never move within the DOM, or it reloads. Approach:
  add `popover="manual"` to the tile's `.tile-body` and call `showPopover()`. That puts it in
  the browser's top layer, where it ignores the camera transform. Removing the attribute on
  exit restores it. Verified on 2026-09-29 in Chromium: inside a board scaled to 0.3, the
  popover covered the whole viewport, the embedded page kept running with no reload and
  re-laid out at the window width, and after exit it returned to its place on the board.
- There is no full-screen feature. Embedded players keep their own full-screen buttons (§5.9).

### 5.6 Posting, replacing, renaming, history

- **Post:** click an empty tile to open a dialog with two options: a link, or an HTML file
  (file picker, drag and drop, or pasted HTML). The name above the tile starts as your
  cursor name. Then Post.
- **Replace:** the same dialog, opened from a filled tile, with a warning: "This replaces
  Maya's tile. Her version stays in History."
- **Rename:** click the name above a tile, edit it, press Enter. This saves a new version.
- **History:** newest first, showing who, when, the title or type, and a screenshot
  thumbnail. **Restore** saves a new version that copies the chosen one, so a restore can
  itself be undone.
- **Two edits at once:** every edit includes the `baseVersion` the user was looking at. If
  the slot has changed since then, the server rejects the edit with `conflict` and the dialog
  says: "Someone just posted to C4. Pick another tile or replace theirs."
- **Locked board:** students don't see Add, Replace, Rename or Restore. A banner says "The
  board is locked."
- **Open in new tab:** a link opens its original URL, not the embed version. An upload opens
  the Worker's copy of the file. Both use `rel="noopener noreferrer"`.

### 5.7 Links

- Only `http` and `https` URLs up to 2,048 characters. Hosts that are IP addresses,
  `localhost`, or end in `.local` or `.internal` are rejected.
- Rewrites, done on the server. The original URL is kept for Open in new tab.
  - YouTube `youtube.com/watch?v=ID`, `youtu.be/ID` and `youtube.com/shorts/ID` become
    `https://www.youtube-nocookie.com/embed/ID`. Their "screenshot" is
    `https://i.ytimg.com/vi/ID/hqdefault.jpg`, which uses no browser time.
  - A published Claude artifact `claude.ai/public/artifacts/ID` becomes `…/ID/embed`.
  - A newer Claude artifact (`claude.ai/artifact/ID` or `claude.ai/code/artifact/ID`) is
    marked as not embeddable, with the note: "Newer Claude artifacts can't be embedded and need
    a Claude account to open. Upload the artifact's HTML file instead."
- Link check, run after the version is saved: a GET with a 5 s timeout, following up to 5
  redirects.
  - CSP `frame-ancestors` takes precedence when present. `'none'` means no. A source list
    means yes only if it matches `https://jacobl-h.github.io` (by host, wildcard host, scheme
    or `*`); `'self'` on its own means no.
  - Otherwise `X-Frame-Options` of `DENY` or `SAMEORIGIN` means no.
  - Neither header means yes. A network error or timeout means `unknown`.
  - Title from `og:title` or `<title>`. Icon from `<link rel~="icon">`, falling back to
    `/favicon.ico`. Parsed with HTMLRewriter, reading at most 256 KB.
  - If a Claude `/embed` URL comes back as no, the note says: "Add jacobl-h.github.io to this
    artifact's Allowed domains in Claude (Publish → Get embed code) to show it live."

### 5.8 HTML uploads

- One file (`.html` or `.htm`, or pasted text), UTF-8, up to 1 MB. It must contain `<`.
  Stored exactly as uploaded.
- An upload's tile title is its `<title>`, falling back to the file name, then "HTML page".
  Its `embeddable` is always `yes`.
- Served at `GET /boards/<board>/files/<id>` with:
  - `Content-Type: text/html; charset=utf-8`
  - `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors <ALLOWED_ORIGINS>`
  - `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`,
    `Cache-Control: public, max-age=31536000, immutable`
- Effect: the page's scripts run with a throwaway ("opaque") origin. It can't use cookies or
  `localStorage` (accessing them throws), and it can't reach the board or other tiles. It can
  only be framed by the board. Uploads that rely on saved browser data lose that data, which
  is fine because most Claude artifacts don't use it.
- The screenshot is taken from the file's URL.

### 5.9 How embeds are framed

- `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`.
  There's no `allow-top-navigation`, so an embed can't navigate the board away.
  `allow-same-origin` is left out for URLs on the board's own origin (`https://jacobl-h.github.io`).
- `allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen"`. The
  `fullscreen` permission only lets an embedded player such as YouTube use its own
  full-screen button. Camera, microphone and location aren't granted.
- The browser's default referrer policy is kept, because YouTube needs a Referer.
- Uploads use the same attributes without `allow-same-origin`. Their CSP sandbox applies
  either way.

## 6. Cursors

### 6.1 Profile

- Saved in `localStorage` under `classBoard.profile`, along with a random `clientId` (UUID)
  created on the first visit.
- Fields:
  - `name`: 1–24 characters, required.
  - `color`: one of 12 fixed colors.
  - `cursor`: either `{ kind: 'shape', shape }`, where `shape` is one of `arrow | hand | pencil | star | plane | crosshair`,
    or `{ kind: 'pixels', art, tip }`.
- The "Your cursor" panel opens on the first visit and can't be closed without a name. The
  "Your cursor" button in the top bar reopens it.

### 6.2 Pixel editor

- A 16×16 grid with a palette of 8 colors (index 1 is your profile color, then black, white
  and 5 fixed colors) plus transparent (index 0).
- Tools: pen, eraser, clear, and set tip (click a pixel; the default is the center, (8, 8)).
- Previews at 1× and 2×.
- Encoding: 256 cells × 4 bits = 128 bytes, stored as 172 characters of base64. The palette
  is fixed apart from index 1, so it's never sent. Changing your color recolors your drawing.
- The server checks the exact length, that it's valid base64, and that the tip is within 0–15.

### 6.3 Your own cursor

- The board sets CSS `cursor: url(<32×32 PNG data URL>) <tipX> <tipY>, auto`. Shapes are
  drawn from SVG; pixel art is scaled up 2×. So you see your own design with no delay.
- Over an in-use or focus-mode iframe, the embedded page controls the cursor (a browser rule).

### 6.4 Sending your position

- While the pointer moves over the board, send its board position as integers at most every
  200 ms (5 Hz), plus a final position 200 ms after it stops. Nothing is sent while it's still.
- When a tile is in use or in focus mode, send `{ tile, mode: 'using' | 'viewing' }` once.
- When the tab is hidden (`visibilitychange`), send `away`, and resume when it's visible again.
- The server's `rate` message can lower the rate to 2 Hz or pause sending (0).

### 6.5 Showing other people's cursors

- Drawn on a layer above the tiles, positioned from board coordinates through the camera.
  They stay the same size on screen at every zoom level.
- Smoothing: each cursor is drawn about 200 ms behind real time, moving in a straight line
  between the positions received. After a gap of more than 1 s it jumps rather than animating.
- The name tag uses the cursor's color, with the darkest shade of that color for the text.
- After 20 s without moving, a cursor fades to 35% opacity and hides its tag. Cursors that
  are away are hidden. A cursor parked on a tile sits at the tile's top-left corner with the
  tag "Name · using C4" or "Name · viewing C4".

### 6.6 People list

- The top bar shows "N here". Clicking it lists everyone with their color and what they're
  doing. Clicking a name centers the view on their cursor, or on their tile.
- The teacher also sees **Reset cursor** for each person. The server replaces that person's
  cursor with the plain arrow and broadcasts a `person` update. When a browser receives an
  update about its own person, it overwrites its saved profile with it.

### 6.7 Traffic budget

- The server counts incoming WebSocket messages per UTC day. The count lives in memory and is
  saved every 30 s, never once per message, to stay under 100K row writes a day.
- Budget: 2,000,000 messages a day (configurable).
  - Under 80%: cursors send at 5 Hz.
  - At 80%: the server broadcasts `rate 2`.
  - At 90%: the server broadcasts `rate 0`. Browsers stop sending cursor positions, and the
    server ignores any that still arrive. Posting, replacing and restoring keep working.
- Expected use: 75 students moving their mouse 40% of the time at 5 Hz is about 150
  messages/s, or 540K an hour. A 75-minute class uses about 675K, 34% of the day's budget.
  In the worst case, with everyone moving nonstop, cursors would pause after about 1.5 hours.

## 7. Server details

### 7.1 Routes

| Route | Purpose |
|---|---|
| `wss://<worker-host>/parties/board/<board>` (PartyServer's default routing) | Realtime connection |
| `POST /boards/<board>/files` | Upload an HTML file, up to 1 MB. Returns `{ fileId }`. |
| `GET /boards/<board>/files/<fileId>` | Serve an upload with sandbox headers (§5.8) |
| `GET /boards/<board>/shots/<shotId>` | Serve a screenshot JPEG with `Cache-Control: public, max-age=31536000, immutable` |

- Board names match `[a-z0-9-]{1,40}`. The default board is `main`.
- WebSocket upgrades and uploads must come from an origin in `ALLOWED_ORIGINS`
  (`https://jacobl-h.github.io`, plus `http://localhost:5173` in development). CORS is only
  needed for the upload. File and screenshot GETs are public, because Open in new tab and
  `<img>` need them.
- HTTP routes are handled in the Worker and forwarded to the board's Durable Object.

### 7.2 Messages

Client → server:

| `type` | Fields | Notes |
|---|---|---|
| `hello` | `clientId`, `profile` | Must be the first message. The server replies with `snapshot`. |
| `profile` | `profile` | Up to 10 a minute |
| `cursor` | `x`, `y` | Up to 6 a second; extras are dropped. Also marks you as on the board. |
| `dock` | `slot`, `mode` (`using` or `viewing`) | You're using a tile or viewing it in focus mode |
| `away` | none | Your tab is hidden |
| `post` | `reqId`, `slot`, `baseVersion`, `content` (`{kind:'link', url}` or `{kind:'html', fileId}`), `label` | |
| `rename` | `reqId`, `slot`, `baseVersion`, `label` | |
| `restore` | `reqId`, `slot`, `baseVersion`, `versionId` | |
| `history` | `reqId`, `slot` | |
| `teacher` | `reqId`, `code`, `action` (`lock`, `unlock`, `clear`, `resetCursor`), plus `slot` or `target` | |

Server → client:

| `type` | Fields |
|---|---|
| `snapshot` | `you`, `tiles` (80 `TileView`s), `locked`, `people`, `rate` |
| `cursors` | A batch of `[connId, x, y]` positions. Sent at most every 100 ms, and only when something moved. |
| `person` | `joined` or `updated`, with the person, including their presence (`board`, `tile` with `slot` and `mode`, or `away`) |
| `personLeft` | `id` |
| `tile` | `slot`, `view`. Sent after any edit, link check or screenshot. |
| `locked` | `locked` |
| `rate` | `hz`: 5, 2 or 0 |
| `ok` / `error` | `reqId`. `error` also has a `code` (`locked`, `conflict`, `rate_limited`, `invalid`, `too_large`, `bad_code`) and a `message`. |
| `historyResult` | `reqId`, `versions` |

`TileView` has: `slot`, `version`, `kind` (`empty`, `link` or `html`), `label`, `url`, `embedUrl`,
`fileUrl`, `title`, `icon`, `embeddable` (`yes`, `no`, `unknown` or `pending`), `note`,
`shotUrl`, `authorName`, `createdAt`.

### 7.3 Storage (SQLite in each Board Durable Object)

```sql
versions  (id INTEGER PRIMARY KEY, slot INTEGER, created_at INTEGER,
           author_client TEXT, author_name TEXT,
           kind TEXT,                 -- 'empty' | 'link' | 'html'
           url TEXT, embed_url TEXT, file_id TEXT, label TEXT,
           title TEXT, icon TEXT, embeddable TEXT, note TEXT, shot_id TEXT)
current   (slot INTEGER PRIMARY KEY, version_id INTEGER)
files     (id TEXT PRIMARY KEY, html TEXT, size INTEGER, created_at INTEGER, author_client TEXT)
shots     (id TEXT PRIMARY KEY, jpeg BLOB, created_at INTEGER)
shot_queue(version_id INTEGER PRIMARY KEY, attempts INTEGER, not_before INTEGER)
meta      (key TEXT PRIMARY KEY, value TEXT)   -- locked, budget_day, budget_count
```

- Link-check and screenshot results update the existing version row, because they describe
  the same content rather than a new edit.
- Clearing a tile saves a new `empty` version, so it can be restored.
- File and screenshot ids are random 128-bit values, so they can't be guessed.
- Who's connected and where their cursors are live in memory only. Each connection's profile
  is stored with its socket through PartyServer's connection state (at most 2 KB), so it
  survives the Durable Object hibernating while idle. Cursor positions are lost when it
  hibernates, which is fine because that only happens when nothing is moving.

### 7.4 Screenshots

- `shot_queue` is worked through by the Durable Object's alarm, one item at a time, reusing one
  Browser Rendering session (`keep_alive` 10 min) to stay within "1 new browser every 20 s".
- Viewport 1280 × 800. Wait for the network to go idle, or 15 s at most. Save as JPEG
  quality 70 in `shots`, update the version, and broadcast `tile`.
- A version that's no longer a tile's current version when its turn comes is skipped.
- An HTTP 429 over the daily limit sets `not_before` to 00:05 UTC the next day. Other errors
  retry up to 3 times with backoff, then give up, and the card shows the title and icon.

### 7.5 Limits and validation

- Per connection: cursor 6/s (burst of 10, extras dropped), post/rename/restore 10/min,
  history 30/min, profile 10/min, teacher attempts 5 per 10 min.
- Per board: at most 150 connections. Uploads: 5 a minute per IP (`CF-Connecting-IP`).
- Labels up to 40 characters, names up to 24. Control characters are removed.

### 7.6 Teacher

- The passcode is the Worker secret `TEACHER_CODE`, compared in constant time.
- Actions: lock or unlock the board, clear a tile, reset a person's cursor.
- A small "Teacher" link at the bottom of the people list opens the teacher panel. The
  passcode is kept in `sessionStorage` for that tab only.

## 8. Error handling

| Situation | What happens |
|---|---|
| Connection lost | PartySocket reconnects with backoff while a "Reconnecting…" banner shows. After reconnecting, a fresh snapshot replaces the local state. |
| Edit rejected | The dialog explains why: board locked, someone just posted there, too many edits, invalid link, file over 1 MB, or not HTML. |
| Link check times out or fails | `embeddable` is `unknown`. The tile tries to embed and shows the "Blank? Open in new tab" hint. |
| Site blocks embedding | A card with the screenshot, the note and Open in new tab. |
| No screenshot | A card with the title, icon and domain. |
| Daily budget at 80% or 90% | Cursors slow down or pause, with a small notice: "Cursors are paused until midnight UTC to stay within the free limit." |
| A Cloudflare limit is hit (connections refused) | The page says: "The board has hit today's free limit. It'll be back at midnight UTC." |
| Upload fails | The dialog offers a retry. Nothing is posted. |
| Server unreachable on first load (for example, a school filter) | The page says: "Can't reach the board server", with the server address to pass to IT. |

## 9. Testing

Implementation follows test-driven development, one task at a time as set out in the plan.

- **shared:** Vitest unit tests for slot names, URL normalization and rewrites, the pixel-art
  codec and message validation.
- **worker:** Vitest with `@cloudflare/vitest-pool-workers`, which runs in Cloudflare's local
  runtime (workerd). Covers:
  - all the header combinations in `frameHeaders`
  - link checks against a mocked `fetch`
  - versions, restore and conflicts
  - lock, rate limits and budget thresholds
  - headers on served files
  - the screenshot queue with a stubbed browser
  - the teacher lockout
- **web:** Vitest unit tests for camera math, choosing live tiles, cursor smoothing,
  throttling, the focus-mode threshold and profile storage.
- **e2e:** Playwright with two browser contexts against `wrangler dev` and `vite`:
  - a cursor moving in one window shows up in the other
  - post, then replace, then restore
  - a conflict
  - locking the board
  - focus mode by zooming, then leaving with Back, with the browser back button, and via a deep link
  - an HTML upload runs, and can't read `localStorage`
  - a link that can't be embedded shows a card
- **Spikes:**
  1. ~~Focus mode with the Popover API keeps the iframe running, with no reload, inside a transformed board.~~
     Done on 2026-09-29; it works (§5.5).
  2. Browser Rendering can be called from a Durable Object on the free plan. Run at first deploy.
  3. PartyServer hibernation works with connection state and a batching timer. Covered by the
     Board Durable Object's tests.
- **Before class:** run a Node load test with 75 simulated cursors at 5 Hz against the
  deployed Worker, to measure message counts and CPU. Then open the board once on the school
  network.

## 10. Deployment

- **GitHub:** a public repo `Jacobl-h/class-board`, with Pages set to deploy from GitHub
  Actions. The workflow builds `web/` with Vite `base: '/class-board/'` and
  `VITE_SERVER_URL` taken from a repository variable.
- **Cloudflare:** a free account. `worker/wrangler.jsonc` declares:
  - the Durable Object binding, with a `new_sqlite_classes` migration
  - the `browser` binding for Browser Rendering
  - variables `ALLOWED_ORIGINS` and `BOARD_ORIGIN`
  - the secret `TEACHER_CODE`

  Deploy with `npx wrangler deploy` from `worker/`.
- **Steps only the owner can do:**
  - Create the Cloudflare account and run `wrangler login`.
  - Set `TEACHER_CODE`.
  - Create the GitHub repo and turn on Pages.
- **Before class:** open the board on the school network. If `*.workers.dev` is blocked,
  move `jacoblehrer.com`'s DNS to Cloudflare (free, carrying the GitHub Pages records over
  unchanged) and give the Worker a custom domain such as `board-api.jacoblehrer.com`.
- **Help for students:** a "?" button in the top bar explains how to post, how to add
  `jacobl-h.github.io` to a published Claude artifact's Allowed domains, and how to upload an
  artifact's HTML file instead.

## 11. Out of scope

- Accounts, logins and tile ownership.
- React (`.jsx`) artifacts, multi-file uploads, emoji or image cursors.
- Browser full-screen mode for the board.
- Free-form drawing, sticky notes, chat and reactions.
- Creating, listing, archiving or deleting boards; exporting.
- Presenter features, such as everyone following the teacher.
- Deploying the Worker automatically from GitHub Actions (`wrangler deploy` is run by hand for now).
- Purging uploaded files. Clearing a tile hides the upload, but the file stays in history and
  at its URL.

## 12. Risks

| Risk | Mitigation |
|---|---|
| The school network blocks `*.workers.dev` | Check before class. Fall back to a custom domain (§10). |
| Browser Rendering from a Durable Object on the free plan isn't documented | Spike 2. Fallback: Browser Rendering's REST `/screenshot` endpoint, called from the Worker (1 request every 10 s on the free plan). |
| The Popover API approach is verified only in Chromium | Check focus mode in Firefox and Safari during end-to-end testing. Fallback: resize the tile in place and move the camera. |
| Some sites send different headers to bots, or block Cloudflare's IPs | The "Blank? Open in new tab" hint, plus the screenshot card. |
| Anyone with the link can join | Share it only with the class. A class join code is a small follow-up if needed. |
| Anyone with a file's URL can open the upload | Ids can't be guessed, pages are `noindex`, only the board can frame them, and the teacher can clear the tile. |

## 13. Build order

Each step ends with something that runs and is tested, so the plan can check progress
along the way.

1. **Spikes** (§9): Browser Rendering from a Durable Object (at first deploy), PartyServer
   hibernation (in the Board Durable Object's tests). The focus-mode spike is already done.
2. **Skeleton:** npm workspaces, `shared/protocol.ts`, a Worker and Board Durable Object that
   answer `hello` with `snapshot`, and a web page that connects and shows the connection status.
3. **Board canvas:** the grid, the camera (pan, zoom, fit, zoom to tile), empty tiles with labels.
4. **Live cursors** with the default arrow: sending, batching, smoothing, idle and away, the people list.
5. **Posting links:** the dialog, versions, conflicts, renaming, history and restore; teacher lock and clear.
6. **Link checks:** rewrites, embed-header evaluation, title and icon, cards.
7. **Live tiles:** the selection rules, shields, "in use", parked cursors.
8. **Focus mode:** zooming in, Back, browser history, deep links.
9. **HTML uploads:** the upload route, sandboxed serving, the dialog's file option.
10. **Screenshots:** the queue, Browser Rendering, YouTube thumbnails, history thumbnails.
11. **Cursor customization:** preset shapes, the pixel editor, your own CSS cursor, teacher reset.
12. **Hardening:** rate limits, the daily budget, every error state in §8, the help button.
13. **Launch:** the Pages workflow, deploying the Worker, the load test, the school-network check.

## 14. References

- Claude help center, "Publish and share artifacts": https://support.claude.com/en/articles/9547008-publish-and-share-artifacts
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Browser Rendering limits: https://developers.cloudflare.com/browser-rendering/platform/limits/
- Browser Rendering pricing: https://developers.cloudflare.com/browser-rendering/platform/pricing/
