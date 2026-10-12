import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  EMPTY_USAGE_HISTORY,
  applyUsageLimitsUpdate,
  attachUsageHistory,
  recordUsageSamples,
  resolveUsageLimitsAfterProbe,
} from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});

describe("usage history", () => {
  const R1 = "2026-09-03T14:00:00.000Z";
  const T0 = "2026-09-03T12:00:00.000Z";
  const at = (seconds: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.parse(T0) + seconds * 1000));
  const sessionWindow = (
    usedPercent: number,
    resetsAt: string | null = R1,
    id = "five_hour",
  ): ServerProviderUsageWindow => ({
    id,
    kind: "session",
    label: id,
    usedPercent,
    windowDurationMins: 300,
    ...(resetsAt === null ? {} : { resetsAt }),
  });
  const limitsOf = (...windows: ServerProviderUsageWindow[]): ServerProviderUsageLimits => ({
    checkedAt: T0,
    windows,
  });
  const ids = (...values: string[]) => new Set(values);
  const record = (
    history: ReturnType<typeof recordUsageSamples>,
    window: ServerProviderUsageWindow,
    when: string,
  ) =>
    recordUsageSamples({
      history,
      limits: limitsOf(window),
      windowIds: ids(window.id),
      at: when,
    });
  const samplesOf = (history: ReturnType<typeof recordUsageSamples>, id = "five_hour") =>
    history.get(id)?.samples;

  describe("recordUsageSamples", () => {
    it("starts a list for a session window without touching the input history", () => {
      const next = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(next.get("five_hour")).toEqual({
        resetsAt: R1,
        samples: [{ at: T0, usedPercent: 40 }],
      });
      expect(EMPTY_USAGE_HISTORY.size).toBe(0);
    });

    it("skips an unchanged value inside the heartbeat and appends it from 60 s on", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(record(first, sessionWindow(40), at(30))).toBe(first);
      expect(record(first, sessionWindow(40), at(59.999))).toBe(first);
      expect(samplesOf(record(first, sessionWindow(40), at(60)))).toHaveLength(2);
    });

    it("appends a changed value regardless of the heartbeat", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(samplesOf(record(first, sessionWindow(41), at(5)))).toEqual([
        { at: T0, usedPercent: 40 },
        { at: at(5), usedPercent: 41 },
      ]);
    });

    it("records a lower reading of the same window at the previous value", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(24), T0);
      expect(record(first, sessionWindow(23), at(30))).toBe(first);
      expect(samplesOf(record(first, sessionWindow(23), at(61)))).toEqual([
        { at: T0, usedPercent: 24 },
        { at: at(61), usedPercent: 24 },
      ]);
    });

    it("holds a runtime reading of any size below the window's high-water mark", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(30), T0);
      expect(record(first, sessionWindow(25), at(5))).toBe(first);
      expect(samplesOf(record(first, sessionWindow(25), at(61)))?.at(-1)?.usedPercent).toBe(30);
    });

    it("records a probe's drop of more than a point as is (a rolling window aging out)", () => {
      const probe = (history: ReturnType<typeof recordUsageSamples>, used: number, when: string) =>
        recordUsageSamples({
          history,
          limits: limitsOf(sessionWindow(used)),
          windowIds: undefined,
          at: when,
        });
      const first = probe(EMPTY_USAGE_HISTORY, 30, T0);
      const held = probe(first, 29.2, at(61));
      expect(samplesOf(held)?.at(-1)?.usedPercent).toBe(30);
      expect(samplesOf(probe(held, 28.9, at(122)))?.at(-1)?.usedPercent).toBe(28.9);
    });

    it("keeps concurrent threads' stale readings out of the history", () => {
      // Claude rate-limit events from several threads, 2026-10-12 17:54:18 onward: a thread
      // whose last API call was earlier reports 43 between the live 48 and 49.
      const readings: ReadonlyArray<readonly [number, number]> = [
        [0, 48],
        [16, 43],
        [21, 49],
        [54, 50],
        [56, 49],
        [87, 51],
      ];
      let history = EMPTY_USAGE_HISTORY;
      for (const [seconds, used] of readings) {
        history = record(history, sessionWindow(used), at(seconds));
      }
      expect(samplesOf(history)).toEqual([
        { at: T0, usedPercent: 48 },
        { at: at(21), usedPercent: 49 },
        { at: at(54), usedPercent: 50 },
        { at: at(87), usedPercent: 51 },
      ]);
    });

    it("records a lower reading as is when the window has no reset", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(24, null), T0);
      expect(samplesOf(record(first, sessionWindow(23, null), at(5)))?.at(-1)).toEqual({
        at: at(5),
        usedPercent: 23,
      });
    });

    it("restarts the list when the reset moves to a new window", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      const next = record(first, sessionWindow(41, "2026-09-03T19:00:00.000Z"), at(5));
      expect(next.get("five_hour")).toEqual({
        resetsAt: "2026-09-03T19:00:00.000Z",
        samples: [{ at: at(5), usedPercent: 41 }],
      });
    });

    it.each([
      ["2026-09-03T14:00:00.500Z", 2],
      ["2026-09-03T14:00:59.000Z", 2],
      ["2026-09-03T14:01:01.000Z", 1],
    ])("treats a reset of %s as %i sample(s) of history", (resetsAt, length) => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(samplesOf(record(first, sessionWindow(41, resetsAt), at(5)))).toHaveLength(length);
    });

    it("records session windows only", () => {
      const next = recordUsageSamples({
        history: EMPTY_USAGE_HISTORY,
        limits: limitsOf(sessionWindow(40), weekly),
        windowIds: ids("five_hour", "seven_day"),
        at: T0,
      });
      expect([...next.keys()]).toEqual(["five_hour"]);
    });

    it("records only the carried ids and leaves other entries alone", () => {
      const both = limitsOf(sessionWindow(40), sessionWindow(10, R1, "other_session"));
      const seeded = recordUsageSamples({
        history: EMPTY_USAGE_HISTORY,
        limits: both,
        windowIds: ids("five_hour", "other_session"),
        at: T0,
      });
      const next = recordUsageSamples({
        history: seeded,
        limits: limitsOf(sessionWindow(45), sessionWindow(11, R1, "other_session")),
        windowIds: ids("five_hour"),
        at: at(10),
      });
      expect(samplesOf(next)).toHaveLength(2);
      expect(next.get("other_session")).toBe(seeded.get("other_session"));
    });

    it("drops lists of windows a full read no longer reports", () => {
      const seeded = recordUsageSamples({
        history: EMPTY_USAGE_HISTORY,
        limits: limitsOf(sessionWindow(40), sessionWindow(10, R1, "gone")),
        windowIds: ids("five_hour", "gone"),
        at: T0,
      });
      const next = recordUsageSamples({
        history: seeded,
        limits: limitsOf(sessionWindow(42)),
        windowIds: undefined,
        at: at(10),
      });
      expect([...next.keys()]).toEqual(["five_hour"]);
      expect(samplesOf(next)).toHaveLength(2);
      expect(
        recordUsageSamples({
          history: seeded,
          limits: undefined,
          windowIds: undefined,
          at: at(10),
        }).size,
      ).toBe(0);
    });

    it("keeps the newest 400 samples", () => {
      let history = EMPTY_USAGE_HISTORY;
      for (let index = 0; index < 405; index += 1) {
        history = record(history, sessionWindow(10 + (index % 2)), at(index * 61));
      }
      const samples = samplesOf(history)!;
      expect(samples).toHaveLength(400);
      expect(samples[0]?.at).toBe(at(5 * 61));
      expect(samples.at(-1)?.at).toBe(at(404 * 61));
    });

    it("stamps a late sample with the last sample's time so the list stays ascending", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(samplesOf(record(first, sessionWindow(41), at(-10)))).toEqual([
        { at: T0, usedPercent: 40 },
        { at: T0, usedPercent: 41 },
      ]);
    });

    it("ignores an unparseable time but still prunes on a full read", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(record(first, sessionWindow(41), "not a date")).toBe(first);
      const pruned = recordUsageSamples({
        history: first,
        limits: limitsOf(weekly),
        windowIds: undefined,
        at: "not a date",
      });
      expect(pruned.size).toBe(0);
    });

    it("treats a missing reset as one window until a reset appears", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40, null), T0);
      const second = record(first, sessionWindow(41, null), at(5));
      expect(samplesOf(second)).toHaveLength(2);
      expect(samplesOf(record(second, sessionWindow(42, R1), at(10)))).toHaveLength(1);
    });

    it("returns the same history for an empty id set", () => {
      const first = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
      expect(
        recordUsageSamples({
          history: first,
          limits: limitsOf(sessionWindow(50)),
          windowIds: new Set(),
          at: at(10),
        }),
      ).toBe(first);
    });
  });

  describe("attachUsageHistory", () => {
    const seeded = record(EMPTY_USAGE_HISTORY, sessionWindow(40), T0);
    const samples = samplesOf(seeded)!;

    it("attaches the entry's samples to session windows only", () => {
      const limits = limitsOf(sessionWindow(40), weekly);
      const next = attachUsageHistory(limits, seeded)!;
      expect(next.windows[0]?.history).toBe(samples);
      expect(next.windows[1]).toBe(weekly);
      expect("history" in next.windows[1]!).toBe(false);
    });

    it("returns the same object when nothing changes", () => {
      const noEntry = limitsOf(sessionWindow(40));
      expect(attachUsageHistory(noEntry, EMPTY_USAGE_HISTORY)).toBe(noEntry);
      const attached = limitsOf({ ...sessionWindow(40), history: samples });
      expect(attachUsageHistory(attached, seeded)).toBe(attached);
    });

    it("raises a lagging reading to the newest sample of the same window", () => {
      const next = attachUsageHistory(limitsOf(sessionWindow(39)), seeded)!;
      expect(next.windows[0]).toEqual({ ...sessionWindow(40), history: samples });
    });

    it("raises a stale reading of any size to the newest sample", () => {
      const next = attachUsageHistory(limitsOf(sessionWindow(35)), seeded)!;
      expect(next.windows[0]?.usedPercent).toBe(40);
    });

    it("publishes a drop the history recorded", () => {
      const dropped = recordUsageSamples({
        history: seeded,
        limits: limitsOf(sessionWindow(38.9)),
        windowIds: undefined,
        at: at(61),
      });
      const next = attachUsageHistory(limitsOf(sessionWindow(38.9)), dropped)!;
      expect(next.windows[0]?.usedPercent).toBe(38.9);
    });

    it("leaves a reading alone when the sample belongs to another or unknown reset", () => {
      const moved = attachUsageHistory(
        limitsOf(sessionWindow(39.5, "2026-09-03T19:00:00.000Z")),
        seeded,
      )!;
      expect(moved.windows[0]?.usedPercent).toBe(39.5);
      const noReset = record(EMPTY_USAGE_HISTORY, sessionWindow(40, null), T0);
      const unknown = attachUsageHistory(limitsOf(sessionWindow(39.5, null)), noReset)!;
      expect(unknown.windows[0]?.usedPercent).toBe(39.5);
    });

    it("removes stale history from session and non-session windows", () => {
      const stale = [{ at: T0, usedPercent: 1 }];
      const next = attachUsageHistory(
        limitsOf({ ...sessionWindow(40), history: stale }, { ...weekly, history: stale }),
        EMPTY_USAGE_HISTORY,
      )!;
      expect(next.windows.some((window) => "history" in window)).toBe(false);
    });

    it("preserves the other limits fields", () => {
      const limits: ServerProviderUsageLimits = {
        ...limitsOf(sessionWindow(40)),
        credentialFingerprint: "fp",
        resetCredits: { availableCount: 1 },
        unavailable: { reason: "probeFailed" },
      };
      const next = attachUsageHistory(limits, seeded)!;
      expect(next).toMatchObject({
        credentialFingerprint: "fp",
        resetCredits: { availableCount: 1 },
        unavailable: { reason: "probeFailed" },
      });
    });

    it("passes undefined through", () => {
      expect(attachUsageHistory(undefined, seeded)).toBeUndefined();
    });
  });
});
