import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPacingModel,
  pacingAriaLabel,
  pacingLayoutForHeaderWidth,
  pacingReservePx,
  pacingRowSpacing,
  PACING_POPOVER_CLOSED,
  PACING_ROW_SPACING,
  reducePacingPopover,
  resolvePacingHeaderPosition,
  resolvePacingPlacement,
  type PacingPopoverState,
  type PacingSettings,
} from "./pacingRows.logic";

const NOW = Date.UTC(2026, 9, 12, 17, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SETTINGS: PacingSettings = {
  showSession: true,
  showWeekly: true,
  showModelScoped: true,
  workHours: "00:00-24:00",
  workDays: [0, 1, 2, 3, 4, 5, 6],
  offHoursWeight: 0.2,
};

function makeWindow(input: {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsInMs?: number;
}): ServerProviderUsageWindow {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    usedPercent: input.usedPercent,
    ...(input.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: input.windowDurationMins }),
    ...(input.resetsInMs === undefined
      ? {}
      : { resetsAt: new Date(NOW + input.resetsInMs).toISOString() }),
  };
}

// `null` omits resetsAt.
const fiveHour = (resetsInMs: number | null = HOUR + 52 * MINUTE) =>
  makeWindow({
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 62,
    windowDurationMins: 300,
    ...(resetsInMs === null ? {} : { resetsInMs }),
  });
const sevenDay = makeWindow({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 45,
  windowDurationMins: 10080,
  resetsInMs: 3 * DAY + 21 * HOUR,
});
const sevenDayFable = makeWindow({
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent: 78,
  windowDurationMins: 10080,
  resetsInMs: 4 * DAY + 21 * HOUR,
});
const BASE = [fiveHour(), sevenDay, sevenDayFable];

function limits(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return { checkedAt: new Date(NOW).toISOString(), windows, ...extra };
}

function build(
  usageLimits: ServerProviderUsageLimits | undefined,
  settings: Partial<PacingSettings> = {},
) {
  return buildPacingModel({
    usageLimits,
    settings: { ...SETTINGS, ...settings },
    nowMs: NOW,
    timestampFormat: "24-hour",
  });
}

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

describe("buildPacingModel", () => {
  it("builds header rows and popover sections for the base windows", () => {
    const model = build(limits(BASE));
    expect(ids(model.headerRows)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
    expect(ids(model.popoverSections)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
    expect(model.popoverSections.map((row) => row.hidden)).toEqual([false, false, false]);
    const rows = model.headerRows;
    expect(rows.map((row) => row.shortLabel)).toEqual(["5h", "7d", "Fable"]);
    expect(rows.map((row) => row.title)).toEqual([
      "Session · 5h",
      "Weekly · all models",
      "Weekly · Fable",
    ]);
    expect(rows.map((row) => row.percentText)).toEqual(["62%", "45%", "78%"]);
    expect(rows.map((row) => row.burnText)).toEqual(["1.0x", "1.0x", "2.6x"]);
    expect(rows.map((row) => row.burnColor)).toEqual(["success", "success", "destructive"]);
    expect(rows.map((row) => row.countdown)).toEqual(["in 1h 52m", "in 3d 21h", "in 4d 21h"]);
    expect(rows[0]!.paceFraction).toBeCloseTo(0.627, 3);
    expect(rows[1]!.paceFraction).toBeCloseTo(0.446, 3);
    expect(rows[2]!.paceFraction).toBeCloseTo(0.304, 3);
    for (const row of rows) expect(row.resetLabel).not.toBeNull();
  });

  it("marks toggled-off windows hidden and drops them from the header", () => {
    const model = build(limits(BASE), { showModelScoped: false });
    expect(ids(model.headerRows)).toEqual(["five_hour", "seven_day"]);
    expect(model.popoverSections.map((row) => row.hidden)).toEqual([false, false, true]);
  });

  it("keeps every window in the popover when all toggles are off", () => {
    const model = build(limits(BASE), {
      showSession: false,
      showWeekly: false,
      showModelScoped: false,
    });
    expect(model.headerRows).toEqual([]);
    expect(model.popoverSections.map((row) => row.hidden)).toEqual([true, true, true]);
  });

  it.each([
    ["undefined limits", undefined],
    ["unavailable limits", limits(BASE, { unavailable: { reason: "probeFailed" } })],
    ["no windows", limits([])],
  ])("renders nothing for %s", (_name, usageLimits) => {
    const model = build(usageLimits);
    expect(model.headerRows).toEqual([]);
    expect(model.popoverSections).toEqual([]);
  });

  it("keeps role other windows popover-only, after scoped windows", () => {
    const monthly = makeWindow({
      id: "monthly",
      kind: "monthly",
      label: "Monthly",
      usedPercent: 10,
      resetsInMs: 10 * DAY,
    });
    const model = build(limits([...BASE, monthly]));
    expect(ids(model.headerRows)).not.toContain("monthly");
    expect(ids(model.popoverSections)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
      "monthly",
    ]);
    expect(model.popoverSections[3]!.hidden).toBe(false);
  });

  it("handles a window without resetsAt", () => {
    const model = build(limits([fiveHour(null), sevenDay, sevenDayFable]));
    const row = model.popoverSections.find((section) => section.id === "five_hour")!;
    expect(row).toMatchObject({
      burnText: "",
      burnColor: "muted",
      paceFraction: null,
      resetLabel: null,
      countdown: null,
      usedPercent: 62,
    });
  });

  it("leaves burn blank early in the session window", () => {
    const model = build(limits([fiveHour(4 * HOUR + 50 * MINUTE)]));
    const row = model.headerRows[0]!;
    expect(row.burnText).toBe("");
    expect(row.burnColor).toBe("muted");
    expect(row.paceFraction).toBeCloseTo(0.033, 3);
    expect(row.resetLabel).not.toBeNull();
  });

  it("handles a window whose reset already passed", () => {
    const model = build(limits([fiveHour(-60_000)]));
    const row = model.headerRows[0]!;
    expect(row.burnText).toBe("");
    expect(row.paceFraction).toBeNull();
    expect(row.countdown).toBe("now");
  });

  it("caps the header at three rows while the popover lists all", () => {
    const sonnet = makeWindow({
      id: "seven_day_sonnet",
      kind: "weekly",
      label: "Weekly · Sonnet",
      usedPercent: 20,
      windowDurationMins: 10080,
      resetsInMs: 4 * DAY,
    });
    const model = build(limits([...BASE, sonnet]));
    expect(ids(model.headerRows)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
    expect(model.popoverSections).toHaveLength(4);
    expect(model.popoverSections[3]!.hidden).toBe(false);
  });

  it("orders windows independently of input order", () => {
    const model = build(limits([...BASE].toReversed()));
    expect(ids(model.headerRows)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
  });

  it("tolerates a malformed schedule", () => {
    const model = build(limits(BASE), { workHours: "garbage", workDays: [], offHoursWeight: 7 });
    expect(model.headerRows).toHaveLength(3);
  });
});

describe("pacingLayoutForHeaderWidth", () => {
  it.each([
    [null, "hidden"],
    [0, "hidden"],
    [489.9, "hidden"],
    [490, "compact"],
    [649.9, "compact"],
    [650, "full"],
    [1400, "full"],
  ] as const)("%s -> %s", (width, layout) => {
    expect(pacingLayoutForHeaderWidth(width)).toBe(layout);
  });
});

describe("pacingReservePx", () => {
  it.each([
    [238, 254],
    [167.2, 184],
    [0, 16],
  ])("%s -> %s", (width, reserve) => {
    expect(pacingReservePx(width)).toBe(reserve);
  });
});

describe("resolvePacingPlacement", () => {
  it.each([
    [false, false, false, "cluster"],
    [true, true, false, "panel-header"],
    [false, true, false, "none"],
    [false, false, true, "none"],
    [true, true, true, "panel-header"],
  ] as const)("owns=%s atRoot=%s inPanel=%s -> %s", (owns, atRoot, inPanel, placement) => {
    expect(
      resolvePacingPlacement({
        inlineRightPanelOwnsTitleBar: owns,
        rightPanelControlsAtRoot: atRoot,
        rightPanelControlsInPanel: inPanel,
      }),
    ).toBe(placement);
  });
});

describe("resolvePacingHeaderPosition", () => {
  // 1200px header, 20px paddings, toggles' left edge at 1084px, full-layout widget.
  const geometry = {
    headerWidthPx: 1200,
    headerPaddingLeftPx: 20,
    headerPaddingRightPx: 20,
    controlsLeftPx: 1084,
    widgetWidthPx: 324,
  };

  it("centers when the breadcrumb and the toggles both keep their room", () => {
    // Left edge (1200 - 324) / 2 = 438; the breadcrumb ends at 1200 - 20 - 96 - 662 = 422 = 438 - 16.
    expect(resolvePacingHeaderPosition(geometry)).toEqual({
      alignment: "center",
      leftPx: 438,
      reservePx: 662,
    });
  });

  it("falls back right when centering would squeeze the breadcrumb", () => {
    // A 240px collapsed-sidebar inset leaves 438 - 16 - 240 = 182px of title (< 240).
    expect(resolvePacingHeaderPosition({ ...geometry, headerPaddingLeftPx: 240 })).toEqual({
      alignment: "right",
      leftPx: 1084 - 12 - 324,
      reservePx: 1200 - 20 - 96 - (748 - 16),
    });
  });

  it("falls back right when the centered widget would reach the toggles", () => {
    // Centered right edge 438 + 324 = 762, within 16px of toggles starting at 770.
    const position = resolvePacingHeaderPosition({ ...geometry, controlsLeftPx: 770 });
    expect(position.alignment).toBe("right");
    expect(position.leftPx).toBe(770 - 12 - 324);
    // The breadcrumb still ends 16px before the widget.
    expect(1200 - 20 - 96 - position.reservePx).toBe(position.leftPx - 16);
  });

  it("centers at the smallest header that leaves the title its minimum", () => {
    // (W - 324) / 2 - 16 - 20 >= 240 -> W >= 876.
    const at = (headerWidthPx: number) =>
      resolvePacingHeaderPosition({
        ...geometry,
        headerWidthPx,
        controlsLeftPx: headerWidthPx - 116,
      }).alignment;
    expect(at(876)).toBe("center");
    expect(at(874)).toBe("right");
  });

  it.each([null, 0, 489])("is hidden for a %s px header", (headerWidthPx) => {
    expect(resolvePacingHeaderPosition({ ...geometry, headerWidthPx })).toEqual({
      alignment: "hidden",
      leftPx: 0,
      reservePx: 0,
    });
  });

  it("never publishes a negative reserve", () => {
    const position = resolvePacingHeaderPosition({ ...geometry, controlsLeftPx: 1300 });
    expect(position.reservePx).toBeGreaterThanOrEqual(0);
  });
});

describe("pacingRowSpacing", () => {
  it.each([
    [0, PACING_ROW_SPACING.spacious],
    [1, PACING_ROW_SPACING.spacious],
    [2, PACING_ROW_SPACING.spacious],
    [3, PACING_ROW_SPACING.tight],
    [4, PACING_ROW_SPACING.tight],
  ])("%s rows", (count, spacing) => {
    expect(pacingRowSpacing(count)).toBe(spacing);
  });
});

describe("reducePacingPopover", () => {
  const closed = PACING_POPOVER_CLOSED;
  const hoverOpen: PacingPopoverState = { open: true, pinned: false };
  const pinned: PacingPopoverState = { open: true, pinned: true };

  it.each([
    ["closed", closed, true, "trigger-hover", hoverOpen],
    ["hoverOpen", hoverOpen, false, "trigger-hover", closed],
    ["hoverOpen", hoverOpen, false, "trigger-press", pinned],
    ["hoverOpen", hoverOpen, true, "trigger-press", pinned],
    ["closed", closed, true, "trigger-press", pinned],
    ["pinned", pinned, false, "trigger-hover", pinned],
    ["pinned", pinned, true, "trigger-hover", pinned],
    ["pinned", pinned, false, "trigger-press", closed],
    ["pinned", pinned, false, "outside-press", closed],
    ["pinned", pinned, false, "escape-key", closed],
    ["pinned", pinned, false, "focus-out", closed],
    ["hoverOpen", hoverOpen, false, "escape-key", closed],
  ] as const)("%s + %s/%s", (_name, state, nextOpen, reason, expected) => {
    expect(reducePacingPopover(state, { nextOpen, reason })).toEqual(expected);
  });
});

describe("pacingAriaLabel", () => {
  it("labels an empty widget", () => {
    expect(pacingAriaLabel([])).toBe("Usage pacing");
  });

  it("summarises each header row", () => {
    expect(pacingAriaLabel(build(limits(BASE)).headerRows)).toBe(
      "Usage pacing: 5h 62%, burn 1.0x; 7d 45%, burn 1.0x; Fable 78%, burn 2.6x",
    );
  });

  it("omits the burn part when burn is unknown", () => {
    const rows = build(limits([fiveHour(null)])).headerRows;
    expect(pacingAriaLabel(rows)).toBe("Usage pacing: 5h 62%");
  });
});
