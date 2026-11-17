import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  type JiraConnectionStatus,
  type JiraTestConnectionResult,
  type PriorityRef,
  type ThreadTicketKey,
  jiraBrowseUrl,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  type JiraError,
  JiraNotConfiguredError,
  JiraService,
  type JiraTicketFetchResult,
} from "../JiraService.ts";

export interface JiraServiceTestState {
  readonly configured: boolean;
  readonly status: JiraConnectionStatus;
  readonly priorityScale: ReadonlyArray<PriorityRef>;
  readonly siteUrl: string | null;
  readonly projectKeys: ReadonlySet<string> | JiraError;
  /** A key missing here reads as not_found. */
  readonly tickets: ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>;
  /** Fails every fetchTickets call while set. */
  readonly fetchError: JiraError | null;
  readonly testResult: JiraTestConnectionResult;
}

export interface JiraServiceTestController {
  /** Applies the patch and publishes status and scale changes to the streams. */
  readonly update: (patch: Partial<JiraServiceTestState>) => Effect.Effect<void>;
  readonly fetchCalls: Effect.Effect<ReadonlyArray<ReadonlyArray<ThreadTicketKey>>>;
}

const defaults: JiraServiceTestState = {
  configured: false,
  status: { state: "disconnected", siteUrl: null, accountName: null, error: null },
  priorityScale: DEFAULT_TICKET_PRIORITY_SCALE,
  siteUrl: null,
  projectKeys: new Set(),
  tickets: new Map(),
  fetchError: null,
  testResult: { type: "failed", kind: "auth", message: "Not configured." },
};

/** A scriptable JiraService with the real service's current-then-changes streams. */
export const makeTestJiraService = Effect.fn("JiraServiceTest.make")(function* (
  initial: Partial<JiraServiceTestState> = {},
) {
  const stateRef = yield* Ref.make<JiraServiceTestState>({ ...defaults, ...initial });
  const fetchCallsRef = yield* Ref.make<ReadonlyArray<ReadonlyArray<ThreadTicketKey>>>([]);
  const statusChanges = yield* PubSub.unbounded<JiraConnectionStatus>();
  const scaleChanges = yield* PubSub.unbounded<ReadonlyArray<PriorityRef>>();

  const read = <A>(select: (state: JiraServiceTestState) => A) =>
    Ref.get(stateRef).pipe(Effect.map(select));

  const stream = <A>(select: (state: JiraServiceTestState) => A, changes: PubSub.PubSub<A>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* read(select);
        return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription)).pipe(
          Stream.changesWith((left: A, right: A) => Equal.equals(left, right)),
        );
      }),
    );

  const controller: JiraServiceTestController = {
    update: Effect.fn("JiraServiceTest.update")(function* (patch) {
      const [previous, next] = yield* Ref.modify(stateRef, (state) => {
        const updated = { ...state, ...patch };
        return [[state, updated] as const, updated];
      });
      if (!Equal.equals(previous.status, next.status)) {
        yield* PubSub.publish(statusChanges, next.status);
      }
      if (!Equal.equals(previous.priorityScale, next.priorityScale)) {
        yield* PubSub.publish(scaleChanges, next.priorityScale);
      }
    }),
    fetchCalls: Ref.get(fetchCallsRef),
  };

  const layer = Layer.succeed(JiraService, {
    isConfigured: read((state) => state.configured),
    status: read((state) => state.status),
    streamStatus: stream((state) => state.status, statusChanges),
    priorityScale: read((state) => state.priorityScale),
    streamPriorityScale: stream((state) => state.priorityScale, scaleChanges),
    browseUrl: (key) =>
      read((state) => (state.siteUrl === null ? null : jiraBrowseUrl(state.siteUrl, key))),
    projectKeys: Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (!state.configured) return yield* new JiraNotConfiguredError();
      const projectKeys = state.projectKeys;
      if ("_tag" in projectKeys) return yield* projectKeys;
      return projectKeys;
    }),
    fetchTickets: Effect.fn("JiraServiceTest.fetchTickets")(function* (
      keys: ReadonlyArray<ThreadTicketKey>,
    ) {
      yield* Ref.update(fetchCallsRef, (calls) => [...calls, keys]);
      const state = yield* Ref.get(stateRef);
      if (!state.configured) return yield* new JiraNotConfiguredError();
      if (state.fetchError !== null) return yield* state.fetchError;
      return new Map(
        keys.map((key): [ThreadTicketKey, JiraTicketFetchResult] => [
          key,
          state.tickets.get(key) ?? { type: "unreachable", syncError: "not_found" },
        ]),
      );
    }),
    testConnection: () => read((state) => state.testResult),
  });

  return { layer, controller };
});
