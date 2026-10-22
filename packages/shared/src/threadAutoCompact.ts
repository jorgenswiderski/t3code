export interface ThreadAutoCompactRange {
  readonly minTokens: number;
  readonly maxTokens: number;
}

/**
 * A threshold at or above a known window never triggers, so the provider compacts as if none
 * was set: null. Applies to every threshold (per-thread, instance default, and an applied report
 * from a process loaded before the window was known). Unknown or non-positive window → unchanged.
 */
export function autoCompactTokensBelowWindow(input: {
  readonly tokens: number | null | undefined;
  readonly windowTokens: number | null | undefined;
}): number | null {
  if (input.tokens == null) return null;
  if (input.windowTokens != null && input.windowTokens > 0 && input.tokens >= input.windowTokens) {
    return null;
  }
  return input.tokens;
}

/**
 * The per-thread threshold a provider should run with, or null for "use the default".
 * null/undefined stored → null. Otherwise clamp to [minTokens, maxTokens]; then, when
 * windowTokens is a positive number and the clamped value is >= windowTokens → null
 * (a cap at or above the window would never trigger).
 */
export function resolveEffectiveAutoCompactTokens(input: {
  readonly stored: number | null | undefined;
  readonly range: ThreadAutoCompactRange;
  readonly windowTokens: number | null | undefined;
}): number | null {
  if (input.stored == null) return null;
  const clamped = Math.min(Math.max(input.stored, input.range.minTokens), input.range.maxTokens);
  return autoCompactTokensBelowWindow({ tokens: clamped, windowTokens: input.windowTokens });
}

/**
 * What a live process should report as applied: effective ?? defaultTokens ?? null. A default
 * at or above the window counts as no default, like a per-thread value would.
 */
export function resolveDesiredAppliedAutoCompactTokens(input: {
  readonly stored: number | null | undefined;
  readonly range: ThreadAutoCompactRange;
  readonly windowTokens: number | null | undefined;
  readonly defaultTokens: number | null | undefined;
}): number | null {
  return (
    resolveEffectiveAutoCompactTokens(input) ??
    autoCompactTokensBelowWindow({ tokens: input.defaultTokens, windowTokens: input.windowTokens })
  );
}
