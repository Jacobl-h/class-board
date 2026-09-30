import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS, SHAPES } from '@class-board/shared/constants';
import { decodeArt, emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { defaultProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import type { TeacherApi, TeacherLogin } from '../src/contracts';
import { cursorImage, shapeSvg } from '../src/cursors/render';
import { openProfilePanel } from '../src/profile/panel';
import { errorText } from '../src/ui/errors';

let saved: Profile[];
let savedCodes: (string | undefined)[];
const onSave = (p: Profile, code?: string) => {
  saved.push(p);
  savedCodes.push(code);
};

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
  saved = [];
  savedCodes = [];
});

afterEach(() => {
  // Closing the open modal also releases the pixel editor's document listeners.
  document.querySelector<HTMLElement>('.modal [data-action="close"]')?.click();
  document.body.innerHTML = '';
});

const modal = () => document.querySelector<HTMLElement>('.modal[data-dialog="profile"]');
const q = <T extends HTMLElement = HTMLElement>(selector: string) => modal()!.querySelector<T>(selector)!;
const nameInput = () => q<HTMLInputElement>('input[name="name"]');
const error = () => q('.dialog-error');
const save = () => q('[data-action="save"]').click();

/** Every way a person can dismiss a modal. When the dialog is not closable none of them may work. */
function tryToClose(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  modal()?.querySelector<HTMLElement>('[data-action="close"]')?.click();
}

function typeName(value: string): void {
  nameInput().value = value;
  nameInput().dispatchEvent(new Event('input', { bubbles: true }));
}

function pointerDown(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

/** Markup as the DOM serializes it, so it can be compared with what an element holds. */
function serialized(markup: string): string {
  const scratch = document.createElement('div');
  scratch.innerHTML = markup;
  return scratch.innerHTML;
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('opening', () => {
  it('opens a modal for the profile dialog titled "Your cursor"', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    expect(modal()).not.toBeNull();
    expect(modal()!.textContent).toContain('Your cursor');
  });

  it('cannot be closed while a name is required and there is no valid profile yet', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    tryToClose();
    expect(modal()).not.toBeNull();
  });

  it('cannot be closed when the stored profile is invalid', () => {
    const broken = { name: '', color: COLORS[0], cursor: { kind: 'shape', shape: 'arrow' } } as Profile;
    openProfilePanel({ initial: broken, requireName: true, onSave });
    tryToClose();
    expect(modal()).not.toBeNull();
  });

  it('can be closed when editing an existing profile', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(modal()!.querySelector('[data-action="close"]')).not.toBeNull();
    tryToClose();
    expect(modal()).toBeNull();
    expect(saved).toEqual([]);
  });

  it('can be closed when no name is required', () => {
    openProfilePanel({ initial: null, requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(modal()).toBeNull();
  });

  it('prefills the name and limits it to 24 characters', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(nameInput().value).toBe('Ana');
    expect(nameInput().maxLength).toBe(24);
  });

  it('starts on a random color on a first visit and on your own color when editing', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[0]);
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0.999 });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[11]);
    openProfilePanel({ initial: { ...defaultProfile('Ana'), color: COLORS[4] }, requireName: true, onSave });
    expect(q('[data-color].is-selected').dataset.color).toBe(COLORS[4]);
  });
});

describe('colors, shapes and tabs', () => {
  it('offers the 12 colors as [data-color] swatches', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    const found = [...modal()!.querySelectorAll<HTMLElement>('[data-color]')].map((el) => el.dataset.color);
    expect(found).toEqual([...COLORS]);
  });

  it('selects the clicked color and marks only it', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q(`[data-color="${COLORS[5]}"]`).click();
    expect(modal()!.querySelectorAll('[data-color].is-selected')).toHaveLength(1);
    expect(q(`[data-color="${COLORS[5]}"]`).getAttribute('aria-pressed')).toBe('true');
    expect(q(`[data-color="${COLORS[0]}"]`).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the five shapes drawn in the chosen color', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    const found = [...modal()!.querySelectorAll<HTMLElement>('[data-shape]')].map((el) => el.dataset.shape);
    expect(found).toEqual([...SHAPES]);
    expect(q('[data-shape="star"]').innerHTML).toBe(serialized(shapeSvg('star', COLORS[0])));
    q(`[data-color="${COLORS[3]}"]`).click();
    expect(q('[data-shape="star"]').innerHTML).toBe(serialized(shapeSvg('star', COLORS[3])));
  });

  it('marks the chosen shape', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(q('[data-shape="arrow"]').getAttribute('aria-pressed')).toBe('true');
    q('[data-shape="plane"]').click();
    expect(q('[data-shape="arrow"]').getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-shape="plane"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on the shape tab and switches to the pixel editor', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    expect(q('[data-panel="shape"]').hidden).toBe(false);
    expect(q('[data-panel="pixels"]').hidden).toBe(true);
    q('[data-tab="pixels"]').click();
    expect(q('[data-panel="shape"]').hidden).toBe(true);
    expect(q('[data-panel="pixels"]').hidden).toBe(false);
    expect(q('[data-tab="pixels"]').getAttribute('aria-selected')).toBe('true');
    expect(modal()!.querySelectorAll('.pixel-grid [data-cell]')).toHaveLength(256);
    expect(modal()!.querySelectorAll('[data-tool]')).toHaveLength(4);
  });

  it('opens on the pixels tab when the profile has a drawing', () => {
    const grid = emptyGrid();
    grid[0] = 1;
    const initial: Profile = { name: 'Ben', color: COLORS[1], cursor: { kind: 'pixels', art: encodeArt(grid), tip: [2, 3] } };
    openProfilePanel({ initial, requireName: true, onSave });
    expect(q('[data-panel="pixels"]').hidden).toBe(false);
    save();
    expect(saved).toEqual([initial]);
  });
});

describe('saving', () => {
  it('saves the name, color and chosen shape, then closes', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    typeName('Ana');
    q(`[data-color="${COLORS[3]}"]`).click();
    q('[data-shape="star"]').click();
    save();
    expect(saved).toEqual([{ name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'star' } }]);
    expect(modal()).toBeNull();
  });

  it('saves a cleaned name: control characters removed, spaces collapsed, cut to 24', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName('  Ana \n\t  Lee  ');
    save();
    expect(saved[0]!.name).toBe('Ana Lee');
  });

  it('saves when Enter is pressed in the name field', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName('Ana');
    nameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(saved).toHaveLength(1);
  });

  it.each(['', '   ', ' \n\t '])('shows an inline error and stays open when the name is %j', (value) => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName(value);
    save();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe('Enter a name. Others see it next to your cursor.');
    expect(saved).toEqual([]);
    expect(modal()).not.toBeNull();
  });

  it('hides the error again once the person starts typing', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    save();
    expect(error().hidden).toBe(false);
    typeName('A');
    expect(error().hidden).toBe(true);
  });

  it('saves a pixel drawing with its tip', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    pointerDown(q('.pixel-grid [data-cell="17"]'));
    q('[data-tool="tip"]').click();
    pointerDown(q('.pixel-grid [data-cell="35"]'));
    save();
    expect(saved).toHaveLength(1);
    const cursor = saved[0]!.cursor;
    expect(cursor.kind).toBe('pixels');
    if (cursor.kind !== 'pixels') return;
    expect(cursor.tip).toEqual([3, 2]);
    expect(decodeArt(cursor.art)![17]).toBe(1);
  });

  it('keeps the drawing and saves the new color when the color changes on the pixels tab', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    pointerDown(q('.pixel-grid [data-cell="0"]'));
    q(`[data-color="${COLORS[6]}"]`).click();
    expect(q('[data-palette="1"]').style.background).not.toBe('');
    save();
    expect(saved[0]!.color).toBe(COLORS[6]);
    const cursor = saved[0]!.cursor;
    expect(cursor.kind === 'pixels' && decodeArt(cursor.art)![0]).toBe(1);
  });

  it('refuses an empty drawing, says why, and stays open', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    save();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe('Your drawing is empty. Draw something or pick a shape.');
    expect(saved).toEqual([]);
    expect(modal()).not.toBeNull();
  });

  it('saves a shape after switching back from an empty drawing', () => {
    openProfilePanel({ initial: defaultProfile('Ben'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    q('[data-tab="shape"]').click();
    save();
    expect(saved[0]!.cursor).toEqual({ kind: 'shape', shape: 'arrow' });
  });

  it('does not call onSave when it is closed instead', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(saved).toEqual([]);
  });
});

describe('preview', () => {
  const previewSrc = () => q<HTMLImageElement>('.profile-preview-img').getAttribute('src');

  it('shows the cursor image for the current design', async () => {
    openProfilePanel({ initial: { ...defaultProfile('Ana'), color: COLORS[3] }, requireName: true, onSave });
    await settle();
    const expected = await cursorImage({ name: 'x', color: COLORS[3], cursor: { kind: 'shape', shape: 'arrow' } });
    expect(previewSrc()).toBe(expected.url);
  });

  it('follows the color and the shape', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q(`[data-color="${COLORS[7]}"]`).click();
    q('[data-shape="hand"]').click();
    await settle();
    const expected = await cursorImage({ name: 'x', color: COLORS[7], cursor: { kind: 'shape', shape: 'hand' } });
    expect(previewSrc()).toBe(expected.url);
  });

  it('follows the drawing while it is being painted', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    q('[data-tab="pixels"]').click();
    await settle();
    const blank = previewSrc();
    pointerDown(q('.pixel-grid [data-cell="40"]'));
    await settle();
    expect(previewSrc()).not.toBe(blank);
  });

  it('shows the typed name in a tag colored like the cursor', () => {
    openProfilePanel({ initial: null, requireName: true, onSave, random: () => 0 });
    expect(q('.profile-preview-tag').textContent).toBe('Your name');
    typeName('  Ana  ');
    expect(q('.profile-preview-tag').textContent).toBe('Ana');
    const probe = document.createElement('i');
    probe.style.background = COLORS[0];
    expect(q('.profile-preview-tag').style.background).toBe(probe.style.background);
  });

  it('stops updating after the panel is closed', async () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    const img = q<HTMLImageElement>('.profile-preview-img');
    q('[data-action="close"]').click();
    const src = img.getAttribute('src');
    await settle();
    expect(img.getAttribute('src')).toBe(src);
  });
});

describe('cleanup', () => {
  it('releases the pixel editor when the panel closes', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: false, onSave });
    q('[data-action="close"]').click();
    expect(remove.mock.calls.map((c) => c[0])).toContain('pointerup');
    remove.mockRestore();
  });

  it('closes itself after saving', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    save();
    expect(document.querySelector('.modal')).toBeNull();
  });
});

function fakeTeacher(opts: { active?: boolean; login?: () => Promise<TeacherLogin> } = {}) {
  let on = opts.active ?? false;
  const listeners = new Set<(a: boolean) => void>();
  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    for (const fn of [...listeners]) fn(on);
  };
  const teacher = {
    active: () => on,
    login: vi.fn(async (_code: string): Promise<TeacherLogin> => {
      const result = opts.login ? await opts.login() : 'ok';
      if (result === 'ok') set(true);
      return result;
    }),
    logout: vi.fn(() => set(false)),
    lock: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    resetCursor: vi.fn(async () => {}),
    onChange(fn: (a: boolean) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } satisfies TeacherApi;
  return { teacher, set, listenerCount: () => listeners.size };
}

const codeInput = () => modal()!.querySelector<HTMLInputElement>('input[name="teacher-code"]');
const teacherError = () => q('.teacher-error');
function typeCode(value: string): void {
  codeInput()!.value = value;
  codeInput()!.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('teacher section', () => {
  it('offers a passcode field with a hint when not signed in', () => {
    const { teacher } = fakeTeacher();
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => false });
    const input = codeInput()!;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.closest('label')!.textContent).toContain('Teacher passcode');
    expect(q('[data-section="teacher"]').textContent).toContain('Only for teachers. Leave it empty otherwise.');
    expect(modal()!.querySelector('[data-action="lock"]')).toBeNull();
  });

  it('sits below the cursor choices and above Save', () => {
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave });
    const section = q('[data-section="teacher"]');
    const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(q('[data-panel="shape"]'), section)).toBe(true);
    expect(follows(section, q('[data-action="save"]'))).toBe(true);
  });

  it('saves without signing in when the passcode is empty', () => {
    const { teacher } = fakeTeacher();
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    save();
    expect(teacher.login).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(savedCodes).toEqual([undefined]);
    expect(modal()).toBeNull();
  });

  it('signs in with a typed passcode, then saves and closes', async () => {
    const { teacher } = fakeTeacher();
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    typeCode('test-passcode');
    save();
    expect(teacher.login).toHaveBeenCalledWith('test-passcode');
    await settle();
    expect(saved).toEqual([defaultProfile('Ana')]);
    expect(savedCodes).toEqual([undefined]);
    expect(modal()).toBeNull();
  });

  it('signs in when Enter is pressed in the passcode field', async () => {
    const { teacher } = fakeTeacher();
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    typeCode('test-passcode');
    codeInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(teacher.login).toHaveBeenCalledWith('test-passcode');
    await settle();
    expect(saved).toHaveLength(1);
  });

  it('stays open with an error when the passcode is wrong', async () => {
    const { teacher } = fakeTeacher({ login: async () => 'bad' });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    typeCode('nope');
    save();
    await settle();
    expect(saved).toEqual([]);
    expect(modal()).not.toBeNull();
    expect(teacherError().hidden).toBe(false);
    expect(teacherError().textContent).toBe("That passcode isn't right.");
    expect(q('[data-action="save"]').hasAttribute('disabled')).toBe(false);
    typeCode('nope2');
    expect(teacherError().hidden).toBe(true);
  });

  it('says to wait after too many tries', async () => {
    const { teacher } = fakeTeacher({ login: async () => 'locked_out' });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    typeCode('nope');
    save();
    await settle();
    expect(teacherError().textContent).toBe('Too many tries. Wait 10 minutes and try again.');
    expect(saved).toEqual([]);
  });

  it('shows the server error when the sign-in request fails', async () => {
    const { teacher } = fakeTeacher({
      login: () => Promise.reject(Object.assign(new Error('x'), { code: 'not_ready' })),
    });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher });
    typeCode('test-passcode');
    save();
    await settle();
    await settle();
    expect(teacherError().textContent).toBe(errorText('not_ready'));
    expect(modal()).not.toBeNull();
  });

  it('checks the profile before trying the passcode', () => {
    const { teacher } = fakeTeacher();
    openProfilePanel({ initial: null, requireName: true, onSave, teacher });
    typeCode('test-passcode');
    save();
    expect(teacher.login).not.toHaveBeenCalled();
    expect(error().textContent).toBe('Enter a name. Others see it next to your cursor.');
  });

  it('hands the passcode to onSave when there is no teacher session yet', () => {
    openProfilePanel({ initial: null, requireName: true, onSave });
    typeName('Ana');
    typeCode('test-passcode');
    save();
    expect(saved).toHaveLength(1);
    expect(savedCodes).toEqual(['test-passcode']);
    expect(modal()).toBeNull();
  });

  it('shows lock and sign-out controls when signed in', () => {
    const { teacher } = fakeTeacher({ active: true });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => false });
    expect(codeInput()).toBeNull();
    expect(q('[data-section="teacher"]').textContent).toContain("You're signed in as a teacher.");
    expect(q('[data-action="lock"]').textContent).toBe('Lock the board');
    expect(q('[data-action="logout"]').textContent).toBe('Sign out');
  });

  it('offers unlock when the board is locked', () => {
    const { teacher } = fakeTeacher({ active: true });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => true });
    expect(modal()!.querySelector('[data-action="lock"]')).toBeNull();
    expect(q('[data-action="unlock"]').textContent).toBe('Unlock the board');
  });

  it('locks, then flips the button to unlock, and back', async () => {
    const { teacher } = fakeTeacher({ active: true });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => false });
    q('[data-action="lock"]').click();
    expect(teacher.lock).toHaveBeenCalledTimes(1);
    await settle();
    q('[data-action="unlock"]').click();
    expect(teacher.unlock).toHaveBeenCalledTimes(1);
    await settle();
    expect(modal()!.querySelector('[data-action="lock"]')).not.toBeNull();
    expect(modal()).not.toBeNull();
  });

  it('shows an error in the section when locking fails', async () => {
    const { teacher } = fakeTeacher({ active: true });
    teacher.lock.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'rate_limited' }));
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => false });
    q('[data-action="lock"]').click();
    await settle();
    expect(teacherError().hidden).toBe(false);
    expect(teacherError().textContent).toBe(errorText('rate_limited'));
    expect(q('[data-action="lock"]').hasAttribute('disabled')).toBe(false);
  });

  it('signs out and shows the passcode field again', () => {
    const { teacher } = fakeTeacher({ active: true });
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher, locked: () => false });
    q('[data-action="logout"]').click();
    expect(teacher.logout).toHaveBeenCalledTimes(1);
    expect(codeInput()).not.toBeNull();
    expect(modal()!.querySelector('[data-action="logout"]')).toBeNull();
    expect(modal()).not.toBeNull();
  });

  it('re-renders when the teacher session changes elsewhere, and stops listening once closed', () => {
    const t = fakeTeacher();
    openProfilePanel({ initial: defaultProfile('Ana'), requireName: true, onSave, teacher: t.teacher, locked: () => false });
    expect(codeInput()).not.toBeNull();
    t.set(true);
    expect(codeInput()).toBeNull();
    expect(q('[data-action="lock"]')).not.toBeNull();
    t.set(false);
    expect(codeInput()).not.toBeNull();
    q('[data-action="close"]').click();
    expect(t.listenerCount()).toBe(0);
  });
});
