import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import type { ModelSelection, TimestampFormat } from "@t3tools/contracts";
import type { RequestIdentity } from "@t3tools/shared/usagePacing";
import { Minimize2Icon } from "lucide-react";
import { useMemo } from "react";
import { PACE_TIER_CLASSES } from "../pacing/paceTierClasses";
import { ThreadContextGlyph, useThreadContextGlyphModel } from "../pacing/ThreadContextGlyph";
import {
  composerGlyphUsage,
  formatGlyphTooltip,
  glyphCacheClause,
} from "../pacing/threadContextGlyph.logic";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  /** Cache fields of the live provider-turn report `usage` was derived from, if any. */
  liveUsage: {
    promptCacheTtlMs?: number | undefined;
    requestIdentity?: RequestIdentity | undefined;
  } | null;
  /** What the next request would run with; a different model or effort drops the cache dot. */
  nextModelSelection: ModelSelection | null | undefined;
  timestampFormat: TimestampFormat;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  /** The agent is working, so compacting waits in the queue until it finishes. */
  compactQueues?: boolean | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    liveUsage,
    nextModelSelection,
    timestampFormat,
    modelDisplayName,
    onCompact,
    compactQueues,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const glyphUsage = useMemo(() => composerGlyphUsage(usage, liveUsage), [usage, liveUsage]);
  const model = useThreadContextGlyphModel(glyphUsage, nextModelSelection);
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  if (model === null) return null;
  const cacheClause = glyphCacheClause(model, timestampFormat);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={formatGlyphTooltip(model, timestampFormat)}
          >
            <span className="flex size-5 items-center justify-center">
              {/* mx-0! cancels Button's descendant-svg -mx-0.5 so the ring stays centred. */}
              <ThreadContextGlyph size={18} model={model} className="mx-0!" />
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  PACE_TIER_CLASSES[model.tierColor].bg,
                )}
                style={{ width: `${normalizedPercentage}%` }}
              />
            </div>
          ) : null}
          {cacheClause ? (
            <div className="text-pretty text-secondary-label text-2xs">{cacheClause}</div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                {compactQueues ? "Queue compaction" : "Compact context"}
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
