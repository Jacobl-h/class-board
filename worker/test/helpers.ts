import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { defaultProfile } from '@class-board/shared/protocol';
import type { ServerMsg } from '@class-board/shared/types';
import type { Board } from '../src/board';

export const ORIGIN = 'https://jacobl-h.github.io';

type MsgOf<T extends ServerMsg['type']> = Extract<ServerMsg, { type: T }>;

export interface TestClient {
  ws: WebSocket;
  /** Every message received, in order. */
  log: ServerMsg[];
  /** Connection id, known after hello(). */
  id: string;
  send(msg: unknown): void;
  /**
   * Resolves with the oldest message of this type (matching `where`, if given) that no
   * earlier next() call returned. Waits for it if it hasn't arrived yet.
   */
  next<T extends ServerMsg['type']>(type: T, timeoutMs?: number, where?: (m: MsgOf<T>) => boolean): Promise<MsgOf<T>>;
  /** All messages of this type received so far. */
  all<T extends ServerMsg['type']>(type: T): MsgOf<T>[];
  close(): void;
}

const open = new Set<TestClient>();

let boardCounter = 0;
/** A board name no other test in this file uses (storage is shared within a test file). */
export function uniqueBoard(prefix = 't'): string {
  boardCounter += 1;
  return `${prefix}-${boardCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stubFor(board: string): DurableObjectStub<Board> {
  return env.Board.get(env.Board.idFromName(board)) as DurableObjectStub<Board>;
}

/** Runs fn inside the board's Durable Object, for seams and for reading storage. */
export function inBoard<R>(board: string, fn: (b: Board) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stubFor(board), (instance) => fn(instance));
}

export async function openClient(board: string, opts: { origin?: string | null } = {}): Promise<TestClient> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.Origin = origin;
  const res = await SELF.fetch(`http://localhost/parties/board/${board}`, { headers });
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();

  const log: ServerMsg[] = [];
  const taken = new Set<number>();
  const waiters: Array<() => void> = [];
  ws.addEventListener('message', (e) => {
    log.push(JSON.parse(e.data as string) as ServerMsg);
    for (const wake of waiters.splice(0)) wake();
  });

  const find = <T extends ServerMsg['type']>(type: T, where?: (m: MsgOf<T>) => boolean): MsgOf<T> | undefined => {
    for (let i = 0; i < log.length; i++) {
      const m = log[i]!;
      if (taken.has(i) || m.type !== type) continue;
      if (where && !where(m as MsgOf<T>)) continue;
      taken.add(i);
      return m as MsgOf<T>;
    }
    return undefined;
  };

  const client: TestClient = {
    ws,
    log,
    id: '',
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: (type, timeoutMs = 2000, where) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for '${type}'; got ${JSON.stringify(log.map((m) => m.type))}`));
        }, timeoutMs);
        const check = () => {
          const found = find(type, where);
          if (found) {
            clearTimeout(timer);
            resolve(found);
          } else {
            waiters.push(check);
          }
        };
        check();
      }),
    all: (type) => log.filter((m) => m.type === type) as never,
    close: () => {
      open.delete(client);
      try {
        ws.close(1000, 'done');
      } catch {
        // already closed
      }
    },
  };
  open.add(client);
  return client;
}

/** Sends hello and waits for the snapshot; sets client.id. */
export async function hello(client: TestClient, name: string): Promise<MsgOf<'snapshot'>> {
  client.send({ type: 'hello', clientId: `client-${name}`, profile: defaultProfile(name) });
  const snap = await client.next('snapshot');
  client.id = snap.you;
  return snap;
}

/** Polls until check() returns true. */
export async function waitFor(check: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Closes every client opened by openClient (call in afterEach). */
export function closeAll(): void {
  for (const c of [...open]) c.close();
}
