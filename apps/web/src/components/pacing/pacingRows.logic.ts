import type { ServerProviderUsageLimits, TimestampFormat } from "@t3tools/contracts";
import {
  BURN_TIER_COLORS,
  computeWindowPace,
  formatBurn,
  formatCountdown,
  formatResetLabel,
  orderPaceWindows,
  paceWindowRole,
  paceWindowShortLabel,
  paceWindowTitle,
  resolveWorkSchedule,
  type PaceTierColor,
  type PaceWindowRole,
} from "@t3tools/shared/usagePacing";

export interface PacingSettings {
  readonly showSession: boolean;
  readonly showWeekly: boolean;
  readonly showModelScoped: boolean;
  readonly workHours: string;
  readonly workDays: ReadonlyArray<number>;
  readonly offHoursWeight: number;
}

export interface PacingRowModel {
  /** Window id, e.g. "five_hour". */
  readonly id: string;
  readonly role: PaceWindowRole;
  /** "5h" | "7d" | "Fable" */
  readonly shortLabel: string;
  /** "Session · 5h" | "Weekly · all models" | "Weekly · Fable" */
  readonly title: string;
  /** 0..100, bar fill. */
  readonly usedPercent: number;
  readonly percentText: string;
  /** "1.2x", "" when burn is unknown. */
  readonly burnText: string;
  /** Tier colour; "muted" when burn is unknown. */
  readonly burnColor: PaceTierColor;
  /** Tick position 0..1. */
  readonly paceFraction: number | null;
  readonly resetLabel: string | null;
  readonly countdown: string | null;
  /** Toggled off in the header (always false for role "other"). */
  readonly hidden: boolean;
}

export interface PacingModel {
  readonly headerRows: ReadonlyArray<PacingRowModel>;
  readonly popoverSections: ReadonlyArray<PacingRowModel>;
}

/** Three rows fit the 52px chat header; more go to the popover only. */
export const MAX_PACING_HEADER_ROWS = 3;

const EMPTY_MODEL: PacingModel = { headerRows: [], popoverSections: [] };

function isToggleOn(role: PaceWindowRole, settings: PacingSettings): boolean {
  switch (role) {
    case "session":
      return settings.showSession;
    case "weekly":
      return settings.showWeekly;
    case "modelScoped":
      return settings.showModelScoped;
    case "other":
      return true;
  }
}

/** Turns a provider's usage limits into header rows (toggled on, capped) and popover sections (all). */
export function buildPacingModel(input: {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly settings: PacingSettings;
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}): PacingModel {
  const { usageLimits, settings, nowMs, timestampFormat } = input;
  if (
    usageLimits === undefined ||
    usageLimits.unavailable !== undefined ||
    usageLimits.windows.length === 0
  ) {
    return EMPTY_MODEL;
  }
  const schedule = resolveWorkSchedule({
    workHours: settings.workHours,
    workDays: settings.workDays,
    offHoursWeight: settings.offHoursWeight,
  });
  const popoverSections = orderPaceWindows(usageLimits.windows).map((window): PacingRowModel => {
    const role = paceWindowRole(window);
    const pace = computeWindowPace(window, { nowMs, schedule });
    const resetsAtMs = pace.resetsAtMs;
    return {
      id: window.id,
      role,
      shortLabel: paceWindowShortLabel(window),
      title: paceWindowTitle(window),
      usedPercent: pace.usedPercent,
      percentText: `${Math.round(pace.usedPercent)}%`,
      burnText: pace.burn === null ? "" : formatBurn(pace.burn),
      burnColor: pace.burnTier === null ? "muted" : BURN_TIER_COLORS[pace.burnTier],
      paceFraction: pace.paceFraction,
      resetLabel:
        resetsAtMs === null
          ? null
          : formatResetLabel(resetsAtMs, window.windowDurationMins, timestampFormat),
      countdown: resetsAtMs === null ? null : formatCountdown(resetsAtMs - nowMs),
      hidden: role !== "other" && !isToggleOn(role, settings),
    };
  });
  const headerRows = popoverSections
    .filter((row) => row.role !== "other" && !row.hidden)
    .slice(0, MAX_PACING_HEADER_ROWS);
  return { headerRows, popoverSections };
}

export type PacingLayout = "full" | "compact" | "hidden";
export const PACING_HIDE_BELOW_PX = 420;
export const PACING_COMPACT_BELOW_PX = 560;

/** Layout from the border-box width of `<header data-chat-header>`; null = not measured yet. */
export function pacingLayoutForHeaderWidth(headerWidthPx: number | null): PacingLayout {
  if (headerWidthPx === null || headerWidthPx < PACING_HIDE_BELOW_PX) return "hidden";
  if (headerWidthPx < PACING_COMPACT_BELOW_PX) return "compact";
  return "full";
}

/** Set on `<header data-chat-header>`; ChatHeader applies it as the breadcrumb's right margin. */
export const PACING_RESERVE_CSS_VAR = "--pacing-widget-reserve";

export function pacingReservePx(widgetWidthPx: number): number {
  return Math.ceil(widgetWidthPx) + 16;
}

export type PacingPlacement = "cluster" | "panel-header" | "none";

/**
 * Inline right panel open -> beside the thread-details toggle in the header; the fixed cluster
 * would cover the panel's tab bar. Sheet open or panel mid-close -> nowhere. Else the cluster.
 */
export function resolvePacingPlacement(input: {
  readonly inlineRightPanelOwnsTitleBar: boolean;
  readonly rightPanelControlsAtRoot: boolean;
  readonly rightPanelControlsInPanel: boolean;
}): PacingPlacement {
  if (input.inlineRightPanelOwnsTitleBar) return "panel-header";
  if (input.rightPanelControlsAtRoot || input.rightPanelControlsInPanel) return "none";
  return "cluster";
}

export interface PacingPopoverState {
  readonly open: boolean;
  readonly pinned: boolean;
}

export const PACING_POPOVER_CLOSED: PacingPopoverState = { open: false, pinned: false };

/**
 * Controlled popover state: hover opens, a click pins, a second click unpins. Base UI alone would
 * toggle a hover-opened popover closed on a late click and close a pinned one on hover-leave.
 * `reason` is Base UI's open-change reason (`trigger-press`, `trigger-hover`, `outside-press`, ...).
 */
export function reducePacingPopover(
  state: PacingPopoverState,
  event: { readonly nextOpen: boolean; readonly reason: string },
): PacingPopoverState {
  if (event.reason === "trigger-press") {
    // Click: pins an open or closed popover; a second click on a pinned one unpins and closes.
    return state.pinned ? PACING_POPOVER_CLOSED : { open: true, pinned: true };
  }
  if (!event.nextOpen) {
    // Hover leaving must not close a pinned popover; every other close reason does.
    return state.pinned && event.reason === "trigger-hover" ? state : PACING_POPOVER_CLOSED;
  }
  return { open: true, pinned: state.pinned };
}

/** Full literal class strings so Tailwind's scanner emits them. */
export const PACING_ROW_GAP_CLASS = { spacious: "gap-1.25", tight: "gap-px" } as const;

export function pacingRowGapClass(rowCount: number): string {
  return rowCount >= 3 ? PACING_ROW_GAP_CLASS.tight : PACING_ROW_GAP_CLASS.spacious;
}

export function pacingAriaLabel(rows: ReadonlyArray<PacingRowModel>): string {
  if (rows.length === 0) return "Usage pacing";
  return `Usage pacing: ${rows
    .map(
      (row) =>
        `${row.shortLabel} ${row.percentText}${row.burnText ? `, burn ${row.burnText}` : ""}`,
    )
    .join("; ")}`;
}
