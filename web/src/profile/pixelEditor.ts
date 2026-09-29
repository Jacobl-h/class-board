import { ART_SIZE } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt, isValidTip, paletteColors, type PixelGrid } from '@class-board/shared/pixelArt';
import type { Unsubscribe } from '../contracts';
import { clear, h } from '../ui/dom';
import './pixelEditor.css';

export interface PixelEditorOpts {
  /** The profile color: palette index 1. */
  color: string;
  /** An encoded drawing to start from. Anything undecodable starts blank. */
  art?: string;
  /** Hot spot cell. Defaults to the center, (8, 8). */
  tip?: [number, number];
}

export interface PixelEditorChange { art: string; tip: [number, number] }

export interface PixelEditor {
  getArt(): string;
  getTip(): [number, number];
  /** Changes palette index 1 everywhere, so the drawing is recolored. */
  setColor(color: string): void;
  onChange(fn: (change: PixelEditorChange) => void): Unsubscribe;
  destroy(): void;
}

type Tool = 'pen' | 'eraser' | 'tip';

const TOOLS: Array<{ tool: Tool | 'clear'; label: string }> = [
  { tool: 'pen', label: 'Pen' },
  { tool: 'eraser', label: 'Eraser' },
  { tool: 'tip', label: 'Set tip' },
  { tool: 'clear', label: 'Clear' },
];

const CELL_COUNT = ART_SIZE * ART_SIZE;

export function createPixelEditor(root: HTMLElement, opts: PixelEditorOpts): PixelEditor {
  let color = opts.color;
  let grid: PixelGrid = (opts.art ? decodeArt(opts.art) : null) ?? emptyGrid();
  let tip: [number, number] = isValidTip(opts.tip) ? [opts.tip[0], opts.tip[1]] : [ART_SIZE / 2, ART_SIZE / 2];
  let tool: Tool = 'pen';
  let selected = 1;
  let drawing = false;
  const listeners = new Set<(change: PixelEditorChange) => void>();

  const cells: HTMLElement[] = [];
  const swatches: HTMLElement[] = [];
  const toolButtons = new Map<string, HTMLElement>();

  const gridEl = h('div', { class: 'pixel-grid', attrs: { role: 'group', 'aria-label': 'Cursor drawing, 16 by 16 cells' } });
  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = h('div', { class: 'pixel-cell', dataset: { cell: String(i) } });
    cells.push(cell);
    gridEl.append(cell);
  }

  const paletteEl = h('div', { class: 'pixel-palette', attrs: { role: 'group', 'aria-label': 'Colors' } });
  for (let i = 0; i <= 8; i++) {
    const swatch = h('button', {
      type: 'button',
      class: 'pixel-swatch',
      dataset: { palette: String(i) },
      attrs: { 'aria-label': i === 0 ? 'Transparent' : i === 1 ? 'Your color' : `Color ${i}` },
      on: { click: () => choosePalette(i) },
    });
    swatches.push(swatch);
    paletteEl.append(swatch);
  }

  const toolsEl = h('div', { class: 'pixel-tools', attrs: { role: 'group', 'aria-label': 'Tools' } });
  for (const { tool: name, label } of TOOLS) {
    const button = h('button', {
      type: 'button',
      class: 'pixel-tool',
      dataset: { tool: name },
      on: { click: () => (name === 'clear' ? clearGrid() : chooseTool(name)) },
    }, label);
    toolButtons.set(name, button);
    toolsEl.append(button);
  }

  const previewOne = h('div', { class: 'pixel-preview', dataset: { scale: '1' }, attrs: { 'aria-hidden': 'true' } });
  const previewTwo = h('div', { class: 'pixel-preview', dataset: { scale: '2' }, attrs: { 'aria-hidden': 'true' } });
  const previewsEl = h('div', { class: 'pixel-previews' },
    h('span', { class: 'pixel-preview-label' }, '1×'), previewOne,
    h('span', { class: 'pixel-preview-label' }, '2×'), previewTwo);

  const wrapper = h('div', { class: 'pixel-editor' }, toolsEl, paletteEl, gridEl, previewsEl);
  clear(root);
  root.append(wrapper);

  function palette(): Array<string | null> {
    return paletteColors(color);
  }

  function previewSvg(scale: number): string {
    const colors = palette();
    let rects = '';
    for (let i = 0; i < CELL_COUNT; i++) {
      const fill = colors[grid[i]!];
      if (fill) rects += `<rect x="${i % ART_SIZE}" y="${Math.floor(i / ART_SIZE)}" width="1" height="1" fill="${fill}"/>`;
    }
    const size = ART_SIZE * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${ART_SIZE} ${ART_SIZE}" shape-rendering="crispEdges">${rects}</svg>`;
  }

  function paintCell(i: number): void {
    const fill = palette()[grid[i]!];
    cells[i]!.style.background = fill ?? '';
    cells[i]!.dataset.value = String(grid[i]);
    cells[i]!.classList.toggle('is-tip', i === tip[1] * ART_SIZE + tip[0]);
  }

  function refreshPreviews(): void {
    previewOne.innerHTML = previewSvg(1);
    previewTwo.innerHTML = previewSvg(2);
  }

  function refreshPalette(): void {
    const colors = palette();
    swatches.forEach((swatch, i) => {
      const fill = colors[i];
      swatch.style.background = fill ?? '';
      swatch.classList.toggle('is-transparent', !fill);
      swatch.classList.toggle('is-selected', i === selected);
      swatch.setAttribute('aria-pressed', String(i === selected));
    });
  }

  function refreshTools(): void {
    for (const [name, button] of toolButtons) {
      if (name === 'clear') continue;
      button.classList.toggle('is-active', name === tool);
      button.setAttribute('aria-pressed', String(name === tool));
    }
  }

  function refreshAll(): void {
    for (let i = 0; i < CELL_COUNT; i++) paintCell(i);
    refreshPalette();
    refreshTools();
    refreshPreviews();
  }

  function emit(): void {
    const change = { art: encodeArt(grid), tip: [tip[0], tip[1]] as [number, number] };
    for (const fn of [...listeners]) fn(change);
  }

  function setCell(i: number, value: number): void {
    if (grid[i] === value) return;
    grid[i] = value;
    paintCell(i);
    refreshPreviews();
    emit();
  }

  function setTip(i: number): void {
    const next: [number, number] = [i % ART_SIZE, Math.floor(i / ART_SIZE)];
    if (next[0] === tip[0] && next[1] === tip[1]) return;
    const old = tip[1] * ART_SIZE + tip[0];
    tip = next;
    paintCell(old);
    paintCell(i);
    emit();
  }

  function apply(i: number): void {
    if (tool === 'tip') setTip(i);
    else setCell(i, tool === 'eraser' ? 0 : selected);
  }

  function choosePalette(i: number): void {
    selected = i;
    if (tool !== 'pen') tool = 'pen';
    refreshPalette();
    refreshTools();
  }

  function chooseTool(next: Tool): void {
    tool = next;
    refreshTools();
  }

  function clearGrid(): void {
    if (grid.every((v) => v === 0)) return;
    grid = emptyGrid();
    refreshAll();
    emit();
  }

  function cellOf(target: EventTarget | null): number | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-cell]') : null;
    return el && gridEl.contains(el) ? Number(el.dataset.cell) : null;
  }

  function onPointerDown(e: Event): void {
    const pe = e as PointerEvent;
    if (pe.button !== 0) return;
    const i = cellOf(e.target);
    if (i === null) return;
    // Touch pointers are captured by the first cell; release so later cells get pointerover.
    try {
      (e.target as Element).releasePointerCapture?.(pe.pointerId);
    } catch {
      // Not captured: nothing to release.
    }
    e.preventDefault();
    drawing = tool !== 'tip';
    apply(i);
  }

  function onPointerOver(e: Event): void {
    if (!drawing) return;
    const i = cellOf(e.target);
    if (i !== null) apply(i);
  }

  function endStroke(): void {
    drawing = false;
  }

  gridEl.addEventListener('pointerdown', onPointerDown);
  gridEl.addEventListener('pointerover', onPointerOver);
  const doc = root.ownerDocument;
  doc.addEventListener('pointerup', endStroke);
  doc.addEventListener('pointercancel', endStroke);

  refreshAll();

  return {
    getArt: () => encodeArt(grid),
    getTip: () => [tip[0], tip[1]],
    setColor(next) {
      color = next;
      refreshAll();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    destroy() {
      doc.removeEventListener('pointerup', endStroke);
      doc.removeEventListener('pointercancel', endStroke);
      listeners.clear();
      clear(root);
    },
  };
}
