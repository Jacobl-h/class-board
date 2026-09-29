import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopBarHandlers } from '../src/contracts';
import { DEFAULT_SERVER_URL, resolveBoard, resolveServerUrl } from '../src/config';
import { openHelp } from '../src/ui/help';
import { mountTopBar } from '../src/ui/topBar';

describe('resolveBoard', () => {
  it('returns the default board without a query string', () => {
    expect(resolveBoard('')).toBe('main');
    expect(resolveBoard('?other=1')).toBe('main');
  });

  it('accepts a valid board name', () => {
    expect(resolveBoard('?board=week-3')).toBe('week-3');
    expect(resolveBoard('?x=1&board=a')).toBe('a');
    expect(resolveBoard('?board=' + 'a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('falls back to the default for names the server would reject', () => {
    expect(resolveBoard('?board=')).toBe('main');
    expect(resolveBoard('?board=Week3')).toBe('main');
    expect(resolveBoard('?board=week_3')).toBe('main');
    expect(resolveBoard('?board=' + 'a'.repeat(41))).toBe('main');
    expect(resolveBoard('?board=../etc')).toBe('main');
    expect(resolveBoard('?board=a%20b')).toBe('main');
  });
});

describe('resolveServerUrl', () => {
  it('uses the local dev server when the variable is unset or blank', () => {
    expect(DEFAULT_SERVER_URL).toBe('http://localhost:8787');
    expect(resolveServerUrl(undefined)).toBe('http://localhost:8787');
    expect(resolveServerUrl('')).toBe('http://localhost:8787');
    expect(resolveServerUrl('   ')).toBe('http://localhost:8787');
  });

  it('keeps a configured URL and drops trailing slashes', () => {
    expect(resolveServerUrl('https://board.example.workers.dev')).toBe('https://board.example.workers.dev');
    expect(resolveServerUrl(' https://board.example.workers.dev/ ')).toBe('https://board.example.workers.dev');
  });
});

describe('module constants', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  it('reads VITE_SERVER_URL, ?board= and the page origin when the module loads', async () => {
    vi.stubEnv('VITE_SERVER_URL', 'https://board.example.workers.dev/');
    window.history.replaceState(null, '', '/class-board/?board=week-3');
    vi.resetModules();
    const config = await import('../src/config');
    expect(config.SERVER_URL).toBe('https://board.example.workers.dev');
    expect(config.BOARD).toBe('week-3');
    expect(config.BOARD_ORIGIN).toBe(window.location.origin);
    expect(typeof config.IS_DEV).toBe('boolean');
  });

  it('uses the defaults when nothing is configured', async () => {
    vi.stubEnv('VITE_SERVER_URL', '');
    vi.resetModules();
    const config = await import('../src/config');
    expect(config.SERVER_URL).toBe('http://localhost:8787');
    expect(config.BOARD).toBe('main');
  });
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function handlers(): TopBarHandlers {
  return { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn(), profile: vi.fn(), help: vi.fn() };
}

function mount(h: TopBarHandlers = handlers()) {
  document.body.innerHTML = '<header id="topbar"></header>';
  const el = q('#topbar');
  return { el, h, bar: mountTopBar(el, h) };
}

describe('mountTopBar', () => {
  it('renders every control the e2e tests look for', () => {
    mount();
    for (const action of ['zoom-out', 'zoom-in', 'fit', 'people', 'profile', 'help']) {
      expect(document.querySelectorAll(`#topbar button[data-action="${action}"]`), action).toHaveLength(1);
    }
    for (const role of ['zoom', 'people-count', 'board-name', 'teacher-badge']) {
      expect(document.querySelectorAll(`#topbar [data-role="${role}"]`), role).toHaveLength(1);
    }
  });

  it('calls the matching handler for each button', () => {
    const { h } = mount();
    q('[data-action="zoom-in"]').click();
    q('[data-action="zoom-out"]').click();
    q('[data-action="zoom-out"]').click();
    q('[data-action="fit"]').click();
    q('[data-action="profile"]').click();
    q('[data-action="help"]').click();
    expect(h.zoomIn).toHaveBeenCalledTimes(1);
    expect(h.zoomOut).toHaveBeenCalledTimes(2);
    expect(h.fit).toHaveBeenCalledTimes(1);
    expect(h.profile).toHaveBeenCalledTimes(1);
    expect(h.help).toHaveBeenCalledTimes(1);
  });

  it('gives icon-only buttons an accessible name and makes every button a plain button', () => {
    mount();
    expect(q('[data-action="zoom-in"]').getAttribute('aria-label')).toBe('Zoom in');
    expect(q('[data-action="zoom-out"]').getAttribute('aria-label')).toBe('Zoom out');
    expect(q('[data-action="help"]').getAttribute('aria-label')).toBe('Help');
    for (const b of document.querySelectorAll<HTMLButtonElement>('#topbar button')) expect(b.type).toBe('button');
  });

  it('shows the zoom as a rounded percentage', () => {
    const { bar } = mount();
    bar.setZoom(1);
    expect(q('[data-role="zoom"]').textContent).toBe('100%');
    bar.setZoom(0.2263);
    expect(q('[data-role="zoom"]').textContent).toBe('23%');
    bar.setZoom(2.666);
    expect(q('[data-role="zoom"]').textContent).toBe('267%');
  });

  it('shows the board name', () => {
    const { bar } = mount();
    bar.setBoardName('week-3');
    expect(q('[data-role="board-name"]').textContent).toBe('week-3');
  });

  it('puts the people count in a child of the people button, followed by "here"', () => {
    const { bar } = mount();
    expect(bar.peopleButton).toBe(q('[data-action="people"]'));
    expect(bar.peopleButton.querySelector('[data-role="people-count"]')).not.toBeNull();
    bar.setPeopleCount(12);
    expect(q('[data-role="people-count"]').textContent).toBe('12');
    expect(bar.peopleButton.textContent).toBe('12 here');
  });

  it('hides the teacher badge unless teacher mode is on', () => {
    const { bar } = mount();
    const badge = q('[data-role="teacher-badge"]');
    expect(badge.hidden).toBe(true);
    bar.setTeacher(true);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('Teacher');
    bar.setTeacher(false);
    expect(badge.hidden).toBe(true);
  });

  it('shows the cursor preview image only while it has a URL', () => {
    const { bar } = mount();
    const img = q<HTMLImageElement>('#topbar [data-action="profile"] img');
    expect(img.hidden).toBe(true);
    bar.setCursorPreview('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');
    expect(img.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');
    bar.setCursorPreview(null);
    expect(img.hidden).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
  });

  it('replaces anything already inside the element when mounted again', () => {
    const { el } = mount();
    mountTopBar(el, handlers());
    expect(el.querySelectorAll('[data-action="fit"]')).toHaveLength(1);
  });
});

describe('openHelp', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a labelled help dialog with the board host in the Allowed domains instructions', () => {
    openHelp('jacobl-h.github.io');
    const dialog = q('.modal[data-dialog="help"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('How the board works');
    const host = dialog.querySelector('code');
    expect(host?.textContent).toBe('jacobl-h.github.io');
    expect(host?.parentElement?.textContent).toContain('Allowed domains');
  });

  it('has a section for posting, uploading HTML, Claude artifacts, focus mode and shortcuts', () => {
    openHelp('example.github.io');
    const headings = [...document.querySelectorAll('.modal[data-dialog="help"] h3')].map((e) => e.textContent);
    expect(headings).toEqual(['Post to a tile', 'Upload an HTML file', 'Show a Claude artifact', 'Focus mode', 'Move around']);
    const keys = [...document.querySelectorAll('.help-keys kbd')].map((e) => e.textContent);
    expect(keys).toEqual(['+ and -', '0', 'Arrow keys', 'Enter', 'Esc']);
  });

  it('closes with Esc and the close button, and replaces itself when opened twice', () => {
    openHelp('a.example');
    openHelp('b.example');
    expect(document.querySelectorAll('.modal[data-dialog="help"]')).toHaveLength(1);
    expect(q('.modal code').textContent).toBe('b.example');
    q('.modal [data-action="close"]').click();
    expect(document.querySelector('.modal')).toBeNull();
  });
});
