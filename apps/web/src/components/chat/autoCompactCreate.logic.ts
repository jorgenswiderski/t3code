import type { ServerProviderThreadAutoCompact } from "@t3tools/contracts";

/**
 * Thread-creation fragment for the composer draft's auto-compact cap. The key is omitted (not
 * null or undefined) unless a value is set and the target provider declares the capability, so an
 * older server or an unsupported provider never receives it. A value outside the provider's range
 * is still sent: the server stores it and the adapter clamps what it applies.
 */
export function resolveCreateAutoCompactTokens(input: {
  readonly draftTokens: number | null | undefined;
  readonly capability: ServerProviderThreadAutoCompact | undefined;
}): { autoCompactTokens: number } | Record<string, never> {
  if (input.draftTokens == null || input.capability === undefined) return {};
  return { autoCompactTokens: input.draftTokens };
}
