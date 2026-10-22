import {
  contextWindowTokensFromSelection,
  deriveThreadAutoCompactView,
  type ThreadAutoCompactView,
} from "@t3tools/client-runtime/thread-auto-compact";
import type {
  ModelSelection,
  OrchestrationV2AppliedAutoCompact,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderModel,
  ServerProviderThreadAutoCompact,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

// Used when the provider did not report its cache TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;
const CLAUDE_RESUME_COMPACTION_TOKENS = 100_000;

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

/** True once a large Claude context's prompt cache has expired, so the next
    turn would re-read all of it uncached. */
export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < CLAUDE_RESUME_COMPACTION_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
  );
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/**
 * Whether the footer should hold the meter's slot before a snapshot exists.
 *
 * The snapshot comes from thread activities, which load after the shell.
 * Reserving the slot while the detail loads, for a started thread, keeps the
 * attach button still until the meter mounts. Once the detail is in, a
 * missing snapshot means there is no usage to show and nothing is reserved.
 *
 * The meter renders from stored activities whatever the provider's state, so
 * only a provider known not to stream usage skips the reservation. An unknown
 * provider (catalog still loading, or the thread's provider disabled) reserves.
 */
export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  /** `null` while the thread's provider is not in the catalog. */
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
