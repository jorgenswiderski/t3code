// @effect-diagnostics globalDate:off -- Fixtures build local-time instants to exercise DST and zone handling.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  BURN_TIER_COLORS,
  BURN_TIER_ORANGE,
  BURN_TIER_YELLOW,
  CONTEXT_TIER_COLORS,
  burnTier,
  contextFraction,
  contextTier,
  formatBurn,
  roundBurn,
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
