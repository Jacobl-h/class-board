import './styles/base.css';
import { tileRect } from '@class-board/shared/slots';
import type { ErrorCode, Person, Profile, ServerMsg, SlotIndex } from '@class-board/shared/types';
import { createCamera } from './board/camera';
import { createFocus } from './board/focus';
import { createGrid } from './board/grid';
import { attachInput } from './board/input';
import { createLiveFrames } from './board/liveFrames';
import { BOARD, BOARD_ORIGIN, SERVER_URL } from './config';
import type {
  CameraState, FocusApi, GridActions, HistoryDeps, InputHandlers, LiveFramesApi, LocalCursorApi, PostDialogDeps,
} from './contracts';
import { createLocalCursor } from './cursors/local';
import { createRemoteCursors } from './cursors/remote';
import { cursorImage } from './cursors/render';
import { connectBoard, newReqId } from './net/socket';
import { uploadHtml } from './net/upload';
import { mountPeoplePanel } from './people/peoplePanel';
import { openProfilePanel } from './profile/panel';
import { loadIdentity, saveProfile } from './profile/storage';
import { createBoardState } from './state/boardState';
import { createTeacher } from './teacher/teacher';
import { openHistory } from './tiles/historyPanel';
import { openPostDialog } from './tiles/postDialog';
import { hideBanner, showBanner } from './ui/banner';
import { errorText, toast } from './ui/errors';
import { openHelp } from './ui/help';
import { mountTopBar } from './ui/topBar';
import { serverHref } from './util/url';

const UNREACHABLE_AFTER_MS = 8_000;
/** While the socket stays down, how often to re-probe the server over HTTP. */
const PROBE_EVERY_MS = 30_000;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el;
}

/** Shows a toast for a failed request: the server's error text when there is a code, else a generic one. */
function report(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  const text = typeof code === 'string' ? errorText(code as ErrorCode) : undefined;
  toast(text || "That didn't work. Check your connection and try again.");
}

function sameProfile(a: Profile, b: Profile): boolean {
  if (a.name !== b.name || a.color !== b.color || a.cursor.kind !== b.cursor.kind) return false;
  if (a.cursor.kind === 'shape' && b.cursor.kind === 'shape') return a.cursor.shape === b.cursor.shape;
  if (a.cursor.kind === 'pixels' && b.cursor.kind === 'pixels') {
    return a.cursor.art === b.cursor.art && a.cursor.tip[0] === b.cursor.tip[0] && a.cursor.tip[1] === b.cursor.tip[1];
  }
  return false;
}

const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * teacherCode is a passcode typed on the first visit, before there was a board to check it
 * against: it's tried once the first snapshot arrives.
 */
function start(clientId: string, initial: Profile, teacherCode?: string): void {
  const topbarEl = byId('topbar');
  const viewport = byId('viewport');
  const world = byId('world');
  const tilesEl = byId('tiles');
  const cursorLayer = byId('cursor-layer');
  const hintEl = byId('hint');

  let current = initial;

  const state = createBoardState(BOARD);
  const camera = createCamera(viewport.clientWidth, viewport.clientHeight);
  const socket = connectBoard({
    serverUrl: SERVER_URL,
    board: BOARD,
    hello: () => ({ type: 'hello', clientId, profile: current }),
  });
  const teacher = createTeacher(socket);

  const postDeps: PostDialogDeps = {
    socket,
    state,
    upload: (html, fileName) => uploadHtml(SERVER_URL, BOARD, html, fileName, clientId),
    defaultLabel: () => current.name,
  };
  const historyDeps: HistoryDeps = {
    socket,
    state,
    serverUrl: SERVER_URL,
    canRestore: () => !state.locked() || teacher.active(),
  };
  const canEdit = (): boolean => !state.locked() || teacher.active();

  // Grid needs its actions before live frames and focus exist (both need the grid), so the
  // actions reach them through these bindings, which are set right after.
  let live: LiveFramesApi;
  let focus: FocusApi;
  let localCursor: LocalCursorApi;

  function openTile(slot: SlotIndex): void {
    const t = state.tile(slot);
    const href = t.url ?? (t.fileUrl ? serverHref(SERVER_URL, t.fileUrl) : null);
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }

  const actions: GridActions = {
    add: (slot) => openPostDialog(postDeps, slot, 'add'),
    replace: (slot) => openPostDialog(postDeps, slot, 'replace'),
    history: (slot) => openHistory(historyDeps, slot),
    open: openTile,
    clear: (slot) => {
      teacher.clear(slot).catch(report);
    },
    rename: (slot, label) => {
      socket
        .request({ type: 'rename', reqId: newReqId(), slot, baseVersion: state.tile(slot).version, label })
        .catch(report);
    },
    focus: (slot) => focus.enter(slot),
    back: () => focus.exit(),
  };

  const grid = createGrid(tilesEl, state, actions, SERVER_URL);
  live = createLiveFrames({
    grid,
    camera,
    state,
    serverUrl: SERVER_URL,
    boardOrigin: BOARD_ORIGIN,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
  focus = createFocus({ grid, live, camera, state, hintEl, serverUrl: SERVER_URL });
  localCursor = createLocalCursor({ viewport, socket });
  createRemoteCursors({ layer: cursorLayer, camera, state }).start();

  /** The server last turned us away as full; its socket closes, and the probe must not relabel that. */
  let boardFull = false;

  // Messages go to the state only after every subscriber above exists, so none misses the first snapshot.
  socket.onMessage((m: ServerMsg) => {
    state.apply(m);
    // Errors without a reqId aren't answers to a request, so no dialog will show them.
    if (m.type === 'error' && m.reqId === null) {
      if (m.code === 'full') {
        boardFull = true;
        showBanner('limit', errorText('full'), 'error');
      }
      else if (m.code !== 'not_ready') toast(errorText(m.code));
    }
  });

  const handlers: InputHandlers = {
    boardPointer: (bx, by) => {
      if (focus.current() === null) localCursor.boardMove(bx, by);
      const active = live.active();
      // The board only sees moves once the pointer has left the in-use iframe.
      if (active !== null && !inRect(tileRect(active), bx, by)) live.deactivate();
    },
    tap: (slot) => {
      const active = live.active();
      if (slot === null) {
        live.deactivate();
        return;
      }
      if (active !== null && active !== slot) live.deactivate();
      if (state.tile(slot).kind === 'empty' && canEdit()) openPostDialog(postDeps, slot, 'add');
      else if (live.isLive(slot)) live.activate(slot);
    },
    doubleTap: (slot) => camera.fitSlot(slot),
    zoomBlocked: (slot) => focus.zoomBlocked(slot),
    // Nothing to send: other people keep seeing the last position until the next move or 'away'.
    pointerLeft: () => {},
  };
  attachInput(viewport, camera, handlers);

  /* ---------- top bar and camera ---------- */

  /** Profiles sent to the server whose echo hasn't come back yet. */
  const sent: Profile[] = [];

  async function showDesign(p: Profile): Promise<void> {
    await localCursor.applyDesign(p);
    topBar.setCursorPreview((await cursorImage(p)).url);
  }

  /** "Your cursor": the profile, plus the Teacher section (sign in, lock or unlock, sign out). */
  function openProfile(): void {
    openProfilePanel({
      initial: current,
      requireName: true,
      teacher,
      locked: () => state.locked(),
      onSave: (p) => {
        adopt(p);
        sent.push(p);
        socket.send({ type: 'profile', profile: p });
      },
    });
  }

  function adopt(p: Profile): void {
    current = p;
    saveProfile(p);
    showDesign(p).catch(() => topBar.setCursorPreview(null));
  }

  const center = (factor: number): void => {
    const { w, h } = camera.viewport();
    camera.zoomAt(w / 2, h / 2, factor);
  };
  const topBar = mountTopBar(topbarEl, {
    zoomIn: () => center(1.25),
    zoomOut: () => center(0.8),
    fit: () => camera.fitBoard(),
    profile: () => openProfile(),
    help: () => openHelp(new URL(BOARD_ORIGIN).host),
  });
  topBar.setBoardName(BOARD);
  showDesign(current).catch(() => topBar.setCursorPreview(null));

  function applyCamera({ s, tx, ty }: CameraState): void {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  world.style.setProperty('--cam-s', String(s));
    topBar.setZoom(s);
  }
  camera.onChange(applyCamera);
  applyCamera(camera.state());
  new ResizeObserver(() => camera.setViewport(viewport.clientWidth, viewport.clientHeight)).observe(viewport);

  /* ---------- docking your cursor ---------- */

  live.onActiveChange((slot) => {
    if (slot !== null) localCursor.dock(slot, 'using');
    else if (focus.current() === null) localCursor.undock();
  });
  focus.onChange((slot) => {
    if (slot !== null) localCursor.dock(slot, 'viewing');
    else localCursor.undock();
  });

  /* ---------- teacher and people ---------- */

  function applyTeacher(on: boolean): void {
    grid.setTeacher(on);
    topBar.setTeacher(on);
    document.body.classList.toggle('is-teacher', on);
  }
  teacher.onChange(applyTeacher);
  applyTeacher(teacher.active());

  const lastPos = new Map<string, { x: number; y: number }>();
  state.on('cursors', (moves) => {
    for (const [id, x, y] of moves) lastPos.set(id, { x, y });
  });

  function onJump(person: Person): void {
    const at = person.presence;
    if (at.at === 'tile') {
      camera.fitSlot(at.slot);
      return;
    }
    const pos = lastPos.get(person.id);
    if (pos) camera.centerOn(pos.x, pos.y);
  }
  mountPeoplePanel({
    button: topBar.peopleButton,
    state,
    teacher,
    onJump,
    onTeacher: openProfile,
  });

  /* ---------- state → banners, rate, people ---------- */

  function syncLocked(): void {
    if (state.locked()) showBanner('locked', 'The board is locked.', 'info');
    else hideBanner('locked');
  }
  function syncRate(): void {
    const hz = state.rate();
    localCursor.setRate(hz);
    if (hz === 0) {
      showBanner('cursors-paused', 'Cursors are paused until midnight UTC to stay within the free limit.', 'info');
    } else {
      hideBanner('cursors-paused');
    }
  }
  function syncPeople(): void {
    topBar.setPeopleCount(state.people().length);
    const here = new Set(state.people().map((p) => p.id));
    for (const id of lastPos.keys()) if (!here.has(id)) lastPos.delete(id);
    adoptServerProfile();
  }
  // My profile as the server has it changes in two ways: an echo of a 'profile' message I sent,
  // and a teacher's cursor reset. Echoes are skipped (even an older one arriving after a newer
  // save); anything else that differs from `current` is adopted.
  function adoptServerProfile(): void {
    const mine = state.me()?.profile;
    if (!mine) return;
    const echo = sent.findIndex((p) => sameProfile(p, mine));
    if (echo !== -1) {
      sent.splice(0, echo + 1);
      return;
    }
    if (!sameProfile(mine, current)) adopt(mine);
  }

  let fitted = false;
  let pendingCode = teacherCode || undefined;

  function signInWith(code: string): void {
    teacher.login(code).then((result) => {
      if (result === 'ok') toast("You're signed in as a teacher.");
      else if (result === 'bad') toast("That passcode isn't right. Open Your cursor to try again.");
      else toast('Too many tries. Wait 10 minutes and try again.');
    }, report);
  }
  state.on('snapshot', () => {
    boardFull = false;
    hideBanner('limit');
    syncLocked();
    syncRate();
    syncPeople();
    if (!fitted) {
      fitted = true;
      camera.fitBoard();
      focus.start();
    }
    if (pendingCode !== undefined) {
      const code = pendingCode;
      pendingCode = undefined;
      signInWith(code);
    }
  });
  state.on('locked', syncLocked);
  state.on('rate', syncRate);
  state.on('people', syncPeople);

  /* ---------- connection banners ---------- */

  // While the socket stays down, probe the Worker over plain HTTP. If it answers at all, the
  // network is fine and the WebSocket is being refused, which on the free plan means a daily
  // limit was hit (spec §8). If it can't be reached, it's the network (or the server is down).
  let everOpen = false;
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  let probeRound = 0;
  function whileDown(): void {
    downTimer = null;
    if (socket.status() === 'open') return;
    if (!everOpen) {
      showBanner('unreachable', `Can't reach the board server at ${SERVER_URL}. If you're on a school network, ask IT to allow this address.`, 'error');
    }
    const round = ++probeRound;
    fetch(`${SERVER_URL}/boards/${BOARD}/files/${'0'.repeat(32)}`, { mode: 'no-cors', cache: 'no-store' }).then(
      () => {
        if (round !== probeRound || socket.status() === 'open' || boardFull) return;
        hideBanner('unreachable');
        hideBanner('reconnecting');
        showBanner('limit', "The board has hit today's free limit. It'll be back at midnight UTC.", 'error');
      },
      () => {
        // Not reachable: keep the unreachable or reconnecting banner.
      },
    );
    downTimer = setTimeout(whileDown, PROBE_EVERY_MS);
  }
  function watchDown(): void {
    if (downTimer === null) downTimer = setTimeout(whileDown, UNREACHABLE_AFTER_MS);
  }
  watchDown();
  socket.onStatus((status) => {
    if (status === 'open') {
      everOpen = true;
      probeRound++;
      if (downTimer !== null) clearTimeout(downTimer);
      downTimer = null;
      hideBanner('unreachable');
      hideBanner('reconnecting');
      // A 'full' answer arrives after open and shows the banner again.
      hideBanner('limit');
    } else if (status === 'closed' && everOpen) {
      showBanner('reconnecting', 'Reconnecting…', 'warn');
      watchDown();
    }
  });

  if (import.meta.env.DEV) window.__classBoard = { camera, state, live, focus };
}

const identity = loadIdentity();
if (identity.profile) {
  start(identity.clientId, identity.profile);
} else {
  // First visit: nothing connects until there's a name.
  openProfilePanel({
    initial: null,
    requireName: true,
    onSave: (p, teacherCode) => {
      saveProfile(p);
      start(identity.clientId, p, teacherCode);
    },
  });
}
