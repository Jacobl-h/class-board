import { PartySocket, type PartySocketOptions } from 'partysocket';
import type { ClientMsg, ErrorCode, RequestMsg, ServerMsg } from '@class-board/shared/types';
import type { BoardSocket, ServerErrorLike, SocketStatus } from '../contracts';

export const REQUEST_TIMEOUT_MS = 10_000;

export class ServerError extends Error implements ServerErrorLike {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

/** 12 random base36 characters. */
export function newReqId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
}

/** The part of a WebSocket that connectBoard uses. PartySocket satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message' | 'error', listener: (event: Event) => void): void;
}

export interface ConnectOptions {
  serverUrl: string;
  board: string;
  /** Called on every (re)open; the result is sent as the first message. */
  hello: () => ClientMsg;
  /** Test seam: replaces `new PartySocket(options)`. */
  socketFactory?: (options: PartySocketOptions) => SocketLike;
  /** Test seam: how long request() waits for a reply. */
  requestTimeoutMs?: number;
}

type Reply = Extract<ServerMsg, { type: 'ok' | 'historyResult' }>;

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: ServerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseServerMessage(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return typeof (value as { type?: unknown }).type === 'string' ? (value as ServerMsg) : null;
}

export function connectBoard(opts: ConnectOptions): BoardSocket {
  const url = new URL(opts.serverUrl);
  const options: PartySocketOptions = {
    host: url.host,
    protocol: url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss' : 'ws',
    party: 'board',
    room: opts.board,
    // PartySocket queues sends made while disconnected and flushes them on reconnect, ahead of our hello.
    maxEnqueuedMessages: 0,
  };
  const socket: SocketLike = opts.socketFactory ? opts.socketFactory(options) : new PartySocket(options);
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  let current: SocketStatus = 'connecting';
  let closedByUs = false;
  const messageListeners = new Set<(msg: ServerMsg) => void>();
  const statusListeners = new Set<(status: SocketStatus) => void>();
  const pending = new Map<string, Pending>();

  function setStatus(next: SocketStatus): void {
    if (next === current) return;
    current = next;
    for (const fn of [...statusListeners]) fn(next);
  }

  function rejectAll(message: string): void {
    for (const [reqId, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(new ServerError('not_ready', message));
    }
  }

  function settle(msg: ServerMsg): void {
    if (msg.type !== 'ok' && msg.type !== 'historyResult' && msg.type !== 'error') return;
    if (msg.reqId === null) return;
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(new ServerError(msg.code, msg.message));
    else p.resolve(msg);
  }

  socket.addEventListener('open', () => {
    if (closedByUs) return;
    // hello goes out before anyone hears the socket is open, so nothing can be sent ahead of it.
    socket.send(JSON.stringify(opts.hello()));
    setStatus('open');
  });
  socket.addEventListener('close', () => {
    if (closedByUs) return;
    setStatus('closed');
    rejectAll('Lost the connection to the board. Try again once it is back.');
  });
  socket.addEventListener('message', (event) => {
    if (closedByUs) return;
    const msg = parseServerMessage((event as MessageEvent).data);
    if (!msg) return;
    settle(msg);
    for (const fn of [...messageListeners]) {
      try {
        fn(msg);
      } catch (err) {
        console.error('Message listener threw', err);
      }
    }
  });

  return {
    send(msg) {
      if (current === 'open') socket.send(JSON.stringify(msg));
    },
    request(msg: RequestMsg) {
      return new Promise<Reply>((resolve, reject) => {
        if (current !== 'open') {
          reject(new ServerError('not_ready', 'The board is not connected. Try again once it is back.'));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(msg.reqId);
          reject(new ServerError('not_ready', 'The board did not answer. Try again.'));
        }, timeoutMs);
        pending.set(msg.reqId, { resolve, reject, timer });
        socket.send(JSON.stringify(msg));
      });
    },
    onMessage(fn) {
      messageListeners.add(fn);
      return () => {
        messageListeners.delete(fn);
      };
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    status: () => current,
    close() {
      if (closedByUs) return;
      socket.close();
      closedByUs = true;
      setStatus('closed');
      rejectAll('The connection to the board was closed.');
    },
  };
}
