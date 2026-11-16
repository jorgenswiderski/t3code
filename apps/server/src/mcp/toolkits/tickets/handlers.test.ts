import {
  EnvironmentId,
  type PriorityRef,
  ProviderInstanceId,
  ThreadId,
  type ThreadTicketCommandSource,
  type ThreadTicketKey,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { JiraUnavailableError } from "../../../jira/JiraService.ts";
import {
  makeTestJiraService,
  type JiraServiceTestState,
} from "../../../jira/testing/JiraServiceTest.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadTicketService from "../../../orchestration-v2/ThreadTicketService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as TicketsHandlers from "./handlers.ts";
import { TicketsToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
const SITE = "https://acme.atlassian.net";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
  ticketTracker: true,
};

type Recorded =
  | {
      readonly type: "link";
      readonly threadId: ThreadId;
      readonly key: ThreadTicketKey;
      readonly url: string | null;
      readonly source: ThreadTicketCommandSource;
    }
  | { readonly type: "unlink"; readonly threadId: ThreadId; readonly key: ThreadTicketKey }
  | {
      readonly type: "priority";
      readonly threadId: ThreadId;
      readonly source: "user" | "agent";
      readonly priority: PriorityRef | null;
    };

interface HarnessOptions {
  readonly jira?: Partial<JiraServiceTestState>;
  readonly linked?: boolean;
  readonly unlinked?: boolean;
  readonly changed?: boolean;
}

const makeHarness = Effect.fn("makeTicketsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const recorded = yield* Ref.make<ReadonlyArray<Recorded>>([]);
  const record = (entry: Recorded) => Ref.update(recorded, (all) => [...all, entry]);
  const jira = yield* makeTestJiraService({
    configured: true,
    siteUrl: SITE,
    projectKeys: new Set(["ACME"]),
    ...options.jira,
  });
  const layerDependencies = Layer.mergeAll(
    jira.layer,
    Layer.mock(ThreadTicketService.ThreadTicketService)({
      linkTicket: (input) =>
        record({ type: "link", ...input }).pipe(Effect.as({ linked: options.linked ?? true })),
      unlinkTicket: (input) =>
        record({ type: "unlink", ...input }).pipe(
          Effect.as({ unlinked: options.unlinked ?? true }),
        ),
      setThreadPriority: (input) =>
        record({ type: "priority", ...input }).pipe(
          Effect.as({ changed: options.changed ?? true }),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === THREAD_ID || id === OTHER_THREAD_ID
            ? McpToolAccessTestkit.liveThreadShell(id)
            : null,
        ),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* TicketsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(TicketsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof TicketsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof TicketsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return { recorded: Ref.get(recorded), call, jira: jira.controller };
});

const BLOCKER_SCALE: ReadonlyArray<PriorityRef> = [
  { id: "10001", name: "Blocker" },
  { id: "10002", name: "Critical" },
  { id: "10003", name: "Major" },
];

describe("ticket toolkit handlers", () => {
  describe("link_ticket", () => {
    it.effect("links a key on the caller's thread with the canonical browse URL", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call("link_ticket", { ticket: "acme-123" });
        expect(result).toEqual({
          key: "ACME-123",
          url: `${SITE}/browse/ACME-123`,
          alreadyLinked: false,
        });
        expect(yield* harness.recorded).toEqual([
          {
            type: "link",
            threadId: THREAD_ID,
            key: "ACME-123",
            url: `${SITE}/browse/ACME-123`,
            source: "agent",
          },
        ]);
      }),
    );

    it.effect("takes the key from a same-site URL and stores the canonical URL", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call("link_ticket", {
          ticket: `${SITE}/jira/software/projects/ACME/boards/1?selectedIssue=ACME-9`,
        });
        expect(result).toMatchObject({ key: "ACME-9", url: `${SITE}/browse/ACME-9` });
        expect(yield* harness.recorded).toMatchObject([
          { type: "link", key: "ACME-9", url: `${SITE}/browse/ACME-9` },
        ]);
      }),
    );

    it.effect("reports an existing link as alreadyLinked, not an error", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ linked: false });
        expect(yield* harness.call("link_ticket", { ticket: "ACME-123" })).toMatchObject({
          alreadyLinked: true,
        });
      }),
    );

    it.effect("refuses a URL from another Jira site", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call("link_ticket", { ticket: "https://other.atlassian.net/browse/ACME-1" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "TicketSiteMismatchError", siteUrl: SITE });
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("refuses a key whose project is not on the site", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness.call("link_ticket", { ticket: "ISO-8601" }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "TicketProjectUnknownError", project: "ISO" });
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("links anyway when the project list cannot be read", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          jira: { projectKeys: new JiraUnavailableError({ message: "down" }) },
        });
        yield* harness.call("link_ticket", { ticket: "ISO-8601" });
        expect(yield* harness.recorded).toMatchObject([{ type: "link", key: "ISO-8601" }]);
      }),
    );

    it.effect("refuses text that is not a ticket", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call("link_ticket", { ticket: "fix the bug" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TicketReferenceInvalidError");
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("links to an explicit thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.call("link_ticket", { ticket: "ACME-1", threadId: OTHER_THREAD_ID });
        expect(yield* harness.recorded).toMatchObject([{ threadId: OTHER_THREAD_ID }]);
      }),
    );

    it.effect("needs a thread when the caller has none", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call("link_ticket", { ticket: "ACME-1" }, { ...invocation, thread: undefined })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TicketThreadRequiredError");
      }),
    );

    it.effect("reports an unknown thread", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call("link_ticket", { ticket: "ACME-1", threadId: ThreadId.make("missing") })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "thread_not_found" });
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("fails while Jira is not configured, for every tool", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ jira: { configured: false } });
        const errors = [
          yield* harness.call("link_ticket", { ticket: "ACME-1" }).pipe(Effect.flip),
          yield* harness.call("unlink_ticket", { ticket: "ACME-1" }).pipe(Effect.flip),
          yield* harness.call("set_thread_priority", { priority: "High" }).pipe(Effect.flip),
        ];
        expect(errors.map((error) => error._tag)).toEqual([
          "TicketTrackerNotConfiguredError",
          "TicketTrackerNotConfiguredError",
          "TicketTrackerNotConfiguredError",
        ]);
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("fails when Jira is disconnected after the tool list was fetched", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.call("link_ticket", { ticket: "ACME-1" });
        yield* harness.jira.update({ configured: false });
        const error = yield* harness.call("link_ticket", { ticket: "ACME-2" }).pipe(Effect.flip);
        expect(error._tag).toBe("TicketTrackerNotConfiguredError");
        expect(yield* harness.recorded).toHaveLength(1);
      }),
    );
  });

  describe("unlink_ticket", () => {
    it.effect("unlinks by key and by URL", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.call("unlink_ticket", { ticket: "ACME-123" })).toEqual({
          key: "ACME-123",
          wasLinked: true,
        });
        yield* harness.call("unlink_ticket", { ticket: `${SITE}/browse/ACME-7` });
        expect(yield* harness.recorded).toMatchObject([
          { type: "unlink", threadId: THREAD_ID, key: "ACME-123" },
          { type: "unlink", threadId: THREAD_ID, key: "ACME-7" },
        ]);
      }),
    );

    it.effect("succeeds with wasLinked false, and skips the project check", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ unlinked: false });
        expect(yield* harness.call("unlink_ticket", { ticket: "ISO-8601" })).toEqual({
          key: "ISO-8601",
          wasLinked: false,
        });
      }),
    );

    it.effect("refuses a URL from another Jira site", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .call("unlink_ticket", { ticket: "https://other.atlassian.net/browse/ACME-1" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TicketSiteMismatchError");
      }),
    );
  });

  describe("set_thread_priority", () => {
    it.effect("sets the agent's provisional priority from a name, listing the scale", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call("set_thread_priority", { priority: "high" });
        expect(result).toEqual({
          source: "agent",
          priority: { id: "default:high", name: "High" },
          changed: true,
          scale: ["Highest", "High", "Medium", "Low", "Lowest"],
        });
        expect(yield* harness.recorded).toEqual([
          {
            type: "priority",
            threadId: THREAD_ID,
            source: "agent",
            priority: { id: "default:high", name: "High" },
          },
        ]);
      }),
    );

    it.effect("writes the user's priority only with userRequested", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call("set_thread_priority", {
          priority: "Low",
          userRequested: true,
        });
        expect(result).toMatchObject({ source: "user", priority: { name: "Low" } });
        yield* harness.call("set_thread_priority", { priority: "Low", userRequested: false });
        expect(yield* harness.recorded).toMatchObject([{ source: "user" }, { source: "agent" }]);
      }),
    );

    it.effect("resolves a name or id on a custom scale", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ jira: { priorityScale: BLOCKER_SCALE } });
        const byId = yield* harness.call("set_thread_priority", { priority: "10002" });
        expect(byId).toMatchObject({
          priority: { id: "10002", name: "Critical" },
          scale: ["Blocker", "Critical", "Major"],
        });
        const byName = yield* harness.call("set_thread_priority", { priority: "major" });
        expect(byName.priority).toEqual({ id: "10003", name: "Major" });
      }),
    );

    it.effect("fails with the valid names for a priority off the scale", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ jira: { priorityScale: BLOCKER_SCALE } });
        const error = yield* harness
          .call("set_thread_priority", { priority: "urgent" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TicketPriorityUnknownError",
          priority: "urgent",
          scale: ["Blocker", "Critical", "Major"],
        });
        expect(error.message).toContain("Blocker, Critical, Major");
        expect(yield* harness.recorded).toEqual([]);
      }),
    );

    it.effect("clears the agent value, or the user value with userRequested", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.call("set_thread_priority", { priority: null })).toMatchObject({
          source: "agent",
          priority: null,
        });
        expect(
          yield* harness.call("set_thread_priority", { priority: null, userRequested: true }),
        ).toMatchObject({ source: "user", priority: null });
        expect(yield* harness.recorded).toMatchObject([
          { source: "agent", priority: null },
          { source: "user", priority: null },
        ]);
      }),
    );

    it.effect("reports an unchanged value without an error", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ changed: false });
        expect(yield* harness.call("set_thread_priority", { priority: "High" })).toMatchObject({
          changed: false,
        });
      }),
    );
  });
});
