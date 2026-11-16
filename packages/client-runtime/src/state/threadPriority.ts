import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  findPriorityInScale,
  isReadableThreadTicketLink,
  type PriorityRef,
  type ThreadTicketKey,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { sortInboxThreadsByReturn, type InboxThreadInput } from "./threadInbox.ts";

export type ThreadPrioritySource = "user" | "jira" | "agent";

export interface EffectiveThreadPriority {
  readonly ref: PriorityRef;
  readonly source: ThreadPrioritySource;
  readonly position: number;
  readonly ticketKey: ThreadTicketKey | null;
}

type PriorityThreadInput = Pick<EnvironmentThreadShell, "ticketLinks" | "priority">;

export function effectiveThreadPriority(
  thread: PriorityThreadInput,
  scale: ReadonlyArray<PriorityRef>,
): EffectiveThreadPriority | null {
  const user = thread.priority.user && findPriorityInScale(scale, thread.priority.user);
  if (user) return { ...user, source: "user", ticketKey: null };
  let jira: EffectiveThreadPriority | null = null;
  for (const link of thread.ticketLinks) {
    const ticketPriority = isReadableThreadTicketLink(link) ? link.snapshot?.priority : null;
    if (!ticketPriority) continue;
    const match = findPriorityInScale(scale, ticketPriority);
    if (match && (jira === null || match.position < jira.position)) {
      jira = { ...match, source: "jira", ticketKey: link.key };
    }
  }
  if (jira) return jira;
  const agent = thread.priority.agent && findPriorityInScale(scale, thread.priority.agent);
  return agent ? { ...agent, source: "agent", ticketKey: null } : null;
}

export function threadJiraRank(thread: Pick<EnvironmentThreadShell, "ticketLinks">): string | null {
  let best: string | null = null;
  for (const link of thread.ticketLinks) {
    const rank = isReadableThreadTicketLink(link) ? (link.snapshot?.rank ?? null) : null;
    // LexoRank compares by code unit; localeCompare would reorder case and punctuation.
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

export function sortInboxThreadsByPriority<T extends InboxThreadInput & PriorityThreadInput>(
  threads: readonly T[],
  scaleFor: (thread: T) => ReadonlyArray<PriorityRef>,
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const returnIndex = new Map(
    sortInboxThreadsByReturn(threads, observedReturnAt).map((thread, index) => [thread, index]),
  );
  const keys = new Map(
    threads.map((thread) => [
      thread,
      {
        position: effectiveThreadPriority(thread, scaleFor(thread))?.position ?? Infinity,
        rank: threadJiraRank(thread),
      },
    ]),
  );
  return [...threads].sort((left, right) => {
    const a = keys.get(left)!;
    const b = keys.get(right)!;
    if (a.position !== b.position) return a.position - b.position;
    if (a.position !== Infinity && a.rank !== b.rank) {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank < b.rank ? -1 : 1;
    }
    return returnIndex.get(left)! - returnIndex.get(right)!;
  });
}

export function ticketPriorityScaleOf(
  config: { readonly ticketPriorityScale?: ReadonlyArray<PriorityRef> } | null | undefined,
): ReadonlyArray<PriorityRef> {
  const scale = config?.ticketPriorityScale;
  return scale && scale.length > 0 ? scale : DEFAULT_TICKET_PRIORITY_SCALE;
}
