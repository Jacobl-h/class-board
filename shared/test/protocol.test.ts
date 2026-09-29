import { describe, expect, it } from 'vitest';
import { COLORS, LIMITS } from '../src/constants';
import { emptyGrid, encodeArt } from '../src/pixelArt';
import { cleanText, defaultProfile, isValidProfile, parseClientMsg } from '../src/protocol';
import type { ClientMsg, Profile } from '../src/types';

const ART = encodeArt(emptyGrid());

const shapeProfile: Profile = { name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'star' } };
const pixelProfile: Profile = { name: 'Ben', color: COLORS[0], cursor: { kind: 'pixels', art: ART, tip: [8, 8] } };

describe('cleanText', () => {
  it('removes control characters', () => {
    expect(cleanText('a\u0000b\u0007c\u001fd\u007fe\u0085f', 40)).toBe('abcdef');
  });

  it('turns tabs and newlines into single spaces', () => {
    expect(cleanText('one\ntwo\t\tthree\r\nfour', 40)).toBe('one two three four');
  });

  it('collapses whitespace runs, including ones mixed with control characters', () => {
    expect(cleanText('a   b \u0001 c  d', 40)).toBe('a b c d');
  });

  it('trims both ends', () => {
    expect(cleanText('  \t hello \n ', 40)).toBe('hello');
    expect(cleanText('\u0001\u0002', 40)).toBe('');
    expect(cleanText('   ', 40)).toBe('');
  });

  it('cuts to the maximum number of characters and trims what the cut exposes', () => {
    expect(cleanText('abcdefghij', 4)).toBe('abcd');
    expect(cleanText('abc defgh', 4)).toBe('abc');
  });

  it('counts an emoji as one character and never splits it', () => {
    expect(cleanText('😀😀😀😀', 2)).toBe('😀😀');
    expect(cleanText('ab😀', 3)).toBe('ab😀');
  });

  it('leaves clean text alone', () => {
    expect(cleanText('Maya R.', 24)).toBe('Maya R.');
  });
});

describe('defaultProfile', () => {
  it('is a guest with the first color and the arrow', () => {
    expect(defaultProfile()).toEqual({
      name: 'Guest', color: COLORS[0], cursor: { kind: 'shape', shape: 'arrow' },
    });
  });

  it('uses the given name, cleaned and cut to the limit', () => {
    expect(defaultProfile('  Ana \n').name).toBe('Ana');
    expect(defaultProfile('x'.repeat(50)).name).toHaveLength(LIMITS.nameMax);
  });

  it('falls back to Guest when the name cleans to nothing', () => {
    expect(defaultProfile('\u0001 ').name).toBe('Guest');
  });

  it('produces a valid profile', () => {
    expect(isValidProfile(defaultProfile())).toBe(true);
  });
});

describe('isValidProfile', () => {
  it('accepts shape and pixel cursors', () => {
    expect(isValidProfile(shapeProfile)).toBe(true);
    expect(isValidProfile(pixelProfile)).toBe(true);
  });

  it('accepts every color and every shape', () => {
    for (const color of COLORS) expect(isValidProfile({ ...shapeProfile, color })).toBe(true);
    for (const shape of ['arrow', 'hand', 'pencil', 'star', 'plane', 'crosshair']) {
      expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'shape', shape } })).toBe(true);
    }
  });

  it('accepts a name that only needs cleaning, and rejects one that cleans to nothing', () => {
    expect(isValidProfile({ ...shapeProfile, name: '  Ana\n' })).toBe(true);
    expect(isValidProfile({ ...shapeProfile, name: '' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, name: ' \t\u0001 ' })).toBe(false);
  });

  it('rejects a name far beyond the limit', () => {
    expect(isValidProfile({ ...shapeProfile, name: 'x'.repeat(1000) })).toBe(false);
  });

  it('rejects colors outside the palette', () => {
    expect(isValidProfile({ ...shapeProfile, color: '#000000' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, color: 'red' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, color: COLORS[0].toLowerCase() })).toBe(false);
  });

  it('rejects unknown shapes and cursor kinds', () => {
    expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'shape', shape: 'emoji' } })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'image', url: 'x' } })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, cursor: null })).toBe(false);
  });

  it('rejects pixel cursors with bad art or a bad tip', () => {
    const px = (art: unknown, tip: unknown) => ({ ...shapeProfile, cursor: { kind: 'pixels', art, tip } });
    expect(isValidProfile(px(ART, [8, 8]))).toBe(true);
    expect(isValidProfile(px('short', [8, 8]))).toBe(false);
    expect(isValidProfile(px(ART.slice(1) + 'A', [8, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [16, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [-1, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [1.5, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [8]))).toBe(false);
    expect(isValidProfile(px(ART, [8, 8, 8]))).toBe(false);
    expect(isValidProfile(px(ART, '8,8'))).toBe(false);
    expect(isValidProfile(px(undefined, [8, 8]))).toBe(false);
  });

  it('rejects values that are not profiles', () => {
    for (const bad of [null, undefined, 'Ana', 42, [], {}, { name: 'Ana' }]) {
      expect(isValidProfile(bad)).toBe(false);
    }
  });
});

const FILE_ID = 'a'.repeat(32);

/** Every message type in its smallest valid form. */
const valid: Record<ClientMsg['type'], ClientMsg> = {
  hello: { type: 'hello', clientId: 'b3d1c0de-1234-4abc-9def-0123456789ab', profile: shapeProfile },
  profile: { type: 'profile', profile: pixelProfile },
  cursor: { type: 'cursor', x: 120, y: -40 },
  dock: { type: 'dock', slot: 23, mode: 'using' },
  away: { type: 'away' },
  post: {
    type: 'post', reqId: 'abc123def456', slot: 0, baseVersion: 0,
    content: { kind: 'link', url: 'https://example.com/' }, label: 'Ana',
  },
  rename: { type: 'rename', reqId: 'abc123def456', slot: 79, baseVersion: 4, label: 'New name' },
  restore: { type: 'restore', reqId: 'abc123def456', slot: 5, baseVersion: 9, versionId: 3 },
  history: { type: 'history', reqId: 'abc123def456', slot: 12 },
  teacher: { type: 'teacher', reqId: 'abc123def456', code: 'letmein', action: 'lock' },
};

describe('parseClientMsg: input handling', () => {
  it('parses every message type from an object', () => {
    for (const msg of Object.values(valid)) expect(parseClientMsg(msg)).toEqual(msg);
  });

  it('parses every message type from a JSON string', () => {
    for (const msg of Object.values(valid)) expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
  });

  it('returns null for invalid JSON and for JSON that is not an object', () => {
    for (const bad of ['', '{', 'not json', 'null', '42', '"cursor"', '[]', '[{"type":"away"}]', 'true']) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('returns null for non-object input of any kind', () => {
    for (const bad of [null, undefined, 42, true, [], [valid.away], new ArrayBuffer(8), () => {}]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('returns null for an oversized string without parsing it', () => {
    const big = JSON.stringify({ type: 'away', pad: 'x'.repeat(20_000) });
    expect(parseClientMsg(big)).toBeNull();
  });

  it('returns null for an unknown or missing type', () => {
    expect(parseClientMsg({ type: 'explode' })).toBeNull();
    expect(parseClientMsg({ type: 'snapshot' })).toBeNull();
    expect(parseClientMsg({ type: 7 })).toBeNull();
    expect(parseClientMsg({})).toBeNull();
    expect(parseClientMsg({ x: 1, y: 2 })).toBeNull();
  });

  it('drops fields the protocol does not define', () => {
    expect(parseClientMsg({ ...valid.cursor, extra: 'x', __proto__: { admin: true } })).toEqual(valid.cursor);
    expect(parseClientMsg({ ...valid.away, junk: 1 })).toEqual({ type: 'away' });
    expect(parseClientMsg({ ...valid.hello, isTeacher: true })).toEqual(valid.hello);
    const post = valid.post as Extract<ClientMsg, { type: 'post' }>;
    expect(parseClientMsg({ ...post, content: { kind: 'link', url: 'https://example.com/', evil: 1 } })).toEqual(post);
    expect(parseClientMsg({ ...valid.hello, profile: { ...shapeProfile, role: 'teacher' } })).toEqual(valid.hello);
  });
});

describe('parseClientMsg: hello and profile', () => {
  it('cleans the profile name', () => {
    const parsed = parseClientMsg({ ...valid.hello, profile: { ...shapeProfile, name: '  A\u0000na \n B ' } });
    expect(parsed).toMatchObject({ type: 'hello', profile: { name: 'Ana B' } });
  });

  it('cuts a long profile name to the limit', () => {
    const parsed = parseClientMsg({ type: 'profile', profile: { ...shapeProfile, name: 'y'.repeat(60) } });
    expect(parsed).toMatchObject({ type: 'profile', profile: { name: 'y'.repeat(LIMITS.nameMax) } });
  });

  it('rejects a hello without a valid client id', () => {
    const { clientId: _unused, ...missing } = valid.hello as Extract<ClientMsg, { type: 'hello' }>;
    expect(parseClientMsg(missing)).toBeNull();
    for (const clientId of ['', 'has space', 'x'.repeat(65), 12, null, '<script>']) {
      expect(parseClientMsg({ ...valid.hello, clientId })).toBeNull();
    }
  });

  it('rejects hello and profile messages with an invalid profile', () => {
    expect(parseClientMsg({ type: 'hello', clientId: 'abcdefgh' })).toBeNull();
    expect(parseClientMsg({ type: 'hello', clientId: 'abcdefgh', profile: { ...shapeProfile, name: '' } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...shapeProfile, color: '#123456' } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...pixelProfile, cursor: { kind: 'pixels', art: 'x', tip: [8, 8] } } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...pixelProfile, cursor: { kind: 'pixels', art: ART, tip: [99, 8] } } })).toBeNull();
    expect(parseClientMsg({ type: 'profile' })).toBeNull();
  });

  it('keeps a pixel cursor exactly as sent', () => {
    expect(parseClientMsg(valid.profile)).toEqual(valid.profile);
  });
});

describe('parseClientMsg: cursor and dock', () => {
  it('rounds cursor coordinates to integers', () => {
    expect(parseClientMsg({ type: 'cursor', x: 10.6, y: -3.4 })).toEqual({ type: 'cursor', x: 11, y: -3 });
  });

  it('clamps cursor coordinates to a sane range', () => {
    expect(parseClientMsg({ type: 'cursor', x: 1e12, y: -1e12 })).toEqual({ type: 'cursor', x: 100_000, y: -100_000 });
  });

  it('rejects cursor messages with missing, non-finite or non-numeric coordinates', () => {
    for (const bad of [
      { type: 'cursor', x: 1 },
      { type: 'cursor', y: 1 },
      { type: 'cursor', x: NaN, y: 1 },
      { type: 'cursor', x: 1, y: Infinity },
      { type: 'cursor', x: '1', y: 2 },
      { type: 'cursor', x: null, y: 2 },
    ]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('accepts dock messages for both modes and every corner slot', () => {
    for (const slot of [0, 9, 70, 79]) {
      for (const mode of ['using', 'viewing'] as const) {
        expect(parseClientMsg({ type: 'dock', slot, mode })).toEqual({ type: 'dock', slot, mode });
      }
    }
  });

  it('rejects dock messages with an out-of-range slot or unknown mode', () => {
    for (const bad of [
      { type: 'dock', slot: 80, mode: 'using' },
      { type: 'dock', slot: -1, mode: 'using' },
      { type: 'dock', slot: 1.5, mode: 'using' },
      { type: 'dock', slot: '3', mode: 'using' },
      { type: 'dock', slot: 3, mode: 'hovering' },
      { type: 'dock', slot: 3 },
      { type: 'dock', mode: 'using' },
    ]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });
});

describe('parseClientMsg: post', () => {
  const post = valid.post as Extract<ClientMsg, { type: 'post' }>;

  it('accepts a link post and an html post', () => {
    expect(parseClientMsg(post)).toEqual(post);
    const html = { ...post, content: { kind: 'html', fileId: FILE_ID } };
    expect(parseClientMsg(html)).toEqual(html);
  });

  it('cleans the label and allows an empty one', () => {
    expect(parseClientMsg({ ...post, label: '  Ana\n\u0000R. ' })).toMatchObject({ label: 'Ana R.' });
    expect(parseClientMsg({ ...post, label: '' })).toMatchObject({ label: '' });
  });

  it('cuts a label to the limit and rejects one that is absurdly long', () => {
    expect(parseClientMsg({ ...post, label: 'z'.repeat(60) })).toMatchObject({ label: 'z'.repeat(LIMITS.labelMax) });
    expect(parseClientMsg({ ...post, label: 'z'.repeat(5000) })).toBeNull();
  });

  it('rejects a missing or malformed reqId', () => {
    const { reqId: _unused, ...missing } = post;
    expect(parseClientMsg(missing)).toBeNull();
    for (const reqId of ['', 'has space', 'x'.repeat(65), 7, null]) {
      expect(parseClientMsg({ ...post, reqId })).toBeNull();
    }
  });

  it('rejects out-of-range slots and invalid base versions', () => {
    expect(parseClientMsg({ ...post, slot: 80 })).toBeNull();
    expect(parseClientMsg({ ...post, slot: -1 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: -1 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: 1.5 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: '0' })).toBeNull();
    const { baseVersion: _unused, ...missing } = post;
    expect(parseClientMsg(missing)).toBeNull();
  });

  it('rejects invalid content', () => {
    for (const content of [
      undefined,
      null,
      'https://example.com',
      { kind: 'link' },
      { kind: 'link', url: '' },
      { kind: 'link', url: 42 },
      { kind: 'link', url: 'x'.repeat(5000) },
      { kind: 'html' },
      { kind: 'html', fileId: 'short' },
      { kind: 'html', fileId: 'A'.repeat(32) },
      { kind: 'html', fileId: 'g'.repeat(32) },
      { kind: 'pdf', url: 'https://example.com' },
    ]) {
      expect(parseClientMsg({ ...post, content })).toBeNull();
    }
  });

  it('passes long link text through for planLink to judge', () => {
    const url = 'https://example.com/' + 'a'.repeat(3000);
    expect(parseClientMsg({ ...post, content: { kind: 'link', url } })).toMatchObject({ content: { kind: 'link', url } });
  });
});

describe('parseClientMsg: rename, restore, history', () => {
  it('accepts rename with a cleaned label', () => {
    expect(parseClientMsg({ ...valid.rename, label: ' New\tname ' })).toMatchObject({ type: 'rename', label: 'New name' });
  });

  it('rejects rename without a label or reqId', () => {
    const { label: _l, ...noLabel } = valid.rename as Extract<ClientMsg, { type: 'rename' }>;
    const { reqId: _r, ...noReq } = valid.rename as Extract<ClientMsg, { type: 'rename' }>;
    expect(parseClientMsg(noLabel)).toBeNull();
    expect(parseClientMsg(noReq)).toBeNull();
    expect(parseClientMsg({ ...valid.rename, label: 7 })).toBeNull();
  });

  it('accepts restore and requires a positive integer version id', () => {
    expect(parseClientMsg(valid.restore)).toEqual(valid.restore);
    for (const versionId of [0, -2, 1.5, '3', null, undefined]) {
      expect(parseClientMsg({ ...valid.restore, versionId })).toBeNull();
    }
  });

  it('rejects restore with a bad slot or base version', () => {
    expect(parseClientMsg({ ...valid.restore, slot: 99 })).toBeNull();
    expect(parseClientMsg({ ...valid.restore, baseVersion: -1 })).toBeNull();
  });

  it('accepts history and rejects a bad slot or missing reqId', () => {
    expect(parseClientMsg(valid.history)).toEqual(valid.history);
    expect(parseClientMsg({ ...valid.history, slot: 80 })).toBeNull();
    expect(parseClientMsg({ type: 'history', slot: 3 })).toBeNull();
  });
});

describe('parseClientMsg: teacher', () => {
  const base = { type: 'teacher', reqId: 'abc123def456', code: 'letmein' };

  it('accepts check, lock and unlock without a slot or target', () => {
    for (const action of ['check', 'lock', 'unlock']) {
      expect(parseClientMsg({ ...base, action })).toEqual({ ...base, action });
    }
  });

  it('drops a slot or target that the action does not use', () => {
    expect(parseClientMsg({ ...base, action: 'lock', slot: 3, target: 'abc' })).toEqual({ ...base, action: 'lock' });
  });

  it('requires a valid slot for clear', () => {
    expect(parseClientMsg({ ...base, action: 'clear', slot: 12 })).toEqual({ ...base, action: 'clear', slot: 12 });
    expect(parseClientMsg({ ...base, action: 'clear' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'clear', slot: 80 })).toBeNull();
  });

  it('requires a valid target for resetCursor', () => {
    const ok = { ...base, action: 'resetCursor', target: 'conn-42' };
    expect(parseClientMsg(ok)).toEqual(ok);
    expect(parseClientMsg({ ...base, action: 'resetCursor' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'resetCursor', target: '' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'resetCursor', target: 'a b' })).toBeNull();
  });

  it('rejects unknown actions and a missing or empty code', () => {
    expect(parseClientMsg({ ...base, action: 'shutdown' })).toBeNull();
    expect(parseClientMsg({ ...base })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: '' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: 12 })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: 'x'.repeat(500) })).toBeNull();
    const { code: _c, ...noCode } = { ...base, action: 'lock' };
    expect(parseClientMsg(noCode)).toBeNull();
  });

  it('does not clean the passcode', () => {
    expect(parseClientMsg({ ...base, action: 'lock', code: ' pass  word ' })).toMatchObject({ code: ' pass  word ' });
  });
});
