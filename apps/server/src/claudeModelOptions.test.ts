import { describe, expect, it } from "@effect/vitest";

import { ClaudeSettings, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { Schema } from "effect";

import {
  CLAUDE_AUTO_COMPACT_WINDOW_MAX,
  CLAUDE_AUTO_COMPACT_WINDOW_MIN,
  compileClaudeModelSelection,
  resolveClaudeAutoCompact,
} from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "./provider/ClaudeModelCatalog.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

describe("resolveClaudeAutoCompact", () => {
  const settingsWith = (autoCompactWindow: string) => decodeClaudeSettings({ autoCompactWindow });
  const DEFAULT = decodeClaudeSettings({});
  const I100 = settingsWith("100000");
  const I300 = settingsWith("300000");
  const I990 = settingsWith("990000");
  const I1M = settingsWith("1000000");
  const M1 = "claude-opus-5-5";
  const M200 = "claude-haiku-4-5";

  it("uses bundled models with the expected context windows", () => {
    expect(
      resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, selection(M1, [])),
    ).toBe(1_000_000);
    expect(
      resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, selection(M200, [])),
    ).toBe(200_000);
  });

  const rows: ReadonlyArray<
    readonly [
      name: string,
      stored: number | null,
      model: string,
      settings: ClaudeSettings,
      sdkWindow: number | undefined,
      appliedTokens: number | null,
    ]
  > = [
    ["nothing configured", null, M1, DEFAULT, undefined, null],
    ["instance only (compacts near 300k, not 267k)", null, M1, I300, 333_000, 300_000],
    ["instance 100k", null, M1, I100, 133_000, 100_000],
    ["instance 1M clamps to 967k", null, M1, I1M, 1_000_000, 967_000],
    ["instance 990k clamps to 967k", null, M1, I990, 1_000_000, 967_000],
    ["per-thread wins", 200_000, M1, I300, 233_000, 200_000],
    ["per-thread, no instance", 300_000, M1, DEFAULT, 333_000, 300_000],
    ["min", 100_000, M1, DEFAULT, 133_000, 100_000],
    ["below range clamps up", 50_000, M1, DEFAULT, 133_000, 100_000],
    ["above range clamps to max", 980_000, M1, DEFAULT, 1_000_000, 967_000],
    ["400k on a 200k model falls back", 400_000, M200, I300, 333_000, 300_000],
    ["at window falls back", 200_000, M200, DEFAULT, undefined, null],
    ["below window on 200k", 150_000, M200, DEFAULT, 183_000, 150_000],
    ["custom model (unknown window)", 300_000, "custom-x", DEFAULT, 333_000, 300_000],
  ];

  it.each(rows)("%s", (_name, stored, model, settings, sdkWindow, appliedTokens) => {
    expect(
      resolveClaudeAutoCompact({ stored, modelSelection: selection(model, []), settings }),
    ).toEqual({ sdkWindow, appliedTokens });
  });

  it("always yields a number SDK window inside the accepted range", () => {
    for (const [, stored, model, settings] of rows) {
      const { sdkWindow } = resolveClaudeAutoCompact({
        stored,
        modelSelection: selection(model, []),
        settings,
      });
      if (sdkWindow === undefined) continue;
      expect(typeof sdkWindow).toBe("number");
      expect(sdkWindow).toBeGreaterThanOrEqual(CLAUDE_AUTO_COMPACT_WINDOW_MIN);
      expect(sdkWindow).toBeLessThanOrEqual(CLAUDE_AUTO_COMPACT_WINDOW_MAX);
    }
  });
});
