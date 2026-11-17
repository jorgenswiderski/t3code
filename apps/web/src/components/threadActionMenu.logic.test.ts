import { DEFAULT_TICKET_PRIORITY_SCALE, EMPTY_THREAD_PRIORITY } from "@t3tools/contracts";
import { threadPriorityMenu } from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
  type ThreadTicketMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  describe("ticket items", () => {
    const scale = DEFAULT_TICKET_PRIORITY_SCALE;
    const high = scale[1]!;
    const noUser = threadPriorityMenu({ priority: EMPTY_THREAD_PRIORITY }, scale);
    const userHigh = threadPriorityMenu({ priority: { user: high, agent: null } }, scale);
    const links = [
      { key: "A-1", label: "A-1 · First" },
      { key: "B-2", label: "B-2" },
    ];
    const build = (tickets: ThreadTicketMenuState | undefined, canOperate = true) =>
      buildThreadActionMenuItems({ ...baseState, canOperate, ...(tickets ? { tickets } : {}) });
    const ids = (items: ReturnType<typeof build>) =>
      items.flatMap((item) => [item.id, ...(item.children?.map((child) => child.id) ?? [])]);

    it("adds Priority, Link and Unlink only when the state allows them", () => {
      const ticketIds = (tickets: ThreadTicketMenuState | undefined) =>
        ids(build(tickets)).filter(
          (id) =>
            id === "priority" || id === "link-ticket" || /^(priority:|unlink-ticket:)/.test(id),
        );
      expect(ticketIds(undefined)).toEqual([]);
      expect(ticketIds({ priority: noUser, canLink: false, links: [] })).toEqual([
        "priority",
        ...scale.map((entry) => `priority:set:${entry.id}`),
        "priority:clear",
      ]);
      expect(ticketIds({ priority: null, canLink: true, links })).toEqual([
        "link-ticket",
        "unlink-ticket:A-1",
        "unlink-ticket:B-2",
      ]);
      // An existing link stays removable after Jira disconnects.
      expect(ticketIds({ priority: null, canLink: false, links: links.slice(0, 1) })).toEqual([
        "unlink-ticket:A-1",
      ]);
    });

    it("checks the user's priority and disables Clear only without one", () => {
      const children = (priority: typeof noUser) =>
        build({ priority, canLink: false, links: [] }).find((item) => item.id === "priority")
          ?.children ?? [];
      expect(
        children(userHigh)
          .filter((child) => child.checked)
          .map((child) => child.id),
      ).toEqual(["priority:set:default:high"]);
      expect(children(userHigh).find((child) => child.id === "priority:clear")?.disabled).toBe(
        false,
      );
      expect(children(noUser).find((child) => child.id === "priority:clear")?.disabled).toBe(true);
    });

    it("disables every ticket item without permission and sits between snooze and rename", () => {
      const tickets = { priority: userHigh, canLink: true, links };
      const denied = build(tickets, false);
      const ticketItems = denied.filter(
        (item) =>
          item.id === "priority" || item.id === "link-ticket" || item.id.startsWith("unlink"),
      );
      expect(ticketItems).toHaveLength(4);
      expect(ticketItems.every((item) => item.disabled)).toBe(true);
      expect(ticketItems[0]?.children?.every((child) => child.disabled)).toBe(true);
      const order = build(tickets).map((item) => item.id);
      expect(order.indexOf("priority")).toBeGreaterThan(order.indexOf("snooze"));
      expect(order.indexOf("unlink-ticket:B-2")).toBe(order.indexOf("rename") - 1);
    });
  });
});
