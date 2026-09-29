import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import type { ClientMsg, Profile } from '@class-board/shared/types';
import type { BoardSocket } from '../src/contracts';
import { createLocalCursor } from '../src/cursors/local';

let viewport: HTMLElement;
let sent: ClientMsg[];
let socket: BoardSocket;
let visibility: 'visible' | 'hidden';

function setVisibility(next: 'visible' | 'hidden'): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  viewport = document.createElement('div');
  sent = [];
  socket = {
    send: (m) => void sent.push(m),
    request: vi.fn(),
    onMessage: () => () => {},
    onStatus: () => () => {},
    status: () => 'open',
    close: vi.fn(),
  };
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('createLocalCursor cursor sending', () => {
  it('sends the first position at once, rounded to integers', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(100.4, 200.6);
    expect(sent).toEqual([{ type: 'cursor', x: 100, y: 201 }]);
    cursor.destroy();
  });

  it('sends at most 5 times a second and finishes with the final position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    for (let i = 0; i < 20; i++) {
      cursor.boardMove(i, i);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(1_000);
    const cursors = sent.filter((m) => m.type === 'cursor');
    expect(cursors.length).toBeLessThanOrEqual(6);
    expect(cursors.at(-1)).toEqual({ type: 'cursor', x: 19, y: 19 });
    cursor.destroy();
  });

  it('sends nothing while the pointer is still', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    cursor.destroy();
  });

  it('slows to 2 Hz when the server lowers the rate', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.setRate(2);
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(100);
    cursor.boardMove(2, 2);
    vi.advanceTimersByTime(399);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    cursor.destroy();
  });

  it('sends nothing at rate 0 and picks up again when the rate returns', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.setRate(0);
    cursor.boardMove(1, 1);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(0);
    cursor.setRate(5);
    cursor.boardMove(2, 2);
    expect(sent).toEqual([{ type: 'cursor', x: 2, y: 2 }]);
    cursor.destroy();
  });
});

describe('createLocalCursor docking', () => {
  it('sends dock once and skips an identical dock', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(23, 'using');
    cursor.dock(23, 'using');
    expect(sent).toEqual([{ type: 'dock', slot: 23, mode: 'using' }]);
    cursor.destroy();
  });

  it('sends a new dock when the slot or mode changes', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(23, 'using');
    cursor.dock(23, 'viewing');
    cursor.dock(24, 'viewing');
    expect(sent.map((m) => JSON.stringify(m))).toEqual([
      '{"type":"dock","slot":23,"mode":"using"}',
      '{"type":"dock","slot":23,"mode":"viewing"}',
      '{"type":"dock","slot":24,"mode":"viewing"}',
    ]);
    cursor.destroy();
  });

  it('suppresses cursor sends while docked, including a pending trailing send', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.boardMove(2, 2);
    cursor.dock(5, 'using');
    cursor.boardMove(3, 3);
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([
      { type: 'cursor', x: 1, y: 1 },
      { type: 'dock', slot: 5, mode: 'using' },
    ]);
    cursor.destroy();
  });

  it('sends the very next move after undock', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.dock(5, 'viewing');
    cursor.undock();
    cursor.boardMove(9, 9);
    expect(sent.at(-1)).toEqual({ type: 'cursor', x: 9, y: 9 });
    expect(sent).toHaveLength(3);
    cursor.destroy();
  });

  it('does not repeat a dock that the server already holds after an undock and dock without a move between', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(5, 'using');
    cursor.undock();
    cursor.dock(5, 'using');
    expect(sent).toHaveLength(1);
    cursor.destroy();
  });

  it('sends a dock again after a cursor message has replaced it', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.dock(5, 'using');
    cursor.undock();
    cursor.boardMove(1, 1);
    cursor.dock(5, 'using');
    expect(sent.map((m) => m.type)).toEqual(['dock', 'cursor', 'dock']);
    cursor.destroy();
  });
});

describe('createLocalCursor tab visibility', () => {
  it('sends away when the tab is hidden and drops a pending position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(1, 1);
    cursor.boardMove(2, 2);
    setVisibility('hidden');
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{ type: 'cursor', x: 1, y: 1 }, { type: 'away' }]);
    cursor.destroy();
  });

  it('resends the last position when the tab is visible again', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(10, 20);
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent.map((m) => m.type)).toEqual(['cursor', 'away', 'cursor']);
    expect(sent.at(-1)).toEqual({ type: 'cursor', x: 10, y: 20 });
    cursor.destroy();
  });

  it('resends the dock instead when docked', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.boardMove(10, 20);
    cursor.dock(5, 'viewing');
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent.map((m) => m.type)).toEqual(['cursor', 'dock', 'away', 'dock']);
    expect(sent.at(-1)).toEqual({ type: 'dock', slot: 5, mode: 'viewing' });
    cursor.destroy();
  });

  it('sends nothing on becoming visible when there was never a position', () => {
    const cursor = createLocalCursor({ viewport, socket });
    setVisibility('hidden');
    setVisibility('visible');
    expect(sent).toEqual([{ type: 'away' }]);
    cursor.destroy();
  });

  it('stops listening after destroy', () => {
    const cursor = createLocalCursor({ viewport, socket });
    cursor.destroy();
    setVisibility('hidden');
    expect(sent).toHaveLength(0);
  });

  it('listens on the document it is given', () => {
    const other = document.implementation.createHTMLDocument('other');
    Object.defineProperty(other, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const cursor = createLocalCursor({ viewport, socket, doc: other });
    other.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toEqual([{ type: 'away' }]);
    cursor.destroy();
  });
});

describe('createLocalCursor applyDesign', () => {
  const profile: Profile = { name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'pencil' } };

  it('sets the CSS cursor from the rendered image with its hot spot', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    await cursor.applyDesign(profile);
    expect(viewport.style.cursor).toMatch(/^url\("data:image\/svg\+xml;utf8,%3Csvg[^"]+"\) 2 30, auto$/);
    cursor.destroy();
  });

  it('uses the pixel art hot spot, doubled', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    await cursor.applyDesign({ ...profile, cursor: { kind: 'pixels', art: encodeArt(emptyGrid()), tip: [3, 4] } });
    expect(viewport.style.cursor).toMatch(/\) 6 8, auto$/);
    cursor.destroy();
  });

  it('keeps the newest design when two are applied in quick succession', async () => {
    const cursor = createLocalCursor({ viewport, socket });
    const first = cursor.applyDesign(profile);
    const second = cursor.applyDesign({ ...profile, cursor: { kind: 'shape', shape: 'hand' } });
    await Promise.all([first, second]);
    expect(viewport.style.cursor).toMatch(/\) 13 2, auto$/);
    cursor.destroy();
  });
});
