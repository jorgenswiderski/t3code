import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { nowTickClock } from "./useNowTick";

const T0 = 1_800_000_000_000;

describe("nowTickClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the current time, ticks on the interval and not before", () => {
    const clock = nowTickClock(30_000);
    const listener = vi.fn();
    const unsubscribe = clock.subscribe(listener);
    expect(clock.getSnapshot()).toBe(T0);
    vi.advanceTimersByTime(29_999);
    expect(listener).not.toHaveBeenCalled();
    expect(clock.getSnapshot()).toBe(T0);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.getSnapshot()).toBe(T0 + 30_000);
    unsubscribe();
  });

  it("shares one timer per interval and stops it after the last unsubscribe", () => {
    const a = nowTickClock(30_000).subscribe(() => {});
    const b = nowTickClock(30_000).subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);
    const slow = vi.fn();
    const c = nowTickClock(60_000).subscribe(slow);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(30_000);
    expect(nowTickClock(30_000).getSnapshot()).toBe(T0 + 30_000);
    expect(slow).not.toHaveBeenCalled();
    a();
    b();
    c();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads a fresh time after every consumer unsubscribed", () => {
    nowTickClock(45_000).subscribe(() => {})();
    vi.setSystemTime(T0 + 100_000);
    const unsubscribe = nowTickClock(45_000).subscribe(() => {});
    expect(nowTickClock(45_000).getSnapshot()).toBe(T0 + 100_000);
    unsubscribe();
  });

  it("keeps the snapshot stable between ticks", () => {
    const clock = nowTickClock(20_000);
    const unsubscribe = clock.subscribe(() => {});
    const first = clock.getSnapshot();
    vi.advanceTimersByTime(10_000);
    expect(clock.getSnapshot()).toBe(first);
    unsubscribe();
  });
});
