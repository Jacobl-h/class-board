import { describe, expect, it } from 'vitest';
import { evaluateFraming } from '../../src/frameHeaders';

const BOARD = 'https://jacobl-h.github.io';
const PAGE = 'https://example.com/some/page';
const DEV = 'http://localhost:5173';

/** Builds Headers from name/value pairs, so a name can repeat. */
function hdrs(...pairs: Array<[string, string]>): Headers {
  return new Headers(pairs);
}
const csp = (value: string) => hdrs(['Content-Security-Policy', value]);
const xfo = (value: string) => hdrs(['X-Frame-Options', value]);
const framing = (h: Headers, page = PAGE, board = BOARD) => evaluateFraming(h, page, board);

describe('evaluateFraming: no restrictions', () => {
  it('allows a page with neither header', () => {
    expect(framing(new Headers())).toBe('yes');
  });

  it('allows a page whose CSP has no frame-ancestors', () => {
    expect(framing(csp("default-src 'self'; script-src 'none'"))).toBe('yes');
  });

  it('ignores Content-Security-Policy-Report-Only', () => {
    expect(framing(hdrs(['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"]))).toBe('yes');
  });
});

describe('evaluateFraming: X-Frame-Options', () => {
  it('rejects DENY', () => {
    expect(framing(xfo('DENY'))).toBe('no');
  });

  it('rejects SAMEORIGIN for another origin', () => {
    expect(framing(xfo('SAMEORIGIN'))).toBe('no');
  });

  it('allows SAMEORIGIN when the page is on the board origin', () => {
    expect(framing(xfo('SAMEORIGIN'), 'https://jacobl-h.github.io/other/')).toBe('yes');
  });

  it('reads values case-insensitively and ignores spaces', () => {
    expect(framing(xfo('  deny '))).toBe('no');
    expect(framing(xfo('sameorigin'))).toBe('no');
    expect(framing(hdrs(['x-frame-options', 'DENY']))).toBe('no');
  });

  it('ignores ALLOW-FROM, as browsers do', () => {
    expect(framing(xfo('ALLOW-FROM https://jacobl-h.github.io'))).toBe('yes');
    expect(framing(xfo('ALLOW-FROM https://other.example'))).toBe('yes');
  });

  it('ignores unknown values', () => {
    expect(framing(xfo('garbage'))).toBe('yes');
    expect(framing(xfo('ALLOWALL'))).toBe('yes');
    expect(framing(xfo(''))).toBe('yes');
  });

  it('rejects when any of several values restricts', () => {
    expect(framing(xfo('SAMEORIGIN, DENY'))).toBe('no');
    expect(framing(hdrs(['X-Frame-Options', 'garbage'], ['X-Frame-Options', 'DENY']))).toBe('no');
  });
});
