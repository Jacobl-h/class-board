import { describe, expect, it } from 'vitest';

describe('workerd unit environment', () => {
  it('provides HTMLRewriter, Headers, Response and crypto', () => {
    expect(typeof HTMLRewriter).toBe('function');
    expect(new Headers({ a: 'b' }).get('a')).toBe('b');
    expect(new Response('x').status).toBe(200);
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    expect(bytes).toHaveLength(8);
  });
});
