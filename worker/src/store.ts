import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Embeddable, TileKind, TileView, VersionSummary } from '@class-board/shared/types';

export interface VersionRow {
  id: number;
  slot: number;
  created_at: number;
  author_client: string;
  author_name: string;
  kind: TileKind;
  label: string;
  url: string | null;
  embed_url: string | null;
  file_id: string | null;
  title: string | null;
  icon: string | null;
  embeddable: Embeddable;
  note: string | null;
  shot_id: string | null;
  thumb_url: string | null;
}

export type NewVersion = Omit<VersionRow, 'id' | 'created_at'>;
export type VersionPatch = Partial<Pick<VersionRow, 'title' | 'icon' | 'embeddable' | 'note' | 'shot_id'>>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS versions (
     id INTEGER PRIMARY KEY, slot INTEGER NOT NULL, created_at INTEGER NOT NULL,
     author_client TEXT NOT NULL, author_name TEXT NOT NULL, kind TEXT NOT NULL,
     url TEXT, embed_url TEXT, file_id TEXT, label TEXT NOT NULL,
     title TEXT, icon TEXT, embeddable TEXT NOT NULL, note TEXT, shot_id TEXT, thumb_url TEXT)`,
  `CREATE INDEX IF NOT EXISTS versions_slot ON versions (slot, id)`,
  `CREATE TABLE IF NOT EXISTS current (slot INTEGER PRIMARY KEY, version_id INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, html TEXT NOT NULL, size INTEGER NOT NULL,
     created_at INTEGER NOT NULL, author_client TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, jpeg BLOB NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shot_queue (version_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL, not_before INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const PATCHABLE = ['title', 'icon', 'embeddable', 'note', 'shot_id'] as const;

// SqlStorage.exec<T> needs an index signature, which our row interfaces don't have.
function rows<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T[] {
  return cursor.toArray() as unknown as T[];
}

export class BoardStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  current(slot: number): VersionRow | null {
    return rows<VersionRow>(this.sql.exec(
      'SELECT v.* FROM current c JOIN versions v ON v.id = c.version_id WHERE c.slot = ?', slot,
    ))[0] ?? null;
  }

  allCurrent(): Array<VersionRow | null> {
    const out: Array<VersionRow | null> = new Array(SLOT_COUNT).fill(null);
    for (const row of rows<VersionRow>(this.sql.exec(
      'SELECT v.* FROM current c JOIN versions v ON v.id = c.version_id',
    ))) {
      if (row.slot >= 0 && row.slot < SLOT_COUNT) out[row.slot] = row;
    }
    return out;
  }

  insert(v: NewVersion, now: number): VersionRow {
    const row = rows<VersionRow>(this.sql.exec(
      `INSERT INTO versions (slot, created_at, author_client, author_name, kind, url, embed_url, file_id,
         label, title, icon, embeddable, note, shot_id, thumb_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      v.slot, now, v.author_client, v.author_name, v.kind, v.url, v.embed_url, v.file_id,
      v.label, v.title, v.icon, v.embeddable, v.note, v.shot_id, v.thumb_url,
    ))[0]!;
    this.sql.exec(
      `INSERT INTO current (slot, version_id) VALUES (?, ?)
       ON CONFLICT (slot) DO UPDATE SET version_id = excluded.version_id`,
      v.slot, row.id,
    );
    return row;
  }

  get(id: number): VersionRow | null {
    return rows<VersionRow>(this.sql.exec('SELECT * FROM versions WHERE id = ?', id))[0] ?? null;
  }

  patch(id: number, p: VersionPatch): VersionRow | null {
    const keys = PATCHABLE.filter((k) => p[k] !== undefined);
    if (keys.length === 0) return this.get(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => p[k] ?? null);
    return rows<VersionRow>(this.sql.exec(
      `UPDATE versions SET ${sets} WHERE id = ? RETURNING *`, ...values, id,
    ))[0] ?? null;
  }

  history(slot: number, limit: number): VersionRow[] {
    return rows<VersionRow>(this.sql.exec(
      'SELECT * FROM versions WHERE slot = ? ORDER BY id DESC LIMIT ?', slot, limit,
    ));
  }

  putFile(id: string, html: string, authorClient: string, now: number): void {
    const size = new TextEncoder().encode(html).byteLength;
    this.sql.exec(
      'INSERT INTO files (id, html, size, created_at, author_client) VALUES (?, ?, ?, ?, ?)',
      id, html, size, now, authorClient,
    );
  }

  getFile(id: string): string | null {
    return rows<{ html: string }>(this.sql.exec('SELECT html FROM files WHERE id = ?', id))[0]?.html ?? null;
  }

  putShot(id: string, jpeg: ArrayBuffer, now: number): void {
    this.sql.exec('INSERT INTO shots (id, jpeg, created_at) VALUES (?, ?, ?)', id, jpeg, now);
  }

  getShot(id: string): ArrayBuffer | null {
    return rows<{ jpeg: ArrayBuffer }>(this.sql.exec('SELECT jpeg FROM shots WHERE id = ?', id))[0]?.jpeg ?? null;
  }

  enqueueShot(versionId: number, notBefore: number): void {
    this.sql.exec(
      `INSERT INTO shot_queue (version_id, attempts, not_before) VALUES (?, 0, ?)
       ON CONFLICT (version_id) DO UPDATE SET attempts = 0, not_before = excluded.not_before`,
      versionId, notBefore,
    );
  }

  dueShot(now: number): { versionId: number; attempts: number } | null {
    const row = rows<{ version_id: number; attempts: number }>(this.sql.exec(
      'SELECT version_id, attempts FROM shot_queue WHERE not_before <= ? ORDER BY not_before, version_id LIMIT 1', now,
    ))[0];
    return row ? { versionId: row.version_id, attempts: row.attempts } : null;
  }

  retryShot(versionId: number, attempts: number, notBefore: number): void {
    this.sql.exec('UPDATE shot_queue SET attempts = ?, not_before = ? WHERE version_id = ?', attempts, notBefore, versionId);
  }

  dropShot(versionId: number): void {
    this.sql.exec('DELETE FROM shot_queue WHERE version_id = ?', versionId);
  }

  nextShotAt(): number | null {
    return rows<{ t: number | null }>(this.sql.exec('SELECT MIN(not_before) AS t FROM shot_queue'))[0]?.t ?? null;
  }

  getMeta(key: string): string | null {
    return rows<{ value: string }>(this.sql.exec('SELECT value FROM meta WHERE key = ?', key))[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, value,
    );
  }
}

export function filePath(board: string, fileId: string): string {
  return `/boards/${board}/files/${fileId}`;
}

export function shotPath(board: string, shotId: string): string {
  return `/boards/${board}/shots/${shotId}`;
}

export function toTileView(board: string, slot: number, row: VersionRow | null): TileView {
  if (!row || row.kind === 'empty') {
    return {
      slot, version: row?.id ?? 0, kind: 'empty', label: '',
      url: null, embedUrl: null, fileUrl: null, title: null, icon: null,
      embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
    };
  }
  return {
    slot,
    version: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    embedUrl: row.embed_url,
    fileUrl: row.file_id ? filePath(board, row.file_id) : null,
    title: row.title,
    icon: row.icon,
    embeddable: row.embeddable,
    note: row.note,
    shotUrl: row.shot_id ? shotPath(board, row.shot_id) : row.thumb_url,
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}

export function toSummary(board: string, row: VersionRow): VersionSummary {
  return {
    id: row.id,
    slot: row.slot,
    kind: row.kind,
    label: row.label,
    title: row.title,
    url: row.url,
    fileUrl: row.file_id ? filePath(board, row.file_id) : null,
    shotUrl: row.shot_id ? shotPath(board, row.shot_id) : row.thumb_url,
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}
