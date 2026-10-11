import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";

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
  pacingRowGapClass,
  PACING_RESERVE_CSS_VAR,
} from "./pacingRows.logic";

/**
 * Chat header usage pacing rows for the thread's provider. `headerRef` is `<header
 * data-chat-header>`: its width picks the layout, and the widget publishes its own width on it
 * as PACING_RESERVE_CSS_VAR so the breadcrumb (ChatHeader) truncates instead of overlapping.
 */
export const PacingWidget = memo(function PacingWidget(props: {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly headerRef: RefObject<HTMLElement | null>;
}) {
  const { usageLimits, headerRef } = props;
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
  // Writes to <header>, which React does not own here, so it must clean up on unmount/hide.
  useEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root) return;
    const stop = observeResize(root, (entries) => {
      const width = entries.at(-1)?.borderBoxSize?.[0]?.inlineSize ?? root.offsetWidth;
      header.style.setProperty(PACING_RESERVE_CSS_VAR, `${pacingReservePx(width)}px`);
    });
    return () => {
      stop();
      header.style.removeProperty(PACING_RESERVE_CSS_VAR);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Showing or relaying out the widget replaces the root.
  }, [headerRef, rendered, layout]);

  if (!rendered) return null;

  return (
    <div ref={rootRef} data-pacing-widget className="mr-2">
      <PacingPopover
        sections={model.popoverSections}
        triggerLabel={pacingAriaLabel(model.headerRows)}
      >
        <div className={cn("flex flex-col", pacingRowGapClass(model.headerRows.length))}>
          {model.headerRows.map((row) => (
            <div
              key={row.id}
              data-pacing-row={row.id}
              className="flex items-center gap-x-1.5 text-2xs leading-3.25 tabular-nums whitespace-nowrap"
            >
              <span className="w-8 shrink-0 truncate text-muted-foreground">{row.shortLabel}</span>
              <PacingBar
                size="header"
                usedPercent={row.usedPercent}
                paceFraction={row.paceFraction}
                color={row.burnColor}
              />
              <span
                data-pacing-burn
                className={cn("w-8 shrink-0 text-right", PACE_TIER_CLASSES[row.burnColor].text)}
              >
                {row.burnText}
              </span>
              {layout === "full" && row.resetLabel !== null ? (
                <span data-pacing-reset className="w-16 shrink-0 text-muted-foreground">
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
