import type { ErrorCode } from '@class-board/shared/types';
import type { BoardStateApi, TeacherApi, Unsubscribe } from '../contracts';
import '../people/people.css';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';

const MESSAGES = {
  bad: "That passcode isn't right.",
  locked_out: 'Too many tries. Wait 10 minutes and try again.',
  empty: 'Enter the passcode.',
  network: "Couldn't reach the board. Check your connection and try again.",
} as const;

function failureText(err: unknown): string {
  const code = (err as { code?: ErrorCode }).code;
  return code ? errorText(code) : MESSAGES.network;
}

export function openTeacherPanel(teacher: TeacherApi, state: BoardStateApi): void {
  const body = h('div', { class: 'teacher-panel' });
  let subscriptions: Unsubscribe[] = [];
  let closed = false;

  const handle = openModal({
    title: 'Teacher',
    dialog: 'teacher',
    body,
    onClose: () => {
      closed = true;
      for (const off of subscriptions) off();
      subscriptions = [];
    },
  });

  function errorEl(): HTMLElement {
    return h('p', { class: 'dialog-error', hidden: true, attrs: { role: 'alert' } });
  }

  function show(error: HTMLElement, text: string): void {
    error.textContent = text;
    error.hidden = false;
  }

  function renderLogin(): void {
    const error = errorEl();
    const input = h('input', {
      type: 'password',
      name: 'code',
      autocomplete: 'off',
      attrs: { 'aria-label': 'Teacher passcode' },
      on: {
        input: () => { error.hidden = true; },
        keydown: (e) => { if ((e as KeyboardEvent).key === 'Enter') void submit(); },
      },
    }) as HTMLInputElement;
    const login = h('button', { type: 'button', class: 'teacher-primary', dataset: { action: 'login' }, on: { click: () => void submit() } }, 'Sign in') as HTMLButtonElement;

    async function submit(): Promise<void> {
      const code = input.value;
      if (!code) {
        show(error, MESSAGES.empty);
        return;
      }
      login.disabled = true;
      try {
        const result = await teacher.login(code);
        if (closed) return;
        if (result === 'ok') {
          render();
          return;
        }
        show(error, MESSAGES[result]);
        input.select();
      } catch (err) {
        if (!closed) show(error, failureText(err));
      } finally {
        login.disabled = false;
      }
    }

    body.replaceChildren(
      h('p', { class: 'teacher-help' }, 'Enter the teacher passcode to lock the board, clear tiles and reset cursors.'),
      h('label', { class: 'profile-field' }, h('span', { class: 'profile-label' }, 'Passcode'), input),
      error,
      h('div', { class: 'teacher-actions' }, login),
    );
    input.focus();
  }

  function renderActive(): void {
    const error = errorEl();
    const locked = state.locked();
    const toggle = h('button', {
      type: 'button',
      class: 'teacher-primary',
      dataset: { action: locked ? 'unlock' : 'lock' },
      on: {
        click: async () => {
          toggle.disabled = true;
          try {
            await (locked ? teacher.unlock() : teacher.lock());
          } catch (err) {
            if (!closed) show(error, failureText(err));
          } finally {
            toggle.disabled = false;
          }
        },
      },
    }, locked ? 'Unlock board' : 'Lock board') as HTMLButtonElement;
    const logout = h('button', {
      type: 'button',
      dataset: { action: 'logout' },
      on: { click: () => { teacher.logout(); handle.close(); } },
    }, 'Sign out');

    body.replaceChildren(
      h('p', { class: 'teacher-help' }, locked
        ? 'The board is locked. Students can look but not post, replace or rename.'
        : 'The board is open. Students can post, replace and rename tiles.'),
      error,
      h('div', { class: 'teacher-actions' }, toggle, logout),
    );
  }

  function render(): void {
    if (teacher.active()) renderActive();
    else renderLogin();
  }

  subscriptions = [state.on('locked', () => { if (teacher.active()) renderActive(); }), teacher.onChange(render)];
  render();
}
