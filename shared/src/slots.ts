import {
  COL_PITCH, COLS, LABEL_H, ROW_PITCH, ROWS, SLOT_COUNT, TILE_H, TILE_W,
} from './constants';
import type { Rect, SlotIndex } from './types';

const ROW_LETTERS = Array.from({ length: ROWS }, (_, i) => String.fromCharCode(65 + i));
const NAME_RE = new RegExp(`^([A-${ROW_LETTERS[ROWS - 1]}])(${COLS}|[1-9])$`, 'i');
const CELL_H = LABEL_H + TILE_H;

export function isSlotIndex(n: unknown): n is SlotIndex {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SLOT_COUNT;
}

function assertSlot(slot: number): void {
  if (!isSlotIndex(slot)) throw new RangeError(`Not a slot index: ${slot}`);
}

export function slotRowCol(slot: SlotIndex): { row: number; col: number } {
  assertSlot(slot);
  return { row: Math.floor(slot / COLS), col: slot % COLS };
}

export function slotName(slot: SlotIndex): string {
  const { row, col } = slotRowCol(slot);
  return `${ROW_LETTERS[row]}${col + 1}`;
}

export function parseSlotName(name: string): SlotIndex | null {
  if (typeof name !== 'string') return null;
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const row = m[1].toUpperCase().charCodeAt(0) - 65;
  return row * COLS + (Number(m[2]) - 1);
}

export function tileRect(slot: SlotIndex): Rect {
  const { row, col } = slotRowCol(slot);
  return { x: col * COL_PITCH, y: row * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H };
}

export function labelRect(slot: SlotIndex): Rect {
  const { row, col } = slotRowCol(slot);
  return { x: col * COL_PITCH, y: row * ROW_PITCH, w: TILE_W, h: LABEL_H };
}

/** Index of the cell whose [start, start + size) span contains v, or -1 (gutter or outside). */
function cellIndex(v: number, pitch: number, size: number, count: number): number {
  if (!Number.isFinite(v) || v < 0) return -1;
  const i = Math.floor(v / pitch);
  return i < count && v - i * pitch < size ? i : -1;
}

export function slotAt(bx: number, by: number): SlotIndex | null {
  const col = cellIndex(bx, COL_PITCH, TILE_W, COLS);
  const row = cellIndex(by, ROW_PITCH, CELL_H, ROWS);
  return col < 0 || row < 0 ? null : row * COLS + col;
}

/** Index of the span [start, start + size] nearest to v; ties go to the lower index. */
function nearestIndex(v: number, start: (i: number) => number, size: number, count: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < count; i++) {
    const lo = start(i);
    const d = v < lo ? lo - v : v > lo + size ? v - (lo + size) : 0;
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

export function nearestSlot(bx: number, by: number): SlotIndex {
  // Tile bodies form a grid, so the nearest body is the nearest column crossed with the nearest row.
  const col = nearestIndex(bx, (i) => i * COL_PITCH, TILE_W, COLS);
  const row = nearestIndex(by, (i) => i * ROW_PITCH + LABEL_H, TILE_H, ROWS);
  return row * COLS + col;
}
