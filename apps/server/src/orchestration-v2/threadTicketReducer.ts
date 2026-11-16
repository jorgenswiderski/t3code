import {
  branchTicketKeys,
  threadTicketSnapshotsEqual,
  type OrchestrationV2ServerCommand,
  type PriorityRef,
  type ThreadPriority,
  type ThreadTicketCommandSource,
  type ThreadTicketKey,
  type ThreadTicketLink,
} from "@t3tools/contracts";

// Each reducer returns its input by reference when nothing changes; the Orchestrator emits no event then.

type Links = ReadonlyArray<ThreadTicketLink>;
type SyncResult = Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.ticket-link.sync" }
>["result"];

export function linkThreadTicketLinks(
  links: Links,
  input: {
    readonly key: ThreadTicketKey;
    readonly url: string | null;
    readonly source: ThreadTicketCommandSource;
    readonly linkedAt: string;
  },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined) {
    return [
      ...links,
      {
        tracker: "jira",
        key: input.key,
        url: input.url,
        source: input.source,
        linkedAt: input.linkedAt,
        snapshot: null,
        syncError: null,
      },
    ];
  }
  // Only an explicit manual/agent link undismisses; branch detection never does.
  if (existing.source !== "branch-dismissed" || input.source === "branch") return links;
  return links.map((link) =>
    link === existing ? { ...link, source: input.source, url: input.url ?? link.url } : link,
  );
}

export function unlinkThreadTicketLinks(
  links: Links,
  input: { readonly key: ThreadTicketKey; readonly branch: string | null },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined || existing.source === "branch-dismissed") return links;
  // Tombstone anything branch detection could re-add, so a removal sticks.
  if (existing.source === "branch" || branchTicketKeys(input.branch).includes(input.key)) {
    return links.map((link) =>
      link === existing
        ? { ...link, source: "branch-dismissed", snapshot: null, syncError: null }
        : link,
    );
  }
  return links.filter((link) => link !== existing);
}

export function syncThreadTicketLinks(
  links: Links,
  input: {
    readonly key: ThreadTicketKey;
    readonly observedAt: string;
    readonly result: SyncResult;
  },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined || existing.source === "branch-dismissed") return links;
  if (
    existing.snapshot !== null &&
    Date.parse(input.observedAt) < Date.parse(existing.snapshot.syncedAt)
  ) {
    return links;
  }
  const { result } = input;
  if (result.type === "snapshot") {
    if (
      existing.syncError === null &&
      existing.snapshot !== null &&
      threadTicketSnapshotsEqual(existing.snapshot, result.snapshot)
    ) {
      return links;
    }
    return links.map((link) =>
      link === existing ? { ...link, snapshot: result.snapshot, syncError: null } : link,
    );
  }
  if (existing.syncError === result.syncError) return links;
  return links.map((link) => (link === existing ? { ...link, syncError: result.syncError } : link));
}

export function setThreadPriorityValue(
  priority: ThreadPriority,
  input: { readonly source: "user" | "agent"; readonly priority: PriorityRef | null },
): ThreadPriority {
  const current = priority[input.source];
  const next = input.priority;
  const same =
    current === null || next === null
      ? current === next
      : current.id === next.id && current.name === next.name;
  return same ? priority : { ...priority, [input.source]: next };
}
