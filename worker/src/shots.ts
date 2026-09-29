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
