import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker scaffold', () => {
  it('answers unknown paths with 404', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(404);
  });

  it('provides the fixed test bindings', () => {
    // Reflect.get keeps this test independent of how the bindings are typed.
    expect(Reflect.get(env, 'TEACHER_CODE')).toBe('test-code');
  });
});
