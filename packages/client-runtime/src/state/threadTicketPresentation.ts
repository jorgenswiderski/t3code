import {
  findPriorityInScale,
  jiraBrowseUrl,
  visibleThreadTicketLinks,
  type PriorityRef,
  type ThreadTicketLink,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { effectiveThreadPriority } from "./threadPriority.ts";

export type PriorityGlyphLevel = 0 | 1 | 2 | 3 | 4;

/** Five visual levels whatever the scale length, so any Jira scale maps to one glyph family. */
export function priorityGlyphLevel(position: number, scaleLength: number): PriorityGlyphLevel {
  if (scaleLength <= 1) return 2;
  const level = Math.round((4 * position) / (scaleLength - 1));
  return Math.min(4, Math.max(0, level)) as PriorityGlyphLevel;
}

export type ThreadPriorityIndicator =
  | {
      readonly kind: "resolved";
      readonly source: "user" | "jira" | "agent";
      readonly position: number;
      readonly level: PriorityGlyphLevel;
      readonly name: string;
      readonly ticketKey: string | null;
      readonly tooltip: string;
      readonly accessibilityLabel: string;
    }
  | {
      readonly kind: "unresolved";
      readonly source: "user" | "agent";
      readonly name: string;
      readonly tooltip: string;
      readonly accessibilityLabel: string;
    };

type IndicatorThread = Pick<EnvironmentThreadShell, "ticketLinks" | "priority">;

export function threadPriorityIndicator(
  thread: IndicatorThread,
  scale: ReadonlyArray<PriorityRef>,
): ThreadPriorityIndicator | null {
  const effective = effectiveThreadPriority(thread, scale);
  if (effective) {
    const name = effective.ref.name;
    const phrase =
      effective.source === "user"
        ? "You"
        : effective.source === "jira"
          ? `Jira ${effective.ticketKey}`
          : "Agent guess";
    const spoken =
      effective.source === "user"
        ? "set by you"
        : effective.source === "jira"
          ? `from Jira ${effective.ticketKey}`
          : "agent's guess";
    return {
      kind: "resolved",
      source: effective.source,
      position: effective.position,
      level: priorityGlyphLevel(effective.position, scale.length),
      name,
      ticketKey: effective.ticketKey,
      tooltip: `${name} · ${phrase}`,
      accessibilityLabel: `Priority ${name}, ${spoken}`,
    };
  }
  const stored = thread.priority.user
    ? ({ source: "user", ref: thread.priority.user } as const)
    : thread.priority.agent
      ? ({ source: "agent", ref: thread.priority.agent } as const)
      : null;
  if (stored === null) return null;
  const phrase = stored.source === "user" ? "You" : "Agent guess";
  const spoken = stored.source === "user" ? "set by you" : "agent's guess";
  return {
    kind: "unresolved",
    source: stored.source,
    name: stored.ref.name,
    tooltip: `${stored.ref.name} · ${phrase} · not on this scale`,
    accessibilityLabel: `Priority ${stored.ref.name}, ${spoken}, not on this scale`,
  };
}

/** Rows without any ticket data skip mounting the indicator, so they subscribe to nothing extra. */
export function threadHasTicketData(thread: IndicatorThread): boolean {
  return (
    thread.ticketLinks.length > 0 || thread.priority.user !== null || thread.priority.agent !== null
  );
}

export function threadPriorityMenu(
  thread: Pick<EnvironmentThreadShell, "priority"> &
    Partial<Pick<EnvironmentThreadShell, "ticketLinks">>,
  scale: ReadonlyArray<PriorityRef>,
): {
  readonly entries: ReadonlyArray<{ readonly ref: PriorityRef; readonly checked: boolean }>;
  readonly canClear: boolean;
  readonly currentLabel: string | null;
} {
  const user = thread.priority.user ? findPriorityInScale(scale, thread.priority.user) : null;
  return {
    entries: scale.map((ref, index) => ({ ref, checked: user?.position === index })),
    canClear: thread.priority.user !== null,
    currentLabel:
      threadPriorityIndicator(
        { priority: thread.priority, ticketLinks: thread.ticketLinks ?? [] },
        scale,
      )?.tooltip ?? null,
  };
}

export type TicketChipStatus =
  | {
      readonly kind: "synced";
      readonly name: string;
      readonly tone: "success" | "info" | "neutral";
    }
  | {
      readonly kind: "unreachable";
      readonly reason: "not_found" | "forbidden";
      readonly label: string;
      readonly reasonText: string;
    }
  | { readonly kind: "pending"; readonly label: string };

export interface TicketChip {
  readonly key: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly sourceLabel: string;
  readonly priorityName: string | null;
  readonly status: TicketChipStatus;
  readonly unreachable: boolean;
}

export interface TicketChipContext {
  readonly jiraConnected: boolean;
  readonly siteUrl: string | null;
}

const SOURCE_LABELS: Record<ThreadTicketLink["source"], string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
  branch: "Found in the branch name",
  "branch-dismissed": "Found in the branch name",
};

export function ticketChipModel(link: ThreadTicketLink, context: TicketChipContext): TicketChip {
  const status: TicketChipStatus =
    link.syncError !== null
      ? {
          kind: "unreachable",
          reason: link.syncError,
          label: "Unreachable",
          reasonText:
            link.syncError === "forbidden" ? "No access" : "Not found, or you can't see it",
        }
      : link.snapshot !== null
        ? {
            kind: "synced",
            name: link.snapshot.statusName,
            tone:
              link.snapshot.statusCategory === "done"
                ? "success"
                : link.snapshot.statusCategory === "indeterminate"
                  ? "info"
                  : "neutral",
          }
        : {
            kind: "pending",
            label: context.jiraConnected ? "Waiting for Jira" : "Jira not connected",
          };
  return {
    key: link.key,
    title: link.snapshot?.title ?? null,
    url: link.url ?? (context.siteUrl ? jiraBrowseUrl(context.siteUrl, link.key) : null),
    sourceLabel: SOURCE_LABELS[link.source],
    priorityName: link.snapshot?.priority?.name ?? null,
    status,
    unreachable: link.syncError !== null,
  };
}

export function visibleTicketChips(
  links: ReadonlyArray<ThreadTicketLink>,
  context: TicketChipContext,
): ReadonlyArray<TicketChip> {
  return visibleThreadTicketLinks(links).map((link) => ticketChipModel(link, context));
}

export interface TicketUiConfigInput {
  readonly environment?: { readonly capabilities?: { readonly threadTickets?: boolean } };
  readonly jiraStatus?: { readonly state: "disconnected" | "connected" | "error" };
}

/** Link UI needs Jira; a missing `jiraStatus` (older server) counts as disconnected. */
export function ticketUiAvailability(config: TicketUiConfigInput | null | undefined): {
  readonly priority: boolean;
  readonly linkTicket: boolean;
  readonly jiraConnected: boolean;
} {
  const priority = config?.environment?.capabilities?.threadTickets === true;
  const state = config?.jiraStatus?.state;
  const jiraConnected = priority && (state === "connected" || state === "error");
  return { priority, linkTicket: jiraConnected, jiraConnected };
}

export function jiraSyncNotice(
  status:
    | {
        readonly state: "disconnected" | "connected" | "error";
        readonly error: { readonly message: string; readonly since: string } | null;
      }
    | undefined,
): { readonly message: string; readonly since: string } | null {
  return status?.state === "error" && status.error
    ? { message: status.error.message, since: status.error.since }
    : null;
}

export const PRIORITY_MENU_ID = "priority";
export const PRIORITY_SET_MENU_PREFIX = "priority:set:";
export const PRIORITY_CLEAR_MENU_ID = "priority:clear";
export const LINK_TICKET_MENU_ID = "link-ticket";
export const UNLINK_TICKET_MENU_PREFIX = "unlink-ticket:";
export const OPEN_TICKETS_MENU_ID = "open-tickets";

export type TicketMenuAction =
  | { readonly type: "set-priority"; readonly priorityId: string }
  | { readonly type: "clear-priority" }
  | { readonly type: "link-ticket" }
  | { readonly type: "unlink-ticket"; readonly key: string }
  | { readonly type: "open-tickets" };

/** Scale ids may contain `:` (`default:high`), so only the prefix is stripped. */
export function parseTicketMenuAction(id: string): TicketMenuAction | null {
  if (id === PRIORITY_CLEAR_MENU_ID) return { type: "clear-priority" };
  if (id === LINK_TICKET_MENU_ID) return { type: "link-ticket" };
  if (id === OPEN_TICKETS_MENU_ID) return { type: "open-tickets" };
  if (id.startsWith(PRIORITY_SET_MENU_PREFIX)) {
    const priorityId = id.slice(PRIORITY_SET_MENU_PREFIX.length);
    return priorityId ? { type: "set-priority", priorityId } : null;
  }
  if (id.startsWith(UNLINK_TICKET_MENU_PREFIX)) {
    const key = id.slice(UNLINK_TICKET_MENU_PREFIX.length);
    return key ? { type: "unlink-ticket", key } : null;
  }
  return null;
}
