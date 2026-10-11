// @effect-diagnostics globalDate:off -- Fixtures build local-time instants to exercise DST and zone handling.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  BURN_TIER_COLORS,
  BURN_TIER_ORANGE,
  BURN_TIER_YELLOW,
  CONTEXT_TIER_COLORS,
  DEFAULT_OFF_HOURS_WEIGHT,
  DEFAULT_WORK_DAYS,
  DEFAULT_WORK_HOURS,
  type WorkSchedule,
  burnTier,
  computeSessionBurn,
  computeWeeklyBurn,
  contextFraction,
  contextTier,
  formatBurn,
  formatClockTime,
  formatCountdown,
  formatResetLabel,
  formatTokenCount,
  formatWorkHours,
  parseWorkHours,
  resolveWorkSchedule,
  roundBurn,
  scheduleWeight,
  weeklyElapsedFraction,
} from "./usagePacing.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("roundBurn", () => {
  it.each([
    [1.23, 1.2],
    [1.26, 1.3],
    [1.35, 1.4],
    [0.45, 0.5],
  ])("roundBurn(%s) = %s", (input, expected) => {
    expect(roundBurn(input)).toBe(expected);
  });
});

describe("burnTier", () => {
  it("exposes the yellow and orange cut constants", () => {
    expect(BURN_TIER_YELLOW).toBe(1.15);
    expect(BURN_TIER_ORANGE).toBe(1.3);
  });

  it.each([
    [0.1, 0],
    [1.0, 0],
    [1.1, 1],
    [1.15, 1],
    [1.2, 2],
    [1.3, 2],
    [1.4, 3],
    [1.0000001, 1],
    [1.15 + 1e-9, 2],
    [1.3 + 1e-9, 3],
  ])("burnTier(%s) = %s on the default ladder", (burn, tier) => {
    expect(burnTier(burn)).toBe(tier);
  });

  it.each([
    [1.05, 1.05, 1.0, 0],
    [1.06, 1.05, 1.0, 1],
    [1.2, 1.05, 1.0, 2],
    [1.15, 1.0, 1.5, 1],
    [1.2, 1.0, 1.5, 1],
    [1.3 ** 1.5 + 1e-9, 1.0, 1.5, 3],
  ])("burnTier(%s, greenCut %s, exponent %s) = %s", (burn, greenCut, exponent, tier) => {
    expect(burnTier(burn, greenCut, exponent)).toBe(tier);
  });

  it.each([0.5, 1.0, 1.15, 1.2, 1.3, 1.31, 2.0])(
    "exponent 1 takes the flat-threshold path for %s",
    (burn) => {
      expect(burnTier(burn, 1.0, 1)).toBe(burnTier(burn));
    },
  );
});

describe("palettes and formatBurn", () => {
  it("maps tiers to semantic colour names", () => {
    expect(BURN_TIER_COLORS).toEqual({ 0: "success", 1: "yellow", 2: "orange", 3: "destructive" });
    expect(CONTEXT_TIER_COLORS).toEqual({ 0: "muted", 1: "yellow", 2: "orange", 3: "destructive" });
  });

  it.each([
    [1.2, "1.2x"],
    [1, "1.0x"],
    [0.4, "0.4x"],
    [12, "12.0x"],
  ])("formatBurn(%s) = %s", (burn, expected) => {
    expect(formatBurn(burn)).toBe(expected);
  });
});

describe("contextTier", () => {
  it.each([
    [0, 1_000_000, 0],
    [199_999, 1_000_000, 0],
    [200_000, 1_000_000, 1],
    [300_000, 1_000_000, 2],
    [399_999, 1_000_000, 2],
    [400_000, 1_000_000, 3],
    [99_999, 200_000, 0],
    [100_000, 200_000, 1],
    [129_999, 200_000, 1],
    [130_000, 200_000, 2],
    [159_999, 200_000, 2],
    [160_000, 200_000, 3],
    [49, 100, 0],
    [50, 100, 1],
    [64, 100, 1],
    [65, 100, 2],
    [79, 100, 2],
    [80, 100, 3],
    [250_000, 200_000, 3],
    [199_999, undefined, 0],
    [200_000, null, 1],
    [400_000, 0, 3],
    [1_000_000, null, 3],
    [Number.NaN, 1_000_000, 0],
    [-5, 100, 0],
  ])("contextTier(used %s, max %s) = %s", (usedTokens, maxTokens, tier) => {
    expect(contextTier({ usedTokens, maxTokens })).toBe(tier);
  });
});

describe("contextFraction", () => {
  it.each([
    [380_000, 1_000_000, 0.38],
    [2, 1, 1],
    [-5, 100, 0],
    [5, null, null],
    [5, undefined, null],
    [5, 0, null],
  ])("contextFraction(used %s, max %s) = %s", (usedTokens, maxTokens, expected) => {
    expect(contextFraction({ usedTokens, maxTokens })).toBe(expected);
  });
});

// ---- work schedule ----------------------------------------------------------------

/** Local-time epoch seconds; evaluate inside the test body after any TZ stub. */
const localSec = (y: number, m: number, d: number, h = 0, min = 0) =>
  Math.trunc(new Date(y, m, d, h, min, 0, 0).getTime() / 1000);

const DAY = 86400;
const MON = localSec(2026, 6, 6);
const FRI = localSec(2026, 6, 10);
const SAT = localSec(2026, 6, 11);
const SUN = localSec(2026, 6, 12);
const NEXT_MON = localSec(2026, 6, 13);

const ALL_DAY: WorkSchedule = {
  startMin: 0,
  endMin: 1440,
  offHoursWeight: 0,
  workDays: [1, 2, 3, 4, 5],
};
const WORK_HOURS: WorkSchedule = {
  startMin: 630,
  endMin: 1170,
  offHoursWeight: 0.2,
  workDays: [1, 2, 3, 4, 5],
};

describe("parseWorkHours", () => {
  it.each([
    ["10:30-19:30", { startMin: 630, endMin: 1170 }],
    ["9-17", { startMin: 540, endMin: 1020 }],
    ["09:00-17:00", { startMin: 540, endMin: 1020 }],
    ["00:00-24:00", { startMin: 0, endMin: 1440 }],
    ["20:00-02:00", { startMin: 1200, endMin: 120 }],
    [" 9-17 ", { startMin: 540, endMin: 1020 }],
    ["22:00-00:00", { startMin: 1320, endMin: 1440 }],
    ["00:00-00:00", { startMin: 0, endMin: 1440 }],
    ["09:00-09:00", { startMin: 540, endMin: 540 }],
  ])("parses %j", (input, expected) => {
    expect(parseWorkHours(input)).toEqual(expected);
  });

  it.each([
    "",
    "nonsense",
    "9:99-17:00",
    "25:00-26:00",
    "9-17-19",
    "24:00-02:00",
    "9-25",
    "24:30-25:00",
  ])("rejects %j", (input) => {
    expect(parseWorkHours(input)).toBeNull();
  });
});

describe("formatWorkHours", () => {
  it.each([
    [{ startMin: 540, endMin: 1020 }, "09:00-17:00"],
    [{ startMin: 630, endMin: 1170 }, "10:30-19:30"],
    [{ startMin: 0, endMin: 1440 }, "00:00-24:00"],
    [{ startMin: 1200, endMin: 120 }, "20:00-02:00"],
  ])("prints %j as %s and round-trips", (hours, text) => {
    expect(formatWorkHours(hours)).toBe(text);
    expect(parseWorkHours(text)).toEqual(hours);
  });
});

describe("resolveWorkSchedule", () => {
  const base = { workHours: "9-17", workDays: [1, 2, 3, 4, 5], offHoursWeight: 0.2 };

  it("passes valid settings through", () => {
    expect(
      resolveWorkSchedule({
        workHours: "10:30-19:30",
        workDays: [1, 2, 3, 4, 5],
        offHoursWeight: 0.35,
      }),
    ).toEqual({ startMin: 630, endMin: 1170, workDays: [1, 2, 3, 4, 5], offHoursWeight: 0.35 });
  });

  it("falls back for malformed hours alone", () => {
    expect(resolveWorkSchedule({ ...base, workHours: "nonsense" })).toEqual({
      startMin: 540,
      endMin: 1020,
      workDays: [1, 2, 3, 4, 5],
      offHoursWeight: 0.2,
    });
  });

  it("keeps unique integer weekdays 0..6, sorted", () => {
    expect(resolveWorkSchedule({ ...base, workDays: [5, 1, 1, 7, -1, 2.5, 3] }).workDays).toEqual([
      1, 3, 5,
    ]);
    expect(resolveWorkSchedule({ ...base, workDays: [] }).workDays).toEqual([]);
  });

  it.each([
    [Number.NaN, 0.2],
    [1.5, 1],
    [-1, 0],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 0],
  ])("clamps offHoursWeight %s to %s", (offHoursWeight, expected) => {
    expect(resolveWorkSchedule({ ...base, workDays: [1], offHoursWeight }).offHoursWeight).toBe(
      expected,
    );
  });

  it("exposes defaults that agree with each other", () => {
    expect(DEFAULT_WORK_HOURS).toBe("09:00-17:00");
    expect(DEFAULT_WORK_DAYS).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_OFF_HOURS_WEIGHT).toBe(0.2);
    const resolved = resolveWorkSchedule({
      workHours: "garbage",
      workDays: DEFAULT_WORK_DAYS,
      offHoursWeight: DEFAULT_OFF_HOURS_WEIGHT,
    });
    expect({ startMin: resolved.startMin, endMin: resolved.endMin }).toEqual(
      parseWorkHours(DEFAULT_WORK_HOURS),
    );
  });
});

describe("scheduleWeight with an all-day weekday schedule", () => {
  it("anchors fall on the expected weekdays", () => {
    expect(new Date(MON * 1000).getDay()).toBe(1);
    expect(new Date(SAT * 1000).getDay()).toBe(6);
  });

  it.each([
    ["Mon to Sat", MON, SAT, 5 * DAY],
    ["Mon to next Mon", MON, NEXT_MON, 5 * DAY],
    ["Sat to next Mon", SAT, NEXT_MON, 0],
    ["Mon to 06:00 Mon", MON, localSec(2026, 6, 6, 6), 6 * 3600],
    ["Mon to Sun", MON, SUN, 5 * DAY],
    ["Sat noon to Mon 06:00", localSec(2026, 6, 11, 12), localSec(2026, 6, 13, 6), 6 * 3600],
    ["empty interval", MON, MON, 0],
    ["reversed interval", FRI, MON, 0],
  ])("%s", (_name, from, to, expected) => {
    expect(scheduleWeight(from, to, ALL_DAY)).toBe(expected);
  });

  it("counts a week spanning the US fall-back transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(scheduleWeight(localSec(2026, 9, 26), localSec(2026, 10, 2, 1), ALL_DAY)).toBe(
      5 * DAY + 3600,
    );
  });
});

describe("scheduleWeight with work hours", () => {
  const DAY_WEIGHT = 0.8 * 9 * 3600 + 0.2 * 86400;

  it("weighs a full Monday", () => {
    expect(DAY_WEIGHT).toBe(43200);
    expect(scheduleWeight(MON, localSec(2026, 6, 7), WORK_HOURS)).toBeCloseTo(43200, 6);
  });

  it("weighs a half-hour boundary partial day", () => {
    expect(scheduleWeight(MON, localSec(2026, 6, 6, 12), WORK_HOURS)).toBeCloseTo(12960, 6);
  });

  it("weighs weekends at zero", () => {
    expect(scheduleWeight(SAT, NEXT_MON, WORK_HOURS)).toBe(0);
  });

  it("handles a schedule that wraps past midnight", () => {
    const wrap: WorkSchedule = {
      startMin: 1200,
      endMin: 120,
      offHoursWeight: 0.2,
      workDays: [1, 2, 3, 4, 5],
    };
    expect(scheduleWeight(MON, localSec(2026, 6, 7), wrap)).toBeCloseTo(34560, 6);
  });

  it("treats an off-hours weight of 1 as flat", () => {
    expect(
      scheduleWeight(MON, localSec(2026, 6, 7), { ...WORK_HOURS, offHoursWeight: 1 }),
    ).toBeCloseTo(DAY, 6);
  });

  it("stays correct over the fall-back week", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(scheduleWeight(localSec(2026, 9, 26), localSec(2026, 10, 2, 1), WORK_HOURS)).toBeCloseTo(
      216720,
      6,
    );
  });
});

describe("scheduleWeight with configurable work days", () => {
  it("counts Sun-Thu schedules", () => {
    const sunThu = { ...ALL_DAY, workDays: [0, 1, 2, 3, 4] };
    expect(scheduleWeight(localSec(2026, 6, 5), SUN, sunThu)).toBe(5 * DAY);
    expect(scheduleWeight(FRI, NEXT_MON, sunThu)).toBe(DAY);
  });

  it("weighs an empty work-day set at zero", () => {
    expect(scheduleWeight(MON, NEXT_MON, { ...ALL_DAY, workDays: [] })).toBe(0);
  });

  it("counts a 25-hour work day", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      scheduleWeight(localSec(2026, 10, 1), localSec(2026, 10, 2), { ...ALL_DAY, workDays: [0] }),
    ).toBe(25 * 3600);
  });

  it("counts a 23-hour work day", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      scheduleWeight(localSec(2026, 2, 8), localSec(2026, 2, 9), { ...ALL_DAY, workDays: [0] }),
    ).toBe(23 * 3600);
  });

  it("weighs work hours across the 25-hour day", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      scheduleWeight(localSec(2026, 10, 1), localSec(2026, 10, 2), {
        ...WORK_HOURS,
        workDays: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toBeCloseTo(43920, 6);
  });

  it("weighs work hours across the fall-back week with every day working", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      scheduleWeight(localSec(2026, 9, 26), localSec(2026, 10, 2, 1), {
        ...WORK_HOURS,
        workDays: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toBeCloseTo(303840, 6);
  });
});

// ---- session and weekly burn --------------------------------------------------------

describe("computeSessionBurn", () => {
  const NOW = 1_750_000_000;
  type Sample = { atSec: number; usedPercent: number };

  const run = (samples: ReadonlyArray<Sample>, used: number, reset: number) =>
    computeSessionBurn({
      nowSec: NOW,
      usedPercent: used,
      resetsAtSec: reset,
      windowSec: 18000,
      samples,
    });

  /** Samples at `used`, every `step` seconds, from `spanSec` ago up to now. */
  const flat = (used: number, spanSec: number, step = 60): Sample[] =>
    Array.from({ length: Math.floor(spanSec / step) + 1 }, (_, i) => ({
      atSec: NOW - spanSec + i * step,
      usedPercent: used,
    }));

  const rising = (from: number, count: number): Sample[] =>
    Array.from({ length: count }, (_, i) => ({
      atSec: NOW - (count - 1 - i) * 60,
      usedPercent: from + i,
    }));

  it("reports an idle series as under pace", () => {
    expect(run(flat(40, 3600), 40, NOW + 600)).toEqual({ burn: 0.4, tier: 0 });
  });

  it("falls back to the window average from one old row", () => {
    expect(run([{ atSec: NOW - 9000, usedPercent: 30 }], 30, NOW + 9000)).toEqual({
      burn: 0.6,
      tier: 0,
    });
  });

  it("returns null when it is too early with too little data", () => {
    expect(
      run(
        [
          { atSec: NOW - 60, usedPercent: 5 },
          { atSec: NOW, usedPercent: 6 },
        ],
        6,
        NOW + 17880,
      ),
    ).toBeNull();
  });

  it("stops scanning at an idle-cap gap", () => {
    const rows = [
      [-7200, 5],
      [-7140, 25],
      [-200, 40],
      [-140, 40],
      [-80, 40],
      [-20, 40],
    ].map(([dt, usedPercent]) => ({ atSec: NOW + dt!, usedPercent: usedPercent! }));
    expect(run(rows, 40, NOW + 3600)).toEqual({ burn: 0.4, tier: 0 });
  });

  it("returns null for an expired window", () => {
    expect(run(flat(40, 600), 40, NOW - 10)).toBeNull();
  });

  // Tiering runs off the rounded burn, and the dynamic cutoffs widen early in the window:
  // at 9000 s remaining of 18000 the green cut is 1.05, so 1.05 stays green but 1.1 does not.
  it.each([
    [95, 1, 0],
    [104, 1, 0],
    [105, 1.1, 1],
    [106, 1.1, 1],
    [114, 1.1, 1],
    [115, 1.2, 2],
    [117, 1.2, 2],
    [118, 1.2, 2],
    [124, 1.2, 2],
    [125, 1.3, 2],
    [134, 1.3, 2],
    [135, 1.4, 3],
    [136, 1.4, 3],
    [137, 1.4, 3],
    [144, 1.4, 3],
    [145, 1.5, 3],
    [150, 1.5, 3],
  ])("tier characterization: used %s gives burn %s tier %s", (used, burn, tier) => {
    expect(run(flat(used, 3600), used, NOW + 9000)).toEqual({ burn, tier });
  });

  it("falls back to the linear projection with no samples", () => {
    expect(run([], 30, NOW + 9000)).toEqual({ burn: 0.6, tier: 0 });
  });

  it("stays blank with no samples and little elapsed time", () => {
    expect(run([], 5, NOW + 17880)).toBeNull();
  });

  it("projects a steady rise", () => {
    expect(run(rising(10, 11), 20, NOW + 9000)).toEqual({ burn: 1.7, tier: 3 });
  });

  it("discards history when the current reading is below the newest sample", () => {
    expect(run(rising(10, 11), 19, NOW + 9000)).toEqual({ burn: 0.4, tier: 0 });
  });

  it("stops the scan at a drop", () => {
    const rows = [
      [-600, 90],
      [-540, 10],
      [-480, 12],
      [-420, 14],
      [-360, 16],
    ].map(([dt, usedPercent]) => ({ atSec: NOW + dt!, usedPercent: usedPercent! }));
    expect(run(rows, 16, NOW + 9000)).toEqual({ burn: 3.2, tier: 3 });
  });

  it("clamps a negative rate to zero", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      atSec: NOW - (5 - i) * 60,
      usedPercent: 30 - i * 0.05,
    }));
    expect(run(rows, 29.75, NOW + 9000)).toEqual({ burn: 0.3, tier: 0 });
  });

  it("keeps a sample stamped slightly ahead of the client clock", () => {
    expect(
      run(
        [
          { atSec: NOW - 3000, usedPercent: 10 },
          { atSec: NOW + 5, usedPercent: 20 },
        ],
        20,
        NOW + 9000,
      ),
    ).toEqual({ burn: 0.4, tier: 0 });
  });

  it("returns null for a non-finite reading", () => {
    expect(run(flat(40, 3600), Number.NaN, NOW + 9000)).toBeNull();
  });
});

describe("weeklyElapsedFraction", () => {
  const WED = localSec(2026, 6, 8);
  const base = { resetsAtSec: NEXT_MON, windowSec: 7 * DAY };

  it("weighs elapsed work days", () => {
    expect(weeklyElapsedFraction({ ...base, nowSec: WED, schedule: ALL_DAY })).toBeCloseTo(0.4, 9);
  });

  it("uses the wall clock without a schedule", () => {
    expect(weeklyElapsedFraction({ ...base, nowSec: WED, schedule: null })).toBeCloseTo(2 / 7, 9);
  });

  it.each([
    ["at the reset", NEXT_MON],
    ["at the window start", MON],
  ])("is null %s", (_name, nowSec) => {
    expect(weeklyElapsedFraction({ ...base, nowSec, schedule: ALL_DAY })).toBeNull();
  });

  it("is null for a window entirely inside a weekend", () => {
    expect(
      weeklyElapsedFraction({
        nowSec: localSec(2026, 6, 11, 11),
        resetsAtSec: localSec(2026, 6, 11, 12),
        windowSec: 7200,
        schedule: ALL_DAY,
      }),
    ).toBeNull();
  });

  it("is null with no work days", () => {
    expect(
      weeklyElapsedFraction({ ...base, nowSec: WED, schedule: { ...ALL_DAY, workDays: [] } }),
    ).toBeNull();
  });
});

describe("computeWeeklyBurn", () => {
  const WED = localSec(2026, 6, 8);
  const weekly = (
    usedPercent: number,
    nowSec: number,
    schedule: WorkSchedule | null = ALL_DAY,
    extra: { resetsAtSec?: number; minElapsedFrac?: number } = {},
  ) =>
    computeWeeklyBurn({
      nowSec,
      usedPercent,
      resetsAtSec: extra.resetsAtSec ?? NEXT_MON,
      windowSec: 7 * DAY,
      schedule,
      minElapsedFrac: extra.minElapsedFrac,
    });

  it("projects 20 percent at Wednesday", () => {
    expect(weekly(20, WED)).toEqual({ burn: 0.5, tier: 0 });
  });

  it("freezes the clock on weekends", () => {
    expect(weekly(50, localSec(2026, 6, 11, 12))).toEqual({ burn: 0.5, tier: 0 });
    expect(weekly(50, localSec(2026, 6, 12, 12))).toEqual({ burn: 0.5, tier: 0 });
  });

  it("uses wall-clock time without a schedule", () => {
    expect(weekly(20, WED, null)).toEqual({ burn: 0.7, tier: 0 });
  });

  it.each([
    [40, 1.0, 0],
    [45, 1.1, 1],
    [51, 1.3, 2],
    [60, 1.5, 3],
  ])("tiers %s percent at Wednesday as burn %s tier %s", (used, burn, tier) => {
    expect(weekly(used, WED)).toEqual({ burn, tier });
  });

  it("blanks the burn under the minimum elapsed floor", () => {
    expect(weekly(5, localSec(2026, 6, 6, 1))).toBeNull();
  });

  it("returns null for bad or empty readings", () => {
    expect(weekly(Number.NaN, WED)).toBeNull();
    expect(weekly(0, WED)).toBeNull();
  });

  it("returns null once the reset has passed", () => {
    expect(weekly(20, WED, ALL_DAY, { resetsAtSec: WED - 10 })).toBeNull();
  });

  it("rounds an exact tenths tie up", () => {
    expect(weekly(1, MON + 3200, ALL_DAY, { minElapsedFrac: 0.001 })).toEqual({
      burn: 1.4,
      tier: 3,
    });
  });

  it("returns null when the window has not started", () => {
    expect(weekly(20, MON, ALL_DAY, { resetsAtSec: NEXT_MON + 7 * DAY })).toBeNull();
  });

  it("returns null for a window inside a weekend", () => {
    expect(
      computeWeeklyBurn({
        nowSec: localSec(2026, 6, 11, 11),
        usedPercent: 50,
        resetsAtSec: localSec(2026, 6, 11, 12),
        windowSec: 7200,
        schedule: ALL_DAY,
      }),
    ).toBeNull();
  });

  describe("under work hours", () => {
    const DEFAULT_STYLE: WorkSchedule = {
      startMin: 540,
      endMin: 1020,
      offHoursWeight: 0.2,
      workDays: [1, 2, 3, 4, 5],
    };

    it("shapes the clock around the working day", () => {
      const now = localSec(2026, 6, 8, 12);
      expect(
        weeklyElapsedFraction({
          nowSec: now,
          resetsAtSec: NEXT_MON,
          windowSec: 7 * DAY,
          schedule: DEFAULT_STYLE,
        }),
      ).toBeCloseTo(0.4857142857, 9);
      expect(weekly(40, now, DEFAULT_STYLE)).toEqual({ burn: 0.8, tier: 0 });
    });

    it("reads a full window on Saturday noon", () => {
      const now = localSec(2026, 6, 11, 12);
      expect(
        weeklyElapsedFraction({
          nowSec: now,
          resetsAtSec: NEXT_MON,
          windowSec: 7 * DAY,
          schedule: DEFAULT_STYLE,
        }),
      ).toBeCloseTo(1, 9);
      expect(weekly(50, now, DEFAULT_STYLE)).toEqual({ burn: 0.5, tier: 0 });
    });

    it.each([
      [localSec(2026, 6, 8), 0.6],
      [localSec(2026, 6, 9), 0.8],
      [localSec(2026, 6, 10, 12), 1],
    ])("counts Sun-Thu work days elapsed at %s as %s", (nowSec, expected) => {
      expect(
        weeklyElapsedFraction({
          nowSec,
          resetsAtSec: SUN,
          windowSec: 7 * DAY,
          schedule: { ...ALL_DAY, workDays: [0, 1, 2, 3, 4] },
        }),
      ).toBeCloseTo(expected, 9);
    });
  });

  describe("usage curve against a work-hours schedule", () => {
    const USAGE: WorkSchedule = { ...WORK_HOURS, offHoursWeight: 0 };
    const total = scheduleWeight(MON, NEXT_MON, USAGE);
    const pctAt = (now: number) => (100 * scheduleWeight(MON, now, USAGE)) / total;

    const sweep = (schedule: WorkSchedule, from: number, to: number): number[] => {
      const readings: number[] = [];
      for (let now = from; now < to; now += 1800) {
        const result = computeWeeklyBurn({
          nowSec: now,
          usedPercent: pctAt(now),
          resetsAtSec: NEXT_MON,
          windowSec: 7 * DAY,
          schedule,
        });
        if (result) readings.push(result.burn);
      }
      return readings;
    };

    it("keeps the projection steady once the first day has passed", () => {
      const readings = sweep(WORK_HOURS, MON + DAY, NEXT_MON);
      expect(readings.length).toBeGreaterThan(100);
      expect(Math.min(...readings)).toBeGreaterThan(0.8);
      expect(Math.max(...readings)).toBeLessThan(1.25);
    });

    it("damps the first-day swing compared with a flat clock", () => {
      const swing = (readings: number[]) => Math.max(...readings) / Math.min(...readings);
      const from = localSec(2026, 6, 6, 11);
      const to = localSec(2026, 6, 6, 23);
      expect(swing(sweep(ALL_DAY, from, to))).toBeGreaterThan(8);
      expect(swing(sweep(WORK_HOURS, from, to))).toBeLessThan(5);
    });
  });
});

// ---- clocks and formatters ----------------------------------------------------------

describe("formatClockTime", () => {
  const at = (h: number, m: number) => new Date(2026, 6, 6, h, m).getTime();

  it.each([
    [14, 40, "2:40pm", "14:40"],
    [0, 5, "12:05am", "00:05"],
    [12, 0, "12:00pm", "12:00"],
    [9, 5, "9:05am", "09:05"],
    [23, 59, "11:59pm", "23:59"],
  ])("%s:%s renders as %s / %s", (h, m, twelve, twentyFour) => {
    expect(formatClockTime(at(h, m), "12-hour")).toBe(twelve);
    expect(formatClockTime(at(h, m), "24-hour")).toBe(twentyFour);
  });

  it("returns an empty string for a non-finite instant", () => {
    expect(formatClockTime(Number.NaN, "12-hour")).toBe("");
  });

  it("resolves locale to one of the two styles, consistently", () => {
    const result = formatClockTime(at(14, 40), "locale");
    expect(["2:40pm", "14:40"]).toContain(result);
    expect(formatClockTime(at(14, 40), "locale")).toBe(result);
  });
});

describe("formatResetLabel", () => {
  const thu = (h: number, m: number) => new Date(2026, 6, 9, h, m).getTime();

  it.each([
    [14, 40, 300, "12-hour", "2:40pm"],
    [14, 40, 1440, "12-hour", "2:40pm"],
    [9, 0, 10080, "12-hour", "Thu 9am"],
    [9, 30, 10080, "12-hour", "Thu 9:30am"],
    [12, 0, 10080, "12-hour", "Thu 12pm"],
    [0, 0, 10080, "12-hour", "Thu 12am"],
    [9, 0, 10080, "24-hour", "Thu 09:00"],
    [9, 0, 1441, "12-hour", "Thu 9am"],
    [9, 0, undefined, "12-hour", "Thu 9am"],
    [9, 0, 0, "12-hour", "Thu 9am"],
    [14, 40, 300, "24-hour", "14:40"],
  ] as const)("%s:%s with %s mins in %s is %s", (h, m, mins, format, expected) => {
    expect(formatResetLabel(thu(h, m), mins, format)).toBe(expected);
  });
});

describe("formatCountdown", () => {
  it.each([
    [0, "now"],
    [-5, "now"],
    [Number.NaN, "now"],
    [30_000, "in <1m"],
    [59_999, "in <1m"],
    [60_000, "in 1m"],
    [4 * 60_000, "in 4m"],
    [(1 * 60 + 52) * 60_000, "in 1h 52m"],
    [(3 * 24 + 21) * 3_600_000, "in 3d 21h"],
  ])("%s ms is %s", (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [-1, "0"],
    [Number.NaN, "0"],
    [950, "950"],
    [999, "999"],
    [1000, "1k"],
    [1049, "1k"],
    [9500, "9.5k"],
    [9999, "10k"],
    [10_000, "10k"],
    [199_999, "200k"],
    [200_000, "200k"],
    [380_000, "380k"],
    [999_499, "999k"],
    [999_500, "1M"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
    [9_960_000, "10M"],
    [10_000_000, "10M"],
  ])("%s is %s", (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});
