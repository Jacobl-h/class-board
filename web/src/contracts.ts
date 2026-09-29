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
