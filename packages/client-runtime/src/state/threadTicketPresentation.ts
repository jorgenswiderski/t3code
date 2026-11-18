import {
  findPriorityInScale,
  jiraBrowseUrl,
  hasVisibleThreadTicketLinks,
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
    hasVisibleThreadTicketLinks(thread.ticketLinks) ||
    thread.priority.user !== null ||
    thread.priority.agent !== null
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
    canClear: thread.priority.user !== null || thread.priority.agent !== null,
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
  | { readonly kind: "pending"; readonly label: string; readonly tone: "muted" | "warning" };

export type TicketChipGroup = "inProgress" | "toDo" | "pending" | "unreachable" | "done";

export interface TicketChip {
  readonly key: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly sourceLabel: string;
  readonly priorityName: string | null;
  readonly status: TicketChipStatus;
  readonly group: TicketChipGroup;
  readonly syncedAt: string | null;
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
            tone: context.jiraConnected ? "muted" : "warning",
          };
  return {
    key: link.key,
    title: link.snapshot?.title ?? null,
    url: link.url ?? (context.siteUrl ? jiraBrowseUrl(context.siteUrl, link.key) : null),
    sourceLabel: SOURCE_LABELS[link.source],
    priorityName: link.snapshot?.priority?.name ?? null,
    status,
    group: chipGroupOf(link),
    syncedAt: link.snapshot?.syncedAt ?? null,
    unreachable: link.syncError !== null,
  };
}

function chipGroupOf(link: ThreadTicketLink): TicketChipGroup {
  if (link.syncError !== null) return "unreachable";
  if (link.snapshot === null) return "pending";
  switch (link.snapshot.statusCategory) {
    case "done":
      return "done";
    case "indeterminate":
      return "inProgress";
    default:
      return "toDo";
  }
}

export function visibleTicketChips(
  links: ReadonlyArray<ThreadTicketLink>,
  context: TicketChipContext,
): ReadonlyArray<TicketChip> {
  return visibleThreadTicketLinks(links).map((link) => ticketChipModel(link, context));
}

export const TICKET_CHIP_GROUP_ORDER: ReadonlyArray<TicketChipGroup> = [
  "inProgress",
  "toDo",
  "pending",
  "unreachable",
  "done",
];

const GROUP_RANK = Object.fromEntries(
  TICKET_CHIP_GROUP_ORDER.map((group, index) => [group, index]),
) as Record<TicketChipGroup, number>;

/** Stable: group order first, link order within a group. The one ordering every surface uses. */
export function orderTicketChips(chips: ReadonlyArray<TicketChip>): ReadonlyArray<TicketChip> {
  return chips
    .map((chip, index) => ({ chip, index }))
    .sort((a, b) => GROUP_RANK[a.chip.group] - GROUP_RANK[b.chip.group] || a.index - b.index)
    .map(({ chip }) => chip);
}

export interface TicketChipGroupModel {
  readonly group: TicketChipGroup;
  readonly label: string;
  readonly tone: "info" | "neutral" | "muted" | "warning" | "success";
  readonly chips: ReadonlyArray<TicketChip>;
  readonly defaultCollapsed: boolean;
}

/** Non-empty groups only, in `TICKET_CHIP_GROUP_ORDER`. */
export function groupTicketChips(
  chips: ReadonlyArray<TicketChip>,
): ReadonlyArray<TicketChipGroupModel> {
  const models: TicketChipGroupModel[] = [];
  for (const group of TICKET_CHIP_GROUP_ORDER) {
    const members = chips.filter((chip) => chip.group === group);
    const first = members[0];
    if (!first) continue;
    const pending = first.status.kind === "pending" ? first.status : null;
    models.push({
      group,
      label:
        group === "inProgress"
          ? "In progress"
          : group === "toDo"
            ? "To do"
            : group === "unreachable"
              ? "Unreachable"
              : group === "done"
                ? "Done"
                : (pending?.label ?? "Pending"),
      tone:
        group === "inProgress"
          ? "info"
          : group === "toDo"
            ? "neutral"
            : group === "unreachable"
              ? "warning"
              : group === "done"
                ? "success"
                : (pending?.tone ?? "muted"),
      chips: members,
      defaultCollapsed: group === "unreachable" || group === "done",
    });
  }
  return models;
}

/** The one ticket the inbox card shows. Null when the thread has no visible links. */
export function threadCardTicket(
  thread: IndicatorThread,
  scale: ReadonlyArray<PriorityRef>,
  context: TicketChipContext,
): { readonly chip: TicketChip; readonly others: number } | null {
  const chips = visibleTicketChips(thread.ticketLinks, context);
  if (chips.length === 0) return null;
  const effective = effectiveThreadPriority(thread, scale);
  const byPriority =
    effective?.source === "jira" ? chips.find((chip) => chip.key === effective.ticketKey) : null;
  const chip = byPriority ?? chips.find((candidate) => candidate.group !== "done") ?? chips[0]!;
  return { chip, others: chips.length - 1 };
}

export function ticketHoverSummary(
  chips: ReadonlyArray<TicketChip>,
  cap = 4,
): {
  readonly lines: ReadonlyArray<TicketChip>;
  readonly hidden: number;
  readonly hiddenUnreachable: number;
  readonly hiddenDone: number;
} {
  const ordered = orderTicketChips(chips);
  const hidden = ordered.slice(cap);
  return {
    lines: ordered.slice(0, cap),
    hidden: hidden.length,
    hiddenUnreachable: hidden.filter((chip) => chip.group === "unreachable").length,
    hiddenDone: hidden.filter((chip) => chip.group === "done").length,
  };
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
