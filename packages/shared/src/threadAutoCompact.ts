export interface ThreadAutoCompactRange {
  readonly minTokens: number;
  readonly maxTokens: number;
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
  if (input.windowTokens != null && input.windowTokens > 0 && clamped >= input.windowTokens) {
    return null;
  }
  return clamped;
}

/** What a live process should report as applied: effective ?? defaultTokens ?? null. */
export function resolveDesiredAppliedAutoCompactTokens(input: {
  readonly stored: number | null | undefined;
  readonly range: ThreadAutoCompactRange;
  readonly windowTokens: number | null | undefined;
  readonly defaultTokens: number | null | undefined;
}): number | null {
  return resolveEffectiveAutoCompactTokens(input) ?? input.defaultTokens ?? null;
}
