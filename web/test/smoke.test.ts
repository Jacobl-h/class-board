import { describe, expect, it } from 'vitest';

describe('web workspace', () => {
  it('runs in a DOM environment', () => {
    const el = document.createElement('div');
    el.textContent = 'ok';
    document.body.append(el);
    expect(document.body.textContent).toContain('ok');
  });
});
