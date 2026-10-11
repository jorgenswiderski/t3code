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
