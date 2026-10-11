import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { PacingBar } from "./PacingBar";
import { PACE_TIER_CLASSES } from "./paceTierClasses";
import {
  PACING_POPOVER_CLOSED,
  reducePacingPopover,
  type PacingRowModel,
} from "./pacingRows.logic";

/** Hover opens, click pins (see reducePacingPopover). `children` is the trigger's row stack. */
export function PacingPopover(props: {
  readonly sections: ReadonlyArray<PacingRowModel>;
  readonly triggerLabel: string;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState(PACING_POPOVER_CLOSED);
  const navigate = useNavigate();

  return (
    <Popover
      open={state.open}
      onOpenChange={(nextOpen, details) =>
        setState((current) => reducePacingPopover(current, { nextOpen, reason: details.reason }))
      }
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label={props.triggerLabel}
            className="cursor-default rounded-md px-2 py-1 hover:bg-accent/50 data-[popup-open]:bg-accent/50"
          />
        }
      >
        {props.children}
      </PopoverTrigger>
      <PopoverPopup data-pacing-popover padding="none" side="bottom" align="end" sideOffset={6}>
        <div className="w-70">
          <div className="[&>*+*]:border-t [&>*+*]:border-border/50">
            {props.sections.map((section) => (
              <div
                key={section.id}
                data-pacing-section={section.id}
                data-hidden={section.hidden ? "true" : "false"}
                className={cn("flex flex-col gap-2 px-4 py-2.5", section.hidden && "opacity-55")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">
                    {section.title}
                    {section.hidden ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">hidden</span>
                    ) : null}
                  </span>
                  <span className="whitespace-nowrap">
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {section.percentText}
                    </span>
                    {section.burnText ? (
                      <span
                        className={cn(
                          "ml-3 text-sm font-semibold tabular-nums",
                          PACE_TIER_CLASSES[section.burnColor].text,
                        )}
                      >
                        {section.burnText}
                      </span>
                    ) : null}
                  </span>
                </div>
                <PacingBar
                  size="popover"
                  usedPercent={section.usedPercent}
                  paceFraction={section.paceFraction}
                  color={section.burnColor}
                />
                {section.resetLabel === null ? null : (
                  <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                    <span>{section.resetLabel}</span>
                    <span>{section.countdown}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-border/50 px-4 py-2.5 text-xs text-muted-foreground">
            <button
              type="button"
              className="cursor-pointer hover:text-foreground"
              onClick={() => {
                setState(PACING_POPOVER_CLOSED);
                void navigate({ to: "/usage" });
              }}
            >
              Usage details →
            </button>
            <button
              type="button"
              className="cursor-pointer hover:text-foreground"
              onClick={() => {
                setState(PACING_POPOVER_CLOSED);
                void navigate({ to: "/settings/usage-pacing" });
              }}
            >
              Settings
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
