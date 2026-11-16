import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  jiraSyncNotice,
  ticketUiAvailability,
  visibleTicketChips,
  type TicketChip,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { PlusIcon, TicketIcon, XIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useThreadTicketActions } from "../../hooks/useThreadTicketActions";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { openLinkTicketDialog } from "../tickets/linkTicketDialogState";
import { Badge } from "../ui/badge";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_BADGE_VARIANT = { success: "success", info: "info", neutral: "secondary" } as const;

function statusBadge(chip: TicketChip) {
  switch (chip.status.kind) {
    case "synced":
      return { variant: STATUS_BADGE_VARIANT[chip.status.tone], text: chip.status.name };
    case "unreachable":
    case "pending":
      return { variant: "warning" as const, text: chip.status.label };
  }
}

function TicketTooltipBody({ chip }: { readonly chip: TicketChip }) {
  const status = chip.status;
  const lines = [
    [
      "status",
      status.kind === "synced"
        ? status.name
        : status.kind === "unreachable"
          ? status.reasonText
          : status.label,
    ],
    ["priority", chip.priorityName ? `Priority ${chip.priorityName}` : null],
    ["source", chip.sourceLabel],
  ] as const;
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-1.5 px-1 py-2">
      <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-snug">
        <span className="shrink-0 font-mono text-muted-foreground">{chip.key}</span>
        <span className="min-w-0 font-medium text-foreground">{chip.title ?? "No title yet"}</span>
      </div>
      <div className="grid gap-1 text-xs text-foreground/75">
        {lines.map(([field, line]) =>
          line === null ? null : (
            <div key={field} className="min-w-0 truncate">
              {line}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** Existing links always render and unlink, whatever the Jira state, so a disconnect is never a dead end. */
export function ThreadTicketsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useQuietThreadShell(threadRef);
  const config = useEnvironment(environmentId)?.serverConfig ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const openLink = useOpenLink(threadRef);
  const { unlinkThreadTicket } = useThreadTicketActions();

  const availability = ticketUiAvailability(config);
  if (!availability.priority || thread === null) return null;
  const chips = visibleTicketChips(thread.ticketLinks, {
    jiraConnected: availability.jiraConnected,
    siteUrl: config?.settings.jira?.siteUrl ?? null,
  });
  const canLink = availability.linkTicket && canOperate;
  if (chips.length === 0 && !canLink) return null;
  const notice = jiraSyncNotice(config?.jiraStatus);

  const open = (chip: TicketChip, event: MouseEvent<HTMLElement>) => {
    if (chip.url === null || event.button > 1) return;
    openLink(chip.url, { event }).catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open ticket",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-tickets-heading"
      title="Jira tickets"
      data-thread-tickets-panel=""
      actions={
        canLink ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Link Jira ticket"
                  onClick={() => openLinkTicketDialog(threadRef)}
                />
              }
            >
              <PlusIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Link Jira ticket</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      <ul className="m-0 list-none p-0">
        {chips.map((chip) => {
          const badge = statusBadge(chip);
          return (
            <li
              key={chip.key}
              data-ticket-key={chip.key}
              data-ticket-unreachable={chip.unreachable ? "" : undefined}
              className="group relative flex items-center rounded-lg"
            >
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      {...(chip.url === null
                        ? { render: <div />, className: "cursor-default" }
                        : {
                            onClick: (event: MouseEvent<HTMLElement>) => open(chip, event),
                            onAuxClick: (event: MouseEvent<HTMLElement>) => open(chip, event),
                          })}
                    />
                  }
                >
                  <TicketIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2",
                      chip.unreachable && "opacity-60",
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs text-foreground/85">
                      {chip.key}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-muted-foreground",
                        THREAD_DETAILS_PANEL_LABEL_CLASS,
                      )}
                    >
                      {chip.title}
                    </span>
                  </span>
                  <span className={cn("flex shrink-0 items-center", canOperate && "pe-6")}>
                    <Badge size="sm" variant={badge.variant}>
                      {badge.text}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipPopup
                  side="top"
                  align="start"
                  sideOffset={4}
                  variant="glass"
                  className="max-w-80 text-left whitespace-normal"
                >
                  <TicketTooltipBody chip={chip} />
                </TooltipPopup>
              </Tooltip>
              {canOperate ? (
                <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Unlink ${chip.key}`}
                    onClick={() => void unlinkThreadTicket(threadRef, chip.key)}
                  >
                    <XIcon aria-hidden className="size-3" />
                  </ThreadDetailsControl>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {notice ? (
        <p className="px-2.5 pt-1 text-2xs text-muted-foreground">
          Jira could not be reached since {formatDayAwareTimestamp(notice.since, timestampFormat)}.
          Showing the last known data.
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
