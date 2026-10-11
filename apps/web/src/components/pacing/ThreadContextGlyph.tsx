import type { ClientSettings, ModelSelection } from "@t3tools/contracts";
import { useMemo } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { useNowTick } from "~/hooks/useNowTick";
import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "~/types";
import { PACE_TIER_CLASSES } from "./paceTierClasses";
import {
  arcDashArray,
  dotFillClass,
  formatGlyphTooltip,
  glyphGeometry,
  resolveThreadContextGlyph,
  type GlyphSize,
  type ThreadContextGlyphModel,
  type ThreadContextUsage,
} from "./threadContextGlyph.logic";

const SIZE_CLASS: Record<GlyphSize, string> = { 14: "size-3.5", 18: "size-4.5" };

const selectTimestampFormat = (settings: ClientSettings) => settings.timestampFormat;

/** Context ring (arc from 12 o'clock, clockwise) with an optional prompt-cache dot in the middle. */
export function ThreadContextGlyph({
  size,
  model,
  className,
}: {
  size: GlyphSize;
  model: ThreadContextGlyphModel;
  className?: string | undefined;
}) {
  const g = glyphGeometry(size);
  const dash = arcDashArray(model.fraction, g.circumference);
  const dotClass = dotFillClass(model.cacheState);
  // With no arc to colour (window size unknown), tint the track with the tier
  // colour instead, so a 300k+ context without a known window is not mistaken
  // for a healthy one. A known fraction keeps the neutral track.
  const trackColor = model.fraction === null ? model.tierColor : "muted";
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
      data-thread-context-glyph=""
      data-size={size}
      data-cache-state={model.cacheState}
      data-context-tier={model.tier}
      className={cn("mx-0! shrink-0", SIZE_CLASS[size], className)}
    >
      <circle
        cx={g.center}
        cy={g.center}
        r={g.radius}
        fill="none"
        strokeWidth={g.strokeWidth}
        className={cn("opacity-25", PACE_TIER_CLASSES[trackColor].stroke)}
      />
      {dash === null ? null : (
        <circle
          cx={g.center}
          cy={g.center}
          r={g.radius}
          fill="none"
          strokeWidth={g.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={dash}
          transform={`rotate(-90 ${g.center} ${g.center})`}
          className={cn(
            "transition-[stroke-dasharray,stroke] duration-500 ease-out motion-reduce:transition-none",
            PACE_TIER_CLASSES[model.tierColor].stroke,
          )}
        />
      )}
      {dotClass === null ? null : (
        <circle cx={g.center} cy={g.center} r={g.dotRadius} className={dotClass} />
      )}
    </svg>
  );
}

/** Subscribes to the shared 30 s clock; the only place the glyph reads time. */
export function useThreadContextGlyphModel(
  usage: ThreadContextUsage | null | undefined,
  nextSelection: ModelSelection | null | undefined,
): ThreadContextGlyphModel | null {
  const nowMs = useNowTick(30_000);
  return useMemo(
    () => resolveThreadContextGlyph(usage, nextSelection, nowMs),
    [usage, nextSelection, nowMs],
  );
}

type GlyphThread = Pick<SidebarThreadSummary, "latestTokenUsage" | "modelSelection">;

function ThreadContextGlyphLive({
  usage,
  nextSelection,
  className,
}: {
  usage: ThreadContextUsage;
  nextSelection: ModelSelection;
  className?: string | undefined;
}) {
  const model = useThreadContextGlyphModel(usage, nextSelection);
  return model === null ? null : (
    <ThreadContextGlyph size={14} model={model} className={className} />
  );
}

/** 14 px glyph for a sidebar row; renders nothing without usage. */
export function ThreadContextGlyphBadge({
  thread,
  className,
}: {
  thread: GlyphThread;
  className?: string | undefined;
}) {
  // Checked before any hook subscription so rows without usage never subscribe to the clock.
  if (!thread.latestTokenUsage) return null;
  return (
    <ThreadContextGlyphLive
      usage={thread.latestTokenUsage}
      nextSelection={thread.modelSelection}
      className={className}
    />
  );
}

function ThreadContextTooltipLineLive({
  usage,
  nextSelection,
}: {
  usage: ThreadContextUsage;
  nextSelection: ModelSelection;
}) {
  const model = useThreadContextGlyphModel(usage, nextSelection);
  const timestampFormat = useClientSettings(selectTimestampFormat);
  if (model === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ThreadContextGlyph size={14} model={model} className="shrink-0" />
      <div className="min-w-0 truncate text-foreground/75">
        {formatGlyphTooltip(model, timestampFormat)}
      </div>
    </div>
  );
}

/** Hover-card row: glyph + the tooltip string; renders nothing without usage. */
export function ThreadContextTooltipLine({ thread }: { thread: GlyphThread }) {
  if (!thread.latestTokenUsage) return null;
  return (
    <ThreadContextTooltipLineLive
      usage={thread.latestTokenUsage}
      nextSelection={thread.modelSelection}
    />
  );
}
