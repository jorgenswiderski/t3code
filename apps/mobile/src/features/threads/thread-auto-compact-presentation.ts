import type {
  OrchestrationV2AppliedAutoCompact,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderThreadAutoCompact,
} from "@t3tools/contracts";
import {
  formatAutoCompactTokens,
  validateCustomAutoCompactTokens,
  type ThreadAutoCompactView,
} from "@t3tools/client-runtime/thread-auto-compact";

/** "default" clears the value, "custom" opens the free-form input, a number is a preset. */
export type AutoCompactSegmentValue = "default" | "custom" | number;

export interface AutoCompactControlModel {
  readonly options: ReadonlyArray<{
    readonly value: AutoCompactSegmentValue;
    readonly label: string;
    readonly disabled: boolean;
  }>;
  readonly selected: AutoCompactSegmentValue;
  readonly statusText: string | null;
  readonly customInput: { readonly visible: boolean; readonly initialText: string };
}

/** Segments, selection and custom-input state for the thread settings "Auto-compact at" row. */
export function presentAutoCompactControl(input: {
  readonly view: ThreadAutoCompactView;
  /** The user tapped "Custom…" and has not committed a value yet. */
  readonly customOpen: boolean;
  /** The environment session holds the operate scope. */
  readonly canEdit: boolean;
}): AutoCompactControlModel {
  const { view, customOpen, canEdit } = input;
  const selected: AutoCompactSegmentValue =
    customOpen || view.choice.kind === "custom"
      ? "custom"
      : view.choice.kind === "preset"
        ? view.choice.tokens
        : "default";
  return {
    options: [
      { value: "default", label: "Default", disabled: !canEdit },
      ...view.presets.map((preset) => ({
        value: preset.tokens,
        label: preset.label,
        disabled: preset.disabled || !canEdit,
      })),
      { value: "custom", label: "Custom…", disabled: !canEdit },
    ],
    selected,
    statusText: view.statusText,
    customInput: {
      visible: selected === "custom",
      initialText: view.choice.kind === "custom" ? formatAutoCompactTokens(view.choice.tokens) : "",
    },
  };
}

export type AutoCompactSegmentAction =
  | { readonly kind: "set"; readonly tokens: number | null }
  | { readonly kind: "open-custom" };

export function resolveSegmentAction(value: AutoCompactSegmentValue): AutoCompactSegmentAction {
  if (value === "custom") return { kind: "open-custom" };
  return { kind: "set", tokens: value === "default" ? null : value };
}

export type AutoCompactCustomCommit =
  | { readonly kind: "set"; readonly tokens: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly message: string };

export function resolveCustomCommit(input: {
  readonly text: string;
  readonly capability: ServerProviderThreadAutoCompact;
  readonly windowTokens: number | null;
  readonly stored: number | null | undefined;
}): AutoCompactCustomCommit {
  const validation = validateCustomAutoCompactTokens({
    text: input.text,
    capability: input.capability,
    windowTokens: input.windowTokens,
  });
  if (!validation.ok) return { kind: "invalid", message: validation.message };
  return validation.tokens === input.stored
    ? { kind: "unchanged" }
    : { kind: "set", tokens: validation.tokens };
}

/** Applied report of the thread's active provider thread, or null. */
export function appliedAutoCompactFromProjection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads"> | null,
): OrchestrationV2AppliedAutoCompact | null {
  if (projection === null) return null;
  const activeId = projection.thread.activeProviderThreadId;
  if (activeId === null) return null;
  return (
    projection.providerThreads.find((providerThread) => providerThread.id === activeId)
      ?.appliedAutoCompact ?? null
  );
}

/** Value to send in thread creation, or undefined (omit the key). A provider that does not
    declare the capability (older server, unsupported provider) never receives the field. */
export function resolveCreationAutoCompactTokens(input: {
  readonly draftTokens: number | null | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "threadAutoCompact">>;
}): number | undefined {
  if (typeof input.draftTokens !== "number") return undefined;
  const provider = input.providers.find((candidate) => candidate.instanceId === input.instanceId);
  return provider?.threadAutoCompact === undefined ? undefined : input.draftTokens;
}
