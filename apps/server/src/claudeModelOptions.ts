import type { ClaudeSettings, ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import {
  resolveDesiredAppliedAutoCompactTokens,
  resolveEffectiveAutoCompactTokens,
  type ThreadAutoCompactRange,
} from "@t3tools/shared/threadAutoCompact";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly queryIdentity: string;
}

/** Compile every Claude model option at the provider boundary. */
export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(isClaudeCatalogUltracodeEffort(resolvedEffort) ? { ultracode: true } : {}),
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  return {
    apiModelId,
    effort,
    promptEffort,
    settings,
    queryIdentity: JSON.stringify({ apiModelId, effort: effort ?? null, settings }),
  };
}

/**
 * Claude compacts at about `autoCompactWindow` minus this many tokens. Measured
 * as a constant from 100k to 1M windows (per-thread auto-compact spike, CLI
 * 2.1.306 / SDK 0.3.276). The only place this buffer appears.
 */
export const CLAUDE_AUTO_COMPACT_BUFFER_TOKENS = 33_000;
/** SDK-accepted autoCompactWindow bounds; anything else is silently ignored by the CLI. */
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;
/** User-facing per-thread range Claude advertises (ServerProvider.threadAutoCompact). */
export const CLAUDE_THREAD_AUTO_COMPACT_RANGE: ThreadAutoCompactRange = {
  minTokens: 100_000,
  maxTokens: CLAUDE_AUTO_COMPACT_WINDOW_MAX - CLAUDE_AUTO_COMPACT_BUFFER_TOKENS,
};

/**
 * Instance "Auto-compact after" as user-facing tokens ("compacts at about N");
 * undefined when empty. Values above the advertised maximum count as that maximum.
 */
export function claudeInstanceAutoCompactTokens(
  settings: ClaudeSettings | undefined,
): number | undefined {
  const value = settings?.autoCompactWindow;
  if (value === undefined || value === "") return undefined;
  return Math.min(Number(value), CLAUDE_THREAD_AUTO_COMPACT_RANGE.maxTokens);
}

/** User-facing tokens → SDK `autoCompactWindow`, clamped to the range the SDK accepts. */
export function claudeAutoCompactWindowForTokens(tokens: number): number {
  return Math.min(
    Math.max(tokens + CLAUDE_AUTO_COMPACT_BUFFER_TOKENS, CLAUDE_AUTO_COMPACT_WINDOW_MIN),
    CLAUDE_AUTO_COMPACT_WINDOW_MAX,
  );
}

export interface ClaudeAutoCompactResolution {
  /** Value for options.settings.autoCompactWindow; undefined = omit the key. */
  readonly sdkWindow: number | undefined;
  /** User-facing tokens to report as appliedAutoCompact.tokens. */
  readonly appliedTokens: number | null;
}

/**
 * Resolve what a Claude process should compact at: the thread's stored value
 * wins over the instance setting, and both mean "compacts at about N tokens".
 * `appliedTokens` matches what clients derive from the advertised capability.
 */
export function resolveClaudeAutoCompact(input: {
  readonly stored: number | null | undefined;
  readonly modelSelection: ModelSelection;
  readonly settings: ClaudeSettings | undefined;
  readonly catalog?: ClaudeModelCatalog;
}): ClaudeAutoCompactResolution {
  const catalog = input.catalog ?? BUNDLED_CLAUDE_MODEL_CATALOG;
  const windowTokens =
    resolveClaudeCatalogContextWindowTokens(catalog, input.modelSelection) ?? null;
  const instanceTokens = claudeInstanceAutoCompactTokens(input.settings);
  const effective = resolveEffectiveAutoCompactTokens({
    stored: input.stored,
    range: CLAUDE_THREAD_AUTO_COMPACT_RANGE,
    windowTokens,
  });
  const sdkTokens = effective ?? instanceTokens;
  return {
    sdkWindow: sdkTokens === undefined ? undefined : claudeAutoCompactWindowForTokens(sdkTokens),
    appliedTokens: resolveDesiredAppliedAutoCompactTokens({
      stored: input.stored,
      range: CLAUDE_THREAD_AUTO_COMPACT_RANGE,
      windowTokens,
      defaultTokens: instanceTokens ?? null,
    }),
  };
}
