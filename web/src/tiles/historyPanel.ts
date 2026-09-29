import { slotName } from '@class-board/shared/slots';
import type { ErrorCode, SlotIndex, VersionSummary } from '@class-board/shared/types';
import type { HistoryDeps } from '../contracts';
import { h } from '../ui/dom';
import { errorText } from '../ui/errors';
import { openModal } from '../ui/modal';
import { serverHref } from '../util/url';
import './history.css';

const LOAD_FAILED = "Couldn't load this tile's history. Close this and try again.";
const RESTORE_FAILED = "Couldn't restore that version. Try again.";

function reqId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function messageFor(e: unknown, fallback: string): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? errorText(code as ErrorCode) : fallback;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function summaryTitle(v: VersionSummary): string {
  if (v.title) return v.title;
  if (v.kind === 'html') return 'HTML page';
  if (v.kind === 'link' && v.url) {
    try {
      return new URL(v.url).host;
    } catch {
      return 'Link';
    }
  }
  return 'Cleared';
}

export function openHistory(deps: HistoryDeps, slot: SlotIndex): void {
  const { socket, state, serverUrl } = deps;
  const status = h('p', { class: 'history-status', textContent: 'Loading history…' });
  const list = h('ul', { class: 'history-list' });
  const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' }, hidden: true });
  const body = h('div', { class: 'history-body' }, status, error, list);
  let closed = false;
  let busy = false;

  const modal = openModal({
    title: `History of ${slotName(slot)}`,
    body,
    dialog: 'history',
    onClose: () => {
      closed = true;
    },
  });

  function showError(text: string | null): void {
    error.textContent = text ?? '';
    error.hidden = text === null;
  }

  async function restore(versionId: number, button: HTMLButtonElement): Promise<void> {
    if (busy) return;
    busy = true;
    const buttons = list.querySelectorAll<HTMLButtonElement>('[data-action="restore"]');
    for (const b of buttons) b.disabled = true;
    button.textContent = 'Restoring…';
    showError(null);
    try {
      await socket.request({
        type: 'restore',
        reqId: reqId(),
        slot,
        baseVersion: state.tile(slot).version,
        versionId,
      });
      modal.close();
    } catch (e) {
      showError(messageFor(e, RESTORE_FAILED));
      button.textContent = 'Restore';
      for (const b of buttons) b.disabled = false;
    } finally {
      busy = false;
    }
  }

  function row(v: VersionSummary, currentId: number, canRestore: boolean, now: number): HTMLElement {
    const thumb = v.shotUrl
      ? h('img', { class: 'history-thumb', src: serverHref(serverUrl, v.shotUrl), alt: '', loading: 'lazy' })
      : h('div', { class: 'history-thumb is-blank', textContent: v.kind === 'html' ? 'HTML' : v.kind === 'link' ? 'Link' : '' });
    const who = v.authorName ?? 'Someone';
    const info = h(
      'div',
      { class: 'history-info' },
      h('span', { class: 'history-title', textContent: summaryTitle(v) }),
      v.label ? h('span', { class: 'history-label', textContent: v.label }) : null,
      h('span', { class: 'history-meta', textContent: `${who} · ${relativeTime(v.createdAt, now)}` }),
    );
    const isCurrent = v.id === currentId;
    let action: HTMLElement | null = null;
    if (isCurrent) {
      action = h('span', { class: 'history-current', textContent: 'Current' });
    } else if (canRestore) {
      const button = h('button', {
        type: 'button',
        class: 'history-restore',
        dataset: { action: 'restore' },
        textContent: 'Restore',
      }) as HTMLButtonElement;
      button.addEventListener('click', () => void restore(v.id, button));
      action = button;
    }
    const li = h('li', { class: 'history-row', dataset: { version: String(v.id) } }, thumb, info, action);
    li.classList.toggle('is-current', isCurrent);
    return li;
  }

  function render(versions: VersionSummary[]): void {
    const sorted = [...versions].sort((a, b) => b.id - a.id);
    const currentId = state.tile(slot).version;
    const canRestore = deps.canRestore();
    const now = Date.now();
    status.hidden = sorted.length > 0;
    status.textContent = sorted.length > 0 ? '' : 'Nothing has been posted here yet.';
    list.replaceChildren(...sorted.map((v) => row(v, currentId, canRestore, now)));
  }

  socket
    .request({ type: 'history', reqId: reqId(), slot })
    .then((reply) => {
      if (closed) return;
      if (reply.type !== 'historyResult') {
        status.hidden = true;
        showError(LOAD_FAILED);
        return;
      }
      render(reply.versions);
    })
    .catch((e: unknown) => {
      if (closed) return;
      status.hidden = true;
      showError(messageFor(e, LOAD_FAILED));
    });
}
