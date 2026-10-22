import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  contextWindowTokensFromSelection,
  deriveThreadAutoCompactView,
  formatAutoCompactTokens,
  parseAutoCompactTokensInput,
  validateCustomAutoCompactTokens,
} from "./threadAutoCompact.ts";

const capability = { minTokens: 100_000, maxTokens: 1_000_000 };

describe("formatAutoCompactTokens", () => {
  it.each([
    [200_000, "200k"],
    [250_500, "250.5k"],
    [999_999, "1M"],
    [1_000_000, "1M"],
    [1_250_000, "1.25M"],
    [1_500_000, "1.5M"],
    [67_000, "67k"],
  ])("%s → %s", (tokens, label) => {
    expect(formatAutoCompactTokens(tokens)).toBe(label);
  });
});

describe("parseAutoCompactTokensInput", () => {
  it.each([
    ["300000", 300_000],
    ["300,000", 300_000],
    [" 300k ", 300_000],
    ["250.5k", 250_500],
    ["1m", 1_000_000],
    ["1.5M", 1_500_000],
    ["12.5", null],
    ["abc", null],
    ["", null],
    ["-5k", null],
    ["1e6", null],
  ])("%j → %s", (text, tokens) => {
    expect(parseAutoCompactTokensInput(text)).toBe(tokens);
  });
});

describe("contextWindowTokensFromSelection", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = (contextWindow?: string) => ({
    instanceId,
    model: "claude-opus",
    ...(contextWindow === undefined
      ? {}
      : { options: [{ id: "contextWindow", value: contextWindow }] }),
  });
  const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
    slug: "claude-opus",
    name: "Claude Opus",
    isCustom: false,
    capabilities: null,
    ...overrides,
  });

  it("reads the selection's 200k option", () => {
    expect(contextWindowTokensFromSelection(selection("200k"))).toBe(200_000);
  });

  it("reads the selection's 1m option", () => {
    expect(contextWindowTokensFromSelection(selection("1m"))).toBe(1_000_000);
  });

  it("falls back to the model descriptor's default option", () => {
    const withDescriptor = model({
      capabilities: {
        optionDescriptors: [
          {
            id: "contextWindow",
            label: "Context window",
            type: "select",
            options: [
              { id: "200k", label: "200k" },
              { id: "1m", label: "1M", isDefault: true },
            ],
          },
        ],
      },
    });
    expect(contextWindowTokensFromSelection(selection(), withDescriptor)).toBe(1_000_000);
  });

  it("falls back to the model's fixed window", () => {
    expect(
      contextWindowTokensFromSelection(selection(), model({ contextWindowTokens: 1_000_000 })),
    ).toBe(1_000_000);
  });

  it("returns null for an option id that is not a size", () => {
    expect(contextWindowTokensFromSelection(selection("standard"))).toBeNull();
  });

  it("returns null with nothing to go on", () => {
    expect(contextWindowTokensFromSelection(selection())).toBeNull();
  });
});

describe("validateCustomAutoCompactTokens", () => {
  it.each([
    ["abc", { ok: false, message: "Enter a number of tokens, like 250k." }],
    ["50k", { ok: false, message: "Enter a value from 100k to 1M." }],
    ["300k", { ok: false, message: "Must be below this model's 272k window." }],
    ["250k", { ok: true, tokens: 250_000 }],
  ])("%s with a 272k window", (text, expected) => {
    expect(validateCustomAutoCompactTokens({ text, capability, windowTokens: 272_000 })).toEqual(
      expected,
    );
  });

  it("accepts any in-range value when the window is unknown", () => {
    expect(
      validateCustomAutoCompactTokens({ text: "900k", capability, windowTokens: null }),
    ).toMatchObject({ ok: true });
  });
});

describe("deriveThreadAutoCompactView", () => {
  const base = {
    capability,
    providerDisplayName: "Claude",
    stored: null,
    applied: undefined,
    windowTokens: 1_000_000,
  } as const;

  it("1: hides the control without a capability", () => {
    expect(
      deriveThreadAutoCompactView({ ...base, capability: undefined, stored: 300_000 }),
    ).toBeNull();
  });

  it("2: a preset in effect", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      capability: { ...capability, defaultTokens: 900_000 },
      stored: 400_000,
      applied: { tokens: 400_000 },
    });
    expect(view).toMatchObject({
      choice: { kind: "preset", tokens: 400_000 },
      pending: false,
      tickFraction: 0.4,
      statusText: "This thread compacts at 400k (default: 900k).",
    });
  });

  it("3: a change pending against the instance default", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      capability: { ...capability, defaultTokens: 900_000 },
      stored: 300_000,
      applied: { tokens: 900_000 },
    });
    expect(view).toMatchObject({
      pending: true,
      statusText: "300k · applies after the session restarts. Currently compacts at 900k.",
    });
  });

  it("4: Default with the provider's built-in behaviour applied", () => {
    const view = deriveThreadAutoCompactView({ ...base, applied: { tokens: null } });
    expect(view).toMatchObject({
      choice: { kind: "default" },
      pending: false,
      statusText: null,
      tickFraction: null,
    });
  });

  it("5: Default with the instance default applied", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      capability: { ...capability, defaultTokens: 300_000 },
      applied: { tokens: 300_000 },
    });
    expect(view).toMatchObject({ pending: false, statusText: null });
  });

  it("6: Default pending while a cap is still applied", () => {
    const view = deriveThreadAutoCompactView({ ...base, applied: { tokens: 400_000 } });
    expect(view).toMatchObject({
      pending: true,
      statusText: "Default · applies after the session restarts. Currently compacts at 400k.",
    });
  });

  it("7: a new thread has no report and nothing pending", () => {
    const view = deriveThreadAutoCompactView({ ...base, stored: 200_000 });
    expect(view).toMatchObject({
      pending: false,
      statusText: "This thread compacts at 200k (default: Claude default).",
      tickFraction: 0.2,
    });
  });

  it("8: a stored value at or above the window falls back to the default", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      providerDisplayName: "Codex",
      stored: 400_000,
      applied: null,
      windowTokens: 272_000,
    });
    expect(view?.presets.map((preset) => [preset.label, preset.disabled])).toEqual([
      ["200k", false],
      ["300k", true],
      ["400k", true],
    ]);
    expect(view).toMatchObject({
      effectiveTokens: null,
      statusText:
        "400k is at or above this model's window, so this thread uses the default (Codex default).",
      tickFraction: null,
    });
  });

  it("9: a value below the range is clamped up", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      stored: 50_000,
      applied: { tokens: 100_000 },
    });
    expect(view).toMatchObject({
      choice: { kind: "custom", tokens: 50_000 },
      effectiveTokens: 100_000,
      pending: false,
      statusText: "This thread compacts at 100k (default: Claude default).",
    });
  });

  it("10: an unknown window draws no tick and disables no preset", () => {
    const view = deriveThreadAutoCompactView({ ...base, stored: 300_000, windowTokens: null });
    expect(view?.tickFraction).toBeNull();
    expect(view?.presets.every((preset) => !preset.disabled)).toBe(true);
    expect(view?.statusText).toBe("This thread compacts at 300k (default: Claude default).");
  });

  it("11: a preset below the provider's minimum is disabled", () => {
    const view = deriveThreadAutoCompactView({
      ...base,
      capability: { minTokens: 250_000, maxTokens: 1_000_000 },
    });
    expect(view?.presets.find((preset) => preset.tokens === 200_000)?.disabled).toBe(true);
  });
});
