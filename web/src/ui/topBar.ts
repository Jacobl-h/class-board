import type { TopBarApi, TopBarHandlers } from '../contracts';
import { clear, h } from './dom';
import './topbar.css';

/** Fills the header with the board name, zoom controls, people, cursor and help buttons. */
export function mountTopBar(el: HTMLElement, handlers: TopBarHandlers): TopBarApi {
  const boardName = h('span', { class: 'topbar-board', dataset: { role: 'board-name' } });
  const teacherBadge = h('span', { class: 'topbar-badge', dataset: { role: 'teacher-badge' }, hidden: true }, 'Teacher');
  const zoom = h('span', { class: 'topbar-zoom', dataset: { role: 'zoom' }, attrs: { 'aria-live': 'off' } }, '100%');
  const peopleCount = h('span', { dataset: { role: 'people-count' } }, '0');
  const cursorPreview = h('img', {
    class: 'topbar-cursor',
    alt: '',
    width: 20,
    height: 20,
    hidden: true,
  });

  const button = (action: string, label: string, title: string, on: () => void, ...content: Array<Node | string>) =>
    h('button', { class: 'topbar-btn', type: 'button', title, dataset: { action }, attrs: { 'aria-label': label }, on: { click: on } }, ...content);

  const peopleButton = h(
    'button',
    { class: 'topbar-btn', type: 'button', title: 'Show who is here', dataset: { action: 'people' } },
    peopleCount,
    ' here',
  );

  clear(el);
  el.classList.add('topbar');
  el.append(
    h('div', { class: 'topbar-group' }, h('strong', { class: 'topbar-title' }, 'Class board'), boardName, teacherBadge),
    h(
      'div',
      { class: 'topbar-group topbar-zoom-group' },
      button('zoom-out', 'Zoom out', 'Zoom out (-)', () => handlers.zoomOut(), '−'),
      zoom,
      button('zoom-in', 'Zoom in', 'Zoom in (+)', () => handlers.zoomIn(), '+'),
      button('fit', 'Fit board', 'Fit the whole board (0)', () => handlers.fit(), 'Fit board'),
    ),
    h(
      'div',
      { class: 'topbar-group topbar-right' },
      peopleButton,
      button('profile', 'Your cursor', 'Change your name and cursor', () => handlers.profile(), cursorPreview, h('span', { class: 'topbar-label' }, 'Your cursor')),
      button('help', 'Help', 'How the board works', () => handlers.help(), '?'),
    ),
  );

  return {
    peopleButton,
    setBoardName(name) {
      boardName.textContent = name;
    },
    setPeopleCount(n) {
      peopleCount.textContent = String(n);
    },
    setZoom(scale) {
      zoom.textContent = Math.round(scale * 100) + '%';
    },
    setTeacher(on) {
      teacherBadge.hidden = !on;
    },
    setCursorPreview(url) {
      if (url === null) {
        cursorPreview.removeAttribute('src');
        cursorPreview.hidden = true;
      } else {
        cursorPreview.src = url;
        cursorPreview.hidden = false;
      }
    },
  };
}
