import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupTicketChips,
  jiraSyncNotice,
  ticketUiAvailability,
  visibleTicketChips,
  type TicketChip,
  type TicketChipGroupModel,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon, TicketIcon, XIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useThreadTicketActions } from "../../hooks/useThreadTicketActions";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { formatDayAwareTimestamp, formatRelativeTimeLabel } from "../../timestampFormat";
import { ticketsGroupKey, ticketsSectionKey, useUiStateStore } from "../../uiStateStore";
import { openLinkTicketDialog } from "../tickets/linkTicketDialogState";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./threadDetailsPanelStyles";

type ChipTone = "success" | "info" | "neutral" | "muted" | "warning";

const TONE_TEXT_CLASS: Record<ChipTone, string> = {
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  neutral: "text-muted-foreground",
  muted: "text-muted-foreground",
};

function chipTone(chip: TicketChip): ChipTone {
  return chip.status.kind === "unreachable" ? "warning" : chip.status.tone;
}

function chipStatusText(chip: TicketChip): string {
  const status = chip.status;
  return status.kind === "synced"
    ? status.name
    : status.kind === "unreachable"
      ? status.reasonText
      : status.label;
}

function TicketTooltipBody({ chip }: { readonly chip: TicketChip }) {
  const syncedAgo = chip.syncedAt ? formatRelativeTimeLabel(chip.syncedAt) : "";
  const source = syncedAgo ? `${chip.sourceLabel} \u00b7 synced ${syncedAgo}` : chip.sourceLabel;
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-1.5 px-1 py-2 text-xs leading-snug">
      <div className="min-w-0 font-medium text-foreground">{chip.title ?? chip.key}</div>
      <div className="grid gap-1 text-foreground/75">
        <div className="min-w-0 truncate">
          <span className={TONE_TEXT_CLASS[chipTone(chip)]}>{chipStatusText(chip)}</span>
          {chip.priorityName ? ` \u00b7 Priority ${chip.priorityName}` : null}
        </div>
        <div className="min-w-0 truncate">{source}</div>
      </div>
    </div>
  );
}

interface TicketRowActions {
  readonly canOperate: boolean;
  readonly onOpen: (chip: TicketChip, event: MouseEvent<HTMLElement>) => void;
  readonly onUnlink: (key: string) => void;
}

function TicketRow({
  chip,
  canOperate,
  onOpen,
  onUnlink,
}: TicketRowActions & { chip: TicketChip }) {
  const tone = chipTone(chip);
  const fallback = chip.status.kind === "synced" ? "" : chipStatusText(chip);
  return (
    <li
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
                    onClick: (event: MouseEvent<HTMLElement>) => onOpen(chip, event),
                    onAuxClick: (event: MouseEvent<HTMLElement>) => onOpen(chip, event),
                  })}
            />
          }
        >
          <TicketIcon aria-hidden className={cn("size-4 shrink-0", TONE_TEXT_CLASS[tone])} />
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              canOperate && "pe-5",
              (chip.unreachable || chip.group === "done") && "opacity-60",
            )}
          >
            <span className="shrink-0 font-mono text-xs text-foreground/85">{chip.key}</span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                THREAD_DETAILS_PANEL_LABEL_CLASS,
                chip.title !== null
                  ? "text-muted-foreground"
                  : tone === "warning"
                    ? "text-warning-foreground"
                    : "text-muted-foreground italic",
              )}
            >
              {chip.title ?? fallback}
            </span>
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
            onClick={() => onUnlink(chip.key)}
          >
            <XIcon aria-hidden className="size-3" />
          </ThreadDetailsControl>
        </div>
      ) : null}
    </li>
  );
}

function TicketRows({
  chips,
  ...actions
}: TicketRowActions & { readonly chips: ReadonlyArray<TicketChip> }) {
  return (
    <ul className="m-0 list-none p-0">
      {chips.map((chip) => (
        <TicketRow key={chip.key} chip={chip} {...actions} />
      ))}
    </ul>
  );
}

function TicketGroup({
  threadKey,
  model,
  ...actions
}: TicketRowActions & { readonly threadKey: string; readonly model: TicketChipGroupModel }) {
  const foldKey = ticketsGroupKey(threadKey, model.group);
  const open =
    useUiStateStore((store) => store.ticketsExpandedByKey[foldKey]) ?? !model.defaultCollapsed;
  const setTicketsExpanded = useUiStateStore((store) => store.setTicketsExpanded);
  return (
    <li>
      <CollapsibleSectionHeader
        variant="panel"
        tone={model.tone === "warning" ? "warning" : "muted"}
        expanded={open}
        onClick={() => setTicketsExpanded(foldKey, !open)}
        accessory={
          <span className="shrink-0 text-2xs font-normal tabular-nums">{model.chips.length}</span>
        }
      >
        {model.label}
      </CollapsibleSectionHeader>
      {open ? <TicketRows chips={model.chips} {...actions} /> : null}
    </li>
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
  const threadKey = scopedThreadKey(threadRef);
  const sectionKey = ticketsSectionKey(threadKey);
  const expanded = useUiStateStore((store) => store.ticketsExpandedByKey[sectionKey]) ?? true;
  const setTicketsExpanded = useUiStateStore((store) => store.setTicketsExpanded);

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

  const groups = groupTicketChips(chips);
  const unreachableCount = chips.filter((chip) => chip.unreachable).length;
  const rowActions = {
    canOperate,
    onOpen: open,
    onUnlink: (key: string) => void unlinkThreadTicket(threadRef, key),
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-tickets-heading"
      title="Jira tickets"
      data-thread-tickets-panel=""
      actions={
        <>
          {chips.length > 0 ? (
            <>
              <span className="min-w-0 truncate text-2xs tabular-nums text-muted-foreground">
                {chips.length}
                {!expanded && unreachableCount > 0 ? (
                  <>
                    {" \u00b7 "}
                    <span className="text-warning-foreground">{unreachableCount} unreachable</span>
                  </>
                ) : null}
              </span>
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} Jira tickets`}
                onClick={() => setTicketsExpanded(sectionKey, !expanded)}
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    !expanded && "-rotate-90",
                  )}
                />
              </ThreadDetailsControl>
            </>
          ) : null}
          {canLink ? (
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
          ) : null}
        </>
      }
    >
      {expanded ? (
        <>
          {groups.length === 1 ? (
            <TicketRows chips={chips} {...rowActions} />
          ) : (
            <ul className="m-0 list-none p-0">
              {groups.map((model) => (
                <TicketGroup
                  key={model.group}
                  threadKey={threadKey}
                  model={model}
                  {...rowActions}
                />
              ))}
            </ul>
          )}
          {notice ? (
            <p className="px-2.5 pt-1 text-2xs text-muted-foreground">
              Jira could not be reached since{" "}
              {formatDayAwareTimestamp(notice.since, timestampFormat)}. Showing the last known data.
            </p>
          ) : null}
        </>
      ) : null}
    </ThreadDetailsSection>
  );
}
