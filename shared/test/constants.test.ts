import { describe, expect, it } from 'vitest';
import {
  BOARD_H, BOARD_W, COL_PITCH, COLORS, ROW_PITCH, SHAPES, SLOT_COUNT, ART_FIXED_COLORS,
} from '../src/constants';

describe('constants', () => {
  it('derives board geometry from tiles, labels and gutters', () => {
    expect(SLOT_COUNT).toBe(80);
    expect(COL_PITCH).toBe(528);
    expect(ROW_PITCH).toBe(380);
    expect(BOARD_W).toBe(5232);
    expect(BOARD_H).toBe(2992);
  });

  it('has 12 distinct cursor colors, 5 shapes and 7 fixed pixel colors', () => {
    expect(new Set(COLORS).size).toBe(12);
    expect(SHAPES).toEqual(['arrow', 'hand', 'pencil', 'star', 'plane']);
    expect(ART_FIXED_COLORS).toHaveLength(7);
  });
});
