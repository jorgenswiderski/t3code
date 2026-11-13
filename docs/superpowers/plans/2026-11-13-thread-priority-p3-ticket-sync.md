# P3: Ticket sync and branch detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every linked Jira ticket's snapshot (title, status, priority, rank) current on the server, and auto-link tickets named in a thread's branch.

**Architecture:** A new `TicketSyncReactor` service, shaped like `PullRequestSyncReactor`: a drainable worker runs sweeps (a full sweep every 2 minutes, a "requested" sweep for new links, a full sweep on Jira (re)connect). Each sweep reads the eligible threads from one new `ProjectionStore` query, dedupes ticket keys across threads, calls `JiraService.fetchTickets` once, and dispatches `thread.ticket-link.sync` only for the (thread, key) pairs whose stored link would change. On the domain event stream, the same reactor watches thread payloads for a changed `branch` and calls `ThreadTicketService.linkTicket({ source: "branch" })` for keys whose project exists on the site.

**Tech stack:** Effect (`Context.Service`, `Effect.fn`, `Stream`, `Schedule`), `makeDrainableWorker` from `@t3tools/shared/DrainableWorker`, `forkParked` from `apps/server/src/serverActivation.ts`, `@effect/vitest` with `TestClock`.

**Detail level:** targeted. Exact code only for change detection, dedupe and branch-change detection; everything else is interface plus prose.

**Inputs from other plans (code against these; do not wait for their text):** contract §6.1 (`threadTicket.ts` helpers), §6.3 (`thread.ticket-link.sync` command and reducer rules), §6.4 (`ThreadTicketService`), §6.7 (`JiraService`, `JiraError` classes, `JiraTicketFetchResult`), §6.9 (this service's shape and query), §7 (`ticketFixtures.ts`, `JiraServiceTest.ts`), and P1's pure reducer `syncThreadTicketLinks` in `apps/server/src/orchestration-v2/threadTicketReducer.ts`. Where P2 put things (coherence pass): `JiraService.layer` is provided in the `Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer)` group of `layerRuntimeCoreDependenciesBase`, and P1's `ThreadTicketService.layer` is that layer's first `provideMerge`, so both already reach the reactor block; Task 4 adds no provide for them. `JiraService.projectKeys` and `fetchTickets` fail fast with `JiraAuthError` (no request) while the status is an auth error (P2 Task 4.6).

---

## Implementation Location
- **Branch:** feat/thread-priority-p3
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p3
- **Base branch:** feat/thread-priority

Create the worktree only after P1 and P2 have merged into `feat/thread-priority` (contract §5): `git-tools:worktree` skill, or from `/home/lima/workspace/t3code`: `git worktree add -b feat/thread-priority-p3 /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p3 feat/thread-priority`. Then follow AGENTS.md "Dev servers" for setup markers (run `vp i` only if no `.t3/setup-*` marker appears). If P4 or P5 merges first and touches `apps/server/src/server.ts`, rebase this branch onto `feat/thread-priority` (never back-merge).

---

## File map

| File | Change |
| --- | --- |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` | Add `ProjectionThreadTicketLinks` type, `getThreadsWithTicketLinks` to `ProjectionStoreV2Shape`, its implementation next to `getThreadsWithPullRequests` (~L6930), and the `readOnReader(...)` registration next to `getThreadsWithPullRequests: readOnReader(...)` (~L7718). |
| `apps/server/src/orchestration-v2/TicketSyncReactor.ts` | New. Service, `make`, `layer`, exported pure helpers `ticketLinkSyncResult`, `groupTicketLinksByKey`, `ticketProjectKey`. |
| `apps/server/src/orchestration-v2/TicketSyncReactor.test.ts` | New. Pure-helper tables and reactor behaviour tests (pattern: `PullRequestSyncReactor.test.ts`, `Layer.mock` for `OrchestratorV2` / `ProjectionStoreV2`, `TestClock`). |
| `apps/server/src/orchestration-v2/ProjectionSettlement.test.ts` | Add rows for `getThreadsWithTicketLinks` beside the existing `getThreadsWithPullRequests` case (~L440-460; it uses the file's `createThread(name, overrides)` helper and `layerSql`). Other test files only stub `getThreadsWithPullRequests` (for example `ProviderTurnControlService.test.ts` ~L228): add a `getThreadsWithTicketLinks: () => Effect.die(...)` stub to every full `ProjectionStoreV2Shape` mock that typecheck flags. |
| `apps/server/src/server.ts` | Start `TicketSyncReactor` in `layerRuntimeCoreDependenciesBase`, beside the `PullRequestSyncReactor` `Layer.effectDiscard` block (~L759). |

No contract, client, or docs changes. P3 adds no user-visible surface of its own (the status it causes is shown by P2's settings section; snapshots are shown by P6).

---

## Interfaces

### `ProjectionStore` query (contract §6.9)

```ts
export type ProjectionThreadTicketLinks = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "branch" | "ticketLinks"
>;
// ProjectionStoreV2Shape:
readonly getThreadsWithTicketLinks: (
  threadId?: ThreadId,
) => Effect.Effect<ReadonlyArray<ProjectionThreadTicketLinks>, ProjectionStoreV2Error>;
```

Implementation: a copy of `getThreadsWithPullRequests` with `json_array_length(payload_json, '$.ticketLinks') > 0` in place of the `$.pullRequests` condition (same `deleted_at IS NULL`, `$.archivedAt IS NULL`, ordering, `decodeThreadPayload`, error mapping), mapping `ticketLinks: thread.ticketLinks ?? []`. Span name `ProjectionStore.getThreadsWithTicketLinks`. Note: `json_array_length` on a missing path returns NULL, so threads without the field are excluded, as for pull requests.

### `TicketSyncReactor` (contract §6.9, exact)

```ts
export class TicketSyncReactor extends Context.Service<TicketSyncReactor, {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}>()("t3/orchestration-v2/TicketSyncReactor") {}

/** @public */
export const make: Effect.Effect<TicketSyncReactor["Service"], never,
  Orchestrator.OrchestratorV2 | ProjectionStore.ProjectionStoreV2 | JiraService.JiraService |
  ThreadTicketService.ThreadTicketService | SecureRandom.SecureRandom | Scope.Scope>;
export const layer = Layer.effect(TicketSyncReactor, make);
```

Constants: `SWEEP_INTERVAL = "2 minutes"`.

Worker item type: `"all" | "requested"`. Reactor-local state (closures inside `make`, like the PR reactor):

| State | Meaning |
| --- | --- |
| `pendingKeys: Set<ThreadTicketKey>` | Keys waiting for the next requested sweep. |
| `requestedSweepQueued: boolean` | One queued "requested" item at a time; a burst of links shares one Jira request. |
| `allSweepQueued: boolean` | One queued "all" item at a time; the reconnect trigger and the periodic tick at startup do not double-fetch. |
| `pausedUntilMs: number` | Set from `JiraUnavailableError.retryAfterMs` (429). Sweeps before it return without a request and keep `pendingKeys`. |
| `lastBranch: Map<ThreadId, string \| null>` | Last branch seen per thread for branch detection. |

### Behaviour

**Sweep (`TicketSyncReactor.sweep`, `Effect.fn`)**, input `"all" | "requested"`:

1. `if (!(yield* jira.isConfigured)) { pendingKeys.clear(); return; }` (no Jira, no work; links made while unconfigured are fetched by the connect-triggered full sweep).
2. If `Clock.currentTimeMillis < pausedUntilMs`, return (pending keys stay).
3. `threads = yield* projections.getThreadsWithTicketLinks()`.
4. For `"all"`: eligible threads are `isUnsettled(thread)` (`settledOverride !== "settled" && settledAt === null`, the same predicate as `PullRequestSyncReactor.ts` `isUnsettled`). For `"requested"`: all returned threads (archived/deleted already excluded by the query), restricted to the keys in `pendingKeys` (snapshot `pendingKeys` into a local set and clear it before the request). A settled thread still gets its first snapshot when a ticket is linked to it, so its chip shows a title.
5. Group with `groupTicketLinksByKey` (exact code below). Done tickets are not filtered: every visible link is synced.
6. If no groups, return. `observedAt = DateTime.formatIso(yield* DateTime.now)` taken **before** the request (a later concurrent read then wins the stale-write guard, never an earlier one).
7. `results = yield* jira.fetchTickets([...groups.keys()])`. On `JiraError` (failure channel): log a warning with the error tag, dispatch nothing, keep every snapshot, re-add the requested keys to `pendingKeys` for a `"requested"` sweep; if the error is `JiraUnavailableError` with `retryAfterMs`, set `pausedUntilMs = now + retryAfterMs` (max with the current value). Do not report anything to `JiraService` (it records its own status, contract §6.7 / Q7). Never dispatch a priority command.
8. For each group key and each entry: `const result = results.get(key)`; skip when undefined; `const next = ticketLinkSyncResult(entry.link, result, observedAt)`; when `next !== null` dispatch, serialized with a `Semaphore.make(1)` like the PR reactor's `persistence`:
   ```ts
   engine.dispatch({
     type: "thread.ticket-link.sync",
     commandId: CommandId.make(`server:ticket-sync:${entry.threadId}:${yield* random.uuidV4()}`),
     threadId: entry.threadId, key, observedAt, result: next,
   })
   ```
   A failed dispatch is logged (`"ticket sync skipped"`, threadId, key) and does not stop the other entries; interrupts propagate (use the PR reactor's `logSkipped` pattern).

**Worker:** `makeDrainableWorker((scope) => Effect.suspend(() => { if (scope === "requested") requestedSweepQueued = false; else allSweepQueued = false; return sweep(scope); }).pipe(Effect.catchCause(logSkipped("ticket sync sweep failed", {}))))`. The worker serializes sweeps, so two sweeps never race each other's dispatches.

**`start` (`TicketSyncReactor.start`, `Effect.fn`)** forks three parked loops with `forkParked`:

1. Periodic: `Effect.gen(function* () { yield* enqueueAll; yield* worker.drain; }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid)`.
2. Reconnect: `Stream.runForEach(jira.streamStatus, ...)` keeping `previousState` (initially `null`); when `status.state === "connected" && previousState !== "connected"` → `enqueueAll`. Then `previousState = status.state`.
3. Domain events (startup note: the periodic loop's immediate first sweep and the first `streamStatus` emission may each enqueue a full sweep, so two back-to-back startup sweeps are possible; the second dispatches nothing, which is why change detection, not request dedupe, is the guarantee): `Stream.runForEach(engine.streamDomainEvents, ...)`:
   - `thread.ticket-links-updated`: for `visibleThreadTicketLinks(payload.ticketLinks ?? [])` with `snapshot === null && syncError === null` → `requestFetch(link.key)`. Then branch detection on the payload (cheap; normally a no-op).
   - `thread.deleted`: `lastBranch.delete(payload.id)`.
   - `thread.created` and every other event except `thread.deleted` (handled above) whose payload is `OrchestrationV2AppThread` (the thread-payload literal list in `OrchestrationV2DomainEvent`, which includes `thread.metadata-updated`, where branch changes land): `detectBranchTickets(payload)`.
   - Anything else: `Effect.void`.
   Each handler catches non-interrupt causes and logs, so one failure never stops the stream.

Use a type guard over `event.type` (a `Set` of the thread-payload event types derived from the schema's literal list, or a `switch` with explicit cases) rather than `"branch" in event.payload`, so a future non-thread payload with a `branch` field is not misread.

`enqueueAll = Effect.suspend(() => allSweepQueued ? Effect.void : (allSweepQueued = true, worker.enqueue("all")))`; `requestFetch(key)` mirrors the PR reactor's `requestSync` (add to `pendingKeys`, enqueue `"requested"` only when `requestedSweepQueued` is false).

**BackgroundPolicy:** not used. The PR reactor uses it to skip reads for threads no client has open because hosts cap per-account reads; here one batched Jira request covers every ticket per sweep, and inbox priority must be current for threads that are not open. Recorded as a deviation below.

### Exact code: change detection and dedupe

```ts
type TicketLinkSyncResult = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.ticket-link.sync" }
>["result"];

interface TicketLinkEntry {
  readonly threadId: ThreadId;
  readonly link: ThreadTicketLink;
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
  fetched: JiraTicketFetchResult,
  observedAt: string,
): TicketLinkSyncResult | null {
  const result: TicketLinkSyncResult =
    fetched.type === "unreachable"
      ? { type: "unreachable", syncError: fetched.syncError }
      : { type: "snapshot", snapshot: { ...fetched.snapshot, syncedAt: observedAt } };
  // P1's reducer returns its input by reference when nothing would change; one source of truth.
  const links = [link];
  return syncThreadTicketLinks(links, { key: link.key, observedAt, result }) === links ? null : result;
}

export const ticketProjectKey = (key: ThreadTicketKey): string =>
  key.slice(0, key.lastIndexOf("-"));
```

`ticketLinkSyncResult` asks P1's pure `syncThreadTicketLinks` (`apps/server/src/orchestration-v2/threadTicketReducer.ts`, which returns its input by reference on a no-op) whether the reducer would change anything, so the reactor never dispatches a command the reducer would drop, a healthy sweep dispatches nothing, and the stale guard, equality and dismissed rules live in one place (coherence pass: replaces an earlier hand-copied body).

### Exact code: branch-change detection

```ts
const detectBranchTickets = Effect.fn("TicketSyncReactor.detectBranchTickets")(function* (
  thread: OrchestrationV2AppThread,
) {
  const previous = lastBranch.get(thread.id);
  lastBranch.set(thread.id, thread.branch);
  if (previous !== undefined && previous === thread.branch) return;
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
}, (effect, thread) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      // Forget the branch so the thread's next event retries after a Jira or dispatch failure.
      lastBranch.delete(thread.id);
      return Effect.logWarning("branch ticket detection skipped", { threadId: thread.id });
    }),
  ),
);
```

Decisions this code pins:
- Detection runs only from events, never from the sweep (contract §P3), so time passing never re-adds a removed key. The reducer additionally refuses already-linked and `branch-dismissed` keys.
- `lastBranch` starts empty on server start, so a thread's first event after a restart re-evaluates its branch; the `present` filter makes that a no-op for already-handled keys, and no Jira call is made unless a new candidate exists.
- The branch is recorded even when Jira is not configured: configuring Jira later does not backfill branch links on existing threads (see open question 2).
- `projectKeys` is the cached set from `JiraService` (upper case); `branchTicketKeys` already upper-cases and dedupes.

---

## Tasks

### Task 1: `getThreadsWithTicketLinks`

**Files:** `apps/server/src/orchestration-v2/ProjectionStore.ts`, `ProjectionSettlement.test.ts` (and the shape stubs in other test files that fail typecheck).

- [ ] Write the failing test rows (add a case next to the `getThreadsWithPullRequests` one in `ProjectionSettlement.test.ts`; build links with `makeTicketLink` from `testkit/ticketFixtures.ts`):

| Thread state | Expected in result |
| --- | --- |
| active, one link | yes, `ticketLinks` equals the stored array, `branch` present |
| active, `ticketLinks: []` | no |
| active, field absent (pre-feature payload) | no |
| archived, one link | no |
| deleted, one link | no |
| settled, one link | yes (settled filtering is the reactor's job) |
| `threadId` argument given | only that thread |

- [ ] `vp test run apps/server/src/orchestration-v2/ProjectionSettlement.test.ts -t <the new case name>` fails.
- [ ] Implement as specified above; rerun, passes.
- [ ] Commit `feat(server): projection query for threads with ticket links`.

### Task 2: pure helpers

**Files:** `TicketSyncReactor.ts` (helpers only), `TicketSyncReactor.test.ts`.

- [ ] Table test for `ticketLinkSyncResult` (snapshot `S` = `makeTicketSnapshot({ syncedAt: "2026-11-13T10:00:00.000Z" })`, `observedAt` = `"2026-11-13T10:02:00.000Z"` unless stated):

| Link | Fetched | Expected |
| --- | --- | --- |
| `snapshot: null, syncError: null` | found S-fields | `{ type: "snapshot", snapshot: { ...S-fields, syncedAt: observedAt } }` |
| snapshot S, no error | found, same fields | `null` |
| snapshot S | found, priority id changed | snapshot result |
| snapshot S | found, rank changed | snapshot result |
| snapshot S | found, status category `done` (was `indeterminate`) | snapshot result (Done still synced) |
| snapshot S, `syncError: "not_found"` | found, same fields as S | snapshot result (clears error) |
| snapshot S, no error | unreachable `not_found` | `{ type: "unreachable", syncError: "not_found" }` |
| snapshot S, `syncError: "not_found"` | unreachable `not_found` | `null` |
| snapshot S, `syncError: "not_found"` | unreachable `forbidden` | unreachable `forbidden` |
| `source: "branch-dismissed"` | found | `null` |
| snapshot S with `syncedAt` later than `observedAt` | found, changed | `null` (stale) |

- [ ] Table test for `groupTicketLinksByKey`:

| Input | Expected |
| --- | --- |
| threads A{X-1, Y-2}, B{X-1} | `X-1 → [A, B]`, `Y-2 → [A]`, one key each |
| thread A{X-1 branch-dismissed, Y-2} | only `Y-2` |
| A{X-1, Y-2}, `onlyKeys = {Y-2}` | only `Y-2` |
| thread with `ticketLinks` undefined | empty map |

- [ ] `ticketProjectKey`: `"ABC_1-42" → "ABC_1"`, `"X-1" → "X"`.
- [ ] Run `vp test run apps/server/src/orchestration-v2/TicketSyncReactor.test.ts`: fails, implement, passes. Commit `feat(server): ticket sync change detection`.

### Task 3: the reactor

**Files:** `TicketSyncReactor.ts`, `TicketSyncReactor.test.ts`.

Harness: copy the `PullRequestSyncReactor.test.ts` layer setup (`Layer.mock(ProjectionStore.ProjectionStoreV2)` backed by a `Ref` of threads, `Layer.mock(Orchestrator.OrchestratorV2)` with `streamDomainEvents: Stream.fromQueue(domainEvents)` and a `dispatch` that records commands, `ServerActivation` and `SecureRandom` as there; make the mock `dispatch` apply `thread.ticket-link.sync` results to the thread `Ref` so a later sweep sees them), plus `makeTestJiraService` from `apps/server/src/jira/testing/JiraServiceTest.ts` (P2) and a `Layer.mock(ThreadTicketService.ThreadTicketService)` recording `linkTicket` calls. Advance time only with `TestClock.adjust`; wait with `reactor.drain`; no sleeps or polling.

- [ ] Write failing behaviour tests:

| # | Setup | Action | Expected |
| --- | --- | --- | --- |
| 1 | Jira not configured, one linked thread | start, `TestClock.adjust("2 minutes")`, drain | `fetchTickets` never called, no dispatch |
| 2 | configured; threads A{X-1}, B{X-1, Y-2}; Jira returns changed data for both | start, drain | every `fetchTickets` call carries keys `{X-1, Y-2}` (startup can run the periodic sweep and the reconnect sweep back to back, see Behaviour; the second finds nothing changed because the harness projects results); three sync dispatches (A/X-1, B/X-1, B/Y-2), each `observedAt === snapshot.syncedAt` |
| 3 | after #2, project the dispatched snapshots into the store; Jira unchanged | `TestClock.adjust("2 minutes")`, drain | exactly one more `fetchTickets` call than at the end of #2 (drain first and record the count), zero dispatches |
| 4 | Jira changes Y-2 priority | adjust 2 minutes, drain | one dispatch, B/Y-2 only |
| 5 | thread settled (`settledAt` set) with stale link | full sweep | not fetched, no dispatch |
| 6 | link with `statusCategory: "done"` on an unsettled thread, Jira changes its rank | full sweep | dispatched |
| 7 | `fetchTickets` fails with `JiraAuthError` | full sweep | no dispatch, stored snapshots untouched, no `thread.priority.set` ever dispatched |
| 8 | `fetchTickets` fails with `JiraUnavailableError { retryAfterMs: 300_000 }` | sweep at start (t=0, pause until 5 min), then `TestClock.adjust` to 4 minutes total, drain | the 2- and 4-minute ticks make no request; after adjusting to 6 minutes total (next tick) a request is made |
| 9 | Jira returns `unreachable not_found` for X-1 | sweep | unreachable dispatch; next sweep with the same answer dispatches nothing |
| 10 | configured, running | publish `thread.ticket-links-updated` whose payload has new link Z-3 (`snapshot: null`) and an already-synced link | drain without advancing the clock: one `fetchTickets` call with exactly `[Z-3]`, one dispatch |
| 11 | three such events published back to back | drain | one `fetchTickets` call covering all three keys |
| 12 | `streamStatus` controller emits `disconnected`, then `connected` | drain | a full sweep runs (fetch call with every eligible key); emitting `connected` again with no state change does not |
| 13 | configured, project keys `{ABC}` | publish `thread.created` with `branch: "feature/abc-12-and-XYZ-3"` | `linkTicket({ key: "ABC-12", source: "branch", url: browseUrl })` once; XYZ-3 skipped |
| 14 | after #13 | publish `thread.metadata-updated` with the same branch | no `linkTicket` call, no `projectKeys` read |
| 15 | thread with branch `abc-12` whose `ticketLinks` holds ABC-12 as `branch-dismissed` | publish `thread.metadata-updated` with branch changed to `abc-12-v2` | no `linkTicket` call for ABC-12 |
| 16 | branch changes from `abc-12` to `abc-13` | event | `linkTicket` for ABC-13 only |
| 17 | `projectKeys` fails once, then succeeds | two events with the same branch | first logs and links nothing, second links (retry because the branch was forgotten) |
| 18 | Jira not configured | `thread.created` with `branch: "ABC-1"` | no `linkTicket`, no Jira calls |
| 19 | archived thread payload with a new branch | event | no `linkTicket` |

- [ ] `vp test run apps/server/src/orchestration-v2/TicketSyncReactor.test.ts`: fails; implement the service per "Behaviour"; passes.
- [ ] `vp run t3#typecheck` passes.
- [ ] Commit `feat(server): sync linked Jira tickets and detect branch tickets`.

### Task 4: runtime registration

**Files:** `apps/server/src/server.ts`.

- [ ] In `layerRuntimeCoreDependenciesBase`, beside the `PullRequestSyncReactor` block, add:
  ```ts
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* TicketSyncReactor.TicketSyncReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provideMerge(TicketSyncReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
  ```
  No provide for `JiraService` or `ThreadTicketService`: P1 and P2 make both available to this merge (see "Inputs from other plans"). Never build a second `JiraService` instance, since its status and caches must be one per server; if typecheck says one is unreachable, fix the placement in P1/P2's wiring rather than providing it here.
- [ ] `vp run t3#typecheck` passes. Commit `feat(server): start the ticket sync reactor`.

### Task 5: verification and review

- [ ] `vp run check:changed` passes.
- [ ] Runtime transcript (see Testing Strategy).
- [ ] Independent review (fresh-context reviewer subagent, or `/code-review`) of the branch diff against this plan and the spec sections "Sync reactor (server)" and "Branch-name detection (server)"; fix or justify every finding; report them in the handoff. Then merge per contract §5.

---

## Testing Strategy

- **Hermetic (the main proof):** Task 1 query rows, Task 2 helper tables, Task 3 reactor tests driven through mocked `OrchestratorV2` / `ProjectionStoreV2`, P2's `makeTestJiraService` controller, and `TestClock` for the 2-minute sweep and the 429 pause. Commands: `vp test run apps/server/src/orchestration-v2/TicketSyncReactor.test.ts`, `vp test run apps/server/src/orchestration-v2/ProjectionSettlement.test.ts -t <the new case name>`, `vp run t3#typecheck`, then `vp run check:changed` before handoff. No sleeps, polling, or wall clock (AGENTS.md "Verifying").
- **End-to-end:** this is a server-only change with no visible surface of its own, so per AGENTS.md it ships tests plus a short runtime transcript. The primary agent (not a subagent) starts this worktree's dev server (`vp run dev` in the background, seeded `.t3`, never `~/.t3/userdata`, PID captured at spawn) connected read-only to the user's Jira Cloud site with credentials from `request_secret`, links one real ticket to a thread via the existing client command (or P4's tool if merged), and records from the server log/DB: the immediate snapshot, a second sweep dispatching nothing, and a branch-named thread getting a `source: "branch"` link. If the user's Jira credentials are not available at that point, say so in the handoff and rely on P7, which covers "Jira priority/rank changes reflected within ~2 minutes" and branch detection on the integrated branch. Stop the server by its captured PID.
- **Visual:** none. P3 renders nothing; P6/P7 view the chips and indicators.

---

## Open questions / spec deviations

**Resolved by the user (2026-11-13), binding:** D12 no backfill on connect; D13 accepted. Where an item below conflicts, this wins.

1. **BackgroundPolicy is not used (scope said "where it fits").** Context: `PullRequestSyncReactor` asks `BackgroundPolicy.shouldRunScopeWork` so it reads only pull requests in threads a client has open, because hosts cap reads per account. Jira sync makes one batched request (≤100 keys per call, inside `JiraService`) per 2-minute sweep regardless of thread count, and priority sort needs fresh data for threads nobody has open. Options: (a) ignore BackgroundPolicy; (b) skip sweeps entirely when no client is connected. Recommendation: (a); revisit only if Jira rate limits show up in P7.

2. **No branch-detection backfill when Jira is connected later.** Context: the spec says detection runs "when a thread's branch is set or changes" and "only when Jira is configured". A thread whose branch was set before Jira was connected therefore never gets its branch link. Options: (a) as written (no backfill); (b) on (re)connect, run detection over all non-archived threads' current branches. (b) would also re-add nothing dismissed (tombstones are kept), but it links tickets on many old threads at once, which may surprise the user. Recommendation: (a) for now; the user can link manually or the agent links proactively. Decision for the user if they expect connect to annotate existing threads.

3. **Sweep interval differs from the PR reactor.** Context: `PullRequestSyncReactor` ticks every 1 minute; the spec fixes 2 minutes for tickets. Plan follows the spec (`SWEEP_INTERVAL = "2 minutes"`). No action needed; noted so reviewers do not "fix" it.

4. **Requested sweeps include settled threads.** Context: the spec scopes the periodic sweep to non-settled threads but says nothing about the immediate fetch on link. Linking a ticket to a settled thread would otherwise leave its chip without a title forever. Recommendation: immediate fetch covers any non-archived thread (as planned); periodic sweep stays unsettled-only per spec.

5. **"Report status to JiraService" from the scope is not implemented as a call.** Context: contract §6.7 and Q7 make `JiraService` record its own status from every request, so P3 only logs on `JiraError`. Deviation from the run's scope wording, conforming to the contract.

6. **Contract §6.9 assumes `ProjectionThreadTicketLinks` can `Pick` `branch` and `ticketLinks` from `OrchestrationV2AppThread`.** Verified: `branch: Schema.NullOr(TrimmedNonEmptyString)` is on the app thread (`packages/contracts/src/orchestrationV2.ts`), and P1 adds `ticketLinks` there (§6.2). `OrchestrationV2AppThread` has no `deletedAt`; deletion is signalled by the `thread.deleted` event and the projection's `deleted_at` column, which the plan uses. No deviation, recorded for the reviewer.
