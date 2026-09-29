import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorText } from '../src/ui/errors';
import type { BoardStateApi, BoardStateEvents, TeacherApi, TeacherLogin } from '../src/contracts';
import { openTeacherPanel } from '../src/teacher/teacherPanel';

function fakeState(locked = false) {
  let isLocked = locked;
  const listeners = new Set<(locked: boolean) => void>();
  const state = {
    locked: () => isLocked,
    on(event: keyof BoardStateEvents, fn: (locked: boolean) => void) {
      if (event !== 'locked') return () => {};
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  } as unknown as BoardStateApi;
  return {
    state,
    setLocked(next: boolean) {
      isLocked = next;
      for (const fn of [...listeners]) fn(isLocked);
    },
    listenerCount: () => listeners.size,
  };
}

function serverError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeTeacher(opts: { active?: boolean; login?: (code: string) => Promise<TeacherLogin> } = {}) {
  let on = opts.active ?? false;
  const listeners = new Set<(a: boolean) => void>();
  const setActive = (next: boolean) => {
    if (on === next) return;
    on = next;
    for (const fn of [...listeners]) fn(on);
  };
  const teacher: TeacherApi = {
    active: () => on,
    login: vi.fn(async (code: string) => {
      const result = await (opts.login ?? (async () => 'ok' as const))(code);
      if (result === 'ok') setActive(true);
      return result;
    }),
    logout: vi.fn(() => setActive(false)),
    lock: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    resetCursor: vi.fn(async () => {}),
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return { teacher, setActive, listenerCount: () => listeners.size };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});

afterEach(() => {
  document.querySelector<HTMLElement>('.modal [data-action="close"]')?.click();
  document.body.innerHTML = '';
});

const modal = () => document.querySelector<HTMLElement>('.modal[data-dialog="teacher"]');
const q = <T extends HTMLElement = HTMLElement>(selector: string) => modal()!.querySelector<T>(selector)!;
const has = (selector: string) => modal()!.querySelector(selector) !== null;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function enter(code: string): void {
  const input = q<HTMLInputElement>('input[name="code"]');
  input.value = code;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('signed out', () => {
  it('opens the teacher dialog with a passcode field and a sign-in button', () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    expect(modal()).not.toBeNull();
    expect(q<HTMLInputElement>('input[name="code"]').type).toBe('password');
    expect(has('[data-action="login"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
    expect(q('.dialog-error').hidden).toBe(true);
  });

  it('can be closed with the close button', () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    q('[data-action="close"]').click();
    expect(modal()).toBeNull();
  });

  it('sends the typed passcode', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    enter('letmein');
    q('[data-action="login"]').click();
    await flush();
    expect(t.teacher.login).toHaveBeenCalledWith('letmein');
  });

  it('signs in on Enter', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    enter('letmein');
    q('input[name="code"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(t.teacher.login).toHaveBeenCalledTimes(1);
  });

  it('asks for a passcode when the field is empty, without contacting the server', async () => {
    const t = fakeTeacher();
    openTeacherPanel(t.teacher, fakeState().state);
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe('Enter the passcode.');
    expect(t.teacher.login).not.toHaveBeenCalled();
  });

  it('says the passcode is wrong on bad', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'bad' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe("That passcode isn't right.");
    expect(has('input[name="code"]')).toBe(true);
  });

  it('says to wait when locked out', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'locked_out' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe('Too many tries. Wait 10 minutes and try again.');
  });

  it('hides the error again when the person types', async () => {
    openTeacherPanel(fakeTeacher({ login: async () => 'bad' }).teacher, fakeState().state);
    enter('nope');
    q('[data-action="login"]').click();
    await flush();
    enter('nop');
    expect(q('.dialog-error').hidden).toBe(true);
  });

  it('shows the server message when sign-in is rejected for another reason', async () => {
    const login = async (): Promise<TeacherLogin> => {
      throw serverError('rate_limited');
    };
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe(errorText('rate_limited'));
  });

  it('says it could not reach the board when sign-in fails without a server code', async () => {
    const login = async (): Promise<TeacherLogin> => {
      throw new Error('offline');
    };
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    await flush();
    expect(q('.dialog-error').textContent).toBe("Couldn't reach the board. Check your connection and try again.");
  });

  it('disables the button while the passcode is being checked', async () => {
    let finish!: (r: TeacherLogin) => void;
    const login = () => new Promise<TeacherLogin>((resolve) => (finish = resolve));
    openTeacherPanel(fakeTeacher({ login }).teacher, fakeState().state);
    enter('x');
    const button = q<HTMLButtonElement>('[data-action="login"]');
    button.click();
    expect(button.disabled).toBe(true);
    finish('bad');
    await flush();
    expect(button.disabled).toBe(false);
  });
});

describe('signed in', () => {
  it('shows Lock and Sign out on an open board', () => {
    openTeacherPanel(fakeTeacher({ active: true }).teacher, fakeState(false).state);
    expect(has('[data-action="lock"]')).toBe(true);
    expect(has('[data-action="unlock"]')).toBe(false);
    expect(has('[data-action="logout"]')).toBe(true);
    expect(has('input[name="code"]')).toBe(false);
  });

  it('shows Unlock on a locked board', () => {
    openTeacherPanel(fakeTeacher({ active: true }).teacher, fakeState(true).state);
    expect(has('[data-action="unlock"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
  });

  it('switches to the signed-in view after a successful sign-in, without closing', async () => {
    openTeacherPanel(fakeTeacher().teacher, fakeState().state);
    enter('letmein');
    q('[data-action="login"]').click();
    await flush();
    expect(modal()).not.toBeNull();
    expect(has('[data-action="lock"]')).toBe(true);
    expect(has('input[name="code"]')).toBe(false);
  });

  it('locks the board', async () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState(false).state);
    q('[data-action="lock"]').click();
    await flush();
    expect(t.teacher.lock).toHaveBeenCalledTimes(1);
    expect(t.teacher.unlock).not.toHaveBeenCalled();
  });

  it('unlocks the board', async () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState(true).state);
    q('[data-action="unlock"]').click();
    await flush();
    expect(t.teacher.unlock).toHaveBeenCalledTimes(1);
  });

  it('swaps Lock for Unlock when the server says the board is now locked', async () => {
    const s = fakeState(false);
    openTeacherPanel(fakeTeacher({ active: true }).teacher, s.state);
    s.setLocked(true);
    expect(has('[data-action="unlock"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
    s.setLocked(false);
    expect(has('[data-action="lock"]')).toBe(true);
  });

  it('shows the reason when locking is rejected', async () => {
    const t = fakeTeacher({ active: true });
    vi.mocked(t.teacher.lock).mockRejectedValueOnce(serverError('rate_limited'));
    openTeacherPanel(t.teacher, fakeState(false).state);
    const button = q<HTMLButtonElement>('[data-action="lock"]');
    button.click();
    await flush();
    expect(q('.dialog-error').hidden).toBe(false);
    expect(q('.dialog-error').textContent).toBe(errorText('rate_limited'));
    expect(button.disabled).toBe(false);
  });

  it('signs out and closes', () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState().state);
    q('[data-action="logout"]').click();
    expect(t.teacher.logout).toHaveBeenCalledTimes(1);
    expect(t.teacher.active()).toBe(false);
    expect(modal()).toBeNull();
  });

  it('goes back to the passcode form if the session ends while it is open', () => {
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, fakeState().state);
    t.setActive(false);
    expect(has('input[name="code"]')).toBe(true);
    expect(has('[data-action="lock"]')).toBe(false);
  });
});

describe('cleanup', () => {
  it('stops listening to the board and the teacher session when closed', () => {
    const s = fakeState();
    const t = fakeTeacher({ active: true });
    openTeacherPanel(t.teacher, s.state);
    expect(s.listenerCount()).toBe(1);
    expect(t.listenerCount()).toBe(1);
    q('[data-action="close"]').click();
    expect(s.listenerCount()).toBe(0);
    expect(t.listenerCount()).toBe(0);
  });

  it('does not redraw a closed dialog when a late sign-in answer arrives', async () => {
    let finish!: (r: TeacherLogin) => void;
    const t = fakeTeacher({ login: () => new Promise<TeacherLogin>((resolve) => (finish = resolve)) });
    openTeacherPanel(t.teacher, fakeState().state);
    enter('x');
    q('[data-action="login"]').click();
    q('[data-action="close"]').click();
    finish('bad');
    await flush();
    expect(modal()).toBeNull();
  });
});
