# Web core A: helpers, camera, socket, state, top bar

These tasks build the first half of the browser's plumbing, all in `web/`, and they depend on other workstreams only through `web/src/contracts.ts` and the shared modules (U2 also needs `shared/src/slots.ts`, Task F3).

- **U1** builds the DOM helper `h()`, the emitter, `serverHref`, the modal, banners and the error texts.
- **U2** builds the camera: pan and zoom math, scale limits, pan limits, fit and center.
- **U3** builds the PartySocket wrapper (`connectBoard`) and the HTML upload client.
- **U4** builds the board state: it applies every `ServerMsg` and emits `BoardStateEvents`.
- **U7** (Wave 3) builds the config module, the top bar and the help dialog.

U1 to U4 run in Wave 2 and U7 in Wave 3. Every command runs from the repo root, `C:/Users/jacob/OneDrive/Documents/GitHub/class-board`, and every test uses `happy-dom` through the web package's Vitest config (master plan §2). Web tests never touch the network: the socket tests inject a fake socket and the upload tests stub `fetch`.

The code in this file was run end to end in a scratch workspace (`vitest` 5.0.2, `happy-dom` 20.14.5, `partysocket` 1.3.0, `typescript` 7.0.2 with `strict` and `noUncheckedIndexedAccess`). All 153 tests pass and the code typechecks. Where a step gives a test count, that is the count from that run.

**Third-party APIs used**

- `partysocket` 1.3.0, used only in `web/src/net/socket.ts`. Docs: https://docs.partykit.io/reference/partysocket-api/ and the source at https://github.com/cloudflare/partykit/tree/main/packages/partysocket. Checked against the installed `index.d.ts` and `dist/index.js`:
  - `new PartySocket({ host, protocol: 'ws' | 'wss', party, room })` connects to `<protocol>://<host>/parties/<party>/<room>`. `host` includes the port (`localhost:8787`). The `roomUrl` getter returns that URL, and a socket built with `startClosed: true` never connects, which is how the test checks the URL.
  - `PartySocket` is a reconnecting WebSocket. It reconnects with backoff, fires `open` again after every reconnect, and fires `close` after each failed attempt. Events come from `addEventListener('open' | 'close' | 'message' | 'error', fn)`, and `message` events carry `event.data`.
  - **Gotcha:** while disconnected, `send()` queues messages (`maxEnqueuedMessages` defaults to `Infinity`) and flushes them on the next open, *before* our `hello`. The server would answer them with `not_ready`. `connectBoard` passes `maxEnqueuedMessages: 0` (the queue then drops everything) and does its own gating on the status.
- `happy-dom` 20.14.5 (the Vitest environment). Confirmed: `location.search` follows `window.history.replaceState`, `Blob`, `Response`, `KeyboardEvent`, `MouseEvent` and `Event` exist, and CSS imports (`import './modal.css'`) are accepted by Vitest and ignored.
- `vitest` 5.0.2. Confirmed: `vi.stubEnv` plus `vi.resetModules()` plus a dynamic `import()` re-evaluates `import.meta.env.VITE_SERVER_URL` in `config.ts`. `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync` drives the 10 s request timeout. `vi.stubGlobal('fetch', …)` and `vi.unstubAllGlobals()` stub the network. Test-file filters match by path substring, so the commands below end in `.test` (`-- dom.test`) to match one file.

---

### Task U1: DOM, emitter, URL, modal, banner and error helpers

**Wave:** 2 · **Tier:** T0 (haiku) · **Depends on:** F1, F2

**Files:**
- Create: `web/src/ui/dom.ts`, `web/src/util/emitter.ts`, `web/src/util/url.ts`, `web/src/ui/modal.ts`, `web/src/ui/modal.css`, `web/src/ui/banner.ts`, `web/src/ui/errors.ts`
- Test: `web/test/dom.test.ts`, `web/test/emitter.test.ts`, `web/test/url.test.ts`, `web/test/modal.test.ts`, `web/test/banner.test.ts`

Notes for the implementer:
- `modal.css` uses the variables from `base.css` (`--z-modal`, `--z-banner`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--danger`, `--radius`, `--font`). Task U6 defines them. Don't define them here.
- There is no separate banner stylesheet: the `#banner` stack and the `.banner` styles live in `modal.css`, and `banner.ts` imports it.
- The tests for `errorText` and `toast` are in `banner.test.ts` (this task's file list has no `errors.test.ts`).

- [ ] **Step 1: Write the failing test for `h()` and `clear()`**

`web/test/dom.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- dom.test`
Expected: FAIL, `Failed to resolve import "../src/ui/dom" from "web/test/dom.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `web/src/ui/dom.ts`**

```ts
export type Child = Node | string | number | null | undefined | false;

/** Handlers pick their own Event subtype, so the listener parameter is deliberately loose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Listener = (ev: any) => void;

export interface HProps {
  class?: string;
  dataset?: Record<string, string | number | boolean>;
  /** Values are used as written: pass '12px', not 12 (except for unitless properties such as zIndex). */
  style?: Record<string, string | number>;
  /** true sets an empty attribute, false and undefined remove it. */
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Record<string, Listener>;
  /** Anything else is assigned as a DOM property: type, value, hidden, disabled, textContent, … */
  [prop: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: HProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: HProps | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: HProps | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined) continue;
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value as Record<string, string | number | boolean>)) el.dataset[k] = String(v);
    } else if (key === 'style') {
      for (const [k, v] of Object.entries(value as Record<string, string | number>)) {
        if (k.startsWith('--')) el.style.setProperty(k, String(v));
        else el.style.setProperty(k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(v));
      }
    } else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value as Record<string, string | number | boolean | undefined>)) {
        if (v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(value as Record<string, Listener>)) el.addEventListener(type, fn);
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- dom.test`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing tests for the emitter and `serverHref`**

`web/test/emitter.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../src/util/emitter';

interface Events {
  count: number;
  ready: undefined;
  name: string;
}

afterEach(() => vi.restoreAllMocks());

describe('createEmitter', () => {
  it('delivers a payload to every listener of that event only', () => {
    const e = createEmitter<Events>();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    e.on('count', a);
    e.on('count', b);
    e.on('name', other);
    e.emit('count', 3);
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
    expect(other).not.toHaveBeenCalled();
  });

  it('lets an event with an undefined payload be emitted with no argument', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    e.on('ready', fn);
    e.emit('ready');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it('stops delivering after the returned unsubscribe is called', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    const off = e.on('count', fn);
    e.emit('count', 1);
    off();
    e.emit('count', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is safe to unsubscribe while emitting', () => {
    const e = createEmitter<Events>();
    const calls: string[] = [];
    const offFirst = e.on('count', () => {
      calls.push('first');
      offFirst();
    });
    e.on('count', () => calls.push('second'));
    e.emit('count', 1);
    e.emit('count', 2);
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('keeps delivering to other listeners when one throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = createEmitter<Events>();
    const after = vi.fn();
    e.on('count', () => {
      throw new Error('boom');
    });
    e.on('count', after);
    e.emit('count', 1);
    expect(after).toHaveBeenCalledWith(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('clear removes every listener', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    e.on('count', fn);
    e.on('name', fn);
    e.clear();
    e.emit('count', 1);
    e.emit('name', 'x');
    expect(fn).not.toHaveBeenCalled();
  });
});
```

`web/test/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { serverHref } from '../src/util/url';

describe('serverHref', () => {
  it('resolves a server-relative path against the server origin', () => {
    expect(serverHref('http://localhost:8787', '/boards/main/files/abc')).toBe('http://localhost:8787/boards/main/files/abc');
  });

  it('ignores a trailing slash on the server url', () => {
    expect(serverHref('https://board.example.workers.dev/', '/boards/main/shots/xyz')).toBe(
      'https://board.example.workers.dev/boards/main/shots/xyz',
    );
  });

  it('passes absolute urls through unchanged', () => {
    const thumb = 'https://i.ytimg.com/vi/abc123/hqdefault.jpg';
    expect(serverHref('http://localhost:8787', thumb)).toBe(thumb);
    expect(serverHref('http://localhost:8787', 'HTTP://Example.com')).toBe('HTTP://Example.com');
  });

  it('keeps the query string and hash of a relative path', () => {
    expect(serverHref('http://localhost:8787', '/boards/main/files/abc?x=1#top')).toBe(
      'http://localhost:8787/boards/main/files/abc?x=1#top',
    );
  });
});
```

- [ ] **Step 6: Run them and confirm they fail**

Run: `npm test -w web -- emitter.test url.test`
Expected: FAIL in both files, `Failed to resolve import "../src/util/emitter"` and `"../src/util/url"`.

- [ ] **Step 7: Implement `web/src/util/emitter.ts` and `web/src/util/url.ts`**

`web/src/util/emitter.ts`:

```ts
import type { Unsubscribe } from '../contracts';

export interface Emitter<E extends object> {
  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): Unsubscribe;
  /** Events whose payload type includes undefined (for example `snapshot: undefined`) can be emitted with no payload. */
  emit<K extends keyof E>(event: K, ...payload: undefined extends E[K] ? [payload?: E[K]] : [payload: E[K]]): void;
  clear(): void;
}

export function createEmitter<E extends object>(): Emitter<E> {
  const listeners = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (payload: never) => void);
      return () => {
        listeners.get(event)?.delete(fn as (payload: never) => void);
      };
    },
    emit(event, ...payload) {
      // Copy first: a listener may unsubscribe itself or others while we iterate.
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          (fn as (p: unknown) => void)(payload[0]);
        } catch (err) {
          console.error(`Listener for "${String(event)}" threw`, err);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
```

`web/src/util/url.ts`:

```ts
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Absolute URLs pass through unchanged; server-relative paths are resolved against the server's origin. */
export function serverHref(serverUrl: string, path: string): string {
  if (HAS_SCHEME.test(path)) return path;
  return new URL(path, serverUrl).href;
}
```

- [ ] **Step 8: Run them and confirm they pass**

Run: `npm test -w web -- emitter.test url.test`
Expected: PASS (2 files, 10 tests: 6 emitter, 4 url).

- [ ] **Step 9: Write the failing test for the modal**

`web/test/modal.test.ts`:

```ts
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
```

- [ ] **Step 10: Run it and confirm it fails**

Run: `npm test -w web -- modal.test`
Expected: FAIL, `Failed to resolve import "../src/ui/modal" from "web/test/modal.test.ts". Does the file exist?`

- [ ] **Step 11: Implement `web/src/ui/modal.css` and `web/src/ui/modal.ts`**

`web/src/ui/modal.css`:

```css
.modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
  font-family: var(--font);
  color: var(--text);
}

.modal-panel {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.modal-close {
  flex: none;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
}

.modal-close:hover {
  background: var(--bg);
  color: var(--text);
}

.modal-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.modal-body {
  padding: 16px;
  overflow: auto;
}

/* Banners (banner.ts). U1 has no separate stylesheet, so they live here. */
#banner {
  position: fixed;
  left: 50%;
  bottom: 16px;
  z-index: var(--z-banner);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: min(560px, calc(100% - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}

.banner {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: 0.9rem/1.4 var(--font);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  pointer-events: auto;
}

.banner-warn {
  border-color: var(--accent);
}

.banner-error {
  border-color: var(--danger);
  color: var(--danger);
}
```

`web/src/ui/modal.ts`:

```ts
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
```

- [ ] **Step 12: Run it and confirm it passes**

Run: `npm test -w web -- modal.test`
Expected: PASS (15 tests).

- [ ] **Step 13: Write the failing test for banners, error texts and toasts**

`web/test/banner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorCode } from '@class-board/shared/types';
import { hideBanner, showBanner } from '../src/ui/banner';
import { errorText, toast } from '../src/ui/errors';

const banners = () => [...document.querySelectorAll<HTMLElement>('#banner [data-banner]')];
const byId = (id: string) => document.querySelector<HTMLElement>(`#banner [data-banner="${id}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showBanner and hideBanner', () => {
  it('creates #banner when it is missing and renders a banner inside it', () => {
    showBanner('reconnecting', 'Reconnecting…', 'warn');
    const el = byId('reconnecting');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Reconnecting…');
    expect(el!.classList.contains('banner-warn')).toBe(true);
    expect(document.querySelectorAll('#banner')).toHaveLength(1);
  });

  it('defaults to the info kind', () => {
    showBanner('locked', 'The board is locked.');
    expect(byId('locked')!.classList.contains('banner-info')).toBe(true);
    expect(byId('locked')!.getAttribute('role')).toBe('status');
  });

  it('marks error banners as alerts', () => {
    showBanner('unreachable', "Can't reach the board server", 'error');
    expect(byId('unreachable')!.getAttribute('role')).toBe('alert');
  });

  it('updates the banner in place when the id already exists', () => {
    showBanner('limit', 'first', 'info');
    const first = byId('limit');
    showBanner('limit', 'second', 'error');
    expect(banners()).toHaveLength(1);
    expect(byId('limit')).toBe(first);
    expect(first!.textContent).toBe('second');
    expect(first!.classList.contains('banner-error')).toBe(true);
    expect(first!.classList.contains('banner-info')).toBe(false);
  });

  it('stacks banners with different ids in the order they were shown', () => {
    showBanner('a', 'one');
    showBanner('b', 'two');
    expect(banners().map((b) => b.dataset.banner)).toEqual(['a', 'b']);
  });

  it('hides one banner and ignores an unknown id', () => {
    showBanner('a', 'one');
    showBanner('b', 'two');
    hideBanner('a');
    hideBanner('missing');
    expect(banners().map((b) => b.dataset.banner)).toEqual(['b']);
  });

  it('uses the #banner element that is already on the page', () => {
    const existing = document.createElement('div');
    existing.id = 'banner';
    document.body.append(existing);
    showBanner('a', 'one');
    expect(existing.querySelector('[data-banner="a"]')).not.toBeNull();
  });
});

describe('errorText', () => {
  const codes: ErrorCode[] = [
    'invalid', 'locked', 'conflict', 'rate_limited', 'too_large',
    'bad_code', 'locked_out', 'not_found', 'full', 'not_ready',
  ];

  it('has text for every error code', () => {
    for (const code of codes) expect(errorText(code).length, code).toBeGreaterThan(0);
  });

  it('uses the agreed wording for conflict and locked', () => {
    expect(errorText('conflict')).toBe('Someone else just changed this tile. Try again.');
    expect(errorText('locked')).toBe('The board is locked.');
  });

  it('is written in sentence case with no please and no exclamation marks', () => {
    for (const code of codes) {
      const text = errorText(code);
      expect(text[0], code).toBe(text[0]!.toUpperCase());
      expect(text.endsWith('.'), code).toBe(true);
      expect(text, code).not.toMatch(/please|!/i);
    }
  });
});

describe('toast', () => {
  it('shows #banner [data-banner="toast"] for 4 seconds', () => {
    toast('Saved');
    expect(byId('toast')!.textContent).toBe('Saved');
    vi.advanceTimersByTime(3999);
    expect(byId('toast')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(byId('toast')).toBeNull();
  });

  it('restarts the 4 seconds and replaces the text when called again', () => {
    toast('first');
    vi.advanceTimersByTime(3000);
    toast('second');
    vi.advanceTimersByTime(3000);
    expect(byId('toast')!.textContent).toBe('second');
    vi.advanceTimersByTime(1000);
    expect(byId('toast')).toBeNull();
    expect(banners()).toHaveLength(0);
  });
});
```

- [ ] **Step 14: Run it and confirm it fails**

Run: `npm test -w web -- banner.test`
Expected: FAIL, `Failed to resolve import "../src/ui/banner" from "web/test/banner.test.ts". Does the file exist?`

- [ ] **Step 15: Implement `web/src/ui/banner.ts` and `web/src/ui/errors.ts`**

`web/src/ui/banner.ts`:

```ts
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
```

`web/src/ui/errors.ts`:

```ts
import type { ErrorCode } from '@class-board/shared/types';
import { hideBanner, showBanner } from './banner';

const TEXT: Record<ErrorCode, string> = {
  invalid: "The board couldn't use that. Check it and try again.",
  locked: 'The board is locked.',
  conflict: 'Someone else just changed this tile. Try again.',
  rate_limited: "You're doing that too fast. Wait a moment and try again.",
  too_large: 'That file is over 1 MB. Choose a smaller HTML file.',
  bad_code: 'That passcode is wrong. Check it and try again.',
  locked_out: 'Too many wrong passcodes. Wait 10 minutes and try again.',
  not_found: "The board couldn't find that. Refresh the list and try again.",
  full: 'The board is full. Try again in a few minutes.',
  not_ready: 'The board is not connected yet. Wait a moment and try again.',
};

export function errorText(code: ErrorCode): string {
  return TEXT[code];
}

const TOAST_MS = 4000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string): void {
  showBanner('toast', text, 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideBanner('toast'), TOAST_MS);
}
```

- [ ] **Step 16: Run it and confirm it passes**

Run: `npm test -w web -- banner.test`
Expected: PASS (12 tests).

- [ ] **Step 17: Commit (orchestrator)**

```bash
git add web/src/ui/dom.ts web/src/util/emitter.ts web/src/util/url.ts web/src/ui/modal.ts web/src/ui/modal.css web/src/ui/banner.ts web/src/ui/errors.ts web/test/dom.test.ts web/test/emitter.test.ts web/test/url.test.ts web/test/modal.test.ts web/test/banner.test.ts
git commit -m "feat(web): DOM, emitter, URL, modal, banner and error helpers (U1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U2: Camera

**Wave:** 2 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2, F3 (`tileRect` and `nearestSlot` from `shared/src/slots.ts`. F3 is scheduled in this same wave, so the orchestrator must have F3 committed or at least written to disk before U2 starts its tests)

**Files:**
- Create: `web/src/board/camera.ts`
- Test: `web/test/camera.test.ts`

The math, for a viewport of `vw × vh` and camera state `{ s, tx, ty }` (a board point `(bx, by)` appears at `(bx*s + tx, by*s + ty)`):

- `minScale = max(0.01, min((vw − 96) / BOARD_W, (vh − 96) / BOARD_H))`. That fits the board with a 48 px margin on each side. The `0.01` floor only matters in viewports smaller than about 100 px.
- `maxScaleForSlot(slot) = max(minScale, min(vw / TILE_W, vh / TILE_H))`. That is the scale at which the tile body exactly fills the viewport on its limiting side (contain), with no margin. Every tile is 480 × 300, so the value is the same for every slot, and `zoomAt` uses it as the global maximum.
- `zoomAt(sx, sy, factor)` computes `target = s * factor`, clamps it to `[minScale, max]`, and moves `tx, ty` so the board point under `(sx, sy)` stays under it. `blockedIn` is `factor > 1 && target > max`, so it is also true when the camera already sits at the maximum. `slot` is `nearestSlot(toBoard(sx, sy))`, taken before the zoom.
- Pan limits: for each axis, with viewport size `V` and board extent `E = boardSize * s` on screen, let `need = min(0.25 * V, E)`. Then `t` must stay in `[need − E, V − need]`. That leaves at least 25% of the viewport showing board, or the whole board when it is smaller than 25% of the viewport. The clamp runs after every pan, zoom, fit, center and viewport change.
- `setViewport` refits the board if it was fitted before the resize. Otherwise it re-clamps the scale to the new limits, keeping the middle of the view fixed, and then re-clamps the pan. Listeners always hear about a resize.
- `onChange` fires once after each call that changed the state, with a copy of it, and stays quiet when nothing changed.

- [ ] **Step 1: Write the failing tests for limits, conversions, zoom, fit and events**

`web/test/camera.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { BOARD_H, BOARD_W } from '@class-board/shared/constants';
import { tileRect } from '@class-board/shared/slots';
import { createCamera } from '../src/board/camera';

const W = 1280;
const H = 800;
const C4 = 23;
const MIN_1280x800 = (W - 96) / BOARD_W; // width is the limiting side: 1184 / 5232
const MAX_1280x800 = 8 / 3; // a 480×300 tile exactly fits a 1280×800 viewport

describe('scale limits', () => {
  it('minScale fits the whole board with a 48 px margin on each side', () => {
    expect(createCamera(W, H).minScale()).toBeCloseTo(MIN_1280x800, 10);
    // Tall viewport: height is not the limit, width is.
    expect(createCamera(600, 1000).minScale()).toBeCloseTo((600 - 96) / BOARD_W, 10);
    // Very wide viewport: height is the limit.
    expect(createCamera(3000, 300).minScale()).toBeCloseTo((300 - 96) / BOARD_H, 10);
  });

  it('maxScaleForSlot makes a tile exactly fill the viewport on its limiting side, with no margin', () => {
    expect(createCamera(W, H).maxScaleForSlot(C4)).toBeCloseTo(MAX_1280x800, 10);
    expect(createCamera(1000, 800).maxScaleForSlot(C4)).toBeCloseTo(1000 / 480, 10);
    expect(createCamera(1600, 500).maxScaleForSlot(C4)).toBeCloseTo(500 / 300, 10);
  });

  it('maxScaleForSlot is the same for every slot', () => {
    const cam = createCamera(1111, 777);
    const values = [0, 9, 23, 70, 79].map((slot) => cam.maxScaleForSlot(slot));
    for (const v of values) expect(v).toBeCloseTo(values[0]!, 10);
  });

  it('never lets the largest scale fall below the smallest, even in a tiny viewport', () => {
    const cam = createCamera(50, 50);
    expect(cam.maxScaleForSlot(0)).toBeGreaterThanOrEqual(cam.minScale());
    expect(cam.minScale()).toBeGreaterThan(0);
  });
});


describe('initial state and conversions', () => {
  it('starts with the board fitted and centered', () => {
    const cam = createCamera(W, H);
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
    expect(tx).toBeCloseTo(48, 8);
  });

  it('toScreen and toBoard are inverses and follow x*s + tx', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(300, 200, 3);
    cam.panBy(-40, 25);
    const { s, tx, ty } = cam.state();
    const p = cam.toScreen(1000, 700);
    expect(p.x).toBeCloseTo(1000 * s + tx, 8);
    expect(p.y).toBeCloseTo(700 * s + ty, 8);
    const b = cam.toBoard(p.x, p.y);
    expect(b.x).toBeCloseTo(1000, 6);
    expect(b.y).toBeCloseTo(700, 6);
  });

  it('state() returns a copy and viewport() the current size', () => {
    const cam = createCamera(W, H);
    const copy = cam.state();
    copy.s = 99;
    expect(cam.state().s).not.toBe(99);
    expect(cam.viewport()).toEqual({ w: W, h: H });
  });
});


describe('zoomAt', () => {
  it('keeps the board point under the pointer fixed', () => {
    const cam = createCamera(W, H);
    for (const [sx, sy, factor] of [[400, 300, 2], [900, 500, 1.25], [640, 400, 0.8], [100, 700, 1.6]] as const) {
      const before = cam.toBoard(sx, sy);
      cam.zoomAt(sx, sy, factor);
      const after = cam.toBoard(sx, sy);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('multiplies the scale by the factor when it is inside the limits', () => {
    const cam = createCamera(W, H);
    const s0 = cam.state().s;
    const result = cam.zoomAt(600, 400, 2);
    expect(cam.state().s).toBeCloseTo(s0 * 2, 10);
    expect(result.blockedIn).toBe(false);
  });

  it('clamps zoom-out at minScale without reporting blockedIn', () => {
    const cam = createCamera(W, H);
    const before = cam.state();
    const result = cam.zoomAt(600, 400, 0.1);
    expect(cam.state()).toEqual(before);
    expect(result.blockedIn).toBe(false);
  });

  it('clamps zoom-in at the maximum and reports blockedIn', () => {
    const cam = createCamera(W, H);
    const result = cam.zoomAt(640, 400, 1000);
    expect(cam.state().s).toBeCloseTo(MAX_1280x800, 10);
    expect(result.blockedIn).toBe(true);
  });

  it('reports blockedIn again when already at the maximum, and does not change the camera', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(640, 400, 1000);
    const at = cam.state();
    const listener = vi.fn();
    cam.onChange(listener);
    expect(cam.zoomAt(640, 400, 1.05).blockedIn).toBe(true);
    expect(cam.zoomAt(640, 400, 1.0001).blockedIn).toBe(true);
    expect(cam.state()).toEqual(at);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not report blockedIn when zooming out from the maximum, or for a zoom-in that stops short of it', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(640, 400, 1000);
    expect(cam.zoomAt(640, 400, 0.5).blockedIn).toBe(false);
    expect(cam.zoomAt(640, 400, 1.2).blockedIn).toBe(false);
  });

  it('reports the slot nearest to the pointer', () => {
    const cam = createCamera(W, H);
    const r = tileRect(C4);
    const c = cam.toScreen(r.x + r.w / 2, r.y + r.h / 2);
    expect(cam.zoomAt(c.x, c.y, 1.5).slot).toBe(C4);
  });

  it('reports the nearest tile for a pointer that is off the board', () => {
    const cam = createCamera(W, H);
    expect(cam.toBoard(0, 0).x).toBeLessThan(0); // the top-left corner of the viewport is outside the board
    expect(cam.zoomAt(0, 0, 1.2).slot).toBe(0);
  });
});


describe('fit and center', () => {
  it('fitBoard returns to minScale with the board centered', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(200, 100, 5);
    cam.panBy(-300, 120);
    cam.fitBoard();
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
  });

  it('fitSlot goes to the maximum scale with the tile exactly filling a same-shaped viewport', () => {
    const cam = createCamera(W, H);
    cam.fitSlot(C4);
    expect(cam.state().s).toBeCloseTo(MAX_1280x800, 10);
    const r = cam.slotScreenRect(C4);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.w).toBeCloseTo(W, 6);
    expect(r.h).toBeCloseTo(H, 6);
  });

  it('fitSlot centers the tile in a viewport of a different shape', () => {
    const cam = createCamera(1000, 800);
    cam.fitSlot(0);
    const r = cam.slotScreenRect(0);
    expect(r.w).toBeCloseTo(1000, 6); // width is the limiting side
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y + r.h / 2).toBeCloseTo(400, 6);
    expect(r.h).toBeLessThan(800);
  });

  it('centerOn keeps the scale and puts the board point in the middle of the viewport', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    const s = cam.state().s;
    cam.centerOn(2000, 1500);
    expect(cam.state().s).toBe(s);
    const p = cam.toScreen(2000, 1500);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
  });

  it('slotScreenRect is the tile body in viewport pixels', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(500, 300, 3);
    const { s, tx, ty } = cam.state();
    const t = tileRect(C4);
    const r = cam.slotScreenRect(C4);
    expect(r.x).toBeCloseTo(t.x * s + tx, 8);
    expect(r.y).toBeCloseTo(t.y * s + ty, 8);
    expect(r.w).toBeCloseTo(480 * s, 8);
    expect(r.h).toBeCloseTo(300 * s, 8);
  });
});


describe('onChange', () => {
  it('fires after zoomAt, panBy, fitBoard, fitSlot and centerOn with the new state', () => {
    const cam = createCamera(W, H);
    const states: number[] = [];
    cam.onChange((st) => states.push(st.s));
    cam.zoomAt(600, 400, 2);
    cam.panBy(10, 10);
    cam.fitSlot(C4);
    cam.centerOn(100, 100);
    cam.fitBoard();
    expect(states).toHaveLength(5);
    expect(states[0]).toBeCloseTo(MIN_1280x800 * 2, 10);
    expect(states[2]).toBeCloseTo(MAX_1280x800, 10);
    expect(states[4]).toBeCloseTo(MIN_1280x800, 10);
  });

  it('passes a copy of the state', () => {
    const cam = createCamera(W, H);
    let seen: { s: number } | null = null;
    cam.onChange((st) => {
      seen = st;
    });
    cam.panBy(5, 5);
    seen!.s = 42;
    expect(cam.state().s).not.toBe(42);
  });

  it('does not fire when nothing changed', () => {
    const cam = createCamera(W, H);
    const fn = vi.fn();
    cam.onChange(fn);
    cam.panBy(0, 0);
    cam.zoomAt(600, 400, 1);
    cam.zoomAt(600, 400, 0.5); // already at minScale
    cam.fitBoard();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops after unsubscribe', () => {
    const cam = createCamera(W, H);
    const fn = vi.fn();
    const off = cam.onChange(fn);
    cam.panBy(5, 0);
    off();
    cam.panBy(5, 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- camera.test`
Expected: FAIL, `Failed to resolve import "../src/board/camera" from "web/test/camera.test.ts". Does the file exist?`

- [ ] **Step 3: Implement the camera without pan limits**

`web/src/board/camera.ts`:

```ts
import { BOARD_H, BOARD_W } from '@class-board/shared/constants';
import { nearestSlot, tileRect } from '@class-board/shared/slots';
import type { Rect, SlotIndex } from '@class-board/shared/types';
import type { CameraApi, CameraState } from '../contracts';

/** Space kept around the board when it is fitted, in viewport px. */
export const FIT_MARGIN = 48;

export function createCamera(viewportW: number, viewportH: number): CameraApi {
  let vw = viewportW;
  let vh = viewportH;
  let s = 1;
  let tx = 0;
  let ty = 0;
  const listeners = new Set<(state: CameraState) => void>();

  const minScale = () => Math.max(0.01, Math.min((vw - 2 * FIT_MARGIN) / BOARD_W, (vh - 2 * FIT_MARGIN) / BOARD_H));
  // Every tile is the same size, so slot 0 stands in for all of them.
  const maxScaleForSlot = (slot: SlotIndex) => {
    const r = tileRect(slot);
    return Math.max(minScale(), Math.min(vw / r.w, vh / r.h));
  };
  const maxScale = () => maxScaleForSlot(0);

  const snapshot = (): CameraState => ({ s, tx, ty });

  function commit(before: CameraState, force = false): void {
    if (!force && before.s === s && before.tx === tx && before.ty === ty) return;
    const state = snapshot();
    for (const fn of [...listeners]) fn({ ...state });
  }

  function setScaleAround(sx: number, sy: number, scale: number): void {
    const bx = (sx - tx) / s;
    const by = (sy - ty) / s;
    s = scale;
    tx = sx - bx * s;
    ty = sy - by * s;
  }

  function centerOnPoint(bx: number, by: number): void {
    tx = vw / 2 - bx * s;
    ty = vh / 2 - by * s;
  }

  function fitBoardState(): void {
    s = minScale();
    tx = (vw - BOARD_W * s) / 2;
    ty = (vh - BOARD_H * s) / 2;
  }

  fitBoardState();

  const api: CameraApi = {
    state: snapshot,
    viewport: () => ({ w: vw, h: vh }),
    setViewport(w, h) {
      vw = w;
      vh = h;
    },
    minScale,
    maxScaleForSlot,
    toScreen: (bx, by) => ({ x: bx * s + tx, y: by * s + ty }),
    toBoard: (sx, sy) => ({ x: (sx - tx) / s, y: (sy - ty) / s }),
    zoomAt(sx, sy, factor) {
      const before = snapshot();
      const slot = nearestSlot((sx - tx) / s, (sy - ty) / s);
      const max = maxScale();
      const target = s * factor;
      setScaleAround(sx, sy, Math.min(Math.max(target, minScale()), max));
      commit(before);
      return { blockedIn: factor > 1 && target > max, slot };
    },
    panBy(dx, dy) {
      const before = snapshot();
      tx += dx;
      ty += dy;
      commit(before);
    },
    fitBoard() {
      const before = snapshot();
      fitBoardState();
      commit(before);
    },
    fitSlot(slot) {
      const before = snapshot();
      const r = tileRect(slot);
      s = maxScaleForSlot(slot);
      centerOnPoint(r.x + r.w / 2, r.y + r.h / 2);
      commit(before);
    },
    centerOn(bx, by) {
      const before = snapshot();
      centerOnPoint(bx, by);
      commit(before);
    },
    slotScreenRect(slot): Rect {
      const r = tileRect(slot);
      return { x: r.x * s + tx, y: r.y * s + ty, w: r.w * s, h: r.h * s };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return api;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- camera.test`
Expected: PASS (24 tests).

- [ ] **Step 5: Add the failing tests for pan limits and `setViewport`**

Append this to the end of `web/test/camera.test.ts` (the imports at the top already cover it):

```ts
/** Share of the viewport width (x) or height (y) that shows board. */
function visibleShare(cam: ReturnType<typeof createCamera>, axis: 'x' | 'y'): number {
  const { s, tx, ty } = cam.state();
  const { w, h } = cam.viewport();
  const [t, extent, size] = axis === 'x' ? [tx, BOARD_W * s, w] : [ty, BOARD_H * s, h];
  return Math.max(0, Math.min(t + extent, size) - Math.max(t, 0)) / size;
}

describe('pan limits', () => {
  it('keeps at least 25% of the viewport showing board after any pan', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, 1e6], [-1e6, -1e6]] as const) {
      cam.panBy(dx, dy);
      expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    }
  });

  it('stops exactly at the limit: tx in [need - boardW*s, viewportW - need] with need = min(0.25*viewportW, boardW*s)', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    const s = cam.state().s;
    cam.panBy(1e6, 1e6);
    expect(cam.state().tx).toBeCloseTo(W - 0.25 * W, 8);
    expect(cam.state().ty).toBeCloseTo(H - 0.25 * H, 8);
    cam.panBy(-1e6, -1e6);
    expect(cam.state().tx).toBeCloseTo(0.25 * W - BOARD_W * s, 6);
    expect(cam.state().ty).toBeCloseTo(0.25 * H - BOARD_H * s, 6);
  });

  it('never demands more than the whole board when the board is smaller than 25% of the viewport', () => {
    const cam = createCamera(3000, 300);
    const s = cam.state().s;
    const boardW = BOARD_W * s;
    expect(boardW).toBeLessThan(0.25 * 3000);
    cam.panBy(-1e6, 0);
    expect(cam.state().tx).toBeCloseTo(0, 8); // the board's right edge may not pass the viewport's left edge
    cam.panBy(1e6, 0);
    expect(cam.state().tx).toBeCloseTo(3000 - boardW, 8);
  });

  it('re-clamps after a zoom that would leave the board too far off screen', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    cam.panBy(-1e6, -1e6);
    cam.zoomAt(0, 0, 1 / 6); // zoom out: the same tx is now out of range for the smaller board
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('panBy moves the board by the given screen distance when inside the limits', () => {
    const cam = createCamera(W, H);
    const { tx, ty } = cam.state();
    cam.panBy(30, -20);
    expect(cam.state().tx).toBeCloseTo(tx + 30, 10);
    expect(cam.state().ty).toBeCloseTo(ty - 20, 10);
  });

  it('centerOn a point outside the board is limited by the pan limits', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    cam.centerOn(-50_000, -50_000);
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(visibleShare(cam, 'y')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });
});

describe('setViewport', () => {
  it('refits the board when it was fitted before the resize', () => {
    const cam = createCamera(400, 300);
    cam.setViewport(W, H);
    const { s, tx, ty } = cam.state();
    expect(s).toBeCloseTo(MIN_1280x800, 10);
    expect(tx).toBeCloseTo((W - BOARD_W * s) / 2, 8);
    expect(ty).toBeCloseTo((H - BOARD_H * s) / 2, 8);
    expect(cam.viewport()).toEqual({ w: W, h: H });
  });

  it('re-clamps the scale to the new limits, keeping the middle of the view in the middle', () => {
    const cam = createCamera(W, H);
    cam.fitSlot(C4);
    const t = tileRect(C4);
    cam.setViewport(640, 400); // the maximum drops from 8/3 to 4/3
    expect(cam.state().s).toBeCloseTo(4 / 3, 10);
    const mid = cam.toBoard(320, 200);
    expect(mid.x).toBeCloseTo(t.x + t.w / 2, 6);
    expect(mid.y).toBeCloseTo(t.y + t.h / 2, 6);
  });

  it('re-clamps the pan for the new viewport', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 6);
    cam.panBy(1e6, 0); // board pushed as far right as allowed for a 1280 px wide viewport
    cam.setViewport(500, H);
    expect(visibleShare(cam, 'x')).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('notifies listeners when the size changed, even if the camera did not move, and stays quiet otherwise', () => {
    const cam = createCamera(W, H);
    cam.zoomAt(W / 2, H / 2, 4);
    const before = cam.state();
    const fn = vi.fn();
    cam.onChange(fn);
    cam.setViewport(W + 20, H);
    expect(cam.state().s).toBe(before.s);
    expect(fn).toHaveBeenCalledTimes(1);
    cam.setViewport(W + 20, H);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm test -w web -- camera.test`
Expected: FAIL, `9 failed | 25 passed (34)`. The failures are the five pan-limit tests and the four `setViewport` tests (the version from Step 3 doesn't clamp the pan, and its `setViewport` only stores the size).

- [ ] **Step 7: Replace `web/src/board/camera.ts` with the version that clamps the pan and handles resizes**

This is the complete new file:

```ts
import { BOARD_H, BOARD_W } from '@class-board/shared/constants';
import { nearestSlot, tileRect } from '@class-board/shared/slots';
import type { Rect, SlotIndex } from '@class-board/shared/types';
import type { CameraApi, CameraState } from '../contracts';

/** Space kept around the board when it is fitted, in viewport px. */
export const FIT_MARGIN = 48;
/** Panning and zooming may never leave less than this share of the viewport (per axis) showing board. */
export const MIN_VISIBLE = 0.25;

export function createCamera(viewportW: number, viewportH: number): CameraApi {
  let vw = viewportW;
  let vh = viewportH;
  let s = 1;
  let tx = 0;
  let ty = 0;
  const listeners = new Set<(state: CameraState) => void>();

  const minScale = () => Math.max(0.01, Math.min((vw - 2 * FIT_MARGIN) / BOARD_W, (vh - 2 * FIT_MARGIN) / BOARD_H));
  // Every tile is the same size, so slot 0 stands in for all of them.
  const maxScaleForSlot = (slot: SlotIndex) => {
    const r = tileRect(slot);
    return Math.max(minScale(), Math.min(vw / r.w, vh / r.h));
  };
  const maxScale = () => maxScaleForSlot(0);

  /** Range of tx (or ty) that keeps at least `min(MIN_VISIBLE * viewport, board extent)` of the board on screen. */
  function panRange(viewport: number, boardExtent: number): [number, number] {
    const need = Math.min(MIN_VISIBLE * viewport, boardExtent * s);
    return [need - boardExtent * s, viewport - need];
  }

  function clampPan(): void {
    const [xLo, xHi] = panRange(vw, BOARD_W);
    const [yLo, yHi] = panRange(vh, BOARD_H);
    tx = Math.min(Math.max(tx, xLo), xHi);
    ty = Math.min(Math.max(ty, yLo), yHi);
  }

  const snapshot = (): CameraState => ({ s, tx, ty });

  function commit(before: CameraState, force = false): void {
    clampPan();
    if (!force && before.s === s && before.tx === tx && before.ty === ty) return;
    const state = snapshot();
    for (const fn of [...listeners]) fn({ ...state });
  }

  function setScaleAround(sx: number, sy: number, scale: number): void {
    const bx = (sx - tx) / s;
    const by = (sy - ty) / s;
    s = scale;
    tx = sx - bx * s;
    ty = sy - by * s;
  }

  function centerOnPoint(bx: number, by: number): void {
    tx = vw / 2 - bx * s;
    ty = vh / 2 - by * s;
  }

  function fitBoardState(): void {
    s = minScale();
    tx = (vw - BOARD_W * s) / 2;
    ty = (vh - BOARD_H * s) / 2;
  }

  fitBoardState();
  clampPan();

  const api: CameraApi = {
    state: snapshot,
    viewport: () => ({ w: vw, h: vh }),
    setViewport(w, h) {
      const before = snapshot();
      const changed = w !== vw || h !== vh;
      const wasFitted = Math.abs(s - minScale()) < 1e-9;
      const cx = (vw / 2 - tx) / s;
      const cy = (vh / 2 - ty) / s;
      vw = w;
      vh = h;
      if (wasFitted) {
        fitBoardState();
      } else {
        // The scale limits depend on the viewport; if the old scale is now out of range, keep the middle of the view fixed.
        const clamped = Math.min(Math.max(s, minScale()), maxScale());
        if (clamped !== s) {
          s = clamped;
          centerOnPoint(cx, cy);
        }
      }
      // Listeners always hear about a resized viewport, since what is on screen changed even if the camera did not.
      commit(before, changed);
    },
    minScale,
    maxScaleForSlot,
    toScreen: (bx, by) => ({ x: bx * s + tx, y: by * s + ty }),
    toBoard: (sx, sy) => ({ x: (sx - tx) / s, y: (sy - ty) / s }),
    zoomAt(sx, sy, factor) {
      const before = snapshot();
      const slot = nearestSlot((sx - tx) / s, (sy - ty) / s);
      const max = maxScale();
      const target = s * factor;
      setScaleAround(sx, sy, Math.min(Math.max(target, minScale()), max));
      commit(before);
      return { blockedIn: factor > 1 && target > max, slot };
    },
    panBy(dx, dy) {
      const before = snapshot();
      tx += dx;
      ty += dy;
      commit(before);
    },
    fitBoard() {
      const before = snapshot();
      fitBoardState();
      commit(before);
    },
    fitSlot(slot) {
      const before = snapshot();
      const r = tileRect(slot);
      s = maxScaleForSlot(slot);
      centerOnPoint(r.x + r.w / 2, r.y + r.h / 2);
      commit(before);
    },
    centerOn(bx, by) {
      const before = snapshot();
      centerOnPoint(bx, by);
      commit(before);
    },
    slotScreenRect(slot): Rect {
      const r = tileRect(slot);
      return { x: r.x * s + tx, y: r.y * s + ty, w: r.w * s, h: r.h * s };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return api;
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- camera.test`
Expected: PASS (34 tests).

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add web/src/board/camera.ts web/test/camera.test.ts
git commit -m "feat(web): camera with scale and pan limits (U2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U3: Socket and upload client

**Wave:** 2 · **Tier:** T2 (sonnet, medium) · **Depends on:** F2

**Files:**
- Create: `web/src/net/socket.ts`, `web/src/net/upload.ts`
- Test: `web/test/socket.test.ts`, `web/test/upload.test.ts`

Notes for the implementer:
- `connectBoard` accepts two optional test seams beyond the contract: `socketFactory` (replaces `new PartySocket(options)`) and `requestTimeoutMs`. The tests use both; production code passes neither.
- `hello()` is sent from the socket's `open` listener, before listeners hear that the status is `open`, so nothing can be sent ahead of it. The `maxEnqueuedMessages: 0` option stops PartySocket from flushing queued sends ahead of it after a reconnect.
- `upload.ts` builds its URL itself (server URL without trailing slashes, plus the path) instead of importing `serverHref` from U1, because U1 runs in the same wave. The file has no imports.

- [ ] **Step 1: Write the failing tests for the socket wrapper**

`web/test/socket.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartySocket, type PartySocketOptions } from 'partysocket';
import type { ClientMsg, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { SocketStatus } from '../src/contracts';
import { connectBoard, newReqId, ServerError, type SocketLike } from '../src/net/socket';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Array<(event: Event) => void>> = {};
  constructor(readonly options: PartySocketOptions) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  fire(type: 'open' | 'close' | 'error'): void {
    this.readyState = type === 'open' ? 1 : 3;
    for (const fn of this.handlers[type] ?? []) fn(new Event(type));
  }
  receive(data: unknown): void {
    const event = Object.assign(new Event('message'), { data });
    for (const fn of this.handlers.message ?? []) fn(event);
  }
  sentMessages(): ClientMsg[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMsg);
  }
}

const HELLO: ClientMsg = {
  type: 'hello',
  clientId: 'c1',
  profile: { name: 'Ana', color: '#D85A30', cursor: { kind: 'shape', shape: 'arrow' } },
};

function setup(overrides: { serverUrl?: string; board?: string; requestTimeoutMs?: number } = {}) {
  let fake!: FakeSocket;
  const hello = vi.fn(() => HELLO);
  const board = connectBoard({
    serverUrl: overrides.serverUrl ?? 'http://localhost:8787',
    board: overrides.board ?? 'main',
    hello,
    requestTimeoutMs: overrides.requestTimeoutMs,
    socketFactory: (options) => (fake = new FakeSocket(options)),
  });
  return { board, fake, hello };
}

const post = (reqId: string): RequestMsg => ({
  type: 'post', reqId, slot: 23, baseVersion: 0, content: { kind: 'link', url: 'https://example.com' }, label: 'Ana',
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('newReqId', () => {
  it('returns 12 lowercase base36 characters and does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newReqId));
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{12}$/);
    expect(ids.size).toBe(200);
  });
});

describe('connection options', () => {
  it('uses ws for http, party board and the board name as the room', () => {
    const { fake } = setup({ serverUrl: 'http://localhost:8787', board: 'week-3' });
    expect(fake.options).toMatchObject({ host: 'localhost:8787', protocol: 'ws', party: 'board', room: 'week-3' });
  });

  it('uses wss for https', () => {
    const { fake } = setup({ serverUrl: 'https://class-board.example.workers.dev' });
    expect(fake.options).toMatchObject({ host: 'class-board.example.workers.dev', protocol: 'wss' });
  });

  it('builds the /parties/board/<board> url that PartyServer routes', () => {
    const { fake } = setup({ serverUrl: 'https://class-board.example.workers.dev', board: 'main' });
    const real = new PartySocket({ ...fake.options, startClosed: true });
    expect(real.roomUrl).toBe('wss://class-board.example.workers.dev/parties/board/main');
    const local = new PartySocket({ ...setup().fake.options, startClosed: true });
    expect(local.roomUrl).toBe('ws://localhost:8787/parties/board/main');
  });

  it('does not let PartySocket queue messages while disconnected', () => {
    expect(setup().fake.options.maxEnqueuedMessages).toBe(0);
  });
});

describe('status and hello', () => {
  it('starts connecting, then follows open and close', () => {
    const { board, fake } = setup();
    const seen: SocketStatus[] = [];
    board.onStatus((s) => seen.push(s));
    expect(board.status()).toBe('connecting');
    fake.fire('open');
    expect(board.status()).toBe('open');
    fake.fire('close');
    expect(board.status()).toBe('closed');
    expect(seen).toEqual(['open', 'closed']);
  });

  it('sends hello() as the first message on every open, before listeners hear about the open', () => {
    const { board, fake, hello } = setup();
    const sentWhenNotified: number[] = [];
    board.onStatus((s) => {
      if (s === 'open') sentWhenNotified.push(fake.sent.length);
    });
    fake.fire('open');
    expect(fake.sentMessages()).toEqual([HELLO]);
    expect(sentWhenNotified).toEqual([1]);
    fake.fire('close');
    fake.fire('open');
    expect(hello).toHaveBeenCalledTimes(2);
    expect(fake.sentMessages()).toEqual([HELLO, HELLO]);
  });

  it('reports each status change once', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onStatus(fn);
    fake.fire('close');
    fake.fire('close');
    fake.fire('open');
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['closed', 'open']);
  });

  it('stops notifying after unsubscribe', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    const off = board.onStatus(fn);
    off();
    fake.fire('open');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('sends JSON while open and drops messages otherwise', () => {
    const { board, fake } = setup();
    board.send({ type: 'away' });
    expect(fake.sent).toHaveLength(0);
    fake.fire('open');
    board.send({ type: 'cursor', x: 10, y: 20 });
    expect(fake.sentMessages()).toEqual([HELLO, { type: 'cursor', x: 10, y: 20 }]);
    fake.fire('close');
    board.send({ type: 'away' });
    expect(fake.sent).toHaveLength(2);
  });
});

describe('incoming messages', () => {
  it('delivers JSON objects that have a string type', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onMessage(fn);
    const msg: ServerMsg = { type: 'locked', locked: true };
    fake.receive(JSON.stringify(msg));
    expect(fn).toHaveBeenCalledWith(msg);
  });

  it('ignores anything else', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onMessage(fn);
    fake.receive('not json');
    fake.receive('null');
    fake.receive('42');
    fake.receive('"locked"');
    fake.receive('[{"type":"locked"}]');
    fake.receive('{"locked":true}');
    fake.receive('{"type":7}');
    fake.receive(new ArrayBuffer(8));
    fake.receive(undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps delivering when one listener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { board, fake } = setup();
    const after = vi.fn();
    board.onMessage(() => {
      throw new Error('boom');
    });
    board.onMessage(after);
    fake.receive('{"type":"rate","hz":2}');
    expect(after).toHaveBeenCalledWith({ type: 'rate', hz: 2 });
  });

  it('stops delivering after unsubscribe', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    const off = board.onMessage(fn);
    off();
    fake.receive('{"type":"rate","hz":2}');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  it('sends the message and resolves with the reply that has the same reqId', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('abc'));
    expect(fake.sentMessages()[1]).toMatchObject({ type: 'post', reqId: 'abc' });
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'other' }));
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'abc' }));
    await expect(promise).resolves.toEqual({ type: 'ok', reqId: 'abc' });
  });

  it('resolves history requests with the historyResult', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request({ type: 'history', reqId: 'h1', slot: 3 });
    fake.receive(JSON.stringify({ type: 'historyResult', reqId: 'h1', slot: 3, versions: [] }));
    await expect(promise).resolves.toEqual({ type: 'historyResult', reqId: 'h1', slot: 3, versions: [] });
  });

  it('rejects with a ServerError carrying the code of an error reply', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('abc'));
    fake.receive(JSON.stringify({ type: 'error', reqId: 'abc', code: 'conflict', message: 'stale' }));
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'conflict', message: 'stale' });
  });

  it('answers concurrent requests independently', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const a = board.request(post('a'));
    const b = board.request(post('b'));
    fake.receive(JSON.stringify({ type: 'error', reqId: 'b', code: 'locked', message: 'no' }));
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'a' }));
    await expect(a).resolves.toEqual({ type: 'ok', reqId: 'a' });
    await expect(b).rejects.toMatchObject({ code: 'locked' });
  });

  it('still passes replies and errors on to onMessage listeners', () => {
    const { board, fake } = setup();
    fake.fire('open');
    const fn = vi.fn();
    board.onMessage(fn);
    void board.request(post('abc')).catch(() => {});
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'abc' }));
    fake.receive(JSON.stringify({ type: 'error', reqId: null, code: 'not_ready', message: 'hello first' }));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects with not_ready after 10 seconds without a reply', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('slow'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    await vi.advanceTimersByTimeAsync(9_999);
    fake.receive(JSON.stringify({ type: 'rate', hz: 5 }));
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(ServerError);
  });

  it('ignores a reply that arrives after the timeout', async () => {
    const { board, fake } = setup({ requestTimeoutMs: 50 });
    fake.fire('open');
    const promise = board.request(post('late'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(() => fake.receive(JSON.stringify({ type: 'ok', reqId: 'late' }))).not.toThrow();
  });

  it('rejects at once with not_ready while the socket is not open, without sending', async () => {
    const { board, fake } = setup();
    await expect(board.request(post('x'))).rejects.toMatchObject({ code: 'not_ready' });
    expect(fake.sent).toHaveLength(0);
  });

  it('rejects requests still waiting when the connection closes', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('x'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    fake.fire('close');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('close', () => {
  it('closes the socket, reports closed, rejects pending requests and ignores later events', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const status = vi.fn();
    const messages = vi.fn();
    board.onStatus(status);
    board.onMessage(messages);
    const promise = board.request(post('x'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    board.close();
    await assertion;
    expect(fake.closed).toBe(true);
    expect(board.status()).toBe('closed');
    expect(status).toHaveBeenCalledWith('closed');
    fake.fire('open');
    fake.receive('{"type":"rate","hz":5}');
    expect(board.status()).toBe('closed');
    expect(messages).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(2); // hello and the request
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- socket.test`
Expected: FAIL, `Failed to resolve import "../src/net/socket" from "web/test/socket.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `web/src/net/socket.ts`**

```ts
import { PartySocket, type PartySocketOptions } from 'partysocket';
import type { ClientMsg, ErrorCode, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { BoardSocket, ServerErrorLike, SocketStatus } from '../contracts';

export const REQUEST_TIMEOUT_MS = 10_000;

export class ServerError extends Error implements ServerErrorLike {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

/** 12 random base36 characters. */
export function newReqId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
}

/** The part of a WebSocket that connectBoard uses. PartySocket satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message' | 'error', listener: (event: Event) => void): void;
}

export interface ConnectOptions {
  serverUrl: string;
  board: string;
  /** Called on every (re)open; the result is sent as the first message. */
  hello: () => ClientMsg;
  /** Test seam: replaces `new PartySocket(options)`. */
  socketFactory?: (options: PartySocketOptions) => SocketLike;
  /** Test seam: how long request() waits for a reply. */
  requestTimeoutMs?: number;
}

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: ServerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseServerMessage(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return typeof (value as { type?: unknown }).type === 'string' ? (value as ServerMsg) : null;
}

export function connectBoard(opts: ConnectOptions): BoardSocket {
  const url = new URL(opts.serverUrl);
  const options: PartySocketOptions = {
    host: url.host,
    protocol: url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss' : 'ws',
    party: 'board',
    room: opts.board,
    // PartySocket queues sends made while disconnected and flushes them on reconnect, ahead of our hello.
    maxEnqueuedMessages: 0,
  };
  const socket: SocketLike = opts.socketFactory ? opts.socketFactory(options) : new PartySocket(options);
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  let current: SocketStatus = 'connecting';
  let closedByUs = false;
  const messageListeners = new Set<(msg: ServerMsg) => void>();
  const statusListeners = new Set<(status: SocketStatus) => void>();
  const pending = new Map<string, Pending>();

  function setStatus(next: SocketStatus): void {
    if (next === current) return;
    current = next;
    for (const fn of [...statusListeners]) fn(next);
  }

  function rejectAll(message: string): void {
    for (const [reqId, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(new ServerError('not_ready', message));
    }
  }

  function settle(msg: ServerMsg): void {
    if (msg.type !== 'ok' && msg.type !== 'historyResult' && msg.type !== 'error') return;
    if (msg.reqId === null) return;
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(new ServerError(msg.code, msg.message));
    else p.resolve(msg);
  }

  socket.addEventListener('open', () => {
    if (closedByUs) return;
    // hello goes out before anyone hears the socket is open, so nothing can be sent ahead of it.
    socket.send(JSON.stringify(opts.hello()));
    setStatus('open');
  });
  socket.addEventListener('close', () => {
    if (closedByUs) return;
    setStatus('closed');
    rejectAll('Lost the connection to the board. Try again once it is back.');
  });
  socket.addEventListener('message', (event) => {
    if (closedByUs) return;
    const msg = parseServerMessage((event as MessageEvent).data);
    if (!msg) return;
    settle(msg);
    for (const fn of [...messageListeners]) {
      try {
        fn(msg);
      } catch (err) {
        console.error('Message listener threw', err);
      }
    }
  });

  return {
    send(msg) {
      if (current === 'open') socket.send(JSON.stringify(msg));
    },
    request(msg: RequestMsg) {
      return new Promise<Reply>((resolve, reject) => {
        if (current !== 'open') {
          reject(new ServerError('not_ready', 'The board is not connected. Try again once it is back.'));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(msg.reqId);
          reject(new ServerError('not_ready', 'The board did not answer. Try again.'));
        }, timeoutMs);
        pending.set(msg.reqId, { resolve, reject, timer });
        socket.send(JSON.stringify(msg));
      });
    },
    onMessage(fn) {
      messageListeners.add(fn);
      return () => {
        messageListeners.delete(fn);
      };
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    status: () => current,
    close() {
      if (closedByUs) return;
      socket.close();
      closedByUs = true;
      setStatus('closed');
      rejectAll('The connection to the board was closed.');
    },
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- socket.test`
Expected: PASS (24 tests).

- [ ] **Step 5: Write the failing tests for the upload client**

`web/test/upload.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadError, uploadHtml } from '../src/net/upload';

const SERVER = 'http://localhost:8787';

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('uploadHtml', () => {
  it('POSTs the blob to /boards/<board>/files with the html headers and returns the fileId', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'a'.repeat(32) }));
    const blob = new Blob(['<p>hi</p>'], { type: 'text/html' });
    const id = await uploadHtml(SERVER, 'week-3', blob, 'My page.html');
    expect(id).toBe('a'.repeat(32));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/boards/week-3/files');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect(init.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'X-File-Name': encodeURIComponent('My page.html'),
    });
  });

  it('percent-encodes file names so the header stays ASCII', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'f' }));
    await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'café ☕.html');
    const headers = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-File-Name']).toBe('caf%C3%A9%20%E2%98%95.html');
    expect(headers['X-File-Name']).toMatch(/^[\x20-\x7e]+$/);
  });

  it('copes with a trailing slash on the server url', async () => {
    const fetchFn = stubFetch(() => jsonResponse({ fileId: 'f' }));
    await uploadHtml('https://board.example.workers.dev/', 'main', new Blob(['<p>']), 'a.html');
    expect(fetchFn.mock.calls[0]![0]).toBe('https://board.example.workers.dev/boards/main/files');
  });

  it.each([
    [413, 'too_large'],
    [400, 'invalid'],
    [429, 'rate_limited'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    stubFetch(() => jsonResponse({ error: code }, status));
    const error = await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toBeInstanceOf(Error);
    expect((error as UploadError).code).toBe(code);
  });

  it.each([403, 500, 502])('maps HTTP %i to network', async (status) => {
    stubFetch(() => jsonResponse({ error: 'x' }, status));
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a fetch failure to network', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a success reply without a usable fileId to network', async () => {
    for (const body of [{}, { fileId: 7 }, { fileId: '' }, null]) {
      stubFetch(() => jsonResponse(body));
      await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
    }
    stubFetch(() => new Response('<html>', { status: 200 }));
    await expect(uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html')).rejects.toMatchObject({ code: 'network' });
  });

  it('gives every failure a message that says what to do', async () => {
    for (const [status, text] of [[413, /smaller/], [400, /\.html/], [429, /wait/i], [500, /try again/i]] as const) {
      stubFetch(() => jsonResponse({}, status));
      const error = (await uploadHtml(SERVER, 'main', new Blob(['<p>']), 'a.html').catch((e: unknown) => e)) as UploadError;
      expect(error.message).toMatch(text);
    }
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test -w web -- upload.test`
Expected: FAIL, `Failed to resolve import "../src/net/upload" from "web/test/upload.test.ts". Does the file exist?`

- [ ] **Step 7: Implement `web/src/net/upload.ts`**

```ts
export type UploadErrorCode = 'too_large' | 'invalid' | 'rate_limited' | 'network';

const MESSAGES: Record<UploadErrorCode, string> = {
  too_large: 'That file is over 1 MB. Choose a smaller HTML file.',
  invalid: "That isn't an HTML file the board can use. Choose an .html file and try again.",
  rate_limited: 'Too many uploads. Wait a minute and try again.',
  network: "The upload didn't go through. Check your connection and try again.",
};

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode) {
    super(MESSAGES[code]);
    this.name = 'UploadError';
    this.code = code;
  }
}

/** Uploads one HTML file and resolves with its file id. */
export async function uploadHtml(serverUrl: string, board: string, html: Blob, fileName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, '')}/boards/${board}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-File-Name': encodeURIComponent(fileName),
      },
      body: html,
    });
  } catch {
    throw new UploadError('network');
  }
  if (res.status === 413) throw new UploadError('too_large');
  if (res.status === 400) throw new UploadError('invalid');
  if (res.status === 429) throw new UploadError('rate_limited');
  // Any other failure (403 origin, 5xx) is not something the student can fix by changing the file.
  if (!res.ok) throw new UploadError('network');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UploadError('network');
  }
  const fileId = (body as { fileId?: unknown } | null)?.fileId;
  if (typeof fileId !== 'string' || fileId === '') throw new UploadError('network');
  return fileId;
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- upload.test`
Expected: PASS (12 tests).

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add web/src/net/socket.ts web/src/net/upload.ts web/test/socket.test.ts web/test/upload.test.ts
git commit -m "feat(web): PartySocket wrapper and HTML upload client (U3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U4: Board state

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F2

**Files:**
- Create: `web/src/state/boardState.ts`
- Test: `web/test/boardState.test.ts`

Behavior, per `ServerMsg` type:

| Message | Effect | Events |
|---|---|---|
| `snapshot` | Replaces tiles (placed by `view.slot`, gaps filled with placeholders), people, `you`, `locked` and `rate`, and sets `ready`. | `locked`, `rate`, `people`, then `snapshot` |
| `tile` | Replaces one tile. A slot outside 0..79 is ignored. | `tile` |
| `person` (`joined` or `updated`) | Upserts by `id`, keeping the order of existing people. | `people` |
| `personLeft` | Removes the person; an unknown id does nothing. | `people` |
| `locked` | Sets `locked`. | `locked` |
| `rate` | Sets the rate. | `rate` |
| `cursors` | Stores nothing. | `cursors` with the moves |
| `ok`, `historyResult`, `error` | Ignored (the socket settles requests). | none |

A snapshot also emits `locked`, `rate` and `people` (before `snapshot`) although the contract only lists the `snapshot` event for it. Listeners of the narrow events need it: after a reconnect the snapshot can change the lock, the cursor rate and the people count with no other message, and the banners and the top bar would go stale. `snapshot` goes last so every listener reads a fully updated state.

`boardState.ts` contains its own ten-line listener map instead of importing `createEmitter` from U1, because U1 runs in the same wave. A listener that throws is logged and doesn't stop the others.

Before the first snapshot `tile(slot)` returns an empty placeholder (version 0, kind `empty`, label `''`, embeddable `no`, every nullable field null). The `tiles()` and `people()` arrays are replaced, never mutated.

- [ ] **Step 1: Write the failing tests**

`web/test/boardState.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { CursorMove, Person, ServerMsg, TileView } from '@class-board/shared/types';
import { createBoardState } from '../src/state/boardState';

const tileView = (slot: number, over: Partial<TileView> = {}): TileView => ({
  slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
  icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null, ...over,
});

const person = (id: string, name = id, at: Person['presence'] = { at: 'board' }): Person => ({
  id, clientId: `client-${id}`, profile: { name, color: '#D85A30', cursor: { kind: 'shape', shape: 'arrow' } }, presence: at,
});

function snapshot(over: Partial<Extract<ServerMsg, { type: 'snapshot' }>> = {}): ServerMsg {
  return {
    type: 'snapshot', board: 'main', you: 'a',
    tiles: Array.from({ length: SLOT_COUNT }, (_, slot) => tileView(slot)),
    locked: false, people: [person('a', 'Ana')], rate: 5, ...over,
  };
}

describe('before the first snapshot', () => {
  it('is not ready and reports empty placeholders', () => {
    const state = createBoardState('week-3');
    expect(state.board()).toBe('week-3');
    expect(state.ready()).toBe(false);
    expect(state.you()).toBeNull();
    expect(state.locked()).toBe(false);
    expect(state.rate()).toBe(5);
    expect(state.people()).toEqual([]);
    expect(state.me()).toBeUndefined();
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(state.tile(23)).toEqual({
      slot: 23, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
      icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
    });
  });

  it('returns a placeholder for a slot outside the board instead of throwing', () => {
    expect(createBoardState('main').tile(500).kind).toBe('empty');
  });
});

describe('snapshot', () => {
  it('replaces tiles, people, you, locked and rate, and sets ready', () => {
    const state = createBoardState('main');
    const posted = tileView(23, { version: 7, kind: 'link', label: 'Maya', url: 'https://example.com', embeddable: 'yes' });
    state.apply(snapshot({
      tiles: Array.from({ length: SLOT_COUNT }, (_, s) => (s === 23 ? posted : tileView(s))),
      locked: true, rate: 2, you: 'b', people: [person('a', 'Ana'), person('b', 'Ben')],
    }));
    expect(state.ready()).toBe(true);
    expect(state.tile(23)).toEqual(posted);
    expect(state.locked()).toBe(true);
    expect(state.rate()).toBe(2);
    expect(state.you()).toBe('b');
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b']);
    expect(state.me()?.profile.name).toBe('Ben');
    expect(state.person('a')?.profile.name).toBe('Ana');
    expect(state.person('zzz')).toBeUndefined();
  });

  it('places each tile by its slot even if the list arrives out of order or incomplete', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ tiles: [tileView(5, { version: 2 }), tileView(1, { version: 9 })] }));
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(state.tile(1).version).toBe(9);
    expect(state.tile(5).version).toBe(2);
    expect(state.tile(0).version).toBe(0);
  });

  it('replaces the previous state completely, as after a reconnect', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ locked: true, rate: 0, people: [person('a'), person('b')] }));
    state.apply({ type: 'tile', view: tileView(3, { version: 4, kind: 'html', label: 'x' }) });
    state.apply(snapshot({ locked: false, rate: 5, people: [person('a')] }));
    expect(state.locked()).toBe(false);
    expect(state.rate()).toBe(5);
    expect(state.people()).toHaveLength(1);
    expect(state.tile(3).version).toBe(0);
  });

  it('emits locked, rate, people and finally snapshot, with the new state already readable', () => {
    const state = createBoardState('main');
    const order: string[] = [];
    state.on('locked', (v) => order.push(`locked:${v}:${state.locked()}`));
    state.on('rate', (v) => order.push(`rate:${v}:${state.rate()}`));
    state.on('people', () => order.push(`people:${state.people().length}`));
    state.on('snapshot', () => order.push(`snapshot:${state.ready()}`));
    state.apply(snapshot({ locked: true, rate: 2 }));
    expect(order).toEqual(['locked:true:true', 'rate:2:2', 'people:1', 'snapshot:true']);
  });
});

describe('tile', () => {
  it('replaces one tile, leaves the others, and emits the view', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const before = state.tiles();
    const seen = vi.fn();
    state.on('tile', seen);
    const view = tileView(23, { version: 3, kind: 'link', label: 'Maya', embeddable: 'pending' });
    state.apply({ type: 'tile', view });
    expect(state.tile(23)).toEqual(view);
    expect(state.tile(22)).toBe(before[22]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(view);
    expect(state.tiles()).not.toBe(before);
    expect(before[23]!.version).toBe(0);
  });

  it('ignores a tile for a slot that does not exist', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('tile', seen);
    state.apply({ type: 'tile', view: tileView(80, { version: 1 }) });
    state.apply({ type: 'tile', view: tileView(-1, { version: 1 }) });
    expect(state.tiles()).toHaveLength(SLOT_COUNT);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('people', () => {
  it('adds a joined person and emits people', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const seen = vi.fn();
    state.on('people', seen);
    state.apply({ type: 'person', event: 'joined', person: person('b', 'Ben') });
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b']);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('replaces an updated person in place, keeping the order', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ people: [person('a', 'Ana'), person('b', 'Ben'), person('c', 'Cy')] }));
    state.apply({ type: 'person', event: 'updated', person: person('b', 'Benjamin', { at: 'tile', slot: 4, mode: 'using' }) });
    expect(state.people().map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(state.person('b')?.profile.name).toBe('Benjamin');
    expect(state.person('b')?.presence).toEqual({ at: 'tile', slot: 4, mode: 'using' });
  });

  it('adds an updated person it has not seen, so a missed join heals itself', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    state.apply({ type: 'person', event: 'updated', person: person('z', 'Zed') });
    expect(state.person('z')?.profile.name).toBe('Zed');
  });

  it('removes a person who left and emits people; an unknown id does nothing', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ people: [person('a'), person('b')] }));
    const seen = vi.fn();
    state.on('people', seen);
    state.apply({ type: 'personLeft', id: 'b' });
    expect(state.people().map((p) => p.id)).toEqual(['a']);
    expect(seen).toHaveBeenCalledTimes(1);
    state.apply({ type: 'personLeft', id: 'nobody' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('me() follows the updated profile of your own connection', () => {
    const state = createBoardState('main');
    state.apply(snapshot({ you: 'a', people: [person('a', 'Ana')] }));
    state.apply({ type: 'person', event: 'updated', person: person('a', 'Ana Reset') });
    expect(state.me()?.profile.name).toBe('Ana Reset');
  });
});

describe('locked and rate', () => {
  it('sets locked and emits it', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('locked', seen);
    state.apply({ type: 'locked', locked: true });
    expect(state.locked()).toBe(true);
    state.apply({ type: 'locked', locked: false });
    expect(state.locked()).toBe(false);
    expect(seen.mock.calls).toEqual([[true], [false]]);
  });

  it('sets the cursor rate and emits it', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    state.on('rate', seen);
    state.apply({ type: 'rate', hz: 0 });
    expect(state.rate()).toBe(0);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(0);
  });
});

describe('cursors', () => {
  it('only emits the moves; positions are not stored', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const moves: CursorMove[] = [['a', 10, 20], ['b', 30, 40]];
    const seen = vi.fn();
    state.on('cursors', seen);
    state.apply({ type: 'cursors', moves });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(moves);
    expect(state.people()).toHaveLength(1);
    expect(Object.keys(state.person('a')!).sort()).toEqual(['clientId', 'id', 'presence', 'profile']);
  });
});

describe('messages the socket handles', () => {
  it('ignores ok, historyResult and error without changing anything or emitting', () => {
    const state = createBoardState('main');
    state.apply(snapshot());
    const seen = vi.fn();
    for (const event of ['snapshot', 'tile', 'people', 'locked', 'rate', 'cursors'] as const) state.on(event, seen);
    const tiles = state.tiles();
    state.apply({ type: 'ok', reqId: 'r1' });
    state.apply({ type: 'historyResult', reqId: 'r2', slot: 3, versions: [] });
    state.apply({ type: 'error', reqId: 'r3', code: 'conflict', message: 'stale' });
    expect(seen).not.toHaveBeenCalled();
    expect(state.tiles()).toBe(tiles);
  });
});

describe('subscriptions', () => {
  it('on() returns an unsubscribe function', () => {
    const state = createBoardState('main');
    const seen = vi.fn();
    const off = state.on('locked', seen);
    state.apply({ type: 'locked', locked: true });
    off();
    state.apply({ type: 'locked', locked: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the other listeners when one throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createBoardState('main');
    const after = vi.fn();
    state.on('rate', () => {
      throw new Error('boom');
    });
    state.on('rate', after);
    state.apply({ type: 'rate', hz: 2 });
    expect(after).toHaveBeenCalledWith(2);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- boardState.test`
Expected: FAIL, `Failed to resolve import "../src/state/boardState" from "web/test/boardState.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `web/src/state/boardState.ts`**

```ts
import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Person, ServerMsg, SlotIndex, TileView } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents } from '../contracts';

function placeholder(slot: SlotIndex): TileView {
  return {
    slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

const isSlot = (n: unknown): n is SlotIndex => Number.isInteger(n) && (n as number) >= 0 && (n as number) < SLOT_COUNT;

export function createBoardState(board: string): BoardStateApi {
  // A small emitter of its own: this task runs in the same wave as the one that writes util/emitter.ts.
  const listeners = new Map<keyof BoardStateEvents, Set<(payload: never) => void>>();
  const events = {
    on<K extends keyof BoardStateEvents>(event: K, fn: (payload: BoardStateEvents[K]) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit<K extends keyof BoardStateEvents>(
      event: K,
      ...payload: undefined extends BoardStateEvents[K] ? [payload?: BoardStateEvents[K]] : [payload: BoardStateEvents[K]]
    ): void {
      // Copy first: a listener may unsubscribe while we iterate.
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          (fn as (p: unknown) => void)(payload[0]);
        } catch (err) {
          console.error(`Listener for "${event}" threw`, err);
        }
      }
    },
  };
  // Arrays are replaced, never mutated, so callers can compare references to detect a change.
  let tiles: readonly TileView[] = Array.from({ length: SLOT_COUNT }, (_, slot) => placeholder(slot));
  let people: readonly Person[] = [];
  let you: string | null = null;
  let locked = false;
  let rate = 5;
  let ready = false;

  const api: BoardStateApi = {
    board: () => board,
    you: () => you,
    locked: () => locked,
    rate: () => rate,
    ready: () => ready,
    tiles: () => tiles,
    tile: (slot) => tiles[slot] ?? placeholder(slot),
    people: () => people,
    person: (id) => people.find((p) => p.id === id),
    me: () => (you === null ? undefined : people.find((p) => p.id === you)),
    on: events.on,
    apply(msg: ServerMsg) {
      switch (msg.type) {
        case 'snapshot': {
          const next = Array.from({ length: SLOT_COUNT }, (_, slot) => placeholder(slot));
          for (const view of msg.tiles) if (isSlot(view.slot)) next[view.slot] = view;
          tiles = next;
          people = [...msg.people];
          you = msg.you;
          locked = msg.locked;
          rate = msg.rate;
          ready = true;
          // A reconnect snapshot can change any of these, so listeners of the narrower events hear about it too.
          // 'snapshot' goes last, once every listener can read a consistent state.
          events.emit('locked', locked);
          events.emit('rate', rate);
          events.emit('people');
          events.emit('snapshot');
          break;
        }
        case 'tile': {
          if (!isSlot(msg.view.slot)) break;
          const next = tiles.slice();
          next[msg.view.slot] = msg.view;
          tiles = next;
          events.emit('tile', msg.view);
          break;
        }
        case 'person': {
          const i = people.findIndex((p) => p.id === msg.person.id);
          if (i === -1) people = [...people, msg.person];
          else people = people.map((p, j) => (j === i ? msg.person : p));
          events.emit('people');
          break;
        }
        case 'personLeft': {
          if (!people.some((p) => p.id === msg.id)) break;
          people = people.filter((p) => p.id !== msg.id);
          events.emit('people');
          break;
        }
        case 'locked':
          locked = msg.locked;
          events.emit('locked', locked);
          break;
        case 'rate':
          rate = msg.hz;
          events.emit('rate', rate);
          break;
        case 'cursors':
          events.emit('cursors', msg.moves);
          break;
        // ok, historyResult and error answer requests; the socket settles those.
        default:
          break;
      }
    },
  };
  return api;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- boardState.test`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add web/src/state/boardState.ts web/test/boardState.test.ts
git commit -m "feat(web): board state applies every server message (U4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task U7: Config, top bar and help

**Wave:** 3 · **Tier:** T0 (haiku) · **Depends on:** F2, U1 (`h`, `clear`, `openModal`)

**Files:**
- Create: `web/src/config.ts`, `web/src/ui/topBar.ts`, `web/src/ui/topbar.css`, `web/src/ui/help.ts`
- Test: `web/test/topBar.test.ts`

Notes for the implementer:
- This task's file list has one test file, so the tests for `config.ts` and `help.ts` live in `web/test/topBar.test.ts` too. It grows over the steps below.
- `config.ts` exports the pure helpers `resolveBoard(search)` and `resolveServerUrl(raw)` next to the constants, so the parsing can be tested without loading the module under different URLs. It also exports `DEFAULT_SERVER_URL`. `resolveServerUrl` treats an unset or blank variable as unset: the Pages workflow passes `VITE_SERVER_URL` from a repository variable that may be empty.
- `topbar.css` uses the `base.css` variables (`--z-topbar`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--radius`, `--font`), which U6 defines. The bar gets the class `.topbar` when mounted, and its CSS is written against that class, so it doesn't depend on how U6 lays out `#app`. The help dialog's styles are in the same file.
- The zoom label starts at `100%` until `setZoom` is called.

- [ ] **Step 1: Write the failing tests for the config module**

`web/test/topBar.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVER_URL, resolveBoard, resolveServerUrl } from '../src/config';

describe('resolveBoard', () => {
  it('returns the default board without a query string', () => {
    expect(resolveBoard('')).toBe('main');
    expect(resolveBoard('?other=1')).toBe('main');
  });

  it('accepts a valid board name', () => {
    expect(resolveBoard('?board=week-3')).toBe('week-3');
    expect(resolveBoard('?x=1&board=a')).toBe('a');
    expect(resolveBoard('?board=' + 'a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('falls back to the default for names the server would reject', () => {
    expect(resolveBoard('?board=')).toBe('main');
    expect(resolveBoard('?board=Week3')).toBe('main');
    expect(resolveBoard('?board=week_3')).toBe('main');
    expect(resolveBoard('?board=' + 'a'.repeat(41))).toBe('main');
    expect(resolveBoard('?board=../etc')).toBe('main');
    expect(resolveBoard('?board=a%20b')).toBe('main');
  });
});

describe('resolveServerUrl', () => {
  it('uses the local dev server when the variable is unset or blank', () => {
    expect(DEFAULT_SERVER_URL).toBe('http://localhost:8787');
    expect(resolveServerUrl(undefined)).toBe('http://localhost:8787');
    expect(resolveServerUrl('')).toBe('http://localhost:8787');
    expect(resolveServerUrl('   ')).toBe('http://localhost:8787');
  });

  it('keeps a configured URL and drops trailing slashes', () => {
    expect(resolveServerUrl('https://board.example.workers.dev')).toBe('https://board.example.workers.dev');
    expect(resolveServerUrl(' https://board.example.workers.dev/ ')).toBe('https://board.example.workers.dev');
  });
});

describe('module constants', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    window.history.replaceState(null, '', '/');
  });

  it('reads VITE_SERVER_URL, ?board= and the page origin when the module loads', async () => {
    vi.stubEnv('VITE_SERVER_URL', 'https://board.example.workers.dev/');
    window.history.replaceState(null, '', '/class-board/?board=week-3');
    vi.resetModules();
    const config = await import('../src/config');
    expect(config.SERVER_URL).toBe('https://board.example.workers.dev');
    expect(config.BOARD).toBe('week-3');
    expect(config.BOARD_ORIGIN).toBe(window.location.origin);
    expect(typeof config.IS_DEV).toBe('boolean');
  });

  it('uses the defaults when nothing is configured', async () => {
    vi.stubEnv('VITE_SERVER_URL', '');
    vi.resetModules();
    const config = await import('../src/config');
    expect(config.SERVER_URL).toBe('http://localhost:8787');
    expect(config.BOARD).toBe('main');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w web -- topBar.test`
Expected: FAIL, `Failed to resolve import "../src/config" from "web/test/topBar.test.ts". Does the file exist?`

- [ ] **Step 3: Implement `web/src/config.ts`**

```ts
import { BOARD_NAME_RE, DEFAULT_BOARD } from '@class-board/shared/constants';

export const DEFAULT_SERVER_URL = 'http://localhost:8787';

/** The board named by `?board=`, or the default board when it is missing or not a valid name. */
export function resolveBoard(search: string): string {
  const name = new URLSearchParams(search).get('board');
  return name !== null && BOARD_NAME_RE.test(name) ? name : DEFAULT_BOARD;
}

/** The Worker's base URL without a trailing slash. An unset or blank variable falls back to the local dev server. */
export function resolveServerUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return (value === '' ? DEFAULT_SERVER_URL : value).replace(/\/+$/, '');
}

export const SERVER_URL: string = resolveServerUrl(import.meta.env.VITE_SERVER_URL);
export const BOARD: string = resolveBoard(location.search);
export const BOARD_ORIGIN: string = location.origin;
export const IS_DEV: boolean = import.meta.env.DEV;
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -w web -- topBar.test`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the failing tests for the top bar**

In `web/test/topBar.test.ts`, replace the two import lines at the top with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TopBarHandlers } from '../src/contracts';
import { DEFAULT_SERVER_URL, resolveBoard, resolveServerUrl } from '../src/config';
import { mountTopBar } from '../src/ui/topBar';
```

Then append this to the end of the file:

```ts
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function handlers(): TopBarHandlers {
  return { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn(), profile: vi.fn(), help: vi.fn() };
}

function mount(h: TopBarHandlers = handlers()) {
  document.body.innerHTML = '<header id="topbar"></header>';
  const el = q('#topbar');
  return { el, h, bar: mountTopBar(el, h) };
}

describe('mountTopBar', () => {
  it('renders every control the e2e tests look for', () => {
    mount();
    for (const action of ['zoom-out', 'zoom-in', 'fit', 'people', 'profile', 'help']) {
      expect(document.querySelectorAll(`#topbar button[data-action="${action}"]`), action).toHaveLength(1);
    }
    for (const role of ['zoom', 'people-count', 'board-name', 'teacher-badge']) {
      expect(document.querySelectorAll(`#topbar [data-role="${role}"]`), role).toHaveLength(1);
    }
  });

  it('calls the matching handler for each button', () => {
    const { h } = mount();
    q('[data-action="zoom-in"]').click();
    q('[data-action="zoom-out"]').click();
    q('[data-action="zoom-out"]').click();
    q('[data-action="fit"]').click();
    q('[data-action="profile"]').click();
    q('[data-action="help"]').click();
    expect(h.zoomIn).toHaveBeenCalledTimes(1);
    expect(h.zoomOut).toHaveBeenCalledTimes(2);
    expect(h.fit).toHaveBeenCalledTimes(1);
    expect(h.profile).toHaveBeenCalledTimes(1);
    expect(h.help).toHaveBeenCalledTimes(1);
  });

  it('gives icon-only buttons an accessible name and makes every button a plain button', () => {
    mount();
    expect(q('[data-action="zoom-in"]').getAttribute('aria-label')).toBe('Zoom in');
    expect(q('[data-action="zoom-out"]').getAttribute('aria-label')).toBe('Zoom out');
    expect(q('[data-action="help"]').getAttribute('aria-label')).toBe('Help');
    for (const b of document.querySelectorAll<HTMLButtonElement>('#topbar button')) expect(b.type).toBe('button');
  });

  it('shows the zoom as a rounded percentage', () => {
    const { bar } = mount();
    bar.setZoom(1);
    expect(q('[data-role="zoom"]').textContent).toBe('100%');
    bar.setZoom(0.2263);
    expect(q('[data-role="zoom"]').textContent).toBe('23%');
    bar.setZoom(2.666);
    expect(q('[data-role="zoom"]').textContent).toBe('267%');
  });

  it('shows the board name', () => {
    const { bar } = mount();
    bar.setBoardName('week-3');
    expect(q('[data-role="board-name"]').textContent).toBe('week-3');
  });

  it('puts the people count in a child of the people button, followed by "here"', () => {
    const { bar } = mount();
    expect(bar.peopleButton).toBe(q('[data-action="people"]'));
    expect(bar.peopleButton.querySelector('[data-role="people-count"]')).not.toBeNull();
    bar.setPeopleCount(12);
    expect(q('[data-role="people-count"]').textContent).toBe('12');
    expect(bar.peopleButton.textContent).toBe('12 here');
  });

  it('hides the teacher badge unless teacher mode is on', () => {
    const { bar } = mount();
    const badge = q('[data-role="teacher-badge"]');
    expect(badge.hidden).toBe(true);
    bar.setTeacher(true);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('Teacher');
    bar.setTeacher(false);
    expect(badge.hidden).toBe(true);
  });

  it('shows the cursor preview image only while it has a URL', () => {
    const { bar } = mount();
    const img = q<HTMLImageElement>('#topbar [data-action="profile"] img');
    expect(img.hidden).toBe(true);
    bar.setCursorPreview('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');
    expect(img.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');
    bar.setCursorPreview(null);
    expect(img.hidden).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
  });

  it('replaces anything already inside the element when mounted again', () => {
    const { el } = mount();
    mountTopBar(el, handlers());
    expect(el.querySelectorAll('[data-action="fit"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm test -w web -- topBar.test`
Expected: FAIL, `Failed to resolve import "../src/ui/topBar" from "web/test/topBar.test.ts". Does the file exist?`

- [ ] **Step 7: Implement `web/src/ui/topBar.ts` and `web/src/ui/topbar.css`**

`web/src/ui/topBar.ts`:

```ts
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
```

`web/src/ui/topbar.css`:

```css
.topbar {
  position: relative;
  z-index: var(--z-topbar);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font);
  font-size: 0.9rem;
}

.topbar-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.topbar-title {
  font-weight: 600;
  white-space: nowrap;
}

.topbar-board {
  overflow: hidden;
  max-width: 14em;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
}

/* The [hidden] attribute loses to the display rules above unless it is restated. */
.topbar-badge[hidden],
.topbar-cursor[hidden] {
  display: none;
}

.topbar-zoom {
  min-width: 3.5em;
  color: var(--text-muted);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.topbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.topbar-btn:hover {
  background: var(--bg);
}

.topbar-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.topbar-cursor {
  width: 20px;
  height: 20px;
  image-rendering: pixelated;
}

@media (max-width: 720px) {
  .topbar-title,
  .topbar-board,
  .topbar-label {
    display: none;
  }
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npm test -w web -- topBar.test`
Expected: PASS (16 tests: 7 config, 9 top bar).

- [ ] **Step 9: Add the failing tests for the help dialog**

In `web/test/topBar.test.ts`, replace the four import lines at the top with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopBarHandlers } from '../src/contracts';
import { DEFAULT_SERVER_URL, resolveBoard, resolveServerUrl } from '../src/config';
import { openHelp } from '../src/ui/help';
import { mountTopBar } from '../src/ui/topBar';
```

Then append this to the end of the file:

```ts
describe('openHelp', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a labelled help dialog with the board host in the Allowed domains instructions', () => {
    openHelp('jacobl-h.github.io');
    const dialog = q('.modal[data-dialog="help"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('How the board works');
    const host = dialog.querySelector('code');
    expect(host?.textContent).toBe('jacobl-h.github.io');
    expect(host?.parentElement?.textContent).toContain('Allowed domains');
  });

  it('has a section for posting, uploading HTML, Claude artifacts, focus mode and shortcuts', () => {
    openHelp('example.github.io');
    const headings = [...document.querySelectorAll('.modal[data-dialog="help"] h3')].map((e) => e.textContent);
    expect(headings).toEqual(['Post to a tile', 'Upload an HTML file', 'Show a Claude artifact', 'Focus mode', 'Move around']);
    const keys = [...document.querySelectorAll('.help-keys kbd')].map((e) => e.textContent);
    expect(keys).toEqual(['+ and -', '0', 'Arrow keys', 'Enter', 'Esc']);
  });

  it('closes with Esc and the close button, and replaces itself when opened twice', () => {
    openHelp('a.example');
    openHelp('b.example');
    expect(document.querySelectorAll('.modal[data-dialog="help"]')).toHaveLength(1);
    expect(q('.modal code').textContent).toBe('b.example');
    q('.modal [data-action="close"]').click();
    expect(document.querySelector('.modal')).toBeNull();
  });
});
```

- [ ] **Step 10: Run it and confirm the new tests fail**

Run: `npm test -w web -- topBar.test`
Expected: FAIL, `Failed to resolve import "../src/ui/help" from "web/test/topBar.test.ts". Does the file exist?`

- [ ] **Step 11: Implement `web/src/ui/help.ts`**

```ts
import { h } from './dom';
import { openModal } from './modal';
import './topbar.css';

const SHORTCUTS: Array<[keys: string, does: string]> = [
  ['+ and -', 'Zoom in and out'],
  ['0', 'Fit the whole board'],
  ['Arrow keys', 'Pan the board'],
  ['Enter', 'Open the selected tile in focus mode'],
  ['Esc', 'Leave focus mode, or stop using a tile'],
];

const section = (title: string, ...content: Array<Node | string>) =>
  h('section', { class: 'help-section' }, h('h3', null, title), ...content);

/** boardHost is the host of the site the board runs on, for example jacobl-h.github.io. */
export function openHelp(boardHost: string): void {
  const body = h(
    'div',
    { class: 'help' },
    section(
      'Post to a tile',
      h('p', null, 'Click an empty tile, choose Link or HTML file, and press Post. Your name goes above the tile. You can rename or replace any tile. Earlier versions stay in History, so nothing is lost.'),
    ),
    section(
      'Upload an HTML file',
      h('p', null, "In the post dialog, choose HTML file, then pick a file, drop one on the dialog or paste the code. It must be one file of up to 1 MB. Scripts run, but the page can't use cookies or saved browser data."),
    ),
    section(
      'Show a Claude artifact',
      h(
        'p',
        null,
        'Publish the artifact in Claude, then open Publish → Get embed code and add ',
        h('code', null, boardHost),
        ' to Allowed domains. Paste its claude.ai/public/artifacts link into a tile and it runs live.',
      ),
      h('p', null, "Artifacts shared with the Share button can't be shown live. Download the artifact's HTML file and upload it instead."),
    ),
    section(
      'Focus mode',
      h('p', null, "Keep zooming in on a tile after it fills the screen, or select it and press Enter, and it fills the whole page. Use the Back button, Esc or your browser's back button to return to the board."),
    ),
    section(
      'Move around',
      h('p', null, 'Scroll to zoom, drag to pan, double-click a tile to zoom to it. Click a running tile to use it.'),
      h(
        'dl',
        { class: 'help-keys' },
        ...SHORTCUTS.flatMap(([keys, does]) => [h('dt', null, h('kbd', null, keys)), h('dd', null, does)]),
      ),
    ),
  );
  openModal({ title: 'How the board works', dialog: 'help', body });
}
```

Then append the help dialog's styles to the end of `web/src/ui/topbar.css`:

```css
.help-section h3 {
  margin: 0 0 4px;
  font-size: 0.95rem;
}

.help-section p {
  margin: 0 0 8px;
  color: var(--text-muted);
  line-height: 1.45;
}

.help-section + .help-section {
  margin-top: 14px;
}

.help code,
.help kbd {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.85em;
}

.help-keys {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 8px 0 0;
}

.help-keys dt,
.help-keys dd {
  margin: 0;
}
```

- [ ] **Step 12: Run it and confirm it passes**

Run: `npm test -w web -- topBar.test`
Expected: PASS (19 tests: 7 config, 9 top bar, 3 help).

- [ ] **Step 13: Commit (orchestrator)**

```bash
git add web/src/config.ts web/src/ui/topBar.ts web/src/ui/topbar.css web/src/ui/help.ts web/test/topBar.test.ts
git commit -m "feat(web): config, top bar and help dialog (U7)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
