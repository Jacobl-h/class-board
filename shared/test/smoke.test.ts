import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

describe('shared workspace', () => {
  it('runs vitest and resolves valibot', () => {
    expect(v.parse(v.string(), 'ok')).toBe('ok');
  });
});
