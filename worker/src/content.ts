import { LIMITS, RATES } from '@class-board/shared/constants';
import type { ServerMsg } from '@class-board/shared/types';
import { NOTES, planLink } from '@class-board/shared/urls';
import type { Env } from './env';
import { checkUpload, htmlFileResponse, ID_RE, json, newId, parseOrigins, shotResponse } from './files';
import { KeyedLimiter } from './limits';
import { checkLink } from './linkCheck';
import { runShotQueue, shotTarget, type Shooter } from './shots';
import { toTileView, type BoardStore, type VersionRow } from './store';

/** What the content handlers need from the Board Durable Object. */
export interface ContentHost {
  store: BoardStore;
  board: string;
  env: Env;
  now(): number;
  fetchImpl: typeof fetch;
  /** Null when screenshots are off (no Browser Rendering binding and no test shooter). */
  shots: ShooterSession | null;
  uploads: UploadLimiter;
  /** To every connection that has said hello. */
  broadcast(msg: ServerMsg): void;
  /** Moves the alarm earlier if `at` is before the one already set. */
  scheduleAlarm(at: number): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
}

/** Creates the shooter on first use and closes it when the queue has drained. */
export class ShooterSession {
  private shooter: Shooter | null = null;

  constructor(private readonly create: () => Shooter | null) {}

  get(): Shooter | null {
    this.shooter ??= this.create();
    return this.shooter;
  }

  async close(): Promise<void> {
    const shooter = this.shooter;
    this.shooter = null;
    if (shooter) await shooter.close().catch(() => undefined);
  }

  /** Drops the cached shooter without closing it; runShotQueue already closed the one it used. */
  forget(): void {
    this.shooter = null;
  }
}

/**
 * A class usually shares one public IP, so the per-minute upload limit applies to each client
 * (IP plus the X-Client-Id header), with a much higher per-IP ceiling as a backstop. A request
 * without a valid client id is limited by its IP alone.
 */
const UPLOADS_PER_IP_PER_MINUTE = 120;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface UploadLimiter {
  allow(ip: string, clientId: string | null): boolean;
}

export function createUploadLimiter(now: () => number): UploadLimiter {
  const perClient = new KeyedLimiter(RATES.uploadsPerMinute, now);
  const perIp = new KeyedLimiter(UPLOADS_PER_IP_PER_MINUTE, now);
  return {
    allow(ip, clientId) {
      const key = clientId !== null && CLIENT_ID_RE.test(clientId) ? `${ip}|${clientId}` : ip;
      // Per client first, so a client retrying past its own limit doesn't use up the class's backstop.
      return perClient.allow(key) && perIp.allow(ip);
    },
  };
}

/**
 * Reads the body, stopping as soon as it passes `max` bytes whatever Content-Length says
 * (a chunked request has none). Null means too large.
 */
async function readCapped(request: Request, max: number): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out.buffer;
}

/** Broadcasts a row only while it's still its slot's current version. */
function broadcastIfCurrent(host: ContentHost, row: VersionRow): void {
  if (host.store.current(row.slot)?.id !== row.id) return;
  host.broadcast({ type: 'tile', view: toTileView(host.board, row.slot, row) });
}

async function queueShot(host: ContentHost, versionId: number): Promise<void> {
  if (!host.shots) return;
  const now = host.now();
  host.store.enqueueShot(versionId, now);
  await host.scheduleAlarm(now);
}

/**
 * Runs after every new version: post, and the copies made by rename and restore. A copy can
 * still be pending, or lack a screenshot, because work started for the old version is dropped
 * once that version is no longer current.
 */
export function afterPost(host: ContentHost, row: VersionRow): void {
  if (row.kind === 'link' && row.embeddable === 'pending' && row.embed_url) {
    // The check queues the screenshot when it finishes.
    host.waitUntil(checkAndUpdate(host, row, row.embed_url));
    return;
  }
  if (!row.shot_id && shotTarget(row, host.board, host.env.PUBLIC_URL) !== null) {
    host.waitUntil(queueShot(host, row.id));
  }
}

async function checkAndUpdate(host: ContentHost, row: VersionRow, embedUrl: string): Promise<void> {
  const check = () => checkLink(embedUrl, host.env.BOARD_ORIGIN, host.fetchImpl)
    .catch(() => ({ embeddable: 'unknown' as const, title: null, icon: null }));
  let result = await check();
  // A cold connection can miss the time limit once; a second try usually gets the real answer.
  if (result.embeddable === 'unknown') result = await check();
  let note: string | null = null;
  if (result.embeddable === 'no') {
    const plan = row.url ? planLink(row.url) : null;
    note = plan?.ok && plan.kind === 'claude-published'
      ? NOTES.claudeAllow(new URL(host.env.BOARD_ORIGIN).host)
      : NOTES.blocked;
  }
  const patched = host.store.patch(row.id, {
    embeddable: result.embeddable, title: result.title, icon: result.icon, note,
  });
  if (!patched) return;
  broadcastIfCurrent(host, patched);
  if (host.store.current(patched.slot)?.id === patched.id && !patched.thumb_url) {
    await queueShot(host, patched.id);
  }
}

/** The alarm: works through the screenshot queue and returns when to run again (or null). */
export async function runAlarm(host: ContentHost): Promise<number | null> {
  const shots = host.shots;
  const next = await runShotQueue({
    store: host.store,
    board: host.board,
    publicUrl: host.env.PUBLIC_URL,
    shooter: () => shots?.get() ?? null,
    now: () => host.now(),
    onUpdated: (row) => broadcastIfCurrent(host, row),
  }, 8);
  // runShotQueue closes the shooter it used before returning, so the next alarm needs a fresh one.
  shots?.forget();
  return next;
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

/** HTTP requests the Worker forwarded to this board: uploads, files and screenshots. */
export async function handleHttp(host: ContentHost, request: Request): Promise<Response> {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts[0] !== 'boards' || parts[1] !== host.board) return notFound();

  if (parts.length === 3 && parts[2] === 'files' && request.method === 'POST') {
    return upload(host, request);
  }
  if (parts.length === 4 && request.method === 'GET') {
    const id = parts[3]!;
    if (!ID_RE.test(id)) return notFound();
    if (parts[2] === 'files') {
      const html = host.store.getFile(id);
      return html === null ? notFound() : htmlFileResponse(html, parseOrigins(host.env.ALLOWED_ORIGINS));
    }
    if (parts[2] === 'shots') {
      const jpeg = host.store.getShot(id);
      return jpeg === null ? notFound() : shotResponse(jpeg);
    }
  }
  return notFound();
}

async function upload(host: ContentHost, request: Request): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (!origin || !parseOrigins(host.env.ALLOWED_ORIGINS).includes(origin)) return json({ error: 'origin' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!host.uploads.allow(ip, request.headers.get('X-Client-Id'))) return json({ error: 'rate_limited' }, 429);

  // Refuse obviously oversized bodies before reading them; the capped read stops any that lie.
  if (Number(request.headers.get('Content-Length') ?? '0') > LIMITS.htmlMaxBytes) return json({ error: 'too_large' }, 413);
  const body = await readCapped(request, LIMITS.htmlMaxBytes);
  if (body === null) return json({ error: 'too_large' }, 413);
  const checked = checkUpload(body, fileNameOf(request));
  if (!checked.ok) return json({ error: checked.code }, checked.code === 'too_large' ? 413 : 400);
  const fileId = newId();
  host.store.putFile(fileId, checked.html, '', host.now());
  return json({ fileId });
}

/** The optional X-File-Name header, which the browser may percent-encode. */
function fileNameOf(request: Request): string | null {
  const raw = request.headers.get('X-File-Name');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
