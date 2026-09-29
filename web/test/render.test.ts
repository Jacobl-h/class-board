import { describe, expect, it } from 'vitest';
import { COLORS, SHAPES } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import type { Profile } from '@class-board/shared/types';
import { cursorImage, shapeSvg, tagTextColor } from '../src/cursors/render';

const DATA_PREFIX = 'data:image/svg+xml;utf8,';

/** The SVG markup back out of a data URL. */
function svgOf(url: string): string {
  expect(url.startsWith(DATA_PREFIX)).toBe(true);
  return decodeURIComponent(url.slice(DATA_PREFIX.length));
}

function shapeProfile(shape: (typeof SHAPES)[number], color: string = COLORS[3]): Profile {
  return { name: 'Ana', color, cursor: { kind: 'shape', shape } };
}

describe('shapeSvg', () => {
  it.each(SHAPES)('draws %s at 32×32 with explicit width and height', (shape) => {
    const svg = shapeSvg(shape, COLORS[3]);
    expect(svg).toMatch(/^<svg [^>]*width="32"/);
    expect(svg).toContain('height="32"');
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it.each(SHAPES)('fills %s with the profile color and outlines it in a dark color', (shape) => {
    const svg = shapeSvg(shape, '#378ADD');
    expect(svg).toContain('#378ADD');
    expect(svg).toContain('#1A1A1A');
  });

  it('draws six different shapes', () => {
    const drawings = new Set(SHAPES.map((s) => shapeSvg(s, COLORS[0])));
    expect(drawings.size).toBe(6);
  });

  it('replaces a color that is not a plain hex value, so markup cannot be injected', () => {
    const svg = shapeSvg('arrow', '"/><script>alert(1)</script>');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('alert');
  });
});

describe('cursorImage for preset shapes', () => {
  it('returns an SVG data URL that a CSS url() value can hold', async () => {
    const img = await cursorImage(shapeProfile('arrow'));
    expect(img.url).toMatch(/^data:image\/svg\+xml;utf8,%3Csvg/);
    expect(img.url).not.toMatch(/["'()\s]/);
    expect(img.size).toBe(32);
    expect(svgOf(img.url)).toBe(shapeSvg('arrow', COLORS[3]));
  });

  it.each([
    ['arrow', 2, 2],
    ['hand', 13, 2],
    ['pencil', 2, 30],
    ['star', 16, 16],
    ['plane', 2, 2],
    ['crosshair', 16, 16],
  ] as const)('puts the %s hot spot at (%i, %i)', async (shape, x, y) => {
    const img = await cursorImage(shapeProfile(shape));
    expect([img.tipX, img.tipY]).toEqual([x, y]);
  });
});

describe('cursorImage for pixel art', () => {
  function pixelProfile(paint: (g: Uint8Array) => void, tip: [number, number] = [8, 8]): Profile {
    const grid = emptyGrid();
    paint(grid);
    return { name: 'Ben', color: '#D85A30', cursor: { kind: 'pixels', art: encodeArt(grid), tip } };
  }

  it('draws each filled cell as a 2×2 rect in its palette color and skips transparent cells', async () => {
    const img = await cursorImage(
      pixelProfile((g) => {
        g[0] = 1; // top-left, the profile color
        g[16 * 3 + 5] = 2; // row 3, column 5, black
        g[255] = 4; // bottom-right, red
      }),
    );
    const svg = svgOf(img.url);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('width="32" height="32"');
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg).toContain('<rect x="0" y="0" width="2" height="2" fill="#D85A30"/>');
    expect(svg).toContain('<rect x="10" y="6" width="2" height="2" fill="#000000"/>');
    expect(svg).toContain('<rect x="30" y="30" width="2" height="2" fill="#E24B4A"/>');
  });

  it('doubles the tip cell to get the hot spot in pixels', async () => {
    const img = await cursorImage(pixelProfile((g) => (g[0] = 1), [3, 5]));
    expect([img.tipX, img.tipY, img.size]).toEqual([6, 10, 32]);
  });

  it('recolors the drawing when the profile color changes', async () => {
    const art = pixelProfile((g) => (g[0] = 1));
    const recolored: Profile = { ...art, color: '#378ADD' };
    expect(svgOf((await cursorImage(recolored)).url)).toContain('fill="#378ADD"');
  });

  it('falls back to the arrow when the art cannot be decoded', async () => {
    const broken: Profile = { name: 'Ben', color: COLORS[0], cursor: { kind: 'pixels', art: 'not art', tip: [8, 8] } };
    const img = await cursorImage(broken);
    expect(svgOf(img.url)).toBe(shapeSvg('arrow', COLORS[0]));
    expect([img.tipX, img.tipY]).toEqual([2, 2]);
  });
});

describe('tagTextColor', () => {
  it('uses white on dark backgrounds', () => {
    expect(tagTextColor('#000000')).toBe('#FFFFFF');
    expect(tagTextColor('#534AB7')).toBe('#FFFFFF');
    expect(tagTextColor('#0F6E56')).toBe('#FFFFFF');
  });

  it('uses near-black on light backgrounds', () => {
    expect(tagTextColor('#FFFFFF')).toBe('#1A1A1A');
    expect(tagTextColor('#EF9F27')).toBe('#1A1A1A');
  });

  it('picks whichever of white and #1A1A1A has the higher contrast for all 12 profile colors', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const color of COLORS) {
      const chosen = tagTextColor(color);
      const other = chosen === '#FFFFFF' ? '#1A1A1A' : '#FFFFFF';
      expect(contrast(color, chosen)).toBeGreaterThanOrEqual(contrast(color, other));
    }
  });

  it('accepts short hex, and treats junk as a black background', () => {
    expect(tagTextColor('#fff')).toBe('#1A1A1A');
    expect(tagTextColor('#000')).toBe('#FFFFFF');
    expect(tagTextColor('not a color')).toBe('#FFFFFF');
  });
});
