import { describe, expect, it } from 'vitest';
import { COLORS } from '@class-board/shared/constants';
import { emptyGrid, encodeArt } from '@class-board/shared/pixelArt';
import { defaultProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import { loadIdentity, saveProfile } from '../src/profile/storage';

/** A Storage that keeps its data in a Map, so tests never touch the real localStorage. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** A Storage whose every method throws, like localStorage with site data blocked. */
function brokenStorage(): Storage {
  const fail = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

const pixelsProfile: Profile = {
  name: 'Maya',
  color: COLORS[3],
  cursor: { kind: 'pixels', art: encodeArt(emptyGrid()), tip: [8, 8] },
};

describe('loadIdentity', () => {
  it('creates a client id on the first visit and saves it', () => {
    const storage = memoryStorage();
    const { clientId, profile } = loadIdentity(storage);
    expect(clientId).toMatch(/^[0-9a-f-]{16,}$/);
    expect(profile).toBeNull();
    expect(storage.data.get('classBoard.clientId')).toBe(clientId);
  });

  it('returns the same client id on the next visit', () => {
    const storage = memoryStorage();
    const first = loadIdentity(storage).clientId;
    expect(loadIdentity(storage).clientId).toBe(first);
  });

  it('replaces a stored client id that is empty or absurdly long', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.clientId', 'x'.repeat(65));
    const { clientId } = loadIdentity(storage);
    expect(clientId).not.toBe('x'.repeat(65));
    expect(storage.data.get('classBoard.clientId')).toBe(clientId);
  });

  it('round-trips a shape profile', () => {
    const storage = memoryStorage();
    const profile = defaultProfile('Ana');
    saveProfile(profile, storage);
    expect(loadIdentity(storage).profile).toEqual(profile);
  });

  it('round-trips a pixel-art profile', () => {
    const storage = memoryStorage();
    saveProfile(pixelsProfile, storage);
    expect(loadIdentity(storage).profile).toEqual(pixelsProfile);
  });

  it('stores the profile as JSON under classBoard.profile', () => {
    const storage = memoryStorage();
    saveProfile(defaultProfile('Ana'), storage);
    expect(JSON.parse(storage.data.get('classBoard.profile')!)).toEqual(defaultProfile('Ana'));
  });

  it('ignores a profile that is not JSON', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.profile', '{not json');
    expect(loadIdentity(storage).profile).toBeNull();
  });

  it('ignores a profile that fails validation', () => {
    const storage = memoryStorage();
    storage.setItem('classBoard.profile', JSON.stringify({ name: '', color: '#123456', cursor: { kind: 'shape', shape: 'arrow' } }));
    expect(loadIdentity(storage).profile).toBeNull();
    storage.setItem('classBoard.profile', JSON.stringify({ name: 'Ana', color: COLORS[0], cursor: { kind: 'shape', shape: 'banana' } }));
    expect(loadIdentity(storage).profile).toBeNull();
  });

  it('still returns an identity when storage throws, and keeps the id for the rest of the page load', () => {
    const storage = brokenStorage();
    const first = loadIdentity(storage);
    expect(first.clientId.length).toBeGreaterThan(0);
    expect(first.profile).toBeNull();
    expect(loadIdentity(storage).clientId).toBe(first.clientId);
  });

  it('does not throw when storage is missing', () => {
    expect(loadIdentity(undefined).profile).toBeNull();
  });
});

describe('saveProfile', () => {
  it('does not throw when storage throws', () => {
    expect(() => saveProfile(defaultProfile('Ana'), brokenStorage())).not.toThrow();
  });

  it('overwrites the earlier profile', () => {
    const storage = memoryStorage();
    saveProfile(defaultProfile('Ana'), storage);
    saveProfile(defaultProfile('Ben'), storage);
    expect(loadIdentity(storage).profile?.name).toBe('Ben');
  });
});
