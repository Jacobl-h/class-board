import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { BUDGET, LIMITS, RATES } from '@class-board/shared/constants';
import { defaultProfile, parseClientMsg } from '@class-board/shared/protocol';
import type {
  ClientMsg, CursorMove, ErrorCode, Person, Presence, Profile, ServerMsg,
} from '@class-board/shared/types';
import { DailyBudget, type BudgetState } from './budget';
import {
  afterPost as startContentChecks, createUploadLimiter, handleHttp, runAlarm, ShooterSession, type ContentHost,
  type UploadLimiter,
} from './content';
import type { Env } from './env';
import { createConnLimits, type ConnLimits } from './limits';
import { createBrowserShooter, type Shooter } from './shots';
import { BoardStore, toTileView, type VersionRow } from './store';
import { TeacherGate } from './teacher';
import { handleTileMsg, type TileHost } from './tiles';

/** Per-connection state, stored on the socket so it survives hibernation (keep it under 2 KB). */
export interface ConnState {
  clientId: string;
  profile: Profile;
  presence: Presence;
  /** True once the connection has sent hello. */
  ready: boolean;
  teacher: boolean;
}

export type BoardConn = Connection<ConnState>;

/**
 * partyserver types connection state as deeply readonly. We never mutate it (every change
 * goes through setState), so reading it as ConnState is safe.
 */
export function stateOf(conn: Connection): ConnState | null {
  return conn.state as unknown as ConnState | null;
}

/** Optional test seams (master plan §2). Production never sets them. */
export interface BoardSeams {
  maxConnections?: number;
  dailyBudget?: number;
  now?: () => number;
  /** Replaces the global fetch for link checks. */
  fetchImpl?: typeof fetch;
  /** Replaces Browser Rendering for screenshots. */
  shooter?: () => Shooter | null;
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid: "That request wasn't valid. Check it and try again.",
  locked: 'The board is locked. Ask the teacher to unlock it.',
  conflict: 'Someone else just changed this tile. Look at the new version and try again.',
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Upload a smaller file.',
  bad_code: "That passcode isn't right. Check it and try again.",
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "That doesn't exist any more. Refresh and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The connection isn\'t ready yet. Wait a moment and try again.',
};

const META_BUDGET_DAY = 'budget_day';
const META_BUDGET_COUNT = 'budget_count';
const META_LOCKED = 'locked';

/**
 * The reqId of a message that failed validation, if it has a well-formed one, so the sender's
 * request settles with 'invalid' at once instead of timing out.
 */
function reqIdOf(raw: string): string | null {
  if (raw.length > 16_384) return null;
  try {
    const data: unknown = JSON.parse(raw);
    const id = typeof data === 'object' && data !== null ? (data as { reqId?: unknown }).reqId : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export class Board extends Server<Env> {
  static options = { hibernate: true };

  store!: BoardStore;
  budget!: DailyBudget;
  locked = false;
  seams: BoardSeams = {};

  /** Rebuilt lazily after hibernation; never the source of truth for identity. */
  private limits = new Map<string, ConnLimits>();
  private pending = new Map<string, [number, number]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHz: number = RATES.cursorHz;
  private teacherGate: TeacherGate | null = null;
  private host: TileHost | null = null;
  private shots: ShooterSession | null = null;
  private uploads: UploadLimiter | null = null;

  now(): number {
    return this.seams.now ? this.seams.now() : Date.now();
  }

  /** Test seam: replace limits or the clock on a running board. */
  setSeams(seams: BoardSeams): void {
    this.seams = { ...this.seams, ...seams };
    if (seams.shooter !== undefined) this.shots = null;
    if (seams.dailyBudget !== undefined) {
      this.budget.flush(true);
      this.budget = this.createBudget(true);
      this.lastHz = this.budget.hz();
    }
  }

  onStart(): void {
    this.store = new BoardStore(this.ctx.storage.sql);
    this.store.migrate();
    this.locked = this.store.getMeta(META_LOCKED) === '1';
    this.budget = this.createBudget();
    this.lastHz = this.budget.hz();
  }

  /** `fresh` starts from zero instead of the saved count (used by the test seam). */
  private createBudget(fresh = false): DailyBudget {
    const configured = Number(this.env.DAILY_MESSAGE_BUDGET);
    const limit = this.seams.dailyBudget
      ?? (Number.isFinite(configured) && configured > 0 ? configured : BUDGET.dailyMessages);
    return new DailyBudget({
      limit,
      now: () => this.now(),
      load: (): BudgetState | null => {
        if (fresh) return null;
        const day = this.store.getMeta(META_BUDGET_DAY);
        if (!day) return null;
        return { day, count: Number(this.store.getMeta(META_BUDGET_COUNT) ?? '0') || 0 };
      },
      save: (s) => {
        this.store.setMeta(META_BUDGET_DAY, s.day);
        this.store.setMeta(META_BUDGET_COUNT, String(s.count));
      },
    });
  }

  onConnect(conn: BoardConn, _ctx: ConnectionContext): void {
    const cap = this.seams.maxConnections ?? LIMITS.maxConnections;
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open > cap) {
      this.sendError(conn, null, 'full');
      conn.close(1013, 'full');
      return;
    }
    conn.setState({
      clientId: '',
      profile: defaultProfile(),
      presence: { at: 'board' },
      ready: false,
      teacher: false,
    });
  }

  onMessage(conn: BoardConn, raw: WSMessage): void {
    this.budget.add();
    this.checkRate();
    this.budget.flush();

    const msg = typeof raw === 'string' ? parseClientMsg(raw) : null;
    if (!msg) {
      this.sendError(conn, typeof raw === 'string' ? reqIdOf(raw) : null, 'invalid');
      return;
    }
    const state = stateOf(conn);
    if (msg.type === 'hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!state?.ready) {
      this.sendError(conn, 'reqId' in msg ? msg.reqId : null, 'not_ready');
      return;
    }
    this.dispatch(conn, state, msg);
  }

  /** Every message type after hello. */
  protected dispatch(conn: BoardConn, state: ConnState, msg: Exclude<ClientMsg, { type: 'hello' }>): void {
    switch (msg.type) {
      case 'profile':
        if (!this.limitsFor(conn.id).profile.take()) {
          this.sendError(conn, null, 'rate_limited');
          return;
        }
        this.updateState(conn, { profile: msg.profile });
        return;
      case 'cursor':
        this.onCursor(conn, state, msg.x, msg.y);
        return;
      case 'dock':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'tile', slot: msg.slot, mode: msg.mode } });
        return;
      case 'away':
        this.pending.delete(conn.id);
        this.updateState(conn, { presence: { at: 'away' } });
        return;
      default:
        handleTileMsg(this.tileHost(), conn, state, msg);
    }
  }

  /** Runs after every successful post: link check and screenshot. */
  protected afterPost(row: VersionRow): void {
    startContentChecks(this.contentHost(), row);
  }

  onRequest(request: Request): Promise<Response> {
    return handleHttp(this.contentHost(), request);
  }

  async onAlarm(): Promise<void> {
    const next = await runAlarm(this.contentHost());
    if (next !== null) await this.ctx.storage.setAlarm(next);
    this.budget.flush();
  }

  private contentHost(): ContentHost {
    return {
      store: this.store,
      board: this.name,
      env: this.env,
      now: () => this.now(),
      // Looked up per call so a stubbed global fetch applies.
      fetchImpl: this.seams.fetchImpl ?? ((input, init) => fetch(input, init)),
      shots: this.shotSession(),
      uploads: (this.uploads ??= createUploadLimiter(() => this.now())),
      broadcast: (msg) => this.broadcastReady(msg),
      scheduleAlarm: (at) => this.scheduleAlarm(at),
      waitUntil: (p) => this.ctx.waitUntil(p.catch((e: unknown) => console.error('content task failed', e))),
    };
  }

  private shotSession(): ShooterSession | null {
    if (this.shots) return this.shots;
    const browser = this.env.BROWSER;
    const create = this.seams.shooter ?? (browser ? () => createBrowserShooter(browser) : null);
    if (!create) return null;
    this.shots = new ShooterSession(create);
    return this.shots;
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private tileHost(): TileHost {
    this.host ??= {
      store: this.store,
      board: this.name,
      now: () => this.now(),
      isLocked: () => this.locked,
      setLocked: (locked) => {
        this.locked = locked;
        this.store.setMeta(META_LOCKED, locked ? '1' : '0');
      },
      gate: () => (this.teacherGate ??= new TeacherGate(this.env.TEACHER_CODE, () => this.now())),
      limits: (id) => this.limitsFor(id),
      send: (conn, msg) => this.send(conn, msg),
      fail: (conn, reqId, code) => this.sendError(conn, reqId, code),
      broadcast: (msg) => this.broadcastReady(msg),
      findPerson: (id) => this.findPerson(id),
      updateState: (conn, patch) => this.updateState(conn, patch),
      afterPost: (row) => this.afterPost(row),
    };
    return this.host;
  }

  private findPerson(id: string): { conn: BoardConn; state: ConnState } | null {
    for (const conn of this.getConnections()) {
      const state = stateOf(conn);
      if (conn.id === id && state?.ready) return { conn: conn as BoardConn, state };
    }
    return null;
  }

  private onHello(conn: BoardConn, msg: Extract<ClientMsg, { type: 'hello' }>): void {
    const prev = stateOf(conn);
    const wasReady = prev?.ready === true;
    const next: ConnState = {
      clientId: msg.clientId,
      profile: msg.profile,
      presence: { at: 'board' },
      ready: true,
      teacher: prev?.teacher ?? false,
    };
    conn.setState(next);
    this.broadcastReady(
      { type: 'person', event: wasReady ? 'updated' : 'joined', person: this.personOf(conn.id, next) },
      conn.id,
    );
    this.send(conn, {
      type: 'snapshot',
      board: this.name,
      you: conn.id,
      tiles: this.store.allCurrent().map((row, slot) => toTileView(this.name, slot, row)),
      locked: this.locked,
      people: this.people(),
      rate: this.budget.hz(),
    });
  }

  private onCursor(conn: BoardConn, state: ConnState, x: number, y: number): void {
    if (this.budget.hz() === 0) return;
    if (!this.limitsFor(conn.id).cursor.take()) return;
    if (state.presence.at !== 'board') this.updateState(conn, { presence: { at: 'board' } });
    this.pending.set(conn.id, [x, y]);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushCursors(), RATES.cursorBatchMs);
    }
  }

  private flushCursors(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const moves: CursorMove[] = [...this.pending].map(([id, [x, y]]) => [id, x, y]);
    this.pending.clear();
    for (const conn of this.getConnections()) {
      if (!stateOf(conn)?.ready) continue;
      const others = moves.filter((m) => m[0] !== conn.id);
      if (others.length > 0) this.send(conn, { type: 'cursors', moves: others });
    }
  }

  onClose(conn: BoardConn): void {
    // PartySocket keeps its id across reconnects, so the old socket can close after its
    // replacement has already said hello. getConnections() skips sockets that aren't open,
    // so this finds only the replacement; the person, cursor and limits then belong to it.
    const replaced = this.findPerson(conn.id) !== null;
    if (!replaced) {
      this.pending.delete(conn.id);
      this.limits.delete(conn.id);
      if (stateOf(conn)?.ready) this.broadcastReady({ type: 'personLeft', id: conn.id });
    }
    let open = 0;
    for (const _c of this.getConnections()) open += 1;
    if (open === 0) this.budget.flush(true);
  }

  /** Broadcasts `rate` when the budget crosses a threshold. */
  private checkRate(): void {
    const hz = this.budget.hz();
    if (hz === this.lastHz) return;
    this.lastHz = hz;
    this.broadcastReady({ type: 'rate', hz });
  }

  protected limitsFor(connId: string): ConnLimits {
    let limits = this.limits.get(connId);
    if (!limits) {
      limits = createConnLimits(() => this.now());
      this.limits.set(connId, limits);
    }
    return limits;
  }

  /** Merges into the connection's state and tells everyone about the person. */
  protected updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState {
    const next = { ...(stateOf(conn) as ConnState), ...patch };
    conn.setState(next);
    this.broadcastReady({ type: 'person', event: 'updated', person: this.personOf(conn.id, next) });
    return next;
  }

  protected personOf(id: string, s: ConnState): Person {
    return { id, clientId: s.clientId, profile: s.profile, presence: s.presence, teacher: s.teacher === true };
  }

  /** Everyone who has said hello, once per id (a reconnect can briefly leave two sockets with one id). */
  protected people(): Person[] {
    const byId = new Map<string, Person>();
    for (const conn of this.getConnections()) {
      const s = stateOf(conn);
      if (s?.ready) byId.set(conn.id, this.personOf(conn.id, s));
    }
    return [...byId.values()];
  }

  protected send(conn: Connection, msg: ServerMsg): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // The socket closed between the check and the send; onClose cleans up.
    }
  }

  protected sendError(conn: Connection, reqId: string | null, code: ErrorCode): void {
    this.send(conn, { type: 'error', reqId, code, message: ERROR_TEXT[code] });
  }

  /** Sends to every connection that has said hello, except `exceptId`. */
  protected broadcastReady(msg: ServerMsg, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const conn of this.getConnections()) {
      if (conn.id === exceptId || !stateOf(conn)?.ready) continue;
      try {
        conn.send(data);
      } catch {
        // Closed mid-broadcast; onClose cleans up.
      }
    }
  }
}
