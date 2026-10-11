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
  contextFraction,
  contextTier,
  formatBurn,
  formatWorkHours,
  parseWorkHours,
  resolveWorkSchedule,
  roundBurn,
  scheduleWeight,
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
