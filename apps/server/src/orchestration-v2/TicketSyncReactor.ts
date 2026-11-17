import {
  branchTicketKeys,
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type ThreadId,
  type ThreadTicketKey,
  type ThreadTicketLink,
  type JiraConnectionStatus,
  visibleThreadTicketLinks,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as JiraService from "../jira/JiraService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadTicketService from "./ThreadTicketService.ts";
import { syncThreadTicketLinks } from "./threadTicketReducer.ts";

const SWEEP_INTERVAL = "2 minutes";

type SweepScope = "all" | "requested";

type TicketLinkSyncResult = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.ticket-link.sync" }
>["result"];

interface TicketLinkEntry {
  readonly threadId: ThreadId;
  readonly link: ThreadTicketLink;
}

type ThreadPayloadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

// A Record, so a thread event added to the union fails to compile until it is listed here.
const THREAD_PAYLOAD_EVENT_TYPES: Record<ThreadPayloadEvent["type"], true> = {
  "thread.created": true,
  "thread.archived": true,
  "thread.unarchived": true,
  "thread.deleted": true,
  "thread.settled": true,
  "thread.unsettled": true,
  "thread.snoozed": true,
  "thread.unsnoozed": true,
  "thread.pinned": true,
  "thread.auto-settle-set": true,
  "thread.unpinned": true,
  "thread.pin-reordered": true,
  "thread.active-reordered": true,
  "thread.tags-updated": true,
  "thread.visited": true,
  "thread.marked-unread": true,
  "thread.metadata-updated": true,
  "thread.pull-request-synced": true,
  "thread.runtime-mode-updated": true,
  "thread.interaction-mode-updated": true,
  "thread.auto-compact-updated": true,
  "thread.model-selection-updated": true,
  "thread.provider-switched": true,
  "thread.guest-share-updated": true,
  "thread.ticket-links-updated": true,
  "thread.priority-updated": true,
};

const isThreadPayloadEvent = (event: OrchestrationV2DomainEvent): event is ThreadPayloadEvent =>
  Object.hasOwn(THREAD_PAYLOAD_EVENT_TYPES, event.type);

function isUnsettled(thread: ProjectionStore.ProjectionThreadTicketLinks): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

/** Visible links grouped by ticket key, so each key is read once however many threads share it. */
export function groupTicketLinksByKey(
  threads: ReadonlyArray<Pick<ProjectionStore.ProjectionThreadTicketLinks, "id" | "ticketLinks">>,
  onlyKeys: ReadonlySet<ThreadTicketKey> | null,
): Map<ThreadTicketKey, Array<TicketLinkEntry>> {
  const groups = new Map<ThreadTicketKey, Array<TicketLinkEntry>>();
  for (const thread of threads) {
    for (const link of visibleThreadTicketLinks(thread.ticketLinks ?? [])) {
      if (onlyKeys !== null && !onlyKeys.has(link.key)) continue;
      const entries = groups.get(link.key) ?? [];
      entries.push({ threadId: thread.id, link });
      groups.set(link.key, entries);
    }
  }
  return groups;
}

/** The sync command result to dispatch for one link, or null when the reducer would change nothing. */
export function ticketLinkSyncResult(
  link: ThreadTicketLink,
  fetched: JiraService.JiraTicketFetchResult,
  observedAt: string,
): TicketLinkSyncResult | null {
  const result: TicketLinkSyncResult =
    fetched.type === "unreachable"
      ? { type: "unreachable", syncError: fetched.syncError }
      : { type: "snapshot", snapshot: { ...fetched.snapshot, syncedAt: observedAt } };
  // The reducer returns its input by reference when nothing would change; one source of truth.
  const links = [link];
  return syncThreadTicketLinks(links, { key: link.key, observedAt, result }) === links
    ? null
    : result;
}

export const ticketProjectKey = (key: ThreadTicketKey): string =>
  key.slice(0, key.lastIndexOf("-"));

export class TicketSyncReactor extends Context.Service<
  TicketSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/TicketSyncReactor") {}

/** @public */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const jira = yield* JiraService.JiraService;
  const tickets = yield* ThreadTicketService.ThreadTicketService;
  const random = yield* SecureRandom.SecureRandom;

  // Keys of newly linked tickets wait here for one queued "requested" sweep, so a burst of links
  // shares one Jira request.
  const pendingKeys = new Set<ThreadTicketKey>();
  let requestedSweepQueued = false;
  let allSweepQueued = false;
  // Set from a 429's Retry-After; sweeps before it make no request and keep `pendingKeys`.
  let pausedUntilMs = 0;
  const lastBranch = new Map<ThreadId, string | null>();
  const failedBranches = new Set<ThreadId>();

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const sweep = Effect.fn("TicketSyncReactor.sweep")(function* (scope: SweepScope) {
    if (!(yield* jira.isConfigured)) {
      // Links made while unconfigured are fetched by the sweep that connecting triggers.
      pendingKeys.clear();
      return;
    }
    if ((yield* Clock.currentTimeMillis) < pausedUntilMs) return;

    const threads = yield* projections.getThreadsWithTicketLinks();
    // A settled thread still gets the first snapshot of a ticket linked to it.
    const requestedKeys = scope === "requested" ? new Set(pendingKeys) : null;
    if (requestedKeys !== null) pendingKeys.clear();
    const groups = groupTicketLinksByKey(
      scope === "all" ? threads.filter(isUnsettled) : threads,
      requestedKeys,
    );
    if (groups.size === 0) return;

    // Taken before the request, so a concurrent later read wins the reducer's stale guard.
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const fetched = yield* jira.fetchTickets([...groups.keys()]).pipe(
      Effect.map((results) => ({ results }) as const),
      Effect.catch((error: JiraService.JiraError) => Effect.succeed({ error } as const)),
    );
    if ("error" in fetched) {
      const { error } = fetched;
      yield* Effect.logWarning("ticket sync fetch failed", { error: error._tag });
      if (requestedKeys !== null) for (const key of requestedKeys) pendingKeys.add(key);
      if (error._tag === "JiraUnavailableError" && error.retryAfterMs !== undefined) {
        pausedUntilMs = Math.max(
          pausedUntilMs,
          (yield* Clock.currentTimeMillis) + error.retryAfterMs,
        );
      }
      return;
    }

    // Dispatched one at a time: each command commits before the next, as the worker runs one sweep at a time.
    for (const [key, entries] of groups) {
      const result = fetched.results.get(key);
      if (result === undefined) continue;
      for (const entry of entries) {
        const next = ticketLinkSyncResult(entry.link, result, observedAt);
        if (next === null) continue;
        yield* engine
          .dispatch({
            type: "thread.ticket-link.sync",
            commandId: CommandId.make(
              `server:ticket-sync:${entry.threadId}:${yield* random.uuidV4()}`,
            ),
            threadId: entry.threadId,
            key,
            observedAt,
            result: next,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause(logSkipped("ticket sync skipped", { threadId: entry.threadId, key })),
          );
      }
    }
  });

  const worker = yield* makeDrainableWorker((scope: SweepScope) =>
    Effect.suspend(() => {
      if (scope === "requested") requestedSweepQueued = false;
      else allSweepQueued = false;
      return sweep(scope);
    }).pipe(Effect.catchCause(logSkipped("ticket sync sweep failed", {}))),
  );

  const enqueueAll = Effect.suspend(() => {
    if (allSweepQueued) return Effect.void;
    allSweepQueued = true;
    return worker.enqueue("all");
  });

  const enqueueRequested = Effect.suspend(() => {
    if (requestedSweepQueued) return Effect.void;
    requestedSweepQueued = true;
    return worker.enqueue("requested");
  });

  const requestFetch = (key: ThreadTicketKey) =>
    Effect.suspend(() => {
      pendingKeys.add(key);
      return enqueueRequested;
    });

  const detectBranchTickets = Effect.fn("TicketSyncReactor.detectBranchTickets")(
    function* (eventType: ThreadPayloadEvent["type"], thread: OrchestrationV2AppThread) {
      const previous = lastBranch.get(thread.id);
      lastBranch.set(thread.id, thread.branch);
      const retry = failedBranches.delete(thread.id);
      // A thread first seen after a restart only records its branch, so branches that predate
      // this process (or a later Jira connect) gain no links; a thread that is new does detect.
      const branchChanged =
        previous === undefined ? eventType === "thread.created" : previous !== thread.branch;
      if (!branchChanged && !retry) return;
      if (thread.archivedAt !== null) return;
      // Dismissed links are in ticketLinks too, so a dismissed key is never offered again.
      const present = new Set((thread.ticketLinks ?? []).map((link) => link.key));
      const candidates = branchTicketKeys(thread.branch).filter((key) => !present.has(key));
      if (candidates.length === 0) return;
      if (!(yield* jira.isConfigured)) return;
      const projectKeys = yield* jira.projectKeys;
      for (const key of candidates) {
        if (!projectKeys.has(ticketProjectKey(key))) continue;
        yield* tickets.linkTicket({
          threadId: thread.id,
          key,
          url: yield* jira.browseUrl(key),
          source: "branch",
        });
      }
    },
    (effect, _eventType, thread) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          // The thread's next event retries after a Jira or dispatch failure.
          failedBranches.add(thread.id);
          return Effect.logWarning("branch ticket detection skipped", { threadId: thread.id });
        }),
      ),
  );

  const onDomainEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "thread.deleted") {
      lastBranch.delete(event.threadId);
      failedBranches.delete(event.threadId);
      return Effect.void;
    }
    if (!isThreadPayloadEvent(event)) return Effect.void;
    const unsynced =
      event.type === "thread.ticket-links-updated"
        ? visibleThreadTicketLinks(event.payload.ticketLinks ?? []).filter(
            (link) => link.snapshot === null && link.syncError === null,
          )
        : [];
    return Effect.forEach(unsynced, (link) => requestFetch(link.key), { discard: true }).pipe(
      Effect.andThen(detectBranchTickets(event.type, event.payload)),
      Effect.catchCause(logSkipped("ticket sync event skipped", { threadId: event.threadId })),
    );
  };

  const start: TicketSyncReactor["Service"]["start"] = Effect.fn("TicketSyncReactor.start")(
    function* () {
      // The periodic tick also retries keys a failed or paused requested sweep kept.
      yield* forkParked(
        Effect.gen(function* () {
          yield* enqueueAll;
          if (pendingKeys.size > 0) yield* enqueueRequested;
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
      let previousState: JiraConnectionStatus["state"] | null = null;
      yield* forkParked(
        Stream.runForEach(jira.streamStatus, (status) =>
          Effect.suspend(() => {
            const reconnected = status.state === "connected" && previousState !== "connected";
            previousState = status.state;
            return reconnected ? enqueueAll : Effect.void;
          }),
        ).pipe(Effect.catchCause(logSkipped("ticket sync status stream failed", {}))),
      );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, onDomainEvent).pipe(
          Effect.catchCause(logSkipped("ticket sync event stream failed", {})),
        ),
      );
    },
  );

  return { start, drain: worker.drain } satisfies TicketSyncReactor["Service"];
});

export const layer = Layer.effect(TicketSyncReactor, make);
