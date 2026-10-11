import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useNowTick } from "./useNowTick";

const T0 = 1_800_000_000_000;

describe("useNowTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mount(interval: number, renders: number[] = []) {
    function Probe() {
      const now = useNowTick(interval);
      renders.push(now);
      return createElement("span", null, String(now));
    }
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(Probe));
    });
    return { renderer: renderer!, renders, last: () => renders[renders.length - 1] };
  }

  it("renders the current time, ticks on the interval and not before", () => {
    const a = mount(30_000);
    expect(a.last()).toBe(T0);
    act(() => vi.advanceTimersByTime(29_999));
    expect(a.last()).toBe(T0);
    act(() => vi.advanceTimersByTime(1));
    expect(a.last()).toBe(T0 + 30_000);
    expect(a.last()).toBe(Date.now());
    act(() => a.renderer.unmount());
  });

  it("shares one timer per interval and stops it after the last unmount", () => {
    const a = mount(30_000);
    const b = mount(30_000);
    expect(vi.getTimerCount()).toBe(1);
    const c = mount(60_000);
    expect(vi.getTimerCount()).toBe(2);
    const cCount = c.renders.length;
    act(() => vi.advanceTimersByTime(30_000));
    expect(a.last()).toBe(T0 + 30_000);
    expect(c.renders.length).toBe(cCount);
    act(() => {
      a.renderer.unmount();
      b.renderer.unmount();
      c.renderer.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads a fresh time after every consumer unmounted", () => {
    const a = mount(30_000);
    act(() => a.renderer.unmount());
    vi.setSystemTime(T0 + 100_000);
    const b = mount(30_000);
    expect(b.last()).toBe(T0 + 100_000);
    act(() => b.renderer.unmount());
  });

  it("keeps the snapshot stable between ticks", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = mount(30_000);
    act(() => vi.advanceTimersByTime(10_000));
    act(() => a.renderer.update(createElement("div")));
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((message) => message.includes("getSnapshot"))).toEqual([]);
    act(() => a.renderer.unmount());
  });
});
