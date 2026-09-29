import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W, COL_PITCH, LABEL_H, ROW_PITCH, SLOT_COUNT, TILE_H, TILE_W } from '../src/constants';
import {
  isSlotIndex, labelRect, nearestSlot, parseSlotName, slotAt, slotName, slotRowCol, tileRect,
} from '../src/slots';

describe('isSlotIndex', () => {
  it('accepts integers from 0 to 79', () => {
    expect(isSlotIndex(0)).toBe(true);
    expect(isSlotIndex(23)).toBe(true);
    expect(isSlotIndex(79)).toBe(true);
  });

  it('rejects out-of-range, fractional, non-finite and non-number values', () => {
    for (const bad of [-1, 80, 1.5, NaN, Infinity, '3', null, undefined, {}, [1]]) {
      expect(isSlotIndex(bad)).toBe(false);
    }
  });
});

describe('slotRowCol and slotName', () => {
  it('maps slot indexes to zero-based rows and columns', () => {
    expect(slotRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(slotRowCol(9)).toEqual({ row: 0, col: 9 });
    expect(slotRowCol(10)).toEqual({ row: 1, col: 0 });
    expect(slotRowCol(23)).toEqual({ row: 2, col: 3 });
    expect(slotRowCol(79)).toEqual({ row: 7, col: 9 });
  });

  it('names slots A1 through H10, with C4 at index 23', () => {
    expect(slotName(0)).toBe('A1');
    expect(slotName(9)).toBe('A10');
    expect(slotName(10)).toBe('B1');
    expect(slotName(23)).toBe('C4');
    expect(slotName(79)).toBe('H10');
  });

  it('gives every slot a distinct name', () => {
    const names = new Set(Array.from({ length: SLOT_COUNT }, (_, i) => slotName(i)));
    expect(names.size).toBe(SLOT_COUNT);
  });

  it('throws a RangeError for an index that is not a slot', () => {
    expect(() => slotName(80)).toThrow(RangeError);
    expect(() => slotName(-1)).toThrow(RangeError);
    expect(() => slotRowCol(1.5)).toThrow(RangeError);
  });
});

describe('parseSlotName', () => {
  it('parses names case-insensitively', () => {
    expect(parseSlotName('C4')).toBe(23);
    expect(parseSlotName('c4')).toBe(23);
    expect(parseSlotName('A1')).toBe(0);
    expect(parseSlotName('a10')).toBe(9);
    expect(parseSlotName('H10')).toBe(79);
  });

  it('round-trips with slotName for every slot', () => {
    for (let i = 0; i < SLOT_COUNT; i++) expect(parseSlotName(slotName(i))).toBe(i);
  });

  it('returns null for columns and rows outside the grid', () => {
    for (const bad of ['C11', 'C0', 'I1', 'A11', 'Z9', 'H100']) {
      expect(parseSlotName(bad)).toBeNull();
    }
  });

  it('returns null for malformed input', () => {
    for (const bad of ['', 'C', '4', 'C04', ' C4', 'C4 ', 'CC4', 'C-1', 'C4x', '#C4', '4C', 'C 4']) {
      expect(parseSlotName(bad)).toBeNull();
    }
  });

  it('returns null when the input is not a string', () => {
    expect(parseSlotName(undefined as unknown as string)).toBeNull();
    expect(parseSlotName(23 as unknown as string)).toBeNull();
  });
});

describe('tileRect and labelRect', () => {
  it('places corner tiles by pitch, below their label strip', () => {
    expect(tileRect(0)).toEqual({ x: 0, y: LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(9)).toEqual({ x: 9 * COL_PITCH, y: LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(70)).toEqual({ x: 0, y: 7 * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(79)).toEqual({ x: 9 * COL_PITCH, y: 7 * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H });
  });

  it('puts the label strip directly above the tile body', () => {
    for (const slot of [0, 9, 23, 70, 79]) {
      const label = labelRect(slot);
      const body = tileRect(slot);
      expect(label).toEqual({ x: body.x, y: body.y - LABEL_H, w: TILE_W, h: LABEL_H });
    }
  });

  it('ends the last tile exactly at the board edge', () => {
    const last = tileRect(79);
    expect(last.x + last.w).toBe(BOARD_W);
    expect(last.y + last.h).toBe(BOARD_H);
  });

  it('throws a RangeError for an index that is not a slot', () => {
    expect(() => tileRect(80)).toThrow(RangeError);
    expect(() => labelRect(-1)).toThrow(RangeError);
  });
});

describe('slotAt', () => {
  it('finds the slot under a point on its label or body', () => {
    const body = tileRect(23);
    const label = labelRect(23);
    expect(slotAt(body.x + body.w / 2, body.y + body.h / 2)).toBe(23);
    expect(slotAt(label.x + 10, label.y + 10)).toBe(23);
  });

  it('includes the top-left corner and excludes the far edges', () => {
    expect(slotAt(0, 0)).toBe(0);
    expect(slotAt(TILE_W - 1, LABEL_H + TILE_H - 1)).toBe(0);
    expect(slotAt(TILE_W, 100)).toBeNull();
    expect(slotAt(100, LABEL_H + TILE_H)).toBeNull();
  });

  it('returns null in the gutters between tiles', () => {
    expect(slotAt(TILE_W + 10, 100)).toBeNull();
    expect(slotAt(100, LABEL_H + TILE_H + 10)).toBeNull();
    expect(slotAt(COL_PITCH - 1, ROW_PITCH - 1)).toBeNull();
  });

  it('starts the next tile at the pitch', () => {
    expect(slotAt(COL_PITCH, 10)).toBe(1);
    expect(slotAt(10, ROW_PITCH)).toBe(10);
  });

  it('returns null outside the board and for non-finite points', () => {
    expect(slotAt(-1, 10)).toBeNull();
    expect(slotAt(10, -1)).toBeNull();
    expect(slotAt(BOARD_W, 10)).toBeNull();
    expect(slotAt(10, BOARD_H)).toBeNull();
    expect(slotAt(NaN, 10)).toBeNull();
    expect(slotAt(10, Infinity)).toBeNull();
  });

  it('agrees with tileRect for every slot center', () => {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const r = tileRect(i);
      expect(slotAt(r.x + r.w / 2, r.y + r.h / 2)).toBe(i);
    }
  });
});

describe('nearestSlot', () => {
  it('returns the slot itself for any point inside its body or label', () => {
    const body = tileRect(23);
    expect(nearestSlot(body.x + 5, body.y + 5)).toBe(23);
    expect(nearestSlot(labelRect(23).x + 5, labelRect(23).y + 5)).toBe(23);
  });

  it('picks the closer tile from a horizontal gutter', () => {
    expect(nearestSlot(TILE_W + 10, 100)).toBe(0);
    expect(nearestSlot(COL_PITCH - 10, 100)).toBe(1);
  });

  it('picks the closer tile from a vertical gutter, counting the label as part of the next row', () => {
    expect(nearestSlot(100, LABEL_H + TILE_H + 8)).toBe(0);
    expect(nearestSlot(100, ROW_PITCH)).toBe(10);
  });

  it('breaks an exact tie toward the lower slot', () => {
    expect(nearestSlot(TILE_W + 24, 100)).toBe(0);
  });

  it('snaps points outside the board to the nearest edge or corner tile', () => {
    expect(nearestSlot(-500, -500)).toBe(0);
    expect(nearestSlot(BOARD_W + 500, -500)).toBe(9);
    expect(nearestSlot(-500, BOARD_H + 500)).toBe(70);
    expect(nearestSlot(BOARD_W + 500, BOARD_H + 500)).toBe(79);
    expect(nearestSlot(3 * COL_PITCH + 100, -400)).toBe(3);
    expect(nearestSlot(3 * COL_PITCH + 100, BOARD_H + 400)).toBe(73);
  });

  it('returns a valid slot for every point on a coarse sweep', () => {
    for (let x = -600; x <= BOARD_W + 600; x += 397) {
      for (let y = -600; y <= BOARD_H + 600; y += 331) {
        expect(isSlotIndex(nearestSlot(x, y))).toBe(true);
      }
    }
  });
});
