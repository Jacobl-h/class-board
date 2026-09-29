import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from '../src/ui/dom';
import { openModal, type ModalHandle } from '../src/ui/modal';

let handle: ModalHandle | null = null;

function open(overrides: Partial<Parameters<typeof openModal>[0]> = {}): ModalHandle {
  handle = openModal({
    title: 'Post to C4',
    dialog: 'post',
    body: h('div', null, h('input', { name: 'url' }), h('button', { dataset: { action: 'submit' } }, 'Post')),
    ...overrides,
  });
  return handle;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function clickBackdrop(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const modals = () => document.querySelectorAll('.modal');

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.close();
  handle = null;
});

describe('openModal', () => {
  it('creates #modal-root when it is missing and renders .modal[data-dialog] inside it', () => {
    const m = open();
    const root = document.getElementById('modal-root');
    expect(root).not.toBeNull();
    expect(m.el.parentElement).toBe(root);
    expect(m.el.classList.contains('modal')).toBe(true);
    expect(m.el.dataset.dialog).toBe('post');
  });

  it('reuses an existing #modal-root', () => {
    const root = h('div', { id: 'modal-root' });
    document.body.append(root);
    const m = open();
    expect(m.el.parentElement).toBe(root);
    expect(document.querySelectorAll('#modal-root')).toHaveLength(1);
  });

  it('is a labelled modal dialog', () => {
    const m = open({ title: 'Your cursor' });
    expect(m.el.getAttribute('role')).toBe('dialog');
    expect(m.el.getAttribute('aria-modal')).toBe('true');
    const title = m.el.querySelector('.modal-title');
    expect(title?.textContent).toBe('Your cursor');
    expect(m.el.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(title?.id).not.toBe('');
  });

  it('shows the body and focuses its first input', () => {
    const m = open();
    const input = m.el.querySelector('input[name="url"]');
    expect(m.el.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('focuses the close button when the body has no input', () => {
    const m = open({ body: h('p', null, 'Just text') });
    expect(document.activeElement).toBe(m.el.querySelector('[data-action="close"]'));
  });

  it('closes with the close button and calls onClose once', () => {
    const onClose = vi.fn();
    const m = open({ onClose });
    m.el.querySelector<HTMLElement>('[data-action="close"]')!.click();
    expect(modals()).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    m.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes with a [data-action="close"] button that the body provides', () => {
    const m = open({ body: h('div', null, h('button', { dataset: { action: 'close' } }, 'Cancel')) });
    m.el.querySelector<HTMLElement>('.modal-body [data-action="close"]')!.click();
    expect(modals()).toHaveLength(0);
  });

  it('closes on Escape', () => {
    open();
    pressEscape();
    expect(modals()).toHaveLength(0);
  });

  it('closes when the backdrop is clicked, but not when the panel is', () => {
    const m = open();
    m.el.querySelector<HTMLElement>('.modal-panel')!.click();
    expect(modals()).toHaveLength(1);
    clickBackdrop(m.el);
    expect(modals()).toHaveLength(0);
  });

  it('does not close when a press inside the panel is released on the backdrop', () => {
    const m = open();
    m.el.querySelector('.modal-panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    m.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modals()).toHaveLength(1);
  });

  it('with closable false, has no close button and ignores Escape, the backdrop and body close buttons', () => {
    const onClose = vi.fn();
    const m = open({ closable: false, onClose, body: h('div', null, h('input'), h('button', { dataset: { action: 'close' } }, 'Cancel')) });
    expect(m.el.querySelector('.modal-header [data-action="close"]')).toBeNull();
    pressEscape();
    clickBackdrop(m.el);
    m.el.querySelector<HTMLElement>('.modal-body [data-action="close"]')!.click();
    expect(modals()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    m.close();
    expect(modals()).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps one modal at a time and closes the first when a second opens', () => {
    const onCloseFirst = vi.fn();
    open({ dialog: 'post', onClose: onCloseFirst });
    open({ dialog: 'help' });
    expect(modals()).toHaveLength(1);
    expect((modals()[0] as HTMLElement).dataset.dialog).toBe('help');
    expect(onCloseFirst).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Escape after it closes', () => {
    const onClose = vi.fn();
    const m = open({ onClose });
    m.close();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives focus back to the element that had it before the modal opened', () => {
    const trigger = h('button', null, 'Open');
    document.body.append(trigger);
    trigger.focus();
    const m = open();
    expect(document.activeElement).not.toBe(trigger);
    m.close();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab inside the dialog', () => {
    const m = open();
    const input = m.el.querySelector<HTMLElement>('input')!;
    const submit = m.el.querySelector<HTMLElement>('[data-action="submit"]')!;
    submit.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(m.el.querySelector('[data-action="close"]'));

    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(submit);
    expect(m.el.contains(input)).toBe(true);
  });
});
