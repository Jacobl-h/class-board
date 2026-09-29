import { ART_FIXED_COLORS, ART_MAX_INDEX, ART_SIZE } from './constants';

/** ART_SIZE * ART_SIZE cells, row-major, each 0..ART_MAX_INDEX (0 = transparent, 1 = profile color). */
export type PixelGrid = Uint8Array;

const CELLS = ART_SIZE * ART_SIZE;
const BYTES = CELLS / 2;
/** 128 bytes as padded base64: 42 full groups plus a 2-byte tail. */
const ART_CHARS = Math.ceil(BYTES / 3) * 4;
const BASE64_RE = new RegExp(`^[A-Za-z0-9+/]{${ART_CHARS - 1}}=$`);

export function emptyGrid(): PixelGrid {
  return new Uint8Array(CELLS);
}

export function encodeArt(grid: PixelGrid): string {
  if (grid.length !== CELLS) throw new RangeError(`Pixel grid must have ${CELLS} cells, got ${grid.length}`);
  let binary = '';
  for (let i = 0; i < CELLS; i += 2) {
    const hi = grid[i]!;
    const lo = grid[i + 1]!;
    if (hi > ART_MAX_INDEX || lo > ART_MAX_INDEX) {
      throw new RangeError(`Pixel values must be 0..${ART_MAX_INDEX}`);
    }
    binary += String.fromCharCode((hi << 4) | lo);
  }
  return btoa(binary);
}

export function decodeArt(art: string): PixelGrid | null {
  if (typeof art !== 'string' || art.length !== ART_CHARS || !BASE64_RE.test(art)) return null;
  let binary: string;
  try {
    binary = atob(art);
  } catch {
    return null;
  }
  if (binary.length !== BYTES) return null;
  const grid = emptyGrid();
  for (let i = 0; i < BYTES; i++) {
    const byte = binary.charCodeAt(i);
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    if (hi > ART_MAX_INDEX || lo > ART_MAX_INDEX) return null;
    grid[i * 2] = hi;
    grid[i * 2 + 1] = lo;
  }
  // Reject non-canonical base64 (stray bits in the padding) so one drawing has one string.
  return encodeArt(grid) === art ? grid : null;
}

export function isValidArt(art: string): boolean {
  return decodeArt(art) !== null;
}

export function isValidTip(tip: unknown): tip is [number, number] {
  return (
    Array.isArray(tip) &&
    tip.length === 2 &&
    tip.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < ART_SIZE)
  );
}

/** Palette by cell value: index 0 is transparent (null), 1 is the profile color, then the fixed colors. */
export function paletteColors(profileColor: string): Array<string | null> {
  return [null, profileColor, ...ART_FIXED_COLORS];
}
