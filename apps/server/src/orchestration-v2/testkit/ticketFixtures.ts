import type { ThreadTicketLink, ThreadTicketSnapshot } from "@t3tools/contracts";

export function makeTicketSnapshot(
  overrides: Partial<ThreadTicketSnapshot> = {},
): ThreadTicketSnapshot {
  return {
    title: "Fix login",
    statusName: "In Progress",
    statusCategory: "indeterminate",
    priority: { id: "2", name: "High" },
    rank: "0|i0000:",
    syncedAt: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

export function makeTicketLink(overrides: Partial<ThreadTicketLink> = {}): ThreadTicketLink {
  return {
    tracker: "jira",
    key: "PROJ-1",
    url: "https://acme.atlassian.net/browse/PROJ-1",
    source: "manual",
    linkedAt: "2026-11-13T09:00:00.000Z",
    snapshot: null,
    syncError: null,
    ...overrides,
  };
}
