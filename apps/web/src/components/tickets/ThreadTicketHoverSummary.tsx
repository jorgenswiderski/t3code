import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ticketHoverSummary,
  visibleTicketChips,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { TicketIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  environmentTicketChipContextAtom,
  ticketChipFallbackText,
  ticketChipIconToneClass,
} from "./ticketChipPresentation";

/**
 * Hover card footer for threads with visible ticket links: ticket lines above `pullRequests`.
 * Falls back to `pullRequests` alone when the environment has no ticket support.
 */
export function ThreadTicketHoverFooter({
  thread,
  pullRequests,
  className,
}: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "ticketLinks">;
  readonly pullRequests: ReactNode;
  readonly className: string;
}) {
  const context = useAtomValue(environmentTicketChipContextAtom(thread.environmentId));
  const chips = context === null ? [] : visibleTicketChips(thread.ticketLinks, context);
  if (chips.length === 0) {
    return pullRequests === null ? null : <div className={className}>{pullRequests}</div>;
  }
  const summary = ticketHoverSummary(chips);
  const moreParts = [
    summary.hiddenUnreachable > 0 ? (
      <span key="unreachable" className="text-warning-foreground">
        {summary.hiddenUnreachable} unreachable
      </span>
    ) : null,
    summary.hiddenDone > 0 ? <span key="done">{summary.hiddenDone} done</span> : null,
  ].filter((part) => part !== null);
  return (
    <div className={cn(className, "flex flex-col gap-2")}>
      <ul className="flex flex-col gap-1" aria-label="Jira tickets">
        {summary.lines.map((chip) => {
          const fallback = ticketChipFallbackText(chip);
          return (
            <li key={chip.key} className="flex min-w-0 items-center gap-2">
              <TicketIcon
                aria-hidden
                className={cn("size-3 shrink-0", ticketChipIconToneClass(chip))}
              />
              <span className="shrink-0 font-mono tabular-nums">{chip.key}</span>
              <span
                className={cn(
                  "min-w-0 truncate",
                  fallback === null
                    ? "text-foreground/75"
                    : fallback.warning
                      ? "text-warning-foreground"
                      : "text-muted-foreground",
                )}
              >
                {chip.title ?? fallback?.text}
              </span>
            </li>
          );
        })}
        {summary.hidden > 0 ? (
          <li className="ps-5">
            +{summary.hidden} more
            {moreParts.map((part) => (
              <span key={part.key}> · {part}</span>
            ))}
          </li>
        ) : null}
      </ul>
      {pullRequests}
    </div>
  );
}
