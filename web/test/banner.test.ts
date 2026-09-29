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
