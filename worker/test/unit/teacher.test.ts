import { describe, expect, it } from 'vitest';
import { TeacherGate, safeEqual } from '../../src/teacher';

const WINDOW = 10 * 60_000;

function setup(code = 'letmein') {
  let t = 5_000_000;
  const gate = new TeacherGate(code, () => t);
  return { gate, advance: (ms: number) => void (t += ms) };
}

function failTimes(gate: TeacherGate, key: string, n: number) {
  for (let i = 0; i < n; i += 1) expect(gate.check(key, 'wrong')).toBe('bad');
}

describe('safeEqual', () => {
  it('accepts equal strings', () => {
    expect(safeEqual('letmein', 'letmein')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(safeEqual('letmein', 'letmeix')).toBe(false);
    expect(safeEqual('Abc', 'abc')).toBe(false);
  });

  it('rejects a prefix in either direction', () => {
    expect(safeEqual('letmein', 'letme')).toBe(false);
    expect(safeEqual('letme', 'letmein')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('is not fooled by a NUL added to reach the same length', () => {
    expect(safeEqual('abc', 'abc\u0000')).toBe(false);
    expect(safeEqual('abc\u0000', 'abc')).toBe(false);
  });

  it('compares non-ASCII text by its UTF-8 bytes', () => {
    expect(safeEqual('pässwörd', 'pässwörd')).toBe(true);
    expect(safeEqual('pässwörd', 'passwörd')).toBe(false);
  });
});

describe('TeacherGate', () => {
  it('accepts the right code', () => {
    const { gate } = setup();
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('reports a wrong code as bad', () => {
    const { gate } = setup();
    expect(gate.check('a', 'nope')).toBe('bad');
    expect(gate.check('a', '')).toBe('bad');
  });

  it('reports five wrong tries as bad and locks out from the sixth', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
  });

  it('does not accept the correct code once locked out', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'letmein')).toBe('locked_out');
  });

  it('still accepts the correct code after four wrong tries', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 4);
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('forgets earlier wrong tries after a success', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 4);
    expect(gate.check('a', 'letmein')).toBe('ok');
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
  });

  it('counts keys separately', () => {
    const { gate } = setup();
    failTimes(gate, 'a', 5);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
    expect(gate.check('b', 'letmein')).toBe('ok');
  });

  it('lifts the lockout when the wrong tries leave the 10 minute window', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 5);
    advance(WINDOW - 1);
    expect(gate.check('a', 'letmein')).toBe('locked_out');
    advance(1);
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('does not extend the lockout when a locked-out key keeps trying', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 5);
    for (let i = 0; i < 9; i += 1) {
      advance(60_000);
      expect(gate.check('a', 'wrong')).toBe('locked_out');
    }
    advance(60_000); // 10 minutes after the wrong tries
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('never locks out a key whose wrong tries are spread out', () => {
    const { gate, advance } = setup();
    for (let i = 0; i < 30; i += 1) {
      expect(gate.check('a', 'wrong')).toBe('bad');
      advance(WINDOW / 4 + 1); // at most 4 wrong tries fit in any window
    }
    expect(gate.check('a', 'letmein')).toBe('ok');
  });

  it('frees one try at a time as the window slides', () => {
    const { gate, advance } = setup();
    failTimes(gate, 'a', 3);
    advance(WINDOW / 2);
    failTimes(gate, 'a', 2);
    expect(gate.check('a', 'wrong')).toBe('locked_out');
    advance(WINDOW / 2); // the first three have now left the window
    expect(gate.check('a', 'wrong')).toBe('bad');
  });

  it('forgets idle keys, so a key that was almost locked out starts fresh', () => {
    const { gate, advance } = setup();
    for (let i = 0; i < 50; i += 1) failTimes(gate, `ip-${i}`, 4);
    advance(WINDOW);
    expect(gate.check('someone-new', 'letmein')).toBe('ok'); // triggers the sweep
    failTimes(gate, 'ip-0', 5);
    expect(gate.check('ip-0', 'wrong')).toBe('locked_out');
  });

  it('accepts nothing, not even an empty code, when no passcode is configured', () => {
    const unset = new TeacherGate('', () => 0);
    expect(unset.check('a', '')).toBe('bad');
    expect(unset.check('a', 'anything')).toBe('bad');
  });
});
