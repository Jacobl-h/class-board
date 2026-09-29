import { isValidProfile } from '@class-board/shared/protocol';
import type { Profile } from '@class-board/shared/types';
import type { StoredIdentity } from '../contracts';

const CLIENT_ID_KEY = 'classBoard.clientId';
const PROFILE_KEY = 'classBoard.profile';

/** Set only when the id couldn't be saved, so one page load still keeps one identity. */
let memoryId: string | null = null;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function readItem(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value couldn't be saved (storage full, blocked or missing). */
function writeItem(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadIdentity(storage: Storage | undefined = defaultStorage()): StoredIdentity {
  let clientId = readItem(storage, CLIENT_ID_KEY);
  if (!clientId || clientId.length > 64) {
    clientId = memoryId ?? newClientId();
    memoryId = writeItem(storage, CLIENT_ID_KEY, clientId) ? null : clientId;
  }

  let profile: Profile | null = null;
  const raw = readItem(storage, PROFILE_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isValidProfile(parsed)) profile = parsed;
    } catch {
      // A corrupt profile is treated like no profile.
    }
  }
  return { clientId, profile };
}

export function saveProfile(profile: Profile, storage: Storage | undefined = defaultStorage()): void {
  // A profile that can't be saved is simply asked for again on the next visit.
  writeItem(storage, PROFILE_KEY, JSON.stringify(profile));
}
