import type { PaceTierColor } from "@t3tools/shared/usagePacing";

import { cn } from "~/lib/utils";
import { PACE_TIER_CLASSES } from "./paceTierClasses";

// Full literal class strings, so Tailwind's scanner emits them and shadcn/no-unknown-classes passes.
const BAR_SIZE = {
  header: { track: "h-1 w-30 shrink-0", tick: "h-2" },
  popover: { track: "h-1 w-full", tick: "h-2" },
} as const;

/** Usage bar with a pace tick; header and popover sizes. No transitions (no repaint animation). */
export function PacingBar(props: {
  readonly usedPercent: number;
  readonly paceFraction: number | null;
  readonly color: PaceTierColor;
  readonly size: keyof typeof BAR_SIZE;
}) {
  const size = BAR_SIZE[props.size];
  return (
    <div className={cn("relative rounded-full bg-muted-foreground/25", size.track)} aria-hidden>
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full", PACE_TIER_CLASSES[props.color].bg)}
        style={{ width: `${props.usedPercent}%` }}
      />
      {props.paceFraction === null ? null : (
        <div
          data-pacing-tick
          className={cn(
            "absolute top-1/2 w-[1.5px] -translate-x-1/2 -translate-y-1/2 bg-foreground",
            size.tick,
          )}
          style={{ left: `${Math.min(1, Math.max(0, props.paceFraction)) * 100}%` }}
        />
      )}
    </div>
  );
}
