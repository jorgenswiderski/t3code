import {
  DEFAULT_TICKET_PRIORITY_SCALE as SCALE,
  EMPTY_THREAD_PRIORITY,
  jiraBrowseUrl,
  type PriorityRef,
  type ThreadPriority,
  type ThreadTicketKey,
  type ThreadTicketLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  jiraSyncNotice,
  parseTicketMenuAction,
  priorityGlyphLevel,
  threadHasTicketData,
  threadPriorityIndicator,
  threadPriorityMenu,
  ticketChipModel,
  ticketUiAvailability,
  visibleTicketChips,
} from "./threadTicketPresentation.ts";

const ref = (name: string): PriorityRef => ({ id: `default:${name.toLowerCase()}`, name });
const SEVEN: ReadonlyArray<PriorityRef> = ["A", "B", "C", "D", "E", "F", "G"].map(
  (name, index) => ({
    id: String(index),
    name,
  }),
);

function link(
  key: string,
  options: {
    readonly priority?: PriorityRef | null;
    readonly statusCategory?: "new" | "indeterminate" | "done";
    readonly statusName?: string;
    readonly source?: ThreadTicketLink["source"];
    readonly syncError?: ThreadTicketLink["syncError"];
    readonly snapshot?: null;
    readonly url?: string | null;
  } = {},
): ThreadTicketLink {
  return {
    tracker: "jira",
    key: key as ThreadTicketKey,
    url: options.url ?? null,
    source: options.source ?? "manual",
    linkedAt: "2026-06-01T00:00:00.000Z",
    snapshot:
      options.snapshot === null
        ? null
        : {
            title: `${key} title`,
            statusName: options.statusName ?? "To Do",
            statusCategory: options.statusCategory ?? "new",
            priority: options.priority ?? null,
            rank: null,
            syncedAt: "2026-06-01T00:00:00.000Z",
          },
    syncError: options.syncError ?? null,
  };
}

const thread = (
  ticketLinks: ReadonlyArray<ThreadTicketLink> = [],
  priority: Partial<ThreadPriority> = {},
) => ({ ticketLinks, priority: { ...EMPTY_THREAD_PRIORITY, ...priority } });

describe("priorityGlyphLevel", () => {
  it.each([
    [0, 5, 0],
    [1, 5, 1],
    [2, 5, 2],
    [3, 5, 3],
    [4, 5, 4],
    [0, 3, 0],
    [1, 3, 2],
    [2, 3, 4],
    [1, 7, 1],
    [3, 7, 2],
    [5, 7, 3],
    [0, 1, 2],
    [0, 0, 2],
  ])("position %i of %i is level %i", (position, length, level) => {
    expect(priorityGlyphLevel(position, length)).toBe(level);
  });
});

describe("threadPriorityIndicator", () => {
  const readable = (key: string, priority: PriorityRef, extra = {}) =>
    link(key, { priority, ...extra });

  it("describes where the priority comes from, or that it matches nothing", () => {
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof thread>, object | null]> = [
      [
        "user",
        thread([], { user: ref("High") }),
        { kind: "resolved", source: "user", position: 1, tooltip: "High · You" },
      ],
      [
        "jira",
        thread([readable("PROJ-1", ref("Medium"))]),
        {
          kind: "resolved",
          source: "jira",
          ticketKey: "PROJ-1",
          tooltip: "Medium · Jira PROJ-1",
          accessibilityLabel: "Priority Medium, from Jira PROJ-1",
        },
      ],
      [
        "agent",
        thread([], { agent: ref("Low") }),
        {
          kind: "resolved",
          source: "agent",
          tooltip: "Low · Agent guess",
          accessibilityLabel: "Priority Low, agent's guess",
        },
      ],
      [
        "done ticket still counts",
        thread([readable("PROJ-1", ref("Highest"), { statusCategory: "done" })]),
        { kind: "resolved", source: "jira", position: 0 },
      ],
      [
        "user wins over ticket",
        thread([readable("PROJ-1", ref("Highest"))], { user: ref("High") }),
        { kind: "resolved", source: "user" },
      ],
      [
        "unreachable link contributes nothing",
        thread([readable("PROJ-1", ref("Highest"), { syncError: "not_found" })], {
          agent: ref("Low"),
        }),
        { kind: "resolved", source: "agent" },
      ],
      [
        "unresolvable user",
        thread([], { user: { id: "9", name: "Expedite" } }),
        {
          kind: "unresolved",
          source: "user",
          tooltip: "Expedite · You · not on this scale",
          accessibilityLabel: "Priority Expedite, set by you, not on this scale",
        },
      ],
      [
        "unresolvable agent",
        thread([], { agent: { id: "9", name: "Expedite" } }),
        {
          kind: "unresolved",
          source: "agent",
          tooltip: "Expedite · Agent guess · not on this scale",
        },
      ],
      [
        "unresolvable user falls through to a readable ticket",
        thread([readable("PROJ-1", ref("Medium"))], { user: { id: "9", name: "Expedite" } }),
        { kind: "resolved", source: "jira" },
      ],
      ["nothing", thread(), null],
      [
        "user by name only",
        thread([], { user: { id: "stale", name: "high" } }),
        { kind: "resolved", source: "user", position: 1, name: "High" },
      ],
      [
        "dismissed branch link",
        thread([readable("PROJ-1", ref("High"), { source: "branch-dismissed" })]),
        null,
      ],
    ];
    for (const [label, input, expected] of cases) {
      const actual = threadPriorityIndicator(input, SCALE);
      if (expected === null) expect(actual, label).toBeNull();
      else expect(actual, label).toMatchObject(expected);
    }
  });

  it("maps position to a glyph level on any scale length", () => {
    expect(threadPriorityIndicator(thread([], { user: SEVEN[3]! }), SEVEN)).toMatchObject({
      position: 3,
      level: 2,
    });
  });
});

describe("threadHasTicketData", () => {
  it("ignores dismissed branch links and counts everything else", () => {
    const dismissed = link("PROJ-1", { source: "branch-dismissed", snapshot: null });
    const cases: ReadonlyArray<readonly [ReturnType<typeof thread>, boolean]> = [
      [thread(), false],
      [thread([dismissed]), false],
      [thread([dismissed, link("PROJ-2")]), true],
      [thread([dismissed], { user: ref("High") }), true],
      [thread([], { agent: ref("Low") }), true],
    ];
    for (const [input, expected] of cases) expect(threadHasTicketData(input)).toBe(expected);
  });
});

describe("threadPriorityMenu", () => {
  it("checks the entry the user value resolves to and enables Clear for any stored value", () => {
    const cases: ReadonlyArray<readonly [ReturnType<typeof thread>, string | null, boolean]> = [
      [thread(), null, false],
      [thread([], { user: ref("High") }), "High", true],
      [thread([], { user: { id: "stale", name: "high" } }), "High", true],
      [thread([], { user: { id: "9", name: "Expedite" } }), null, true],
      [thread([], { agent: ref("Low") }), null, true],
    ];
    for (const [input, checked, canClear] of cases) {
      const menu = threadPriorityMenu(input, SCALE);
      expect(menu.entries.map((entry) => entry.ref.name)).toEqual(SCALE.map((entry) => entry.name));
      expect(menu.entries.filter((entry) => entry.checked).map((entry) => entry.ref.name)).toEqual(
        checked === null ? [] : [checked],
      );
      expect(menu.canClear).toBe(canClear);
    }
  });

  it("follows the scale order and labels the current priority", () => {
    const menu = threadPriorityMenu(thread([], { agent: SEVEN[0]! }), SEVEN);
    expect(menu.entries.map((entry) => entry.ref.id)).toEqual(SEVEN.map((entry) => entry.id));
    expect(menu.currentLabel).toBe("A · Agent guess");
    expect(threadPriorityMenu(thread(), SCALE).currentLabel).toBeNull();
  });
});

describe("ticketChipModel", () => {
  const connected = { jiraConnected: true, siteUrl: null };

  it("reports status, reachability and pending states", () => {
    expect(
      ticketChipModel(link("A-1", { statusCategory: "done", statusName: "Done" }), connected),
    ).toMatchObject({
      status: { kind: "synced", name: "Done", tone: "success" },
      unreachable: false,
    });
    expect(
      ticketChipModel(
        link("A-1", { statusCategory: "indeterminate", statusName: "In Progress" }),
        connected,
      ).status,
    ).toMatchObject({ tone: "info" });
    expect(ticketChipModel(link("A-1"), connected).status).toMatchObject({ tone: "neutral" });
    expect(ticketChipModel(link("A-1", { syncError: "not_found" }), connected)).toMatchObject({
      title: "A-1 title",
      unreachable: true,
      status: { kind: "unreachable", reason: "not_found", label: "Unreachable" },
    });
    expect(
      ticketChipModel(link("A-1", { snapshot: null, syncError: "forbidden" }), connected),
    ).toMatchObject({
      title: null,
      status: { kind: "unreachable", reason: "forbidden", reasonText: "No access" },
    });
    expect(ticketChipModel(link("A-1", { snapshot: null }), connected).status).toEqual({
      kind: "pending",
      label: "Waiting for Jira",
    });
    expect(
      ticketChipModel(link("A-1", { snapshot: null }), { jiraConnected: false, siteUrl: null })
        .status,
    ).toEqual({ kind: "pending", label: "Jira not connected" });
  });

  it("opens the link's own url, else the saved site's browse url, else nothing", () => {
    const key = "A-1" as ThreadTicketKey;
    const site = "https://acme.atlassian.net";
    expect(ticketChipModel(link("A-1"), { jiraConnected: true, siteUrl: site }).url).toBe(
      jiraBrowseUrl(site, key),
    );
    expect(ticketChipModel(link("A-1"), connected).url).toBeNull();
    expect(
      ticketChipModel(link("A-1", { url: "https://other.example/browse/A-1" }), {
        jiraConnected: true,
        siteUrl: site,
      }).url,
    ).toBe("https://other.example/browse/A-1");
  });

  it("never renders a tombstone and labels each source", () => {
    const chips = visibleTicketChips(
      [
        link("A-1", { source: "manual" }),
        link("B-2", { source: "branch-dismissed" }),
        link("C-3", { source: "agent" }),
        link("D-4", { source: "branch" }),
      ],
      connected,
    );
    expect(chips.map((chip) => [chip.key, chip.sourceLabel])).toEqual([
      ["A-1", "Linked by you"],
      ["C-3", "Linked by the agent"],
      ["D-4", "Found in the branch name"],
    ]);
  });
});

describe("ticketUiAvailability", () => {
  const withTickets = (jiraStatus?: "disconnected" | "connected" | "error") => ({
    environment: { capabilities: { threadTickets: true } },
    ...(jiraStatus ? { jiraStatus: { state: jiraStatus } } : {}),
  });

  it.each([
    [undefined, false, false, false],
    [null, false, false, false],
    [{ environment: { capabilities: {} } }, false, false, false],
    [withTickets(), true, false, false],
    [withTickets("disconnected"), true, false, false],
    [withTickets("connected"), true, true, true],
    [withTickets("error"), true, true, true],
  ])("config %#", (config, priority, linkTicket, jiraConnected) => {
    expect(ticketUiAvailability(config)).toEqual({ priority, linkTicket, jiraConnected });
  });
});

describe("jiraSyncNotice", () => {
  it("is set only for an error state", () => {
    const error = {
      kind: "unavailable",
      message: "Down",
      since: "2026-06-01T00:00:00.000Z",
    } as const;
    expect(jiraSyncNotice(undefined)).toBeNull();
    expect(jiraSyncNotice({ state: "connected", error: null })).toBeNull();
    expect(jiraSyncNotice({ state: "disconnected", error: null })).toBeNull();
    expect(jiraSyncNotice({ state: "error", error })).toEqual({
      message: "Down",
      since: error.since,
    });
  });
});

describe("parseTicketMenuAction", () => {
  it.each([
    ["priority:set:default:high", { type: "set-priority", priorityId: "default:high" }],
    ["priority:set:10000", { type: "set-priority", priorityId: "10000" }],
    ["priority:clear", { type: "clear-priority" }],
    ["link-ticket", { type: "link-ticket" }],
    ["unlink-ticket:PROJ-123", { type: "unlink-ticket", key: "PROJ-123" }],
    ["open-tickets", { type: "open-tickets" }],
    ["priority", null],
    ["pin", null],
    ["snooze:custom", null],
    ["unlink-ticket:", null],
    ["priority:set:", null],
  ])("%s", (id, expected) => {
    expect(parseTicketMenuAction(id)).toEqual(expected);
  });
});
