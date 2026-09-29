import { describe, expect, it } from 'vitest';
import { ART_FIXED_COLORS, ART_MAX_INDEX, ART_SIZE } from '../src/constants';
import {
  decodeArt, emptyGrid, encodeArt, isValidArt, isValidTip, paletteColors,
} from '../src/pixelArt';

const CELLS = ART_SIZE * ART_SIZE;

/** Deterministic pseudo-random grid (LCG), so failures reproduce. */
function randomGrid(seed: number): Uint8Array {
  const grid = emptyGrid();
  let s = seed;
  for (let i = 0; i < CELLS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    grid[i] = (s >>> 16) % (ART_MAX_INDEX + 1);
  }
  return grid;
}

/** Encodes raw bytes the way encodeArt does, but without validating nibbles. */
function rawArt(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('emptyGrid', () => {
  it('has 256 transparent cells', () => {
    const grid = emptyGrid();
    expect(grid).toBeInstanceOf(Uint8Array);
    expect(grid).toHaveLength(CELLS);
    expect(grid.every((v) => v === 0)).toBe(true);
  });

  it('returns a fresh array each time', () => {
    const a = emptyGrid();
    a[0] = 3;
    expect(emptyGrid()[0]).toBe(0);
  });
});

describe('encodeArt and decodeArt', () => {
  it('encodes to exactly 172 characters of padded base64', () => {
    for (const grid of [emptyGrid(), randomGrid(1), randomGrid(2)]) {
      const art = encodeArt(grid);
      expect(art).toHaveLength(172);
      expect(art).toMatch(/^[A-Za-z0-9+/]{171}=$/);
    }
  });

  it('packs two cells per byte with the even cell in the high nibble', () => {
    const grid = emptyGrid();
    grid[0] = 1;
    grid[1] = 8;
    grid[2] = 2;
    grid[3] = 0;
    const bytes = Uint8Array.from(atob(encodeArt(grid)), (c) => c.charCodeAt(0));
    expect(bytes).toHaveLength(128);
    expect(bytes[0]).toBe(0x18);
    expect(bytes[1]).toBe(0x20);
    expect(bytes[2]).toBe(0);
  });

  it('encodes an empty grid as all A characters plus padding', () => {
    expect(encodeArt(emptyGrid())).toBe('A'.repeat(171) + '=');
  });

  it('round-trips random grids exactly', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const grid = randomGrid(seed);
      expect(decodeArt(encodeArt(grid))).toEqual(grid);
    }
  });

  it('round-trips a grid that uses every palette index', () => {
    const grid = emptyGrid();
    for (let i = 0; i < CELLS; i++) grid[i] = i % (ART_MAX_INDEX + 1);
    expect(decodeArt(encodeArt(grid))).toEqual(grid);
  });

  it('refuses to encode a grid of the wrong size', () => {
    expect(() => encodeArt(new Uint8Array(255))).toThrow(RangeError);
    expect(() => encodeArt(new Uint8Array(257))).toThrow(RangeError);
  });

  it('refuses to encode a value above the palette', () => {
    const grid = emptyGrid();
    grid[100] = ART_MAX_INDEX + 1;
    expect(() => encodeArt(grid)).toThrow(RangeError);
  });

  it('rejects strings that are not valid base64', () => {
    expect(decodeArt('!'.repeat(172))).toBeNull();
    expect(decodeArt('A'.repeat(170) + '=!')).toBeNull();
    expect(decodeArt('A'.repeat(172))).toBeNull();
    expect(decodeArt('A'.repeat(169) + '===')).toBeNull();
    expect(decodeArt('-'.repeat(171) + '=')).toBeNull();
  });

  it('rejects strings of the wrong length', () => {
    const good = encodeArt(randomGrid(3));
    expect(decodeArt('')).toBeNull();
    expect(decodeArt(good.slice(0, 171))).toBeNull();
    expect(decodeArt(good + 'A')).toBeNull();
    expect(decodeArt('A'.repeat(168))).toBeNull();
  });

  it('rejects values above the palette in either nibble', () => {
    const high = new Uint8Array(128);
    high[5] = 0x90;
    expect(decodeArt(rawArt(high))).toBeNull();
    const low = new Uint8Array(128);
    low[5] = 0x0f;
    expect(decodeArt(rawArt(low))).toBeNull();
    const max = new Uint8Array(128);
    max[5] = (ART_MAX_INDEX << 4) | ART_MAX_INDEX;
    expect(decodeArt(rawArt(max))).not.toBeNull();
  });

  it('rejects non-canonical base64 with stray bits in the padding', () => {
    const good = encodeArt(randomGrid(4));
    // The last character before "=" carries 2 unused bits; flipping one changes the text, not the bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = good[170]!;
    const flipped = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect(decodeArt(good.slice(0, 170) + flipped + '=')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(decodeArt(undefined as unknown as string)).toBeNull();
    expect(decodeArt(42 as unknown as string)).toBeNull();
  });
});

describe('isValidArt', () => {
  it('accepts encoded grids and rejects everything else', () => {
    expect(isValidArt(encodeArt(randomGrid(7)))).toBe(true);
    expect(isValidArt(encodeArt(emptyGrid()))).toBe(true);
    expect(isValidArt('nope')).toBe(false);
    expect(isValidArt('')).toBe(false);
    expect(isValidArt('A'.repeat(172))).toBe(false);
  });
});

describe('isValidTip', () => {
  it('accepts integer pairs from 0 to 15', () => {
    expect(isValidTip([0, 0])).toBe(true);
    expect(isValidTip([8, 8])).toBe(true);
    expect(isValidTip([15, 15])).toBe(true);
  });

  it('rejects out-of-range, fractional, non-numeric and wrongly shaped tips', () => {
    for (const bad of [
      [16, 0], [0, 16], [-1, 0], [0, -1], [1.5, 2], [NaN, 0], [Infinity, 0], ['1', 2],
      [1], [1, 2, 3], [], null, undefined, 'ab', { 0: 1, 1: 2 }, 8,
    ]) {
      expect(isValidTip(bad)).toBe(false);
    }
  });
});

describe('paletteColors', () => {
  it('lists transparent, the profile color, then the fixed colors', () => {
    const palette = paletteColors('#D85A30');
    expect(palette).toHaveLength(ART_MAX_INDEX + 1);
    expect(palette[0]).toBeNull();
    expect(palette[1]).toBe('#D85A30');
    expect(palette.slice(2)).toEqual([...ART_FIXED_COLORS]);
  });

  it('recolors index 1 with the profile color and nothing else', () => {
    const a = paletteColors('#111111');
    const b = paletteColors('#222222');
    expect(a[1]).not.toBe(b[1]);
    expect(a.filter((_, i) => i !== 1)).toEqual(b.filter((_, i) => i !== 1));
  });
});
