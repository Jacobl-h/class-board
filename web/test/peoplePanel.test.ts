import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import type { Person, Presence } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents, TeacherApi } from '../src/contracts';
import { errorText } from '../src/ui/errors';
import { mountPeoplePanel } from '../src/people/peoplePanel';

function person(id: string, name: string, presence: Presence = { at: 'board' }, color: string = COLORS[3]): Person {
  return { id, clientId: `client-${id}`, profile: { name, color, cursor: { kind: 'shape', shape: 'arrow' } }, presence };
}

function fakeState(initial: Person[], you: string | null = 'me') {
  let people = initial;
  const listeners = new Map<keyof BoardStateEvents, Set<() => void>>();
  const state = {
    you: () => you,
    people: () => people,
    on(event: keyof BoardStateEvents, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => void listeners.get(event)!.delete(fn);
    },
  } as unknown as BoardStateApi;
  return {
    state,
    set(next: Person[], event: keyof BoardStateEvents = 'people') {
      people = next;
      for (const fn of [...(listeners.get(event) ?? [])]) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

function fakeTeacher(active = false) {
  let on = active;
  const listeners = new Set<(a: boolean) => void>();
  const teacher: TeacherApi = {
    active: () => on,
    login: vi.fn(),
    logout: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
    clear: vi.fn(),
    resetCursor: vi.fn(async () => {}),
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return {
    teacher,
    setActive(next: boolean) {
      on = next;
      for (const fn of [...listeners]) fn(on);
    },
    listenerCount: () => listeners.size,
  };
}

let button: HTMLButtonElement;
let onJump: Mock<(person: Person) => void>;
let onTeacher: Mock<() => void>;

beforeEach(() => {
  document.body.innerHTML = '<div id="banner"></div>';
  button = document.createElement('button');
  button.dataset.action = 'people';
  document.body.prepend(button);
  onJump = vi.fn<(person: Person) => void>();
  onTeacher = vi.fn<() => void>();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(people: Person[], opts: { teacherActive?: boolean; you?: string | null } = {}) {
  const s = fakeState(people, opts.you === undefined ? 'me' : opts.you);
  const t = fakeTeacher(opts.teacherActive);
  const panel = mountPeoplePanel({ button, state: s.state, teacher: t.teacher, onJump, onTeacher });
  return { s, t, panel };
}

const panelEl = () => document.querySelector<HTMLElement>('.people-panel');
const rowEl = (id: string) => document.querySelector<HTMLElement>(`.people-panel .person[data-person="${id}"]`);
const names = () => [...document.querySelectorAll('.people-panel .person-name')].map((el) => el.textContent);
const open = () => button.click();

describe('opening and closing', () => {
  it('is closed until the button is clicked, then toggles', () => {
    mount([person('me', 'Me')]);
    expect(panelEl()).toBeNull();
    open();
    expect(panelEl()).not.toBeNull();
    open();
    expect(panelEl()).toBeNull();
  });

  it('marks the button expanded while open', () => {
    mount([person('me', 'Me')]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a pointer press outside, but not inside the panel or on the button', () => {
    mount([person('me', 'Me')]);
    open();
    panelEl()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).not.toBeNull();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(panelEl()).toBeNull();
  });

  it('closes on Escape and gives the focus back to the button', () => {
    mount([person('me', 'Me')]);
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panelEl()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('ignores other keys', () => {
    mount([person('me', 'Me')]);
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(panelEl()).not.toBeNull();
  });

  it('is anchored under the button', () => {
    mount([person('me', 'Me')]);
    button.getBoundingClientRect = () => ({ bottom: 50, right: 900, top: 10, left: 800, width: 100, height: 40, x: 800, y: 10, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    open();
    expect(panelEl()!.style.top).toBe('56px');
    expect(panelEl()!.style.right).toBe('100px');
  });
});

describe('the list', () => {
  it('shows how many people are here', () => {
    mount([person('me', 'Me'), person('a', 'Ana')]);
    open();
    expect(panelEl()!.querySelector('.people-head')!.textContent).toBe('2 here');
  });

  it('sorts people by name, ignoring case', () => {
    mount([person('1', 'zoe'), person('2', 'Ben'), person('3', 'ana'), person('me', 'Cy')]);
    open();
    expect(names()).toEqual(['ana', 'Ben', 'Cy', 'zoe']);
  });

  it('gives each person a row with their color, name and presence', () => {
    mount([person('a', 'Ana', { at: 'board' }, '#EF9F27')]);
    open();
    const row = rowEl('a')!;
    expect(row.querySelector('.person-name')!.textContent).toBe('Ana');
    expect(row.querySelector('.person-presence')!.textContent).toBe('On the board');
    const probe = document.createElement('i');
    probe.style.background = '#EF9F27';
    expect(row.querySelector<HTMLElement>('.person-swatch')!.style.background).toBe(probe.style.background);
  });

  it.each<[Presence, string]>([
    [{ at: 'board' }, 'On the board'],
    [{ at: 'tile', slot: 23, mode: 'using' }, 'Using C4'],
    [{ at: 'tile', slot: 79, mode: 'viewing' }, 'Viewing H10'],
    [{ at: 'away' }, 'Away'],
  ])('describes %j as "%s"', (presence, text) => {
    mount([person('a', 'Ana', presence)]);
    open();
    expect(rowEl('a')!.querySelector('.person-presence')!.textContent).toBe(text);
  });

  it('marks your own row', () => {
    mount([person('me', 'Me'), person('a', 'Ana')]);
    open();
    expect(rowEl('me')!.querySelector<HTMLElement>('.person-you')!.hidden).toBe(false);
    expect(rowEl('a')!.querySelector<HTMLElement>('.person-you')!.hidden).toBe(true);
  });

  it('puts names in as text, never as markup', () => {
    mount([person('a', '<img src=x onerror=alert(1)>')]);
    open();
    expect(panelEl()!.querySelector('img')).toBeNull();
    expect(names()).toEqual(['<img src=x onerror=alert(1)>']);
  });
});

describe('staying up to date while open', () => {
  it('adds, removes and updates rows when the people change', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    s.set([person('a', 'Ana', { at: 'away' }), person('b', 'Ben')]);
    expect(names()).toEqual(['Ana', 'Ben']);
    expect(rowEl('a')!.querySelector('.person-presence')!.textContent).toBe('Away');
    s.set([person('b', 'Ben')]);
    expect(rowEl('a')).toBeNull();
    expect(panelEl()!.querySelector('.people-head')!.textContent).toBe('1 here');
  });

  it('also refreshes on a new snapshot', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    s.set([person('a', 'Ana'), person('b', 'Ben')], 'snapshot');
    expect(names()).toEqual(['Ana', 'Ben']);
  });

  it('keeps the same row element when only its details change, so a click in progress is not lost', () => {
    const { s } = mount([person('a', 'Ana'), person('b', 'Ben')]);
    open();
    const before = rowEl('a');
    s.set([person('a', 'Ana', { at: 'tile', slot: 1, mode: 'using' }), person('b', 'Ben')]);
    expect(rowEl('a')).toBe(before);
  });

  it('reorders rows when a name changes', () => {
    const { s } = mount([person('a', 'Ana'), person('b', 'Ben')]);
    open();
    s.set([person('a', 'Zed'), person('b', 'Ben')]);
    expect(names()).toEqual(['Ben', 'Zed']);
  });

  it('stops listening once closed', () => {
    const { s, t } = mount([person('a', 'Ana')]);
    open();
    open();
    expect(s.listenerCount()).toBe(0);
    expect(t.listenerCount()).toBe(0);
  });
});

describe('jumping', () => {
  it('calls onJump with the person and closes the panel', () => {
    const ana = person('a', 'Ana', { at: 'tile', slot: 23, mode: 'using' });
    mount([ana, person('me', 'Me')]);
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="jump"]')!.click();
    expect(onJump).toHaveBeenCalledWith(ana);
    expect(panelEl()).toBeNull();
  });

  it('passes the latest details of the person after an update', () => {
    const { s } = mount([person('a', 'Ana')]);
    open();
    const moved = person('a', 'Ana', { at: 'tile', slot: 5, mode: 'viewing' });
    s.set([moved]);
    rowEl('a')!.querySelector<HTMLElement>('[data-action="jump"]')!.click();
    expect(onJump).toHaveBeenCalledWith(moved);
  });
});

describe('teacher features', () => {
  it('hides Reset cursor from students', () => {
    mount([person('a', 'Ana')]);
    open();
    expect(rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden).toBe(true);
  });

  it('shows Reset cursor on every row for the teacher', () => {
    mount([person('a', 'Ana'), person('me', 'Me')], { teacherActive: true });
    open();
    for (const id of ['a', 'me']) {
      expect(rowEl(id)!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden).toBe(false);
    }
  });

  it('asks the teacher session to reset that person', () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    expect(t.teacher.resetCursor).toHaveBeenCalledWith('a');
    expect(panelEl()).not.toBeNull();
  });

  it('shows a toast when the reset is rejected', async () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    vi.mocked(t.teacher.resetCursor).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'not_found' }));
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('#banner [data-banner="toast"]')!.textContent).toBe(errorText('not_found'));
  });

  it('shows a general toast when the reset fails without a server code', async () => {
    const { t } = mount([person('a', 'Ana')], { teacherActive: true });
    vi.mocked(t.teacher.resetCursor).mockRejectedValueOnce(new Error('offline'));
    open();
    rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('#banner [data-banner="toast"]')!.textContent).toContain("Couldn't reset that cursor");
  });

  it('shows or hides Reset cursor as the teacher signs in or out while the panel is open', () => {
    const { t } = mount([person('a', 'Ana')]);
    open();
    const reset = () => rowEl('a')!.querySelector<HTMLElement>('[data-action="reset-cursor"]')!.hidden;
    expect(reset()).toBe(true);
    t.setActive(true);
    expect(reset()).toBe(false);
    t.setActive(false);
    expect(reset()).toBe(true);
  });

  it('has a footer link that says Teacher sign-in, then Teacher tools once signed in', () => {
    const { t } = mount([person('a', 'Ana')]);
    open();
    const footer = () => panelEl()!.querySelector('[data-action="teacher"]')!.textContent;
    expect(footer()).toBe('Teacher sign-in');
    t.setActive(true);
    expect(footer()).toBe('Teacher tools');
    t.setActive(false);
    expect(footer()).toBe('Teacher sign-in');
  });

  it('tags every person the server marks as a teacher, for everyone to see', () => {
    mount([{ ...person('a', 'Ana'), teacher: true }, person('b', 'Ben'), { ...person('c', 'Cy'), teacher: true }]);
    open();
    const tag = (id: string) => rowEl(id)!.querySelector<HTMLElement>('.person-teacher-tag')!;
    expect(tag('a').hidden).toBe(false);
    expect(tag('a').textContent).toBe('Teacher');
    expect(tag('b').hidden).toBe(true);
    expect(tag('c').hidden).toBe(false);
    expect(rowEl('a')!.querySelector('[data-action="jump"]')!.getAttribute('aria-label')).toBe('Ana, teacher, On the board. Go to them.');
    expect(rowEl('b')!.querySelector('[data-action="jump"]')!.getAttribute('aria-label')).toBe('Ben, On the board. Go to them.');
  });

  it('shows or hides the Teacher tag as people sign in or out', () => {
    const s = mount([person('a', 'Ana')]).s;
    open();
    const tag = () => rowEl('a')!.querySelector<HTMLElement>('.person-teacher-tag')!;
    expect(tag().hidden).toBe(true);
    s.set([{ ...person('a', 'Ana'), teacher: true }]);
    expect(tag().hidden).toBe(false);
    s.set([{ ...person('a', 'Ana'), teacher: false }]);
    expect(tag().hidden).toBe(true);
  });

  it('calls onTeacher and closes when the footer link is clicked', () => {
    mount([person('a', 'Ana')]);
    open();
    panelEl()!.querySelector<HTMLElement>('[data-action="teacher"]')!.click();
    expect(onTeacher).toHaveBeenCalledTimes(1);
    expect(panelEl()).toBeNull();
  });
});

describe('destroy', () => {
  it('removes the panel and stops responding to the button', () => {
    const { panel } = mount([person('a', 'Ana')]);
    open();
    panel.destroy();
    expect(panelEl()).toBeNull();
    open();
    expect(panelEl()).toBeNull();
  });
});
