import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useNowTick } from "~/hooks/useNowTick";
import { useClientSettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { PacingBar } from "./PacingBar";
import { PacingPopover } from "./PacingPopover";
import { PACE_TIER_CLASSES } from "./paceTierClasses";
import {
  buildPacingModel,
  pacingAriaLabel,
  pacingLayoutForHeaderWidth,
  pacingReservePx,
  pacingRowSpacing,
  PACING_RESERVE_CSS_VAR,
  resolvePacingHeaderPosition,
  type PacingHeaderPosition,
} from "./pacingRows.logic";

function samePosition(a: PacingHeaderPosition | null, b: PacingHeaderPosition): boolean {
  return a?.alignment === b.alignment && a.leftPx === b.leftPx && a.reservePx === b.reservePx;
}

/**
 * Chat header usage pacing rows for the thread's provider. `headerRef` is `<header
 * data-chat-header>`: its width picks the layout, and the widget publishes the room it takes on
 * it as PACING_RESERVE_CSS_VAR so the breadcrumb (ChatHeader) truncates instead of overlapping.
 *
 * With `controlsRef` (the header's right-side toggles) the widget must be a direct child of the
 * header and positions itself there: centered, or against the toggles when centering does not fit
 * (resolvePacingHeaderPosition). Without it, it sits in flow at the right.
 */
export const PacingWidget = memo(function PacingWidget(props: {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly headerRef: RefObject<HTMLElement | null>;
  readonly controlsRef?: RefObject<HTMLElement | null> | undefined;
}) {
  const { usageLimits, headerRef, controlsRef } = props;
  const nowMs = useNowTick(30_000);
  const showSession = useClientSettings((settings) => settings.usagePacingShowSession);
  const showWeekly = useClientSettings((settings) => settings.usagePacingShowWeekly);
  const showModelScoped = useClientSettings((settings) => settings.usagePacingShowModelScoped);
  const workHours = useClientSettings((settings) => settings.usagePacingWorkHours);
  const workDays = useClientSettings((settings) => settings.usagePacingWorkDays);
  const offHoursWeight = useClientSettings((settings) => settings.usagePacingOffHoursWeight);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  const model = useMemo(
    () =>
      buildPacingModel({
        usageLimits,
        settings: { showSession, showWeekly, showModelScoped, workHours, workDays, offHoursWeight },
        nowMs,
        timestampFormat,
      }),
    [
      usageLimits,
      showSession,
      showWeekly,
      showModelScoped,
      workHours,
      workDays,
      offHoursWeight,
      nowMs,
      timestampFormat,
    ],
  );

  const [headerWidth, setHeaderWidth] = useState<number | null>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    return observeResize(header, (entries) => {
      const entry = entries.at(-1);
      if (entry) setHeaderWidth(entry.borderBoxSize?.[0]?.inlineSize ?? header.offsetWidth);
    });
  }, [headerRef]);

  const layout = pacingLayoutForHeaderWidth(headerWidth);
  const rendered = layout !== "hidden" && model.headerRows.length > 0;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PacingHeaderPosition | null>(null);
  // Writes to <header>, which React does not own here, so it must clean up on unmount/hide.
  // A layout effect, so a positioned widget is placed before its first paint.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root) return;
    const controls = controlsRef?.current ?? null;
    const measure = () => {
      const widgetWidthPx = root.getBoundingClientRect().width;
      let reservePx = pacingReservePx(widgetWidthPx);
      if (controls !== null) {
        const headerRect = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        const next = resolvePacingHeaderPosition({
          headerWidthPx: headerRect.width,
          headerPaddingLeftPx: Number.parseFloat(style.paddingLeft) || 0,
          headerPaddingRightPx: Number.parseFloat(style.paddingRight) || 0,
          controlsLeftPx: controls.getBoundingClientRect().left - headerRect.left,
          widgetWidthPx,
        });
        setPosition((previous) => (samePosition(previous, next) ? previous : next));
        reservePx = next.reservePx;
      }
      header.style.setProperty(PACING_RESERVE_CSS_VAR, `${reservePx}px`);
    };
    measure();
    // Header padding (collapsed-sidebar inset) and the toggles' width also move the widget.
    const stop = observeResize(controls === null ? [root] : [header, root, controls], measure);
    return () => {
      stop();
      header.style.removeProperty(PACING_RESERVE_CSS_VAR);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Showing or relaying out the widget replaces the root.
  }, [headerRef, controlsRef, rendered, layout]);

  if (!rendered) return null;

  const positioned = controlsRef !== undefined;
  const spacing = pacingRowSpacing(model.headerRows.length);
  return (
    <div
      ref={rootRef}
      data-pacing-widget
      data-pacing-alignment={positioned ? (position?.alignment ?? "measuring") : "right"}
      className={
        positioned
          ? cn(
              "absolute top-0 flex h-full w-max items-center [-webkit-app-region:no-drag]",
              (position === null || position.alignment === "hidden") && "invisible",
            )
          : "mr-2"
      }
      style={positioned ? { left: position?.leftPx ?? 0 } : undefined}
    >
      <PacingPopover
        sections={model.popoverSections}
        triggerLabel={pacingAriaLabel(model.headerRows)}
      >
        <div className={cn("flex flex-col", spacing.stack)}>
          {model.headerRows.map((row) => (
            <div
              key={row.id}
              data-pacing-row={row.id}
              className={cn(
                "flex items-center gap-x-2 text-xs tabular-nums whitespace-nowrap",
                spacing.row,
              )}
            >
              <span className="w-11 shrink-0 truncate text-muted-foreground">{row.shortLabel}</span>
              <PacingBar
                size="header"
                usedPercent={row.usedPercent}
                paceFraction={row.paceFraction}
                color={row.burnColor}
              />
              <span
                data-pacing-burn
                className={cn("w-10 shrink-0 text-right", PACE_TIER_CLASSES[row.burnColor].text)}
              >
                {row.burnText}
              </span>
              {layout === "full" && row.resetLabel !== null ? (
                <span data-pacing-reset className="w-20 shrink-0 text-muted-foreground">
                  {row.resetLabel}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </PacingPopover>
    </div>
  );
});
