import { LIMITS, SLOT_COUNT } from '@class-board/shared/constants';
import { cleanText } from '@class-board/shared/protocol';
import { labelRect, slotName, tileRect } from '@class-board/shared/slots';
import type { SlotIndex, TileView } from '@class-board/shared/types';
import type { BoardStateApi, GridActions, GridApi, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { serverHref } from '../util/url';
import './grid.css';

/** Classes Grid owns on `.tile`. Other modules add is-live, is-active and is-focus; those are never touched here. */
const STATE_CLASSES = ['is-empty', 'is-link', 'is-html', 'is-checking', 'is-blocked'] as const;

interface TileParts {
  tile: HTMLElement;
  name: HTMLButtonElement;
  badge: HTMLElement;
  body: HTMLElement;
  card: HTMLElement;
  frame: HTMLElement;
  open: HTMLButtonElement;
  replace: HTMLButtonElement;
  history: HTMLButtonElement;
  clear: HTMLButtonElement;
}

function domainOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function actionButton(action: string, text: string, label: string): HTMLButtonElement {
  return h('button', { type: 'button', class: 'tile-action', dataset: { action }, attrs: { 'aria-label': label } }, text);
}

export function createGrid(root: HTMLElement, state: BoardStateApi, actions: GridActions, serverUrl: string): GridApi {
  const parts: TileParts[] = [];
  let locked = state.locked();
  let teacher = false;
  /** The slot whose name is being edited, so a re-render doesn't throw the edit away. */
  let editing: SlotIndex | null = null;

  const canEdit = (): boolean => !locked || teacher;

  function build(slot: SlotIndex): TileParts {
    const id = slotName(slot);
    const label = labelRect(slot);
    const body = tileRect(slot);
    const name = h('button', { type: 'button', class: 'tile-name', dataset: { action: 'rename' } });
    const badge = h('span', { class: 'tile-badge', hidden: true }, 'HTML');
    const card = h('div', { class: 'tile-card' });
    const frame = h('div', { class: 'tile-frame' });
    const open = actionButton('open', 'Open', `Open ${id} in a new tab`);
    const replace = actionButton('replace', 'Replace', `Replace ${id}`);
    const history = actionButton('history', 'History', `History of ${id}`);
    const clear = actionButton('clear', 'Clear', `Clear ${id}`);
    const back = h('button', { type: 'button', class: 'focus-back', dataset: { action: 'back' }, hidden: true }, '← Back');
    const bodyEl = h(
      'div',
      { class: 'tile-body' },
      card,
      frame,
      h('div', { class: 'tile-actions' }, open, replace, history, clear),
      back,
    );
    const tile = h(
      'div',
      { class: 'tile', dataset: { slot: String(slot) }, attrs: { tabindex: '0' } },
      h('div', { class: 'tile-label' }, name, h('span', { class: 'tile-slot' }, id), badge),
      bodyEl,
    );
    tile.style.left = `${label.x}px`;
    tile.style.top = `${label.y}px`;
    tile.style.width = `${label.w}px`;
    tile.style.height = `${body.y + body.h - label.y}px`;
    return { tile, name, badge, body: bodyEl, card, frame, open, replace, history, clear };
  }

  function cardContent(view: TileView): Node[] {
    const id = slotName(view.slot);
    if (view.kind === 'empty') {
      return [h('button', { type: 'button', class: 'tile-add', dataset: { action: 'add' }, hidden: !canEdit() }, `Add to ${id}`)];
    }
    if (view.kind === 'link' && view.embeddable === 'pending') {
      return [
        h('div', { class: 'tile-checking', attrs: { role: 'status' } },
          h('span', { class: 'tile-spinner', attrs: { 'aria-hidden': 'true' } }),
          h('span', null, 'Checking link…')),
      ];
    }
    const nodes: Node[] = [];
    const info = (): HTMLElement => {
      const domain = view.kind === 'html' ? 'HTML page' : domainOf(view.url);
      const icon = view.icon
        ? h('img', { class: 'tile-icon', src: serverHref(serverUrl, view.icon), alt: '', draggable: false, referrerPolicy: 'no-referrer' })
        : null;
      icon?.addEventListener('error', () => icon.remove());
      return h('div', { class: 'tile-info' },
        icon,
        h('div', { class: 'tile-title' }, view.title || view.label || domain),
        h('div', { class: 'tile-domain' }, domain));
    };
    if (view.shotUrl) {
      const shot = h('img', { class: 'tile-shot', src: serverHref(serverUrl, view.shotUrl), alt: '', draggable: false, loading: 'lazy' });
      // A missing screenshot falls back to the title card.
      shot.addEventListener('error', () => shot.replaceWith(info()));
      nodes.push(shot);
    } else {
      nodes.push(info());
    }
    if (view.note) nodes.push(h('p', { class: 'tile-note' }, view.note));
    if (view.kind === 'link' && view.embeddable === 'unknown') {
      nodes.push(h('button', { type: 'button', class: 'tile-hint', dataset: { action: 'open' } }, 'Blank? Open in new tab'));
    }
    return nodes;
  }

  function ariaLabel(view: TileView): string {
    const id = slotName(view.slot);
    if (view.kind === 'empty') return `${id}, empty`;
    const what = view.title || (view.kind === 'html' ? 'HTML page' : domainOf(view.url));
    return [id, view.label, what].filter((s) => s).join(', ');
  }

  function renderTile(slot: SlotIndex): void {
    const p = parts[slot];
    if (!p) return;
    const view = state.tile(slot);
    const filled = view.kind !== 'empty';
    const edit = canEdit();

    p.tile.classList.remove(...STATE_CLASSES);
    p.tile.classList.add(`is-${view.kind}`);
    if (view.kind === 'link' && view.embeddable === 'pending') p.tile.classList.add('is-checking');
    if (filled && view.embeddable === 'no') p.tile.classList.add('is-blocked');
    p.tile.setAttribute('aria-label', ariaLabel(view));

    if (editing !== slot) {
      p.name.textContent = view.label;
      p.name.hidden = !filled;
      p.name.disabled = !edit;
      p.name.setAttribute('aria-label', `Rename ${slotName(slot)}: ${view.label}`);
    }
    p.badge.hidden = view.kind !== 'html';
    p.card.replaceChildren(...cardContent(view));

    p.open.hidden = !filled;
    p.replace.hidden = !filled || !edit;
    p.history.hidden = view.version === 0;
    p.clear.hidden = !filled || !teacher;
  }

  function render(): void {
    for (let slot = 0; slot < SLOT_COUNT; slot++) renderTile(slot);
  }

  function startRename(slot: SlotIndex): void {
    const p = parts[slot];
    if (!p || editing !== null || !canEdit()) return;
    const view = state.tile(slot);
    if (view.kind === 'empty') return;
    editing = slot;
    const input = h('input', {
      class: 'tile-name-input',
      type: 'text',
      value: view.label,
      maxLength: LIMITS.labelMax,
      attrs: { 'aria-label': `Name for ${slotName(slot)}`, autocomplete: 'off' },
    });
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const next = cleanText(input.value, LIMITS.labelMax);
      editing = null;
      input.replaceWith(p.name);
      renderTile(slot);
      if (save && next && next !== view.label) actions.rename(slot, next);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
        p.tile.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        p.tile.focus();
      }
    });
    input.addEventListener('blur', () => finish(false));
    p.name.replaceWith(input);
    input.focus();
    input.select();
  }

  function slotOf(el: Element): SlotIndex | null {
    const raw = el.closest<HTMLElement>('.tile')?.dataset.slot;
    const n = Number(raw);
    return raw !== undefined && Number.isInteger(n) && n >= 0 && n < SLOT_COUNT ? n : null;
  }

  function onClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const button = target?.closest<HTMLElement>('[data-action]');
    if (!button || !root.contains(button)) return;
    const slot = slotOf(button);
    if (slot === null) return;
    switch (button.dataset.action) {
      case 'add':
        actions.add(slot);
        break;
      case 'replace':
        actions.replace(slot);
        break;
      case 'history':
        actions.history(slot);
        break;
      case 'open':
        actions.open(slot);
        break;
      case 'clear':
        actions.clear(slot);
        break;
      case 'rename':
        startRename(slot);
        break;
      case 'back':
        actions.back();
        break;
      default:
        return;
    }
    e.stopPropagation();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLElement) || !e.target.classList.contains('tile')) return;
    const slot = slotOf(e.target);
    if (slot === null) return;
    e.preventDefault();
    actions.focus(slot);
  }

  function setLocked(on: boolean): void {
    locked = on;
    root.classList.toggle('is-locked', on);
    render();
  }

  for (let slot = 0; slot < SLOT_COUNT; slot++) parts.push(build(slot));
  root.replaceChildren(...parts.map((p) => p.tile));
  root.classList.toggle('is-locked', locked);
  render();
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  const subs: Unsubscribe[] = [
    state.on('snapshot', () => setLocked(state.locked())),
    state.on('tile', (view) => renderTile(view.slot)),
    state.on('locked', (on) => setLocked(on)),
  ];

  const part = (slot: SlotIndex): TileParts => {
    const p = parts[slot];
    if (!p) throw new RangeError(`No tile for slot ${slot}`);
    return p;
  };

  return {
    tileEl: (slot) => part(slot).tile,
    bodyEl: (slot) => part(slot).body,
    frameHost: (slot) => part(slot).frame,
    render,
    update: renderTile,
    setLocked,
    setTeacher(on: boolean) {
      teacher = on;
      render();
    },
    destroy() {
      for (const off of subs) off();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      root.replaceChildren();
      root.classList.remove('is-locked');
      parts.length = 0;
    },
  };
}
