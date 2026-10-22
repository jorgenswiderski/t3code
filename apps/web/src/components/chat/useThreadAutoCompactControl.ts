import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export const AUTO_COMPACT_NO_OPERATE_REASON = "This connection cannot change threads.";

/**
 * The auto-compact value the composer shows and how it changes. Before the thread exists the value
 * lives in the composer draft (and travels with creation); afterwards it is thread state and a
 * change is a command, so the control follows the thread shell once the event lands.
 */
export function useThreadAutoCompactControl(input: {
  isLocalDraftThread: boolean;
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  serverStored: number | null | undefined;
  canOperateThread: boolean;
}): {
  stored: number | null;
  disabledReason: string | null;
  onChange: (tokens: number | null) => void;
} {
  const { isLocalDraftThread, composerDraftTarget, environmentId, threadId, canOperateThread } =
    input;
  const draftStored = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.autoCompactTokens ?? null,
  );
  const setDraftAutoCompactTokens = useComposerDraftStore((store) => store.setAutoCompactTokens);
  const setThreadAutoCompact = useOrchestrationCommand(threadEnvironment.setAutoCompact, {
    reportFailure: false,
  });

  const onChange = useCallback(
    (tokens: number | null) => {
      if (isLocalDraftThread) {
        setDraftAutoCompactTokens(composerDraftTarget, tokens);
        return;
      }
      void (async () => {
        const result = await setThreadAutoCompact({
          environmentId,
          input: { threadId, autoCompactTokens: tokens, createdAt: new Date().toISOString() },
        });
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change auto-compact",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })();
    },
    [
      composerDraftTarget,
      environmentId,
      isLocalDraftThread,
      setDraftAutoCompactTokens,
      setThreadAutoCompact,
      threadId,
    ],
  );

  return {
    stored: isLocalDraftThread ? draftStored : (input.serverStored ?? null),
    disabledReason:
      !isLocalDraftThread && !canOperateThread ? AUTO_COMPACT_NO_OPERATE_REASON : null,
    onChange,
  };
}
