import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  branchTicketKeys,
  DEFAULT_TICKET_PRIORITY_SCALE,
  EMPTY_THREAD_PRIORITY,
  findPriorityInScale,
  isReadableThreadTicketLink,
  jiraBrowseUrl,
  parseTicketReference,
  StoredThreadPriority,
  StoredThreadTicketLinks,
  threadTicketSnapshotsEqual,
  visibleThreadTicketLinks,
  type ThreadTicketLink,
  type ThreadTicketSnapshot,
} from "./threadTicket.ts";

const snapshot: ThreadTicketSnapshot = {
  title: "Fix login",
  statusName: "In Progress",
  statusCategory: "indeterminate",
  priority: { id: "2", name: "High" },
  rank: "0|a",
  syncedAt: "2026-11-13T10:00:00.000Z",
};

const link = (overrides: Partial<ThreadTicketLink> = {}): ThreadTicketLink => ({
  tracker: "jira",
  key: "PROJ-1",
  url: null,
  source: "manual",
  linkedAt: "2026-11-13T09:00:00.000Z",
  snapshot: null,
  syncError: null,
  ...overrides,
});

const [highest, high, medium, low] = DEFAULT_TICKET_PRIORITY_SCALE;

const decodeUnknownLinks = Schema.decodeUnknownEffect(StoredThreadTicketLinks);
const decodeLinks = Schema.decodeEffect(StoredThreadTicketLinks);
const decodeUnknownPriority = Schema.decodeUnknownEffect(StoredThreadPriority);

it("parseTicketReference reads keys and Jira URLs", () => {
  const browse = "https://acme.atlassian.net/browse/PROJ-12";
  expect(parseTicketReference("  proj-12 ")).toEqual({ key: "PROJ-12", url: null });
  expect(parseTicketReference("https://acme.atlassian.net/browse/proj-12")).toEqual({
    key: "PROJ-12",
    url: browse,
  });
  expect(parseTicketReference(`${browse}?focusedCommentId=1`)).toEqual({
    key: "PROJ-12",
    url: browse,
  });
  expect(
    parseTicketReference(
      "https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7",
    ),
  ).toEqual({ key: "PROJ-7", url: "https://acme.atlassian.net/browse/PROJ-7" });
  for (const input of [
    "ftp://acme/browse/PROJ-1",
    "PROJ-",
    "12-34",
    "",
    "https://acme.atlassian.net/",
  ]) {
    expect(parseTicketReference(input)).toBeNull();
  }
});

it("branchTicketKeys finds distinct upper-cased keys", () => {
  expect(branchTicketKeys("feat/proj-12-and-ABC_2-7")).toEqual(["PROJ-12", "ABC_2-7"]);
  expect(branchTicketKeys("PROJ-12/PROJ-12-again")).toEqual(["PROJ-12"]);
  expect(branchTicketKeys("v1-2")).toEqual(["V1-2"]);
  expect(branchTicketKeys("xPROJ-12")).toEqual(["XPROJ-12"]);
  expect(branchTicketKeys("PROJ-123abc")).toEqual(["PROJ-123"]);
  expect(branchTicketKeys(null)).toEqual([]);
});

it("jiraBrowseUrl drops trailing slashes", () => {
  expect(jiraBrowseUrl("https://acme.atlassian.net//", "PROJ-1")).toBe(
    "https://acme.atlassian.net/browse/PROJ-1",
  );
});

it("threadTicketSnapshotsEqual ignores syncedAt only", () => {
  expect(
    threadTicketSnapshotsEqual(snapshot, { ...snapshot, syncedAt: "2026-11-13T11:00:00.000Z" }),
  ).toBe(true);
  expect(
    threadTicketSnapshotsEqual(snapshot, { ...snapshot, priority: { id: "2", name: "Highest" } }),
  ).toBe(false);
  expect(threadTicketSnapshotsEqual(snapshot, { ...snapshot, rank: "0|b" })).toBe(false);
  expect(threadTicketSnapshotsEqual(snapshot, { ...snapshot, priority: null })).toBe(false);
  expect(threadTicketSnapshotsEqual({ ...snapshot, priority: null }, snapshot)).toBe(false);
  expect(
    threadTicketSnapshotsEqual({ ...snapshot, priority: null }, { ...snapshot, priority: null }),
  ).toBe(true);
});

it("findPriorityInScale matches id, then name", () => {
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, "default:low")).toEqual({
    ref: low,
    position: 3,
  });
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, "high")).toEqual({
    ref: high,
    position: 1,
  });
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, { name: "HIGH" })).toEqual({
    ref: high,
    position: 1,
  });
  expect(
    findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, { id: "nope", name: "Medium" }),
  ).toEqual({ ref: medium, position: 2 });
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, { id: "default:highest" })).toEqual({
    ref: highest,
    position: 0,
  });
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, "Urgent")).toBeNull();
  expect(findPriorityInScale(DEFAULT_TICKET_PRIORITY_SCALE, {})).toBeNull();
});

it("visibleThreadTicketLinks and isReadableThreadTicketLink hide dismissed and unsynced links", () => {
  const manual = link({ key: "PROJ-1", snapshot });
  const agent = link({ key: "PROJ-2", source: "agent" });
  const branch = link({ key: "PROJ-3", source: "branch", snapshot, syncError: "forbidden" });
  const dismissed = link({ key: "PROJ-4", source: "branch-dismissed", snapshot });

  expect(visibleThreadTicketLinks([manual, agent, branch, dismissed])).toEqual([
    manual,
    agent,
    branch,
  ]);
  expect(isReadableThreadTicketLink(manual)).toBe(true);
  expect(isReadableThreadTicketLink(agent)).toBe(false);
  expect(isReadableThreadTicketLink(branch)).toBe(false);
  expect(isReadableThreadTicketLink(dismissed)).toBe(false);
});

it.effect("stored forms read an unreadable value as empty", () =>
  Effect.gen(function* () {
    const links = yield* decodeUnknownLinks([{ ...link(), source: "jira-epic" }]);
    expect(links).toEqual([]);
    const priority = yield* decodeUnknownPriority({ user: 5 });
    expect(priority).toEqual(EMPTY_THREAD_PRIORITY);
    const kept = yield* decodeLinks([link()]);
    expect(kept).toEqual([link()]);
  }),
);
