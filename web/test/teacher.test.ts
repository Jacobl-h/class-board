import { describe, expect, it, vi } from 'vitest';
import type { ErrorCode, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { BoardSocket, ServerErrorLike, SocketStatus } from '../src/contracts';
import { createTeacher } from '../src/teacher/teacher';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
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

function serverError(code: ErrorCode): ServerErrorLike {
  return Object.assign(new Error(code), { code });
}

/** A BoardSocket whose request() answers from a script, and remembers what it was asked. */
function fakeSocket(reply: (msg: RequestMsg) => ServerMsg | ServerErrorLike) {
  const requests: RequestMsg[] = [];
  const statusListeners = new Set<(status: SocketStatus) => void>();
  const socket: BoardSocket = {
    send: vi.fn(),
    request: async (msg) => {
      requests.push(msg);
      const result = reply(msg);
      if (result instanceof Error) throw result;
      return result as Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;
    },
    onMessage: () => () => {},
    onStatus: (fn) => {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    status: () => 'open',
    close: vi.fn(),
  };
  const emitStatus = (status: SocketStatus) => {
    for (const fn of [...statusListeners]) fn(status);
  };
  return { socket, requests, emitStatus };
}

const ok = (msg: RequestMsg): ServerMsg => ({ type: 'ok', reqId: msg.reqId });

describe('createTeacher login', () => {
  it('sends a check request with the passcode and becomes active on ok', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage());
    expect(teacher.active()).toBe(false);
    await expect(teacher.login('letmein')).resolves.toBe('ok');
    expect(teacher.active()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'check', code: 'letmein' });
    expect(requests[0]!.reqId).toMatch(/^[0-9a-z]{12}$/);
  });

  it('stores the passcode in the storage it is given', async () => {
    const storage = memoryStorage();
    const teacher = createTeacher(fakeSocket(ok).socket, storage);
    await teacher.login('letmein');
    expect(storage.getItem('classBoard.teacher')).toBe('letmein');
  });

  it('answers bad and stays inactive on bad_code', async () => {
    const storage = memoryStorage();
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, storage);
    await expect(teacher.login('nope')).resolves.toBe('bad');
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('answers locked_out on locked_out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('locked_out')).socket, memoryStorage());
    await expect(teacher.login('nope')).resolves.toBe('locked_out');
    expect(teacher.active()).toBe(false);
  });

  it('rethrows any other error, such as rate_limited', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('rate_limited')).socket, memoryStorage());
    await expect(teacher.login('x')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(teacher.active()).toBe(false);
  });
});

describe('createTeacher session', () => {
  it('restores the active state from storage on creation', () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    expect(teacher.active()).toBe(true);
  });

  it('uses the stored passcode for later actions', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    await teacher.lock();
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'lock', code: 'letmein' });
  });

  it('forgets the passcode on logout', async () => {
    const storage = memoryStorage({ 'classBoard.teacher': 'letmein' });
    const teacher = createTeacher(fakeSocket(ok).socket, storage);
    teacher.logout();
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('tells the server about the sign-out with the passcode', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    teacher.logout();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'logout', code: 'letmein' });
    expect(requests[0]).not.toHaveProperty('slot');
    expect(requests[0]).not.toHaveProperty('target');
  });

  it('signs out locally even when the logout request fails', async () => {
    const { socket, requests } = fakeSocket(() => serverError('not_ready'));
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    expect(() => teacher.logout()).not.toThrow();
    expect(teacher.active()).toBe(false);
    expect(requests).toHaveLength(1);
    await Promise.resolve();
  });

  it('signs out locally even when the socket throws', () => {
    const { socket } = fakeSocket(ok);
    socket.request = () => {
      throw new Error('closed');
    };
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    expect(() => teacher.logout()).not.toThrow();
    expect(teacher.active()).toBe(false);
  });

  it('sends nothing when logging out while already signed out', () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage());
    teacher.logout();
    expect(requests).toHaveLength(0);
  });

  it('works for the tab even when storage throws', async () => {
    const broken = new Proxy({}, { get: () => () => { throw new DOMException('blocked', 'SecurityError'); } }) as Storage;
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, broken);
    expect(teacher.active()).toBe(false);
    await teacher.login('letmein');
    expect(teacher.active()).toBe(true);
    await teacher.unlock();
    expect(requests.at(-1)).toMatchObject({ action: 'unlock', code: 'letmein' });
  });
});

describe('createTeacher actions', () => {
  async function signedIn() {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    return { teacher, requests, socket };
  }

  it('lock and unlock send their action', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.lock();
    await teacher.unlock();
    expect(requests.map((r) => (r as { action: string }).action)).toEqual(['lock', 'unlock']);
  });

  it('clear sends the slot', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.clear(23);
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'clear', slot: 23, code: 'letmein' });
  });

  it('resetCursor sends the person as the target', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.resetCursor('conn-7');
    expect(requests[0]).toMatchObject({ type: 'teacher', action: 'resetCursor', target: 'conn-7', code: 'letmein' });
  });

  it('gives every request its own id', async () => {
    const { teacher, requests } = await signedIn();
    await teacher.lock();
    await teacher.lock();
    expect(requests[0]!.reqId).not.toBe(requests[1]!.reqId);
  });

  it('refuses to act without logging in, and sends nothing', async () => {
    const { socket, requests } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage());
    await expect(teacher.lock()).rejects.toThrow('Not signed in');
    expect(requests).toHaveLength(0);
  });

  it('logs out and rethrows when the server says the passcode is wrong', async () => {
    const storage = memoryStorage({ 'classBoard.teacher': 'old-code' });
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, storage);
    await expect(teacher.clear(3)).rejects.toMatchObject({ code: 'bad_code' });
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
  });

  it('stays logged in and rethrows on other errors', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('rate_limited')).socket, memoryStorage({ 'classBoard.teacher': 'x' }));
    await expect(teacher.lock()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(teacher.active()).toBe(true);
  });
});

describe('createTeacher onChange', () => {
  it('fires with true on login and false on logout', async () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage());
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.login('letmein');
    teacher.logout();
    expect(fn.mock.calls).toEqual([[true], [false]]);
  });

  it('does not fire for a failed login or for a logout that was already logged out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, memoryStorage());
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.login('nope');
    teacher.logout();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires false when a bad_code rejection logs out', async () => {
    const teacher = createTeacher(fakeSocket(() => serverError('bad_code')).socket, memoryStorage({ 'classBoard.teacher': 'old' }));
    const fn = vi.fn();
    teacher.onChange(fn);
    await teacher.lock().catch(() => {});
    expect(fn.mock.calls).toEqual([[false]]);
  });

  it('stops firing after the returned unsubscribe is called', async () => {
    const teacher = createTeacher(fakeSocket(ok).socket, memoryStorage());
    const fn = vi.fn();
    const off = teacher.onChange(fn);
    off();
    await teacher.login('letmein');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createTeacher reconnect', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('re-sends the check with the stored passcode each time the socket opens', async () => {
    const { socket, requests, emitStatus } = fakeSocket(ok);
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    emitStatus('open');
    emitStatus('closed');
    emitStatus('open');
    await flush();
    expect(requests).toHaveLength(2);
    for (const r of requests) expect(r).toMatchObject({ type: 'teacher', action: 'check', code: 'letmein' });
    expect(teacher.active()).toBe(true);
  });

  it('sends nothing on open when not signed in, or for other statuses', async () => {
    const { socket, requests, emitStatus } = fakeSocket(ok);
    createTeacher(socket, memoryStorage());
    emitStatus('open');
    emitStatus('connecting');
    emitStatus('closed');
    await flush();
    expect(requests).toHaveLength(0);
  });

  it('logs out when the re-check answers bad_code', async () => {
    const storage = memoryStorage({ 'classBoard.teacher': 'changed' });
    const { socket, emitStatus } = fakeSocket(() => serverError('bad_code'));
    const teacher = createTeacher(socket, storage);
    const fn = vi.fn();
    teacher.onChange(fn);
    emitStatus('open');
    await flush();
    expect(teacher.active()).toBe(false);
    expect(storage.getItem('classBoard.teacher')).toBeNull();
    expect(fn.mock.calls).toEqual([[false]]);
  });

  it('stays signed in when the re-check fails for another reason', async () => {
    const { socket, emitStatus } = fakeSocket(() => serverError('not_ready'));
    const teacher = createTeacher(socket, memoryStorage({ 'classBoard.teacher': 'letmein' }));
    emitStatus('open');
    await flush();
    expect(teacher.active()).toBe(true);
  });
});
