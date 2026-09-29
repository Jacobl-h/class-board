import { SLOT_COUNT } from '@class-board/shared/constants';
import type { Person, ServerMsg, SlotIndex, TileView } from '@class-board/shared/types';
import type { BoardStateApi, BoardStateEvents } from '../contracts';

function placeholder(slot: SlotIndex): TileView {
  return {
    slot, version: 0, kind: 'empty', label: '', url: null, embedUrl: null, fileUrl: null, title: null,
    icon: null, embeddable: 'no', note: null, shotUrl: null, authorName: null, createdAt: null,
  };
}

const isSlot = (n: unknown): n is SlotIndex => Number.isInteger(n) && (n as number) >= 0 && (n as number) < SLOT_COUNT;

export function createBoardState(board: string): BoardStateApi {
  // A small emitter of its own: this task runs in the same wave as the one that writes util/emitter.ts.
  const listeners = new Map<keyof BoardStateEvents, Set<(payload: never) => void>>();
  const events = {
    on<K extends keyof BoardStateEvents>(event: K, fn: (payload: BoardStateEvents[K]) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit<K extends keyof BoardStateEvents>(
      event: K,
      ...payload: undefined extends BoardStateEvents[K] ? [payload?: BoardStateEvents[K]] : [payload: BoardStateEvents[K]]
    ): void {
      // Copy first: a listener may unsubscribe while we iterate.
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          (fn as (p: unknown) => void)(payload[0]);
        } catch (err) {
          console.error(`Listener for "${event}" threw`, err);
        }
      }
    },
  };
  // Arrays are replaced, never mutated, so callers can compare references to detect a change.
  let tiles: readonly TileView[] = Array.from({ length: SLOT_COUNT }, (_, slot) => placeholder(slot));
  let people: readonly Person[] = [];
  let you: string | null = null;
  let locked = false;
  let rate = 5;
  let ready = false;

  const api: BoardStateApi = {
    board: () => board,
    you: () => you,
    locked: () => locked,
    rate: () => rate,
    ready: () => ready,
    tiles: () => tiles,
    tile: (slot) => tiles[slot] ?? placeholder(slot),
    people: () => people,
    person: (id) => people.find((p) => p.id === id),
    me: () => (you === null ? undefined : people.find((p) => p.id === you)),
    on: events.on,
    apply(msg: ServerMsg) {
      switch (msg.type) {
        case 'snapshot': {
          const next = Array.from({ length: SLOT_COUNT }, (_, slot) => placeholder(slot));
          for (const view of msg.tiles) if (isSlot(view.slot)) next[view.slot] = view;
          tiles = next;
          people = [...msg.people];
          you = msg.you;
          locked = msg.locked;
          rate = msg.rate;
          ready = true;
          // A reconnect snapshot can change any of these, so listeners of the narrower events hear about it too.
          // 'snapshot' goes last, once every listener can read a consistent state.
          events.emit('locked', locked);
          events.emit('rate', rate);
          events.emit('people');
          events.emit('snapshot');
          break;
        }
        case 'tile': {
          if (!isSlot(msg.view.slot)) break;
          const next = tiles.slice();
          next[msg.view.slot] = msg.view;
          tiles = next;
          events.emit('tile', msg.view);
          break;
        }
        case 'person': {
          const i = people.findIndex((p) => p.id === msg.person.id);
          if (i === -1) people = [...people, msg.person];
          else people = people.map((p, j) => (j === i ? msg.person : p));
          events.emit('people');
          break;
        }
        case 'personLeft': {
          if (!people.some((p) => p.id === msg.id)) break;
          people = people.filter((p) => p.id !== msg.id);
          events.emit('people');
          break;
        }
        case 'locked':
          locked = msg.locked;
          events.emit('locked', locked);
          break;
        case 'rate':
          rate = msg.hz;
          events.emit('rate', rate);
          break;
        case 'cursors':
          events.emit('cursors', msg.moves);
          break;
        // ok, historyResult and error answer requests; the socket settles those.
        default:
          break;
      }
    },
  };
  return api;
}
