import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  DEFAULT_OFF_HOURS_WEIGHT,
  DEFAULT_WORK_DAYS,
  DEFAULT_WORK_HOURS,
  parseWorkHours,
} from "@t3tools/shared/usagePacing";
import { describe, expect, it } from "vite-plus/test";

import {
  sameWorkDays,
  snapOffHoursWeight,
  workHoursFromTimeInputs,
  workHoursToTimeInputs,
} from "./usagePacingSettings.logic";

describe("workHoursToTimeInputs", () => {
  it.each([
    ["09:00-17:00", "09:00", "17:00"],
    ["9-17", "09:00", "17:00"],
    ["20:00-02:00", "20:00", "02:00"],
    ["00:00-24:00", "00:00", "00:00"],
    ["garbage", "09:00", "17:00"],
    ["", "09:00", "17:00"],
  ])("%j -> %s / %s", (value, start, end) => {
    expect(workHoursToTimeInputs(value)).toEqual({ start, end });
  });
});

describe("workHoursFromTimeInputs", () => {
  it.each([
    ["09:00", "17:00", "09:00-17:00"],
    ["20:00", "02:00", "20:00-02:00"],
    ["09:00", "00:00", "09:00-24:00"],
    ["00:00", "00:00", "00:00-24:00"],
    ["", "17:00", null],
    ["09:00", "", null],
    ["9:0x", "17:00", null],
  ])("%j, %j -> %j", (start, end, expected) => {
    expect(workHoursFromTimeInputs(start, end)).toBe(expected);
  });

  it("round-trips through the parser and the input mapping", () => {
    for (const [start, end] of [
      ["09:00", "17:00"],
      ["20:00", "02:00"],
      ["09:00", "00:00"],
      ["00:00", "00:00"],
    ] as const) {
      const stored = workHoursFromTimeInputs(start, end);
      expect(stored).not.toBeNull();
      expect(parseWorkHours(stored!)).not.toBeNull();
      expect(workHoursToTimeInputs(stored!)).toEqual({ start, end });
    }
  });
});

describe("snapOffHoursWeight", () => {
  it.each([
    [0.2, 0.2],
    [0.12, 0.1],
    [0.31, 0.3],
    [0.15, 0.15],
    [1.5, 1],
    [-1, 0],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ])("%s -> %s", (value, expected) => {
    expect(snapOffHoursWeight(value)).toBe(expected);
  });
});

describe("sameWorkDays", () => {
  it.each([
    [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 1], true],
    [[1, 2, 3, 4, 5], [1, 2, 3, 4], false],
    [[], [], true],
    [[0, 6], [6, 0], true],
  ])("%j vs %j -> %s", (a, b, expected) => {
    expect(sameWorkDays(a, b)).toBe(expected);
  });
});

describe("client setting defaults", () => {
  it("equal the shared usage pacing constants", () => {
    expect(DEFAULT_CLIENT_SETTINGS.usagePacingWorkHours).toBe(DEFAULT_WORK_HOURS);
    expect(DEFAULT_CLIENT_SETTINGS.usagePacingWorkDays).toEqual(DEFAULT_WORK_DAYS);
    expect(DEFAULT_CLIENT_SETTINGS.usagePacingOffHoursWeight).toBe(DEFAULT_OFF_HOURS_WEIGHT);
  });
});
