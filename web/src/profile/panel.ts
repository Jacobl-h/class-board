import { COLORS, LIMITS, SHAPES } from '@class-board/shared/constants';
import { decodeArt } from '@class-board/shared/pixelArt';
import { cleanText, isValidProfile } from '@class-board/shared/protocol';
import type { CursorDesign, Profile, ShapeName } from '@class-board/shared/types';
import type { ProfilePanelOpts } from '../contracts';
import { cursorImage, shapeSvg, tagTextColor } from '../cursors/render';
import { h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { createPixelEditor } from './pixelEditor';
import './panel.css';

/** Optional test seam on top of the contract's options. */
export interface ProfilePanelSeams extends ProfilePanelOpts {
  /** Picks the starting color on a first visit. Defaults to Math.random. */
  random?: () => number;
}

type Tab = 'shape' | 'pixels';

const PLACEHOLDER_NAME = 'Your name';

export function openProfilePanel(opts: ProfilePanelSeams): void {
  const initial = opts.initial && isValidProfile(opts.initial) ? opts.initial : null;
  const closable = !(opts.requireName && !initial);
  const random = opts.random ?? Math.random;

  let color: string = initial?.color ?? COLORS[Math.floor(random() * COLORS.length)]!;
  let shape: ShapeName = initial?.cursor.kind === 'shape' ? initial.cursor.shape : 'arrow';
  let tab: Tab = initial?.cursor.kind === 'pixels' ? 'pixels' : 'shape';
  let previewSeq = 0;
  let cleanedUp = false;

  const nameInput = h('input', {
    type: 'text',
    name: 'name',
    value: initial?.name ?? '',
    maxLength: LIMITS.nameMax,
    autocomplete: 'off',
    attrs: { 'aria-label': 'Your name', placeholder: PLACEHOLDER_NAME },
    on: {
      input: () => {
        hideError();
        refreshTag();
      },
      keydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') save();
      },
    },
  }) as HTMLInputElement;

  const errorEl = h('p', { class: 'dialog-error', hidden: true, attrs: { role: 'alert' } });

  const swatches = COLORS.map((c, i) =>
    h('button', {
      type: 'button',
      class: 'profile-swatch',
      dataset: { color: c },
      style: { background: c },
      attrs: { 'aria-label': `Color ${i + 1}` },
      on: { click: () => chooseColor(c) },
    }),
  );

  const shapeButtons = SHAPES.map((s) =>
    h('button', {
      type: 'button',
      class: 'profile-shape',
      dataset: { shape: s },
      attrs: { 'aria-label': s },
      on: { click: () => chooseShape(s) },
    }),
  );

  const previewImg = h('img', { class: 'profile-preview-img', attrs: { alt: '', width: '32', height: '32' } });
  const previewTag = h('span', { class: 'profile-preview-tag' });

  const tabButtons = (['shape', 'pixels'] as const).map((t) =>
    h('button', {
      type: 'button',
      class: 'profile-tab',
      dataset: { tab: t },
      attrs: { role: 'tab' },
      on: { click: () => chooseTab(t) },
    }, t === 'shape' ? 'Pointer shapes' : 'Draw your own'),
  );

  const shapePanel = h('div', { class: 'profile-tabpanel', dataset: { panel: 'shape' }, attrs: { role: 'tabpanel' } },
    h('div', { class: 'profile-shapes' }, ...shapeButtons));
  const pixelsRoot = h('div', { class: 'profile-pixels' });
  const pixelsPanel = h('div', { class: 'profile-tabpanel', dataset: { panel: 'pixels' }, attrs: { role: 'tabpanel' } }, pixelsRoot);

  const editor = createPixelEditor(pixelsRoot, {
    color,
    art: initial?.cursor.kind === 'pixels' ? initial.cursor.art : undefined,
    tip: initial?.cursor.kind === 'pixels' ? initial.cursor.tip : undefined,
  });
  editor.onChange(() => {
    hideError();
    void refreshPreview();
  });

  const body = h('div', { class: 'profile-panel' },
    h('label', { class: 'profile-field' }, h('span', { class: 'profile-label' }, 'Name'), nameInput),
    errorEl,
    h('div', { class: 'profile-field' },
      h('span', { class: 'profile-label' }, 'Color'),
      h('div', { class: 'profile-swatches' }, ...swatches)),
    h('div', { class: 'profile-field' },
      h('div', { class: 'profile-tabs', attrs: { role: 'tablist' } }, ...tabButtons),
      shapePanel, pixelsPanel),
    h('div', { class: 'profile-preview' },
      h('span', { class: 'profile-label' }, 'Preview'),
      h('div', { class: 'profile-preview-box' }, previewImg, previewTag)),
    h('div', { class: 'profile-actions' },
      h('button', { type: 'button', class: 'profile-save', dataset: { action: 'save' }, on: { click: () => save() } }, 'Save')));

  const handle = openModal({
    title: 'Your cursor',
    dialog: 'profile',
    body,
    closable,
    onClose: cleanUp,
  });

  function cleanUp(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    previewSeq++;
    editor.destroy();
  }

  function currentCursor(): CursorDesign {
    return tab === 'pixels'
      ? { kind: 'pixels', art: editor.getArt(), tip: editor.getTip() }
      : { kind: 'shape', shape };
  }

  function showError(text: string): void {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function refreshTag(): void {
    previewTag.textContent = cleanText(nameInput.value, LIMITS.nameMax) || PLACEHOLDER_NAME;
    previewTag.style.background = color;
    previewTag.style.color = tagTextColor(color);
  }

  async function refreshPreview(): Promise<void> {
    const seq = ++previewSeq;
    const image = await cursorImage({ name: PLACEHOLDER_NAME, color, cursor: currentCursor() });
    if (seq !== previewSeq) return;
    previewImg.setAttribute('src', image.url);
  }

  function refreshControls(): void {
    for (const swatch of swatches) {
      const on = swatch.dataset.color === color;
      swatch.classList.toggle('is-selected', on);
      swatch.setAttribute('aria-pressed', String(on));
    }
    for (const button of shapeButtons) {
      const on = button.dataset.shape === shape;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
      button.innerHTML = shapeSvg(button.dataset.shape as ShapeName, color);
    }
    for (const button of tabButtons) {
      const on = button.dataset.tab === tab;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-selected', String(on));
    }
    shapePanel.hidden = tab !== 'shape';
    pixelsPanel.hidden = tab !== 'pixels';
    refreshTag();
  }

  function chooseColor(next: string): void {
    color = next;
    editor.setColor(next);
    refreshControls();
    void refreshPreview();
  }

  function chooseShape(next: ShapeName): void {
    shape = next;
    refreshControls();
    void refreshPreview();
  }

  function chooseTab(next: Tab): void {
    tab = next;
    hideError();
    refreshControls();
    void refreshPreview();
  }

  function save(): void {
    const name = cleanText(nameInput.value, LIMITS.nameMax);
    if (!name) {
      showError('Enter a name. Others see it next to your cursor.');
      nameInput.focus();
      return;
    }
    const cursor = currentCursor();
    if (cursor.kind === 'pixels' && decodeArt(cursor.art)?.every((v) => v === 0)) {
      showError('Your drawing is empty. Draw something or pick a shape.');
      return;
    }
    const profile: Profile = { name, color, cursor };
    if (!isValidProfile(profile)) {
      showError("That cursor isn't valid. Check the name and drawing, then try again.");
      return;
    }
    opts.onSave(profile);
    handle.close();
  }

  refreshControls();
  void refreshPreview();
  nameInput.focus();
}
