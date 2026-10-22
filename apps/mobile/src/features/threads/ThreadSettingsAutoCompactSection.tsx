import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  contextWindowTokensFromSelection,
  deriveThreadAutoCompactView,
} from "@t3tools/client-runtime/thread-auto-compact";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppliedAutoCompact,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appliedAutoCompactFromProjection,
  presentAutoCompactControl,
  resolveCustomCommit,
  resolveSegmentAction,
  type AutoCompactSegmentValue,
} from "./thread-auto-compact-presentation";

export type ThreadSettingsAutoCompactSource =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | {
      readonly kind: "draft";
      readonly value: number | null;
      readonly onChange: (value: number | null) => void;
    };

/**
 * "Auto-compact at" row of the thread settings sheet. Renders nothing when the staged model's
 * provider instance does not declare per-thread auto-compact support.
 */
export function ThreadSettingsAutoCompactSection(props: {
  readonly environmentId: EnvironmentId | null;
  /** The model shown in the sheet, including one staged but not yet applied. */
  readonly modelSelection: ModelSelection | null;
  readonly providerLabel: string | undefined;
  readonly source: ThreadSettingsAutoCompactSource | undefined;
}) {
  const { environmentId, modelSelection, providerLabel, source } = props;
  if (!source || !environmentId || !modelSelection) return null;
  return source.kind === "thread" ? (
    <ExistingThreadAutoCompact
      key={source.threadId}
      environmentId={environmentId}
      modelSelection={modelSelection}
      providerLabel={providerLabel}
      threadId={source.threadId}
    />
  ) : (
    <AutoCompactBody
      environmentId={environmentId}
      modelSelection={modelSelection}
      providerLabel={providerLabel}
      stored={source.value}
      applied={null}
      canEdit
      onSet={async (tokens) => {
        source.onChange(tokens);
        return null;
      }}
    />
  );
}

function ExistingThreadAutoCompact(props: {
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly providerLabel: string | undefined;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const detail = useEnvironmentThread(environmentId, threadId);
  const applied = useMemo(
    () => appliedAutoCompactFromProjection(Option.getOrNull(detail.data)),
    [detail.data],
  );
  const canEdit = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const setAutoCompact = useAtomCommand(threadEnvironment.setAutoCompact, {
    label: "thread auto-compact update",
    reportFailure: false,
  });
  const onSet = useCallback(
    async (tokens: number | null): Promise<string | null> => {
      const result = await setAutoCompact({
        environmentId,
        input: { threadId, autoCompactTokens: tokens },
      });
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
      const failure = squashAtomCommandFailure(result);
      const message =
        failure instanceof Error && failure.message.length > 0
          ? failure.message
          : "The auto-compact setting could not be changed.";
      Alert.alert("Could not update auto-compact", message);
      return message;
    },
    [environmentId, setAutoCompact, threadId],
  );
  // A queued creation that has not reached the server has no shell yet.
  if (shell === null) return null;
  return (
    <AutoCompactBody
      environmentId={environmentId}
      modelSelection={props.modelSelection}
      providerLabel={props.providerLabel}
      stored={shell.autoCompactTokens ?? null}
      applied={applied}
      canEdit={canEdit}
      onSet={onSet}
    />
  );
}

/** Resolves to a failure message, or null when the value was applied (or nothing happened). */
type SetAutoCompact = (tokens: number | null) => Promise<string | null>;

function AutoCompactBody(props: {
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly providerLabel: string | undefined;
  readonly stored: number | null;
  readonly applied: OrchestrationV2AppliedAutoCompact | null;
  readonly canEdit: boolean;
  readonly onSet: SetAutoCompact;
}) {
  const { stored, onSet } = props;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const provider = configs
    .get(props.environmentId)
    ?.providers.find((candidate) => candidate.instanceId === props.modelSelection.instanceId);
  const capability = provider?.threadAutoCompact;
  const windowTokens = contextWindowTokensFromSelection(
    props.modelSelection,
    provider?.models.find((model) => model.slug === props.modelSelection.model),
  );
  const view = deriveThreadAutoCompactView({
    capability,
    providerDisplayName:
      props.providerLabel ?? provider?.displayName ?? props.modelSelection.instanceId,
    stored,
    applied: props.applied,
    windowTokens,
  });

  const [customOpen, setCustomOpen] = useState(false);
  // The choice the user just made. It is shown while the set is in flight and, once it
  // succeeds, until the stored value first moves off what it was when the choice was made.
  // It is then dropped for good, so a later change back to that old value is not masked.
  const [inFlight, setInFlight] = useState<{
    readonly selected: AutoCompactSegmentValue;
    readonly storedBefore: number | null;
    readonly settled: boolean;
  } | null>(null);

  const submit = useCallback(
    async (tokens: number | null, selected: AutoCompactSegmentValue) => {
      setInFlight({ selected, storedBefore: stored, settled: false });
      const failure = await onSet(tokens);
      // On failure snap back to the stored choice.
      setInFlight(failure === null ? { selected, storedBefore: stored, settled: true } : null);
    },
    [onSet, stored],
  );

  // Adjusting state during render (not in an effect) drops the override before it can paint.
  if (inFlight?.settled === true && stored !== inFlight.storedBefore) setInFlight(null);

  if (view === null || capability === undefined) return null;

  const model = presentAutoCompactControl({ view, customOpen, canEdit: props.canEdit });
  const selected =
    inFlight !== null && (!inFlight.settled || stored === inFlight.storedBefore)
      ? inFlight.selected
      : model.selected;
  const customVisible = selected === "custom";

  return (
    <View>
      <Text
        accessibilityRole="header"
        className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted"
      >
        Auto-compact at
      </Text>
      <View className="mx-4 gap-2 overflow-hidden rounded-2xl bg-grouped-card p-3">
        <SegmentedControl
          size="compact"
          options={model.options}
          selected={selected}
          onSelect={(value) => {
            const action = resolveSegmentAction(value);
            if (action.kind === "open-custom") {
              setCustomOpen(true);
              return;
            }
            setCustomOpen(false);
            void Haptics.selectionAsync();
            void submit(action.tokens, value);
          }}
        />
        {customVisible ? (
          <CustomTokensInput
            key={model.customInput.initialText}
            initialText={model.customInput.initialText}
            disabled={!props.canEdit}
            onDismiss={() => setCustomOpen(false)}
            onCommit={(text) => {
              const commit = resolveCustomCommit({ text, capability, windowTokens, stored });
              if (commit.kind === "invalid") return commit.message;
              if (commit.kind === "set") void submit(commit.tokens, "custom");
              return null;
            }}
          />
        ) : null}
        {model.statusText !== null ? (
          <Text className="text-xs text-foreground-muted">{model.statusText}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Free-form value entry; commits on Done and on blur, and shows why a value was rejected.
 * Leaving it blank or unedited dismisses it instead of committing.
 */
function CustomTokensInput(props: {
  readonly initialText: string;
  readonly disabled: boolean;
  readonly onDismiss: () => void;
  /** Returns a validation message, or null when the value was accepted or unchanged. */
  readonly onCommit: (text: string) => string | null;
}) {
  const [text, setText] = useState(props.initialText);
  const [error, setError] = useState<string | null>(null);
  // Done fires submit and then blur; the second must not dispatch again.
  const [committedText, setCommittedText] = useState<string | null>(null);

  const commit = () => {
    if (committedText === text) return;
    if (text.trim() === "" || text === props.initialText) {
      props.onDismiss();
      return;
    }
    setCommittedText(text);
    setError(props.onCommit(text));
  };

  return (
    <View className="gap-1">
      <View className="rounded-full bg-input px-4" style={{ minHeight: 40 }}>
        <TextInput
          accessibilityLabel="Custom auto-compact value"
          autoCapitalize="none"
          autoCorrect={false}
          className="min-w-0 flex-1 py-0 text-sm text-foreground"
          editable={!props.disabled}
          placeholder="e.g. 250k"
          returnKeyType="done"
          style={{ minHeight: 40, includeFontPadding: false, textAlignVertical: "center" }}
          value={text}
          onBlur={commit}
          onChangeText={(next) => {
            setText(next);
            setError(null);
            setCommittedText(null);
          }}
          onSubmitEditing={commit}
        />
      </View>
      {error !== null ? <Text className="px-1 text-xs text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
