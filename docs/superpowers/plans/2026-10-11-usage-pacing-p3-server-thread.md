# Usage pacing P3: per-thread token usage on the shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every thread shell carries the newest top-level token usage of its active provider thread (`latestTokenUsage`), and Claude's top-level usage reports carry the request identity and a carried-forward prompt-cache TTL, so the sidebar can draw the context ring and cache dot (P5) without loading thread detail.

**Architecture:** (a) Two optional contract fields (`requestIdentity` on `OrchestrationV2ProviderTurnTokenUsage`, `latestTokenUsage` on `OrchestrationV2ThreadShell`) and a non-optional mirror on the client-runtime `EnvironmentThreadShell`. (b) `ClaudeAdapterV2` stamps the identity and remembers the last TTL per provider thread in adapter memory. (c) `ProjectionStore` derives `latestTokenUsage` at read time from the persisted `orchestration_v2_projection_provider_turns` rows, with one correlated subquery in the row-based shell query and one pure helper in the in-memory shell builder; the live shell stream already re-reads a thread's shell after every committed thread event, so the field rides the existing push path with no new stream code.

**Tech Stack:** TypeScript, Effect v4 (`effect/Schema`, `effect/sql`), SQLite (node sqlite client), vitest via `vp test run`, `@effect/vitest`.

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` section 5.3 (plus 3.3 "No data" / "Unknown cache state", 4.5, 6, 7 item 4). Shared contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` sections 1 "P3-server-thread", 6.3, 7, 9 (items C4, C5, D2). Read both first; this plan conforms to them except where "Open questions / spec deviations" says otherwise.

## Global Constraints

- Contract shapes are index 6.3 verbatim: `OrchestrationV2ProviderTurnRequestIdentity = { model?: TrimmedNonEmptyString, effort?: TrimmedNonEmptyString, fastMode?: Boolean }`; `requestIdentity: Schema.optional(...)` on `OrchestrationV2ProviderTurnTokenUsage` before `updatedAt`; `latestTokenUsage: Schema.optional(Schema.NullOr(OrchestrationV2ProviderTurnTokenUsage))` on `OrchestrationV2ThreadShell` right after `goal`.
- Client runtime: `EnvironmentThreadShell.latestTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null` right after `goal`; `presentThreadShell` sets `latestTokenUsage: thread.latestTokenUsage ?? null` right after `goal`.
- `latestTokenUsage` semantics: among provider turns whose `providerThreadId` equals the shell's `activeProviderThreadId`, the `tokenUsage` with the greatest `Date.parse(updatedAt)`; ties go to the higher `ordinal`; `null` when `activeProviderThreadId` is null or no such turn has `tokenUsage`. Turns of any other provider thread never count.
- `requestIdentity` is filled only on Claude's top-level assistant usage report (`parent_tool_use_id === null`, `model !== "<synthetic>"`). Raw selection values, no default resolution (index 9 C5). The compaction report (`compact_boundary`) gets neither identity nor carried TTL (index 9 D2).
- TTL carry-forward: on that same path only, a report whose response wrote no cache (`claudePromptCacheTtlMs` returns `undefined`) gets the last TTL observed on the same provider thread.
- Shell pushes: at most one per `tokenUsage` change of the active provider thread, by riding the existing per-thread shell refetch in `ws.ts` (`toShellStream`: 50 ms `groupedWithin`, per-thread coalescing, `skipUnchangedThreadShells`). No new stream, publisher or coalescer.
- No new tables, migrations, indexes, config keys, env vars or log fields (index 6.7).
- File ownership (index 7): this plan alone edits `packages/contracts/src/orchestrationV2.ts` (+ `orchestrationV2.test.ts`), `packages/client-runtime/src/state/models.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`. No `apps/web` changes.
- Repo rules (AGENTS.md): targeted checks only, never repo-wide (`vp check`, `vp run -r ...` are forbidden); tests assert behaviour; no sleeps or polling waits in new tests (drain `OrchestrationEffectWorkerV2`, await the stored event, or take from the adapter harness's `terminalReceipts` queue; do not add new `awaitUntil` polling loops); `exactOptionalPropertyTypes` is on (build optional keys with conditional spreads, never assign `undefined`); inferred types over annotations; comments describe use; Conventional Commit titles; do not start a dev server (P6 owns end-to-end).
- Commands: `vp` is not on PATH. Prefix every command with `PATH="$PWD/node_modules/.bin:$PATH"` (written as plain `vp` below), run from the P3 worktree root. The user's shell wraps `cd` via fnm and returns 127: use `builtin cd <dir>; <cmd>` with `;`, never `cd ... && ...`.

## Review Focus

Failure modes the spec implies but that a straightforward implementation would not exercise; each has its test in the bracketed task.

1. **A blank effort or model value reaching the wire.** `TrimmedNonEmptyString` rejects blank strings on encode, and the provider-turn payload is schema-encoded when it is projected, so a blank `effort: " "` option would fail the whole event write and lose the turn's events. Expected: blank values are omitted, the report still lands. [Task 4, `claudeRequestIdentity` table rows 7 and 9]
2. **The SQL shell and the in-memory shell disagreeing on "newest".** An older turn re-reporting later, two reports with the same `updatedAt`, and a terminal update without `tokenUsage` must give the same answer from `getShellSnapshot`, `getThreadShell` and `threadShellFromProjection`. [Task 2, steps 5-7 of the sequence table]
3. **A handoff showing the previous provider's usage.** After `activeProviderThreadId` moves to a new provider thread with no reports yet, the shell must say `null`, not the old provider's context. [Task 2, sequence step 9]
4. **Snapshot cost on long threads.** The shell snapshot runs the subquery once per thread; it must seek through an index on `orchestration_v2_projection_provider_turns`, never scan the table. [Task 2, query-plan test]
5. **Subagent and workflow usage leaking into the thread's context (the 0.0.45 "1m/1m" symptom).** Subagent assistant frames, `task_progress` and `task_notification` frames carrying `usage.total_tokens` must not produce any `tokenUsage`. [Task 4 harness test, Task 5]
6. **A terminal provider-turn update erasing the shell's usage.** The turn's `completed` update omits `tokenUsage`; `upsertProviderTurn` keeps the stored one, and the shell must keep showing it through the full orchestrator path. [Task 3 integration test]

---

## Implementation Location

- **Branch:** `feat/usage-pacing-p3-server-thread`
- **Worktree:** `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p3-server-thread`
- **Base branch:** `feat/usage-pacing`

Create it (index section 5, from the integration worktree, which is the only place `vp` binaries exist before the child's install):

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git worktree add -b feat/usage-pacing-p3-server-thread /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p3-server-thread feat/usage-pacing
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p3-server-thread; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/node_modules/.bin:$PATH" node scripts/setup-worktree.ts
```

After setup, use the child's own `node_modules/.bin`.

Milestone **P3-contract** = the Task 1 commit (contract fields, client-runtime mirror, their tests, nothing else). Report its SHA once Task 1 verification passes; the orchestrator merges that commit forward (index 5 "Merge a milestone forward"). Tasks 2-6 continue on the same branch. One PR / one merge for the rest of the plan.

## Testing Strategy

- **End-to-end: deferred to P6, not run in this plan.** AGENTS.md: "Subagents do not launch their own dev servers"; the integrated feature gets one end-to-end pass in P6 on the merged `feat/usage-pacing` with real Claude turns. The P6 items this plan feeds: item 3 (sidebar and composer glyphs appear after a turn, the dot is present while warm, switching model or effort removes it), which depends on `latestTokenUsage` reaching the sidebar and on `requestIdentity` using the same vocabulary as `ModelSelection`; item 4 (a subagent/workflow turn keeps the ring at the real context size, no 1m/1m), which depends on Task 5's property holding against the real CLI; item 5 (server restart: the shell's `latestTokenUsage` comes back from persisted rows immediately, with no backfill). P6 can read the field on the wire from the shell stream or `GET` shell snapshot.
- **Closest autonomous substitute run here (Task 3):** a full-orchestrator integration test (`ProviderSwitch.integration.test.ts` harness: real `Orchestrator`, `EventSink`, `ProjectionStore`, `OrchestrationEffectWorkerV2`, in-memory SQLite, scripted provider adapter) that dispatches real `message.dispatch` commands, drains the worker, and reads `orchestrator.getThreadShell` (the exact read `ws.ts` performs for every live shell push) and `orchestrator.getShellSnapshot` (the read a reconnecting or restarted client hydrates from).
- **Hermetic:**
  - Contracts: decode tests for both fields, including blank identity strings and the JSON shell schema.
  - Client runtime: `presentThreadShell` maps present / `null` / absent.
  - Projection: one sequence test over `apply` + three read paths (SQL snapshot, SQL per-thread, in-memory builder), plus a query-plan assertion. This also covers spec 7's "historical threads": the value is derived at read time from persisted `orchestration_v2_projection_provider_turns` rows, which is exactly what a pre-upgrade thread has, so there is no separate backfill path to test.
  - Live push filter: `skipUnchangedThreadShells` sends a shell whose `latestTokenUsage` changed and drops one where only `updatedAt` moved.
  - Adapter: pure tables for `claudeRequestIdentity` and the extended `claudeProviderTurnTokenUsage`; scripted-SDK harness tests for identity, carry-forward across turns, subagent exclusion and the compaction report; the task-progress/notification regression test.

## File Structure

| File                                                                          | Action | Responsibility                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/orchestrationV2.ts`                                   | modify | `OrchestrationV2ProviderTurnRequestIdentity`; `requestIdentity` field (struct at line ~1057); `latestTokenUsage` field (shell struct at line ~1927, after `goal` at ~1985)      |
| `packages/contracts/src/orchestrationV2.test.ts`                              | modify | decode tests, in `describe("orchestration V2 contracts")` next to "decodes historical thread shell JSON..." (line ~1275)                                                        |
| `packages/client-runtime/src/state/models.ts`                                 | modify | `EnvironmentThreadShell.latestTokenUsage` (after `goal`, line ~117); `presentThreadShell` (after `goal: thread.goal ?? null`, line ~263)                                        |
| `packages/client-runtime/src/state/entities.test.ts`                          | modify | one test in `describe("V2 client presentation")`                                                                                                                                |
| `apps/server/src/orchestration-v2/ProjectionStore.ts`                         | modify | `latestTokenUsageForShell` helper; `ShellThreadRow`, `ShellThreadState`, `selectShellThreadRows`, `shellThreadStateFromRow`, `shellFromState`, `threadShellFromProjection`      |
| `apps/server/src/orchestration-v2/ProjectionStore.test.ts`                    | modify | sequence test and query-plan test, after "shows the native goal of the active provider thread on the shell" (line ~1939)                                                        |
| `apps/server/src/orchestration-v2/ShellStream.test.ts`                        | modify | one case in `describe("skipUnchangedThreadShells")` (line ~547)                                                                                                                 |
| `apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts` | modify | one full-orchestrator test                                                                                                                                                      |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`                | modify | `claudeRequestIdentity`; 4th parameter of `claudeProviderTurnTokenUsage` (line ~192); `promptCacheTtlMsByProviderThread` map; call site (line ~6935-6967)                       |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`           | modify | pure tables in `describe("ClaudeAdapterV2 context usage")` (line ~883); harness tests at the end of `describe("ClaudeAdapterV2 background wake turns")` (closes at line ~13479) |

Files this plan must not touch: anything under `apps/web` or `apps/mobile`, `packages/shared`, `packages/contracts/src/settings.ts`, `packages/contracts/src/providerUsageLimits.ts`, `apps/server/src/provider/claudeUsageLimits.ts`, `ws.ts`, `ShellStream.ts`, migrations.

---

## Task 1: Contract fields and client-runtime mirror (milestone P3-contract)

**Files:**

- Modify: `packages/contracts/src/orchestrationV2.ts`
- Modify: `packages/client-runtime/src/state/models.ts`
- Test: `packages/contracts/src/orchestrationV2.test.ts`, `packages/client-runtime/src/state/entities.test.ts`

**Interfaces:**

- Produces (index 6.3, verbatim): `OrchestrationV2ProviderTurnRequestIdentity` (schema + type, exported from `@t3tools/contracts` through the existing `export *` of `orchestrationV2.ts`); `OrchestrationV2ProviderTurnTokenUsage["requestIdentity"]`; `OrchestrationV2ThreadShell["latestTokenUsage"]: OrchestrationV2ProviderTurnTokenUsage | null | undefined`; `EnvironmentThreadShell["latestTokenUsage"]: OrchestrationV2ProviderTurnTokenUsage | null` (and therefore `SidebarThreadSummary["latestTokenUsage"]`, an alias in `apps/web/src/types.ts` line ~125).
- Consumed later by: Task 2 (shell field), Task 4 (identity type), P5 (both).

- [ ] **Step 1: Write the failing contract tests.** In `orchestrationV2.test.ts`, add `const decodeTokenUsage = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnTokenUsage);` and `const decodeThreadShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);` next to `decodeOrchestrationV2ThreadShell` (line ~130), importing both schemas. Inside `describe("orchestration V2 contracts")`, after "decodes historical thread shell JSON without pendingBackgroundTasks as empty roster", add `it("carries request identity on token usage and the latest token usage on the shell")`. Reuse the historical shell object from the neighbouring test as `baseShell` (extract it to a `const` inside the new test; do not change the old test). `usage` below = `{ usedTokens: 380000, maxTokens: 1000000, promptCacheTtlMs: 3600000, requestIdentity: { model: "claude-opus-5-5", effort: "high", fastMode: false }, updatedAt: "2026-10-11T10:00:00.000Z" }`.

| #   | Input                                                                                                                                            | Expected                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | `decodeTokenUsage({ usedTokens: 10, updatedAt: "2026-10-11T10:00:00.000Z" })`                                                                    | result has no `requestIdentity` key (`"requestIdentity" in result === false`)     |
| 2   | `decodeTokenUsage(usage)`                                                                                                                        | deep-equals `usage`                                                               |
| 3   | `decodeTokenUsage({ ...usage, requestIdentity: {} })`                                                                                            | `requestIdentity` deep-equals `{}`                                                |
| 4   | `decodeTokenUsage({ ...usage, requestIdentity: { model: " claude-opus-5-5 " } })`                                                                | `requestIdentity` deep-equals `{ model: "claude-opus-5-5" }` (trimmed)            |
| 5   | `decodeTokenUsage({ ...usage, requestIdentity: { effort: "  " } })`                                                                              | throws                                                                            |
| 6   | `decodeOrchestrationV2ThreadShell(baseShell)`                                                                                                    | `shell.latestTokenUsage` is `undefined`                                           |
| 7   | `decodeOrchestrationV2ThreadShell({ ...baseShell, latestTokenUsage: null })`                                                                     | `shell.latestTokenUsage` is `null`                                                |
| 8   | `decodeOrchestrationV2ThreadShell({ ...baseShell, latestTokenUsage: usage })`                                                                    | `shell.latestTokenUsage` deep-equals `usage`                                      |
| 9   | `decodeThreadShellJson({ ...baseShell, createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", latestTokenUsage: usage })` | `latestTokenUsage` deep-equals `usage` (the JSON shell schema inherits the field) |

`baseShell` in the existing test uses `now` (a `DateTime.Utc`) for `createdAt` / `updatedAt`; row 9 overrides them with ISO strings because `OrchestrationV2ThreadShellJson` decodes those from strings.

- [ ] **Step 2: Write the failing client-runtime test.** In `entities.test.ts`, `describe("V2 client presentation")`, add `it("presents the active provider thread's latest token usage")`:

| Input                                                                                                                                         | Expected `presentThreadShell(environmentId, input).latestTokenUsage` |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `v2ThreadShell` (fixture has no field)                                                                                                        | `null`                                                               |
| `{ ...v2ThreadShell, latestTokenUsage: null }`                                                                                                | `null`                                                               |
| `{ ...v2ThreadShell, latestTokenUsage: usage }` (same `usage` literal as Step 1, typed via `satisfies OrchestrationV2ProviderTurnTokenUsage`) | the same object (`toBe(usage)`)                                      |

- [ ] **Step 3: Run to verify they fail.**
      `vp test run packages/contracts/src/orchestrationV2.test.ts -t "request identity"` -> rows 2-5, 7-9 fail (fields stripped / no throw).
      `vp test run packages/client-runtime/src/state/entities.test.ts -t "latest token usage"` -> all three rows fail at runtime (`undefined` instead of `null` / `usage`; use `toBeNull()` for the first two so `undefined` does not pass).

- [ ] **Step 4: Implement the contract.** In `orchestrationV2.ts`, directly above `OrchestrationV2ProviderTurnTokenUsage` (line ~1056), add the identity schema, then the two fields, exactly as index 6.3:

```ts
/** What a request targeted, for prompt-cache identity checks. Absent fields are unknown, not mismatches. */
export const OrchestrationV2ProviderTurnRequestIdentity = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2ProviderTurnRequestIdentity =
  typeof OrchestrationV2ProviderTurnRequestIdentity.Type;

// inside OrchestrationV2ProviderTurnTokenUsage, between promptCacheTtlMs and updatedAt:
  /** Claude's top-level reports only: model, effort and fast mode the request ran with. */
  requestIdentity: Schema.optional(OrchestrationV2ProviderTurnRequestIdentity),

// inside OrchestrationV2ThreadShell, immediately after `goal`:
  /** Newest top-level token usage on the active provider thread; omitted by servers that predate it. */
  latestTokenUsage: Schema.optional(Schema.NullOr(OrchestrationV2ProviderTurnTokenUsage)),
```

`TrimmedNonEmptyString` is already imported (line ~36). `OrchestrationV2ThreadShellJson` (`mapFields` with `...fields`, line ~2502) and `OrchestrationV2ProviderTurnJson` inherit the new fields; no edit there.

- [ ] **Step 5: Implement the client-runtime mirror.** In `models.ts`: add `OrchestrationV2ProviderTurnTokenUsage` to the `import type { ... } from "@t3tools/contracts"` list (line ~3); in `EnvironmentThreadShell` right after `readonly goal: ...` add

```ts
  /** Newest top-level token usage on the active provider thread. */
  readonly latestTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null;
```

and in `presentThreadShell` right after `goal: thread.goal ?? null,` add `latestTokenUsage: thread.latestTokenUsage ?? null,`. Every `EnvironmentThreadShell` in web and mobile is built through `presentThreadShell` (verified: no literal constructions in `apps/web/src`, `apps/mobile/src`, `packages/client-runtime/src`), so nothing else changes. If a typecheck in Step 7 still reports a literal `EnvironmentThreadShell` missing the field, add `latestTokenUsage: null` to that literal and nothing else.

- [ ] **Step 6: Run the tests to verify they pass.** The two commands from Step 3, plus the whole files: `vp test run packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/entities.test.ts`. Expected: all pass.

- [ ] **Step 7: Typecheck, lint, format.** `vp run @t3tools/contracts#typecheck`; `vp run @t3tools/client-runtime#typecheck`; `vp run @t3tools/web#typecheck`; `vp run @t3tools/mobile#typecheck` (the mirror field is required on a type both clients consume); `vp run t3#typecheck` (the server must still compile with the optional fields unset). `vp lint packages/contracts/src/orchestrationV2.ts packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/models.ts packages/client-runtime/src/state/entities.test.ts`; `vp fmt` the same four files.

- [ ] **Step 8: Commit (milestone P3-contract) and report the SHA.**

```bash
git add packages/contracts/src/orchestrationV2.ts packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/models.ts packages/client-runtime/src/state/entities.test.ts
git commit -m "feat(contracts): request identity on token usage and latest token usage on thread shells"
```

---

## Task 2: Derive `latestTokenUsage` in the projection read paths

**Files:**

- Modify: `apps/server/src/orchestration-v2/ProjectionStore.ts`
- Test: `apps/server/src/orchestration-v2/ProjectionStore.test.ts`

**Interfaces:**

- Consumes: Task 1's `OrchestrationV2ThreadShell["latestTokenUsage"]` and the `OrchestrationV2ProviderTurnTokenUsage` schema value.
- Produces: `getShellSnapshot`, `readShellSnapshot`, `getThreadShell` (the per-thread read `ws.ts` performs for live pushes, line ~1024) and `threadShellFromProjection` all return `latestTokenUsage` (never `undefined` from this server). Module-private helper `latestTokenUsageForShell` (not exported; knip flags unused exports).

**Design (the code is the decision here).** The value is derived at read time from rows that already exist, never stored on the thread row: no migration, no backfill, and historical threads get it on the first read after upgrade. The live path needs nothing new: `provider-turn.updated` is a persisted thread event, `ws.ts`'s `toShellStream` re-reads `getThreadShell` for every thread with events in each 50 ms batch, and `skipUnchangedThreadShells` already sends a shell whenever any field other than `updatedAt` differs. Before this change those re-reads produced an identical shell and were dropped; now a changed `tokenUsage` makes the shell differ, so exactly one push per change per batch goes out.

- [ ] **Step 1: Write the failing sequence test.** In `ProjectionStore.test.ts`, after "shows the native goal of the active provider thread on the shell", add `it.effect("puts the active provider thread's newest token usage on the shell", ...)` using the `layerTest` the file already provides (look at how the goal test is wrapped and do the same). Setup mirrors the goal test: `thread.created` for `ThreadId.make("thread:latest-usage")` with `activeProviderThreadId: null`, and an `applyProviderThread(suffix, seconds)` helper that applies `provider-thread.updated` with `appThreadId: threadId`, `ownerNodeId: null`, id `provider-thread:latest-usage:<suffix>` (this sets the thread's `activeProviderThreadId`, `ProjectionStore.ts` line ~2236). Add an `applyTurn({ providerThread, turn, ordinal, status, usage })` helper that applies `provider-turn.updated` with `threadId`, `nodeId: NodeId.make("node:latest-usage")`, `driver`, `occurredAt: DateTime.add(now, { seconds })` (the event base requires it; use the same seconds as the usage), and payload `{ id: ProviderTurnId.make("provider-turn:latest-usage:<turn>"), providerThreadId, nodeId, runAttemptId: null, nativeTurnRef: null, ordinal, status, startedAt: now, completedAt: status === "completed" ? now : null, ...(usage === undefined ? {} : { tokenUsage: usage }) }`. Give each event a unique `EventId`.

Define `usage(usedTokens, secondsAfterNow, extra = {})` = `{ usedTokens, maxTokens: 200_000, updatedAt: <ISO of now + seconds>, ...extra }` (ISO via `DateTime.formatIso(DateTime.add(now, { seconds }))`).

Define `readAll` = an Effect returning a tuple of three values: `(yield* projectionStore.getShellSnapshot()).threads.find((t) => t.id === threadId)?.latestTokenUsage`, `(yield* projectionStore.getThreadShell(threadId))?.latestTokenUsage`, `ProjectionStore.threadShellFromProjection(yield* projectionStore.getThreadProjection(threadId)).latestTokenUsage`. After every step, assert all three deep-equal the expected value (one helper `expectLatest(expected)` that does the three `assert.deepEqual`s).

| Step | Event(s) applied                                                                                                                                                    | Expected `latestTokenUsage` (all three reads) |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | none beyond `thread.created`                                                                                                                                        | `null`                                        |
| 2    | `applyProviderThread("first", 0)` (active = first)                                                                                                                  | `null`                                        |
| 3    | turn `t1`, ordinal 1, running, `U1 = usage(40_000, 10)`                                                                                                             | `U1`                                          |
| 4    | turn `t2`, ordinal 2, running, `U2 = usage(55_000, 20, { promptCacheTtlMs: 3_600_000, requestIdentity: { model: "claude-sonnet-4-6", effort: "high" } })`           | `U2` (identity and TTL preserved)             |
| 5    | turn `t2`, ordinal 2, `completed`, no usage                                                                                                                         | `U2` (terminal update keeps stored usage)     |
| 6    | turn `t1`, ordinal 1, running, `U1b = usage(41_000, 30)` (older turn reports later)                                                                                 | `U1b` (report time beats ordinal)             |
| 7    | turn `t3`, ordinal 3, running, `U3 = usage(60_000, 30)` (same `updatedAt` as `U1b`)                                                                                 | `U3` (tie goes to the higher ordinal)         |
| 8    | turn `t9` on provider thread `ProviderThreadId.make("provider-thread:latest-usage:subagent")` (never announced as active), ordinal 1, running, `usage(999_000, 60)` | `U3` (other provider threads never count)     |
| 9    | `applyProviderThread("second", 70)` (handoff: active = second)                                                                                                      | `null`                                        |
| 10   | turn `t4` on `second`, ordinal 1, running, `U4 = usage(5_000, 80)`                                                                                                  | `U4`                                          |

- [ ] **Step 2: Write the failing query-plan test.** Directly after it, `it.effect("seeks the latest token usage through a provider-turn index", ...)`: create one thread with an active provider thread and one turn with usage (reuse the shapes above, new ids), then

```ts
const sql = yield * SqlClient.SqlClient; // already imported by the test file
const { statements, tracer } = traceSqlStatements();
yield * projectionStore.getShellSnapshot().pipe(Effect.withTracer(tracer));
const statement = statements.find((query) => query.includes("AS latest_token_usage_json"));
assert.isDefined(statement);
const plan = (
  yield * sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
).map((row) => row.detail);
```

| Assertion                                                                                                  | Expected |
| ---------------------------------------------------------------------------------------------------------- | -------- |
| some `detail` matches `/^SEARCH turn USING (COVERING )?INDEX orchestration_v2_projection_provider_turns_/` | true     |
| no `detail` starts with `SCAN turn`                                                                        | true     |

(`traceSqlStatements` is defined at the top of the test file, line ~57; the "lastError" test at line ~3393 uses the same EXPLAIN pattern.)

- [ ] **Step 3: Run to verify they fail.** `vp test run apps/server/src/orchestration-v2/ProjectionStore.test.ts -t "token usage"` -> the sequence test fails at step 1 (`undefined` instead of `null`: the field is absent from all three reads); the plan test fails (`statement` undefined).

- [ ] **Step 4: Implement the pure helper.** In `ProjectionStore.ts`, directly below `activeProviderGoalForShell` (line ~1576). Add `type OrchestrationV2ProviderTurnTokenUsage` to the existing `import type { ... } from "@t3tools/contracts"` block (line ~16).

```ts
/**
 * Newest token usage the active provider thread reported: latest `updatedAt`,
 * ties to the higher ordinal. Other provider threads (subagents, the previous
 * provider after a handoff) never count. Mirrors the `latest_token_usage_json`
 * subquery in `selectShellThreadRows`; keep the two in step.
 */
function latestTokenUsageForShell(
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "ordinal" | "tokenUsage">
  >,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ProviderTurnTokenUsage | null {
  if (activeProviderThreadId === null) return null;
  let latest: {
    readonly at: number;
    readonly ordinal: number;
    readonly usage: OrchestrationV2ProviderTurnTokenUsage;
  } | null = null;
  for (const turn of providerTurns) {
    if (turn.providerThreadId !== activeProviderThreadId || turn.tokenUsage === undefined) continue;
    const parsed = Date.parse(turn.tokenUsage.updatedAt);
    // SQLite's julianday() is NULL for an unparseable time and sorts it last.
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (latest === null || at > latest.at || (at === latest.at && turn.ordinal > latest.ordinal)) {
      latest = { at, ordinal: turn.ordinal, usage: turn.tokenUsage };
    }
  }
  return latest?.usage ?? null;
}
```

- [ ] **Step 5: Wire the in-memory builder.** In `threadShellFromProjection` (line ~1400), right after the `goal: activeProviderGoalForShell(...)` property (line ~1524):

```ts
    latestTokenUsage: latestTokenUsageForShell(
      projection.providerTurns,
      projection.thread.activeProviderThreadId,
    ),
```

- [ ] **Step 6: Add the SQL column.** In `ShellThreadRow` (line ~971) add `readonly latest_token_usage_json: string | null;` after `has_actionable_proposed_plan`. In `selectShellThreadRows` (line ~5156), insert this select-list entry immediately after `) AS has_actionable_proposed_plan,` and before the `-- Count per run on the covering ...` comment:

```sql
              (
                -- Mirrors latestTokenUsageForShell: the active provider
                -- thread's newest report, by report time, then turn ordinal.
                SELECT json_extract(turn.payload_json, '$.tokenUsage')
                FROM orchestration_v2_projection_provider_turns turn
                WHERE turn.provider_thread_id = t.active_provider_thread_id
                  AND turn.thread_id = t.thread_id
                  AND json_type(turn.payload_json, '$.tokenUsage') = 'object'
                ORDER BY
                  julianday(json_extract(turn.payload_json, '$.tokenUsage.updatedAt')) DESC,
                  turn.ordinal DESC
                LIMIT 1
              ) AS latest_token_usage_json,
```

Notes for the implementer, all verified against the code:

- `t.active_provider_thread_id` is a real column kept in step with the payload on every thread upsert (line ~1858) and on `provider-thread.updated` (line ~2252). A null column compares unknown, so the subquery returns NULL, matching the helper's `null`.
- `turn.thread_id = t.thread_id` matches the in-memory builder, which only sees the thread's own `projection.providerTurns`.
- `json_extract` of an object returns its JSON text; `julianday()` parses the ISO strings adapters write (`DateTime.formatIso`, e.g. `2026-10-11T10:00:00.123Z`) at sub-millisecond resolution, and NULL sorts last under `DESC`, matching `Date.parse` with NaN as `-Infinity`. `julianday` is already used in this file (line ~3518).
- The existing indexes `orchestration_v2_projection_provider_turns_thread_ordinal_idx (provider_thread_id, ordinal)` and `orchestration_v2_projection_provider_turns_thread_idx (thread_id)` let the planner seek; Step 2 pins that it does.

- [ ] **Step 7: Decode the column into the row-based shell state.** Near the other module-level decoders (line ~1102), add:

```ts
const decodeProviderTurnTokenUsageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnTokenUsageSchema),
);
```

and add `OrchestrationV2ProviderTurnTokenUsage as OrchestrationV2ProviderTurnTokenUsageSchema,` to the value import block from `@t3tools/contracts` (line ~41). In `type ShellThreadState` (line ~1597) add `readonly latestTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null;` right after `goal`. In `shellThreadStateFromRow` (line ~5615), before the `return {`:

```ts
// A row this build cannot decode reads as "no usage" rather than
// failing the whole shell; the sidebar then shows no glyph.
const latestTokenUsage =
  row.latest_token_usage_json === null
    ? null
    : yield *
      decodeProviderTurnTokenUsageJson(row.latest_token_usage_json).pipe(
        Effect.orElseSucceed(() => null),
      );
```

and in the returned object, right after `goal: activeProviderGoalForShell(...)` (line ~5743), add `latestTokenUsage,`. In `shellFromState` (line ~1725), right after `goal: input.state.goal,` add `latestTokenUsage: input.state.latestTokenUsage,`.

`getShellSnapshot`, `readShellSnapshot` and `getThreadShell` all build shells through `selectShellThreadRows` -> `shellThreadStateFromRow` -> `shellFromState`, so these three edits cover every SQL read path. `getSettlementCandidates` has its own query and its own type and is untouched.

- [ ] **Step 8: Run the tests to verify they pass.** `vp test run apps/server/src/orchestration-v2/ProjectionStore.test.ts -t "token usage"` -> both pass. Then the regression neighbours: `vp test run apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/ProviderTurnTokenUsage.test.ts apps/server/src/orchestration-v2/WireProjection.test.ts` -> all pass (several existing tests compare the SQL shell with `threadShellFromProjection`; both now carry the field).

- [ ] **Step 9: Typecheck, lint, format.** `vp run t3#typecheck`; `vp lint apps/server/src/orchestration-v2/ProjectionStore.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts`; `vp fmt` the two files.

- [ ] **Step 10: Commit.**

```bash
git add apps/server/src/orchestration-v2/ProjectionStore.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts
git commit -m "feat(server): thread shells carry the active provider thread's latest token usage"
```

---

## Task 3: Pin the live push path end to end through the orchestrator

No production code is expected to change in this task: Task 2 already makes the live path work. These tests pin it so a later refactor of the shell stream cannot silently drop the field. If either test fails, the failure is a real gap in Task 2; fix it there and record what was missing in the handoff.

**Files:**

- Test: `apps/server/src/orchestration-v2/ShellStream.test.ts`
- Test: `apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts`

**Interfaces:**

- Consumes: Task 2's shell field; `skipUnchangedThreadShells` (`ShellStream.ts` line ~254); the test adapter's `tokenUsageByRunOrdinal` option (`ProviderSwitch.integration.test.ts` line ~113, emitted at line ~344 as a `running` `provider_turn.updated` with `updatedAt` = that turn's event time, followed by a terminal update without usage).

- [ ] **Step 1: Write the push-filter case.** In `describe("skipUnchangedThreadShells")`, add `it.effect("sends a shell whose latest token usage changed", ...)` using the existing `shell`, `updated`, `run` and `at` helpers. `A = { usedTokens: 40_000, maxTokens: 200_000, updatedAt: "2026-10-01T00:00:00.000Z" }`, `B = { ...A, usedTokens: 41_000, updatedAt: "2026-10-01T00:00:01.000Z" }`.

| Steps fed to `run`                                                                                                                                                                                                                                                     | Expected sent sequences |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `updated(1, shell("a", { latestTokenUsage: A }))`, `updated(2, shell("a", { updatedAt: at(100), latestTokenUsage: A }))`, `updated(3, shell("a", { updatedAt: at(200), latestTokenUsage: B }))`, `updated(4, shell("a", { updatedAt: at(300), latestTokenUsage: B }))` | `[1, 3]`                |

- [ ] **Step 2: Write the full-orchestrator test.** In `ProviderSwitch.integration.test.ts`, inside `describe("orchestration v2 provider switching")`, add `it.live("puts the newest token usage on the thread shell as turns report it", ...)`, modelled on "keeps the native session after turns refused before reaching the provider" (line ~1201): `checkpointWorkspace("latest-token-usage")`, one `makeTestAdapter` for Claude (`instanceId: CLAUDE_MODEL_SELECTION.instanceId`, `driver: CLAUDE_DRIVER`, `capabilities: ClaudeProviderCapabilitiesV2`, `modelSelection: CLAUDE_MODEL_SELECTION`, `responseByRunOrdinal: {}`, `capturedTurns`) with

```ts
tokenUsageByRunOrdinal: {
  1: { usedTokens: 40_000, maxTokens: 200_000 },
  2: { usedTokens: 55_000, maxTokens: 200_000, promptCacheTtlMs: 3_600_000,
       requestIdentity: { model: "claude-sonnet-4-6", effort: "high" } },
},
```

The same `run(ordinal)` helper as that test (dispatch `message.dispatch` with `CLAUDE_MODEL_SELECTION`, `Stream.runHead` on the stored `run.updated` reaching `completed`/`failed` for that ordinal, then `worker.drain()`), the same `thread.create`, and the same `ProviderReplayHarness.layerWithRegistry({ name: "latest-token-usage", runtimePolicyOverride: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } }, registry)`. Read with `const shellUsage = Effect.map(orchestrator.getThreadShell(threadId), (shell) => shell?.latestTokenUsage)` and `const snapshotUsage = Effect.map(orchestrator.getShellSnapshot(), (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.latestTokenUsage)`. Check the exact `getShellSnapshot` parameter list at `Orchestrator.ts` line ~345 and pass whatever it requires for an unfiltered active snapshot.

| After                                                            | `shellUsage` and `snapshotUsage` (both)                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread.create`, before any run                                  | `null`                                                                                                                                         |
| `run(1)` returns `"completed"`                                   | object with `usedTokens: 40_000`, `maxTokens: 200_000`, no `promptCacheTtlMs` key                                                              |
| `run(2)` returns `"completed"`                                   | object with `usedTokens: 55_000`, `promptCacheTtlMs: 3_600_000`, `requestIdentity` deep-equal `{ model: "claude-sonnet-4-6", effort: "high" }` |
| `run(3)` returns `"completed"` (no usage reported for ordinal 3) | still the run-2 object (deep-equal)                                                                                                            |

Assert with `assert.include` / `assert.deepEqual` on the fields named; do not assert `updatedAt` (it is the adapter's wall clock).

- [ ] **Step 3: Run.** `vp test run apps/server/src/orchestration-v2/ShellStream.test.ts -t "latest token usage"` and `vp test run apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts -t "newest token usage"`. Expected: both pass on Task 2's code. Confirm each run reports one matched test (a `-t` filter that matches nothing also exits 0).

- [ ] **Step 4: Lint, format, commit.** `vp lint` and `vp fmt` the two test files.

```bash
git add apps/server/src/orchestration-v2/ShellStream.test.ts apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts
git commit -m "test(server): pin latest token usage through the live shell path"
```

---

## Task 4: Claude request identity and TTL carry-forward

**Files:**

- Modify: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
- Test: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`

**Interfaces:**

- Consumes: Task 1's `OrchestrationV2ProviderTurnRequestIdentity` type; `resolveClaudeModelSlug(catalog, slugOrAlias)` (`apps/server/src/provider/ClaudeModelCatalog.ts` line ~145, already imported at adapter line ~120); `getModelSelectionStringOptionValue` / `getModelSelectionBooleanOptionValue` (`packages/shared/src/model.ts` lines ~72/~79).
- Produces (exported for tests):

```ts
export function claudeRequestIdentity(
  catalog: ClaudeModelCatalog,
  responseModel: unknown,
  modelSelection: ModelSelection,
): OrchestrationV2ProviderTurnRequestIdentity | undefined;

export function claudeProviderTurnTokenUsage(
  usage: { /* unchanged */ },
  modelSelection: ModelSelection,
  updatedAt: string,
  context?: {
    readonly carriedPromptCacheTtlMs?: number | undefined;
    readonly requestIdentity?: OrchestrationV2ProviderTurnRequestIdentity | undefined;
  },
): /* inferred; assignable to OrchestrationV2ProviderTurnTokenUsage */;
```

- [ ] **Step 1: Write the failing pure tests.** In `describe("ClaudeAdapterV2 context usage")` (line ~883), add two tests. Import `BUNDLED_CLAUDE_MODEL_CATALOG` from `../../provider/ClaudeModelCatalog.ts` if the test file does not already.

`it("names the request a top-level usage report belongs to")`, `ClaudeAdapterV2.claudeRequestIdentity(BUNDLED_CLAUDE_MODEL_CATALOG, responseModel, { ...CLAUDE_TEST_MODEL_SELECTION, options })`:

| #   | `responseModel`                 | `options`                                                            | Expected (`assert.deepEqual`)                                                 |
| --- | ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `"claude-sonnet-4-6"`           | `[{ id: "effort", value: "ultrathink" }]`                            | `{ model: "claude-sonnet-4-6", effort: "ultrathink" }`                        |
| 2   | `" claude-haiku-4-5-20251001 "` | `[]`                                                                 | `{ model: "claude-haiku-4-5" }` (dated id resolves through the catalog alias) |
| 3   | `"claude-opus-5-5[1m]"`         | `[{ id: "effort", value: "high" }, { id: "fastMode", value: true }]` | `{ model: "claude-opus-5-5", effort: "high", fastMode: true }`                |
| 4   | `"claude-opus-5-5"`             | `[{ id: "fastMode", value: false }]`                                 | `{ model: "claude-opus-5-5", fastMode: false }`                               |
| 5   | `"some-unknown-model"`          | `[]`                                                                 | `{ model: "some-unknown-model" }` (unknown ids pass through)                  |
| 6   | `""`                            | `[]`                                                                 | `undefined`                                                                   |
| 7   | `"   "`                         | `[{ id: "effort", value: "high" }]`                                  | `{ effort: "high" }`                                                          |
| 8   | `undefined`                     | `[]`                                                                 | `undefined`                                                                   |
| 9   | `"claude-sonnet-4-6"`           | `[{ id: "effort", value: "  " }]`                                    | `{ model: "claude-sonnet-4-6" }` (blank effort omitted)                       |
| 10  | `"claude-sonnet-4-6"`           | `[{ id: "effort", value: true }, { id: "fastMode", value: "yes" }]`  | `{ model: "claude-sonnet-4-6" }` (wrong-typed options ignored)                |

`it("carries the last cache TTL and the request identity onto a usage report")`, `ClaudeAdapterV2.claudeProviderTurnTokenUsage({ input_tokens: 1, output_tokens: 1, ...cache }, CLAUDE_TEST_MODEL_SELECTION, "2026-08-29T00:00:00.000Z", context)`:

| #   | `cache`                                                                               | `context`                                             | Expected `promptCacheTtlMs`                | Expected `requestIdentity`       |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| 1   | `{ cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } }` | `{ carriedPromptCacheTtlMs: 300_000 }`                | `3_600_000` (this response's own TTL wins) | key absent                       |
| 2   | `{}`                                                                                  | `{ carriedPromptCacheTtlMs: 3_600_000 }`              | `3_600_000`                                | key absent                       |
| 3   | `{ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }`  | `{ carriedPromptCacheTtlMs: 300_000 }`                | `300_000`                                  | key absent                       |
| 4   | `{}`                                                                                  | `{}`                                                  | key absent                                 | key absent                       |
| 5   | `{}`                                                                                  | `{ requestIdentity: { model: "claude-sonnet-4-6" } }` | key absent                                 | `{ model: "claude-sonnet-4-6" }` |

"Key absent" means `assert.isFalse("promptCacheTtlMs" in usage)` (or `"requestIdentity" in usage`). The two existing tests above it ("projects assistant usage...", "reports the prompt cache TTL...") call the function with three arguments and must keep passing unchanged.

- [ ] **Step 2: Write the failing harness tests.** At the end of `describe("ClaudeAdapterV2 background wake turns")` (just before its closing `});` at line ~13479), add a local frame builder and two tests. The builder copies `makeAssistantTextFrame` (line ~2176) but takes the usage and parent:

```ts
const makeUsageFrame = (input: {
  readonly uuid: string;
  readonly model?: string;
  readonly parentToolUseId?: string | null;
  readonly usage: Record<string, unknown>;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: input.model ?? "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
      stop_reason: null,
      stop_sequence: null,
      usage: input.usage,
    },
    parent_tool_use_id: input.parentToolUseId ?? null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
const reportedUsage = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
      ? [event.providerTurn.tokenUsage]
      : [],
  );
```

`dNN` below is the uuid `00000000-0000-4000-8000-000000000dNN` (that range is unused in the file today). `oneHour` usage = `{ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } }`; `readOnly` usage = `{ input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 }` (no `cache_creation`).

Test A, `it.effect("stamps top-level usage with the request identity and carries the cache TTL across turns", ...)` (wrap like "keeps the measured context when a usage limit ends the turn", line ~3360: `makeWakeHarness`, `Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer))`). Turn 1 (`attemptId "attempt-usage-identity-1"`, default `CLAUDE_TEST_MODEL_SELECTION`, effort `ultrathink`): offer `makeUsageFrame({ uuid: d01, usage: oneHour })`, `makeUsageFrame({ uuid: d02, usage: readOnly })`, `makeUsageFrame({ uuid: d03, parentToolUseId: "toolu_usage_subagent", usage: oneHour })`, `makeResultFrame({ uuid: d04, result: "Done." })`; `Queue.take(harness.terminalReceipts)`. Turn 2 (`attemptId "attempt-usage-identity-2"`, `providerTurnOrdinal: 2`): offer `makeUsageFrame({ uuid: d05, usage: readOnly })`, `makeResultFrame({ uuid: d06, result: "Done." })`; take the second terminal receipt.

| Assertion on `reportedUsage(harness.events)` | Expected                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| length                                       | `3` (the subagent frame d03 reports nothing)                                                                                          |
| `[0]`                                        | `usedTokens: 610`, `promptCacheTtlMs: 3_600_000`, `requestIdentity` deep-equal `{ model: "claude-sonnet-4-6", effort: "ultrathink" }` |
| `[1]`                                        | `usedTokens: 615`, `promptCacheTtlMs: 3_600_000` (carried), same `requestIdentity`                                                    |
| `[2]` (turn 2)                               | `usedTokens: 615`, `promptCacheTtlMs: 3_600_000` (carried across turns), same `requestIdentity`                                       |

(`usedTokens` = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`: `100 + 500 + 0 + 10 = 610`; `5 + 0 + 600 + 10 = 615`.)

Test B, `it.effect("leaves the compaction watermark without identity or carried TTL", ...)`, wrapped like "runs native compaction and keeps its context watermark separate from billed usage" (line ~3480, note its `Effect.scoped`): turn 1 as in test A but only `d11 = oneHour` then a result frame; take the terminal receipt. Then `harness.runtime.compactThread` (assert defined) with `attemptId "attempt-usage-compact"`, `text: "/compact"`, `providerTurnOrdinal: 2`; offer the `compact_boundary` frame exactly as that existing test does (`post_tokens: 400`) and a result frame; take the terminal receipt.

| Assertion                                           | Expected                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| the `reportedUsage` entry with `usedTokens === 400` | exists; `"promptCacheTtlMs" in it === false`; `"requestIdentity" in it === false` |
| the entry with `usedTokens === 610`                 | `promptCacheTtlMs: 3_600_000` and the identity, as in test A                      |

- [ ] **Step 3: Run to verify they fail.** `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "names the request|request identity|compaction watermark without"` (a bare `-t "request"` would also match dozens of unrelated runtime-request tests) -> `claudeRequestIdentity` is not a function; the carry-forward rows and test A fail on missing keys. Test B may already pass (the compaction report is built inline); that is fine, it pins the behaviour.

- [ ] **Step 4: Implement `claudeRequestIdentity`.** In `ClaudeAdapterV2.ts`, directly above `claudeProviderTurnTokenUsage` (line ~192). Add `type OrchestrationV2ProviderTurnRequestIdentity` to the `@t3tools/contracts` import block (line ~50) and change `import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";` (line ~45) to also import `getModelSelectionBooleanOptionValue` and `getModelSelectionStringOptionValue`.

```ts
/**
 * The identity a top-level request ran with, for the client's prompt-cache
 * check. The response names a dated API id ("claude-haiku-4-5-20251001"),
 * sometimes with a context suffix ("[1m]"); the catalog slug is the
 * vocabulary of ModelSelection.model, which is what the client compares
 * against. Effort and fast mode are the raw selection values (no default
 * resolution). Blank values are omitted: the wire schema rejects them.
 */
export function claudeRequestIdentity(
  catalog: ClaudeModelCatalog,
  responseModel: unknown,
  modelSelection: ModelSelection,
): OrchestrationV2ProviderTurnRequestIdentity | undefined {
  const reported =
    // Same suffix rule as P1's sameRequestIdentity (`replace(/\[.*$/, "")`).
    typeof responseModel === "string" ? responseModel.trim().replace(/\[.*$/, "").trim() : "";
  const model = reported.length === 0 ? undefined : resolveClaudeModelSlug(catalog, reported);
  const effort = getModelSelectionStringOptionValue(modelSelection, "effort")?.trim();
  const fastMode = getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
  const identity = {
    ...(model === undefined ? {} : { model }),
    ...(effort ? { effort } : {}),
    ...(fastMode === undefined ? {} : { fastMode }),
  };
  return Object.keys(identity).length === 0 ? undefined : identity;
}
```

- [ ] **Step 5: Extend `claudeProviderTurnTokenUsage`.** Add the optional fourth parameter shown in Interfaces with default `{}`; replace `const promptCacheTtlMs = claudePromptCacheTtlMs(usage.cache_creation);` with `const promptCacheTtlMs = claudePromptCacheTtlMs(usage.cache_creation) ?? context.carriedPromptCacheTtlMs;`, and in the returned object insert `...(context.requestIdentity === undefined ? {} : { requestIdentity: context.requestIdentity }),` between the `promptCacheTtlMs` spread and `updatedAt`. Nothing else in the function changes. Extend its doc comment by one sentence: "A response that wrote no cache takes the provider thread's last known TTL from `context`."

- [ ] **Step 6: Remember the TTL and wire the call site.** In `makeClaudeAdapterV2` (line ~3329), directly after the `subagentModelCatalog` declaration, add:

```ts
// Last prompt-cache TTL a top-level report named, per provider thread. A
// response that only read cache names none, so its report carries this one
// forward. The TTL is the account's cache tier (1h or 5m), so it stays valid
// across turns, sessions and compactions; it is lost on a server restart
// until the next response writes cache.
const promptCacheTtlMsByProviderThread = new Map<ProviderThreadId, number>();
```

Adapter scope (not `openSession`) so a reopened session on the same provider thread keeps it. Then replace the `tokenUsage: claudeProviderTurnTokenUsage(...)` call inside `if (message.type === "assistant" && input.replayed !== true)` -> `if (message.parent_tool_use_id === null && message.message.usage !== undefined && message.message.model !== "<synthetic>")` (line ~6935-6967). The final shape of that `if` block:

```ts
if (
  message.parent_tool_use_id === null &&
  message.message.usage !== undefined &&
  message.message.model !== "<synthetic>"
) {
  const providerThreadId = context.input.providerThread.id;
  const tokenUsage = claudeProviderTurnTokenUsage(
    message.message.usage,
    context.input.modelSelection,
    DateTime.formatIso(now),
    {
      carriedPromptCacheTtlMs: promptCacheTtlMsByProviderThread.get(providerThreadId),
      requestIdentity: claudeRequestIdentity(
        subagentModelCatalog,
        message.message.model,
        context.input.modelSelection,
      ),
    },
  );
  if (tokenUsage.promptCacheTtlMs !== undefined) {
    promptCacheTtlMsByProviderThread.set(providerThreadId, tokenUsage.promptCacheTtlMs);
  }
  yield *
    emitProviderEvent({
      type: "provider_turn.updated",
      driver: CLAUDE_PROVIDER,
      threadId: context.input.threadId,
      providerTurn: {
        // every field exactly as today ...
        tokenUsage,
      },
    });
}
```

Do not touch the `compact_boundary` branch (line ~6782): its inline `tokenUsage` stays without identity or TTL (index 9 D2), and it does not read or clear the map.

- [ ] **Step 7: Run the tests to verify they pass.** The commands from Step 3 -> pass. Then the existing usage tests: `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "context"` -> pass ("projects assistant usage...", "reports the prompt cache TTL...", "keeps the measured context when a usage limit ends the turn", "runs native compaction...").

- [ ] **Step 8: Typecheck, lint, format.** `vp run t3#typecheck`; `vp lint apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`; `vp fmt` the two files.

- [ ] **Step 9: Commit.**

```bash
git add apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
git commit -m "feat(server): Claude usage reports name their request and keep the cache TTL"
```

---

## Task 5: Regression test for the 0.0.45 "1m/1m" context

Test-only. The property: a subagent's `task_progress` or `task_notification` frame carrying `usage.total_tokens` never changes any `tokenUsage`. Today the only reader of `total_tokens` is `claudeWorkflowProgress.ts` line ~188 (workflow progress, not token usage), so the test is expected to pass at once; it exists to keep it that way.

**Files:**

- Test: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`

**Interfaces:**

- Consumes: `makeWakeHarness` (its `terminalReceipts` queue), `makeAssistantTextFrame` (usage 1/1 -> `usedTokens: 2`), `makeSubagentTaskStartedFrame` and `makeSubagentNotificationFrame` (line ~6877 / ~6895), `makeResultFrame`, `claudeSdkFrame`, and Task 4's `reportedUsage` helper (same describe block).

- [ ] **Step 1: Write the test.** At the end of `describe("ClaudeAdapterV2 background wake turns")`, after Task 4's tests, add `it.effect.each(["task_progress", "task_notification"] as const)("never reports a subagent's %s usage as the thread's context", (subtype) => ...)`, wrapped like Task 4 test A. `TASK = "task-usage-regression"`, `TOOL_USE = "toolu_usage_regression"`, `HUGE = { total_tokens: 1_000_000, tool_uses: 12, duration_ms: 60_000 }`. `eNN` below is the uuid `00000000-0000-4000-8000-000000000eNN` (the `d`/`e` ranges are unused in the file today; each parameterised case gets its own harness, so reusing them across the two cases is fine). Frames, in order:

| #   | Frame                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `makeAssistantTextFrame({ uuid: e01, text: "Delegating." })`                                                                                                                                                                                                                                                                                                                                           |
| 2   | `makeSubagentTaskStartedFrame({ taskId: TASK, toolUseId: TOOL_USE, uuid: e02 })`                                                                                                                                                                                                                                                                                                                       |
| 3   | `subtype === "task_progress"`: `claudeSdkFrame({ type: "system", subtype: "task_progress", task_id: TASK, tool_use_id: TOOL_USE, description: "Reading files", usage: HUGE, uuid: e03, session_id: WAKE_NATIVE_SESSION })`; `subtype === "task_notification"`: `claudeSdkFrame({ ...makeSubagentNotificationFrame({ taskId: TASK, toolUseId: TOOL_USE, summary: "Done.", uuid: e03 }), usage: HUGE })` |
| 4   | `makeResultFrame({ uuid: e04, result: "Delegated." })`                                                                                                                                                                                                                                                                                                                                                 |

Start the turn with `attemptId "attempt-usage-regression-<subtype>"`, offer the four frames, then `yield* Queue.take(harness.terminalReceipts)` (the backgrounded subagent may keep running after the root settles, so wait on the root's `turn.terminal`, not on a background result; AGENTS.md forbids polling waits, so do not use `awaitUntil` here).

| Assertion on `reportedUsage(harness.events)` | Expected                                                   |
| -------------------------------------------- | ---------------------------------------------------------- |
| `.map((usage) => usage.usedTokens)`          | deep-equals `[2]`                                          |
| every entry's `maxTokens`                    | `200_000` (the selected model's window, never `1_000_000`) |

- [ ] **Step 2: Run.** `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "usage as the thread's context"` -> 2 tests, both pass. To prove the test can fail, temporarily change the expected list to `[2, 1_000_000]`, run, see it fail, and revert before committing.

- [ ] **Step 3: Lint, format, commit.** `vp lint` and `vp fmt` the test file.

```bash
git add apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
git commit -m "test(server): subagent progress usage never becomes the thread's context"
```

---

## Task 6: Final verification sweep

- [ ] **Step 1: Run every touched test file once.**

```sh
vp test run packages/contracts/src/orchestrationV2.test.ts packages/client-runtime/src/state/entities.test.ts
vp test run apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/ShellStream.test.ts apps/server/src/orchestration-v2/ProviderTurnTokenUsage.test.ts apps/server/src/orchestration-v2/WireProjection.test.ts
vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
vp test run apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts -t "newest token usage"
```

Expected: all pass. The server suite runs files serially (`fileParallelism: false`), so run the commands one after another, not in parallel.

- [ ] **Step 2: Typecheck each touched package** (one command each, never repo-wide): `vp run @t3tools/contracts#typecheck`, `vp run @t3tools/client-runtime#typecheck`, `vp run @t3tools/web#typecheck`, `vp run @t3tools/mobile#typecheck`, `vp run t3#typecheck`.

- [ ] **Step 3: Lint and format every changed file** (list from `git diff --name-only feat/usage-pacing`): `vp lint <files>`, `vp fmt --check <files>`.

- [ ] **Step 4: Walk AGENTS.md "Hit every surface" and record the answers in the handoff:**
  - Providers: Claude fills `requestIdentity` and carries the TTL. Codex, Cursor, Grok, OpenCode, Antigravity and Pi report `tokenUsage` without identity; their threads still get `latestTokenUsage` (ring), and the client skips the identity check (spec 4.5). Decision: not supported beyond Claude, by design (spec 1 "Only Claude needs to work now").
  - Clients: web reads the field via `SidebarThreadSummary` (P5 draws it); mobile receives it through `presentThreadShell` and renders nothing (out of scope); desktop wraps web.
  - Contracts: both fields optional on the wire; mixed versions degrade (index 4).
  - Connection modes: the field rides the existing shell snapshot and shell stream, identical locally and remotely.
  - Docs: no user-visible behaviour of its own (P5 documents the glyph), and nothing in `docs/internals/` describes shell fields; no doc change. The "keep the two in step" comment on `latestTokenUsageForShell` is the implementation note.

- [ ] **Step 5: Request the independent review.** This plan gets a full review (index 1 "Gets a full review"). Hand the reviewer this plan, the spec, the index, and `git diff feat/usage-pacing...feat/usage-pacing-p3-server-thread`. Fix or justify every finding with a follow-up commit before reporting the branch done.

---

## Open questions / spec deviations

Each item is self-contained. "Followed provisionally" means the plan already implements the recommendation.

1. **Contract deviation (index 6.3, `requestIdentity.model`): strip a trailing `[...]` before resolving the slug.** Context: index 6.3 pins `model = resolveClaudeModelSlug(subagentModelCatalog, message.message.model.trim())`. The adapter builds the API model id with `resolveClaudeCatalogApiModelId`, which can append a context suffix such as `[1m]`, and `resolveClaudeModelSlug` matches only exact slugs or aliases, so a suffixed dated id (for example `claude-opus-4-6-20251117[1m]`) would pass through unresolved. P1's `sameRequestIdentity` strips a trailing `[...]` when it compares, but stripping after the fact leaves `claude-opus-4-6-20251117`, which still differs from the selection's `claude-opus-4-6` and would read as cold. Options: (a) follow the index literally; (b) strip the suffix, then resolve. Recommendation: (b), followed provisionally (`claudeRequestIdentity`, Task 4 table row 3). It uses P1's suffix regex (`/\[.*$/`) so server and client agree on what a suffix is. It changes only what the server writes for suffixed ids, and P1's comparison is unaffected.

2. **Where the carried TTL lives (index 6.3 left this to P3).** Context: the TTL is remembered in a plain `Map<ProviderThreadId, number>` at adapter scope in `makeClaudeAdapterV2`, not seeded from persisted rows. Consequence: after a server restart, a response that only reads cache (writes nothing) before any response that writes cache produces a report with no TTL, and the glyph shows the ring without a dot until the next cache-writing response. Writes are the normal case (every request with new prompt content writes cache), so this is rare and self-heals within a turn. Options: (a) adapter memory only; (b) seed the map from the newest persisted `tokenUsage.promptCacheTtlMs` of the provider thread when a session opens, which needs a projection read the adapter does not have today; (c) fall back in the projection to an older report's TTL, which would also apply to the compaction report and contradict index 9 D2. Recommendation: (a), followed provisionally. Not user-visible beyond the rare restart case above.

3. **The carried TTL is not cleared by a compaction.** Context: index 9 D2 says the compaction report gets no identity and no carried TTL, so the cache state reads `unknown` right after a compaction. The question is whether the next assistant report should also lose the carried TTL. The TTL encodes the account's cache tier (1 h on a subscription within limits, 5 m otherwise), not the life of a particular cache entry, so it stays correct after a compaction; and the first request after a compaction writes a new prefix, so its own report names a TTL anyway. Recommendation: keep the map across compactions, followed provisionally. No user-visible difference in practice.

4. **One extra shell push per top-level usage report (performance note, AGENTS.md "Performance without compromise").** Context: before this change, the shell re-read that follows each `provider-turn.updated` produced an identical shell and `skipUnchangedThreadShells` dropped it. Now each Claude top-level assistant message changes `latestTokenUsage`, so subscribed clients receive one `thread.updated` (about 1-2 KB, the whole shell) per assistant message, coalesced per 50 ms batch per thread. A busy turn emits on the order of one assistant message per tool round-trip, comparable to the existing per-turn status pushes. The snapshot grows by roughly 250 bytes per thread that has usage. The new subquery seeks by index (Task 2 query-plan test) but still runs `json_type` / `json_extract` over every provider turn of each thread's active provider thread (one row per run) to sort by report time. That is a smaller set than the `item_count` subquery already in the same `SELECT`, which walks every turn item of the thread. Options: (a) accept; (b) quantise (for example push only when `usedTokens` moves by 1% or the identity/TTL changes), which would make the sidebar lag the composer. Recommendation: (a), followed provisionally; P6's end-to-end run can watch the shell stream during the subagent turn (item 4) if a check is wanted.

5. **Handoff hides the glyph until the new provider reports.** Context: per index 6.3, only the active provider thread counts, so right after switching provider (a new provider thread becomes active) `latestTokenUsage` is `null` and the sidebar shows no glyph until the new provider's first usage report. The previous provider's context size would be wrong for the new provider anyway. Recommendation: accept, followed provisionally (Task 2 sequence step 9). User-visible only as a brief absence after a switch; listed so the coherence agent can decide whether the spec should say so.

6. **Spec citation (spec 5.3, "`message.model`").** The field is `message.message.model`, an API model id; the client side compares against `ModelSelection.model`, a catalog slug. Already index 9 C4; this plan implements the C4 recommendation (resolve through the catalog). Small, clearly-correct spec fix: "`message.message.model`, resolved to the catalog slug".

7. **Spec 5.3 "Updated live whenever a provider turn's `tokenUsage` changes" needs no new mechanism.** The spec leaves "the exact projection mechanics" to the plan. Decision recorded here: the value is derived at read time (Task 2) and reaches clients through the existing per-thread shell refetch in `ws.ts` (`toShellStream` -> `getThreadShell` -> `skipUnchangedThreadShells`). Spec wording could add one sentence saying so; no behaviour question.

8. **What the regression test can and cannot pin (spec 5.3 / 7 item 4).** Context: the spec asks for a test "pinning the 0.0.45 bug's cause". In this codebase (nightly, not 0.0.45) no code path turns `task_progress` / `task_notification` usage into `tokenUsage`, so the cause cannot be reproduced; Task 5 pins the property instead (such frames never change `tokenUsage`, and `maxTokens` stays the selected model's window). If the real 0.0.45 symptom had another cause (for example a model id with a `[1m]` suffix inflating `maxTokens`), only P6's real subagent turn would show it. Recommendation: keep Task 5 as written and rely on P6 item 4 for the real-CLI check.

9. **`threadShellFromProjection` does not feed any shell that reaches a client.** Verified with grep: production shell reads (`getShellSnapshot`, `readShellSnapshot`, `getThreadShell` in `layer`) go through the SQL path. Its other callers are `Orchestrator.ts` line ~4524 (reads only `lastErrorClass`; the added loop over `providerTurns` costs O(turns) there and changes nothing it reads), the test-only `layerMemory` in `ProjectionStore.ts` (line ~5983, whose `getShellSnapshot` / `getThreadShell` / `getSettlementCandidates` build shells with it), `ProjectionStore.test.ts`, `WireProjection.test.ts` and an MCP integration test. The plan wires it anyway (index 1 names both places) because the existing tests compare the two builders and `layerMemory` must match `layer`. A windowed (bounded) projection would not hold every provider turn, so the in-memory value would be wrong for windowed input. Recommendation: no action; noted so nobody starts building client shells from a bounded projection.

10. **A stored `tokenUsage` this build cannot decode reads as `null`.** Task 2 decodes the subquery's JSON with `Effect.orElseSucceed(() => null)` so one bad row cannot fail the whole shell snapshot (the same tolerance `shellThreadStateFromRow` already applies to a blocking-failure row). The cost is a silently missing glyph for that thread. Recommendation: accept.
