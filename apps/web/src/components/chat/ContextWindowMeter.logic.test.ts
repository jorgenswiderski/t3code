import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  barTickLeftPercent,
  resolveContextWindowAutoCompact,
  shouldIgnoreMeterClose,
  shouldReserveContextWindowMeter,
  shouldShowEmptyContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});

describe("barTickLeftPercent", () => {
  it.each([
    [0.4, 40],
    [0.3, 30],
  ])("fraction %s sits at %s percent", (fraction, expected) => {
    expect(barTickLeftPercent(fraction)).toBeCloseTo(expected);
  });

  it.each([0, 1, null, Number.NaN, 1.5])("draws nothing for %s", (fraction) => {
    expect(barTickLeftPercent(fraction)).toBeNull();
  });
});

describe("shouldIgnoreMeterClose", () => {
  it.each([
    ["trigger-hover", true, true],
    ["trigger-hover", false, false],
    ["escape-key", true, false],
    ["outside-press", true, false],
    ["trigger-press", true, false],
  ])("closing for %s while editing=%s is ignored=%s", (reason, editing, expected) => {
    expect(shouldIgnoreMeterClose({ nextOpen: false, reason, editing })).toBe(expected);
  });

  it("never blocks opening", () => {
    expect(shouldIgnoreMeterClose({ nextOpen: true, reason: "trigger-hover", editing: true })).toBe(
      false,
    );
  });
});

describe("shouldShowEmptyContextWindowMeter", () => {
  const base = {
    meterEnabled: true,
    hasCapability: true,
    hasSnapshot: false,
    threadStarted: false,
    reservingPlaceholder: false,
  };

  it.each([
    ["new thread with the capability", {}, true],
    ["ring setting off", { meterEnabled: false }, false],
    ["older server or unsupported provider", { hasCapability: false }, false],
    ["populated meter takes over", { hasSnapshot: true }, false],
    ["started thread without usage", { threadStarted: true }, false],
    ["placeholder owns the slot", { reservingPlaceholder: true }, false],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(shouldShowEmptyContextWindowMeter({ ...base, ...overrides })).toBe(expected);
  });
});

describe("resolveContextWindowAutoCompact", () => {
  const capability = { minTokens: 100_000, maxTokens: 1_000_000 };
  const claude = ProviderInstanceId.make("claudeAgent");
  const other = ProviderInstanceId.make("claudeAgent_work");
  const selection = (options?: ModelSelection["options"]): ModelSelection => ({
    instanceId: claude,
    model: "claude-opus-4-8",
    ...(options ? { options } : {}),
  });
  const onChange = () => undefined;
  const base = {
    capability,
    providerDisplayName: "Claude",
    stored: null,
    applied: null,
    threadProviderInstanceId: claude,
    selectedInstanceId: claude,
    snapshotMaxTokens: 1_000_000,
    selection: selection(),
    selectedModel: undefined,
    canChange: true,
    changeDeniedReason: null,
    onChange,
  };
  const fixedWindowModel = (contextWindowTokens: number): ServerProviderModel => ({
    slug: "claude-opus-4-8",
    name: "Claude Opus",
    isCustom: false,
    capabilities: null,
    contextWindowTokens,
  });

  it("is null without the capability", () => {
    expect(resolveContextWindowAutoCompact({ ...base, capability: undefined })).toBeNull();
  });

  it("derives the tick from the stored value and the snapshot window", () => {
    const result = resolveContextWindowAutoCompact({ ...base, stored: 400_000 });
    expect(result?.view.tickFraction).toBeCloseTo(0.4);
    expect(result?.windowTokens).toBe(1_000_000);
    expect(result?.disabled).toBe(false);
  });

  it("shows a change as pending against the live process", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      stored: 300_000,
      applied: { tokens: null },
    });
    expect(result?.view.pending).toBe(true);
    expect(result?.appliedTokens).toBeNull();
  });

  it("ignores the applied report when the picker points at another instance", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      stored: 300_000,
      applied: { tokens: null },
      selectedInstanceId: other,
    });
    expect(result?.view.pending).toBe(false);
  });

  it("falls back to the selection's context window option", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      snapshotMaxTokens: null,
      selection: selection([{ id: "contextWindow", value: "1m" }]),
    });
    expect(result?.windowTokens).toBe(1_000_000);
  });

  it("falls back to the model's fixed window", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      snapshotMaxTokens: null,
      selectedModel: fixedWindowModel(1_000_000),
    });
    expect(result?.windowTokens).toBe(1_000_000);
  });

  it("has no window and no tick when nothing reports one", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      stored: 400_000,
      snapshotMaxTokens: null,
    });
    expect(result?.windowTokens).toBeNull();
    expect(result?.view.tickFraction).toBeNull();
  });

  it("reads a reported cap at or above the snapshot window as the built-in default", () => {
    // A fresh Codex start loads the stored cap before it knows the model's window.
    const result = resolveContextWindowAutoCompact({
      ...base,
      providerDisplayName: "Codex",
      stored: 300_000,
      applied: { tokens: 300_000 },
      snapshotMaxTokens: 258_400,
    });
    expect(result?.view.pending).toBe(false);
    expect(result?.appliedTokens).toBeNull();
  });

  it("does not claim an instance default at or above the window as the compaction point", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      capability: { ...capability, defaultTokens: 300_000 },
      applied: { tokens: 300_000 },
      snapshotMaxTokens: 200_000,
    });
    expect(result?.view.pending).toBe(false);
    expect(result?.appliedTokens).toBeNull();
  });

  it("disables the control with the reason when the connection cannot change threads", () => {
    const result = resolveContextWindowAutoCompact({
      ...base,
      stored: 400_000,
      canChange: false,
      changeDeniedReason: "X",
    });
    expect(result?.disabled).toBe(true);
    expect(result?.disabledReason).toBe("X");
  });
});
