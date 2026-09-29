import { h } from './dom';
import './modal.css';

export type BannerKind = 'info' | 'warn' | 'error';

function stack(): HTMLElement {
  let el = document.getElementById('banner');
  if (!el) {
    el = h('div', { id: 'banner' });
    document.body.append(el);
  }
  return el;
}

function find(id: string): HTMLElement | null {
  return [...stack().children].find((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.banner === id) ?? null;
}

/** Shows a banner, or updates the one with the same id in place. */
export function showBanner(id: string, text: string, kind: BannerKind = 'info'): void {
  let el = find(id);
  if (!el) {
    el = h('div', { dataset: { banner: id } });
    stack().append(el);
  }
  el.className = `banner banner-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
}

export function hideBanner(id: string): void {
  find(id)?.remove();
}
