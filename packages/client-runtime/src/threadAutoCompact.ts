import type {
  ModelSelection,
  OrchestrationV2AppliedAutoCompact,
  ServerProviderModel,
  ServerProviderThreadAutoCompact,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  resolveDesiredAppliedAutoCompactTokens,
  resolveEffectiveAutoCompactTokens,
} from "@t3tools/shared/threadAutoCompact";

export const THREAD_AUTO_COMPACT_PRESETS = [200_000, 300_000, 400_000] as const;

const CONTEXT_WINDOW_OPTION_ID = "contextWindow";

/** "200k", "250.5k", "1M", "1.25M": k below a million (no decimal when whole), M above. */
export function formatAutoCompactTokens(tokens: number): string {
  const thousands = Math.round(tokens / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(tokens / 10_000) / 100}M`;
}

/** "300000", "300,000", "300k", "1m", "1.5M" → integer tokens; anything else → null. */
export function parseAutoCompactTokensInput(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.trim().replace(/[,_\s]/g, ""));
  if (match === null) return null;
  const [, amount = "", suffix = ""] = match;
  if (amount.includes(".") && suffix === "") return null;
  const multiplier = suffix === "" ? 1 : suffix.toLowerCase() === "k" ? 1_000 : 1_000_000;
  return Math.round(Number(amount) * multiplier);
}

/** Window for a selection, first hit wins: the selection's `contextWindow` option id
    ("200k" → 200_000, "1m" → 1_000_000); the model descriptor's default `contextWindow`
    option; `model.contextWindowTokens`; else null. Callers pass the selected
    ServerProviderModel whenever they have it. */
export function contextWindowTokensFromSelection(
  modelSelection: ModelSelection,
  model?: ServerProviderModel | undefined,
): number | null {
  const selected = getModelSelectionStringOptionValue(modelSelection, CONTEXT_WINDOW_OPTION_ID);
  const fromSelection = selected === undefined ? null : parseAutoCompactTokensInput(selected);
  if (fromSelection !== null) return fromSelection;
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === CONTEXT_WINDOW_OPTION_ID,
  );
  const defaultOption =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.isDefault === true)
      : undefined;
  const fromDescriptor =
    defaultOption === undefined ? null : parseAutoCompactTokensInput(defaultOption.id);
  if (fromDescriptor !== null) return fromDescriptor;
  return model?.contextWindowTokens ?? null;
}

export type ThreadAutoCompactChoice =
  | { readonly kind: "default" }
  | { readonly kind: "preset"; readonly tokens: (typeof THREAD_AUTO_COMPACT_PRESETS)[number] }
  | { readonly kind: "custom"; readonly tokens: number };

export interface ThreadAutoCompactPresetState {
  readonly tokens: number;
  /** formatAutoCompactTokens(tokens) */
  readonly label: string;
  /** tokens >= windowTokens (when known), or outside [minTokens, maxTokens]. */
  readonly disabled: boolean;
}

export type ThreadAutoCompactCustomValidation =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly message: string };

/** Checks a Custom entry: it must parse, sit in the provider's range, and stay below the window. */
export function validateCustomAutoCompactTokens(input: {
  readonly text: string;
  readonly capability: ServerProviderThreadAutoCompact;
  readonly windowTokens: number | null;
}): ThreadAutoCompactCustomValidation {
  const tokens = parseAutoCompactTokensInput(input.text);
  if (tokens === null) return { ok: false, message: "Enter a number of tokens, like 250k." };
  const { minTokens, maxTokens } = input.capability;
  if (tokens < minTokens || tokens > maxTokens) {
    return {
      ok: false,
      message: `Enter a value from ${formatAutoCompactTokens(minTokens)} to ${formatAutoCompactTokens(maxTokens)}.`,
    };
  }
  if (input.windowTokens != null && input.windowTokens > 0 && tokens >= input.windowTokens) {
    return {
      ok: false,
      message: `Must be below this model's ${formatAutoCompactTokens(input.windowTokens)} window.`,
    };
  }
  return { ok: true, tokens };
}

export interface ThreadAutoCompactView {
  /** From the stored value. */
  readonly choice: ThreadAutoCompactChoice;
  readonly presets: ReadonlyArray<ThreadAutoCompactPresetState>;
  /** resolveEffectiveAutoCompactTokens */
  readonly effectiveTokens: number | null;
  readonly pending: boolean;
  /** effectiveTokens / windowTokens when the stored value is non-null and both are known;
      null otherwise (no tick). Uses the stored value, not the applied one. */
  readonly tickFraction: number | null;
  /** The line under the presets; null when stored is null and nothing is pending,
      so the caller keeps the existing "Compacts automatically …" message. */
  readonly statusText: string | null;
}

function choiceFor(stored: number | null | undefined): ThreadAutoCompactChoice {
  if (stored == null) return { kind: "default" };
  const preset = THREAD_AUTO_COMPACT_PRESETS.find((tokens) => tokens === stored);
  return preset === undefined
    ? { kind: "custom", tokens: stored }
    : { kind: "preset", tokens: preset };
}

/** null when capability is undefined → hide the control (and the empty ring). */
export function deriveThreadAutoCompactView(input: {
  readonly capability: ServerProviderThreadAutoCompact | undefined;
  /** The resolved instance display name the client already shows, e.g. "Claude". */
  readonly providerDisplayName: string;
  readonly stored: number | null | undefined;
  /** Active provider thread's appliedAutoCompact; null/undefined for new threads or no report. */
  readonly applied: OrchestrationV2AppliedAutoCompact | null | undefined;
  readonly windowTokens: number | null;
}): ThreadAutoCompactView | null {
  const { capability, stored, applied, windowTokens } = input;
  if (capability === undefined) return null;
  const range = { minTokens: capability.minTokens, maxTokens: capability.maxTokens };
  const defaultTokens = capability.defaultTokens;
  const effectiveTokens = resolveEffectiveAutoCompactTokens({ stored, range, windowTokens });
  const desired = resolveDesiredAppliedAutoCompactTokens({
    stored,
    range,
    windowTokens,
    defaultTokens,
  });
  const pending = applied != null && applied.tokens !== desired;
  const defaultLabel =
    defaultTokens != null
      ? formatAutoCompactTokens(defaultTokens)
      : `${input.providerDisplayName} default`;

  const presets = THREAD_AUTO_COMPACT_PRESETS.map((tokens) => ({
    tokens,
    label: formatAutoCompactTokens(tokens),
    disabled:
      (windowTokens != null && windowTokens > 0 && tokens >= windowTokens) ||
      tokens < range.minTokens ||
      tokens > range.maxTokens,
  }));

  const tickFraction =
    stored != null && effectiveTokens != null && windowTokens != null && windowTokens > 0
      ? effectiveTokens / windowTokens
      : null;

  let statusText: string | null = null;
  if (applied != null && pending) {
    const pendingLabel =
      effectiveTokens != null ? formatAutoCompactTokens(effectiveTokens) : "Default";
    const appliedLabel =
      applied.tokens != null ? formatAutoCompactTokens(applied.tokens) : defaultLabel;
    statusText = `${pendingLabel} · applies after the session restarts. Currently compacts at ${appliedLabel}.`;
  } else if (stored != null && effectiveTokens === null) {
    statusText = `${formatAutoCompactTokens(stored)} is at or above this model's window, so this thread uses the default (${defaultLabel}).`;
  } else if (stored != null && effectiveTokens !== null) {
    statusText = `This thread compacts at ${formatAutoCompactTokens(effectiveTokens)} (default: ${defaultLabel}).`;
  }

  return {
    choice: choiceFor(stored),
    presets,
    effectiveTokens,
    pending,
    tickFraction,
    statusText,
  };
}
