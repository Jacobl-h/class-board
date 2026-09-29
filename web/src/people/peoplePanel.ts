import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, Person, Presence } from '@class-board/shared/types';
import type { PeoplePanelDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { errorText, toast } from '../ui/errors';
import './people.css';

export function presenceText(presence: Presence): string {
  if (presence.at === 'away') return 'Away';
  if (presence.at === 'tile') return `${presence.mode === 'using' ? 'Using' : 'Viewing'} ${slotName(presence.slot)}`;
  return 'On the board';
}

interface Row {
  el: HTMLElement;
  swatch: HTMLElement;
  name: HTMLElement;
  you: HTMLElement;
  presence: HTMLElement;
  jump: HTMLElement;
  reset: HTMLElement;
  person: Person;
}

function byName(a: Person, b: Person): number {
  return a.profile.name.localeCompare(b.profile.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

export function mountPeoplePanel(deps: PeoplePanelDeps): { destroy(): void } {
  const { button, state, teacher } = deps;
  const doc = button.ownerDocument;
  const rows = new Map<string, Row>();
  let panel: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let teacherButton: HTMLElement | null = null;
  let subscriptions: Unsubscribe[] = [];

  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  function makeRow(person: Person): Row {
    const swatch = h('span', { class: 'person-swatch', attrs: { 'aria-hidden': 'true' } });
    const name = h('span', { class: 'person-name' });
    const you = h('span', { class: 'person-you', hidden: true }, 'you');
    const presence = h('span', { class: 'person-presence' });
    const jump = h('button', {
      type: 'button',
      class: 'person-jump',
      dataset: { action: 'jump' },
      on: { click: () => { close(); deps.onJump(row.person); } },
    }, swatch, name, you, presence);
    const reset = h('button', {
      type: 'button',
      class: 'person-reset',
      dataset: { action: 'reset-cursor' },
      on: { click: () => resetCursor(row.person) },
    }, 'Reset cursor');
    const el = h('li', { class: 'person', dataset: { person: person.id } }, jump, reset);
    const row: Row = { el, swatch, name, you, presence, jump, reset, person };
    return row;
  }

  function resetCursor(person: Person): void {
    teacher.resetCursor(person.id).catch((err: unknown) => {
      const code = (err as { code?: ErrorCode }).code;
      toast(code ? errorText(code) : "Couldn't reset that cursor. Check your connection and try again.");
    });
  }

  function fill(row: Row, person: Person, isYou: boolean, isTeacher: boolean): void {
    row.person = person;
    row.el.dataset.person = person.id;
    row.swatch.style.background = person.profile.color;
    row.name.textContent = person.profile.name;
    row.you.hidden = !isYou;
    row.presence.textContent = presenceText(person.presence);
    row.jump.setAttribute('aria-label', `${person.profile.name}, ${presenceText(person.presence)}. Go to them.`);
    row.reset.hidden = !isTeacher;
    row.reset.setAttribute('aria-label', `Reset ${person.profile.name}'s cursor`);
  }

  function render(): void {
    if (!panel || !list || !heading || !teacherButton) return;
    const people = [...state.people()].sort(byName);
    const you = state.you();
    const isTeacher = teacher.active();

    heading.textContent = `${people.length} here`;
    teacherButton.textContent = isTeacher ? 'Teacher tools' : 'Teacher';

    const wanted = new Set(people.map((p) => p.id));
    for (const [id, row] of rows) {
      if (wanted.has(id)) continue;
      row.el.remove();
      rows.delete(id);
    }
    const ordered: HTMLElement[] = [];
    for (const person of people) {
      let row = rows.get(person.id);
      if (!row) {
        row = makeRow(person);
        rows.set(person.id, row);
      }
      fill(row, person, person.id === you, isTeacher);
      ordered.push(row.el);
    }
    const inPlace = ordered.length === list.children.length && ordered.every((el, i) => list!.children[i] === el);
    if (!inPlace) list.append(...ordered);
  }

  function place(): void {
    if (!panel) return;
    const rect = button.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.right = `${Math.max(8, Math.round((doc.defaultView?.innerWidth ?? rect.right) - rect.right))}px`;
  }

  function onOutsidePointer(e: Event): void {
    const target = e.target as Node | null;
    if (target && (panel?.contains(target) || button.contains(target))) return;
    close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    close();
    button.focus();
  }

  function open(): void {
    if (panel) return;
    heading = h('div', { class: 'people-head' });
    list = h('ul', { class: 'people-list' });
    teacherButton = h('button', {
      type: 'button',
      class: 'people-teacher',
      dataset: { action: 'teacher' },
      on: { click: () => { close(); deps.onTeacher(); } },
    });
    panel = h('div', { class: 'people-panel', attrs: { role: 'dialog', 'aria-label': 'People' } },
      heading, list, h('div', { class: 'people-foot' }, teacherButton));
    doc.body.append(panel);
    button.setAttribute('aria-expanded', 'true');
    render();
    place();
    subscriptions = [
      state.on('people', render),
      state.on('snapshot', render),
      teacher.onChange(render),
    ];
    doc.addEventListener('pointerdown', onOutsidePointer, true);
    doc.addEventListener('keydown', onKey);
    doc.defaultView?.addEventListener('resize', place);
  }

  function close(): void {
    if (!panel) return;
    for (const off of subscriptions) off();
    subscriptions = [];
    doc.removeEventListener('pointerdown', onOutsidePointer, true);
    doc.removeEventListener('keydown', onKey);
    doc.defaultView?.removeEventListener('resize', place);
    panel.remove();
    panel = list = heading = teacherButton = null;
    rows.clear();
    button.setAttribute('aria-expanded', 'false');
  }

  function toggle(): void {
    if (panel) close();
    else open();
  }

  button.addEventListener('click', toggle);

  return {
    destroy() {
      close();
      button.removeEventListener('click', toggle);
    },
  };
}
