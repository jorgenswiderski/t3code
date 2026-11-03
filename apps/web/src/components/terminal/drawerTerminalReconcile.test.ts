import { describe, expect, it } from "vite-plus/test";

import { drawerTerminalIdsToReconcile } from "./drawerTerminalReconcile";

const sessions = (...ids: string[]) => ids.map((terminalId) => ({ target: { terminalId } }));

describe("drawerTerminalIdsToReconcile", () => {
  it.each([
    {
      name: "keeps a host tab when another client opens a thread-environment tab",
      sessionsByEnvironment: [sessions("t1", "t2"), sessions("h1")],
      panelTerminalIds: [],
      clientIds: ["t1", "h1"],
      expected: ["t1", "t2", "h1"],
    },
    {
      name: "skips while any environment's sessions are unknown",
      sessionsByEnvironment: [sessions("t1", "t2"), null],
      panelTerminalIds: [],
      clientIds: ["t1", "h1"],
      expected: null,
    },
    {
      name: "skips a strict subset, which is a lagging open",
      sessionsByEnvironment: [sessions("t1"), sessions()],
      panelTerminalIds: [],
      clientIds: ["t1", "h1"],
      expected: null,
    },
    {
      name: "skips when the union already matches the client",
      sessionsByEnvironment: [sessions("t1"), sessions("h1")],
      panelTerminalIds: [],
      clientIds: ["h1", "t1"],
      expected: null,
    },
    {
      name: "excludes panel terminals from the union",
      sessionsByEnvironment: [sessions("t1", "p1", "t2"), sessions("h1")],
      panelTerminalIds: ["p1"],
      clientIds: ["t1", "h1"],
      expected: ["t1", "t2", "h1"],
    },
    {
      name: "drops a client tab whose session vanished",
      sessionsByEnvironment: [sessions("t1", "t2"), sessions()],
      panelTerminalIds: [],
      clientIds: ["t1", "h1"],
      expected: ["t1", "t2"],
    },
    {
      name: "ignores other environments' sessions this client never placed",
      sessionsByEnvironment: [sessions("t1", "t2"), sessions("h1", "h9")],
      panelTerminalIds: [],
      clientIds: ["t1", "h1"],
      expected: ["t1", "t2", "h1"],
    },
  ])("$name", ({ sessionsByEnvironment, panelTerminalIds, clientIds, expected }) => {
    expect(
      drawerTerminalIdsToReconcile({
        sessionsByEnvironment,
        panelTerminalIds: new Set(panelTerminalIds),
        clientIds,
      }),
    ).toEqual(expected);
  });
});
