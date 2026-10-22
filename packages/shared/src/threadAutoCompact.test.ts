import { describe, expect, it } from "vite-plus/test";

import {
  autoCompactTokensBelowWindow,
  resolveDesiredAppliedAutoCompactTokens,
  resolveEffectiveAutoCompactTokens,
} from "./threadAutoCompact.ts";

const range = { minTokens: 100_000, maxTokens: 1_000_000 };

describe("resolveEffectiveAutoCompactTokens", () => {
  it.each([
    { stored: null, windowTokens: 1_000_000, expected: null, why: "Default" },
    { stored: undefined, windowTokens: null, expected: null, why: "Default" },
    { stored: 300_000, windowTokens: 1_000_000, expected: 300_000, why: "in range" },
    { stored: 50_000, windowTokens: 1_000_000, expected: 100_000, why: "clamped up to min" },
    { stored: 2_000_000, windowTokens: null, expected: 1_000_000, why: "clamped down to max" },
    { stored: 200_000, windowTokens: 200_000, expected: null, why: "at the window" },
    { stored: 400_000, windowTokens: 272_000, expected: null, why: "above the window" },
    { stored: 199_999, windowTokens: 200_000, expected: 199_999, why: "just below the window" },
    { stored: 300_000, windowTokens: 0, expected: 300_000, why: "non-positive window is unknown" },
  ])(
    "$why: $stored with window $windowTokens → $expected",
    ({ stored, windowTokens, expected }) => {
      expect(resolveEffectiveAutoCompactTokens({ stored, range, windowTokens })).toBe(expected);
    },
  );
});

describe("resolveDesiredAppliedAutoCompactTokens", () => {
  it.each([
    { stored: null, windowTokens: 1_000_000, defaultTokens: 300_000, expected: 300_000 },
    { stored: null, windowTokens: 1_000_000, defaultTokens: undefined, expected: null },
    { stored: 250_000, windowTokens: 1_000_000, defaultTokens: 300_000, expected: 250_000 },
    { stored: 400_000, windowTokens: 200_000, defaultTokens: 150_000, expected: 150_000 },
    { stored: 400_000, windowTokens: 200_000, defaultTokens: undefined, expected: null },
    { stored: null, windowTokens: 200_000, defaultTokens: 300_000, expected: null },
    { stored: null, windowTokens: 200_000, defaultTokens: 200_000, expected: null },
    { stored: 400_000, windowTokens: 200_000, defaultTokens: 300_000, expected: null },
    { stored: null, windowTokens: null, defaultTokens: 300_000, expected: 300_000 },
  ])(
    "$stored with window $windowTokens and default $defaultTokens → $expected",
    ({ stored, windowTokens, defaultTokens, expected }) => {
      expect(
        resolveDesiredAppliedAutoCompactTokens({ stored, range, windowTokens, defaultTokens }),
      ).toBe(expected);
    },
  );
});

describe("autoCompactTokensBelowWindow", () => {
  it.each([
    { tokens: null, windowTokens: 258_400, expected: null, why: "no value" },
    { tokens: 300_000, windowTokens: 258_400, expected: null, why: "above the window" },
    { tokens: 258_400, windowTokens: 258_400, expected: null, why: "at the window" },
    { tokens: 200_000, windowTokens: 258_400, expected: 200_000, why: "below the window" },
    { tokens: 300_000, windowTokens: null, expected: 300_000, why: "unknown window" },
    { tokens: 300_000, windowTokens: 0, expected: 300_000, why: "non-positive window" },
  ])(
    "$why: $tokens with window $windowTokens → $expected",
    ({ tokens, windowTokens, expected }) => {
      expect(autoCompactTokensBelowWindow({ tokens, windowTokens })).toBe(expected);
    },
  );
});
