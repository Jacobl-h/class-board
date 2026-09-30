# Class Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan replaces that skill's per-task loop with the fast path in §1 (the owner asked for speed, parallel agents with model and effort matched to each job, and lighter verification):** a script writes all the code, the tests run once, and agents fix only what fails. Section 1 takes precedence over the sub-skill wherever they conflict.

**Goal:** Build the class board in `docs/superpowers/specs/2026-09-29-class-board-design.md`: a GitHub Pages site plus a Cloudflare Worker / Durable Object backend with live cursors, 80 replaceable tiles with history, HTML uploads, embed checks, screenshots and focus mode.

**Architecture:** An npm-workspaces monorepo:
- `shared/`: types, validation, geometry, URL rules.
- `worker/`: one PartyServer Durable Object per board, plus small leaf modules.
- `web/`: Vite + TypeScript with no UI framework. Modules depend only on the interfaces in `web/src/contracts.ts`, and `web/src/main.ts` wires the concrete pieces together.
- `e2e/`: Playwright tests.

A script writes every file from the plan; agents, each on a model and effort level matched to the job, fix only what the checks flag.

**Tech stack:** TypeScript 7 · Vite 8 · Vitest 4 (with `@cloudflare/vitest-plugin` and `happy-dom`) · Cloudflare Workers + SQLite-backed Durable Objects via `partyserver` / `partysocket` · `@cloudflare/puppeteer` (Browser Rendering) · `valibot` · Playwright · GitHub Actions → GitHub Pages.

**Detailed tasks live in the workstream files** listed in §9. This file holds everything that has to be the same across them: the execution rules, the wave schedule, and the fixed contracts (Task F2 contains their code).

---

## 1. How to execute: the fast path (read first)

The workstream files already contain the complete code and tests for all 152 files, so no agent
needs to retype code. A script writes every file in task order. Agents are used only where a
check fails. This replaces the earlier plan of seven separately run waves and 41 task agents,
and it deliberately skips the red/green TDD ceremony: every test in the plan still exists and
runs, once, against the finished code.

On this path the workstream files are the source of truth for code and tests. Their
step-by-step instructions (write the test, see it fail, implement, see it pass) describe how the
code was designed; nobody follows them.

### 1.1 Stages

| Stage | Who | What | Rough time |
|---|---|---|---|
| 1. Write | Orchestrator, by script | Branch, write all 152 files, install packages and Chromium, commit once | ~10 min |
| 2. Check | Orchestrator | `npm run typecheck` and `npm test` across every package; group failures by area (§1.3) | ~3 min |
| 3. Fix | One agent per failing area, in parallel | Fix, re-check, and repeat, at most 3 rounds; an area that's still failing moves up a model tier | 15–45 min |
| 4. End-to-end | One agent (`opus`, `medium`), then the orchestrator | `npm run e2e` in Chromium and fix what fails; then a two-tab manual check in the browser pane with a screenshot | 20–40 min |
| 5. Review | One agent (`opus`, `high`) | A single pass over the whole repo against the spec, reporting only critical and important issues; the orchestrator applies the fixes | ~15 min |
| 6. Deploy | The owner, with the orchestrator | The runbook in `08-e2e-launch.md`. Ask before creating the GitHub repo or pushing | Owner's pace |

### 1.2 Stage 1 commands

```bash
cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"
git switch -c build/v1
node docs/superpowers/plans/2026-09-29-class-board/materialize.mjs
npm install
cp worker/.dev.vars.example worker/.dev.vars
npx playwright install chromium
git add -A
git commit -m "feat: write the class-board code from the plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- `materialize.mjs` writes each file's final state:
  - it applies every "create", "replace", "append", "replace the imports" and
    find-and-replace step in task order
  - it exits with status 1 if any edit can't be applied exactly
  - a dry run on 2026-09-29 mapped all 152 files with no errors; `package-lock.json` comes
    from `npm install`
- `worker/.dev.vars` is gitignored.
- The Chromium download is about 115 MB and goes to `%LOCALAPPDATA%\ms-playwright`.

### 1.3 Areas, and the model and effort for fixing each

A failing test or type error belongs to the area that owns the file it's in. When the fix
clearly lies in another area's file (for example, a web test failing because a helper is
wrong), give it to that area instead.

| Area | Files | Plan sections | Model / effort |
|---|---|---|---|
| shared | `shared/**` | `01-foundation.md` F3–F5, master §3.1 | `sonnet` / `low` |
| worker-leaves | `worker/src/{frameHeaders,limits,budget,teacher,files,linkCheck,shots}.ts`, `worker/test/unit/**` | `03-worker-leaves.md` | `sonnet` / `medium` |
| worker-core | `worker/src/{store,board,tiles,content,index}.ts`, `worker/test/*.ts` | `02-worker-core.md` | `opus` / `medium` |
| web-core | `web/src/{ui,util,net,state}/**`, `web/src/config.ts`, `web/src/board/camera.ts` and their tests | `04-web-core-a.md` | `sonnet` / `medium` |
| web-board | `web/src/board/{input,grid,chooseLive,liveFrames,focus}.*`, `web/src/main.ts`, `web/index.html`, `web/src/styles/**` and their tests | `05-web-core-b.md`, `06-web-tiles.md` T1, T2, T5 | `opus` / `medium` |
| web-panels | `web/src/{tiles,cursors,profile,people,teacher}/**` and their tests | `06-web-tiles.md` T3, T4, `07-web-cursors.md` | `sonnet` / `medium` |
| config | root files, `*/package.json`, `*/tsconfig.json`, `*/vite*.config.ts`, `*/vitest*.config.ts`, `worker/wrangler.jsonc` | `01-foundation.md` F1 | `sonnet` / `medium` (runs alone, before the other areas) |
| e2e | `e2e/**` | `08-e2e-launch.md` E1 | `opus` / `medium` |

- **Escalation:** an area still failing after a fix round moves up one step, from
  `sonnet`/`low` → `sonnet`/`medium` → `opus`/`medium` → `opus`/`high`. Fable is never used.
- **Haiku** has no place on this path: there's nothing left to transcribe.

### 1.4 Rules for fix agents (include them in every fix prompt)

1. **Stay in your area.** Edit only the files your prompt lists as your area; other agents are
   fixing other areas at the same time. Don't touch `package.json`, lockfiles or configs unless
   you're the config area.
2. **What's correct:** the spec, the contracts (§3–§6) and your area's plan sections define correct
   behavior.
   - Fix code so it meets them.
   - Change a test only when it contradicts the spec or a contract, and say so in your result.
   - Never change a contract file (`shared/src/constants.ts`, `shared/src/types.ts`,
     `worker/src/env.ts`, `web/src/contracts.ts`). If one blocks you, stop and report.
3. **Check narrowly.** Run your own test files by exact path, for example
   `npm test -w web -- test/grid.test.ts`, or `npm run test:unit -w worker -- test/unit/files.test.ts`.
   `npm run typecheck -w <package>` is allowed, but only act on errors in your own files; others
   may be mid-fix.
4. **Leave git and dependencies alone.** Don't commit, and don't install or upgrade packages.
   If a fix needs a new dependency, report it.
5. **Return** the result JSON from §1.5: the files changed, the root cause in one sentence per
   problem, and the final test output.

### 1.5 Workflow template for Stage 3

The Agent tool can't set effort, so fix agents run through the Workflow tool.
`args.areas` holds one entry per failing area, taken from the Stage 2 output.

```js
export const meta = {
  name: 'class-board-fix-round',
  description: 'Fix failing class-board areas in parallel, one agent per area',
  phases: [{ title: 'Fix' }],
}
const RESULT = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    status: { type: 'string', enum: ['green', 'still_failing', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    rootCauses: { type: 'array', items: { type: 'string' } },
    testOutput: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['area', 'status', 'filesChanged', 'rootCauses', 'testOutput'],
}
const REPO = 'C:/Users/jacob/OneDrive/Documents/GitHub/class-board'
const results = await parallel(args.areas.map(a => () => agent(
  'Fix the "' + a.name + '" area of the class-board repo at ' + REPO + ' (branch build/v1).\n' +
  'Your files (edit only these): ' + a.files + '\n' +
  'Read master plan ' + REPO + '/docs/superpowers/plans/2026-09-29-class-board.md sections 1.4 and 2-6, ' +
  'then these plan sections for intended behavior: ' + a.planSections + '.\n' +
  'Failures to fix:\n' + a.failures + '\n' +
  'Follow the rules in section 1.4 exactly.',
  { label: a.name, phase: 'Fix', model: a.model, effort: a.effort, schema: RESULT },
)))
return results
```

### 1.6 Commits

The orchestrator commits:
- once after Stage 1
- once after each fix round, once after Stage 4, and once after the review fixes, each with a
  message naming the areas fixed

The trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## 2. Repository conventions

- **Workspaces:** `shared`, `worker`, `web`, `e2e`. Package names: `@class-board/shared`,
  `@class-board/worker`, `@class-board/web`, `@class-board/e2e`.
- **Imports from shared** go through subpaths. There's no barrel file:
  `import { SLOT_COUNT } from '@class-board/shared/constants'`,
  `import type { TileView } from '@class-board/shared/types'`. The shared `package.json` has
  `"exports": { "./*": "./src/*.ts" }`. Inside `shared/` itself, source and tests use relative
  imports (`../src/slots`, `./constants`).
- **Tests:** `<package>/test/<name>.test.ts`. Run one file with `npm test -w <package> -- <name>`,
  for example `npm test -w shared -- slots`. The `test` script for shared and web is `vitest run`.
- **Worker tests come in two kinds, so parallel agents don't break each other:**
  - `worker/test/unit/*.test.ts`: pure modules (X1–X6). They run in workerd *without* loading
    `src/index.ts`, through `worker/vitest.unit.config.ts`, so another agent editing the
    Durable Object in the same wave can't break them. Run one with
    `npm run test:unit -w worker -- <name>`.
  - `worker/test/*.test.ts`: Durable Object and integration tests (W1–W4). They load
    `src/index.ts` through `worker/vitest.config.ts`. Run one with `npm run test:do -w worker -- <name>`.
  - `npm test -w worker` runs both.
- **Optional test seams:** a module may add *optional* fields to an options or deps object, for
  example an injectable `socketFactory` or `fetchImpl`, so it can be tested. It must not add
  required fields, rename anything, or change a return type.
- **Typecheck:** each package has a `typecheck` script, `tsc --noEmit -p .`. From the root:
  `npm run typecheck` (workspaces) and `npm test` (workspaces, `--if-present`).
- **Test environments:**
  - shared: Node.
  - web: `happy-dom`.
  - worker: `@cloudflare/vitest-plugin`, running in workerd. It's the successor to
    `@cloudflare/vitest-pool-workers`, whose last release can't boot at our compatibility date.
    Tests import `env`, `SELF` and `runInDurableObject` from `cloudflare:test`, typed through a
    global `Cloudflare.Env` augmentation in `worker/test/env.d.ts` (`ProvidedEnv` no longer
    exists). **`env.BROWSER` is undefined in the Durable Object tests**, because F1 renames the
    binding so tests never launch a real Chrome; inject a fake `Shooter` instead. Test bindings are fixed:
    `TEACHER_CODE=test-code`, `BOARD_ORIGIN=https://jacobl-h.github.io`,
    `PUBLIC_URL=http://localhost:8787`,
    `ALLOWED_ORIGINS=https://jacobl-h.github.io,http://localhost:5173`, `DAILY_MESSAGE_BUDGET=2000000`.
- **Dev ports:** worker `8787` (`npm run dev -w worker`, `wrangler dev`); web `5173`
  (`npm run dev -w web`, `vite`). Local teacher passcode (`worker/.dev.vars`, gitignored): `letmein`.
- **Web config:** `VITE_SERVER_URL` defaults to `http://localhost:8787`. Vite's `base` is `/` in
  dev and `process.env.BASE_PATH ?? '/'` in builds; CI sets `BASE_PATH=/class-board/`.
- **Tests never use the real network.** Link checks use an injected `fetch`, and screenshots
  use a fake `Shooter`. `web/vitest.config.ts` turns off happy-dom's child-frame navigation,
  because happy-dom 20 otherwise fetches every attached `<iframe src>` for real.
- **Test filters match paths case-insensitively as substrings.** When a bare name could match
  another file (`panel` matches `peoplePanel` and `teacherPanel`; `board` matches every
  `board.*` file), pass the path instead: `npm test -w web -- test/panel.test.ts`.
- **Web timers:** Node's types are visible in `web`, so a bare `setTimeout` returns
  `NodeJS.Timeout` and `const t: number = setTimeout(…)` fails `tsc`. Use `window.setTimeout`
  / `window.clearTimeout` or `ReturnType<typeof setTimeout>`.
- **TypeScript 7** (the native compiler) is pinned. It has no `baseUrl`; any `paths` must start with `./`.
- **Shell:** commands are written for Git Bash on Windows. npm scripts are cross-platform.
  Git Bash rewrites `BASE_PATH=/class-board/` into a Windows path, so local production builds
  need `MSYS_NO_PATHCONV=1 BASE_PATH=/class-board/ npm run build -w web`. CI on Linux is unaffected.

---

## 3. Contract files (created by Task F2)

The code for these files is in Task F2 (§8). Once Wave 1 ends they're frozen, and any change
has to go through the orchestrator.

- `shared/src/constants.ts`: geometry, limits, rates, tiers and palettes.
- `shared/src/types.ts`: every wire type (`TileView`, `Person`, `ClientMsg`, `ServerMsg`, …).
- `worker/src/env.ts`: the Worker's `Env`.
- `web/src/contracts.ts`: interfaces between web modules.

### 3.1 Shared module exports (Tasks F3–F5; used by every workstream)

```ts
// shared/src/slots.ts — Task F3
import type { Rect, SlotIndex } from './types';
export function isSlotIndex(n: unknown): n is SlotIndex;              // integer 0..SLOT_COUNT-1
export function slotRowCol(slot: SlotIndex): { row: number; col: number }; // 0-based
export function slotName(slot: SlotIndex): string;                    // 23 → 'C4'
export function parseSlotName(name: string): SlotIndex | null;        // case-insensitive: 'c4' → 23; 'C11', 'I1', '' → null
export function tileRect(slot: SlotIndex): Rect;                      // tile body: x = col*COL_PITCH, y = row*ROW_PITCH + LABEL_H, TILE_W×TILE_H
export function labelRect(slot: SlotIndex): Rect;                     // label strip: x = col*COL_PITCH, y = row*ROW_PITCH, TILE_W×LABEL_H
export function slotAt(bx: number, by: number): SlotIndex | null;     // point inside a tile's label or body, else null
export function nearestSlot(bx: number, by: number): SlotIndex;       // tile body with the smallest distance to the point (0 inside)

// shared/src/urls.ts — Task F4 (rules: spec §5.7)
export type LinkPlan =
  | { ok: true; kind: 'generic' | 'youtube' | 'claude-published'; url: string; embedUrl: string; thumbUrl: string | null }
  | { ok: true; kind: 'claude-new'; url: string; embedUrl: null; thumbUrl: null }
  | { ok: false; reason: 'invalid' | 'scheme' | 'host' | 'too_long' };
export function planLink(input: string): LinkPlan;   // trims; normalizes via new URL(); http/https only; rejects IP-literal,
                                                      // localhost, *.local, *.internal hosts; > LIMITS.urlMax → too_long
export function originOf(url: string): string | null;
export const NOTES: {
  claudeNew: string;                                  // "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead."
  claudeAllow: (boardHost: string) => string;         // `Add ${boardHost} to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.`
  blocked: string;                                    // "This site doesn't allow embedding. Open it in a new tab."
};

// shared/src/pixelArt.ts — Task F5
export type PixelGrid = Uint8Array;                   // ART_SIZE*ART_SIZE cells, row-major, values 0..ART_MAX_INDEX
export function emptyGrid(): PixelGrid;
export function encodeArt(grid: PixelGrid): string;   // 2 cells per byte, even cell in the high nibble → base64 (172 chars)
export function decodeArt(art: string): PixelGrid | null;
export function isValidArt(art: string): boolean;
export function isValidTip(tip: unknown): tip is [number, number]; // integers 0..ART_SIZE-1
export function paletteColors(profileColor: string): Array<string | null>; // [null, profileColor, ...ART_FIXED_COLORS]

// shared/src/protocol.ts — Task F5 (valibot)
import type { ClientMsg, Profile } from './types';
export function parseClientMsg(data: unknown): ClientMsg | null;     // accepts a JSON string or an object; validates every
                                                                      // field; cleans name/label with cleanText; null when invalid
export function isValidProfile(p: unknown): p is Profile;             // name 1..nameMax after cleanText, color ∈ COLORS, valid cursor
export function cleanText(s: string, max: number): string;            // strips control chars, collapses whitespace, trims, cuts to max
export function defaultProfile(name?: string): Profile;               // { name: name ?? 'Guest', color: COLORS[0], cursor: { kind: 'shape', shape: 'arrow' } }
```

## 4. Worker module contracts

Signatures that one task implements and another consumes. The implementer must export exactly these names.

```ts
// worker/src/store.ts  — Task W1 (consumed by W2–W4, X6)
import type { Embeddable, TileKind, TileView, VersionSummary } from '@class-board/shared/types';
export interface VersionRow {
  id: number; slot: number; created_at: number;
  author_client: string; author_name: string;
  kind: TileKind; label: string;
  url: string | null; embed_url: string | null; file_id: string | null;
  title: string | null; icon: string | null; embeddable: Embeddable; note: string | null;
  shot_id: string | null; thumb_url: string | null;
}
export type NewVersion = Omit<VersionRow, 'id' | 'created_at'>;
export type VersionPatch = Partial<Pick<VersionRow, 'title' | 'icon' | 'embeddable' | 'note' | 'shot_id'>>;
export class BoardStore {
  constructor(sql: SqlStorage);
  migrate(): void;                                   // idempotent CREATE TABLE IF NOT EXISTS …
  current(slot: number): VersionRow | null;
  allCurrent(): Array<VersionRow | null>;            // length SLOT_COUNT, index = slot
  insert(v: NewVersion, now: number): VersionRow;    // also points current(slot) at the new row
  get(id: number): VersionRow | null;
  patch(id: number, p: VersionPatch): VersionRow | null;
  history(slot: number, limit: number): VersionRow[]; // newest first
  putFile(id: string, html: string, authorClient: string, now: number): void;
  getFile(id: string): string | null;
  putShot(id: string, jpeg: ArrayBuffer, now: number): void;
  getShot(id: string): ArrayBuffer | null;
  enqueueShot(versionId: number, notBefore: number): void;
  dueShot(now: number): { versionId: number; attempts: number } | null;
  retryShot(versionId: number, attempts: number, notBefore: number): void;
  dropShot(versionId: number): void;
  nextShotAt(): number | null;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
export function filePath(board: string, fileId: string): string;   // `/boards/${board}/files/${fileId}`
export function shotPath(board: string, shotId: string): string;   // `/boards/${board}/shots/${shotId}`
export function toTileView(board: string, slot: number, row: VersionRow | null): TileView;
// null row or kind 'empty' → { version: row?.id ?? 0, kind: 'empty', label: '', all nullable fields null, embeddable: 'no' }
// shotUrl = shot_id ? shotPath(board, shot_id) : thumb_url ; fileUrl = file_id ? filePath(board, file_id) : null
export function toSummary(board: string, row: VersionRow): VersionSummary;

// worker/src/frameHeaders.ts — Task X1 (consumed by X5)
export function evaluateFraming(headers: Headers, pageUrl: string, boardOrigin: string): 'yes' | 'no';
// CSP frame-ancestors (every policy that has it must allow boardOrigin) takes precedence over X-Frame-Options.
// 'none' → no; '*' → yes; scheme-source, host-source (wildcard subdomains, optional scheme/port) as per CSP3;
// 'self' matches only when origin(pageUrl) === boardOrigin. XFO: DENY → no; SAMEORIGIN → no unless same origin;
// ALLOW-FROM and unknown values are ignored. Neither header → yes.

// worker/src/limits.ts — Task X2 (consumed by W2–W4)
export class TokenBucket { constructor(ratePerSecond: number, burst: number, now: () => number); take(): boolean; }
export interface ConnLimits { cursor: TokenBucket; edit: TokenBucket; history: TokenBucket; profile: TokenBucket }
export function createConnLimits(now: () => number): ConnLimits;   // values from RATES
export class KeyedLimiter { constructor(perMinute: number, now: () => number); allow(key: string): boolean; }

// worker/src/budget.ts — Task X2 (consumed by W2)
export interface BudgetState { day: string; count: number }
export function utcDay(ms: number): string;                         // 'YYYY-MM-DD'
export class DailyBudget {
  constructor(opts: { limit: number; now: () => number; load: () => BudgetState | null; save: (s: BudgetState) => void });
  add(n?: number): void;              // counts messages; rolls over at UTC midnight
  hz(): number;                       // RATES.cursorHz below BUDGET.slowAt, RATES.cursorSlowHz below BUDGET.pauseAt, else 0
  flush(force?: boolean): void;       // calls save() if BUDGET.persistEveryMs elapsed since last save (or force)
  state(): BudgetState;
}

// worker/src/teacher.ts — Task X3 (consumed by W3)
export type TeacherCheck = 'ok' | 'bad' | 'locked_out';
export function safeEqual(a: string, b: string): boolean;          // constant-time over the longer length
export class TeacherGate {
  constructor(code: string, now: () => number);
  check(key: string, attempt: string): TeacherCheck;              // RATES.teacherAttempts wrong tries per RATES.teacherWindowMs per key
}

// worker/src/files.ts — Task X4 (consumed by W4)
export const ID_RE: RegExp;                                          // /^[0-9a-f]{32}$/
export function newId(): string;                                     // 32 lowercase hex chars from crypto.getRandomValues
export function parseOrigins(csv: string): string[];
export type UploadCheck = { ok: true; html: string; title: string } | { ok: false; code: 'too_large' | 'invalid' };
export function checkUpload(body: ArrayBuffer, fileName: string | null): UploadCheck;
// > LIMITS.htmlMaxBytes → too_large; not valid UTF-8 or no '<' → invalid; title = <title> text, else file name without extension, else 'HTML page'
export function htmlFileResponse(html: string, allowedOrigins: string[]): Response;   // headers exactly as spec §5.8
export function shotResponse(jpeg: ArrayBuffer): Response;                            // image/jpeg, immutable cache
export function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string>;
export function json(body: unknown, status?: number, headers?: Record<string, string>): Response;

// worker/src/linkCheck.ts — Task X5 (consumed by W4)
export interface LinkCheckResult { embeddable: 'yes' | 'no' | 'unknown'; title: string | null; icon: string | null }
export function checkLink(embedUrl: string, boardOrigin: string, fetchImpl?: typeof fetch): Promise<LinkCheckResult>;
// GET with LINK_CHECK.timeoutMs, manual redirects up to LINK_CHECK.maxRedirects, evaluateFraming on the final response,
// title/icon via HTMLRewriter reading at most LINK_CHECK.maxHtmlBytes; network error/timeout → 'unknown'.

// worker/src/shots.ts — Task X6 (consumed by W4)
import type { BoardStore, VersionRow } from './store';
export interface Shooter { shoot(url: string): Promise<ArrayBuffer>; close(): Promise<void>; }
export class DailyLimitError extends Error {}
export function createBrowserShooter(binding: Fetcher): Shooter;    // @cloudflare/puppeteer, one kept-alive session
export function shotTarget(row: VersionRow, board: string, publicUrl: string): string | null;
// link → embed_url for claude.ai/public/artifacts/…/embed, else url; html → `${publicUrl}${filePath(board, file_id)}`;
// rows with thumb_url (YouTube) or kind 'empty' → null
export interface ShotDeps {
  store: BoardStore; board: string; publicUrl: string;
  shooter: () => Shooter | null; now: () => number;
  onUpdated: (row: VersionRow) => void;   // called after shot_id is patched
}
export function runShotQueue(deps: ShotDeps, maxJobs?: number): Promise<number | null>; // returns the next alarm time or null
```

The Board Durable Object (W2–W4) owns `worker/src/board.ts`, `worker/src/index.ts`,
`worker/src/tiles.ts` and `worker/src/content.ts`. Their internals are defined in
`02-worker-core.md`. Externally:

- `export class Board extends Server<Env>` from `partyserver`, exported from `worker/src/index.ts`.
  Binding `Board`, so the party name is `board`.
- WebSocket: `/parties/board/<board>`, through `routePartykitRequest`.
- HTTP: `POST /boards/<board>/files`, `GET /boards/<board>/files/<id>`, `GET /boards/<board>/shots/<id>`,
  plus CORS preflight. The Worker forwards them with `env.Board.get(env.Board.idFromName(board)).fetch(request)`.
  That's one Durable Object call; `getServerByName` would make two, which counts against the free daily limit.
- Board names are checked against `BOARD_NAME_RE`; anything else gets a 404.
- Upload response: `200 {"fileId": "<32 hex>"}`. Errors: `413 {"error":"too_large"}`,
  `400 {"error":"invalid"}`, `429 {"error":"rate_limited"}`, `403 {"error":"origin"}`.

## 5. Web module contracts

Each module exports exactly the name in this table. Only `web/src/main.ts` imports concrete
modules from other workstreams; everything else imports types from `web/src/contracts.ts`
(plus `web/src/ui/*` and `web/src/util/*` helpers from Task U1).

| File (task) | Exports |
|---|---|
| `web/src/config.ts` (U7) | `SERVER_URL: string`, `BOARD: string` (from `?board=`, validated with `BOARD_NAME_RE`, default `DEFAULT_BOARD`), `BOARD_ORIGIN: string` (`location.origin`), `IS_DEV: boolean` |
| `web/src/util/url.ts` (U1) | `serverHref(serverUrl: string, path: string): string`: absolute URLs pass through, server-relative paths are resolved against `serverUrl` |
| `web/src/util/emitter.ts` (U1) | `createEmitter<E extends object>(): Emitter<E>` with `on(k, fn): Unsubscribe`, `emit(k, payload)` (the payload is optional when its type includes `undefined`), `clear()`. The constraint is `object`, not `Record<string, unknown>`, so interfaces such as `BoardStateEvents` fit. |
| `web/src/ui/dom.ts` (U1) | `h(tag, props?, ...children)`. `props` keys: `class`, `dataset` (object), `style` (object), `attrs` (object), `on` (object of listeners), plus any direct DOM property such as `type`, `value`, `hidden`, `disabled` or `textContent`. Children: `Node \| string \| number \| null \| undefined \| false`. Also `clear(el: Element): void`. |
| `web/src/ui/modal.ts` (U1) | `openModal(opts: { title: string; body: HTMLElement; dialog: string; onClose?: () => void; closable?: boolean }): { el: HTMLElement; close(): void }`. Renders `.modal[data-dialog=<dialog>]` into `#modal-root` with a `[data-action="close"]` button. Esc or the backdrop closes it unless `closable === false`. At most one modal is open; opening another closes the first. |
| `web/src/ui/banner.ts` (U1) | `showBanner(id: string, text: string, kind?: 'info' \| 'warn' \| 'error'): void`, `hideBanner(id: string): void`. Renders `#banner [data-banner=<id>]`. |
| `web/src/ui/errors.ts` (U1) | `errorText(code: ErrorCode): string`, `toast(text: string): void` (renders `#banner [data-banner="toast"]` for 4 s) |
| `web/src/net/socket.ts` (U3) | `connectBoard(opts: { serverUrl: string; board: string; hello: () => ClientMsg }): BoardSocket`, `class ServerError extends Error` (implements `ServerErrorLike`), `newReqId(): string`. Sends `hello()` on every (re)open. |
| `web/src/net/upload.ts` (U3) | `uploadHtml(serverUrl: string, board: string, html: Blob, fileName: string): Promise<string>`, `class UploadError extends Error { code: 'too_large' \| 'invalid' \| 'rate_limited' \| 'network' }` |
| `web/src/state/boardState.ts` (U4) | `createBoardState(board: string): BoardStateApi` |
| `web/src/board/camera.ts` (U2) | `createCamera(viewportW: number, viewportH: number): CameraApi` |
| `web/src/board/input.ts` (U5) | `attachInput(viewport: HTMLElement, camera: CameraApi, handlers: InputHandlers): Unsubscribe` |
| `web/src/board/grid.ts` (U6) | `createGrid(root: HTMLElement, state: BoardStateApi, actions: GridActions, serverUrl: string): GridApi` |
| `web/src/board/liveFrames.ts` (T2) | `createLiveFrames(deps: LiveFramesDeps): LiveFramesApi` |
| `web/src/board/focus.ts` (T5) | `createFocus(deps: FocusDeps): FocusApi` |
| `web/src/tiles/postDialog.ts` (T3) | `openPostDialog(deps: PostDialogDeps, slot: SlotIndex, mode: 'add' \| 'replace'): void` |
| `web/src/tiles/historyPanel.ts` (T4) | `openHistory(deps: HistoryDeps, slot: SlotIndex): void` |
| `web/src/cursors/render.ts` (C2) | `cursorImage(profile: Profile): Promise<CursorImage>`, `shapeSvg(shape: ShapeName, color: string): string`, `tagTextColor(bg: string): string`. `CursorImage.url` is an SVG data URL, 32×32 with explicit `width` and `height`. There's no canvas, so it works in happy-dom and as a CSS `cursor: url(…) x y, auto` value. |
| `web/src/cursors/local.ts` (C6) | `createLocalCursor(deps: LocalCursorDeps): LocalCursorApi` |
| `web/src/cursors/remote.ts` (C7) | `createRemoteCursors(deps: RemoteCursorsDeps): RemoteCursorsApi` |
| `web/src/profile/storage.ts` (C3) | `loadIdentity(storage?: Storage): StoredIdentity`, `saveProfile(profile: Profile, storage?: Storage): void`. Keys `classBoard.clientId` and `classBoard.profile`; every access is wrapped in try/catch. |
| `web/src/profile/panel.ts` (C8) | `openProfilePanel(opts: ProfilePanelOpts): void` |
| `web/src/teacher/teacher.ts` (C5) | `createTeacher(socket: BoardSocket, storage?: Storage): TeacherApi` (the passcode lives in `sessionStorage` under `classBoard.teacher`) |
| `web/src/teacher/teacherPanel.ts` (C9) | `openTeacherPanel(teacher: TeacherApi, state: BoardStateApi): void` |
| `web/src/people/peoplePanel.ts` (C9) | `mountPeoplePanel(deps: PeoplePanelDeps): { destroy(): void }` |
| `web/src/ui/topBar.ts` (U7) | `mountTopBar(el: HTMLElement, handlers: TopBarHandlers): TopBarApi` |
| `web/src/ui/help.ts` (U7) | `openHelp(boardHost: string): void` |

### 5.1 Page structure (`web/index.html`, Task U6)

```html
<body>
  <div id="app">
    <header id="topbar"></header>
    <main id="viewport">
      <div id="world"><div id="tiles"></div></div>
      <div id="cursor-layer"></div>
      <div id="hint"></div>
    </main>
    <div id="banner"></div>
    <div id="modal-root"></div>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- `#world` is the only element the camera transforms:
  `transform: translate(${tx}px, ${ty}px) scale(${s})` with `transform-origin: 0 0`.
  A board point `(bx, by)` appears at `(bx*s + tx, by*s + ty)` relative to `#viewport`.
- `#cursor-layer` isn't transformed. Cursors are positioned in screen pixels.
- z-index variables live in `web/src/styles/base.css` (U6): `--z-world: 1`, `--z-cursors: 10`,
  `--z-hint: 15`, `--z-topbar: 20`, `--z-banner: 25`, `--z-modal: 30`. Other color and size
  variables are defined there too, and every module's CSS uses them: `--bg`, `--surface`,
  `--border`, `--text`, `--text-muted`, `--accent`, `--danger`, `--radius`, `--font`.
- Each module imports its own CSS file (for example `import './grid.css'`). Only U6 edits `base.css`.

### 5.2 Tile element (created by Grid, Task U6)

```html
<div class="tile is-link" data-slot="23" tabindex="0" aria-label="C4, Maya, Title"
     style="left:<x>px; top:<y>px; width:480px; height:332px">
  <div class="tile-label">
    <button class="tile-name" data-action="rename">Maya</button>
    <span class="tile-slot">C4</span>
    <span class="tile-badge">HTML</span>            <!-- uploads only -->
  </div>
  <div class="tile-body">                            <!-- 480×300; gets popover="manual" in focus mode -->
    <div class="tile-card">…</div>                   <!-- Grid owns: empty/checking/card content -->
    <div class="tile-frame"></div>                   <!-- LiveFrames owns: <iframe> + .tile-shield -->
    <div class="tile-actions">
      <button data-action="open">…</button><button data-action="replace">…</button>
      <button data-action="history">…</button><button data-action="clear">…</button>  <!-- clear: teacher only -->
    </div>
    <button class="focus-back" data-action="back" hidden>← Back</button>
  </div>
</div>
```

- An empty tile's `.tile-card` contains `<button data-action="add">Add to C4</button>`.
- Grid handles clicks on every `[data-action]` inside a tile by delegation and calls the
  matching `GridActions` method: `rename` swaps the name for `input.tile-name-input` (Enter
  saves through `actions.rename`, Esc cancels), `back` calls `actions.back()`, and so on.
  `attachInput` ignores pointer events whose target is inside `[data-action]`, `input`,
  `textarea` or `.modal`.
- Grid sets classes: `is-empty`, `is-link`, `is-html`, `is-checking` (embeddable `pending`),
  `is-blocked` (embeddable `no`). It sets `#tiles.is-locked` when locked and `body.is-teacher`
  in teacher mode. LiveFrames sets `is-live` and `is-active`. Focus sets `is-focus` on the tile
  and `body.is-focusing`.
- Iframes: `width:1280px; height:800px; transform: scale(0.375); transform-origin: 0 0`, with the
  `sandbox`, `allow` and referrer rules from spec §5.9. In focus mode:
  `.tile-body:popover-open iframe { width:100%; height:100%; transform:none }`.
- The focus-mode top layer element is `.tile-body`, never `.tile`.

### 5.3 Selectors used by the e2e tests (every task producing UI must match these)

| Thing | Selector |
|---|---|
| Tile | `.tile[data-slot="<n>"]` plus the state classes above |
| Tile name / rename input | `.tile-name` / `.tile-name-input` |
| Tile buttons | `[data-action="add\|open\|replace\|history\|clear\|back"]` |
| Top bar | `#topbar [data-action="zoom-in\|zoom-out\|fit\|profile\|help\|people"]`, `[data-role="zoom"]`, `[data-role="people-count"]`, `[data-role="board-name"]`, `[data-role="teacher-badge"]` |
| Post dialog | `.modal[data-dialog="post"]`, tabs `[data-tab="link\|html"]`, `input[name="url"]`, `input[name="file"]`, `textarea[name="html"]`, `input[name="label"]`, `[data-action="submit"]`, `.dialog-error` |
| History dialog | `.modal[data-dialog="history"]`, `.history-row[data-version="<id>"]`, `[data-action="restore"]` |
| Profile dialog | `.modal[data-dialog="profile"]`, `input[name="name"]`, `[data-color="<hex>"]`, `[data-shape="<shape>"]`, `[data-tab="shape\|pixels"]`, `.pixel-grid [data-cell="<0-255>"]`, `[data-tool="pen\|eraser\|tip\|clear"]`, `[data-action="save"]` |
| Teacher section (in the profile dialog; the separate teacher dialog was removed) | `.modal[data-dialog="profile"] input[name="teacher-code"]`, `[data-action="lock\|unlock\|logout"]`, `.teacher-error` |
| People panel | `.people-panel`, `.person[data-person="<id>"]`, `.person-teacher-tag`, `[data-action="jump"]`, `[data-action="reset-cursor"]`, `[data-action="teacher"]` (opens the profile dialog) |
| Remote cursor | `#cursor-layer .cursor[data-person="<id>"]`, `.cursor-tag`; class `is-idle` when idle |
| Banner / hint | `#banner [data-banner="<id>"]` (ids: `reconnecting`, `unreachable`, `locked`, `cursors-paused`, `limit`, `toast`); `#hint.is-visible` |
| Modal close | `.modal [data-action="close"]` |

### 5.4 Debug handle (used by e2e)

In dev builds (`import.meta.env.DEV`), `main.ts` sets `window.__classBoard = { camera, state, live, focus }`.
The type is `DebugHandle` in `contracts.ts`.

### 5.5 Who subscribes to what

Modules that receive `state` or `camera` in their deps subscribe to them themselves.
`main.ts` doesn't forward those events.
- **Grid:** `'snapshot'` → `render()`; `'tile'` → `update(view.slot)`; `'locked'` → `setLocked()`.
- **LiveFrames:** `camera.onChange`, `'snapshot'`, `'tile'` → `update()`.
- **RemoteCursors:** `'cursors'`, `'people'`, `camera.onChange`.
- **Focus:** `'tile'`, to refresh the focused tile.

### 5.6 Wiring flows (implemented in `main.ts` by U8 and U9)

**Startup (U9; U8 does steps 2–5 with `defaultProfile('Guest')` and no panel):**
1. `const { clientId, profile } = loadIdentity()`. If `profile` is null, call
   `openProfilePanel({ initial: null, requireName: true, onSave })`, and connect only after
   `onSave` has run `saveProfile(p)`.
2. Create:
   - `state = createBoardState(BOARD)`
   - `camera = createCamera(viewport.clientWidth, viewport.clientHeight)`
   - `grid = createGrid(tilesEl, state, actions, SERVER_URL)`
   - `attachInput(viewport, camera, handlers)`
   - `topBar = mountTopBar(topbarEl, …)`
   - `socket = connectBoard({ serverUrl: SERVER_URL, board: BOARD, hello: () => ({ type: 'hello', clientId, profile: current }) })`

   Then `socket.onMessage(m => state.apply(m))`.
3. On `camera.onChange`, write `#world`'s transform and call `topBar.setZoom(s)`. A
   `ResizeObserver` on `#viewport` calls `camera.setViewport`. The first `'snapshot'` calls
   `camera.fitBoard()`, then `focus.start()` (U9).
4. Banners:
   - If no `'open'` status arrives within 8 s of starting: `unreachable`, with the text "Can't reach the board server at <SERVER_URL>".
   - `'closed'` after at least one `'open'`: `reconnecting`, hidden on the next `'open'`.
   - `'locked'` true: `locked`.
   - `'rate'` 0: `cursors-paused`.
5. `topBar.setBoardName(BOARD)`. On `'people'`, `topBar.setPeopleCount(state.people().length)`.
   Zoom in and out call `camera.zoomAt(vw/2, vh/2, 1.25)` or `0.8`. Fit calls `camera.fitBoard()`.
   Help calls `openHelp(new URL(BOARD_ORIGIN).host)`.

**Input handlers (U9; U8 only pans and zooms):**
- `boardPointer(bx, by)`:
  - When `focus.current() === null`, call `localCursor.boardMove(bx, by)`.
  - When `live.active() !== null` and the point is outside `tileRect(live.active())`, call `live.deactivate()`.
- `tap(slot)`:
  - `null` → `live.deactivate()`.
  - An empty tile on an unlocked board → `openPostDialog(postDeps, slot, 'add')`.
  - A tile where `live.isLive(slot)` is true → `live.activate(slot)`.
  - Anything else does nothing.
- `doubleTap(slot)` → `camera.fitSlot(slot)`. `zoomBlocked(slot)` → `focus.zoomBlocked(slot)`.

**Docking your cursor:**
- `live.onActiveChange(s)`: a slot → `localCursor.dock(s, 'using')`; `null` → `localCursor.undock()`
  unless focus mode is on.
- `focus.onChange(s)`: a slot → `localCursor.dock(s, 'viewing')`; `null` → `localCursor.undock()`.
- On `'rate'`, call `localCursor.setRate(hz)`.

**Grid actions:**
- `add` / `replace` → `openPostDialog(postDeps, slot, mode)`.
- `history` → `openHistory(historyDeps, slot)`.
- `open` → `window.open(tile.url ?? serverHref(SERVER_URL, tile.fileUrl!), '_blank', 'noopener,noreferrer')`.
- `clear` → `teacher.clear(slot)`.
- `rename` → `socket.request({ type: 'rename', reqId: newReqId(), slot, baseVersion: state.tile(slot).version, label })`.
- `focus` → `focus.enter(slot)`. `back` → `focus.exit()`.
- Any rejection calls `toast(errorText(e.code))`.
- `postDeps = { socket, state, upload: (b, n) => uploadHtml(SERVER_URL, BOARD, b, n), defaultLabel: () => current.name }`.
- `historyDeps = { socket, state, serverUrl: SERVER_URL, canRestore: () => !state.locked() || teacher.active() }`.

**Profile:**
- The top bar's profile button calls `openProfilePanel({ initial: current, requireName: true, onSave })`.
  `onSave` sets `current`, runs `saveProfile`, sends `{ type: 'profile', profile }`, calls
  `localCursor.applyDesign`, and calls `topBar.setCursorPreview((await cursorImage(p)).url)`.
- On `'people'`, if `state.me()`'s profile differs from `current` (the teacher reset it), adopt
  it: `saveProfile`, then `applyDesign`.

**Teacher and people:**
- `teacher = createTeacher(socket)`.
- `teacher.onChange(on)` → `grid.setTeacher(on)`, `topBar.setTeacher(on)`, and `document.body.classList.toggle('is-teacher', on)`.
- `mountPeoplePanel({ button: topBar.peopleButton, state, teacher, onJump, onTeacher: () => openTeacherPanel(teacher, state) })`.
- `onJump(person)`:
  - When the person is on a tile → `camera.fitSlot(slot)`.
  - Otherwise → `camera.centerOn(x, y)` at their last position. `main.ts` records the last
    position per person from the `'cursors'` events.

**Other pieces:** `createRemoteCursors({ layer, camera, state }).start()`,
`createLocalCursor({ viewport, socket })` followed by `applyDesign(current)`, and the debug
handle (§5.4).

## 6. Wire conventions

- PartySocket: `new PartySocket({ host: <SERVER_URL host>, protocol: 'ws' | 'wss' (from SERVER_URL), party: 'board', room: <board> })`.
- The client sends `hello` as the first message after every open. The server answers with
  `snapshot`. Anything sent before `hello` gets `error` code `not_ready`.
- `request()` messages carry `reqId` (`newReqId()`: 12 random base36 characters). The server
  answers each with exactly one `ok`, `historyResult` or `error` carrying the same `reqId`.
- `TileView.fileUrl` and `TileView.shotUrl` may be server-relative. The web resolves them with
  `serverHref(SERVER_URL, path)`.
- Error-code meanings, shared by the server and `errorText()`:
  - `invalid`: bad input
  - `locked`: the board is locked
  - `conflict`: `baseVersion` is stale
  - `rate_limited`
  - `too_large`
  - `bad_code`: wrong teacher passcode
  - `locked_out`: too many wrong passcodes
  - `not_found`: unknown version or person
  - `full`: 150 connections; the server then closes the socket
  - `not_ready`: no `hello` yet

---

## 7. Task index

The fast path (§1) doesn't run these waves or tiers. This table maps each task to its files and plan section; the waves record the dependency order `materialize.mjs` applies, and the tiers show how hard each part was to design.

`File` is the workstream file under `docs/superpowers/plans/2026-09-29-class-board/`.

| Wave | Task | Title | Tier | Files (all under the repo root) | File |
|---|---|---|---|---|---|
| 1 | F1 | Scaffold workspaces, install all deps, configs, smoke tests | T2 | root `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`; `shared/{package.json,tsconfig.json,vitest.config.ts,test/smoke.test.ts}`; `worker/{package.json,tsconfig.json,vitest.config.ts,vitest.unit.config.ts,wrangler.jsonc,.dev.vars.example,test/env.d.ts,test/smoke.test.ts,test/unit/smoke.test.ts,src/index.ts}`; `web/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,src/vite-env.d.ts,test/smoke.test.ts}`; `e2e/{package.json,tsconfig.json}` | 01-foundation.md |
| 1 | F2 | Contract files (after F1) | T0 | `shared/src/constants.ts`, `shared/src/types.ts`, `worker/src/env.ts`, `web/src/contracts.ts`, `shared/test/constants.test.ts` | this file, §8 |
| 1 | F3 | Slot names and geometry (after F2; U2 needs it in wave 2) | T0 | `shared/src/slots.ts`, `shared/test/slots.test.ts` | 01-foundation.md |
| 2 | F4 | Link planning and rewrites | T1 | `shared/src/urls.ts`, `shared/test/urls.test.ts` | 01-foundation.md |
| 2 | F5 | Pixel-art codec and message validation | T1 | `shared/src/pixelArt.ts`, `shared/src/protocol.ts`, `shared/test/pixelArt.test.ts`, `shared/test/protocol.test.ts` | 01-foundation.md |
| 2 | W1 | BoardStore (SQLite) | T2 | `worker/src/store.ts`, `worker/test/store.test.ts` | 02-worker-core.md |
| 2 | X1 | Frame-header evaluation | T1 | `worker/src/frameHeaders.ts`, `worker/test/unit/frameHeaders.test.ts` | 03-worker-leaves.md |
| 2 | X2 | Token buckets and daily budget | T1 | `worker/src/limits.ts`, `worker/src/budget.ts`, `worker/test/unit/limits.test.ts`, `worker/test/unit/budget.test.ts` | 03-worker-leaves.md |
| 2 | X3 | Teacher gate | T0 | `worker/src/teacher.ts`, `worker/test/unit/teacher.test.ts` | 03-worker-leaves.md |
| 2 | X4 | Upload checks and file responses | T1 | `worker/src/files.ts`, `worker/test/unit/files.test.ts` | 03-worker-leaves.md |
| 2 | U1 | DOM, emitter, URL, modal, banner and error helpers | T0 | `web/src/ui/dom.ts`, `web/src/util/emitter.ts`, `web/src/util/url.ts`, `web/src/ui/modal.ts`, `web/src/ui/modal.css`, `web/src/ui/banner.ts`, `web/src/ui/errors.ts`, `web/test/dom.test.ts`, `web/test/emitter.test.ts`, `web/test/url.test.ts`, `web/test/modal.test.ts`, `web/test/banner.test.ts` | 04-web-core-a.md |
| 2 | U2 | Camera | T2 | `web/src/board/camera.ts`, `web/test/camera.test.ts` | 04-web-core-a.md |
| 2 | U3 | Socket and upload client | T2 | `web/src/net/socket.ts`, `web/src/net/upload.ts`, `web/test/socket.test.ts`, `web/test/upload.test.ts` | 04-web-core-a.md |
| 2 | U4 | Board state | T1 | `web/src/state/boardState.ts`, `web/test/boardState.test.ts` | 04-web-core-a.md |
| 2 | T1 | chooseLive (pure selection) | T2 | `web/src/board/chooseLive.ts`, `web/test/chooseLive.test.ts` | 06-web-tiles.md |
| 2 | C1 | Throttle and interpolation | T1 | `web/src/cursors/throttle.ts`, `web/src/cursors/interpolate.ts`, `web/test/throttle.test.ts`, `web/test/interpolate.test.ts` | 07-web-cursors.md |
| 3 | X5 | Link check | T2 | `worker/src/linkCheck.ts`, `worker/test/unit/linkCheck.test.ts` | 03-worker-leaves.md |
| 3 | X6 | Screenshot queue | T2 | `worker/src/shots.ts`, `worker/test/unit/shots.test.ts` | 03-worker-leaves.md |
| 3 | W2 | Board Durable Object core: connect, hello, snapshot, profile, cursors, presence, budget, WS routing | T4 | `worker/src/board.ts`, `worker/src/index.ts`, `worker/test/board.session.test.ts`, `worker/test/helpers.ts` | 02-worker-core.md |
| 3 | U5 | Input (pan, zoom, tap, keys, touch) | T3 | `web/src/board/input.ts`, `web/test/input.test.ts` | 05-web-core-b.md |
| 3 | U6 | Page shell, base styles, grid | T2 | `web/index.html`, `web/src/styles/base.css`, `web/src/board/grid.ts`, `web/src/board/grid.css`, `web/test/grid.test.ts` | 05-web-core-b.md |
| 3 | U7 | Config, top bar, help | T0 | `web/src/config.ts`, `web/src/ui/topBar.ts`, `web/src/ui/topbar.css`, `web/src/ui/help.ts`, `web/test/topBar.test.ts` | 04-web-core-a.md |
| 3 | T2 | Live frames manager | T3 | `web/src/board/liveFrames.ts`, `web/src/board/frames.css`, `web/test/liveFrames.test.ts` | 06-web-tiles.md |
| 3 | C2 | Cursor images | T2 | `web/src/cursors/render.ts`, `web/test/render.test.ts` | 07-web-cursors.md |
| 3 | C4 | Pixel editor | T2 | `web/src/profile/pixelEditor.ts`, `web/src/profile/pixelEditor.css`, `web/test/pixelEditor.test.ts` | 07-web-cursors.md |
| 3 | C5 | Teacher session | T1 | `web/src/teacher/teacher.ts`, `web/test/teacher.test.ts` | 07-web-cursors.md |
| 3 | C3 | Profile storage (imports F5, so wave 3) | T0 | `web/src/profile/storage.ts`, `web/test/storage.test.ts` | 07-web-cursors.md |
| 4 | W3 | Tile edits: post, rename, restore, history, lock, clear, reset cursor | T3 | `worker/src/tiles.ts`, `worker/src/board.ts`, `worker/test/board.tiles.test.ts` | 02-worker-core.md |
| 4 | U8 | main.ts stage 1: board, camera, grid, socket, top bar | T2 | `web/src/main.ts` | 05-web-core-b.md |
| 4 | T3 | Post dialog | T2 | `web/src/tiles/postDialog.ts`, `web/src/tiles/postDialog.css`, `web/test/postDialog.test.ts` | 06-web-tiles.md |
| 4 | T4 | History panel | T1 | `web/src/tiles/historyPanel.ts`, `web/src/tiles/history.css`, `web/test/historyPanel.test.ts` | 06-web-tiles.md |
| 4 | T5 | Focus mode | T3 | `web/src/board/focus.ts`, `web/src/board/focus.css`, `web/test/focus.test.ts` | 06-web-tiles.md |
| 4 | C6 | Local cursor | T2 | `web/src/cursors/local.ts`, `web/test/local.test.ts` | 07-web-cursors.md |
| 4 | C7 | Remote cursors | T2 | `web/src/cursors/remote.ts`, `web/src/cursors/cursors.css`, `web/test/remote.test.ts` | 07-web-cursors.md |
| 4 | C8 | Profile panel | T2 | `web/src/profile/panel.ts`, `web/src/profile/panel.css`, `web/test/panel.test.ts` | 07-web-cursors.md |
| 4 | C9 | People panel and teacher panel | T2 | `web/src/people/peoplePanel.ts`, `web/src/people/people.css`, `web/src/teacher/teacherPanel.ts`, `web/test/peoplePanel.test.ts`, `web/test/teacherPanel.test.ts` | 07-web-cursors.md |
| 5 | W4 | Content: link checks after posting, upload/file/shot routes, screenshot alarm | T3 | `worker/src/content.ts`, `worker/src/board.ts`, `worker/src/index.ts`, `worker/test/board.content.test.ts` | 02-worker-core.md |
| 5 | U9 | main.ts stage 2: live frames, focus, dialogs, cursors, profile, people, teacher, banners | T4 | `web/src/main.ts` | 05-web-core-b.md |
| 5 | E2 | GitHub Pages workflow | T0 | `.github/workflows/pages.yml` | 08-e2e-launch.md |
| 5 | E3 | README, runbook, load test | T0 | `README.md`, `docs/runbook.md`, `scripts/loadtest.mjs` | 08-e2e-launch.md |
| 6 | E1 | End-to-end tests | T3 | `e2e/playwright.config.ts`, `e2e/tests/*.spec.ts`, `e2e/fixtures/*` | 08-e2e-launch.md |
| 7 | V1 | Full verification plus manual browser check (orchestrator) | — | none | 08-e2e-launch.md |
| 7 | V2 | Final single-pass review | T4 | none (report only) | 08-e2e-launch.md |

Dependency check: every task depends only on earlier waves and the Wave 1 contracts. The
only files edited in more than one wave are `worker/src/board.ts` (W2 → W3 → W4),
`worker/src/index.ts` (W2 → W4) and `web/src/main.ts` (U8 → U9), and those waves run in sequence.

---

## 8. Task F2: Contract files

**Wave:** 1 (after F1) · **Tier:** T0 (`haiku`) · **Depends on:** F1

**Files:**
- Create: `shared/src/constants.ts`, `shared/src/types.ts`, `worker/src/env.ts`, `web/src/contracts.ts`
- Test: `shared/test/constants.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/test/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BOARD_H, BOARD_W, COL_PITCH, COLORS, ROW_PITCH, SHAPES, SLOT_COUNT, ART_FIXED_COLORS,
} from '../src/constants';

describe('constants', () => {
  it('derives board geometry from tiles, labels and gutters', () => {
    expect(SLOT_COUNT).toBe(80);
    expect(COL_PITCH).toBe(528);
    expect(ROW_PITCH).toBe(380);
    expect(BOARD_W).toBe(5232);
    expect(BOARD_H).toBe(2992);
  });

  it('has 12 distinct cursor colors, 6 shapes and 7 fixed pixel colors', () => {
    expect(new Set(COLORS).size).toBe(12);
    expect(SHAPES).toEqual(['arrow', 'hand', 'pencil', 'star', 'plane', 'crosshair']);
    expect(ART_FIXED_COLORS).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w shared -- constants`
Expected: FAIL, "Failed to resolve import '../src/constants'" (or "Cannot find module").

- [ ] **Step 3: Create `shared/src/constants.ts`**

```ts
/** Grid: 8 rows (A–H) × 10 columns (1–10). */
export const ROWS = 8;
export const COLS = 10;
export const SLOT_COUNT = ROWS * COLS;

/** Board geometry in board units (1 unit = 1 CSS px at zoom 1). */
export const TILE_W = 480;
export const TILE_H = 300;
export const LABEL_H = 32;
export const GUTTER = 48;
export const COL_PITCH = TILE_W + GUTTER;
export const ROW_PITCH = LABEL_H + TILE_H + GUTTER;
export const BOARD_W = COLS * TILE_W + (COLS - 1) * GUTTER;
export const BOARD_H = ROWS * (LABEL_H + TILE_H) + (ROWS - 1) * GUTTER;

/** Embedded pages render at this size and are scaled down to the tile. */
export const FRAME_W = 1280;
export const FRAME_H = 800;
export const FRAME_SCALE = TILE_W / FRAME_W;

export const DEFAULT_BOARD = 'main';
export const BOARD_NAME_RE = /^[a-z0-9-]{1,40}$/;

export const LIMITS = {
  nameMax: 24,
  labelMax: 40,
  urlMax: 2048,
  htmlMaxBytes: 1_000_000,
  maxConnections: 150,
  historyLimit: 50,
} as const;

export const RATES = {
  cursorHz: 5,
  cursorSlowHz: 2,
  cursorBatchMs: 100,
  cursorPerSecond: 6,
  cursorBurst: 10,
  editsPerMinute: 10,
  historyPerMinute: 30,
  profilePerMinute: 10,
  teacherAttempts: 5,
  teacherWindowMs: 10 * 60_000,
  uploadsPerMinute: 5,
} as const;

export const BUDGET = {
  dailyMessages: 2_000_000,
  slowAt: 0.8,
  pauseAt: 0.9,
  persistEveryMs: 30_000,
} as const;

export const LIVE = {
  maxLive: 12,
  maxLiveLowMemory: 6,
  lowMemoryGb: 4,
  minWidthPx: 240,
  lingerMs: 2_000,
  mountBatch: 2,
  mountIntervalMs: 250,
} as const;

export const CURSOR = {
  idleMs: 20_000,
  idleOpacity: 0.35,
  renderDelayMs: 200,
  jumpGapMs: 1_000,
  imageSize: 32,
} as const;

export const FOCUS = { holdMs: 300 } as const;

export const LINK_CHECK = { timeoutMs: 5_000, maxRedirects: 5, maxHtmlBytes: 262_144 } as const;

export const SHOTS = {
  viewportW: 1280,
  viewportH: 800,
  maxWaitMs: 15_000,
  jpegQuality: 70,
  maxAttempts: 3,
  keepAliveMs: 600_000,
} as const;

/** The 12 cursor colors offered in the profile panel. */
export const COLORS = [
  '#D85A30', '#D4537E', '#7F77DD', '#378ADD', '#1D9E75', '#639922',
  '#BA7517', '#E24B4A', '#534AB7', '#0F6E56', '#993556', '#5F5E5A',
] as const;

export const SHAPES = ['arrow', 'hand', 'pencil', 'star', 'plane', 'crosshair'] as const;

/** Pixel cursors: 16×16 cells. Palette index 0 = transparent, 1 = the profile color, 2–8 = these. */
export const ART_SIZE = 16;
export const ART_FIXED_COLORS = ['#000000', '#FFFFFF', '#E24B4A', '#EF9F27', '#639922', '#378ADD', '#7F77DD'] as const;
export const ART_MAX_INDEX = 1 + ART_FIXED_COLORS.length;
```

- [ ] **Step 4: Create `shared/src/types.ts`**

```ts
import type { SHAPES } from './constants';

export type SlotIndex = number;
export type ShapeName = (typeof SHAPES)[number];

export interface Rect { x: number; y: number; w: number; h: number }

export type CursorDesign =
  | { kind: 'shape'; shape: ShapeName }
  | { kind: 'pixels'; art: string; tip: [number, number] };

export interface Profile {
  name: string;
  color: string;
  cursor: CursorDesign;
}

export type Presence =
  | { at: 'board' }
  | { at: 'tile'; slot: SlotIndex; mode: 'using' | 'viewing' }
  | { at: 'away' };

export interface Person {
  /** Connection id: one per open tab. */
  id: string;
  /** Browser id from localStorage. */
  clientId: string;
  profile: Profile;
  presence: Presence;
}

export type TileKind = 'empty' | 'link' | 'html';
export type Embeddable = 'yes' | 'no' | 'unknown' | 'pending';

export interface TileView {
  slot: SlotIndex;
  /** Id of the current version; 0 when the slot has never been posted to. */
  version: number;
  kind: TileKind;
  label: string;
  /** Original link, used by Open in new tab. */
  url: string | null;
  /** Iframe src for links (after rewrites). */
  embedUrl: string | null;
  /** Server-relative path of an upload: /boards/<board>/files/<id>. */
  fileUrl: string | null;
  title: string | null;
  icon: string | null;
  embeddable: Embeddable;
  note: string | null;
  /** Absolute (YouTube thumbnail) or server-relative (/boards/<board>/shots/<id>). */
  shotUrl: string | null;
  authorName: string | null;
  createdAt: number | null;
}

export interface VersionSummary {
  id: number;
  slot: SlotIndex;
  kind: TileKind;
  label: string;
  title: string | null;
  url: string | null;
  fileUrl: string | null;
  shotUrl: string | null;
  authorName: string | null;
  createdAt: number;
}

export type PostContent = { kind: 'link'; url: string } | { kind: 'html'; fileId: string };

export type TeacherAction = 'check' | 'lock' | 'unlock' | 'clear' | 'resetCursor';

export type ClientMsg =
  | { type: 'hello'; clientId: string; profile: Profile }
  | { type: 'profile'; profile: Profile }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'dock'; slot: SlotIndex; mode: 'using' | 'viewing' }
  | { type: 'away' }
  | { type: 'post'; reqId: string; slot: SlotIndex; baseVersion: number; content: PostContent; label: string }
  | { type: 'rename'; reqId: string; slot: SlotIndex; baseVersion: number; label: string }
  | { type: 'restore'; reqId: string; slot: SlotIndex; baseVersion: number; versionId: number }
  | { type: 'history'; reqId: string; slot: SlotIndex }
  | { type: 'teacher'; reqId: string; code: string; action: TeacherAction; slot?: SlotIndex; target?: string };

export type RequestMsg = Extract<ClientMsg, { reqId: string }>;

export type ErrorCode =
  | 'invalid'
  | 'locked'
  | 'conflict'
  | 'rate_limited'
  | 'too_large'
  | 'bad_code'
  | 'locked_out'
  | 'not_found'
  | 'full'
  | 'not_ready';

export type CursorMove = [id: string, x: number, y: number];

export type ServerMsg =
  | { type: 'snapshot'; board: string; you: string; tiles: TileView[]; locked: boolean; people: Person[]; rate: number }
  | { type: 'cursors'; moves: CursorMove[] }
  | { type: 'person'; event: 'joined' | 'updated'; person: Person }
  | { type: 'personLeft'; id: string }
  | { type: 'tile'; view: TileView }
  | { type: 'locked'; locked: boolean }
  | { type: 'rate'; hz: number }
  | { type: 'ok'; reqId: string }
  | { type: 'historyResult'; reqId: string; slot: SlotIndex; versions: VersionSummary[] }
  | { type: 'error'; reqId: string | null; code: ErrorCode; message: string };
```

- [ ] **Step 5: Create `worker/src/env.ts`**

```ts
/** Bindings and variables for the Worker and the Board Durable Object (see wrangler.jsonc). */
export interface Env {
  Board: DurableObjectNamespace;
  /** Browser Rendering binding. Absent or failing in local dev: screenshots are skipped. */
  BROWSER?: Fetcher;
  /** Comma-separated origins allowed to connect, upload and frame uploaded files. */
  ALLOWED_ORIGINS: string;
  /** The board site's origin, used to decide whether a page allows being framed. */
  BOARD_ORIGIN: string;
  /** This Worker's public base URL (no trailing slash), used to screenshot uploads. */
  PUBLIC_URL: string;
  TEACHER_CODE: string;
  DAILY_MESSAGE_BUDGET?: string;
}
```

- [ ] **Step 6: Create `web/src/contracts.ts`**

```ts
/**
 * Interfaces between web modules. Modules depend on these, never on each other's
 * concrete code, so they can be built in parallel. Only main.ts imports concrete factories.
 */
import type {
  ClientMsg, CursorMove, ErrorCode, Person, Profile, Rect, RequestMsg, ServerMsg, SlotIndex, TileView,
} from '@class-board/shared/types';

export type Unsubscribe = () => void;

/* ---------- net/socket.ts ---------- */

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface BoardSocket {
  /** Fire-and-forget; dropped while the socket isn't open. */
  send(msg: ClientMsg): void;
  /** Resolves with the matching 'ok' or 'historyResult'; rejects with a ServerErrorLike (code 'not_ready' after 10 s without an answer). */
  request(msg: RequestMsg): Promise<Extract<ServerMsg, { type: 'ok' | 'historyResult' }>>;
  onMessage(fn: (msg: ServerMsg) => void): Unsubscribe;
  onStatus(fn: (status: SocketStatus) => void): Unsubscribe;
  status(): SocketStatus;
  close(): void;
}

export interface ServerErrorLike extends Error {
  code: ErrorCode;
}

/* ---------- state/boardState.ts ---------- */

export interface BoardStateEvents {
  snapshot: undefined;
  tile: TileView;
  people: undefined;
  locked: boolean;
  rate: number;
  cursors: CursorMove[];
}

export interface BoardStateApi {
  board(): string;
  you(): string | null;
  locked(): boolean;
  rate(): number;
  /** True once the first snapshot has been applied. */
  ready(): boolean;
  tiles(): readonly TileView[];
  tile(slot: SlotIndex): TileView;
  people(): readonly Person[];
  person(id: string): Person | undefined;
  me(): Person | undefined;
  apply(msg: ServerMsg): void;
  on<K extends keyof BoardStateEvents>(event: K, fn: (payload: BoardStateEvents[K]) => void): Unsubscribe;
}

/* ---------- board/camera.ts ---------- */

export interface CameraState { s: number; tx: number; ty: number }

export interface CameraApi {
  state(): CameraState;
  viewport(): { w: number; h: number };
  setViewport(w: number, h: number): void;
  /** Scale at which the whole board fits the viewport with a margin. */
  minScale(): number;
  /** Scale at which the slot's tile body exactly fills the viewport (contain). */
  maxScaleForSlot(slot: SlotIndex): number;
  toScreen(bx: number, by: number): { x: number; y: number };
  toBoard(sx: number, sy: number): { x: number; y: number };
  /** factor > 1 zooms in around (sx, sy). blockedIn is true when a zoom-in was clamped by maxScaleForSlot(slot), slot being the one nearest the pointer. */
  zoomAt(sx: number, sy: number, factor: number): { blockedIn: boolean; slot: SlotIndex };
  panBy(dx: number, dy: number): void;
  fitBoard(): void;
  fitSlot(slot: SlotIndex): void;
  centerOn(bx: number, by: number): void;
  /** The slot's tile body in viewport pixels. */
  slotScreenRect(slot: SlotIndex): Rect;
  onChange(fn: (state: CameraState) => void): Unsubscribe;
}

/* ---------- board/input.ts ---------- */

export interface InputHandlers {
  /** Pointer moved over the board (never fires while the pointer is inside an active iframe). */
  boardPointer(bx: number, by: number): void;
  /** Click/tap without dragging. slot is null on the background. */
  tap(slot: SlotIndex | null): void;
  doubleTap(slot: SlotIndex): void;
  /** Wheel/pinch zoom-in was blocked at the max for this slot (drives focus mode). */
  zoomBlocked(slot: SlotIndex): void;
  pointerLeft(): void;
}

/* ---------- board/grid.ts ---------- */

export interface GridActions {
  add(slot: SlotIndex): void;
  replace(slot: SlotIndex): void;
  history(slot: SlotIndex): void;
  open(slot: SlotIndex): void;
  clear(slot: SlotIndex): void;
  rename(slot: SlotIndex, label: string): void;
  /** Enter key on a focused tile. */
  focus(slot: SlotIndex): void;
  /** The focus-mode Back button. */
  back(): void;
}

export interface GridApi {
  tileEl(slot: SlotIndex): HTMLElement;
  /** .tile-body: the element promoted to the top layer in focus mode. */
  bodyEl(slot: SlotIndex): HTMLElement;
  /** .tile-frame: owned by the live frames manager. */
  frameHost(slot: SlotIndex): HTMLElement;
  render(): void;
  update(slot: SlotIndex): void;
  setLocked(locked: boolean): void;
  setTeacher(on: boolean): void;
  destroy(): void;
}

/* ---------- board/liveFrames.ts ---------- */

export interface LiveFramesDeps {
  grid: GridApi;
  camera: CameraApi;
  state: BoardStateApi;
  serverUrl: string;
  boardOrigin: string;
  deviceMemory?: number;
  now?: () => number;
  /** Defaults to requestAnimationFrame. */
  schedule?: (fn: () => void) => void;
}

export interface LiveFramesApi {
  /** Recompute which tiles are live (cheap; call on camera or state changes). */
  update(): void;
  isLive(slot: SlotIndex): boolean;
  active(): SlotIndex | null;
  /** Remove the shield so the page receives input ("in use"). */
  activate(slot: SlotIndex): void;
  deactivate(): void;
  /** Keep a tile live regardless of the cap (focus mode). */
  pin(slot: SlotIndex): void;
  unpin(slot: SlotIndex): void;
  onActiveChange(fn: (slot: SlotIndex | null) => void): Unsubscribe;
  destroy(): void;
}

/* ---------- board/focus.ts ---------- */

export interface FocusDeps {
  grid: GridApi;
  live: LiveFramesApi;
  camera: CameraApi;
  state: BoardStateApi;
  hintEl: HTMLElement;
  serverUrl: string;
  win?: Window;
  now?: () => number;
}

export interface FocusApi {
  current(): SlotIndex | null;
  enter(slot: SlotIndex, opts?: { push?: boolean }): void;
  exit(opts?: { fromHistory?: boolean }): void;
  /** Called on every blocked zoom-in; enters after FOCUS.holdMs of continued blocking on the same slot. */
  zoomBlocked(slot: SlotIndex): void;
  /** Call once after the first snapshot: honors a #C4 hash and starts listening to popstate. */
  start(): void;
  onChange(fn: (slot: SlotIndex | null) => void): Unsubscribe;
  destroy(): void;
}

/* ---------- tiles ---------- */

export interface PostDialogDeps {
  socket: BoardSocket;
  state: BoardStateApi;
  /** Uploads HTML and resolves with the file id. */
  upload: (html: Blob, fileName: string) => Promise<string>;
  /** The poster's cursor name, used as the default label. */
  defaultLabel: () => string;
}

export interface HistoryDeps {
  socket: BoardSocket;
  state: BoardStateApi;
  serverUrl: string;
  canRestore: () => boolean;
}

/* ---------- cursors ---------- */

export interface CursorImage { url: string; tipX: number; tipY: number; size: number }

export interface LocalCursorDeps {
  viewport: HTMLElement;
  socket: BoardSocket;
  now?: () => number;
  doc?: Document;
}

export interface LocalCursorApi {
  /** Renders the design and applies it as the CSS cursor on the viewport. */
  applyDesign(profile: Profile): Promise<void>;
  /** Throttled position send. */
  boardMove(bx: number, by: number): void;
  dock(slot: SlotIndex, mode: 'using' | 'viewing'): void;
  undock(): void;
  /** Hz from the server's rate message; 0 pauses sending. */
  setRate(hz: number): void;
  destroy(): void;
}

export interface RemoteCursorsDeps {
  layer: HTMLElement;
  camera: CameraApi;
  state: BoardStateApi;
  now?: () => number;
}

export interface RemoteCursorsApi {
  start(): void;
  stop(): void;
}

/* ---------- profile ---------- */

export interface StoredIdentity { clientId: string; profile: Profile | null }

export interface ProfilePanelOpts {
  initial: Profile | null;
  /** When true the panel can't be closed until a valid name is entered. */
  requireName: boolean;
  onSave: (profile: Profile) => void;
}

/* ---------- teacher and people ---------- */

export type TeacherLogin = 'ok' | 'bad' | 'locked_out';

export interface TeacherApi {
  active(): boolean;
  login(code: string): Promise<TeacherLogin>;
  logout(): void;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  clear(slot: SlotIndex): Promise<void>;
  resetCursor(personId: string): Promise<void>;
  onChange(fn: (active: boolean) => void): Unsubscribe;
}

export interface PeoplePanelDeps {
  button: HTMLElement;
  state: BoardStateApi;
  teacher: TeacherApi;
  onJump: (person: Person) => void;
  onTeacher: () => void;
}

/* ---------- ui/topBar.ts ---------- */

export interface TopBarHandlers {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  profile(): void;
  help(): void;
}

export interface TopBarApi {
  peopleButton: HTMLElement;
  setBoardName(name: string): void;
  setPeopleCount(n: number): void;
  setZoom(scale: number): void;
  setTeacher(on: boolean): void;
  setCursorPreview(url: string | null): void;
}

/* ---------- debug handle (dev builds only; used by e2e) ---------- */

export interface DebugHandle {
  camera: CameraApi;
  state: BoardStateApi;
  live: LiveFramesApi;
  focus: FocusApi;
}

declare global {
  interface Window {
    __classBoard?: DebugHandle;
  }
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npm test -w shared -- constants`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit (orchestrator)**

```bash
git add shared/src/constants.ts shared/src/types.ts worker/src/env.ts web/src/contracts.ts shared/test/constants.test.ts
git commit -m "feat(contracts): shared constants, wire types, worker env, web interfaces (F2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 9. Workstream files

| File | Tasks | Written by |
|---|---|---|
| `2026-09-29-class-board/01-foundation.md` | F1, F3, F4, F5 | plan agent P1 |
| `2026-09-29-class-board/02-worker-core.md` | W1, W2, W3, W4 | plan agent P2 |
| `2026-09-29-class-board/03-worker-leaves.md` | X1–X6 | plan agent P3 |
| `2026-09-29-class-board/04-web-core-a.md` | U1, U2, U3, U4, U7 | plan agent P4a |
| `2026-09-29-class-board/05-web-core-b.md` | U5, U6, U8, U9 | plan agent P4b |
| `2026-09-29-class-board/06-web-tiles.md` | T1–T5 | plan agent P5 |
| `2026-09-29-class-board/07-web-cursors.md` | C1–C9 | plan agent P6 |
| `2026-09-29-class-board/08-e2e-launch.md` | E1, E2, E3, V1, V2, plus deploy steps | plan agent P7 |

## 10. Spike results

1. **Focus mode through the Popover API: verified on 2026-09-29 in Chromium.** Inside a
   `#world` scaled to 0.3, adding `popover="manual"` to the tile element and calling
   `showPopover()` moved it to 0,0 at 1024×768 (the whole viewport, instead of its transformed
   386×242). The iframe's page kept counting with no reload (its `load` event fired once) and
   re-laid out at 1024 px wide. `hidePopover()` plus removing the attribute put it back on the
   board, again with no reload. An element with the `popover` attribute is `display:none`
   until shown, so add the attribute only when entering and remove it on exit. Firefox and
   Safari are unverified; E1 checks them if their Playwright browsers are available.
2. **Browser Rendering from a Durable Object on the free plan:** not verified yet (it needs
   the owner's Cloudflare account). It's checked at first deploy (runbook in
   `08-e2e-launch.md`). Fallback: the REST `/screenshot` endpoint called with an API token.
3. **PartyServer hibernation with connection state:** covered by W2's tests.

## 11. Decisions made while assembling the plan

The eight plan agents raised these points, and the orchestrator settled them. The workstream
files already reflect each one.

**Tooling**
- `@cloudflare/vitest-plugin` 1.3.3 replaces `@cloudflare/vitest-pool-workers` (see §2).
  Pinned versions are in `01-foundation.md` F1: TypeScript 7.0.2 (fall back to 6.0.3 only if a
  compiler incompatibility shows up), Vitest 4.1.11, Vite 8.3.1, wrangler 4.144.0, partyserver
  0.5.10, partysocket 1.3.0, valibot 1.5.0, happy-dom 20.14.5, Playwright 1.63.0.
- `npm audit` reports 3 high findings through `@cloudflare/puppeteer`'s `extract-zip`, which
  isn't bundled into the Worker. Never run `npm audit fix --force`; it downgrades puppeteer to 0.0.11.

**Schedule**
- F3 moved to Wave 1, because U2 imports it.
- C3 moved to Wave 3, because it imports F5.

**Security and cost**
- `TeacherGate` never accepts anything when `TEACHER_CODE` is empty (X3). Otherwise a missing
  secret would let anyone in with an empty passcode.
- File and screenshot requests are forwarded with `idFromName` (§4), which is one Durable
  Object call instead of two.
- Connection ids come from the client (`?_pk=`) and can't be trusted. W2 iterates
  `getConnections()` rather than calling `getConnection(id)`, so a duplicate id can't crash it.
  This is accepted for a class of known students.
- `TeacherGate` is keyed by connection id, so reconnecting resets the wrong-try count. Accepted.

**Behavior** (these changes and deviations from the briefs are accepted)
- Focus mode never opens an empty tile, whether by zooming or through a `#A1` link (T5).
- Leaving focus mode through the browser's back or forward buttons leaves history alone (T5).
- The names above tiles scale with a `--cam-s` CSS variable that `main.ts` sets on `#world`, so
  they stay readable on the zoomed-out overview (U6 `grid.css`, U8/U9 `applyCamera`).
- Newer Claude artifacts (`claude.ai/artifact/…`) get no screenshot (`shotTarget` returns null).
  A browser without an account only sees a sign-in page.
- Upload titles fall back to "HTML page", not the file name (spec §5.8 updated).
- Edit checks run in this order: locked → rate limited → conflict → content validation.
  - Renaming to an empty label, or renaming an empty tile, → `invalid`.
  - History stays available on a locked board.
  - A cleared tile shows no author; the history does.
- A tap on an empty tile opens the post dialog for the teacher even when the board is locked
  (matching Grid, which shows the teacher the Add button). Empty tiles have no rename button.
- Remote cursors parked on a tile don't fade when idle. A first-time profile starts with a
  random color, so the class doesn't all start the same.
- The `limit` banner appears for an unsolicited `error` with code `full`.
  `InputHandlers.pointerLeft` is a no-op.
- There are two "Blank? Open in new tab" hints: the Grid card's, and LiveFrames' over a live
  frame. Only one is visible at a time, because the card is hidden while the tile is live. In
  e2e, target the toolbar's open button as `.tile-actions [data-action="open"]`.
- Cursor images are SVG data URLs, not PNGs (spec §6.3 updated).

**Process**
- e2e doesn't run in CI yet; `pages.yml` only builds and deploys.
- `build/v1` is merged into `main` before the first push, because Pages deploys from `main`.
- The orchestrator's commit trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Owner changes after the build (2026-09-29)**
- One global teacher passcode. Any number of teachers can be signed in at once, each shown with a
  Teacher tag (`Person.teacher`), and there's a server-side `logout` action.
- Teacher sign-in, lock/unlock and sign-out live in the "Your cursor" panel. The separate teacher
  dialog (`teacherPanel.ts`) was removed.
- The crosshair pointer shape was removed, so `SHAPES` has 5.
- The passcode is never committed. Production sets it with `wrangler secret put`, local dev uses
  the gitignored `worker/.dev.vars`, and the e2e teacher test reads it from there.
