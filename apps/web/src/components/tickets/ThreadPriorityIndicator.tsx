import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  threadPriorityIndicator,
  type PriorityGlyphLevel,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import {
  ChevronDownIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  EqualIcon,
} from "lucide-react";

import { environmentTicketPriorityScaleAtom } from "~/state/threadTickets";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LEVEL_GLYPHS = {
  0: { Icon: ChevronsUpIcon, tone: "text-destructive-foreground" },
  1: { Icon: ChevronUpIcon, tone: "text-warning-foreground" },
  2: { Icon: EqualIcon, tone: "text-muted-foreground/65" },
  3: { Icon: ChevronDownIcon, tone: "text-info-foreground" },
  4: { Icon: ChevronsDownIcon, tone: "text-muted-foreground/65" },
} satisfies Record<PriorityGlyphLevel, { Icon: typeof EqualIcon; tone: string }>;

/** Mounted only for threads with ticket data, so other rows pay nothing. */
export function ThreadPriorityIndicator({
  thread,
}: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "ticketLinks" | "priority">;
}) {
  const scale = useAtomValue(environmentTicketPriorityScaleAtom(thread.environmentId));
  const indicator = threadPriorityIndicator(thread, scale);
  if (indicator === null) return null;
  const dataAttributes =
    indicator.kind === "resolved"
      ? {
          "data-thread-priority": indicator.source,
          "data-thread-priority-position": indicator.position,
        }
      : { "data-thread-priority-unresolved": "" };
  const { Icon, tone } =
    indicator.kind === "resolved"
      ? LEVEL_GLYPHS[indicator.level]
      : { Icon: CircleDashedIcon, tone: "text-muted-foreground/65" };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={indicator.accessibilityLabel}
            className="inline-flex shrink-0 items-center"
            {...dataAttributes}
          />
        }
      >
        <Icon aria-hidden className={`size-3 shrink-0 ${tone}`} />
      </TooltipTrigger>
      <TooltipPopup side="top">{indicator.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
