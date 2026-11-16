import {
  DEFAULT_TICKET_PRIORITY_SCALE as S,
  EMPTY_THREAD_PRIORITY,
  EnvironmentId,
  ThreadId,
  type PriorityRef,
  type ThreadPriority,
  type ThreadTicketKey,
  type ThreadTicketLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveThreadPriority,
  sortInboxThreadsByPriority,
  threadJiraRank,
  ticketPriorityScaleOf,
} from "./threadPriority.ts";

const ref = (name: string): PriorityRef => ({ id: `default:${name.toLowerCase()}`, name });

function link(
  key: string,
  options: {
    readonly priority?: PriorityRef | null;
    readonly rank?: string | null;
    readonly statusCategory?: "new" | "indeterminate" | "done";
    readonly source?: ThreadTicketLink["source"];
    readonly syncError?: ThreadTicketLink["syncError"];
    readonly snapshot?: null;
  } = {},
): ThreadTicketLink {
  return {
    tracker: "jira",
    key: key as ThreadTicketKey,
    url: null,
    source: options.source ?? "manual",
    linkedAt: "2026-06-01T00:00:00.000Z",
    snapshot:
      options.snapshot === null
        ? null
        : {
            title: key,
            statusName: "To Do",
            statusCategory: options.statusCategory ?? "new",
            priority: options.priority ?? null,
            rank: options.rank ?? null,
            syncedAt: "2026-06-01T00:00:00.000Z",
          },
    syncError: options.syncError ?? null,
  };
}

function shell(
  id: string,
  overrides: {
    readonly ticketLinks?: ReadonlyArray<ThreadTicketLink>;
    readonly priority?: Partial<ThreadPriority>;
    readonly createdAt?: string;
    readonly environmentId?: string;
  } = {},
) {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(overrides.environmentId ?? "environment-1"),
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    ticketLinks: overrides.ticketLinks ?? [],
    priority: { ...EMPTY_THREAD_PRIORITY, ...overrides.priority },
  };
}

const t = (n: number) => `2026-06-0${n}T00:00:00.000Z`;

describe("effectiveThreadPriority", () => {
  const Medium = ref("Medium");
  const High = ref("High");
  const Low = ref("Low");
  const Highest = ref("Highest");
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly thread: Parameters<typeof effectiveThreadPriority>[0];
    readonly scale?: ReadonlyArray<PriorityRef>;
    readonly expected: { source: string; position: number; ticketKey: string | null } | null;
  }> = [
    {
      name: "user outranks agent and Jira",
      thread: shell("a", {
        priority: { user: High, agent: Low },
        ticketLinks: [link("PROJ-1", { priority: Highest })],
      }),
      expected: { source: "user", position: 1, ticketKey: null },
    },
    {
      name: "best readable Jira link wins",
      thread: shell("a", {
        ticketLinks: [link("PROJ-1", { priority: Medium }), link("PROJ-2", { priority: High })],
      }),
      expected: { source: "jira", position: 1, ticketKey: "PROJ-2" },
    },
    {
      name: "first link wins a Jira tie",
      thread: shell("a", {
        ticketLinks: [link("PROJ-1", { priority: High }), link("PROJ-2", { priority: High })],
      }),
      expected: { source: "jira", position: 1, ticketKey: "PROJ-1" },
    },
    {
      name: "a Done ticket still counts",
      thread: shell("a", {
        ticketLinks: [link("PROJ-1", { priority: Low, statusCategory: "done" })],
      }),
      expected: { source: "jira", position: 3, ticketKey: "PROJ-1" },
    },
    {
      name: "an unreachable link is skipped for the agent value",
      thread: shell("a", {
        priority: { agent: Low },
        ticketLinks: [link("PROJ-1", { priority: Highest, syncError: "not_found" })],
      }),
      expected: { source: "agent", position: 3, ticketKey: null },
    },
    {
      name: "a dismissed branch link is ignored",
      thread: shell("a", {
        ticketLinks: [link("PROJ-1", { priority: Highest, source: "branch-dismissed" })],
      }),
      expected: null,
    },
    {
      name: "a link with no snapshot is ignored",
      thread: shell("a", { ticketLinks: [link("PROJ-1", { snapshot: null })] }),
      expected: null,
    },
    {
      name: "user value resolves by id",
      thread: shell("a", { priority: { user: { id: "10003", name: "Medium" } } }),
      scale: [
        { id: "10001", name: "Blocker" },
        { id: "10003", name: "Medium" },
      ],
      expected: { source: "user", position: 1, ticketKey: null },
    },
    {
      name: "user value falls back to a case-insensitive name",
      thread: shell("a", { priority: { user: { id: "default:high", name: "high" } } }),
      scale: [
        { id: "1", name: "Highest" },
        { id: "2", name: "High" },
      ],
      expected: { source: "user", position: 1, ticketKey: null },
    },
    {
      name: "an unresolvable user value falls through to Jira",
      thread: shell("a", {
        priority: { user: { id: "x", name: "Gone" } },
        ticketLinks: [link("PROJ-1", { priority: High })],
      }),
      expected: { source: "jira", position: 1, ticketKey: "PROJ-1" },
    },
    { name: "empty thread", thread: shell("a"), expected: null },
  ];
  it.each(cases)("$name", ({ thread, scale, expected }) => {
    const result = effectiveThreadPriority(thread, scale ?? S);
    expect(
      result && { source: result.source, position: result.position, ticketKey: result.ticketKey },
    ).toEqual(expected);
  });
});

describe("threadJiraRank", () => {
  it("returns the smallest readable rank, by code unit", () => {
    expect(
      threadJiraRank(
        shell("a", {
          ticketLinks: [
            link("PROJ-1", { rank: "0|i0000b:" }),
            link("PROJ-2", { rank: "0|i00003:" }),
          ],
        }),
      ),
    ).toBe("0|i00003:");
    expect(
      threadJiraRank(
        shell("a", {
          ticketLinks: [link("PROJ-1", { rank: "0|a" }), link("PROJ-2", { rank: "0|Z" })],
        }),
      ),
    ).toBe("0|Z");
  });
  it("ignores ranks on unreadable links and returns null without ranks", () => {
    expect(
      threadJiraRank(
        shell("a", {
          ticketLinks: [
            link("PROJ-1", { rank: "0|a" }),
            link("PROJ-2", { rank: "0|0", syncError: "not_found" }),
          ],
        }),
      ),
    ).toBe("0|a");
    expect(threadJiraRank(shell("a", { ticketLinks: [link("PROJ-1")] }))).toBeNull();
  });
});

describe("sortInboxThreadsByPriority", () => {
  const High = ref("High");
  const Low = ref("Low");
  const order = (threads: ReturnType<typeof shell>[], scaleFor = () => S) =>
    sortInboxThreadsByPriority(threads, scaleFor).map((thread) => thread.id);
  const ids = (...values: string[]) => values.map((value) => ThreadId.make(value));

  it("puts prioritized threads first, highest first", () => {
    expect(
      order([
        shell("a", { createdAt: t(3) }),
        shell("b", { priority: { user: Low }, createdAt: t(1) }),
        shell("c", { priority: { user: High }, createdAt: t(2) }),
      ]),
    ).toEqual(ids("c", "b", "a"));
  });

  it("orders a level by Jira rank, ranked before unranked", () => {
    expect(
      order([
        shell("a", {
          ticketLinks: [link("PROJ-1", { priority: High, rank: "0|b" })],
          createdAt: t(1),
        }),
        shell("b", {
          ticketLinks: [link("PROJ-2", { priority: High, rank: "0|a" })],
          createdAt: t(1),
        }),
        shell("c", { ticketLinks: [link("PROJ-3", { priority: High })], createdAt: t(3) }),
      ]),
    ).toEqual(ids("b", "a", "c"));
  });

  it("ignores rank without a priority", () => {
    expect(
      order([
        shell("a", { ticketLinks: [link("PROJ-1", { rank: "0|a" })], createdAt: t(1) }),
        shell("b", { createdAt: t(2) }),
      ]),
    ).toEqual(ids("b", "a"));
  });

  it("breaks ties by return order", () => {
    expect(
      order([
        shell("a", { priority: { user: High }, createdAt: t(1) }),
        shell("b", { priority: { user: High }, createdAt: t(2) }),
      ]),
    ).toEqual(ids("b", "a"));
  });

  it("compares across environments by position only", () => {
    const scale3 = [ref("Blocker"), ref("High"), ref("Minor")];
    const threads = [
      shell("a", { environmentId: "E1", priority: { user: ref("Minor") }, createdAt: t(1) }),
      shell("b", { environmentId: "E2", priority: { user: ref("Medium") }, createdAt: t(2) }),
    ];
    expect(
      sortInboxThreadsByPriority(threads, (thread) =>
        thread.environmentId === EnvironmentId.make("E1") ? scale3 : S,
      ).map((thread) => thread.id),
    ).toEqual(ids("b", "a"));
  });
});

describe("ticketPriorityScaleOf", () => {
  it("falls back to the default scale when absent or empty", () => {
    expect(ticketPriorityScaleOf(undefined)).toBe(S);
    expect(ticketPriorityScaleOf(null)).toBe(S);
    expect(ticketPriorityScaleOf({})).toBe(S);
    expect(ticketPriorityScaleOf({ ticketPriorityScale: [] })).toBe(S);
  });
  it("returns a non-empty scale as is", () => {
    const scale = [ref("Blocker")];
    expect(ticketPriorityScaleOf({ ticketPriorityScale: scale })).toBe(scale);
  });
});
