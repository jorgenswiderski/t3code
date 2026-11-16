import { describe, expect, it } from "@effect/vitest";
import type { ThreadPriority, ThreadTicketLink } from "@t3tools/contracts";

import { makeTicketLink, makeTicketSnapshot } from "./testkit/ticketFixtures.ts";
import {
  linkThreadTicketLinks,
  setThreadPriorityValue,
  syncThreadTicketLinks,
  unlinkThreadTicketLinks,
} from "./threadTicketReducer.ts";

const T = "2026-11-13T12:00:00.000Z";
const other = makeTicketLink({ key: "OTHER-9", url: null });

describe("linkThreadTicketLinks", () => {
  it("appends a new key", () => {
    expect(
      linkThreadTicketLinks([other], { key: "PROJ-1", url: null, source: "manual", linkedAt: T }),
    ).toEqual([
      other,
      {
        tracker: "jira",
        key: "PROJ-1",
        url: null,
        source: "manual",
        linkedAt: T,
        snapshot: null,
        syncError: null,
      },
    ]);
    const url = "https://acme.atlassian.net/browse/PROJ-1";
    expect(
      linkThreadTicketLinks([], { key: "PROJ-1", url, source: "branch", linkedAt: T }),
    ).toEqual([makeTicketLink({ url, source: "branch", linkedAt: T })]);
  });

  it.each([
    ["manual", "agent"],
    ["branch", "manual"],
    ["branch-dismissed", "branch"],
  ] as const)("keeps an existing %s link for a %s command", (existing, source) => {
    const links = [makeTicketLink({ source: existing }), other];
    expect(linkThreadTicketLinks(links, { key: "PROJ-1", url: null, source, linkedAt: T })).toBe(
      links,
    );
  });

  it("undismisses on an explicit link, keeping linkedAt and snapshot", () => {
    const snapshot = makeTicketSnapshot();
    const dismissed = makeTicketLink({ source: "branch-dismissed", url: null, snapshot });
    expect(
      linkThreadTicketLinks([dismissed, other], {
        key: "PROJ-1",
        url: "https://x/browse/PROJ-1",
        source: "manual",
        linkedAt: T,
      }),
    ).toEqual([{ ...dismissed, source: "manual", url: "https://x/browse/PROJ-1" }, other]);

    const withUrl = makeTicketLink({ source: "branch-dismissed", url: "https://u/browse/PROJ-1" });
    expect(
      linkThreadTicketLinks([withUrl], { key: "PROJ-1", url: null, source: "agent", linkedAt: T }),
    ).toEqual([{ ...withUrl, source: "agent" }]);
  });
});

describe("unlinkThreadTicketLinks", () => {
  it.each([
    ["absent", [other], null],
    ["already dismissed", [makeTicketLink({ source: "branch-dismissed" }), other], "feat/PROJ-1"],
  ] as const)("is a no-op when the key is %s", (_label, links, branch) => {
    expect(unlinkThreadTicketLinks(links, { key: "PROJ-1", branch })).toBe(links);
  });

  it.each([
    ["manual", "main"],
    ["agent", null],
  ] as const)("removes a %s link not in the branch (%s)", (source, branch) => {
    const links = [other, makeTicketLink({ source }), makeTicketLink({ key: "ZED-2" })];
    expect(unlinkThreadTicketLinks(links, { key: "PROJ-1", branch })).toEqual([
      other,
      makeTicketLink({ key: "ZED-2" }),
    ]);
  });

  it.each([
    [
      "a branch link",
      makeTicketLink({ source: "branch", snapshot: makeTicketSnapshot(), syncError: "forbidden" }),
      "feat/PROJ-1",
    ],
    [
      "a manual link whose key is in the branch name",
      makeTicketLink({ source: "manual" }),
      "feat/proj-1-login",
    ],
  ] as const)("tombstones %s", (_label, link, branch) => {
    expect(unlinkThreadTicketLinks([other, link], { key: "PROJ-1", branch })).toEqual([
      other,
      { ...link, source: "branch-dismissed", snapshot: null, syncError: null },
    ]);
  });
});

describe("syncThreadTicketLinks", () => {
  const S = "2026-11-13T10:00:00.000Z";
  const later = "2026-11-13T10:05:00.000Z";
  const synced = makeTicketLink({ snapshot: makeTicketSnapshot({ syncedAt: S }) });
  const snapshotResult = (overrides: Parameters<typeof makeTicketSnapshot>[0] = {}) =>
    ({ type: "snapshot", snapshot: makeTicketSnapshot(overrides) }) as const;
  const unreachable = (syncError: "not_found" | "forbidden") =>
    ({ type: "unreachable", syncError }) as const;

  it.each<
    [
      string,
      ReadonlyArray<ThreadTicketLink>,
      string,
      Parameters<typeof syncThreadTicketLinks>[1]["result"],
    ]
  >([
    ["no link", [other], later, snapshotResult()],
    ["a dismissed link", [makeTicketLink({ source: "branch-dismissed" })], later, snapshotResult()],
    ["a stale read", [synced], "2026-11-13T09:59:00.000Z", snapshotResult({ title: "Other" })],
    ["equal data", [synced], later, snapshotResult({ syncedAt: later })],
    [
      "the same error",
      [makeTicketLink({ syncError: "forbidden" })],
      later,
      unreachable("forbidden"),
    ],
  ])("is a no-op for %s", (_label, links, observedAt, result) => {
    expect(syncThreadTicketLinks(links, { key: "PROJ-1", observedAt, result })).toBe(links);
  });

  it("stores the first snapshot", () => {
    const result = snapshotResult();
    expect(
      syncThreadTicketLinks([makeTicketLink()], {
        key: "PROJ-1",
        observedAt: "2026-11-13T09:00:00.000Z",
        result,
      }),
    ).toEqual([makeTicketLink({ snapshot: result.snapshot })]);
  });

  it("replaces a changed snapshot", () => {
    const result = snapshotResult({ priority: { id: "3", name: "Medium" }, syncedAt: later });
    expect(syncThreadTicketLinks([synced], { key: "PROJ-1", observedAt: later, result })).toEqual([
      { ...synced, snapshot: result.snapshot },
    ]);
  });

  it("clears a sync error with equal data", () => {
    const failing = { ...synced, syncError: "not_found" as const };
    const result = snapshotResult({ syncedAt: later });
    expect(syncThreadTicketLinks([failing], { key: "PROJ-1", observedAt: later, result })).toEqual([
      { ...synced, snapshot: result.snapshot, syncError: null },
    ]);
  });

  it("records an unreachable ticket and keeps its snapshot", () => {
    expect(
      syncThreadTicketLinks([synced], {
        key: "PROJ-1",
        observedAt: later,
        result: unreachable("forbidden"),
      }),
    ).toEqual([{ ...synced, syncError: "forbidden" }]);
    const forbidden = makeTicketLink({ syncError: "forbidden" });
    expect(
      syncThreadTicketLinks([forbidden], {
        key: "PROJ-1",
        observedAt: later,
        result: unreachable("not_found"),
      }),
    ).toEqual([{ ...forbidden, syncError: "not_found" }]);
  });
});

describe("setThreadPriorityValue", () => {
  const High = { id: "2", name: "High" };
  const Medium = { id: "3", name: "Medium" };
  const Low = { id: "4", name: "Low" };
  const empty: ThreadPriority = { user: null, agent: null };

  it.each<[string, ThreadPriority, "user" | "agent", typeof High | null]>([
    ["the same user value", { user: High, agent: null }, "user", { ...High }],
    ["clearing an empty agent value", empty, "agent", null],
  ])("is a no-op for %s", (_label, stored, source, priority) => {
    expect(setThreadPriorityValue(stored, { source, priority })).toBe(stored);
  });

  it.each<[string, ThreadPriority, "user" | "agent", typeof High | null, ThreadPriority]>([
    ["sets user", empty, "user", High, { user: High, agent: null }],
    ["clears user", { user: High, agent: null }, "user", null, empty],
    [
      "replaces on a name change",
      { user: null, agent: Low },
      "agent",
      { id: Low.id, name: "low" },
      { user: null, agent: { id: Low.id, name: "low" } },
    ],
    [
      "keeps the other source",
      { user: High, agent: Low },
      "agent",
      Medium,
      { user: High, agent: Medium },
    ],
  ])("%s", (_label, stored, source, priority, expected) => {
    expect(setThreadPriorityValue(stored, { source, priority })).toEqual(expected);
  });
});
