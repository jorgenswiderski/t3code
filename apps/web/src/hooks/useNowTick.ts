import { useSyncExternalStore } from "react";

/** Epoch-ms clock refreshed every `intervalMs`. One timer per distinct interval, shared by every
    consumer and stopped when the last one unsubscribes. */
interface TickClock {
  value: number;
  timerId: ReturnType<typeof setInterval> | null;
  readonly listeners: Set<() => void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

const clocks = new Map<number, TickClock>();

function createClock(intervalMs: number): TickClock {
  const clock: TickClock = {
    value: Date.now(),
    timerId: null,
    listeners: new Set(),
    subscribe(listener) {
      if (clock.timerId === null) {
        // First subscriber: the cached value may be up to one interval old.
        clock.value = Date.now();
        clock.timerId = setInterval(() => {
          clock.value = Date.now();
          for (const notify of clock.listeners) notify();
        }, intervalMs);
      }
      clock.listeners.add(listener);
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.timerId !== null) {
          clearInterval(clock.timerId);
          clock.timerId = null;
        }
      };
    },
    getSnapshot() {
      // No timer running (first render, or after a full unmount): refresh once the cached value
      // is a full interval old. While a timer runs the cached value is returned untouched, which
      // useSyncExternalStore requires between change notifications.
      if (clock.timerId === null) {
        const now = Date.now();
        if (now - clock.value >= intervalMs) clock.value = now;
      }
      return clock.value;
    },
  };
  return clock;
}

export function useNowTick(intervalMs: number): number {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
