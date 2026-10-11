// @effect-diagnostics globalDate:off -- Schedule weighting and clock labels read the viewer's local calendar fields.
/**
 * Pure usage-pacing maths shared by web (and later mobile): burn projection, work-schedule
 * weighting, context tiers, prompt-cache warmth and their formatters. Ported from the
 * Claude Code statusline; no React, no I/O, no timers.
 *
 * @module usagePacing
 */

import type { ModelSelection, TimestampFormat } from "@t3tools/contracts";

import { copySorted } from "./Array.ts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "./model.ts";
import { formatDuration } from "./usageLimits.ts";

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

// ---- session and weekly burn (epoch seconds) ---------------------------------------

export interface BurnResult {
  /** Rounded to one decimal (roundBurn). */
  readonly burn: number;
  readonly tier: PaceTier;
}

const HALF_LIFE_SEC = 1800;
const IDLE_CAP_SEC = 3600;
const MIN_OBS_SEC = 90;
const FALLBACK_MIN_ELAPSED_SEC = 1800;

/**
 * Port of the statusline's computeBurn: an exponentially recency-weighted rate over the
 * recent samples, falling back to the whole-window average. Deviations from the original:
 * zero samples fall through to the linear used/elapsed fallback instead of null (upstream
 * servers send no history); there is no upper `t <= now` sample filter (a sample's age is
 * clamped >= 0 so client clock skew cannot drop the newest sample); non-finite used -> null.
 */
export function computeSessionBurn(input: {
  readonly nowSec: number;
  readonly usedPercent: number;
  readonly resetsAtSec: number;
  /** Window length. */
  readonly windowSec: number;
  /** Ascending by atSec; already limited to this window by the server. */
  readonly samples: ReadonlyArray<{ readonly atSec: number; readonly usedPercent: number }>;
}): BurnResult | null {
  const { nowSec, usedPercent: u, windowSec } = input;
  if (!Number.isFinite(u)) return null;
  const rem = input.resetsAtSec - nowSec;
  if (!(rem > 0)) return null;

  const rows = input.samples.filter((s) => s.atSec >= nowSec - windowSec);
  const n = rows.length;
  const elapsed = Math.max(windowSec - rem, 1);
  let sumWdu = 0;
  let sumWdt = 0;
  let obs = 0;
  let iv = 0;
  for (let i = n - 1; i >= 1; i--) {
    const cur = rows[i]!;
    const prev = rows[i - 1]!;
    let dt = cur.atSec - prev.atSec;
    const du = cur.usedPercent - prev.usedPercent;
    if (du < -0.1) break; // window boundary or torn read
    if (dt > IDLE_CAP_SEC) break; // no-data gap
    if (dt < 1) dt = 1;
    const age = Math.max(0, nowSec - cur.atSec);
    const w = Math.exp((-Math.log(2) * age) / HALF_LIFE_SEC);
    sumWdu += w * du;
    sumWdt += w * dt;
    obs += dt;
    iv++;
  }
  // current reading below the newest sample: the samples describe a prior window
  if (n > 0 && u < rows[n - 1]!.usedPercent - 0.1) {
    iv = 0;
    obs = 0;
  }

  let rate: number;
  if (iv >= 2 && obs >= MIN_OBS_SEC && sumWdt > 0) rate = sumWdu / sumWdt;
  else if (elapsed >= FALLBACK_MIN_ELAPSED_SEC) rate = u / elapsed;
  else return null;
  if (rate < 0) rate = 0;

  const burnx = (u + rate * rem) / 100;
  if (!(burnx > 0)) return null;

  const remFrac = Math.min(1, Math.max(0, rem / windowSec));
  const greenCut = 1.0 + 0.1 * remFrac;
  const exponent = 1.0 + 2.0 * (1.0 - 10 / (rem / elapsed + 10));
  // Round first, then tier off the value actually displayed (see burnTier).
  const burn = roundBurn(burnx);
  return { burn, tier: burnTier(burn, greenCut, exponent) };
}

/**
 * Elapsed fraction of [resetsAt - windowSec, resetsAt) at now; schedule null = wall clock.
 * Null when now is outside the window or the window weighs 0. May return 0 (window just
 * started inside a non-work stretch); computeWeeklyBurn applies the minimum guard.
 */
export function weeklyElapsedFraction(input: {
  readonly nowSec: number;
  readonly resetsAtSec: number;
  readonly windowSec: number;
  readonly schedule: WorkSchedule | null;
}): number | null {
  const { nowSec, resetsAtSec, windowSec, schedule } = input;
  const start = resetsAtSec - windowSec;
  if (!(resetsAtSec > nowSec && nowSec > start)) return null;
  if (schedule) {
    const denom = scheduleWeight(start, resetsAtSec, schedule);
    if (!(denom > 0)) return null;
    return scheduleWeight(start, nowSec, schedule) / denom;
  }
  return (nowSec - start) / windowSec;
}

/** Port of the statusline's computeWeeklyBurn: roundBurn((used/100)/frac), null when frac < minElapsedFrac (default 0.02). */
export function computeWeeklyBurn(input: {
  readonly nowSec: number;
  readonly usedPercent: number;
  readonly resetsAtSec: number;
  readonly windowSec: number;
  readonly schedule: WorkSchedule | null;
  readonly minElapsedFrac?: number | undefined;
}): BurnResult | null {
  if (!Number.isFinite(input.usedPercent)) return null;
  const frac = weeklyElapsedFraction(input);
  if (frac === null || !(frac > 0) || frac < (input.minElapsedFrac ?? 0.02)) return null;
  // Zero usage blanks the burn. This model has no early-window correction, so it takes
  // burnTier's default ladder.
  const burn = roundBurn(input.usedPercent / 100 / frac);
  if (!(burn > 0)) return null;
  return { burn, tier: burnTier(burn) };
}

// ---- clocks and formatters ---------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

let localeUses12Hour: boolean | undefined;

// Intl decides only 12 vs 24: the spec's examples read `2:40pm`, not Intl's `2:40 PM`. The hour
// cycle depends on the locale alone, so it is resolved once.
function uses12HourClock(format: TimestampFormat): boolean {
  if (format !== "locale") return format === "12-hour";
  localeUses12Hour ??=
    new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
  return localeUses12Hour;
}

/** Clock time in local time: "2:40pm" (12-hour, lowercase, always minutes) or "14:40" (24-hour). */
export function formatClockTime(ms: number, timestampFormat: TimestampFormat): string {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const h = date.getHours();
  const m = date.getMinutes();
  return uses12HourClock(timestampFormat)
    ? `${h % 12 || 12}:${pad2(m)}${h < 12 ? "am" : "pm"}`
    : `${pad2(h)}:${pad2(m)}`;
}

/**
 * windowDurationMins <= 1440 -> formatClockTime; otherwise weekday + hour: "Thu 9am" /
 * "Thu 9:30am" (12-hour), "Thu 09:00" (24-hour). Unknown (undefined or 0) counts as > 1 day.
 */
export function formatResetLabel(
  resetsAtMs: number,
  windowDurationMins: number | undefined,
  timestampFormat: TimestampFormat,
): string {
  if (windowDurationMins !== undefined && windowDurationMins > 0 && windowDurationMins <= 1440) {
    return formatClockTime(resetsAtMs, timestampFormat);
  }
  if (!Number.isFinite(resetsAtMs)) return "";
  const date = new Date(resetsAtMs);
  const weekday = WEEKDAYS[date.getDay()]!;
  const h = date.getHours();
  const m = date.getMinutes();
  if (!uses12HourClock(timestampFormat)) return `${weekday} ${pad2(h)}:${pad2(m)}`;
  const minutes = m === 0 ? "" : `:${pad2(m)}`;
  return `${weekday} ${h % 12 || 12}${minutes}${h < 12 ? "am" : "pm"}`;
}

/** "in " + formatDuration(ms): "in 1h 52m", "in 3d 21h", "in 4m"; ms <= 0 (or non-finite) -> "now"; 0 < ms < 60 s -> "in <1m". */
export function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return "now";
  if (msRemaining < 60_000) return "in <1m";
  return `in ${formatDuration(msRemaining)}`;
}

function compactUnit(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

/** "950", "9.5k", "380k", "1M", "1.5M" (uppercase M; 999_500 must not print "1000k"). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) return `${compactUnit(tokens / 1000)}k`;
  return `${compactUnit(tokens / 1_000_000)}M`;
}

// ---- request identity and cache warmth -----------------------------------------------

export interface RequestIdentity {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly fastMode?: boolean | undefined;
}

export interface CacheUsageInput {
  readonly updatedAt: string;
  readonly promptCacheTtlMs?: number | undefined;
  readonly requestIdentity?: RequestIdentity | undefined;
}

export type CacheWarmth = "unknown" | "cold" | "expiring" | "warm";

export const CACHE_WARN_MS = 600_000;

/**
 * The identity the next request would carry: model = selection.model; effort / fastMode are
 * the raw option values (no default resolution); a field is omitted when unset.
 */
export function requestIdentityFromModelSelection(
  selection: ModelSelection | null | undefined,
): RequestIdentity | null {
  if (!selection) return null;
  const effort = getModelSelectionStringOptionValue(selection, "effort");
  const fastMode = getModelSelectionBooleanOptionValue(selection, "fastMode");
  return {
    model: selection.model,
    ...(effort !== undefined ? { effort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

function sameWhenPresent<T extends string | boolean>(
  a: T | undefined,
  b: T | undefined,
  normalize: (value: T) => T = (value) => value,
): boolean {
  if (a === undefined || b === undefined || a === "" || b === "") return true;
  return normalize(a) === normalize(b);
}

const stripModelVariant = (model: string) => model.replace(/\[.*$/, "");

/** Field absent (or empty string) on either side is skipped; model compares with a trailing "[...]" stripped. */
export function sameRequestIdentity(a: RequestIdentity, b: RequestIdentity): boolean {
  return (
    sameWhenPresent(a.model, b.model, stripModelVariant) &&
    sameWhenPresent(a.effort, b.effort) &&
    sameWhenPresent(a.fastMode, b.fastMode)
  );
}

/** Date.parse(updatedAt) + promptCacheTtlMs; null when either is missing/unparseable. */
export function cacheExpiresAtMs(usage: CacheUsageInput | null | undefined): number | null {
  const ttl = usage?.promptCacheTtlMs;
  if (!usage || ttl === undefined || !Number.isFinite(ttl) || ttl <= 0) return null;
  const updatedAt = Date.parse(usage.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt + ttl : null;
}

/**
 * unknown: no usage, no TTL, or unparseable updatedAt.
 * cold: identity mismatch (skipped when next is null), or nowMs >= expiry.
 * expiring: expiry - nowMs <= min(CACHE_WARN_MS, ttl / 4).
 * warm: otherwise.
 */
export function cacheWarmth(
  usage: CacheUsageInput | null | undefined,
  next: RequestIdentity | null | undefined,
  nowMs: number,
): CacheWarmth {
  const expiry = cacheExpiresAtMs(usage);
  if (usage === null || usage === undefined || expiry === null) return "unknown";
  if (next && !sameRequestIdentity(usage.requestIdentity ?? {}, next)) return "cold";
  if (nowMs >= expiry) return "cold";
  const warn = Math.min(CACHE_WARN_MS, (usage.promptCacheTtlMs ?? 0) / 4);
  return expiry - nowMs <= warn ? "expiring" : "warm";
}

/**
 * "Context 380k / 1M (38%) · Cache warm, expires 3:12pm"; no maxTokens -> "Context 380k";
 * expiring -> "· Cache expiring 3:12pm"; cold -> "· Cache cold"; unknown -> clause omitted.
 * Percent = Math.round(used / max * 100). Clock via formatClockTime.
 */
export function formatThreadContextTooltip(input: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
  readonly warmth: CacheWarmth;
  readonly expiresAtMs: number | null;
  readonly timestampFormat: TimestampFormat;
}): string {
  const { usedTokens, maxTokens, warmth, expiresAtMs, timestampFormat } = input;
  const context =
    maxTokens !== null && maxTokens !== undefined && maxTokens > 0
      ? `Context ${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} (${Math.round((usedTokens / maxTokens) * 100)}%)`
      : `Context ${formatTokenCount(usedTokens)}`;
  const clock = expiresAtMs === null ? "" : ` ${formatClockTime(expiresAtMs, timestampFormat)}`;
  const cache =
    warmth === "warm"
      ? `Cache warm${clock === "" ? "" : `, expires${clock}`}`
      : warmth === "expiring"
        ? `Cache expiring${clock}`
        : warmth === "cold"
          ? "Cache cold"
          : null;
  return cache === null ? context : `${context} \u00b7 ${cache}`;
}

// ---- per-window pace --------------------------------------------------------------

export interface PaceWindowInput {
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
  readonly windowDurationMins?: number | undefined;
  readonly history?:
    | ReadonlyArray<{ readonly at: string; readonly usedPercent: number }>
    | undefined;
}

export interface WindowPace {
  /** Clamped 0..100: the bar fill. */
  readonly usedPercent: number;
  /** Null = blank burn column. */
  readonly burn: number | null;
  /** Null exactly when burn is null. */
  readonly burnTier: PaceTier | null;
  /** 0..1 tick position; null when resetsAt is missing/unparseable or now is outside the window. */
  readonly paceFraction: number | null;
  /** Null when resetsAt is missing/unparseable. */
  readonly resetsAtMs: number | null;
}

// scheduleWeight walks one iteration per local day of the window, so a bogus huge duration
// would stall the UI thread.
const MAX_WINDOW_SEC = 400 * 86_400;

function windowLengthSec(kind: PaceWindowInput["kind"], mins: number | undefined): number {
  const fallback = kind === "session" ? 18_000 : 604_800;
  if (mins === undefined || !Number.isFinite(mins) || mins <= 0) return fallback;
  const sec = mins * 60;
  return sec > MAX_WINDOW_SEC ? fallback : sec;
}

function toSamples(
  history: PaceWindowInput["history"],
): Array<{ atSec: number; usedPercent: number }> {
  const samples: Array<{ atSec: number; usedPercent: number }> = [];
  for (const entry of history ?? []) {
    const atMs = Date.parse(entry.at);
    if (Number.isFinite(atMs)) samples.push({ atSec: atMs / 1000, usedPercent: entry.usedPercent });
  }
  return samples;
}

/**
 * session -> computeSessionBurn over history, tick = wall-clock elapsed fraction;
 * weekly -> computeWeeklyBurn with the schedule, tick = schedule-weighted fraction (the tick is
 *           drawn even while the 0.02 floor suppresses the burn);
 * monthly / other -> computeWeeklyBurn with schedule null, tick = wall-clock fraction.
 * Window length: windowDurationMins * 60, falling back to 18000 (session) or 604800 (others) when
 * the duration is missing, 0, non-finite or above 400 days.
 */
export function computeWindowPace(
  window: PaceWindowInput,
  input: { readonly nowMs: number; readonly schedule: WorkSchedule },
): WindowPace {
  const used = Number.isFinite(window.usedPercent) ? Math.max(0, window.usedPercent) : 0;
  const usedPercent = Math.min(100, used);
  const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) {
    return { usedPercent, burn: null, burnTier: null, paceFraction: null, resetsAtMs: null };
  }
  const nowSec = input.nowMs / 1000;
  const resetsAtSec = resetsAtMs / 1000;
  const windowSec = windowLengthSec(window.kind, window.windowDurationMins);
  // Only the weekly window follows the user's work schedule; the session window is wall-clock.
  const schedule = window.kind === "weekly" ? input.schedule : null;
  const paceFraction = weeklyElapsedFraction({ nowSec, resetsAtSec, windowSec, schedule });
  const result =
    window.kind === "session"
      ? computeSessionBurn({
          nowSec,
          usedPercent: used,
          resetsAtSec,
          windowSec,
          samples: toSamples(window.history),
        })
      : computeWeeklyBurn({ nowSec, usedPercent: used, resetsAtSec, windowSec, schedule });
  return {
    usedPercent,
    burn: result?.burn ?? null,
    burnTier: result?.tier ?? null,
    paceFraction,
    resetsAtMs,
  };
}

// ---- roles and labels -------------------------------------------------------------

export type PaceWindowRole = "session" | "weekly" | "modelScoped" | "other";

// Claude's scoped windows are labelled "Weekly · <display name>" (claudeUsageLimits.ts scopedWindow).
const MODEL_SCOPED_PREFIX = "Weekly \u00b7 ";

/**
 * kind "session" -> "session"; kind "weekly" whose label starts with "Weekly · " ->
 * "modelScoped"; other kind "weekly" -> "weekly"; monthly/other -> "other".
 */
export function paceWindowRole(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
}): PaceWindowRole {
  if (window.kind === "session") return "session";
  if (window.kind === "weekly") {
    return window.label.startsWith(MODEL_SCOPED_PREFIX) ? "modelScoped" : "weekly";
  }
  return "other";
}

/**
 * Header label: modelScoped -> display name ("Fable"); else from windowDurationMins:
 * < 60 -> "<m>m", < 1440 -> "<h>h" ("5h"), else "<d>d" ("7d"); no duration (or 0) -> window.label.
 */
export function paceWindowShortLabel(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
  readonly windowDurationMins?: number | undefined;
}): string {
  if (paceWindowRole(window) === "modelScoped") {
    return window.label.slice(MODEL_SCOPED_PREFIX.length);
  }
  const mins = window.windowDurationMins;
  if (mins === undefined || !Number.isFinite(mins) || mins <= 0) return window.label;
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** Popover title: session with a known duration -> "Session · <short>" (else window.label); weekly -> "Weekly · all models"; modelScoped and other -> window.label. */
export function paceWindowTitle(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
  readonly windowDurationMins?: number | undefined;
}): string {
  const role = paceWindowRole(window);
  if (role === "weekly") return "Weekly \u00b7 all models";
  if (role === "session") {
    const short = paceWindowShortLabel(window);
    return short === window.label ? window.label : `Session \u00b7 ${short}`;
  }
  return window.label;
}

const ROLE_RANK: Readonly<Record<PaceWindowRole, number>> = {
  session: 0,
  weekly: 1,
  modelScoped: 2,
  other: 3,
};

/** Stable order: session, weekly, modelScoped, other; ties by id. */
export function orderPaceWindows<
  T extends { readonly id: string; readonly kind: PaceWindowInput["kind"]; readonly label: string },
>(windows: ReadonlyArray<T>): ReadonlyArray<T> {
  return copySorted(windows, (a, b) => {
    const byRole = ROLE_RANK[paceWindowRole(a)] - ROLE_RANK[paceWindowRole(b)];
    if (byRole !== 0) return byRole;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
