import type { Unsubscribe } from '../contracts';

export interface Emitter<E extends object> {
  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): Unsubscribe;
  /** Events whose payload type includes undefined (for example `snapshot: undefined`) can be emitted with no payload. */
  emit<K extends keyof E>(event: K, ...payload: undefined extends E[K] ? [payload?: E[K]] : [payload: E[K]]): void;
  clear(): void;
}

export function createEmitter<E extends object>(): Emitter<E> {
  const listeners = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (payload: never) => void);
      return () => {
        listeners.get(event)?.delete(fn as (payload: never) => void);
      };
    },
    emit(event, ...payload) {
      // Copy first: a listener may unsubscribe itself or others while we iterate.
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          (fn as (p: unknown) => void)(payload[0]);
        } catch (err) {
          console.error(`Listener for "${String(event)}" threw`, err);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
