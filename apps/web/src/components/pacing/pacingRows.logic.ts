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

/** Three rows fit the 40px desktop title bar; more go to the popover only. */
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
// The full widget is ~324px wide and the compact one ~236px. Each threshold leaves the rest of
// the header the room it had at the old 238px / 168px sizes (420 / 560).
export const PACING_HIDE_BELOW_PX = 490;
export const PACING_COMPACT_BELOW_PX = 650;

/** Layout from the border-box width of `<header data-chat-header>`; null = not measured yet. */
export function pacingLayoutForHeaderWidth(headerWidthPx: number | null): PacingLayout {
  if (headerWidthPx === null || headerWidthPx < PACING_HIDE_BELOW_PX) return "hidden";
  if (headerWidthPx < PACING_COMPACT_BELOW_PX) return "compact";
  return "full";
}

/** Set on `<header data-chat-header>`; ChatHeader applies it as the breadcrumb's right margin. */
export const PACING_RESERVE_CSS_VAR = "--pacing-widget-reserve";

/** Minimum space between the widget and the breadcrumb or the header's right-side controls. */
export const PACING_EDGE_GAP_PX = 16;

/** Reserve for a widget laid out in flow at the header's right (the panel-header placement). */
export function pacingReservePx(widgetWidthPx: number): number {
  return Math.ceil(widgetWidthPx) + PACING_EDGE_GAP_PX;
}

/**
 * Narrowest breadcrumb that centering may leave: the project crumb (capped at 160px) plus a
 * separator and a few words of thread title. Below it the title reads as a fragment, so the
 * widget moves right instead.
 */
export const PACING_TITLE_MIN_PX = 240;
/** ChatHeader's breadcrumb `pr-24`: toggle clearance that sits inside the published reserve. */
export const CHAT_HEADER_TITLE_END_PAD_PX = 96;
/** Space between a right-aligned widget and the toggles (the cluster's former gap-1 + mr-2). */
export const PACING_CONTROLS_GAP_PX = 12;

/** Measured in px; x positions are relative to the header's left border edge. */
export interface PacingHeaderGeometry {
  readonly headerWidthPx: number | null;
  readonly headerPaddingLeftPx: number;
  readonly headerPaddingRightPx: number;
  /** Left edge of the right-side toggles. */
  readonly controlsLeftPx: number;
  readonly widgetWidthPx: number;
}

export interface PacingHeaderPosition {
  readonly alignment: "center" | "right" | "hidden";
  /** The widget's left edge. */
  readonly leftPx: number;
  /** PACING_RESERVE_CSS_VAR: the breadcrumb's right margin, ending it PACING_EDGE_GAP_PX short of the widget. */
  readonly reservePx: number;
}

const HIDDEN_POSITION: PacingHeaderPosition = { alignment: "hidden", leftPx: 0, reservePx: 0 };

/**
 * Main chat header placement: centered in the header, or right-aligned against the toggles when
 * centering would squeeze the breadcrumb below PACING_TITLE_MIN_PX or reach the toggles.
 */
export function resolvePacingHeaderPosition(geometry: PacingHeaderGeometry): PacingHeaderPosition {
  const { headerWidthPx, widgetWidthPx, controlsLeftPx } = geometry;
  if (pacingLayoutForHeaderWidth(headerWidthPx) === "hidden" || headerWidthPx === null) {
    return HIDDEN_POSITION;
  }
  const centerLeft = Math.round((headerWidthPx - widgetWidthPx) / 2);
  const titleRoom = centerLeft - PACING_EDGE_GAP_PX - geometry.headerPaddingLeftPx;
  const clearsControls = centerLeft + widgetWidthPx + PACING_EDGE_GAP_PX <= controlsLeftPx;
  const alignment = titleRoom >= PACING_TITLE_MIN_PX && clearsControls ? "center" : "right";
  const leftPx =
    alignment === "center"
      ? centerLeft
      : Math.round(controlsLeftPx - PACING_CONTROLS_GAP_PX - widgetWidthPx);
  // The breadcrumb's content ends at its padding edge: header content edge, minus the reserve,
  // minus its own toggle clearance.
  const titleEnd = headerWidthPx - geometry.headerPaddingRightPx - CHAT_HEADER_TITLE_END_PAD_PX;
  const reservePx = Math.max(0, Math.ceil(titleEnd - (leftPx - PACING_EDGE_GAP_PX)));
  return { alignment, leftPx, reservePx };
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

/**
 * Row stack spacing for 12px text in the 40px desktop title bar (52px on the web): two rows are
 * 16 + 4 + 16 = 36px, three are 3 x 13 = 39px. Full literal class strings so Tailwind emits them.
 */
export const PACING_ROW_SPACING = {
  spacious: { stack: "gap-1", row: "leading-4" },
  tight: { stack: "gap-0", row: "leading-3.25" },
} as const;

export function pacingRowSpacing(rowCount: number): {
  readonly stack: string;
  readonly row: string;
} {
  return rowCount >= 3 ? PACING_ROW_SPACING.tight : PACING_ROW_SPACING.spacious;
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
