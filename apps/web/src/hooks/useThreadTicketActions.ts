import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ticketPriorityScaleOf } from "@t3tools/client-runtime/state/thread-priority";
import {
  parseTicketMenuAction,
  threadPriorityMenu,
  ticketUiAvailability,
  visibleTicketChips,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import type { ScopedThreadRef, ServerConfig, ThreadTicketKey } from "@t3tools/contracts";

import { openLinkTicketDialog } from "../components/tickets/LinkTicketDialog";
import type { ThreadTicketMenuState } from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentServerConfig } from "../state/threadTickets";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Computed once for every thread menu so the sidebar and the header cannot drift. */
export function buildTicketMenuState(
  thread: Pick<EnvironmentThreadShell, "ticketLinks" | "priority">,
  config: Pick<
    ServerConfig,
    "environment" | "jiraStatus" | "ticketPriorityScale" | "settings"
  > | null,
): ThreadTicketMenuState | undefined {
  const availability = ticketUiAvailability(config);
  if (!availability.priority) return undefined;
  const chips = visibleTicketChips(thread.ticketLinks, {
    jiraConnected: availability.jiraConnected,
    siteUrl: config?.settings.jira?.siteUrl ?? null,
  });
  return {
    priority: threadPriorityMenu(thread, ticketPriorityScaleOf(config)),
    canLink: availability.linkTicket,
    links: chips.map((chip) => ({
      key: chip.key,
      label: chip.title ? `${chip.key} · ${chip.title}` : chip.key,
    })),
  };
}

export function useThreadTicketActions() {
  const setPriorityCommand = useOrchestrationCommand(threadEnvironment.setPriority, {
    reportFailure: false,
  });
  const unlinkTicketCommand = useOrchestrationCommand(threadEnvironment.unlinkTicket, {
    reportFailure: false,
  });

  const report = async (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    const result = await run();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(title, squashAtomCommandFailure(result));
    }
  };

  /** `priorityId` null clears the user's own priority. */
  const setThreadPriority = (threadRef: ScopedThreadRef, priorityId: string | null) => {
    if (priorityId === null) {
      return report("Failed to clear priority", () =>
        setPriorityCommand({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, source: "user", priority: null },
        }),
      );
    }
    const priority = ticketPriorityScaleOf(
      readEnvironmentServerConfig(threadRef.environmentId),
    ).find((entry) => entry.id === priorityId);
    if (!priority) {
      failureToast("Failed to set priority", new Error("That priority is no longer available."));
      return Promise.resolve();
    }
    return report("Failed to set priority", () =>
      setPriorityCommand({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, source: "user", priority },
      }),
    );
  };

  const unlinkThreadTicket = (threadRef: ScopedThreadRef, key: string) =>
    report("Failed to unlink ticket", () =>
      unlinkTicketCommand({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, key: key as ThreadTicketKey },
      }),
    );

  /** Returns true when the id was a ticket action, so callers continue their own switch otherwise. */
  const handleTicketMenuAction = async (
    threadRef: ScopedThreadRef,
    actionId: string,
  ): Promise<boolean> => {
    const action = parseTicketMenuAction(actionId);
    if (action === null) return false;
    switch (action.type) {
      case "set-priority":
        await setThreadPriority(threadRef, action.priorityId);
        break;
      case "clear-priority":
        await setThreadPriority(threadRef, null);
        break;
      case "link-ticket":
        openLinkTicketDialog(threadRef);
        break;
      case "unlink-ticket":
        await unlinkThreadTicket(threadRef, action.key);
        break;
      case "open-tickets":
        return false;
    }
    return true;
  };

  return { handleTicketMenuAction, setThreadPriority, unlinkThreadTicket };
}
