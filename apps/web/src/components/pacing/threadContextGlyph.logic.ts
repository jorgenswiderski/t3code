import type { ModelSelection, TimestampFormat } from "@t3tools/contracts";
import {
  CONTEXT_TIER_COLORS,
  cacheExpiresAtMs,
  cacheWarmth,
  contextFraction,
  contextTier,
  formatThreadContextTooltip,
  requestIdentityFromModelSelection,
  type CacheWarmth,
  type PaceTier,
  type PaceTierColor,
  type RequestIdentity,
} from "@t3tools/shared/usagePacing";

export type GlyphSize = 14 | 18;

/** Structural subset of OrchestrationV2ProviderTurnTokenUsage; the contract type is assignable to it. */
export interface ThreadContextUsage {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
  readonly updatedAt: string;
  readonly promptCacheTtlMs?: number | undefined;
  readonly requestIdentity?: RequestIdentity | undefined;
}

export interface ThreadContextGlyphModel {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly tier: PaceTier;
  readonly tierColor: PaceTierColor;
  /** contextFraction(usage): null means no arc. */
  readonly fraction: number | null;
  readonly cacheState: CacheWarmth;
  readonly expiresAtMs: number | null;
}

/**
 * Everything the glyph and its tooltip show, for one usage report at `nowMs`. `null` means the
 * thread has no usage and gets no glyph. `nextSelection` is the identity the next request would
 * carry (the composer's picker, or the thread's stored selection in the sidebar).
 */
export function resolveThreadContextGlyph(
  usage: ThreadContextUsage | null | undefined,
  nextSelection: ModelSelection | null | undefined,
  nowMs: number,
): ThreadContextGlyphModel | null {
  if (usage === null || usage === undefined) return null;
  const tier = contextTier(usage);
  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens ?? null,
    tier,
    tierColor: CONTEXT_TIER_COLORS[tier],
    fraction: contextFraction(usage),
    cacheState: cacheWarmth(usage, requestIdentityFromModelSelection(nextSelection), nowMs),
    expiresAtMs: cacheExpiresAtMs(usage),
  };
}

/**
 * Composer input: the context snapshot plus the cache fields of the live provider-turn report it
 * was derived from. Without a live report (or for a compaction report) the cache state is unknown.
 * Optional keys are only set when defined (exactOptionalPropertyTypes).
 */
export function composerGlyphUsage(
  snapshot: {
    readonly usedTokens: number;
    readonly maxTokens?: number | null | undefined;
    readonly updatedAt: string;
  },
  live:
    | {
        readonly promptCacheTtlMs?: number | undefined;
        readonly requestIdentity?: RequestIdentity | undefined;
      }
    | null
    | undefined,
): ThreadContextUsage {
  return {
    usedTokens: snapshot.usedTokens,
    maxTokens: snapshot.maxTokens ?? null,
    updatedAt: snapshot.updatedAt,
    ...(live?.promptCacheTtlMs !== undefined ? { promptCacheTtlMs: live.promptCacheTtlMs } : {}),
    ...(live?.requestIdentity !== undefined ? { requestIdentity: live.requestIdentity } : {}),
  };
}

export interface GlyphGeometry {
  readonly size: GlyphSize;
  readonly center: number;
  readonly radius: number;
  readonly strokeWidth: number;
  readonly circumference: number;
  readonly dotRadius: number;
}

const STROKE_WIDTH: Record<GlyphSize, number> = { 14: 1.6, 18: 2 };

export function glyphGeometry(size: GlyphSize): GlyphGeometry {
  const strokeWidth = STROKE_WIDTH[size];
  // The stroke is centred on the path, so inset the radius by half of it to keep
  // the outer edge exactly on the viewBox (14 -> r 6.2, 18 -> r 8).
  const radius = (size - strokeWidth) / 2;
  return {
    size,
    center: size / 2,
    radius,
    strokeWidth,
    circumference: 2 * Math.PI * radius,
    dotRadius: size * 0.15, // 14 -> 2.1, 18 -> 2.7
  };
}

/** Dash pattern that paints `fraction` of the circle from the path start, or null for "no arc". */
export function arcDashArray(fraction: number | null, circumference: number): string | null {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return null;
  const painted = Math.min(1, fraction) * circumference;
  return `${painted} ${circumference}`;
}

// Full literals so Tailwind's scanner emits them. The mix lives in a custom property because an
// arbitrary `fill-[color-mix(...)]` value and a raw `fill="color-mix(...)"` attribute both fail lint.
const WARM_DOT_CLASS = "fill-muted-foreground";
const EXPIRING_DOT_CLASS =
  "[--thread-glyph-dot:color-mix(in_oklab,var(--color-warning)_45%,var(--color-muted-foreground))] fill-(--thread-glyph-dot)";

/** Class painting the cache dot, or null when there is no dot (cold or unknown). */
export function dotFillClass(cacheState: CacheWarmth): string | null {
  switch (cacheState) {
    case "warm":
      return WARM_DOT_CLASS;
    case "expiring":
      return EXPIRING_DOT_CLASS;
    case "cold":
    case "unknown":
      return null;
  }
}

export function formatGlyphTooltip(
  model: ThreadContextGlyphModel,
  timestampFormat: TimestampFormat,
): string {
  return formatThreadContextTooltip({
    usedTokens: model.usedTokens,
    maxTokens: model.maxTokens,
    warmth: model.cacheState,
    expiresAtMs: model.expiresAtMs,
    timestampFormat,
  });
}

/**
 * The cache part of the tooltip ("Cache warm, expires 3:12pm"), or null when the cache state is
 * unknown. Derived from the single shared formatter rather than duplicating its wording.
 */
export function glyphCacheClause(
  model: ThreadContextGlyphModel,
  timestampFormat: TimestampFormat,
): string | null {
  const tooltip = formatGlyphTooltip(model, timestampFormat);
  const separator = tooltip.indexOf(" · ");
  return separator === -1 ? null : tooltip.slice(separator + 3);
}
