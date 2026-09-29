import { describe, expect, it, vi } from 'vitest';
import { clear, h } from '../src/ui/dom';

describe('h', () => {
  it('creates an element of the given tag', () => {
    const el = h('section');
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.tagName).toBe('SECTION');
  });

  it('sets class, dataset, style and attrs', () => {
    const el = h('div', {
      class: 'a b',
      dataset: { slot: 23, ready: true, name: 'x' },
      style: { left: '10px', zIndex: 5, '--tile-w': '480px' },
      attrs: { role: 'dialog', 'aria-modal': true, tabindex: 0, 'aria-hidden': false, title: undefined },
    });
    expect(el.className).toBe('a b');
    expect(el.dataset.slot).toBe('23');
    expect(el.dataset.ready).toBe('true');
    expect(el.dataset.name).toBe('x');
    expect(el.style.left).toBe('10px');
    expect(el.style.zIndex).toBe('5');
    expect(el.style.getPropertyValue('--tile-w')).toBe('480px');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('assigns other props as DOM properties and skips undefined ones', () => {
    const input = h('input', { type: 'checkbox', name: 'agree', checked: true, disabled: true, hidden: true });
    expect(input.type).toBe('checkbox');
    expect(input.name).toBe('agree');
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.hidden).toBe(true);
    const p = h('p', { textContent: 'hello', title: undefined });
    expect(p.textContent).toBe('hello');
    expect(p.title).toBe('');
  });

  it('attaches listeners from on', () => {
    const click = vi.fn();
    const keydown = vi.fn();
    const el = h('button', { on: { click, keydown } });
    el.click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(keydown).toHaveBeenCalledTimes(1);
  });

  it('appends nodes, strings and numbers, and skips null, undefined and false', () => {
    const child = h('b', null, 'bold');
    const el = h('p', null, 'a', 1, null, undefined, false, child, 0);
    expect(el.childNodes).toHaveLength(4);
    expect(el.textContent).toBe('a1bold0');
    expect(el.querySelector('b')).toBe(child);
  });

  it('treats text children as text, never as HTML', () => {
    const el = h('p', null, '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('accepts null props', () => {
    expect(h('span', null, 'x').textContent).toBe('x');
  });
});

describe('clear', () => {
  it('removes every child', () => {
    const el = h('div', null, h('p'), 'text', h('p'));
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});
