// @effect-diagnostics globalDate:off -- Schedule weighting and clock labels read the viewer's local calendar fields.
/**
 * Pure usage-pacing maths shared by web (and later mobile): burn projection, work-schedule
 * weighting, context tiers, prompt-cache warmth and their formatters. Ported from the
 * Claude Code statusline; no React, no I/O, no timers.
 *
 * @module usagePacing
 */

// ---- burn colour ladder -----------------------------------------------------------

export type PaceTier = 0 | 1 | 2 | 3;

export const BURN_TIER_YELLOW = 1.15;
export const BURN_TIER_ORANGE = 1.3;

// +1e-9 nudges a mathematically-exact tenths tie (e.g. 13.5) that floating point
// computes one ULP low (13.499999999999998) back up to the tie before rounding, so it
// lands on 14 as it should instead of silently falling to 13 and flipping a colour-tier
// boundary. 1e-9 is far above float error (~1e-15) and far below the 0.5 tie gap, so it
// cannot change any other rounding outcome.
export const roundBurn = (x: number): number => Math.round(x * 10 + 1e-9) / 10;

// `greenCut` and `exponent` carry the session model's dynamic cutoffs, which widen the bands
// early in a window when little has elapsed and the projection is correspondingly noisy.
// The weekly model has no such correction and is the degenerate case: greenCut 1.0,
// exponent 1.
//
// Callers pass the *rounded* burn. Tiering off the same number that is displayed is what
// keeps the colour and the digits telling one story; tiering off the unrounded value can
// print 1.1x in green because 1.05 was still under the cutoff.
export function burnTier(burn: number, greenCut = 1.0, exponent = 1): PaceTier {
  const yellowCut =
    exponent === 1 ? BURN_TIER_YELLOW : Math.exp(Math.log(BURN_TIER_YELLOW) * exponent);
  const orangeCut =
    exponent === 1 ? BURN_TIER_ORANGE : Math.exp(Math.log(BURN_TIER_ORANGE) * exponent);
  return burn <= greenCut ? 0 : burn <= yellowCut ? 1 : burn <= orangeCut ? 2 : 3;
}

/** Semantic colour names; the web maps them to classes. Not CSS. */
export type PaceTierColor = "success" | "yellow" | "orange" | "destructive" | "muted";

export const BURN_TIER_COLORS: Readonly<Record<PaceTier, PaceTierColor>> = {
  0: "success",
  1: "yellow",
  2: "orange",
  3: "destructive",
};

export const CONTEXT_TIER_COLORS: Readonly<Record<PaceTier, PaceTierColor>> = {
  0: "muted",
  1: "yellow",
  2: "orange",
  3: "destructive",
};

/** "1.2x" */
export function formatBurn(burn: number): string {
  return `${burn.toFixed(1)}x`;
}

// ---- context tier -----------------------------------------------------------------

function maxTier(a: PaceTier, b: PaceTier): PaceTier {
  return a >= b ? a : b;
}

/**
 * max(% tier, token tier); % tier only when maxTokens > 0. Percentage: >=80 red, >=65 orange,
 * >=50 yellow. Tokens: >=400k red, >=300k orange, >=200k yellow.
 */
export function contextTier(usage: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}): PaceTier {
  const used = Number.isFinite(usage.usedTokens) && usage.usedTokens > 0 ? usage.usedTokens : 0;
  const tokenTier: PaceTier = used >= 400_000 ? 3 : used >= 300_000 ? 2 : used >= 200_000 ? 1 : 0;
  const max = usage.maxTokens;
  if (max === null || max === undefined || !(max > 0)) return tokenTier;
  // used / max * 100 >= T  <=>  used * 100 >= T * max; exact for integer token counts.
  const percentTier: PaceTier =
    used * 100 >= 80 * max ? 3 : used * 100 >= 65 * max ? 2 : used * 100 >= 50 * max ? 1 : 0;
  return maxTier(percentTier, tokenTier);
}

/** used / max clamped 0..1; null when maxTokens is missing or <= 0 (track only, no arc). */
export function contextFraction(usage: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}): number | null {
  const max = usage.maxTokens;
  if (max === null || max === undefined || !Number.isFinite(max) || max <= 0) return null;
  const used = Number.isFinite(usage.usedTokens) && usage.usedTokens > 0 ? usage.usedTokens : 0;
  return Math.min(1, used / max);
}

// ---- work schedule ----------------------------------------------------------------

export interface WorkHours {
  /** Minutes past local midnight, 0..1439. */
  readonly startMin: number;
  /** Exclusive end, 1..1440 (1440 = midnight). endMin <= startMin wraps past midnight. */
  readonly endMin: number;
}

export interface WorkSchedule extends WorkHours {
  /** Weekday ints, 0 = Sunday .. 6 = Saturday (matches scheduledTask.ts weekdays). */
  readonly workDays: ReadonlyArray<number>;
  /** Weight of a work-day second outside work hours, 0..1. Non-work days weigh 0. */
  readonly offHoursWeight: number;
}

export const DEFAULT_WORK_HOURS = "09:00-17:00";
export const DEFAULT_WORK_DAYS: ReadonlyArray<number> = [1, 2, 3, 4, 5];
export const DEFAULT_OFF_HOURS_WEIGHT = 0.2;

// What DEFAULT_WORK_HOURS parses to; a test keeps the two in agreement.
const DEFAULT_WORK_HOURS_PARSED: WorkHours = { startMin: 540, endMin: 1020 };

const WORK_HOURS_PATTERN = /^(\d{1,2})(?::([0-5]\d))?-(\d{1,2})(?::([0-5]\d))?$/;

/**
 * "HH:MM-HH:MM", minutes optional ("9-17"), "24:00" legal as an end; an end of "00:00"
 * normalises to 1440; a start of "24:00" or any value > 1440 is null; null when malformed.
 */
export function parseWorkHours(value: string): WorkHours | null {
  const match = WORK_HOURS_PATTERN.exec(value.trim());
  if (!match) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2] ?? 0);
  const rawEndMin = Number(match[3]) * 60 + Number(match[4] ?? 0);
  if (startMin >= 1440 || rawEndMin > 1440) return null;
  // "22:00-00:00" means "until midnight"; under the wrap rule it covers the same seconds as 1440.
  return { startMin, endMin: rawEndMin === 0 ? 1440 : rawEndMin };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Inverse of parseWorkHours, zero-padded "HH:MM-HH:MM"; endMin 1440 prints "24:00". */
export function formatWorkHours(hours: WorkHours): string {
  const clock = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  return `${clock(hours.startMin)}-${clock(hours.endMin)}`;
}

/**
 * Settings -> schedule. Malformed workHours falls back to 09:00-17:00 for that field alone;
 * workDays keeps unique integers 0..6; offHoursWeight is clamped to 0..1 (NaN -> 0.2).
 */
export function resolveWorkSchedule(settings: {
  readonly workHours: string;
  readonly workDays: ReadonlyArray<number>;
  readonly offHoursWeight: number;
}): WorkSchedule {
  const hours = parseWorkHours(settings.workHours) ?? DEFAULT_WORK_HOURS_PARSED;
  const workDays = [
    ...new Set(settings.workDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)),
  ].sort((a, b) => a - b);
  const weight = settings.offHoursWeight;
  const offHoursWeight = Number.isNaN(weight)
    ? DEFAULT_OFF_HOURS_WEIGHT
    : Math.min(1, Math.max(0, weight));
  return { startMin: hours.startMin, endMin: hours.endMin, workDays, offHoursWeight };
}

// Minutes past local midnight on a local calendar day, as epoch seconds. The Date constructor
// normalises an out-of-range minute (1440 = next local midnight) BEFORE resolving the zone,
// which keeps 23- and 25-hour DST days correct.
function localMin(y: number, m: number, d: number, min: number): number {
  return new Date(y, m, d, 0, min, 0, 0).getTime() / 1000;
}

function overlap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

/**
 * Weighted seconds in [fromSec, toSec), local time, walking local calendar days (DST-safe).
 * Do not simplify to `cursor += 86400`: DST days are 23 or 25 hours long.
 */
export function scheduleWeight(fromSec: number, toSec: number, schedule: WorkSchedule): number {
  if (!(toSec > fromSec)) return 0;
  let total = 0;
  let cursor = fromSec;
  while (cursor < toSec) {
    const d = new Date(cursor * 1000);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const segEnd = Math.min(localMin(y, m, day, 1440), toSec);
    if (schedule.workDays.includes(d.getDay())) {
      // Every work-day second earns offHoursWeight; work-hours seconds earn the remainder on
      // top, so only the work-hours overlap is needed, not its complement.
      const active =
        schedule.endMin > schedule.startMin
          ? overlap(
              cursor,
              segEnd,
              localMin(y, m, day, schedule.startMin),
              localMin(y, m, day, schedule.endMin),
            )
          : // wraps past midnight (20:00-02:00): this calendar day's head and tail
            overlap(cursor, segEnd, localMin(y, m, day, 0), localMin(y, m, day, schedule.endMin)) +
            overlap(
              cursor,
              segEnd,
              localMin(y, m, day, schedule.startMin),
              localMin(y, m, day, 1440),
            );
      total += schedule.offHoursWeight * (segEnd - cursor) + (1 - schedule.offHoursWeight) * active;
    }
    cursor = segEnd;
  }
  return total;
}
