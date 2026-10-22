import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  barTickLeftPercent,
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
  shouldIgnoreMeterClose,
  type ContextWindowAutoCompact,
} from "./ContextWindowMeter.logic";
import { AutoCompactControl } from "./AutoCompactControl";
import type { ModelSelection, TimestampFormat } from "@t3tools/contracts";
import type { RequestIdentity } from "@t3tools/shared/usagePacing";
import { Minimize2Icon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { PACE_TIER_CLASSES } from "../pacing/paceTierClasses";
import { ThreadContextGlyph, useThreadContextGlyphModel } from "../pacing/ThreadContextGlyph";
import {
  composerGlyphUsage,
  emptyThreadContextGlyphModel,
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

const EMPTY_USAGE_MESSAGE = "Usage appears after the first message.";

/**
 * Composer context ring and its popover. `usage: null` is a thread that has not started: the ring
 * is empty and the popover only offers the auto-compact control (so `autoCompact` is required,
 * otherwise nothing renders).
 */
export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  /** Per-thread auto-compact control; absent when the provider does not support it. */
  autoCompact?: ContextWindowAutoCompact | undefined;
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
    autoCompact,
    liveUsage,
    nextModelSelection,
    timestampFormat,
    modelDisplayName,
    onCompact,
    compactQueues,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const glyphUsage = useMemo(
    () => (usage === null ? null : composerGlyphUsage(usage, liveUsage)),
    [usage, liveUsage],
  );
  const liveModel = useThreadContextGlyphModel(glyphUsage, nextModelSelection);
  const emptyWindowTokens = autoCompact?.windowTokens ?? null;
  const emptyModel = useMemo(
    () => emptyThreadContextGlyphModel(emptyWindowTokens),
    [emptyWindowTokens],
  );
  const [open, setOpen] = useState(false);
  const customInputFocusedRef = useRef(false);
  const onCustomInputFocusChange = useCallback((focused: boolean) => {
    customInputFocusedRef.current = focused;
  }, []);
  const model = usage === null ? (autoCompact ? emptyModel : null) : liveModel;
  if (model === null) return null;
  const isEmpty = usage === null;
  const windowTokens = usage === null ? emptyWindowTokens : (usage.maxTokens ?? null);
  const usedPercentage = usage === null ? null : formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const cacheClause = isEmpty ? null : glyphCacheClause(model, timestampFormat);
  const tickFraction = autoCompact?.view.tickFraction ?? null;
  const barTickLeft = barTickLeftPercent(tickFraction);
  const compactsAutomaticallyMessage = usage?.compactsAutomatically
    ? formatContextWindowCompactionMessage(
        modelDisplayName,
        autoCompact?.appliedTokens ?? usage.autoCompactThreshold,
      )
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (
          shouldIgnoreMeterClose({
            nextOpen,
            reason: details.reason,
            editing: customInputFocusedRef.current,
          })
        ) {
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              isEmpty
                ? `Context window. ${EMPTY_USAGE_MESSAGE}`
                : formatGlyphTooltip(model, timestampFormat)
            }
          >
            <span className="flex size-5 items-center justify-center">
              {/* mx-0! cancels Button's descendant-svg -mx-0.5 so the ring stays centred. */}
              <ThreadContextGlyph
                size={18}
                model={model}
                tickFraction={tickFraction}
                emptyOutline={isEmpty}
                className="mx-0!"
              />
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
        width="md"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage === null ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                {windowTokens !== null ? `0 / ${formatContextWindowTokens(windowTokens)}` : "0"}
              </div>
            ) : usage.maxTokens !== null && usedPercentage ? (
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
          {windowTokens !== null ? (
            <div className="relative">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(normalizedPercentage)}
                aria-label="Context window usage"
              >
                {isEmpty ? null : (
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                      PACE_TIER_CLASSES[model.tierColor].bg,
                    )}
                    style={{ width: `${normalizedPercentage}%` }}
                  />
                )}
              </div>
              {barTickLeft === null ? null : (
                <div
                  aria-hidden="true"
                  className="absolute -top-[3px] -bottom-[3px] -ml-px w-0.5 rounded-xs bg-foreground"
                  style={{ left: `${barTickLeft}%` }}
                />
              )}
            </div>
          ) : null}
          {isEmpty ? (
            <div className="text-pretty text-secondary-label text-2xs">{EMPTY_USAGE_MESSAGE}</div>
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
          {usage?.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {autoCompact ? (
            <AutoCompactControl
              view={autoCompact.view}
              capability={autoCompact.capability}
              windowTokens={autoCompact.windowTokens}
              disabled={autoCompact.disabled}
              disabledReason={autoCompact.disabledReason}
              fallbackStatus={compactsAutomaticallyMessage}
              onChange={autoCompact.onChange}
              onEditingChange={onCustomInputFocusChange}
            />
          ) : compactsAutomaticallyMessage ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {compactsAutomaticallyMessage}
            </div>
          ) : null}
          {onCompact && !isEmpty ? (
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
