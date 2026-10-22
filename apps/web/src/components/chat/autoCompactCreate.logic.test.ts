import { describe, expect, it } from "vite-plus/test";
import { resolveCreateAutoCompactTokens } from "./autoCompactCreate.logic";

const capability = { minTokens: 100_000, maxTokens: 1_000_000 };

describe("resolveCreateAutoCompactTokens", () => {
  it.each([
    [300_000, capability, { autoCompactTokens: 300_000 }],
    [null, capability, {}],
    [undefined, capability, {}],
    [300_000, undefined, {}],
    [50_000, capability, { autoCompactTokens: 50_000 }],
  ] as const)("draft %s with capability %j", (draftTokens, cap, expected) => {
    expect(resolveCreateAutoCompactTokens({ draftTokens, capability: cap })).toStrictEqual(
      expected,
    );
  });
});
