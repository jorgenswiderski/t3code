# Thread tickets and priority, P1: thread data core. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Threads carry Jira ticket links and a user/agent priority, changed only through four
orchestration commands, stored in projections and shells, and reachable from the server
(`ThreadTicketService`) and clients (`threadEnvironment.linkTicket` etc.).

**Architecture:** New contracts module `threadTicket.ts` (schemas plus pure helpers). Two optional,
leniently decoded fields on the thread and shell. Three client commands and one server-only
command, all reduced in `Orchestrator.dispatchThreadMutation` by pure functions in a new
`threadTicketReducer.ts`. Two thread-payload events that never bump `updatedAt`. A thin server
service dispatches the same commands for P3 (reactor) and P4 (MCP). Clients dispatch through the
existing `orchestration.dispatchCommand`.

**Tech Stack:** TypeScript, Effect (Schema, Context.Service, Layer), `@effect/vitest`, SQLite
projections (JSON payload column, no migration).

**Spec:** `docs/superpowers/specs/2026-11-13-thread-priority-design.md` (sections "Thread state
(contracts)" and "Commands and events").
**Contract (binding):** `docs/superpowers/plans/2026-11-13-thread-priority-index.md`, §1 "P1",
§4 D1/D2/D7/D9, §6.1 to §6.5, §6.8 capability, §7 server ticket fixtures, §8, §9.

Detail level: **targeted**. Exact code appears only where it is the decision (link/unlink/dismiss
semantics, sync stale guard and no-op equality, no-event-on-no-op, `updatedAt` exclusion, key
parsing). Everything else is a signature, a file, and prose. Line numbers are from `ddec2d528a`
and drift; re-locate by symbol.

## Global Constraints

- `ticketLinks` and `priority` are `Schema.optional` and decode leniently: a value this build
  cannot read becomes `[]` / `{ user: null, agent: null }`, never a thread decode failure (D1).
- `thread.ticket-link.sync` lives only in `OrchestrationV2InternalCommand`; no client can send it (D7).
- A command that changes nothing emits **no event** and succeeds (§6.3). A sync whose snapshot
  equals the stored one ignoring `syncedAt` writes nothing (anti-goal: no history growth per tick).
- None of the four commands changes the thread's `updatedAt`; server `ProjectionStore` and the
  client projection treat both events like `thread.tags-updated` (spec: "Neither field bumps the
  thread's `updatedAt`").
- Unlinking a `branch` link (or a key present in the thread's branch name) turns it into
  `branch-dismissed`; it is hidden and branch detection never re-adds it. A manual/agent link
  of the same key undismisses it (no one-way door).
- Archived threads accept all four commands; deleted or missing threads are rejected by the
  existing guards. No new guard.
- `threadTickets: true` capability gates every client dispatch (D2); P1 only advertises it.
- No new ws method and no `CLIENT_GUARDED_RPC_SCOPES` entry (contract Q1).
- Do not edit the spec. Do not run repo-wide checks, installs, or dev servers from subagents.

## Review Focus

1. A user removes a manually linked ticket whose key is also in the branch name: it must stay
   removed after branch detection runs again (tombstone), and a later manual link brings it back.
   Pinned in Task 3's unlink/link tables.
2. A Jira sync result lands after the user removed or dismissed that ticket: it must not bring
   the link back or write anything. Pinned in Task 3's sync table (missing / dismissed rows).
3. A thread written by a newer server with a ticket source or snapshot shape this build does not
   know, or an old thread with neither field: the thread still loads; links read `[]`, priority
   reads empty. Pinned in Task 2's leniency test.
4. The same Jira data synced twice (only `syncedAt` differs): zero stored events and no shell
   change. Pinned in Task 4's integration test (`storedEvents.length === 0`).
5. A ticket is linked to an archived thread, or the service is called for a thread id that was
   deleted: archived succeeds, deleted/missing returns `ThreadTicketThreadNotFoundError`. Pinned
   in Task 4 (archived) and Task 6 (service errors).

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/contracts/src/threadTicket.ts` | create | §6.1 schemas, constants, pure helpers |
| `packages/contracts/src/threadTicket.test.ts` | create | helper tables |
| `packages/contracts/src/index.ts` | modify | `export * from "./threadTicket.ts";` (beside `./threadTags.ts`, ~L50) |
| `packages/contracts/src/environment.ts` | modify | `threadTickets` capability (beside `threadActiveReorder`, ~L125) |
| `packages/contracts/src/orchestrationV2.ts` | modify | thread/shell fields, commands, events |
| `packages/contracts/src/orchestrationV2.test.ts` | modify | new `describe("thread tickets and priority")` |
| `apps/server/src/orchestration-v2/threadTicketReducer.ts` | create | pure reducers shared by Orchestrator (and readable by P3) |
| `apps/server/src/orchestration-v2/threadTicketReducer.test.ts` | create | reducer tables |
| `apps/server/src/orchestration-v2/Orchestrator.ts` | modify | routing, reducer cases, no-op return, event types |
| `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | modify | extend the lifecycle test after the tag loop (~L2650) |
| `apps/server/src/relay/AgentAwarenessRelay.ts` | modify | add both events to the exhaustive switch group with `thread.tags-updated` (~L117) |
| `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` | modify | `commandThreadIds` (~L135): three client commands return `[command.threadId]` |
| `apps/server/src/telemetry/FeatureUsage.ts` | modify | `thread.ticket.link`, `thread.priority.set` features |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` | modify | apply both events, shell builders |
| `apps/server/src/orchestration-v2/ProjectionStore.test.ts` | modify | extend `backgroundThreadUpdatesKeepTimestamp` (~L1740) |
| `apps/server/src/orchestration-v2/testkit/ticketFixtures.ts` | create | §7 `makeTicketLink`, `makeTicketSnapshot` |
| `apps/server/src/environment/ServerEnvironment.ts` (+ `.test.ts`) | modify | `threadTickets: true` (~L257; test ~L246) |
| `apps/server/src/orchestration-v2/ThreadTicketService.ts` | create | §6.4 service |
| `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | modify (again, Task 6) | new `it.effect` for service booleans and error mapping on the real in-memory runtime |
| `apps/server/src/server.ts` | modify | provide `ThreadTicketService.layer` |
| `packages/client-runtime/src/state/models.ts` | modify | `EnvironmentThreadShell` fields, `presentThreadShell` |
| `packages/client-runtime/src/state/orchestrationV2Projection.ts` (+ `.test.ts`) | modify | skip-`updatedAt` group (~L297) |
| `packages/client-runtime/src/operations/commands.ts` | modify | §6.5 command functions (beside `linkThreadPullRequest`, ~L1124) |
| `packages/client-runtime/src/state/threadCommands.ts` | modify | `linkTicket`, `unlinkTicket`, `setPriority` atoms (beside `linkPullRequest`, ~L232) |

---

### Task 1: `threadTicket.ts` contracts and capability (milestone **P1-contract**)

This task is exactly the P1-contract milestone (§1): nothing else goes in its commit.

**Files:**
- Create: `packages/contracts/src/threadTicket.ts`, `packages/contracts/src/threadTicket.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/environment.ts`

**Interfaces:**
- Produces: every export in contract §6.1 with those exact names and types (`ThreadTicketKey`,
  `ThreadTicketLinkSource`, `ThreadTicketCommandSource`, `ThreadTicketStatusCategory`,
  `PriorityRef`, `ThreadTicketSnapshot`, `ThreadTicketSyncError`, `ThreadTicketLink`,
  `ThreadPriority`, `EMPTY_THREAD_PRIORITY`, `StoredThreadTicketLinks`, `StoredThreadPriority`,
  `DEFAULT_TICKET_PRIORITY_SCALE`, `parseTicketReference`, `branchTicketKeys`, `jiraBrowseUrl`,
  `visibleThreadTicketLinks`, `isReadableThreadTicketLink`, `threadTicketSnapshotsEqual`,
  `findPriorityInScale`), each schema with a same-named `Type` alias; and
  `ExecutionEnvironmentCapabilities.threadTickets: Schema.optionalKey(Schema.Boolean)` with the doc
  comment `/** Accepts thread ticket/priority commands and carries ticketLinks/priority on threads. */`.
  P2, P3, P4, P5, P6 import these; do not rename.

- [ ] **Step 1: Write the failing tests** in `threadTicket.test.ts` (`@effect/vitest` `it`/`expect`, one `it` per helper, table rows):

| Helper | Input | Expected |
| --- | --- | --- |
| `parseTicketReference` | `"  proj-12 "` | `{ key: "PROJ-12", url: null }` |
| | `"https://acme.atlassian.net/browse/proj-12"` | `{ key: "PROJ-12", url: "https://acme.atlassian.net/browse/PROJ-12" }` |
| | `"https://acme.atlassian.net/browse/PROJ-12?focusedCommentId=1"` | same key, `url` without query |
| | `"https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7"` | `{ key: "PROJ-7", url: "https://acme.atlassian.net/browse/PROJ-7" }` |
| | `"ftp://acme/browse/PROJ-1"`, `"PROJ-"`, `"12-34"`, `""`, `"https://acme.atlassian.net/"` | `null` |
| `branchTicketKeys` | `"feat/proj-12-and-ABC_2-7"` | `["PROJ-12", "ABC_2-7"]` |
| | `"PROJ-12/PROJ-12-again"` | `["PROJ-12"]` |
| | `"v1-2"`, `"xPROJ-12"` | `["V1-2"]`, `["XPROJ-12"]` (the regex accepts any 2+ char prefix; P3 filters by real project keys) |
| | `"PROJ-123abc"` | `["PROJ-123"]` |
| | `null` | `[]` |
| `jiraBrowseUrl` | `("https://acme.atlassian.net//", "PROJ-1")` | `"https://acme.atlassian.net/browse/PROJ-1"` |
| `threadTicketSnapshotsEqual` | same fields, different `syncedAt` | `true` |
| | priority `{id:"1",name:"High"}` vs `{id:"1",name:"Highest"}`; rank `"0|a"` vs `"0|b"`; priority `null` vs object | `false` each |
| `findPriorityInScale` | `(DEFAULT…, "default:low")` | `{ ref: Low, position: 3 }` |
| | `(DEFAULT…, "high")`, `(DEFAULT…, { name: "HIGH" })` | `{ ref: High, position: 1 }` |
| | `(DEFAULT…, { id: "nope", name: "Medium" })` | position 2 (name fallback) |
| | `(DEFAULT…, "Urgent")` | `null` |
| `visibleThreadTicketLinks` / `isReadableThreadTicketLink` | links of each source, with/without snapshot and syncError | dismissed excluded; readable only when not dismissed, snapshot non-null, syncError null |
| `StoredThreadTicketLinks` decode | `[{ ...validLink, source: "jira-epic" }]` | `[]` |
| `StoredThreadPriority` decode | `{ user: 5 }` | `EMPTY_THREAD_PRIORITY` |

- [ ] **Step 2: Run and see it fail.** `vp test run packages/contracts/src/threadTicket.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `threadTicket.ts`** exactly per §6.1 schemas. The lenient forms follow `StoredThreadTags` (`packages/contracts/src/threadTags.ts:16`):

```ts
export const StoredThreadTicketLinks = Schema.Array(ThreadTicketLink).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);
export const StoredThreadPriority = ThreadPriority.pipe(
  Schema.catchDecoding(() => Effect.succeedSome(EMPTY_THREAD_PRIORITY)),
);
```

Key parsing is the decision (shared by MCP, UI dialog and branch detection), so exactly:

```ts
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9_]+-[0-9]+$/;
const BROWSE_PATH = /\/browse\/([A-Za-z][A-Za-z0-9_]+-[0-9]+)(?:\/|$)/;
const BRANCH_KEY = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]+-[0-9]+)(?![0-9])/g;

export function parseTicketReference(input: string): { key: ThreadTicketKey; url: string | null } | null {
  const trimmed = input.trim();
  if (TICKET_KEY.test(trimmed)) return { key: trimmed.toUpperCase(), url: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const candidate = BROWSE_PATH.exec(url.pathname)?.[1] ?? url.searchParams.get("selectedIssue");
  if (candidate === null || candidate === undefined || !TICKET_KEY.test(candidate)) return null;
  const key = candidate.toUpperCase();
  return { key, url: `${url.origin}/browse/${key}` };
}

export function branchTicketKeys(branch: string | null): ReadonlyArray<ThreadTicketKey> {
  if (branch === null) return [];
  const keys = [...branch.matchAll(BRANCH_KEY)].map((match) => match[1]!.toUpperCase());
  return [...new Set(keys)];
}
```

Note on the table row `"PROJ-12/PROJ-12-again"`: the second `PROJ-12` is followed by `-`, not a
digit, so it matches and dedupes. The `(?![0-9])` lookahead plus greedy `[0-9]+` means
`PROJ-123abc` yields `PROJ-123`. `ThreadTicketKey` is an unbranded string (`TrimmedNonEmptyString`
is unbranded), so no cast is needed. The other helpers are as §6.1 describes; write them
directly. `threadTicketSnapshotsEqual` compares `title`, `statusName`, `statusCategory`, `rank`,
and `priority` (`a === b` when both null, else equal `id` and `name`), never `syncedAt`.

- [ ] **Step 4: Export and capability.** Add `export * from "./threadTicket.ts";` to `index.ts`; add
  the `threadTickets` field to `ExecutionEnvironmentCapabilities` in `environment.ts`.

- [ ] **Step 5: Verify.** `vp test run packages/contracts/src/threadTicket.test.ts` → PASS;
  `vp run @t3tools/contracts#typecheck` → no errors.

- [ ] **Step 6: Commit (the milestone).**

```bash
git add packages/contracts/src/threadTicket.ts packages/contracts/src/threadTicket.test.ts packages/contracts/src/index.ts packages/contracts/src/environment.ts
git commit -m "feat(contracts): thread ticket link and priority schemas"
```

- [ ] **Step 7: Publish the milestone (§5 "Milestone merge").** Record the commit sha. From the
  clean integration worktree `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority`:
  `git merge --no-ff <sha> -m "merge: P1-contract (feat/thread-priority-p1)"`. Tell the
  orchestrator P2 may start. Keep working on the P1 branch.

---

### Task 2: Thread fields, commands and events in `orchestrationV2.ts`

**Files:**
- Modify: `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/orchestrationV2.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces (§6.2, §6.3 exactly):
  - `OrchestrationV2AppThread` (~L463) and `OrchestrationV2ThreadShell` (~L2138), next to
    `pullRequests`: `ticketLinks: Schema.optional(StoredThreadTicketLinks)`,
    `priority: Schema.optional(StoredThreadPriority)`. No `*Json` `mapFields` changes (all date
    fields are `IsoDateTime` strings).
  - In `OrchestrationV2Command` (~L2977, after `thread.pull-request.sync`): `thread.ticket.link`
    `{ commandId, threadId, key: ThreadTicketKey, url: Schema.optional(TrimmedNonEmptyString), source: ThreadTicketCommandSource }`,
    `thread.ticket.unlink` `{ commandId, threadId, key }`, `thread.priority.set`
    `{ commandId, threadId, source: Schema.Literals(["user", "agent"]), priority: Schema.NullOr(PriorityRef) }`.
  - In `OrchestrationV2InternalCommand` (~L3471): `thread.ticket-link.sync`
    `{ commandId, threadId, key, observedAt: IsoDateTime, result: Union(snapshot | unreachable) }` per §6.3.
  - `"thread.ticket-links-updated"` and `"thread.priority-updated"` appended to the thread-payload
    `Schema.Literals` list in both `OrchestrationV2DomainEvent` (~L1936) and
    `OrchestrationV2DomainEventJson` (~L2836).

- [ ] **Step 1: Write the failing tests** in a new `describe("thread tickets and priority", …)` in
  `orchestrationV2.test.ts` (model it on `describe("per-thread auto-compact")`, ~L727):
  1. A pre-change thread payload (an existing fixture without the fields) decodes with
     `ticketLinks === undefined` and `priority === undefined`; the same payload with
     `ticketLinks: [{ ...link, source: "jira-epic" }]` and `priority: "high"` decodes with
     `ticketLinks: []` and `priority: EMPTY_THREAD_PRIORITY` (Review Focus 3).
  2. `Schema.decodeUnknownSync(OrchestrationV2Command)` accepts each of the three client commands
     (one valid payload each, `priority: null` included) and **throws** for
     `{ type: "thread.ticket-link.sync", … }` (the D7 permission proof, contract Q1).
  3. `OrchestrationV2DomainEventJson` decodes a `thread.ticket-links-updated` and a
     `thread.priority-updated` event with a JSON thread payload.

- [ ] **Step 2: Run and see it fail.** `vp test run packages/contracts/src/orchestrationV2.test.ts -t "thread tickets"` → FAIL.

- [ ] **Step 3: Implement** the schema additions listed under Interfaces.

- [ ] **Step 4: Verify.** Same test command → PASS. `vp run @t3tools/contracts#typecheck` → clean.
  (Server/client typecheck will fail on exhaustive switches until Tasks 4, 5, 7; that is expected.)

- [ ] **Step 5: Commit.** `git commit -m "feat(contracts): thread ticket and priority commands and events"`

---

### Task 3: Pure reducers (`threadTicketReducer.ts`)

These four functions are the semantics of the feature. Each returns **its input by reference**
when nothing changes; the Orchestrator turns identity into "no event".

**Files:**
- Create: `apps/server/src/orchestration-v2/threadTicketReducer.ts`, `threadTicketReducer.test.ts`
- Create: `apps/server/src/orchestration-v2/testkit/ticketFixtures.ts` (§7)

**Interfaces:**
- Consumes: `branchTicketKeys`, `threadTicketSnapshotsEqual`, Task 1 types.
- Produces:
  - `linkThreadTicketLinks(links, { key, url: string | null, source: ThreadTicketCommandSource, linkedAt: string }): ReadonlyArray<ThreadTicketLink>`
  - `unlinkThreadTicketLinks(links, { key, branch: string | null }): ReadonlyArray<ThreadTicketLink>`
  - `syncThreadTicketLinks(links, { key, observedAt: string, result: Extract<OrchestrationV2ServerCommand, { type: "thread.ticket-link.sync" }>["result"] }): ReadonlyArray<ThreadTicketLink>`
  - `setThreadPriorityValue(priority: ThreadPriority, { source: "user" | "agent", priority: PriorityRef | null }): ThreadPriority`
  - testkit: `makeTicketSnapshot(overrides?: Partial<ThreadTicketSnapshot>): ThreadTicketSnapshot`
    (defaults: title `"Fix login"`, statusName `"In Progress"`, statusCategory `"indeterminate"`,
    priority `{ id: "2", name: "High" }`, rank `"0|i0000:"`, syncedAt `"2026-11-13T10:00:00.000Z"`)
    and `makeTicketLink(overrides?: Partial<ThreadTicketLink>): ThreadTicketLink` (defaults:
    tracker `"jira"`, key `"PROJ-1"`, url `"https://acme.atlassian.net/browse/PROJ-1"`, source
    `"manual"`, linkedAt `"2026-11-13T09:00:00.000Z"`, snapshot `null`, syncError `null`). P3/P4
    reuse these.

- [ ] **Step 1: Write the failing tables** (one `it` per function, `it.each`-style rows; "same" means `toBe(input)`):

Link (`linkedAt` = `T`):

| Existing link for `PROJ-1` | Command source, url | Expected |
| --- | --- | --- |
| none | `manual`, `null` | appended `{ tracker:"jira", key, url:null, source:"manual", linkedAt:T, snapshot:null, syncError:null }` |
| none | `branch`, `"https://…/PROJ-1"` | appended with that url, source `branch` |
| `manual` | `agent` | same |
| `branch` | `manual` | same (stays `branch`) |
| `branch-dismissed` | `branch` | same (stays dismissed) |
| `branch-dismissed` (url `null`) | `manual`, `"https://x/browse/PROJ-1"` | source `manual`, url set, `linkedAt` and snapshot kept |
| `branch-dismissed` (url `u`) | `agent`, `null` | source `agent`, url `u` |

Unlink (`branch` argument shown):

| Existing | Branch | Expected |
| --- | --- | --- |
| none | `null` | same |
| `branch-dismissed` | any | same |
| `manual` | `"main"` | removed |
| `agent` | `null` | removed |
| `branch` with snapshot and syncError `"forbidden"` | `"feat/PROJ-1"` | `{ source:"branch-dismissed", snapshot:null, syncError:null }`, other fields kept |
| `manual` | `"feat/proj-1-login"` | `branch-dismissed` (key in branch name, contract Q4) |
| other links present | | untouched, order kept |

Sync (stored snapshot `syncedAt` = `S` = `10:00`):

| Existing | `observedAt` | Result | Expected |
| --- | --- | --- | --- |
| none | any | snapshot | same |
| `branch-dismissed` | any | snapshot | same |
| snapshot at `S` | `09:59` | snapshot (different title) | same (stale) |
| snapshot null, syncError null | `09:00` | snapshot | snapshot set, syncError null |
| snapshot at `S` | `10:05` | equal data, `syncedAt` `10:05` | same (no-op; stored `syncedAt` stays `S`) |
| snapshot at `S` | `10:05` | priority changed | snapshot replaced |
| snapshot at `S`, syncError `"not_found"` | `10:05` | equal data | snapshot replaced, syncError `null` |
| snapshot at `S` | `10:05` | unreachable `"forbidden"` | syncError `"forbidden"`, snapshot kept |
| syncError `"forbidden"` | `10:05` | unreachable `"forbidden"` | same |
| syncError `"forbidden"` | `10:05` | unreachable `"not_found"` | syncError `"not_found"` |

Priority:

| Stored `{user, agent}` | Command | Expected |
| --- | --- | --- |
| empty | `user`, High | `{ user: High, agent: null }` |
| `{ user: High }` | `user`, `{ id: High.id, name: High.name }` (new object) | same |
| `{ user: High }` | `user`, `null` | `{ user: null, agent: null }` |
| empty | `agent`, `null` | same |
| `{ agent: Low }` | `agent`, `{ id: Low.id, name: "low" }` | replaced (name differs) |
| `{ user: High, agent: Low }` | `agent`, Medium | user kept |

- [ ] **Step 2: Run and see it fail.** `vp test run apps/server/src/orchestration-v2/threadTicketReducer.test.ts` → FAIL.

- [ ] **Step 3: Implement exactly:**

```ts
type Links = ReadonlyArray<ThreadTicketLink>;
type SyncResult = Extract<OrchestrationV2ServerCommand, { type: "thread.ticket-link.sync" }>["result"];

export function linkThreadTicketLinks(
  links: Links,
  input: { readonly key: ThreadTicketKey; readonly url: string | null; readonly source: ThreadTicketCommandSource; readonly linkedAt: string },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined) {
    return [...links, { tracker: "jira", key: input.key, url: input.url, source: input.source, linkedAt: input.linkedAt, snapshot: null, syncError: null }];
  }
  // Only an explicit manual/agent link undismisses; branch detection never does.
  if (existing.source !== "branch-dismissed" || input.source === "branch") return links;
  return links.map((link) => link === existing ? { ...link, source: input.source, url: input.url ?? link.url } : link);
}

export function unlinkThreadTicketLinks(
  links: Links,
  input: { readonly key: ThreadTicketKey; readonly branch: string | null },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined || existing.source === "branch-dismissed") return links;
  // Tombstone anything branch detection could re-add, so a removal sticks.
  if (existing.source === "branch" || branchTicketKeys(input.branch).includes(input.key)) {
    return links.map((link) => link === existing ? { ...link, source: "branch-dismissed", snapshot: null, syncError: null } : link);
  }
  return links.filter((link) => link !== existing);
}

export function syncThreadTicketLinks(
  links: Links,
  input: { readonly key: ThreadTicketKey; readonly observedAt: string; readonly result: SyncResult },
): Links {
  const existing = links.find((link) => link.key === input.key);
  if (existing === undefined || existing.source === "branch-dismissed") return links;
  if (existing.snapshot !== null && Date.parse(input.observedAt) < Date.parse(existing.snapshot.syncedAt)) return links;
  const { result } = input;
  if (result.type === "snapshot") {
    if (existing.syncError === null && existing.snapshot !== null && threadTicketSnapshotsEqual(existing.snapshot, result.snapshot)) return links;
    return links.map((link) => link === existing ? { ...link, snapshot: result.snapshot, syncError: null } : link);
  }
  if (existing.syncError === result.syncError) return links;
  return links.map((link) => link === existing ? { ...link, syncError: result.syncError } : link);
}

export function setThreadPriorityValue(
  priority: ThreadPriority,
  input: { readonly source: "user" | "agent"; readonly priority: PriorityRef | null },
): ThreadPriority {
  const current = priority[input.source];
  const next = input.priority;
  const same = current === null || next === null ? current === next : current.id === next.id && current.name === next.name;
  return same ? priority : { ...priority, [input.source]: next };
}
```

(`Date.parse` rather than string comparison because `IsoDateTime` is a plain `Schema.String`.)

- [ ] **Step 4: Verify.** Test command → PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): thread ticket and priority reducers"`

---

### Task 4: Orchestrator wiring

**Files:**
- Modify: `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/relay/AgentAwarenessRelay.ts`,
  `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts`, `apps/server/src/telemetry/FeatureUsage.ts`
- Test: `apps/server/src/orchestration-v2/runtimeLayer.test.ts`

**Interfaces:**
- Consumes: Task 3 reducers; Task 2 command/event types.
- Produces: the four command types dispatchable via `OrchestratorV2.dispatch`, emitting
  `thread.ticket-links-updated` (link, unlink, sync) or `thread.priority-updated` (priority) with
  the full `OrchestrationV2AppThread` payload, or nothing when unchanged.

- [ ] **Step 1: Write the failing integration test.** Extend the lifecycle `it.effect` in
  `runtimeLayer.test.ts` directly after the tag loop and its `updatedAt` assertion (~L2650), using
  the same `shellOf`, `threadId`, `TestClock.adjust("1 minute")` pattern. Dispatch in order and
  assert on `(yield* orchestrator.dispatch(cmd)).storedEvents` and the shell:

| Step | Command | Expect |
| --- | --- | --- |
| link | `thread.ticket.link` `PROJ-1`, source `manual` | 1 stored event, type `thread.ticket-links-updated`; shell `ticketLinks[0].key === "PROJ-1"` |
| relink | same again (new commandId) | `storedEvents.length === 0` |
| sync | `thread.ticket-link.sync` `PROJ-1`, snapshot `makeTicketSnapshot()`, `observedAt` = its `syncedAt` | 1 event; shell snapshot title `"Fix login"` |
| sync-equal | same data, `syncedAt`/`observedAt` one minute later | 0 events (Review Focus 4) |
| priority | `thread.priority.set` `user`, `{ id: "2", name: "High" }` | 1 event, type `thread.priority-updated`; shell `priority.user.name === "High"` |
| priority-same | same | 0 events |
| unlink | `thread.ticket.unlink` `PROJ-1` | 1 event; shell `ticketLinks` empty |

  After the table: the shell `updatedAt` equals the value read before the first ticket step
  (same assertion style as tags). Later in the same test, after the existing archive step, add one
  `thread.priority.set` (`agent`, Low) that succeeds on the archived thread (Review Focus 5).

- [ ] **Step 2: Run and see it fail.** `vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts -t "applies lifecycle commands idempotently"` → FAIL (typecheck/unknown command). The test lives in `it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", …)` (~L2500); its thread's branch is `"feature/v2"`, so the `unlink` row removes the link (no tombstone).

- [ ] **Step 3: Route the commands.** In `Orchestrator.ts` add `"thread.ticket.link"`,
  `"thread.ticket.unlink"`, `"thread.ticket-link.sync"`, `"thread.priority.set"` to:
  `commandThreadId` (~L585, the group returning `command.threadId`), the `dispatchThreadMutation`
  `Extract` type union (~L3504), and the top-level dispatch switch group that calls
  `dispatchThreadMutation` (~L13690). Do **not** add them to the archived-thread guard list
  (~L3660). No other guard.

- [ ] **Step 4: Reducer cases** inside `const updatedThread = (() => { switch … })()` (~L3974),
  next to `thread.tag.set`. These never touch `updatedAt` (the spread keeps it):

```ts
case "thread.ticket.link":
case "thread.ticket.unlink":
case "thread.ticket-link.sync": {
  const links = thread.ticketLinks ?? [];
  const ticketLinks =
    command.type === "thread.ticket.link"
      ? linkThreadTicketLinks(links, { key: command.key, url: command.url ?? null, source: command.source, linkedAt: DateTime.formatIso(now) })
      : command.type === "thread.ticket.unlink"
        ? unlinkThreadTicketLinks(links, { key: command.key, branch: thread.branch })
        : syncThreadTicketLinks(links, command);
  return ticketLinks === links ? thread : { ...thread, ticketLinks };
}
case "thread.priority.set": {
  const current = thread.priority ?? EMPTY_THREAD_PRIORITY;
  const priority = setThreadPriorityValue(current, command);
  return priority === current ? thread : { ...thread, priority };
}
```

- [ ] **Step 5: No event on no-op, and event types.** Immediately after the
  `thread.pull-request-link.sync` early-return block (~L4434), add:

```ts
if (
  (command.type === "thread.ticket.link" ||
    command.type === "thread.ticket.unlink" ||
    command.type === "thread.ticket-link.sync" ||
    command.type === "thread.priority.set") &&
  updatedThread === thread
) {
  return;
}
```

  and in the `eventType` switch: the three ticket commands → `"thread.ticket-links-updated" as const`,
  `thread.priority.set` → `"thread.priority-updated" as const`. (Other mutations still emit on
  no-op as today; this plan does not change them.)

- [ ] **Step 6: Exhaustive switches elsewhere.** `AgentAwarenessRelay.ts`: add both events to the
  group containing `"thread.tags-updated"` (~L117). `OrchestratorScenario.ts` `commandThreadIds`:
  the three client commands return `[command.threadId]`. `FeatureUsage.ts` `COMMAND_FEATURES`:
  `"thread.ticket.link": (command) => use("thread.ticket.link", command.source)` and
  `"thread.priority.set": (command) => use("thread.priority.set", command.source)` (closed enums
  only, per the file's privacy rule). Run `vp run t3#typecheck` and fix any other exhaustive
  switch it reports the same way (group with the `tags` equivalent).

- [ ] **Step 7: Verify.** The lifecycle test → PASS; `vp test run apps/server/src/orchestration-v2/threadTicketReducer.test.ts apps/server/src/telemetry/FeatureUsage.test.ts` → PASS.

- [ ] **Step 8: Commit.** `git commit -m "feat(server): orchestrate thread ticket and priority commands"`

---

### Task 5: `ProjectionStore` application and shells

**Files:**
- Modify: `apps/server/src/orchestration-v2/ProjectionStore.ts`
- Test: `apps/server/src/orchestration-v2/ProjectionStore.test.ts`

**Interfaces:**
- Produces: both events persisted in `orchestration_v2_projection_threads.payload_json` without
  changing `updated_at`; `OrchestrationV2ThreadShell.ticketLinks` / `.priority` filled by every
  shell builder (P3's `getThreadsWithTicketLinks` reads `$.ticketLinks` from the same payload).

- [ ] **Step 1: Write the failing test.** Extend `backgroundThreadUpdatesKeepTimestamp` (~L1740):
  after the `active-reordered` apply, apply `thread.ticket-links-updated` with
  `{ ...reordered.thread, ticketLinks: [makeTicketLink()] }` at `createdAt + 60 min`, then
  `thread.priority-updated` with `priority: { user: { id: "2", name: "High" }, agent: null }` at
  `+65 min`. After each, `readActivity` (all four reads keep `createdAt`) and assert the field on
  `store.getThreadShell(threadId)`, on the `getShellSnapshot()` row (both go through
  `shellFromState`), and on `ProjectionStore.threadShellFromProjection(projection)` (the in-memory
  builder, compared the same way as the `latestTokenUsage` parity test ~L4704), so both builders
  are proven.

- [ ] **Step 2: Run and see it fail.** `vp test run apps/server/src/orchestration-v2/ProjectionStore.test.ts -t "keeps background thread updates out of updatedAt"` → FAIL.

- [ ] **Step 3: Implement.** Add both event types to:
  1. `applyToProjection`'s group with `thread.active-reordered` / `thread.tags-updated` /
     `thread.pull-request-synced` (~L874) that sets `updatedAt: event.payload.updatedAt`.
  2. `apply`'s thread-payload case list that writes the row (~L2114).
  3. The "not a thread-payload event" exclusion condition (~L2932), so `updated_at` is not
     overwritten with `occurredAt`.
  4. Both shell builders, `threadShellFromProjection` (~L1557) and `shellFromState` (~L1967),
     beside the `tags` spread, using the same omit-when-empty style to keep shell payloads small:
     `...(thread.ticketLinks?.length ? { ticketLinks: thread.ticketLinks } : {})` and
     `...(thread.priority && (thread.priority.user !== null || thread.priority.agent !== null) ? { priority: thread.priority } : {})`.

- [ ] **Step 4: Verify.** Test → PASS; `vp run t3#typecheck` → clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): project thread ticket links and priority"`

---

### Task 6: Capability, `ThreadTicketService`, layer wiring

**Files:**
- Modify: `apps/server/src/environment/ServerEnvironment.ts` (`threadTickets: true` beside
  `threadActiveReorder: true`, ~L257), `ServerEnvironment.test.ts` (~L246: add
  `expect(second.capabilities.threadTickets).toBe(true)`), `apps/server/src/server.ts`
- Create: `apps/server/src/orchestration-v2/ThreadTicketService.ts`
- Test: `apps/server/src/orchestration-v2/runtimeLayer.test.ts` (new `it.effect`, see Step 1)

**Interfaces (§6.4, exact):**
- `export class ThreadTicketService extends Context.Service<ThreadTicketService, ThreadTicketServiceShape>()("t3/orchestration-v2/ThreadTicketService") {}`,
  `export const make`, `export const layer = Layer.effect(ThreadTicketService, make)`.
- Shape: `linkTicket`, `unlinkTicket`, `setThreadPriority` with the §6.4 inputs and results,
  each `Effect.fn("ThreadTicketService.<method>")`.
- Errors (`Schema.TaggedError`, same file):
  `ThreadTicketThreadNotFoundError { threadId: ThreadId }` and
  `ThreadTicketDispatchError { threadId: ThreadId, commandType: Schema.String, cause: Schema.optional(Schema.Defect()) }`
  (`Schema.Defect()` is a call in this Effect version, as in `OrchestratorDispatchError`);
  `export type ThreadTicketError = ThreadTicketThreadNotFoundError | ThreadTicketDispatchError`.
- Dependencies: `Orchestrator.OrchestratorV2`, `ProjectionStore.ProjectionStoreV2`,
  `SecureRandom.SecureRandom` (`effect/crypto/SecureRandom`).

Behaviour per method:
1. `projectionStore.getThread(threadId)`: `ProjectionStoreThreadNotFoundError`, or a thread with
   `deletedAt !== null`, → `ThreadTicketThreadNotFoundError`; any other store error →
   `ThreadTicketDispatchError`.
2. Dispatch the §6.3 command with `commandId: CommandId.make(\`server:thread-ticket:${threadId}:${uuid}\`)`
   (`uuid` from `random.uuidV4()`, the `ThreadPullRequestService` pattern). `linkTicket` passes
   `url` only when non-null (the command field is optional). Orchestrator failures →
   `ThreadTicketDispatchError`, with one exception: an `OrchestratorProjectionError` whose `cause`
   is a `ProjectionStoreThreadNotFoundError` (the thread row vanished after step 1) →
   `ThreadTicketThreadNotFoundError`. A thread deleted between step 1 and the dispatch is rejected
   by `dispatchThreadMutation` as `OrchestratorDispatchError` with a string cause; that rare race
   stays a `ThreadTicketDispatchError` (do not string-match the cause).
3. Return `{ linked | unlinked | changed: result.storedEvents.length > 0 }`. This reads the outcome
   of the commit itself instead of re-deriving it (see deviation 1).

Wiring in `server.ts`: add `Layer.provideMerge(ThreadTicketService.layer.pipe(Layer.provide(ProjectionStoreV2.layer)))`
as the **first** step of `layerRuntimeCoreDependenciesBase`'s `.pipe(…)` (~L688, before
`Layer.provideMerge(layerOrchestrationApplication)`), so it receives `OrchestratorV2` from below
and is visible to the reactors merged into that layer (P3) and to everything built on top,
including `McpHttpServer.layer` (P4). Confirm with `vp run t3#typecheck`; if the MCP layer does
not see it, P4 provides it there (§9).

- [ ] **Step 1: Write the failing test** as a new `it.effect("ThreadTicketService reports changes and maps missing threads", …)`
  inside `it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", …)` in `runtimeLayer.test.ts`.
  `layerTest` is a module-private const of that test file, so a separate
  `ThreadTicketService.test.ts` cannot reuse it. `layerTest` already outputs `OrchestratorV2` and
  `ProjectionStoreV2` but provides `SecureRandom` only internally, so wrap the body in
  `Effect.provide(ThreadTicketService.layer.pipe(Layer.provide(NodeCrypto.layer)))`. Seed a project
  and `thread.create` a thread the way the lifecycle test does (unique ids, `branch: null`):

| Call | Expect |
| --- | --- |
| `linkTicket({ threadId, key: "PROJ-1", url: null, source: "agent" })` | `{ linked: true }` |
| same again | `{ linked: false }` |
| `setThreadPriority({ threadId, source: "agent", priority: Low })` twice | `{ changed: true }`, then `{ changed: false }` |
| `unlinkTicket({ threadId, key: "PROJ-1" })` | `{ unlinked: true }` |
| `linkTicket` with an unknown `ThreadId` | fails with `ThreadTicketThreadNotFoundError` |
| `linkTicket` after `thread.delete` of the thread | fails with `ThreadTicketThreadNotFoundError` |

- [ ] **Step 2: Run and see it fail.** `vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts -t "ThreadTicketService"` → FAIL.

- [ ] **Step 3: Implement** the service, capability flag and wiring.

- [ ] **Step 4: Verify.** The service test (Step 2 command) and `vp test run apps/server/src/environment/ServerEnvironment.test.ts` → PASS; `vp run t3#typecheck` → clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): ThreadTicketService and threadTickets capability"`

---

### Task 7: Client runtime

**Files:**
- Modify: `packages/client-runtime/src/state/models.ts`, `state/orchestrationV2Projection.ts`,
  `state/orchestrationV2Projection.test.ts`, `operations/commands.ts`, `state/threadCommands.ts`

**Interfaces (§6.2, §6.5, exact names):**
- `EnvironmentThreadShell`: `readonly ticketLinks: ReadonlyArray<ThreadTicketLink>;` and
  `readonly priority: ThreadPriority;`. `presentThreadShell` (~L267) sets
  `ticketLinks: thread.ticketLinks ?? []` and `priority: thread.priority ?? EMPTY_THREAD_PRIORITY`.
  `presentThreadShell` is the only builder (see deviation 2); `reuseUnchangedThreadShells` already
  compares the whole shell via `Schema.toEquivalence(OrchestrationV2ThreadShell)` and needs no
  change.
- `operations/commands.ts`: `LinkThreadTicketInput`, `UnlinkThreadTicketInput`,
  `SetThreadPriorityInput` (the §6.5 `Omit<Extract<…>> & CommandMetadata` types) and
  `linkThreadTicket`, `unlinkThreadTicket`, `setThreadPriority`, each
  `Effect.fn("EnvironmentCommands.<name>")` doing `dispatch({ ...input, type, commandId: yield* allocateCommandId(input) })`
  exactly like `linkThreadPullRequest`.
- `threadCommands.ts` `createThreadEnvironmentAtoms` `commands`: `linkTicket`, `unlinkTicket`,
  `setPriority` via `createEnvironmentCommand(runtime, { label, execute, scheduler, concurrency })`
  with labels `environment-data:commands:thread:link-ticket`, `…:unlink-ticket`,
  `…:set-priority`. P6 reaches them as `threadEnvironment.linkTicket` etc. in
  `apps/web/src/state/threads.ts` / `apps/mobile/src/state/threads.ts` with no further change.

- [ ] **Step 1: Write the failing test** in `orchestrationV2Projection.test.ts`, one `it`
  ("ticket and priority events are not activity") looping over both event types: from
  `emptyProjection`, apply an event whose payload has the new field set and
  `updatedAt` = a later time; expect `next.thread.ticketLinks` / `.priority` updated and
  `next.updatedAt` equal to `emptyProjection.updatedAt`.

- [ ] **Step 2: Run and see it fail.** `vp test run packages/client-runtime/src/state/orchestrationV2Projection.test.ts -t "not activity"` → FAIL.

- [ ] **Step 3: Implement.** In `applyOrchestrationV2ProjectionEvent`, add both events to the
  group `case "thread.visited": case "thread.tags-updated": case "thread.marked-unread":`
  (~L297) that returns `{ ...projection, thread: event.payload }`, and widen its comment to
  `// Visited tracking, tags, ticket links and priority are not activity: skip the updatedAt bump.`
  Then the model fields and the commands above.

- [ ] **Step 4: Verify.** Test → PASS. `vp run @t3tools/client-runtime#typecheck`,
  `vp run @t3tools/web#typecheck`, `vp run @t3tools/mobile#typecheck` → clean (fix any test
  fixture that builds an `EnvironmentThreadShell` literal by adding the two fields).

- [ ] **Step 5: Commit.** `git commit -m "feat(client-runtime): thread ticket links, priority and commands"`

---

### Task 8: Final checks and handoff

- [ ] `vp run check:changed` → passes (format, lint incl. `t3code/no-low-value-comments`, knip,
  affected typechecks, tests beside changes).
- [ ] Independent review (§8, user rule): a fresh-context reviewer (not the implementer) reviews
  the full P1 diff against this plan, the contract §6.1 to §6.5 and the spec, with emphasis on the
  Review Focus list and the exact-code sections. Fix or justify every finding; report them at
  handoff.
- [ ] Merge forward per §5: from the clean integration worktree,
  `git merge --no-ff feat/thread-priority-p1 -m "merge: P1"`.

---

## Implementation Location
- **Branch:** feat/thread-priority-p1
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p1
- **Base branch:** feat/thread-priority

Create it with the `git-tools:worktree` skill (equivalent `git worktree add -b feat/thread-priority-p1 /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p1 feat/thread-priority` from `/home/lima/workspace/t3code`); then follow AGENTS.md "Dev servers" for `vp i` (wait on `.t3/setup-running`; run `vp i` only if no marker appears). The first commit (Task 1) is the P1-contract milestone, merged forward by sha before the rest.

## Testing Strategy

- **Hermetic (the proof for this plan):**
  - Contracts: helper tables (`threadTicket.test.ts`), decode leniency, client-union rejection of
    `thread.ticket-link.sync`, Json event decode (`orchestrationV2.test.ts`).
  - Server, lowest failing layer first: pure reducer tables (`threadTicketReducer.test.ts`) carry
    every semantic row; one integration pass through the real Orchestrator, event sink, in-memory
    SQLite projection and shell snapshot (`runtimeLayer.test.ts` lifecycle test) proves routing,
    zero events on no-op, event types and unchanged `updatedAt`; `ProjectionStore.test.ts` proves
    persistence, unchanged `updated_at`, and the fields on both shell builders (`shellFromState`
    via the SQL reads, `threadShellFromProjection` in memory); a second `runtimeLayer.test.ts`
    case proves the `ThreadTicketService` booleans and error mapping that P3/P4 rely on, on the
    real runtime; `ServerEnvironment.test.ts` the capability.
  - Client: `orchestrationV2Projection.test.ts` proves no `updatedAt` bump.
  - Not tested (AGENTS.md "leave out"): `presentThreadShell` `?? []` defaults, the client command
    wrappers and atoms (callback wiring), FeatureUsage mapping rows.
  - Tests use `it.effect` with `TestClock`, no sleeps or polling (AGENTS.md).
  - Iterate with `vp test run <files>`; typecheck `@t3tools/contracts`, `t3`,
    `@t3tools/client-runtime`, `@t3tools/web`, `@t3tools/mobile`; finish with `vp run check:changed`.
- **End-to-end: deferred to P7, with this reason.** P1 adds no visible surface and no caller:
  nothing in any client or agent dispatches these commands until P4 (MCP) and P6 (UI) land, and
  there is no CLI that dispatches orchestration commands. The transport (`orchestration.dispatchCommand`)
  is unchanged. The `runtimeLayer.test.ts` pass already runs the real server pipeline minus
  the socket. P7 runs the whole chain (link, sync, priority, unlink, dismissed branch link) against
  a real worktree dev server and Jira.
- **Visual:** none; P1 renders nothing.

## Open questions / spec deviations

1. **`ThreadTicketService` derives its boolean from the commit, not a pre-check (contract §6.4).**
   Context: §6.4 says each method "computes whether the reducer would change it (shared pure
   functions with the reducer)" before dispatching. Reading the thread, predicting, then
   dispatching can disagree when another command lands in between. `OrchestratorV2.dispatch`
   returns `storedEvents`, and these commands emit exactly one event when they change something
   and none otherwise (Task 4 Step 5). Options: (a) pre-compute with the shared reducers; (b)
   `storedEvents.length > 0`. Recommendation: (b), implemented. The public signature and meaning
   are unchanged, so P3 and P4 are unaffected. The reducers stay pure and exported in
   `threadTicketReducer.ts` for anyone who needs to predict.
2. **Contract §1 lists more `EnvironmentThreadShell` builders than exist.** Context: §1 names
   `threadExecution.ts` (~L332), `threadSearch.ts` (~L264), `shell.ts`/`shellReducer.ts` as places
   that build an `EnvironmentThreadShell`. At `ddec2d528a` they only read `pullRequests`;
   `presentThreadShell` in `models.ts` is the only builder (mobile `use-thread-selection.ts` and
   `pending-thread-creation.ts` go through it), and `shellReducer`'s equivalence covers new
   shell fields automatically. Recommendation: change only `models.ts`; the coherence pass may
   correct §1.
3. **Exact reducer code lives in a new `threadTicketReducer.ts`, not inline in `Orchestrator.ts`
   (contract §1 "Orchestrator.ts … Exact code for").** Context: `Orchestrator.ts` is 14.8k lines
   and its reducer is a closure that cannot be table-tested alone. The Orchestrator still owns
   routing, no-op suppression and event selection; the semantics live in four pure functions with
   their own tables (AGENTS.md "Test at one layer: the lowest one"). Recommendation: as planned.
4. **Extra exhaustive switch not in contract §1: `apps/server/src/relay/AgentAwarenessRelay.ts`.**
   Its event switch (~L117) lists `thread.tags-updated` and must list both new events. Covered in
   Task 4 Step 6. No other plan touches it.
5. **Scope text asks for "ws RPC methods", "CLIENT_GUARDED_RPC_SCOPES + permission tests" and the
   spec says to add client commands to `CLIENT_GUARDED_RPC_SCOPES`; this plan adds none (contract
   Q1).** Context: every thread mutation is an orchestration command over
   `orchestration.dispatchCommand`, which the server already guards with
   `AuthOrchestrationOperateScope` in `RPC_REQUIRED_SCOPES`
   (`apps/server/src/auth/RpcAuthorization.ts` ~L42). It has no entry in the client-side
   `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts`), and neither do
   the existing PR/tag/pin commands; that map is keyed by ws method, not command type, so a
   per-command entry is not expressible there. The permission
   coverage is Task 2's decode test that clients cannot send `thread.ticket-link.sync`
   (`OrchestrationV2InternalCommand` is "Excluded from dispatchCommand so only the server can send
   these", `orchestrationV2.ts` ~L3470). Note: the
   PR sync commands this design is "patterned on" (`thread.pull-request-link.sync`,
   `thread.pull-request.sync`) are in fact in the **client** union today; putting the ticket sync
   in `OrchestrationV2InternalCommand` (D7) is deliberately stricter. Recommendation: follow Q1.
6. **Stale-guard gap after an `unreachable` result (contract §6.3, minor).** Context: the guard
   compares `observedAt` to `snapshot.syncedAt`. An `unreachable` result keeps the old snapshot
   (and its old `syncedAt`), so a snapshot read *before* the unreachable one but committed after
   it would pass the guard and clear `syncError`. It needs two overlapping reads of one key;
   P3's reactor runs one sweep at a time (`makeDrainableWorker`), so it cannot happen there.
   Options: (a) accept; (b) add `syncErrorAt` to the link. Recommendation: (a); revisit only if
   P3 introduces concurrent fetches.
7. **`snapshot.syncedAt` means "when this data was last read *as changed*", not "last checked".**
   Context: an equal sync writes nothing (anti-goal), so `syncedAt` stays at the first read of the
   current data. P6 must not show it as freshness ("synced 2 h ago" would mislead); connection
   health comes from `jiraStatus` (P2). Recommendation: accept; P6 and the coherence pass note it.
8. **Forks and new threads start with no ticket links or priority.** Context: thread creation
   (`Orchestrator.ts` ~L3220) builds the thread from scratch, and the spec is silent on forks.
   A fork on the same branch gets the branch link back through P3's detection on
   `thread.created`. Options: copy links/priority on fork, or not. Recommendation: do not copy
   (YAGNI); revisit if users ask.
9. **`StoredThreadTicketLinks` drops the whole array when one element is unreadable (contract
   §6.1, D1).** Context: following `StoredThreadTags`, the lenient form is
   `Schema.Array(ThreadTicketLink)` + `catchDecoding -> []`. A thread written by a newer build with
   one link this build cannot read (for example a new `source` literal) therefore reads as having
   no links at all, and if this server then writes that thread (any thread event carries the whole
   payload), every link is lost, including `branch-dismissed` tombstones, so branch detection could
   re-add a ticket the user removed. Options: (a) as contracted; (b) per-element leniency (decode
   each element, drop only the unreadable ones). Recommendation: (a) for P1, because it is the
   contract, matches `StoredThreadTags`, and only bites on a downgrade or a mixed-version write,
   which D9 already accepts; the coherence pass may switch to (b), which changes only this schema
   and the Task 1 decode row.
