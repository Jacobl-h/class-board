import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ART_FIXED_COLORS } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { createPixelEditor } from '../src/profile/pixelEditor';

const COLOR = '#378ADD';

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
});

const cell = (i: number) => root.querySelector<HTMLElement>(`.pixel-grid [data-cell="${i}"]`)!;
const tool = (name: string) => root.querySelector<HTMLElement>(`[data-tool="${name}"]`)!;
const swatch = (i: number) => root.querySelector<HTMLElement>(`[data-palette="${i}"]`)!;

function pointer(el: Element, type: string, init: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

function pixels(editor: { getArt(): string }): Uint8Array {
  return decodeArt(editor.getArt())!;
}

describe('createPixelEditor structure', () => {
  it('renders a 16×16 grid of numbered cells', () => {
    createPixelEditor(root, { color: COLOR });
    const cells = root.querySelectorAll('.pixel-grid [data-cell]');
    expect(cells).toHaveLength(256);
    expect(cells[0]!.getAttribute('data-cell')).toBe('0');
    expect(cells[255]!.getAttribute('data-cell')).toBe('255');
  });

  it('renders the four tools', () => {
    createPixelEditor(root, { color: COLOR });
    for (const name of ['pen', 'eraser', 'tip', 'clear']) expect(tool(name)).not.toBeNull();
  });

  it('shows nine palette swatches: transparent, the profile color, then the fixed colors', () => {
    createPixelEditor(root, { color: COLOR });
    expect(root.querySelectorAll('[data-palette]')).toHaveLength(9);
    expect(swatch(0).classList.contains('is-transparent')).toBe(true);
    expect(swatch(1).style.background).not.toBe('');
    expect(swatch(2).getAttribute('aria-label')).toBe('Color 2');
    expect(ART_FIXED_COLORS).toHaveLength(7);
  });

  it('starts blank with the pen on your color and the tip in the center', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([8, 8]);
    expect(swatch(1).getAttribute('aria-pressed')).toBe('true');
    expect(swatch(2).getAttribute('aria-pressed')).toBe('false');
    expect(tool('pen').getAttribute('aria-pressed')).toBe('true');
    expect(cell(8 * 16 + 8).classList.contains('is-tip')).toBe(true);
    expect(root.querySelectorAll('.is-tip')).toHaveLength(1);
  });

  it('starts from the art and tip it is given', () => {
    const grid = emptyGrid();
    grid[5] = 3;
    const editor = createPixelEditor(root, { color: COLOR, art: encodeArt(grid), tip: [2, 3] });
    expect(pixels(editor)[5]).toBe(3);
    expect(cell(5).dataset.value).toBe('3');
    expect(editor.getTip()).toEqual([2, 3]);
    expect(cell(3 * 16 + 2).classList.contains('is-tip')).toBe(true);
  });

  it('starts blank and centered when the art or tip it is given is invalid', () => {
    const editor = createPixelEditor(root, { color: COLOR, art: 'garbage', tip: [99, 0] });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([8, 8]);
  });

  it('draws 1× and 2× previews', () => {
    createPixelEditor(root, { color: COLOR });
    expect(root.querySelector('.pixel-preview[data-scale="1"] svg')!.getAttribute('width')).toBe('16');
    expect(root.querySelector('.pixel-preview[data-scale="2"] svg')!.getAttribute('width')).toBe('32');
  });
});

describe('painting', () => {
  it('paints a cell with the selected color on pointer down', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(17), 'pointerdown');
    expect(pixels(editor)[17]).toBe(1);
    expect(cell(17).dataset.value).toBe('1');
    pointer(document.body, 'pointerup');
  });

  it('paints with a fixed palette color after it is chosen', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    swatch(4).click();
    expect(swatch(4).getAttribute('aria-pressed')).toBe('true');
    expect(swatch(1).getAttribute('aria-pressed')).toBe('false');
    pointer(cell(0), 'pointerdown');
    expect(pixels(editor)[0]).toBe(4);
    pointer(document.body, 'pointerup');
  });

  it('paints every cell the pointer passes over while it is held down', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(cell(1), 'pointerover');
    pointer(cell(2), 'pointerover');
    pointer(document.body, 'pointerup');
    pointer(cell(3), 'pointerover');
    const g = pixels(editor);
    expect([g[0], g[1], g[2], g[3]]).toEqual([1, 1, 1, 0]);
  });

  it('ignores pointer moves when no stroke has started', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(5), 'pointerover');
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
  });

  it('ignores non-primary mouse buttons', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(5), 'pointerdown', { button: 2 });
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
  });

  it('erases with the eraser tool', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(9), 'pointerdown');
    pointer(document.body, 'pointerup');
    tool('eraser').click();
    expect(tool('eraser').getAttribute('aria-pressed')).toBe('true');
    expect(tool('pen').getAttribute('aria-pressed')).toBe('false');
    pointer(cell(9), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(pixels(editor)[9]).toBe(0);
  });

  it('goes back to the pen when a palette color is chosen while erasing', () => {
    createPixelEditor(root, { color: COLOR });
    tool('eraser').click();
    swatch(2).click();
    expect(tool('pen').getAttribute('aria-pressed')).toBe('true');
  });

  it('clears the whole drawing', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(1), 'pointerdown');
    pointer(cell(2), 'pointerover');
    pointer(document.body, 'pointerup');
    tool('clear').click();
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(cell(1).dataset.value).toBe('0');
  });

  it('keeps the tip where it was when the drawing is cleared', () => {
    const editor = createPixelEditor(root, { color: COLOR, tip: [1, 1] });
    pointer(cell(40), 'pointerdown');
    pointer(document.body, 'pointerup');
    tool('clear').click();
    expect(editor.getTip()).toEqual([1, 1]);
  });
});

describe('the tip', () => {
  it('moves to the clicked cell and marks it', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    tool('tip').click();
    pointer(cell(2 * 16 + 5), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(editor.getTip()).toEqual([5, 2]);
    expect(cell(2 * 16 + 5).classList.contains('is-tip')).toBe(true);
    expect(cell(8 * 16 + 8).classList.contains('is-tip')).toBe(false);
    expect(root.querySelectorAll('.is-tip')).toHaveLength(1);
  });

  it('does not paint when the tip tool is used, even when dragging', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    tool('tip').click();
    pointer(cell(0), 'pointerdown');
    pointer(cell(1), 'pointerover');
    pointer(document.body, 'pointerup');
    expect(editor.getArt()).toBe(encodeArt(emptyGrid()));
    expect(editor.getTip()).toEqual([0, 0]);
  });
});

describe('setColor', () => {
  it('recolors the palette, the cells and the previews without changing the art', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    const before = editor.getArt();
    const swatchBefore = swatch(1).style.background;
    editor.setColor('#D85A30');
    expect(editor.getArt()).toBe(before);
    expect(swatch(1).style.background).not.toBe(swatchBefore);
    expect(root.querySelector('.pixel-preview[data-scale="1"]')!.innerHTML.toLowerCase()).toContain('#d85a30');
    expect(root.querySelector('.pixel-preview[data-scale="1"]')!.innerHTML.toLowerCase()).not.toContain('#378add');
  });
});

describe('onChange and destroy', () => {
  it('reports each change with the encoded art and the tip', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    const fn = vi.fn();
    editor.onChange(fn);
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith({ art: editor.getArt(), tip: [8, 8] });
  });

  it('does not report painting a cell with the color it already has', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    const fn = vi.fn();
    editor.onChange(fn);
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops reporting after the returned unsubscribe is called', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    const fn = vi.fn();
    const off = editor.onChange(fn);
    off();
    pointer(cell(0), 'pointerdown');
    pointer(document.body, 'pointerup');
    expect(fn).not.toHaveBeenCalled();
  });

  it('removes its markup on destroy', () => {
    const editor = createPixelEditor(root, { color: COLOR });
    editor.destroy();
    expect(root.children).toHaveLength(0);
  });
});
