import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ticketPriorityScaleOf } from "@t3tools/client-runtime/state/thread-priority";
import {
  parseTicketMenuAction,
  ticketUiAvailability,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import {
  AuthOrchestrationOperateScope,
  jiraBrowseUrl,
  parseTicketReference,
  type ThreadTicketKey,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useEnvironmentScope } from "../../state/session";
import { readEnvironmentServerConfig } from "../../state/thread-tickets";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Per thread, so list rows and the tickets sheet share one set of actions. */
export function useThreadTicketActions(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id"> | null,
) {
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const setPriorityCommand = useAtomCommand(threadEnvironment.setPriority, {
    reportFailure: false,
  });
  const linkTicketCommand = useAtomCommand(threadEnvironment.linkTicket, { reportFailure: false });
  const unlinkTicketCommand = useAtomCommand(threadEnvironment.unlinkTicket, {
    reportFailure: false,
  });

  const run = async (
    failureTitle: string,
    pending: Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    const result = await pending;
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, cause instanceof Error ? cause.message : "Try again.");
  };

  /** `priorityId` null clears the user's own priority. */
  const setPriority = (priorityId: string | null) => {
    if (thread === null || !canOperate) return;
    const { environmentId } = thread;
    if (priorityId === null) {
      void run(
        "Couldn't clear priority",
        setPriorityCommand({
          environmentId,
          input: { threadId: thread.id, source: "user", priority: null },
        }),
      );
      return;
    }
    const priority = ticketPriorityScaleOf(readEnvironmentServerConfig(environmentId)).find(
      (entry) => entry.id === priorityId,
    );
    if (!priority) {
      Dialog.alert("Couldn't set priority", "That priority is no longer available.");
      return;
    }
    void run(
      "Couldn't set priority",
      setPriorityCommand({
        environmentId,
        input: { threadId: thread.id, source: "user", priority },
      }),
    );
  };

  const unlink = (key: string) => {
    if (thread === null || !canOperate) return;
    void run(
      "Couldn't unlink ticket",
      unlinkTicketCommand({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, key: key as ThreadTicketKey },
      }),
    );
  };

  const promptLink = () => {
    if (thread === null || !canOperate) return;
    const { environmentId } = thread;
    Dialog.prompt({
      title: "Link Jira ticket",
      message: "Paste a Jira link or enter a ticket key such as PROJ-123.",
      placeholder: "Jira URL or PROJ-123",
      initialValue: "",
      confirmText: "Link",
      onConfirm: (reference) => {
        const config = readEnvironmentServerConfig(environmentId);
        if (!ticketUiAvailability(config).linkTicket) {
          Dialog.alert("Couldn't link this ticket", "Jira isn't connected to this server.");
          return;
        }
        const parsed = parseTicketReference(reference);
        if (parsed === null) {
          Dialog.alert("Couldn't link this ticket", "Use a Jira link or a key like PROJ-123.");
          return;
        }
        const siteUrl = config?.settings.jira?.siteUrl ?? null;
        if (parsed.url !== null && siteUrl !== null && !sameOrigin(parsed.url, siteUrl)) {
          Dialog.alert(
            "Couldn't link this ticket",
            "That link is for a different Jira site than the one connected to this server.",
          );
          return;
        }
        const url = siteUrl !== null ? jiraBrowseUrl(siteUrl, parsed.key) : parsed.url;
        void run(
          "Couldn't link this ticket",
          linkTicketCommand({
            environmentId,
            input: {
              threadId: thread.id,
              key: parsed.key,
              source: "manual",
              ...(url ? { url } : {}),
            },
          }),
        );
      },
    });
  };

  const openTicket = (url: string) => {
    void tryOpenExternalUrl(url, "ticket").then((opened) => {
      if (!opened) Dialog.alert("Unable to open Jira ticket", "The ticket could not be opened.");
    });
  };

  /** Returns true when the id was a ticket action, so callers continue their own handling otherwise. */
  const handleTicketMenuAction = (actionId: string): boolean => {
    const action = parseTicketMenuAction(actionId);
    if (action === null) return false;
    switch (action.type) {
      case "set-priority":
        setPriority(action.priorityId);
        return true;
      case "clear-priority":
        setPriority(null);
        return true;
      case "link-ticket":
        promptLink();
        return true;
      case "unlink-ticket":
        unlink(action.key);
        return true;
      case "open-tickets":
        return false;
    }
  };

  return { canOperate, setPriority, unlink, promptLink, openTicket, handleTicketMenuAction };
}

export type ThreadTicketActions = ReturnType<typeof useThreadTicketActions>;
