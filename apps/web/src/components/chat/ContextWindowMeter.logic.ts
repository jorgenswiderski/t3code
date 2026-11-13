import {
  contextWindowTokensFromSelection,
  deriveThreadAutoCompactView,
  type ThreadAutoCompactView,
} from "@t3tools/client-runtime/thread-auto-compact";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ModelSelection,
  OrchestrationV2AppliedAutoCompact,
  ProviderInstanceId,
  ServerProviderModel,
  ServerProviderThreadAutoCompact,
} from "@t3tools/contracts";

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}

/**
 * The per-thread auto-compact control's state for the meter popover. `view` is derived from the
 * stored value (it drives the tick and presets); `appliedTokens` is what the live session compacts
 * at, read against the window (see `ThreadAutoCompactView.appliedTokens`).
 */
export interface ContextWindowAutoCompact {
  readonly view: ThreadAutoCompactView;
  readonly capability: ServerProviderThreadAutoCompact;
  readonly windowTokens: number | null;
  readonly appliedTokens: number | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (tokens: number | null) => void;
}

/** Left offset in percent for the cap mark on the popover bar; null draws no mark. */
export function barTickLeftPercent(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    return null;
  }
  return fraction * 100;
}

/**
 * The meter opens on hover, so pointer drift would close it under a half-typed custom value.
 * Only the hover close is held back while the custom input has focus; escape, outside press and a
 * trigger click still close it. `reason` is Base UI's open-change reason.
 */
export function shouldIgnoreMeterClose(input: {
  readonly nextOpen: boolean;
  readonly reason: string;
  readonly editing: boolean;
}): boolean {
  return !input.nextOpen && input.reason === "trigger-hover" && input.editing;
}

/**
 * Whether a thread that has not started (so has no usage) gets the empty ring, which carries the
 * auto-compact control. The populated meter and the loading placeholder own their own slots.
 */
export function shouldShowEmptyContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly hasCapability: boolean;
  readonly hasSnapshot: boolean;
  readonly threadStarted: boolean;
  readonly reservingPlaceholder: boolean;
}): boolean {
  return (
    input.meterEnabled &&
    input.hasCapability &&
    !input.hasSnapshot &&
    !input.threadStarted &&
    !input.reservingPlaceholder
  );
}

/**
 * Meter state for the auto-compact control, or null when the selected provider instance does not
 * declare the capability. `applied` only counts when the composer still points at the instance the
 * live process runs under; another instance will start fresh, so nothing is pending.
 */
export function resolveContextWindowAutoCompact(input: {
  readonly capability: ServerProviderThreadAutoCompact | undefined;
  readonly providerDisplayName: string;
  readonly stored: number | null | undefined;
  readonly applied: OrchestrationV2AppliedAutoCompact | null | undefined;
  readonly threadProviderInstanceId: ProviderInstanceId | null;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly snapshotMaxTokens: number | null;
  readonly selection: ModelSelection;
  readonly selectedModel: ServerProviderModel | undefined;
  readonly canChange: boolean;
  readonly changeDeniedReason: string | null;
  readonly onChange: (tokens: number | null) => void;
}): ContextWindowAutoCompact | null {
  const { capability } = input;
  if (capability === undefined) return null;
  const windowTokens =
    input.snapshotMaxTokens ??
    contextWindowTokensFromSelection(input.selection, input.selectedModel);
  const applied =
    input.selectedInstanceId === input.threadProviderInstanceId ? (input.applied ?? null) : null;
  const view = deriveThreadAutoCompactView({
    capability,
    providerDisplayName: input.providerDisplayName,
    stored: input.stored,
    applied,
    windowTokens,
  });
  if (view === null) return null;
  return {
    view,
    capability,
    windowTokens,
    appliedTokens: view.appliedTokens,
    disabled: !input.canChange,
    disabledReason: input.canChange ? null : input.changeDeniedReason,
    onChange: input.onChange,
  };
}
