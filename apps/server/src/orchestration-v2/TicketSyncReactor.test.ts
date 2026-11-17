import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type JiraConnectionStatus,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type ThreadTicketKey,
  type ThreadTicketLink,
  type ThreadTicketSnapshot,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as JiraService from "../jira/JiraService.ts";
import { makeTestJiraService, type JiraServiceTestState } from "../jira/testing/JiraServiceTest.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeTicketLink, makeTicketSnapshot } from "./testkit/ticketFixtures.ts";
import * as ThreadTicketService from "./ThreadTicketService.ts";
import { syncThreadTicketLinks } from "./threadTicketReducer.ts";
import * as TicketSyncReactor from "./TicketSyncReactor.ts";

const NOW = "2026-11-13T12:00:00.000Z";
const SITE_URL = "https://acme.atlassian.net";
const providerInstanceId = ProviderInstanceId.make("codex");

type SyncCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.ticket-link.sync" }
>;

type TicketFields = Omit<ThreadTicketSnapshot, "syncedAt">;

const fieldsOf = (snapshot: ThreadTicketSnapshot): TicketFields => ({
  title: snapshot.title,
  statusName: snapshot.statusName,
  statusCategory: snapshot.statusCategory,
  priority: snapshot.priority,
  rank: snapshot.rank,
});

const found = (
  snapshot: ThreadTicketSnapshot,
  overrides: Partial<TicketFields> = {},
): JiraService.JiraTicketFetchResult => ({
  type: "found",
  snapshot: { ...fieldsOf(snapshot), ...overrides },
});

describe("ticketLinkSyncResult", () => {
  const S = makeTicketSnapshot({ syncedAt: "2026-11-13T10:00:00.000Z" });
  const observedAt = "2026-11-13T10:02:00.000Z";
  const snapshotResult = (fields: TicketFields) => ({
    type: "snapshot" as const,
    snapshot: { ...fields, syncedAt: observedAt },
  });

  it.each([
    {
      name: "first snapshot",
      link: makeTicketLink({ snapshot: null }),
      fetched: found(S),
      expected: snapshotResult(fieldsOf(S)),
    },
    {
      name: "same fields change nothing",
      link: makeTicketLink({ snapshot: S }),
      fetched: found(S),
      expected: null,
    },
    {
      name: "a changed priority id",
      link: makeTicketLink({ snapshot: S }),
      fetched: found(S, { priority: { id: "1", name: "Highest" } }),
      expected: snapshotResult({ ...fieldsOf(S), priority: { id: "1", name: "Highest" } }),
    },
    {
      name: "a changed rank",
      link: makeTicketLink({ snapshot: S }),
      fetched: found(S, { rank: "0|i0001:" }),
      expected: snapshotResult({ ...fieldsOf(S), rank: "0|i0001:" }),
    },
    {
      name: "Done tickets are still synced",
      link: makeTicketLink({ snapshot: S }),
      fetched: found(S, { statusName: "Done", statusCategory: "done" }),
      expected: snapshotResult({ ...fieldsOf(S), statusName: "Done", statusCategory: "done" }),
    },
    {
      name: "a found ticket clears the error",
      link: makeTicketLink({ snapshot: S, syncError: "not_found" }),
      fetched: found(S),
      expected: snapshotResult(fieldsOf(S)),
    },
    {
      name: "a newly unreachable ticket",
      link: makeTicketLink({ snapshot: S }),
      fetched: { type: "unreachable", syncError: "not_found" } as const,
      expected: { type: "unreachable", syncError: "not_found" },
    },
    {
      name: "the same error again changes nothing",
      link: makeTicketLink({ snapshot: S, syncError: "not_found" }),
      fetched: { type: "unreachable", syncError: "not_found" } as const,
      expected: null,
    },
    {
      name: "a different error",
      link: makeTicketLink({ snapshot: S, syncError: "not_found" }),
      fetched: { type: "unreachable", syncError: "forbidden" } as const,
      expected: { type: "unreachable", syncError: "forbidden" },
    },
    {
      name: "a dismissed link",
      link: makeTicketLink({ source: "branch-dismissed" }),
      fetched: found(S),
      expected: null,
    },
    {
      name: "an older read is stale",
      link: makeTicketLink({ snapshot: { ...S, syncedAt: "2026-11-13T10:05:00.000Z" } }),
      fetched: found(S, { title: "Renamed" }),
      expected: null,
    },
  ])("$name", ({ link, fetched, expected }) => {
    assert.deepStrictEqual(
      TicketSyncReactor.ticketLinkSyncResult(link, fetched, observedAt),
      expected,
    );
  });
});

describe("groupTicketLinksByKey", () => {
  const thread = (id: string, links: ReadonlyArray<ThreadTicketLink> | undefined) => ({
    id: ThreadId.make(id),
    ticketLinks: links,
  });
  const link = (key: string, overrides: Partial<ThreadTicketLink> = {}) =>
    makeTicketLink({ key, ...overrides });
  const summarize = (groups: ReturnType<typeof TicketSyncReactor.groupTicketLinksByKey>) =>
    [...groups].map(([key, entries]) => [key, entries.map((entry) => entry.threadId)]);

  it("reads a key shared by threads once", () => {
    const groups = TicketSyncReactor.groupTicketLinksByKey(
      [thread("a", [link("AAA-1"), link("BBB-2")]), thread("b", [link("AAA-1")])],
      null,
    );
    assert.deepStrictEqual(summarize(groups), [
      ["AAA-1", ["a", "b"]],
      ["BBB-2", ["a"]],
    ]);
  });

  it("skips dismissed links", () => {
    const groups = TicketSyncReactor.groupTicketLinksByKey(
      [thread("a", [link("AAA-1", { source: "branch-dismissed" }), link("BBB-2")])],
      null,
    );
    assert.deepStrictEqual(summarize(groups), [["BBB-2", ["a"]]]);
  });

  it("keeps only the requested keys", () => {
    const groups = TicketSyncReactor.groupTicketLinksByKey(
      [thread("a", [link("AAA-1"), link("BBB-2")])],
      new Set(["BBB-2"]),
    );
    assert.deepStrictEqual(summarize(groups), [["BBB-2", ["a"]]]);
  });

  it("reads a thread without the field as having no links", () => {
    assert.strictEqual(
      TicketSyncReactor.groupTicketLinksByKey([thread("a", undefined)], null).size,
      0,
    );
  });
});

describe("ticketProjectKey", () => {
  it.each([
    ["ABC_1-42", "ABC_1"],
    ["X-1", "X"],
  ])("%s -> %s", (key, expected) => {
    assert.strictEqual(TicketSyncReactor.ticketProjectKey(key), expected);
  });
});

function makeThread(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:ticket-sync"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

let eventCounter = 0;
function threadEvent(
  type: "thread.created" | "thread.metadata-updated" | "thread.ticket-links-updated",
  payload: OrchestrationV2AppThread,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:ticket-sync:${(eventCounter += 1)}`),
    type,
    threadId: payload.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload,
  };
}

const connectedStatus = (accountName = "Ada"): JiraConnectionStatus => ({
  state: "connected",
  siteUrl: SITE_URL,
  accountName,
  error: null,
});
const disconnectedStatus: JiraConnectionStatus = {
  state: "disconnected",
  siteUrl: null,
  accountName: null,
  error: null,
};

interface HarnessOptions {
  readonly threads?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly jira?: Partial<JiraServiceTestState>;
}

const makeHarness = Effect.fn("makeTicketSyncHarness")(function* (options: HarnessOptions = {}) {
  yield* TestClock.setTime(Date.parse(NOW));
  const activation = yield* Deferred.make<void>();
  const threads = yield* Ref.make<ReadonlyArray<OrchestrationV2AppThread>>(options.threads ?? []);
  const syncCommands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const otherCommands = yield* Ref.make<ReadonlyArray<string>>([]);
  const linkCalls = yield* Ref.make<
    ReadonlyArray<Parameters<ThreadTicketService.ThreadTicketServiceShape["linkTicket"]>[0]>
  >([]);
  const projectKeyReads = yield* Ref.make(0);
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  // Markers: every sweep reads isConfigured once, then (when it gets that far) the threads.
  const configChecks = yield* Queue.unbounded<void>();
  const sweepReads = yield* Queue.unbounded<void>();
  const statusSeen = yield* Queue.unbounded<void>();

  const jira = yield* makeTestJiraService({
    configured: true,
    status: disconnectedStatus,
    siteUrl: SITE_URL,
    ...options.jira,
  });
  const jiraContext = yield* Layer.build(jira.layer);
  const baseJira = Context.get(jiraContext, JiraService.JiraService);
  const jiraLayer = Layer.succeed(JiraService.JiraService, {
    ...baseJira,
    isConfigured: baseJira.isConfigured.pipe(
      Effect.tap(() => Queue.offer(configChecks, undefined)),
    ),
    streamStatus: baseJira.streamStatus.pipe(Stream.tap(() => Queue.offer(statusSeen, undefined))),
    projectKeys: Ref.update(projectKeyReads, (count) => count + 1).pipe(
      Effect.andThen(baseJira.projectKeys),
    ),
  });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type === "thread.ticket-link.sync") {
      return Ref.update(syncCommands, (recorded) => [...recorded, command]).pipe(
        Effect.andThen(
          Ref.update(threads, (current) =>
            current.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    ticketLinks: syncThreadTicketLinks(thread.ticketLinks ?? [], command),
                  }
                : thread,
            ),
          ),
        ),
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    return Ref.update(otherCommands, (recorded) => [...recorded, command.type]).pipe(
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const layerDependencies = Layer.mergeAll(
    jiraLayer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithTicketLinks: (threadId) =>
        Queue.offer(sweepReads, undefined).pipe(
          Effect.andThen(Ref.get(threads)),
          Effect.map((current) =>
            current
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.archivedAt === null &&
                  (thread.ticketLinks?.length ?? 0) > 0,
              )
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: thread.lineage,
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt,
                branch: thread.branch,
                ticketLinks: thread.ticketLinks ?? [],
              })),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch,
      streamDomainEvents: Stream.fromQueue(domainEvents),
    }),
    Layer.mock(ThreadTicketService.ThreadTicketService)({
      linkTicket: (input) =>
        Ref.update(linkCalls, (recorded) => [...recorded, input]).pipe(Effect.as({ linked: true })),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(1)),
    ),
  );

  return {
    activation,
    threads,
    syncCommands,
    otherCommands,
    linkCalls,
    projectKeyReads,
    domainEvents,
    configChecks,
    sweepReads,
    statusSeen,
    jira: jira.controller,
    layer: TicketSyncReactor.layer.pipe(Layer.provide(layerDependencies)),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Waits for the sweep that starting begins; `reads` is false when it stops before reading threads. */
const awaitSweep = Effect.fn("awaitTicketSweep")(function* (fixture: Harness, reads = true) {
  yield* Queue.take(fixture.configChecks);
  if (reads) yield* Queue.take(fixture.sweepReads);
});

const startReactor = Effect.fn("startTicketSyncHarness")(function* (
  fixture: Harness,
  reads = true,
) {
  const reactor = yield* TicketSyncReactor.TicketSyncReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* awaitSweep(fixture, reads);
  yield* Queue.take(fixture.statusSeen);
  yield* reactor.drain;
  return reactor;
});

const tick = Effect.fn("tickTicketSyncHarness")(function* (
  fixture: Harness,
  reactor: TicketSyncReactor.TicketSyncReactor["Service"],
  reads = true,
) {
  yield* TestClock.adjust("2 minutes");
  yield* awaitSweep(fixture, reads);
  yield* reactor.drain;
});

/** An event for a thread the store does not hold: its requested sweep reads threads and ends. */
const flushEvents = Effect.fn("flushTicketSyncEvents")(function* (
  fixture: Harness,
  reactor: TicketSyncReactor.TicketSyncReactor["Service"],
) {
  yield* Queue.offer(
    fixture.domainEvents,
    threadEvent(
      "thread.ticket-links-updated",
      makeThread("sentinel", { ticketLinks: [makeTicketLink({ key: "SENT-1" })] }),
    ),
  );
  yield* Queue.take(fixture.sweepReads);
  yield* reactor.drain;
});

const fetchCalls = (fixture: Harness) => fixture.jira.fetchCalls;

const keysOfCalls = (calls: ReadonlyArray<ReadonlyArray<ThreadTicketKey>>) =>
  calls.map((keys) => [...keys].toSorted());

const S = makeTicketSnapshot({ syncedAt: "2026-11-13T10:00:00.000Z" });
const link = (key: string, snapshot: ThreadTicketSnapshot | null = null) =>
  makeTicketLink({ key, snapshot });

describe("TicketSyncReactor sweeps", () => {
  it.effect("does nothing while Jira is not configured", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1")] })],
        jira: { configured: false },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture, false);
        yield* tick(fixture, reactor, false);
        assert.deepStrictEqual(yield* fetchCalls(fixture), []);
        assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reads each key once per sweep and dispatches only what changed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [
          makeThread("a", { ticketLinks: [link("AAA-1")] }),
          makeThread("b", { ticketLinks: [link("AAA-1"), link("BBB-2")] }),
        ],
        jira: {
          tickets: new Map([
            ["AAA-1", found(S, { title: "One" })],
            ["BBB-2", found(S, { title: "Two" })],
          ]),
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        assert.deepStrictEqual(keysOfCalls(yield* fetchCalls(fixture)), [["AAA-1", "BBB-2"]]);
        const commands = yield* Ref.get(fixture.syncCommands);
        assert.deepStrictEqual(
          commands.map((command) => [command.threadId, command.key]),
          [
            ["a", "AAA-1"],
            ["b", "AAA-1"],
            ["b", "BBB-2"],
          ],
        );
        for (const command of commands) {
          assert.strictEqual(command.observedAt, NOW);
          assert.deepStrictEqual(command.result, {
            type: "snapshot",
            snapshot: {
              ...fieldsOf(S),
              title: command.key === "AAA-1" ? "One" : "Two",
              syncedAt: NOW,
            },
          });
        }

        // The harness projected the snapshots, so an unchanged Jira dispatches nothing.
        yield* tick(fixture, reactor);
        assert.strictEqual((yield* fetchCalls(fixture)).length, 2);
        assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 3);

        yield* fixture.jira.update({
          tickets: new Map([
            ["AAA-1", found(S, { title: "One" })],
            ["BBB-2", found(S, { title: "Two", priority: { id: "1", name: "Highest" } })],
          ]),
        });
        yield* tick(fixture, reactor);
        const after = yield* Ref.get(fixture.syncCommands);
        assert.deepStrictEqual(
          after.slice(3).map((command) => [command.threadId, command.key]),
          [["b", "BBB-2"]],
        );
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.otherCommands)).filter((type) => type === "thread.priority.set"),
          [],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("skips settled threads in the periodic sweep", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [
          makeThread("a", {
            settledAt: DateTime.makeUnsafe("2026-11-12T00:00:00.000Z"),
            ticketLinks: [link("AAA-1", S)],
          }),
          makeThread("b", { settledOverride: "settled", ticketLinks: [link("AAA-1", S)] }),
        ],
        jira: { tickets: new Map([["AAA-1", found(S, { title: "Changed" })]]) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* tick(fixture, reactor);
        assert.deepStrictEqual(yield* fetchCalls(fixture), []);
        assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("syncs a Done ticket whose rank changed", () =>
    Effect.gen(function* () {
      const done = makeTicketSnapshot({ statusName: "Done", statusCategory: "done" });
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", done)] })],
        jira: {
          tickets: new Map([["AAA-1", found(done, { rank: "0|z0000:" })]]),
        },
      });
      yield* Effect.gen(function* () {
        yield* startReactor(fixture);
        const commands = yield* Ref.get(fixture.syncCommands);
        assert.deepStrictEqual(
          commands.map((command) => [command.threadId, command.key]),
          [["a", "AAA-1"]],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("keeps every snapshot when the whole batch fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", S)] })],
        jira: { fetchError: new JiraService.JiraAuthError({ status: 401, message: "no" }) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* tick(fixture, reactor);
        assert.strictEqual((yield* fetchCalls(fixture)).length, 2);
        assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);
        assert.deepStrictEqual(yield* Ref.get(fixture.otherCommands), []);
        const [stored] = yield* Ref.get(fixture.threads);
        assert.deepStrictEqual(stored!.ticketLinks, [link("AAA-1", S)]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("pauses until a rate limit's Retry-After passes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", S)] })],
        jira: {
          fetchError: new JiraService.JiraUnavailableError({
            message: "slow down",
            retryAfterMs: 300_000,
          }),
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        assert.strictEqual((yield* fetchCalls(fixture)).length, 1);
        yield* tick(fixture, reactor, false);
        yield* tick(fixture, reactor, false);
        assert.strictEqual((yield* fetchCalls(fixture)).length, 1);
        yield* tick(fixture, reactor);
        assert.strictEqual((yield* fetchCalls(fixture)).length, 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("records an unreachable ticket once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", S)] })],
        jira: { tickets: new Map([["AAA-1", { type: "unreachable", syncError: "not_found" }]]) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        const commands = yield* Ref.get(fixture.syncCommands);
        assert.deepStrictEqual(
          commands.map((command) => command.result),
          [{ type: "unreachable", syncError: "not_found" }],
        );
        yield* tick(fixture, reactor);
        assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

describe("TicketSyncReactor immediate fetch", () => {
  it.effect("fetches a newly linked ticket without waiting for the sweep", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", S)] })],
        jira: {
          tickets: new Map([
            ["AAA-1", found(S)],
            ["ZZZ-3", found(S, { title: "New" })],
          ]),
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        const before = (yield* fetchCalls(fixture)).length;
        const linked = makeThread("a", { ticketLinks: [link("AAA-1", S), link("ZZZ-3")] });
        yield* Ref.set(fixture.threads, [linked]);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.ticket-links-updated", linked),
        );
        yield* Queue.take(fixture.sweepReads);
        yield* reactor.drain;
        assert.deepStrictEqual(keysOfCalls((yield* fetchCalls(fixture)).slice(before)), [
          ["ZZZ-3"],
        ]);
        const commands = yield* Ref.get(fixture.syncCommands);
        assert.deepStrictEqual(
          commands.map((command) => [command.threadId, command.key]),
          [["a", "ZZZ-3"]],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("gives a settled thread its first snapshot", () =>
    Effect.gen(function* () {
      const settled = makeThread("a", {
        settledOverride: "settled",
        ticketLinks: [link("AAA-1")],
      });
      const fixture = yield* makeHarness({
        threads: [settled],
        jira: { tickets: new Map([["AAA-1", found(S)]]) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        assert.deepStrictEqual(yield* fetchCalls(fixture), []);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.ticket-links-updated", settled),
        );
        yield* Queue.take(fixture.sweepReads);
        yield* reactor.drain;
        assert.deepStrictEqual(keysOfCalls(yield* fetchCalls(fixture)), [["AAA-1"]]);
        assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("shares one request between links made back to back", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        jira: {
          tickets: new Map([
            ["AAA-1", found(S)],
            ["BBB-2", found(S)],
            ["CCC-3", found(S)],
          ]),
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        const linked = makeThread("a", {
          ticketLinks: [link("AAA-1"), link("BBB-2"), link("CCC-3")],
        });
        yield* Ref.set(fixture.threads, [linked]);
        yield* Queue.offerAll(fixture.domainEvents, [
          threadEvent(
            "thread.ticket-links-updated",
            makeThread("a", { ticketLinks: [link("AAA-1")] }),
          ),
          threadEvent(
            "thread.ticket-links-updated",
            makeThread("a", { ticketLinks: [link("AAA-1", S), link("BBB-2")] }),
          ),
          threadEvent("thread.ticket-links-updated", linked),
        ]);
        yield* Queue.take(fixture.sweepReads);
        yield* reactor.drain;
        const calls = keysOfCalls(yield* fetchCalls(fixture));
        assert.deepStrictEqual(calls, [["AAA-1", "BBB-2", "CCC-3"]]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("runs a full sweep when Jira connects, and not on a repeat", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        threads: [makeThread("a", { ticketLinks: [link("AAA-1", S)] })],
        jira: { tickets: new Map([["AAA-1", found(S)]]) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        const before = (yield* fetchCalls(fixture)).length;
        yield* fixture.jira.update({ status: connectedStatus() });
        yield* Queue.take(fixture.statusSeen);
        yield* awaitSweep(fixture);
        yield* reactor.drain;
        assert.strictEqual((yield* fetchCalls(fixture)).length, before + 1);

        yield* fixture.jira.update({ status: connectedStatus("Grace") });
        yield* Queue.take(fixture.statusSeen);
        yield* reactor.drain;
        assert.strictEqual((yield* fetchCalls(fixture)).length, before + 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

describe("TicketSyncReactor branch tickets", () => {
  const withBranch = (branch: string | null, overrides: Partial<OrchestrationV2AppThread> = {}) =>
    makeThread("a", { branch, ...overrides });

  it.effect("links a ticket named in the branch of a new thread", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { projectKeys: new Set(["ABC"]) } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.created", withBranch("feature/abc-12-and-XYZ-3")),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), [
          {
            threadId: ThreadId.make("a"),
            key: "ABC-12",
            url: `${SITE_URL}/browse/ABC-12`,
            source: "branch",
          },
        ]);

        // The same branch again is not read at all.
        const reads = yield* Ref.get(fixture.projectKeyReads);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.metadata-updated", withBranch("feature/abc-12-and-XYZ-3")),
        );
        yield* flushEvents(fixture, reactor);
        assert.strictEqual((yield* Ref.get(fixture.linkCalls)).length, 1);
        assert.strictEqual(yield* Ref.get(fixture.projectKeyReads), reads);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("links only the new ticket when the branch changes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { projectKeys: new Set(["ABC"]) } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.created", withBranch("abc-12")),
        );
        yield* flushEvents(fixture, reactor);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent(
            "thread.metadata-updated",
            withBranch("abc-13", { ticketLinks: [link("ABC-12")] }),
          ),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.linkCalls)).map((call) => call.key),
          ["ABC-12", "ABC-13"],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("never offers a dismissed key again", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { projectKeys: new Set(["ABC"]) } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        const dismissed = [{ ...link("ABC-12"), source: "branch-dismissed" as const }];
        yield* Queue.offerAll(fixture.domainEvents, [
          threadEvent("thread.created", withBranch("abc-12", { ticketLinks: dismissed })),
          threadEvent(
            "thread.metadata-updated",
            withBranch("abc-12-v2", { ticketLinks: dismissed }),
          ),
        ]);
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("retries a branch after a Jira failure", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({
        jira: { projectKeys: new JiraService.JiraUnavailableError({ message: "down" }) },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.created", withBranch("abc-12")),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), []);

        yield* fixture.jira.update({ projectKeys: new Set(["ABC"]) });
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.metadata-updated", withBranch("abc-12")),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.linkCalls)).map((call) => call.key),
          ["ABC-12"],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("makes no Jira call while Jira is not configured", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { configured: false } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture, false);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.created", withBranch("ABC-1")),
        );
        // Detection reads isConfigured and stops: that read is the only sign the event was handled.
        yield* Queue.take(fixture.configChecks);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), []);
        assert.strictEqual(yield* Ref.get(fixture.projectKeyReads), 0);
        assert.deepStrictEqual(yield* fetchCalls(fixture), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("ignores the branch of an archived thread", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { projectKeys: new Set(["ABC"]) } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent(
            "thread.created",
            withBranch("abc-12", { archivedAt: DateTime.makeUnsafe("2026-11-12T00:00:00.000Z") }),
          ),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("does not backfill a branch that predates this process", () =>
    Effect.gen(function* () {
      const fixture = yield* makeHarness({ jira: { projectKeys: new Set(["ABC"]) } });
      yield* Effect.gen(function* () {
        const reactor = yield* startReactor(fixture);
        // The first event the process sees for an existing thread only records its branch.
        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.metadata-updated", withBranch("abc-12")),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(yield* Ref.get(fixture.linkCalls), []);
        assert.strictEqual(yield* Ref.get(fixture.projectKeyReads), 0);

        yield* Queue.offer(
          fixture.domainEvents,
          threadEvent("thread.metadata-updated", withBranch("abc-13")),
        );
        yield* flushEvents(fixture, reactor);
        assert.deepStrictEqual(
          (yield* Ref.get(fixture.linkCalls)).map((call) => call.key),
          ["ABC-13"],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});
