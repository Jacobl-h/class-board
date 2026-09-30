import { COLORS, LIMITS, SHAPES } from '@class-board/shared/constants';
import { decodeArt } from '@class-board/shared/pixelArt';
import { cleanText, isValidProfile } from '@class-board/shared/protocol';
import type { CursorDesign, ErrorCode, Profile, ShapeName } from '@class-board/shared/types';
import type { ProfilePanelOpts, Unsubscribe } from '../contracts';
import { cursorImage, shapeSvg, tagTextColor } from '../cursors/render';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
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

const TEACHER_TEXT = {
  bad: "That passcode isn't right.",
  locked_out: 'Too many tries. Wait 10 minutes and try again.',
  network: "Couldn't reach the board. Check your connection and try again.",
} as const;

function failureText(err: unknown): string {
  const code = (err as { code?: ErrorCode } | null)?.code;
  return (code && errorText(code)) || TEACHER_TEXT.network;
}

export function openProfilePanel(opts: ProfilePanelSeams): void {
  const initial = opts.initial && isValidProfile(opts.initial) ? opts.initial : null;
  const closable = !(opts.requireName && !initial);
  const random = opts.random ?? Math.random;

  let color: string = initial?.color ?? COLORS[Math.floor(random() * COLORS.length)]!;
  let shape: ShapeName = initial?.cursor.kind === 'shape' ? initial.cursor.shape : 'arrow';
  let tab: Tab = initial?.cursor.kind === 'pixels' ? 'pixels' : 'shape';
  let previewSeq = 0;
  let cleanedUp = false;
  let saving = false;
  /** What the board's lock state is after our own lock or unlock, until the panel re-reads it. */
  let lockedAfterAction: boolean | null = null;
  let codeInput: HTMLInputElement | null = null;
  const teacher = opts.teacher;
  const unsubscribe: Unsubscribe[] = [];

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

  const teacherError = h('p', { class: 'dialog-error teacher-error', hidden: true, attrs: { role: 'alert' } });
  const teacherContent = h('div', { class: 'profile-teacher-content' });
  const teacherSection = h('div', { class: 'profile-field profile-teacher', dataset: { section: 'teacher' } },
    h('span', { class: 'profile-label' }, 'Teacher'),
    teacherContent,
    teacherError);

  const saveButton = h('button', {
    type: 'button',
    class: 'profile-save',
    dataset: { action: 'save' },
    on: { click: () => save() },
  }, 'Save') as HTMLButtonElement;

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
    teacherSection,
    h('div', { class: 'profile-actions' }, saveButton));

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
    for (const off of unsubscribe) off();
    unsubscribe.length = 0;
  }

  function showTeacherError(text: string): void {
    teacherError.textContent = text;
    teacherError.hidden = false;
  }

  function hideTeacherError(): void {
    teacherError.hidden = true;
  }

  function renderTeacher(): void {
    hideTeacherError();
    if (teacher?.active()) {
      codeInput = null;
      const locked = lockedAfterAction ?? opts.locked?.() ?? false;
      const toggle = h('button', {
        type: 'button',
        class: 'teacher-primary',
        dataset: { action: locked ? 'unlock' : 'lock' },
        on: { click: () => void toggleLock(toggle, locked) },
      }, locked ? 'Unlock the board' : 'Lock the board') as HTMLButtonElement;
      const logout = h('button', {
        type: 'button',
        class: 'teacher-secondary',
        dataset: { action: 'logout' },
        on: {
          click: () => {
            teacher.logout();
            renderTeacher();
          },
        },
      }, 'Sign out');
      teacherContent.replaceChildren(
        h('p', { class: 'profile-hint' }, "You're signed in as a teacher."),
        h('div', { class: 'teacher-actions' }, toggle, logout),
      );
      return;
    }
    const previous = codeInput?.value ?? '';
    codeInput = h('input', {
      type: 'password',
      name: 'teacher-code',
      value: previous,
      autocomplete: 'off',
      on: {
        input: hideTeacherError,
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Enter') save();
        },
      },
    }) as HTMLInputElement;
    teacherContent.replaceChildren(
      h('label', { class: 'profile-teacher-field' },
        h('span', { class: 'profile-teacher-label' }, 'Teacher passcode'),
        codeInput),
      h('p', { class: 'profile-hint' }, 'Only for teachers. Leave it empty otherwise.'),
    );
  }

  async function toggleLock(button: HTMLButtonElement, wasLocked: boolean): Promise<void> {
    if (!teacher) return;
    button.disabled = true;
    hideTeacherError();
    try {
      await (wasLocked ? teacher.unlock() : teacher.lock());
      if (cleanedUp) return;
      lockedAfterAction = !wasLocked;
      renderTeacher();
    } catch (err) {
      if (cleanedUp) return;
      button.disabled = false;
      showTeacherError(failureText(err));
    }
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
    if (saving) return;
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
    const code = codeInput?.value ?? '';
    if (!code) {
      opts.onSave(profile);
      handle.close();
      return;
    }
    if (!teacher) {
      // Not connected yet (first visit): main.ts signs in once the board is there.
      opts.onSave(profile, code);
      handle.close();
      return;
    }
    void signInAndSave(profile, code);
  }

  async function signInAndSave(profile: Profile, code: string): Promise<void> {
    if (!teacher) return;
    saving = true;
    saveButton.disabled = true;
    hideTeacherError();
    try {
      const result = await teacher.login(code);
      if (cleanedUp) return;
      if (result === 'ok') {
        opts.onSave(profile);
        handle.close();
        return;
      }
      showTeacherError(TEACHER_TEXT[result]);
      codeInput?.select();
    } catch (err) {
      if (!cleanedUp) showTeacherError(failureText(err));
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  }

  if (teacher) {
    unsubscribe.push(teacher.onChange(() => {
      lockedAfterAction = null;
      renderTeacher();
    }));
  }
  renderTeacher();
  refreshControls();
  void refreshPreview();
  nameInput.focus();
}
