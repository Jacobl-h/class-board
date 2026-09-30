import { ART_SIZE, CURSOR } from '@class-board/shared/constants';
import { decodeArt, paletteColors } from '@class-board/shared/pixelArt';
import type { Profile, ShapeName } from '@class-board/shared/types';
import type { CursorImage } from '../contracts';

const OUTLINE = '#000000';
const FALLBACK_COLOR = '#5F5E5A';
const WHITE = '#FFFFFF';

/** Where each preset's hot spot sits inside its 32×32 image. */
export const SHAPE_TIPS: Record<ShapeName, [number, number]> = {
  arrow: [2, 2],
  hand: [13, 2],
  pencil: [2, 30],
  star: [16, 16],
  plane: [2, 2],
};

const OUTLINE_ATTRS = `stroke="${OUTLINE}" stroke-width="1" stroke-linejoin="miter" stroke-linecap="square"`;

/** Inner markup for each shape, drawn in a 32×32 box. `c` is the profile color. */
const SHAPE_BODIES: Record<ShapeName, (c: string) => string> = {
  arrow: (c) => `<path d="M2 2 L2 25 L8 19.5 L12.5 29 L17.5 26.8 L13 17.5 L21.5 17.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  hand: (c) =>
    `<path d="M13.5 2 C15 2 16 3.2 16 5 V12.5 C17.6 11.8 19.6 12.3 20 14 C21.8 13.6 23.6 14.4 23.9 16.2 C25.6 16.2 27 17.4 27 19.5 V24 C27 27.8 24.2 30 20.5 30 H15.5 C12.6 30 11.2 28.8 9.6 26.6 L4.6 19.2 C3.8 17.9 4.8 16.4 6.3 16.4 C7.4 16.4 8.2 17 9.2 18 L11 19.8 V5 C11 3.2 12 2 13.5 2 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  pencil: (c) =>
    `<path d="M2 30 L4.5 21.5 L22 4 C23.6 2.4 25.6 2.4 27.2 4 L28 4.8 C29.6 6.4 29.6 8.4 28 10 L10.5 27.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>` +
    `<path d="M4.5 21.5 L10.5 27.5" fill="none" ${OUTLINE_ATTRS}/>` +
    `<path d="M2 30 L3.4 25.3 L6.7 28.6 Z" fill="${OUTLINE}" ${OUTLINE_ATTRS}/>`,
  star: (c) =>
    `<path d="M16 2.5 L19.6 11.5 L29.3 12.2 L21.9 18.4 L24.2 27.8 L16 22.7 L7.8 27.8 L10.1 18.4 L2.7 12.2 L12.4 11.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>`,
  plane: (c) =>
    `<path d="M2 2 L30 12 L20 30 L15 17.5 Z" fill="${c}" ${OUTLINE_ATTRS}/>` +
    `<path d="M15 17.5 L30 12" fill="none" ${OUTLINE_ATTRS}/>`,
};

const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR.imageSize}" height="${CURSOR.imageSize}" viewBox="0 0 32 32"`;

/** Colors end up inside markup, so anything that isn't a plain hex color is replaced. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLOR;
}

/** Raw SVG markup for a preset shape, for previews. */
export function shapeSvg(shape: ShapeName, color: string): string {
  return `${SVG_OPEN}>${SHAPE_BODIES[shape](safeColor(color))}</svg>`;
}

function artSvg(art: string, color: string): string | null {
  const grid = decodeArt(art);
  if (!grid) return null;
  const palette = paletteColors(safeColor(color));
  const scale = CURSOR.imageSize / ART_SIZE;
  let rects = '';
  for (let i = 0; i < grid.length; i++) {
    const fill = palette[grid[i]!];
    if (!fill) continue;
    const x = (i % ART_SIZE) * scale;
    const y = Math.floor(i / ART_SIZE) * scale;
    rects += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="${fill}"/>`;
  }
  return `${SVG_OPEN} shape-rendering="crispEdges">${rects}</svg>`;
}

function toDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The cursor image for a profile. Pixel art that can't be decoded falls back to the arrow. */
export async function cursorImage(profile: Profile): Promise<CursorImage> {
  const { cursor, color } = profile;
  if (cursor.kind === 'pixels') {
    const svg = artSvg(cursor.art, color);
    if (svg) {
      const scale = CURSOR.imageSize / ART_SIZE;
      return { url: toDataUrl(svg), tipX: cursor.tip[0] * scale, tipY: cursor.tip[1] * scale, size: CURSOR.imageSize };
    }
  }
  const shape: ShapeName = cursor.kind === 'shape' ? cursor.shape : 'arrow';
  const [tipX, tipY] = SHAPE_TIPS[shape];
  return { url: toDataUrl(shapeSvg(shape, color)), tipX, tipY, size: CURSOR.imageSize };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** White or black, whichever contrasts more with the background (WCAG relative luminance). */
export function tagTextColor(bg: string): string {
  const l = luminance(bg);
  const contrastWithWhite = 1.05 / (l + 0.05);
  const contrastWithDark = (l + 0.05) / (luminance(OUTLINE) + 0.05);
  return contrastWithWhite >= contrastWithDark ? WHITE : OUTLINE;
}
