import { h } from './dom';
import './modal.css';

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  /** Value of data-dialog, for example 'post'. */
  dialog: string;
  onClose?: () => void;
  /** false blocks Esc, backdrop clicks and every [data-action="close"] button. Default true. */
  closable?: boolean;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current: ModalHandle | null = null;
let titleCounter = 0;

function modalRoot(): HTMLElement {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = h('div', { id: 'modal-root' });
    document.body.append(root);
  }
  return root;
}

export function openModal(opts: ModalOptions): ModalHandle {
  current?.close();

  const closable = opts.closable !== false;
  const titleId = `modal-title-${++titleCounter}`;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;

  const closeButton = closable
    ? h('button', { class: 'modal-close', type: 'button', dataset: { action: 'close' }, attrs: { 'aria-label': 'Close' } }, '×')
    : null;
  const el = h(
    'div',
    { class: 'modal', dataset: { dialog: opts.dialog }, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
    h(
      'div',
      { class: 'modal-panel' },
      h('div', { class: 'modal-header' }, h('h2', { class: 'modal-title', id: titleId }, opts.title), closeButton),
      h('div', { class: 'modal-body' }, opts.body),
    ),
  );

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    el.remove();
    if (current === handle) current = null;
    if (opener && opener.isConnected) opener.focus();
    opts.onClose?.();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && closable) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  // Selecting text can start inside the panel and end on the backdrop, which fires a click on the backdrop.
  let pressedOnBackdrop = false;
  el.addEventListener('mousedown', (e) => {
    pressedOnBackdrop = e.target === el;
  });
  el.addEventListener('click', (e) => {
    if (!closable) return;
    const target = e.target as Element;
    if ((target === el && pressedOnBackdrop) || target.closest('[data-action="close"]')) close();
    pressedOnBackdrop = false;
  });

  document.addEventListener('keydown', onKeydown, true);
  modalRoot().append(el);
  const handle: ModalHandle = { el, close };
  current = handle;

  const first = opts.body.querySelector<HTMLElement>('input, textarea, select') ?? closeButton ?? el.querySelector<HTMLElement>(FOCUSABLE);
  first?.focus();
  return handle;
}
