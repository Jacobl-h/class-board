import type { ClientMsg, SlotIndex } from '@class-board/shared/types';
import type { BoardSocket, TeacherApi, Unsubscribe } from '../contracts';

const STORAGE_KEY = 'classBoard.teacher';

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** 12 random base36 characters, like newReqId() in net/socket.ts. */
function makeReqId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
}

type TeacherMsg = Extract<ClientMsg, { type: 'teacher' }>;

export function createTeacher(socket: BoardSocket, storage: Storage | undefined = defaultStorage()): TeacherApi {
  const listeners = new Set<(active: boolean) => void>();

  function read(): string | null {
    try {
      return storage?.getItem(STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  // Kept in memory too, so a tab whose sessionStorage is blocked still works until it closes.
  let code: string | null = read();

  function notify(): void {
    for (const fn of [...listeners]) fn(code !== null);
  }

  function setCode(next: string | null): void {
    const changed = (code === null) !== (next === null);
    code = next;
    try {
      if (next === null) storage?.removeItem(STORAGE_KEY);
      else storage?.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved: the passcode stays in memory for this page only.
    }
    if (changed) notify();
  }

  async function act(fields: Pick<TeacherMsg, 'action' | 'slot' | 'target'>): Promise<void> {
    if (code === null) throw new Error('Not signed in as the teacher.');
    try {
      await socket.request({ type: 'teacher', reqId: makeReqId(), code, ...fields });
    } catch (err) {
      if ((err as { code?: string }).code === 'bad_code') setCode(null);
      throw err;
    }
  }

  // The server remembers teacher status per connection, so every new connection (a reload or a
  // reconnect) must sign in again. connectBoard sends hello before it reports 'open'.
  socket.onStatus((status) => {
    if (status !== 'open' || code === null) return;
    const sent = code;
    socket.request({ type: 'teacher', reqId: makeReqId(), code: sent, action: 'check' }).catch((err) => {
      // Only a wrong passcode logs out; a dropped or slow connection will be retried on the next open.
      if ((err as { code?: string }).code === 'bad_code' && code === sent) setCode(null);
    });
  });

  return {
    active: () => code !== null,

    async login(attempt) {
      try {
        await socket.request({ type: 'teacher', reqId: makeReqId(), code: attempt, action: 'check' });
      } catch (err) {
        const errorCode = (err as { code?: string }).code;
        if (errorCode === 'bad_code') return 'bad';
        if (errorCode === 'locked_out') return 'locked_out';
        throw err;
      }
      setCode(attempt);
      return 'ok';
    },

    logout: () => setCode(null),
    lock: () => act({ action: 'lock' }),
    unlock: () => act({ action: 'unlock' }),
    clear: (slot: SlotIndex) => act({ action: 'clear', slot }),
    resetCursor: (personId: string) => act({ action: 'resetCursor', target: personId }),

    onChange(fn): Unsubscribe {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
