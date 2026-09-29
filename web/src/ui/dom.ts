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
