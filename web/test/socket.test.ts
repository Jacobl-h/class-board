import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartySocket, type PartySocketOptions } from 'partysocket';
import type { ClientMsg, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { SocketStatus } from '../src/contracts';
import { connectBoard, newReqId, ServerError, type SocketLike } from '../src/net/socket';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Array<(event: Event) => void>> = {};
  constructor(readonly options: PartySocketOptions) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  fire(type: 'open' | 'close' | 'error'): void {
    this.readyState = type === 'open' ? 1 : 3;
    for (const fn of this.handlers[type] ?? []) fn(new Event(type));
  }
  receive(data: unknown): void {
    const event = Object.assign(new Event('message'), { data });
    for (const fn of this.handlers.message ?? []) fn(event);
  }
  sentMessages(): ClientMsg[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMsg);
  }
}

const HELLO: ClientMsg = {
  type: 'hello',
  clientId: 'c1',
  profile: { name: 'Ana', color: '#D85A30', cursor: { kind: 'shape', shape: 'arrow' } },
};

function setup(overrides: { serverUrl?: string; board?: string; requestTimeoutMs?: number } = {}) {
  let fake!: FakeSocket;
  const hello = vi.fn(() => HELLO);
  const board = connectBoard({
    serverUrl: overrides.serverUrl ?? 'http://localhost:8787',
    board: overrides.board ?? 'main',
    hello,
    requestTimeoutMs: overrides.requestTimeoutMs,
    socketFactory: (options) => (fake = new FakeSocket(options)),
  });
  return { board, fake, hello };
}

const post = (reqId: string): RequestMsg => ({
  type: 'post', reqId, slot: 23, baseVersion: 0, content: { kind: 'link', url: 'https://example.com' }, label: 'Ana',
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('newReqId', () => {
  it('returns 12 lowercase base36 characters and does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newReqId));
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{12}$/);
    expect(ids.size).toBe(200);
  });
});

describe('connection options', () => {
  it('uses ws for http, party board and the board name as the room', () => {
    const { fake } = setup({ serverUrl: 'http://localhost:8787', board: 'week-3' });
    expect(fake.options).toMatchObject({ host: 'localhost:8787', protocol: 'ws', party: 'board', room: 'week-3' });
  });

  it('uses wss for https', () => {
    const { fake } = setup({ serverUrl: 'https://class-board.example.workers.dev' });
    expect(fake.options).toMatchObject({ host: 'class-board.example.workers.dev', protocol: 'wss' });
  });

  it('builds the /parties/board/<board> url that PartyServer routes', () => {
    const { fake } = setup({ serverUrl: 'https://class-board.example.workers.dev', board: 'main' });
    const real = new PartySocket({ ...fake.options, startClosed: true });
    expect(real.roomUrl).toBe('wss://class-board.example.workers.dev/parties/board/main');
    const local = new PartySocket({ ...setup().fake.options, startClosed: true });
    expect(local.roomUrl).toBe('ws://localhost:8787/parties/board/main');
  });

  it('does not let PartySocket queue messages while disconnected', () => {
    expect(setup().fake.options.maxEnqueuedMessages).toBe(0);
  });
});

describe('status and hello', () => {
  it('starts connecting, then follows open and close', () => {
    const { board, fake } = setup();
    const seen: SocketStatus[] = [];
    board.onStatus((s) => seen.push(s));
    expect(board.status()).toBe('connecting');
    fake.fire('open');
    expect(board.status()).toBe('open');
    fake.fire('close');
    expect(board.status()).toBe('closed');
    expect(seen).toEqual(['open', 'closed']);
  });

  it('sends hello() as the first message on every open, before listeners hear about the open', () => {
    const { board, fake, hello } = setup();
    const sentWhenNotified: number[] = [];
    board.onStatus((s) => {
      if (s === 'open') sentWhenNotified.push(fake.sent.length);
    });
    fake.fire('open');
    expect(fake.sentMessages()).toEqual([HELLO]);
    expect(sentWhenNotified).toEqual([1]);
    fake.fire('close');
    fake.fire('open');
    expect(hello).toHaveBeenCalledTimes(2);
    expect(fake.sentMessages()).toEqual([HELLO, HELLO]);
  });

  it('reports each status change once', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onStatus(fn);
    fake.fire('close');
    fake.fire('close');
    fake.fire('open');
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['closed', 'open']);
  });

  it('stops notifying after unsubscribe', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    const off = board.onStatus(fn);
    off();
    fake.fire('open');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('sends JSON while open and drops messages otherwise', () => {
    const { board, fake } = setup();
    board.send({ type: 'away' });
    expect(fake.sent).toHaveLength(0);
    fake.fire('open');
    board.send({ type: 'cursor', x: 10, y: 20 });
    expect(fake.sentMessages()).toEqual([HELLO, { type: 'cursor', x: 10, y: 20 }]);
    fake.fire('close');
    board.send({ type: 'away' });
    expect(fake.sent).toHaveLength(2);
  });
});

describe('incoming messages', () => {
  it('delivers JSON objects that have a string type', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onMessage(fn);
    const msg: ServerMsg = { type: 'locked', locked: true };
    fake.receive(JSON.stringify(msg));
    expect(fn).toHaveBeenCalledWith(msg);
  });

  it('ignores anything else', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    board.onMessage(fn);
    fake.receive('not json');
    fake.receive('null');
    fake.receive('42');
    fake.receive('"locked"');
    fake.receive('[{"type":"locked"}]');
    fake.receive('{"locked":true}');
    fake.receive('{"type":7}');
    fake.receive(new ArrayBuffer(8));
    fake.receive(undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps delivering when one listener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { board, fake } = setup();
    const after = vi.fn();
    board.onMessage(() => {
      throw new Error('boom');
    });
    board.onMessage(after);
    fake.receive('{"type":"rate","hz":2}');
    expect(after).toHaveBeenCalledWith({ type: 'rate', hz: 2 });
  });

  it('stops delivering after unsubscribe', () => {
    const { board, fake } = setup();
    const fn = vi.fn();
    const off = board.onMessage(fn);
    off();
    fake.receive('{"type":"rate","hz":2}');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  it('sends the message and resolves with the reply that has the same reqId', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('abc'));
    expect(fake.sentMessages()[1]).toMatchObject({ type: 'post', reqId: 'abc' });
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'other' }));
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'abc' }));
    await expect(promise).resolves.toEqual({ type: 'ok', reqId: 'abc' });
  });

  it('resolves history requests with the historyResult', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request({ type: 'history', reqId: 'h1', slot: 3 });
    fake.receive(JSON.stringify({ type: 'historyResult', reqId: 'h1', slot: 3, versions: [] }));
    await expect(promise).resolves.toEqual({ type: 'historyResult', reqId: 'h1', slot: 3, versions: [] });
  });

  it('rejects with a ServerError carrying the code of an error reply', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('abc'));
    fake.receive(JSON.stringify({ type: 'error', reqId: 'abc', code: 'conflict', message: 'stale' }));
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'conflict', message: 'stale' });
  });

  it('answers concurrent requests independently', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const a = board.request(post('a'));
    const b = board.request(post('b'));
    fake.receive(JSON.stringify({ type: 'error', reqId: 'b', code: 'locked', message: 'no' }));
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'a' }));
    await expect(a).resolves.toEqual({ type: 'ok', reqId: 'a' });
    await expect(b).rejects.toMatchObject({ code: 'locked' });
  });

  it('still passes replies and errors on to onMessage listeners', () => {
    const { board, fake } = setup();
    fake.fire('open');
    const fn = vi.fn();
    board.onMessage(fn);
    void board.request(post('abc')).catch(() => {});
    fake.receive(JSON.stringify({ type: 'ok', reqId: 'abc' }));
    fake.receive(JSON.stringify({ type: 'error', reqId: null, code: 'not_ready', message: 'hello first' }));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects with not_ready after 10 seconds without a reply', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('slow'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    await vi.advanceTimersByTimeAsync(9_999);
    fake.receive(JSON.stringify({ type: 'rate', hz: 5 }));
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(ServerError);
  });

  it('ignores a reply that arrives after the timeout', async () => {
    const { board, fake } = setup({ requestTimeoutMs: 50 });
    fake.fire('open');
    const promise = board.request(post('late'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(() => fake.receive(JSON.stringify({ type: 'ok', reqId: 'late' }))).not.toThrow();
  });

  it('rejects at once with not_ready while the socket is not open, without sending', async () => {
    const { board, fake } = setup();
    await expect(board.request(post('x'))).rejects.toMatchObject({ code: 'not_ready' });
    expect(fake.sent).toHaveLength(0);
  });

  it('rejects requests still waiting when the connection closes', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const promise = board.request(post('x'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    fake.fire('close');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('close', () => {
  it('closes the socket, reports closed, rejects pending requests and ignores later events', async () => {
    const { board, fake } = setup();
    fake.fire('open');
    const status = vi.fn();
    const messages = vi.fn();
    board.onStatus(status);
    board.onMessage(messages);
    const promise = board.request(post('x'));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_ready' });
    board.close();
    await assertion;
    expect(fake.closed).toBe(true);
    expect(board.status()).toBe('closed');
    expect(status).toHaveBeenCalledWith('closed');
    fake.fire('open');
    fake.receive('{"type":"rate","hz":5}');
    expect(board.status()).toBe('closed');
    expect(messages).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(2); // hello and the request
  });
});
