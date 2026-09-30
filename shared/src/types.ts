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
  /** True while this connection is signed in as a teacher (any number of people can be). */
  teacher?: boolean;
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

export type TeacherAction = 'check' | 'lock' | 'unlock' | 'clear' | 'resetCursor' | 'logout';

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
