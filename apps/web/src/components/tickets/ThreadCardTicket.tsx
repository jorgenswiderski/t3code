import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  threadCardTicket,
  type TicketChip,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { TicketIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { environmentTicketPriorityScaleAtom } from "~/state/threadTickets";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  environmentTicketChipContextAtom,
  ticketChipFallbackText,
  ticketChipIconToneClass,
  ticketChipStatusText,
} from "./ticketChipPresentation";

/**
 * Width bucket of the chip text, read by the meta line's container queries
 * (`TICKET_CHIP_PEER_HIDE_CLASS`) so the key never truncates without per-row measuring.
 */
type ChipSize = "s" | "m" | "l" | "xl";

function chipSize(key: string, others: number): ChipSize {
  const length = key.length + (others > 0 ? String(others).length + 2 : 0);
  return length <= 8 ? "s" : length <= 11 ? "m" : length <= 14 ? "l" : "xl";
}

/**
 * The meta line is `@container/meta group/meta`. Thresholds are the chip's widest text in its
 * bucket plus the PR badge, provider icon and gaps; the diff needs room beyond the PR badge.
 */
export const TICKET_CHIP_PR_HIDE_CLASS =
  "@max-[160px]/meta:group-has-[[data-ticket-chip=s]]/meta:hidden @max-[182px]/meta:group-has-[[data-ticket-chip=m]]/meta:hidden @max-[203px]/meta:group-has-[[data-ticket-chip=l]]/meta:hidden @max-[232px]/meta:group-has-[[data-ticket-chip=xl]]/meta:hidden";
export const TICKET_CHIP_DIFF_HIDE_CLASS =
  "@max-[216px]/meta:group-has-[[data-ticket-chip=s]]/meta:hidden @max-[238px]/meta:group-has-[[data-ticket-chip=m]]/meta:hidden @max-[259px]/meta:group-has-[[data-ticket-chip=l]]/meta:hidden @max-[288px]/meta:group-has-[[data-ticket-chip=xl]]/meta:hidden";

/**
 * Mounted only for threads with visible ticket links; renders `fallback` when the environment has
 * no ticket support. A null `onOpenTicketList` means there is nowhere to go (the thread is already
 * open), so several tickets render as a plain label instead of a button that does nothing.
 */
export function ThreadCardTicketSlot({
  thread,
  fallback,
  onOpenTicketList,
}: {
  readonly thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "ticketLinks" | "priority"
  >;
  readonly fallback: ReactNode;
  readonly onOpenTicketList: (() => void) | null;
}) {
  const context = useAtomValue(environmentTicketChipContextAtom(thread.environmentId));
  const scale = useAtomValue(environmentTicketPriorityScaleAtom(thread.environmentId));
  const cardTicket = context === null ? null : threadCardTicket(thread, scale, context);
  if (cardTicket === null) return fallback;
  return (
    <>
      <ThreadCardTicketChip
        thread={thread}
        chip={cardTicket.chip}
        others={cardTicket.others}
        onOpenTicketList={onOpenTicketList}
      />
      <span className="flex-1" />
    </>
  );
}

function ThreadCardTicketChip({
  thread,
  chip,
  others,
  onOpenTicketList,
}: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id">;
  readonly chip: TicketChip;
  readonly others: number;
  readonly onOpenTicketList: (() => void) | null;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const openLink = useOpenLink(threadRef);
  const statusText = ticketChipStatusText(chip);
  const label =
    others > 0
      ? `Jira ${chip.key} and ${others} more ${others === 1 ? "ticket" : "tickets"}`
      : `Jira ${chip.key}, ${statusText}`;
  const opensLink = others === 0 && chip.url !== null;

  const openTicket = (event: MouseEvent<HTMLElement>) => {
    if (chip.url === null || event.button > 1) return;
    event.preventDefault();
    event.stopPropagation();
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
  const openList = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenTicketList?.();
  };

  const content = (
    <span className="inline-flex items-center gap-1 font-normal text-xs tabular-nums">
      <TicketIcon aria-hidden className={cn("size-3 shrink-0", ticketChipIconToneClass(chip))} />
      <span className="font-mono text-foreground/80">{chip.key}</span>
      {others > 0 ? <span className="text-muted-foreground/65">+{others}</span> : null}
    </span>
  );
  const fallback = ticketChipFallbackText(chip);
  const tooltip = (
    <TooltipPopup side="top" className="max-w-72 text-left whitespace-normal">
      <span className="font-mono">{chip.key}</span> · {chip.title ?? fallback?.text ?? statusText}
      {others > 0 ? (
        <span className="block text-muted-foreground">
          {others === 1 ? "1 more ticket" : `${others} more tickets`}
        </span>
      ) : chip.title !== null ? (
        <span className="block text-muted-foreground">{statusText}</span>
      ) : null}
    </TooltipPopup>
  );

  if (!opensLink && !(others > 0 && onOpenTicketList !== null)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={chip.title === null ? label : `${label}, ${chip.title}`}
              data-ticket-chip={chipSize(chip.key, others)}
              className="inline-flex shrink-0 items-center"
            />
          }
        >
          {content}
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            render={
              opensLink ? (
                <a href={chip.url ?? undefined} target="_blank" rel="noopener noreferrer" />
              ) : (
                <button type="button" />
              )
            }
            aria-label={label}
            data-ticket-chip={chipSize(chip.key, others)}
            onPointerDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
            onClick={opensLink ? openTicket : openList}
            {...(opensLink ? { onAuxClick: openTicket } : {})}
          />
        }
      >
        {content}
      </TooltipTrigger>
      {tooltip}
    </Tooltip>
  );
}
