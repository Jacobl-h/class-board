import { LIMITS } from '@class-board/shared/constants';
import { cleanText } from '@class-board/shared/protocol';
import type { ClientMsg, ErrorCode, ServerMsg } from '@class-board/shared/types';
import { NOTES, planLink } from '@class-board/shared/urls';
import type { BoardConn, ConnState } from './board';
import { checkUpload, ID_RE } from './files';
import type { ConnLimits } from './limits';
import { toSummary, toTileView, type BoardStore, type NewVersion, type VersionRow } from './store';
import type { TeacherGate } from './teacher';

export type TileMsg = Extract<ClientMsg, { type: 'post' | 'rename' | 'restore' | 'history' | 'teacher' }>;

/** What the tile handlers need from the Board Durable Object. */
export interface TileHost {
  store: BoardStore;
  board: string;
  now(): number;
  isLocked(): boolean;
  setLocked(locked: boolean): void;
  gate(): TeacherGate;
  limits(connId: string): ConnLimits;
  send(conn: BoardConn, msg: ServerMsg): void;
  fail(conn: BoardConn, reqId: string | null, code: ErrorCode): void;
  /** To every connection that has said hello. */
  broadcast(msg: ServerMsg): void;
  /** A connection that has said hello, by connection id. */
  findPerson(id: string): { conn: BoardConn; state: ConnState } | null;
  /** Replaces part of a connection's state and broadcasts `person` `updated`. */
  updateState(conn: BoardConn, patch: Partial<ConnState>): ConnState;
  /** Called after a successful post, rename or restore (W4 starts link checks and screenshots here). */
  afterPost(row: VersionRow): void;
}

export function handleTileMsg(host: TileHost, conn: BoardConn, state: ConnState, msg: TileMsg): void {
  switch (msg.type) {
    case 'post':
      return post(host, conn, state, msg);
    case 'rename':
      return rename(host, conn, state, msg);
    case 'restore':
      return restore(host, conn, state, msg);
    case 'history':
      return history(host, conn, msg);
    case 'teacher':
      return teacher(host, conn, state, msg);
  }
}

/** Shared checks for post, rename and restore. Returns the current row, or null after replying with an error. */
function checkEdit(
  host: TileHost, conn: BoardConn, state: ConnState,
  msg: { reqId: string; slot: number; baseVersion: number },
): { current: VersionRow | null } | null {
  if (host.isLocked() && !state.teacher) {
    host.fail(conn, msg.reqId, 'locked');
    return null;
  }
  if (!host.limits(conn.id).edit.take()) {
    host.fail(conn, msg.reqId, 'rate_limited');
    return null;
  }
  const current = host.store.current(msg.slot);
  if ((current?.id ?? 0) !== msg.baseVersion) {
    host.fail(conn, msg.reqId, 'conflict');
    return null;
  }
  return { current };
}

function save(host: TileHost, conn: BoardConn, reqId: string, v: NewVersion): VersionRow {
  const row = host.store.insert(v, host.now());
  host.broadcast({ type: 'tile', view: toTileView(host.board, row.slot, row) });
  host.send(conn, { type: 'ok', reqId });
  return row;
}

function authored(state: ConnState): Pick<NewVersion, 'author_client' | 'author_name'> {
  return { author_client: state.clientId, author_name: state.profile.name };
}

function post(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'post' }>): void {
  if (!checkEdit(host, conn, state, msg)) return;
  const label = cleanText(msg.label, LIMITS.labelMax) || state.profile.name;
  const base = { slot: msg.slot, label, ...authored(state), title: null, icon: null, shot_id: null };
  let v: NewVersion;
  if (msg.content.kind === 'link') {
    const plan = planLink(msg.content.url);
    if (!plan.ok) {
      host.fail(conn, msg.reqId, 'invalid');
      return;
    }
    v = plan.kind === 'claude-new'
      ? { ...base, kind: 'link', url: plan.url, embed_url: null, file_id: null, embeddable: 'no', note: NOTES.claudeNew, thumb_url: null }
      : { ...base, kind: 'link', url: plan.url, embed_url: plan.embedUrl, file_id: null, embeddable: 'pending', note: null, thumb_url: plan.thumbUrl };
  } else {
    const fileId = msg.content.fileId;
    const html = ID_RE.test(fileId) ? host.store.getFile(fileId) : null;
    if (html === null) {
      host.fail(conn, msg.reqId, 'not_found');
      return;
    }
    const checked = checkUpload(new TextEncoder().encode(html).buffer as ArrayBuffer, null);
    v = {
      ...base, kind: 'html', url: null, embed_url: null, file_id: fileId,
      title: checked.ok ? checked.title : 'HTML page', embeddable: 'yes', note: null, thumb_url: null,
    };
  }
  const row = save(host, conn, msg.reqId, v);
  host.afterPost(row);
}

function rename(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'rename' }>): void {
  const label = cleanText(msg.label, LIMITS.labelMax);
  const checked = checkEdit(host, conn, state, msg);
  if (!checked) return;
  const current = checked.current;
  if (!current || current.kind === 'empty' || !label) {
    host.fail(conn, msg.reqId, 'invalid');
    return;
  }
  // The copy may still be waiting for a link check or a screenshot that the old version can't hand on.
  host.afterPost(save(host, conn, msg.reqId, { ...copyOf(current), ...authored(state), label }));
}

function restore(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'restore' }>): void {
  if (!checkEdit(host, conn, state, msg)) return;
  const old = host.store.get(msg.versionId);
  if (!old || old.slot !== msg.slot) {
    host.fail(conn, msg.reqId, 'not_found');
    return;
  }
  host.afterPost(save(host, conn, msg.reqId, { ...copyOf(old), ...authored(state) }));
}

function history(host: TileHost, conn: BoardConn, msg: Extract<TileMsg, { type: 'history' }>): void {
  if (!host.limits(conn.id).history.take()) {
    host.fail(conn, msg.reqId, 'rate_limited');
    return;
  }
  const versions = host.store.history(msg.slot, LIMITS.historyLimit).map((row) => toSummary(host.board, row));
  host.send(conn, { type: 'historyResult', reqId: msg.reqId, slot: msg.slot, versions });
}

function teacher(host: TileHost, conn: BoardConn, state: ConnState, msg: Extract<TileMsg, { type: 'teacher' }>): void {
  const check = host.gate().check(conn.id, msg.code);
  if (check !== 'ok') {
    host.fail(conn, msg.reqId, check === 'bad' ? 'bad_code' : 'locked_out');
    return;
  }
  switch (msg.action) {
    case 'check':
      conn.setState({ ...state, teacher: true });
      break;
    case 'lock':
    case 'unlock': {
      const locked = msg.action === 'lock';
      host.setLocked(locked);
      host.broadcast({ type: 'locked', locked });
      break;
    }
    case 'clear': {
      if (msg.slot === undefined) {
        host.fail(conn, msg.reqId, 'invalid');
        return;
      }
      save(host, conn, msg.reqId, {
        slot: msg.slot, kind: 'empty', label: '', ...authored(state),
        url: null, embed_url: null, file_id: null, title: null, icon: null,
        embeddable: 'no', note: null, shot_id: null, thumb_url: null,
      });
      return;
    }
    case 'resetCursor': {
      if (msg.target === undefined) {
        host.fail(conn, msg.reqId, 'invalid');
        return;
      }
      const target = host.findPerson(msg.target);
      if (!target) {
        host.fail(conn, msg.reqId, 'not_found');
        return;
      }
      host.updateState(target.conn, { profile: { ...target.state.profile, cursor: { kind: 'shape', shape: 'arrow' } } });
      break;
    }
  }
  host.send(conn, { type: 'ok', reqId: msg.reqId });
}

/** The content fields of a version, for rename and restore. */
function copyOf(row: VersionRow): NewVersion {
  return {
    slot: row.slot, author_client: row.author_client, author_name: row.author_name,
    kind: row.kind, label: row.label, url: row.url, embed_url: row.embed_url, file_id: row.file_id,
    title: row.title, icon: row.icon, embeddable: row.embeddable, note: row.note,
    shot_id: row.shot_id, thumb_url: row.thumb_url,
  };
}
