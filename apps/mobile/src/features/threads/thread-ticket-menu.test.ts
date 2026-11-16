import {
  parseTicketMenuAction,
  threadPriorityMenu,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { DEFAULT_TICKET_PRIORITY_SCALE, EMPTY_THREAD_PRIORITY } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPriorityMenuAction, buildTicketMenuItems } from "./thread-ticket-menu";

describe("buildPriorityMenuAction", () => {
  it("emits ids the shared parser reads back, with the user's value checked and clear gated", () => {
    const high = DEFAULT_TICKET_PRIORITY_SCALE[1]!;
    const action = buildPriorityMenuAction(
      threadPriorityMenu(
        { priority: { ...EMPTY_THREAD_PRIORITY, user: high } },
        DEFAULT_TICKET_PRIORITY_SCALE,
      ),
    );
    const subactions = action.subactions ?? [];
    expect(subactions.map((entry) => parseTicketMenuAction(entry.id ?? ""))).toEqual([
      ...DEFAULT_TICKET_PRIORITY_SCALE.map((ref) => ({
        type: "set-priority",
        priorityId: ref.id,
      })),
      { type: "clear-priority" },
    ]);
    expect(subactions.filter((entry) => entry.state === "on").map((entry) => entry.title)).toEqual([
      high.name,
    ]);
    expect(subactions.at(-1)?.attributes?.disabled).toBe(false);

    const unset = buildPriorityMenuAction(
      threadPriorityMenu({ priority: EMPTY_THREAD_PRIORITY }, DEFAULT_TICKET_PRIORITY_SCALE),
    );
    expect(unset.subactions?.at(-1)?.attributes?.disabled).toBe(true);
  });
});

describe("buildTicketMenuItems", () => {
  const priorityMenu = threadPriorityMenu(
    { priority: EMPTY_THREAD_PRIORITY },
    DEFAULT_TICKET_PRIORITY_SCALE,
  );
  const ids = (canOperate: boolean, uiLevel: "off" | "priority" | "link") =>
    buildTicketMenuItems({ uiLevel, canOperate, priorityMenu }).map((entry) => entry.id);

  it("offers Priority only to clients that can set it, and always the view-only tickets entry", () => {
    expect(ids(true, "link")).toEqual(["priority", "open-tickets"]);
    expect(ids(false, "link")).toEqual(["open-tickets"]);
    expect(ids(true, "off")).toEqual([]);
  });
});
