import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: vi.fn(),
    setFollowSystem: vi.fn(),
    setThemeHalf: vi.fn(),
    clearThemeHalves: vi.fn(),
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
});

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Auto-resume limited threads"],
    ["snoozeLimitedThreads", "Snooze limited threads"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it.each([
    ["usagePacingShowSession", false, "Show session window", true],
    ["usagePacingShowWeekly", false, "Show weekly window", true],
    ["usagePacingShowModelScoped", false, "Show model-scoped weekly windows", true],
    ["usagePacingWorkHours", "20:00-02:00", "Work hours", "09:00-17:00"],
    ["usagePacingWorkDays", [0, 6], "Work days", [1, 2, 3, 4, 5]],
    ["usagePacingOffHoursWeight", 0.5, "Off-hours weight", 0.2],
  ] as const)("restores usage pacing %s", async (key, value, label, expected) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toEqual(expected);
  });

  it("does not treat reordered work days as changed", () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, usagePacingWorkDays: [5, 4, 3, 2, 1] };
    hooks.beginRender();

    expect(useSettingsRestore().changedSettingLabels).toEqual([]);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    hooks.beginRender();

    await useSettingsRestore().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
