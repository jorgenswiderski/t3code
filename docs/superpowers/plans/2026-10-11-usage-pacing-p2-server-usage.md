# Usage pacing P2: server usage freshness and session history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude usage windows update from every `rate_limit_event`, and keep an in-memory, per-instance history of session-window samples that reaches clients as an optional `history` on `ServerProviderUsageWindow`.

**Architecture:** (a) `claudeRateLimitEventToUpdate` additionally reads the untyped `rate_limit_info.unifiedWindows` and returns one window per listed id; the single-window path stays as fallback. (b) `makeManagedServerProvider` holds a `usageHistory` map in its private state next to the published snapshot; two pure helpers in `provider-core/.../usageLimits.ts` record samples and re-attach them as `history` every time the snapshot is published (runtime update path and probe path). (c) A new optional contract field carries the samples through the existing `providerStatuses` server-config stream.

**Tech Stack:** TypeScript, Effect v4 (`effect/Ref`, `effect/Schema`), vitest via `vp test run`, `@effect/vitest` for Effect tests.

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` sections 5.1 and 5.2. Shared contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` (sections 1 "P2-server-usage", 6.2, 7, 9 item C2). Read both first; this plan conforms to them.

## Global Constraints

- Contract shape, verbatim from index 6.2: `ServerProviderUsageSample = { at: IsoDateTime, usedPercent: Number in [0,100] }`; `history: Schema.optional(Schema.Array(ServerProviderUsageSample))` added to `ServerProviderUsageWindow` after `windowDurationMins`.
- History exists only for windows with `kind: "session"`; an empty list is omitted, never `[]`; samples ascending by `at`; at most 400 (newest kept); in memory only.
- A sample is `{ at: update.checkedAt, usedPercent: <window's merged usedPercent after the update> }`.
- Heartbeat coalescing: a sample whose `usedPercent` equals the previous sample's is skipped if fewer than 60 s separate them. When neither windows nor history changed, nothing is published (Codex's per-token notification must still not publish).
- Prune: `resetsAt` change clears that window's list; `credentialFingerprint`, `auth.workspaceId` or `auth.email` change (the existing `switchedAccount` rule) clears every list. A failed probe that keeps the last good snapshot records no sample.
- `claudeRateLimitEventToUpdate(info, names)` keeps its exported signature, so `ClaudeAdapterV2.ts` is **not edited** (P3 owns that file).
- `utilization` is a 0-1 fraction and `resetsAt` is epoch seconds in `unifiedWindows` (confirmed in `~/.t3/userdata/logs/provider/events.*.log`).
- No web changes, no new config keys, env vars, tables or migrations.
- Repo rules (AGENTS.md): targeted checks only, never repo-wide; tests assert behaviour, no sleeps; `exactOptionalPropertyTypes` is on; inferred types over annotations; comments describe use, not narrate lines; Conventional Commit titles; do not start a dev server (P6 owns end-to-end).
- Commands: `vp` is not on PATH. Prefix every command with `PATH="$PWD/node_modules/.bin:$PATH"` (shown as `vp` below). The user's shell wraps `cd` via fnm and returns 127: use `builtin cd <dir>; <cmd>` with `;`, never `cd ... && ...`.

## Review Focus

Failure modes the spec implies but no obvious test would exercise; each has its test in the task named in brackets.

1. **Sub-second `resetsAt` drift between sources.** The probe reports ISO strings (possibly fractional), events report integer epoch seconds; the same window can differ by under a second between the two. Treating that as a new window would wipe the history on every alternation. Expected: same window, history kept. [Task 3]
2. **Float noise in percent.** `0.58 * 100 = 57.99999999999999`, `0.07 * 100 = 7.000000000000001`. A raw product would never equal the probe's `58`/`7`, defeating heartbeat coalescing and publishing on every alternation. Expected: events round to two decimals. [Task 2]
3. **Codex per-token notifications.** Unchanged numbers inside the 60 s heartbeat window must publish nothing and return the same snapshot object. [Task 4]
4. **Failed or unsupported probe.** Must not append a sample, must not drop the existing history of the same account. [Task 4]
5. **Account swap mid-session.** Samples of the old account must not feed the new account's burn. Expected: history cleared on workspace, email or fingerprint change, even though `resetsAt` might coincide. [Task 4]
6. **Malformed `unifiedWindows`** (string, array, null entries, non-finite numbers, unknown keys such as `seven_day_opus`). Expected: ignored without throwing, fallback path still works. [Task 2]
7. **Enrichment landing after a live update** must not revert `history`. [Task 4]

---

## Implementation Location

- **Branch:** `feat/usage-pacing-p2-server-usage`
- **Worktree:** `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p2-server-usage`
- **Base branch:** `feat/usage-pacing`

Create it (from the integration worktree, as index section 5 specifies):

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git worktree add -b feat/usage-pacing-p2-server-usage /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p2-server-usage feat/usage-pacing
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p2-server-usage; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/node_modules/.bin:$PATH" node scripts/setup-worktree.ts
```

Milestone **P2-contract** = the Task 1 commit (contract + decode test, nothing else). The implementing agent reports its SHA after Task 1 verification passes; the orchestrator merges that commit forward (index 5 "Merge a milestone forward"). The remaining tasks continue on the same branch.

## Testing Strategy

- **End-to-end: deferred to P6, not run in this plan.** AGENTS.md says subagents do not launch dev servers; the integrated feature gets one end-to-end pass in P6 on the merged `feat/usage-pacing`. P6 items this plan feeds: item 1 (header percentages match the provider snapshot, which depends on the `unifiedWindows` fix), item 2 (session burn appears after enough samples, which depends on `history`) and item 5 (after a server restart `history` is empty and the widget falls back to the linear estimate). P6 can read the live values from the `subscribeServerConfig` `providerStatuses` stream or the provider snapshot.
- **Hermetic (this plan):**
  - Mapper: table-driven unit tests, including the verbatim real payload from the user's logs.
  - History: pure-function tests of `recordUsageSamples` / `attachUsageHistory` (append, heartbeat boundary, reset tolerance, cap, clamping, full vs partial mode), then `makeManagedServerProvider` behavioural tests through the public `applyUsageLimits` / `refresh` / `getSnapshot` / `streamChanges` surface with explicit `checkedAt` strings (deterministic, no clock, no sleeps).
  - Contract: decode with and without `history`.
  - Cache: the provider-status cache file does not carry `history`.
- A cross-package hermetic bridge (real payload -> `claudeRateLimitEventToUpdate` -> `applyUsageLimitsUpdate`) is covered by Task 2's last case, which feeds the mapper output into `applyUsageLimitsUpdate`, so the two halves are known to compose.

## File Structure

| File                                                        | Action | Responsibility                                                                                                                                          |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/providerUsageLimits.ts`             | modify | `ServerProviderUsageSample`, `history` on `ServerProviderUsageWindow`                                                                                   |
| `packages/contracts/src/server.test.ts`                     | modify | decode tests (inside `describe("server config forward compatibility")` (line 143), next to "drops usage windows this build cannot decode...", line 181) |
| `apps/server/src/provider/claudeUsageLimits.ts`             | modify | `unifiedWindows` reader, `percentFromFraction`, new body of `claudeRateLimitEventToUpdate`                                                              |
| `apps/server/src/provider/claudeUsageLimits.test.ts`        | modify | new `describe` cases in `claudeRateLimitEventToUpdate`                                                                                                  |
| `packages/provider-core/src/server/usageLimits.ts`          | modify | `UsageHistory`, `EMPTY_USAGE_HISTORY`, `recordUsageSamples`, `attachUsageHistory`                                                                       |
| `packages/provider-core/src/server/usageLimits.test.ts`     | modify | pure-function tests                                                                                                                                     |
| `packages/provider-core/src/server/managedProvider.ts`      | modify | `usageHistory` in `ProviderSnapshotState`; wire both publish paths                                                                                      |
| `packages/provider-core/src/server/managedProvider.test.ts` | modify | behavioural tests                                                                                                                                       |
| `apps/server/src/provider/providerStatusCache.ts`           | modify | drop `history` from the persisted cache file                                                                                                            |
| `apps/server/src/provider/providerStatusCache.test.ts`      | modify | one test                                                                                                                                                |

Files this plan must not touch: `ClaudeAdapterV2.ts` (P3), anything under `apps/web`, `packages/shared`, `packages/client-runtime`.

---

## Task 1: Contract field (milestone P2-contract)

**Files:**

- Modify: `packages/contracts/src/providerUsageLimits.ts` (the `ServerProviderUsageWindow` struct, line ~19)
- Test: `packages/contracts/src/server.test.ts`

**Interfaces:**

- Produces (index 6.2, verbatim): `ServerProviderUsageSample` (value + type, both exported from `@t3tools/contracts` through the existing `export * from "./providerUsageLimits.ts"`), and `ServerProviderUsageWindow["history"]: ReadonlyArray<ServerProviderUsageSample> | undefined`.

- [ ] **Step 1: Write the failing test.** In `server.test.ts`, inside `describe("server config forward compatibility")` (line 143; not `describe("ServerProvider")`, which ends before it) after the "drops usage windows..." test (line 181), add `it("decodes a session window with and without usage history")`. Use `decodeServerProvider({ ...baseProviderSnapshot, usageLimits: { checkedAt, windows } })`.

| Input window(s)                                                                                                                                                                                | Expected                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{ id: "five_hour", kind: "session", label: "Session", usedPercent: 12, history: [{ at: "2026-10-11T10:00:00.000Z", usedPercent: 10 }, { at: "2026-10-11T10:05:00.000Z", usedPercent: 12 }] }` | decoded window `history` deep-equals the input array                                                                                     |
| `{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20 }`                                                                                                                        | decoded window has no `history` key (`"history" in window` is `false`)                                                                   |
| same session window, then `Schema.encodeSync(ServerProviderUsageWindow)` of the decoded value                                                                                                  | round-trips equal to the input (history preserved on encode)                                                                             |
| session window with `history: [{ at: "2026-10-11T10:00:00.000Z", usedPercent: 120 }]`                                                                                                          | the window is dropped by `ForwardCompatibleArray` (same behaviour as the existing "bad" window); other windows in the same array survive |

Import `ServerProviderUsageWindow` from `./providerUsageLimits.ts` for the encode case.

- [ ] **Step 2: Run to verify it fails.** `vp test run packages/contracts/src/server.test.ts` -> the history cases fail (field stripped on decode, `history` undefined).

- [ ] **Step 3: Implement.** In `providerUsageLimits.ts`, above `ServerProviderUsageWindow`, add the sample struct exactly as index 6.2, and add the field after `windowDurationMins`:

```ts
/** One observation of a session window, recorded by the server on every usage update. */
export const ServerProviderUsageSample = Schema.Struct({
  at: IsoDateTime,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
});
export type ServerProviderUsageSample = typeof ServerProviderUsageSample.Type;

// inside ServerProviderUsageWindow, after windowDurationMins:
  /** Session windows only: samples of the current window, oldest first. Omitted when empty. */
  history: Schema.optional(Schema.Array(ServerProviderUsageSample)),
```

Also extend the struct's doc comment with one sentence: `history` is how clients project a burn rate for the window.

- [ ] **Step 4: Run to verify it passes.** `vp test run packages/contracts/src/server.test.ts`.

- [ ] **Step 5: Typecheck and lint.** `vp run @t3tools/contracts#typecheck`; `vp lint packages/contracts/src/providerUsageLimits.ts packages/contracts/src/server.test.ts`; `vp fmt packages/contracts/src/providerUsageLimits.ts packages/contracts/src/server.test.ts`. (Old clients ignore the unknown optional field: Effect `Struct` decode ignores excess properties by default, which is why no deploy ordering applies, index 4.)

- [ ] **Step 6: Commit (this is the P2-contract milestone).**

```sh
git add packages/contracts/src/providerUsageLimits.ts packages/contracts/src/server.test.ts
git commit -m "feat(contracts): session usage windows can carry their sample history

<attribution line your harness specifies>"
git rev-parse HEAD   # report this SHA as the P2-contract milestone
```

---

## Task 2: Read `unifiedWindows` in `claudeRateLimitEventToUpdate`

**Files:**

- Modify: `apps/server/src/provider/claudeUsageLimits.ts` (`claudeRateLimitEventToUpdate`, line ~129; the module doc comment, line 1)
- Test: `apps/server/src/provider/claudeUsageLimits.test.ts` (inside `describe("claudeRateLimitEventToUpdate")`, line 122)

**Interfaces:**

- Consumes: existing `WINDOWS`, `makeWindow`, `scopedWindow`, `isoFromEpochSeconds`, `OVERAGE_INCLUDED_EVENT_TYPE`, `ClaudeScopedLimitNames`, `clampPercent`.
- Produces: unchanged export `claudeRateLimitEventToUpdate(info: SDKRateLimitInfo, names: ClaudeScopedLimitNames): ProviderUsageLimitsUpdate | undefined`. The pinned SDK typings (0.3.276) do not declare `unifiedWindows`, so it is read structurally, like `readModelScoped` does for `model_scoped`.

Behaviour (precise):

- Windows come from two sources, merged by window id into one update; the `unifiedWindows` entry wins when both name the same id.
  1. **Unified.** For each id in `WINDOWS` (`five_hour`, `seven_day`, in that order; unknown keys such as `seven_day_opus` are ignored), take `unifiedWindows[id]` if it is a non-null object whose `utilization` is a finite number. `usedPercent = percentFromFraction(utilization)`; `resetsAt = isoFromEpochSeconds(entry.resetsAt)` when `entry.resetsAt` is a number, otherwise omitted. Not gated on top-level `utilization` or on `rateLimitType`; a non-object `unifiedWindows` (string, array, null, number) yields nothing.
  2. **Single-window fallback** (today's logic, unchanged except the new rounding and a finite check): requires `rateLimitType` and a finite numeric top-level `utilization`; maps `five_hour` / `seven_day` through `makeWindow`, and `seven_day_overage_included` through `scopedWindow(names.overageIncluded, ...)` only when the name is known.
- Returns `undefined` when neither source yields a window.
- `percentFromFraction(fraction) = Math.round(fraction * 10_000) / 100`, then the existing `clampPercent` inside `makeWindow` / `scopedWindow`. Rationale: Review Focus item 2. The existing expectations (0.85 -> 85, 0.4 -> 40) stay green.

Code (the spot an implementer could plausibly get wrong, so given in full):

```ts
function percentFromFraction(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/**
 * `rate_limit_info.unifiedWindows` shipped in the CLI after the SDK typings we
 * pin, so it is read structurally until the `.d.ts` catches up. Every event
 * lists the account-wide windows, not just the one named by `rateLimitType`.
 */
function readUnifiedWindows(info: SDKRateLimitInfo): ReadonlyArray<ServerProviderUsageWindow> {
  const raw = (info as { readonly unifiedWindows?: unknown }).unifiedWindows;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const entry: unknown = (raw as Record<string, unknown>)[id];
    if (typeof entry !== "object" || entry === null) continue;
    const { utilization, resetsAt } = entry as { utilization?: unknown; resetsAt?: unknown };
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    windows.push(
      makeWindow(
        id,
        percentFromFraction(utilization),
        isoFromEpochSeconds(typeof resetsAt === "number" ? resetsAt : undefined),
      ),
    );
  }
  return windows;
}

export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const byId = new Map<string, ServerProviderUsageWindow>();
  const type: string | undefined = info.rateLimitType;
  if (type && typeof info.utilization === "number" && Number.isFinite(info.utilization)) {
    const usedPercent = percentFromFraction(info.utilization);
    const resetsAt = isoFromEpochSeconds(info.resetsAt);
    if (type in WINDOWS) {
      byId.set(type, makeWindow(type, usedPercent, resetsAt));
    } else if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
      const scoped = scopedWindow(names.overageIncluded, usedPercent, resetsAt);
      byId.set(scoped.id, scoped);
    }
  }
  for (const window of readUnifiedWindows(info)) byId.set(window.id, window);
  return byId.size === 0 ? undefined : { windows: [...byId.values()] };
}
```

Update the leading doc comment of the file ("names one window at a time") to say events list every account-wide window via `unifiedWindows`, and keep the existing `claudeRateLimitEventToUpdate` doc paragraph about the dropped overage-included event.

- [ ] **Step 1: Write the failing tests.** Add to the `claudeRateLimitEventToUpdate` describe. Fixture helper: `const info = (extra: object) => ({ status: "allowed", ...extra }) as SDKRateLimitInfo` (cast; the typings lack `unifiedWindows`). The test file does not import `SDKRateLimitInfo` today: add `import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";`, plus `import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";` for case 13. Expected windows below are full window objects as `makeWindow` produces them: five_hour = `{ id: "five_hour", kind: "session", label: "Session", windowDurationMins: 300, usedPercent, resetsAt? }`, seven_day = `{ id: "seven_day", kind: "weekly", label: "Weekly", windowDurationMins: 10080, ... }`.

| #   | Input `rate_limit_info`                                                                                                                                                                                                                                                                                                                                      | Expected `windows` (order-insensitive; assert via sorting by id)                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Real logged payload: `{ status: "allowed", resetsAt: 1791654000, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1791654000 }, seven_day: { utilization: 0.62, resetsAt: 1791828000 } } }` (no top-level utilization) | five_hour 2% reset `2026-10-10T17:40:00.000Z`; seven_day 62% reset `2026-10-12T18:00:00.000Z`                               |
| 2   | `{ status: "allowed_warning", resetsAt: 1791828000, rateLimitType: "seven_day", utilization: 0.92, unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: 1791744000 }, seven_day: { utilization: 0.92, resetsAt: 1791828000 } } }` (the spec 5.1 test)                                                                                                 | both windows: five_hour 44% reset `2026-10-11T18:40:00.000Z`, seven_day 92%                                                 |
| 3   | Same as 2 but top-level `utilization: 0.9` and unified seven_day `0.93`                                                                                                                                                                                                                                                                                      | seven_day 93 (unified wins), five_hour 44                                                                                   |
| 4   | `{ rateLimitType: "seven_day", utilization: 0.85, resetsAt: 1_784_000_000 }` with no `unifiedWindows`                                                                                                                                                                                                                                                        | exactly the existing single-window result (existing test stays as is)                                                       |
| 5   | `unifiedWindows` lists only five_hour; top-level `rateLimitType: "seven_day"`, `utilization: 0.5`                                                                                                                                                                                                                                                            | five_hour from unified plus seven_day 50 from the fallback                                                                  |
| 6   | `rateLimitType: "seven_day_overage_included"`, `utilization: 0.4`, names `{ overageIncluded: "Fable" }`, plus `unifiedWindows` with both windows                                                                                                                                                                                                             | three windows: `seven_day_fable` 40, five_hour, seven_day                                                                   |
| 7   | Same as 6 with `noNames`                                                                                                                                                                                                                                                                                                                                     | two windows (five_hour, seven_day); no scoped window                                                                        |
| 8   | `unifiedWindows: { five_hour: { utilization: 0.58 }, seven_day: { utilization: 0.07, resetsAt: 1791828000 } }`                                                                                                                                                                                                                                               | five_hour `usedPercent === 58` with no `resetsAt` key; seven_day `usedPercent === 7` (strict equality, float noise removed) |
| 9   | No `rateLimitType`, `unifiedWindows` with both windows                                                                                                                                                                                                                                                                                                       | both windows (path not gated on `rateLimitType`)                                                                            |
| 10  | Malformed: `unifiedWindows: { five_hour: { utilization: "0.5" }, seven_day: null, seven_day_opus: { utilization: 0.3 } }` and no top-level utilization                                                                                                                                                                                                       | `undefined`                                                                                                                 |
| 11  | `unifiedWindows` of `"x"`, `[]`, `null`, `7` (four sub-cases) with `rateLimitType: "five_hour"`, `utilization: 0.1`                                                                                                                                                                                                                                          | fallback five_hour 10 only                                                                                                  |
| 12  | `unifiedWindows: { five_hour: { utilization: NaN }, seven_day: { utilization: Infinity } }`                                                                                                                                                                                                                                                                  | `undefined`                                                                                                                 |
| 13  | Composition: feed case 1's result into `applyUsageLimitsUpdate` (import from `@t3tools/provider-core/server/usageLimits`) with `previous = { checkedAt, windows: [five_hour 10% with resetsAt, seven_day 20%] }`                                                                                                                                             | both windows updated to 2 and 62, other fields intact                                                                       |

Case 1 must be a literal copy of the log payload (comment: "verbatim from provider events log, 2026-10-10"), per index section 8.

- [ ] **Step 2: Run to verify they fail.** `vp test run apps/server/src/provider/claudeUsageLimits.test.ts` -> cases 1, 2, 3, 5, 6, 7, 8, 9, 13 fail; the existing cases pass.

- [ ] **Step 3: Implement** the code above.

- [ ] **Step 4: Run to verify they pass.** Same command; all green including the three pre-existing `claudeRateLimitEventToUpdate` cases.

- [ ] **Step 5: Regression check on the caller.** `vp test run apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "usage-limit pauses"` and `-t "usage limit ends the turn"` (those exercise the `rate_limit_event` branch; the adapter file is not edited). Expect pass and a non-zero matched-test count.

- [ ] **Step 6: Typecheck, lint, format.** `vp run t3#typecheck`; `vp lint apps/server/src/provider/claudeUsageLimits.ts apps/server/src/provider/claudeUsageLimits.test.ts`; `vp fmt` on the same two files.

- [ ] **Step 7: Commit.**

```sh
git add apps/server/src/provider/claudeUsageLimits.ts apps/server/src/provider/claudeUsageLimits.test.ts
git commit -m "fix(server): every Claude rate-limit event updates both usage windows

<attribution line your harness specifies>"
```

---

## Task 3: History helpers in provider-core `usageLimits.ts`

**Files:**

- Modify: `packages/provider-core/src/server/usageLimits.ts`
- Test: `packages/provider-core/src/server/usageLimits.test.ts` (plain `it` from `vite-plus/test`, as the file does)

**Interfaces:**

- Consumes: `ServerProviderUsageLimits`, `ServerProviderUsageSample` from `@t3tools/contracts` (Task 1).
- Produces (exports used by Task 4; keep constants module-private so knip stays quiet):

```ts
export type UsageHistory = ReadonlyMap<string, UsageHistoryEntry>; // key = window id
export const EMPTY_USAGE_HISTORY: UsageHistory;
export function recordUsageSamples(input: {
  readonly history: UsageHistory;
  readonly limits: ServerProviderUsageLimits | undefined;
  /** Ids the update carried. Undefined = a full read (probe): also drops lists of session windows `limits` no longer reports. */
  readonly windowIds: ReadonlySet<string> | undefined;
  readonly at: string; // the update's checkedAt
}): UsageHistory; // the same object when nothing changed
export function attachUsageHistory(
  limits: ServerProviderUsageLimits | undefined,
  history: UsageHistory,
): ServerProviderUsageLimits | undefined; // the same object when nothing to change
```

Behaviour (precise):

- Only windows with `kind === "session"` are ever recorded. The sample value is that window's `usedPercent` in `limits` (the merged, clamped value); `at` is the supplied `at`.
- Per window: the previous entry is reused only if its `resetsAt` is the same window as the new one, where "same" = both undefined, or both parse and differ by at most 60 000 ms (unparseable: string equality). Otherwise the list starts empty.
- Skip (append nothing) when the last sample has the same `usedPercent` and `at - last.at < 60_000` ms. At exactly 60 000 ms a heartbeat sample is appended.
- Order guard: if `at` is earlier than the last sample's `at` (a slow probe finishing after a newer event), the new sample is stamped with the last sample's `at`, so the list stays ascending.
- Unparseable `at`: record nothing (full mode still prunes).
- Cap: after appending keep the last 400.
- Full mode (`windowIds === undefined`): entries whose id is not a session window in `limits` are removed.
- `attachUsageHistory` sets `history` (the entry's `samples` array by reference) on session windows with a non-empty entry; removes a stale `history` from any other window; never allocates when no window changes.

Code (the D-level spot; full):

```ts
const USAGE_HISTORY_MAX_SAMPLES = 400;
const USAGE_HISTORY_HEARTBEAT_MS = 60_000;
/** The probe reports reset times as ISO strings, events as whole epoch seconds. */
const USAGE_HISTORY_RESET_TOLERANCE_MS = 60_000;

interface UsageHistoryEntry {
  readonly resetsAt: string | undefined;
  readonly samples: ReadonlyArray<ServerProviderUsageSample>;
}
export type UsageHistory = ReadonlyMap<string, UsageHistoryEntry>;
export const EMPTY_USAGE_HISTORY: UsageHistory = new Map();

function sameWindowReset(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return Math.abs(left - right) <= USAGE_HISTORY_RESET_TOLERANCE_MS;
}

export function recordUsageSamples(input: {
  readonly history: UsageHistory;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly windowIds: ReadonlySet<string> | undefined;
  readonly at: string;
}): UsageHistory {
  const { history, limits, windowIds, at } = input;
  const sessionWindows = (limits?.windows ?? []).filter((window) => window.kind === "session");
  let next: Map<string, UsageHistoryEntry> | undefined;
  const edit = () => (next ??= new Map(history));

  if (windowIds === undefined) {
    const present = new Set(sessionWindows.map((window) => window.id));
    for (const id of history.keys()) {
      if (!present.has(id)) edit().delete(id);
    }
  }
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return next ?? history;

  for (const window of sessionWindows) {
    if (windowIds !== undefined && !windowIds.has(window.id)) continue;
    const previous = history.get(window.id);
    const entry =
      previous !== undefined && sameWindowReset(previous.resetsAt, window.resetsAt)
        ? previous
        : undefined;
    const last = entry?.samples.at(-1);
    const lastMs = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.at);
    if (
      last !== undefined &&
      last.usedPercent === window.usedPercent &&
      atMs - lastMs < USAGE_HISTORY_HEARTBEAT_MS
    ) {
      continue;
    }
    const sample = {
      at: last !== undefined && lastMs > atMs ? last.at : at,
      usedPercent: window.usedPercent,
    };
    edit().set(window.id, {
      resetsAt: window.resetsAt,
      samples: [...(entry?.samples ?? []), sample].slice(-USAGE_HISTORY_MAX_SAMPLES),
    });
  }
  return next ?? history;
}

export function attachUsageHistory(
  limits: ServerProviderUsageLimits | undefined,
  history: UsageHistory,
): ServerProviderUsageLimits | undefined {
  if (limits === undefined) return limits;
  let changed = false;
  const windows = limits.windows.map((window) => {
    const samples = window.kind === "session" ? history.get(window.id)?.samples : undefined;
    const wanted = samples !== undefined && samples.length > 0 ? samples : undefined;
    if (window.history === wanted) return window;
    changed = true;
    const { history: _stale, ...rest } = window;
    return wanted === undefined ? rest : { ...rest, history: wanted };
  });
  return changed ? { ...limits, windows } : limits;
}
```

Add `ServerProviderUsageSample` to the existing `import type { ... } from "@t3tools/contracts"` at the top of the file. Add a doc comment above `recordUsageSamples` (how it is used: runtime update passes the carried ids, a probe passes `undefined`) and note `applyUsageLimitsUpdate` stays history-agnostic (its `usageWindowEquals` deliberately ignores `history`).

- [ ] **Step 1: Write the failing tests** (in `usageLimits.test.ts`; fixtures: `R1 = "2026-09-03T14:00:00.000Z"`, `T0 = "2026-09-03T12:00:00.000Z"`, helper `at(sec)` = `T0` plus `sec` seconds as ISO, `sessionWindow(usedPercent, resetsAt = R1, id = "five_hour")`, `limitsOf(...windows)`).

`recordUsageSamples`:

| #   | Setup                                                                                                            | Expected                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `EMPTY_USAGE_HISTORY`, limits [session 40, R1], `windowIds {five_hour}`, at T0                                   | `five_hour` entry `{ resetsAt: R1, samples: [{ at: T0, usedPercent: 40 }] }`; input history untouched    |
| 2   | After 1, same 40 at +30 s                                                                                        | returns the **same** history object (`toBe`)                                                             |
| 3   | After 1, same 40 at +59.999 s / at exactly +60 s                                                                 | skipped (same object) / appended (2 samples)                                                             |
| 4   | After 1, 41 at +5 s                                                                                              | appended (value change beats the heartbeat gate)                                                         |
| 5   | After 1, 41 with `resetsAt` 5 h later                                                                            | list is only the new sample; entry `resetsAt` is the new one                                             |
| 6   | After 1, 41 with `resetsAt` `2026-09-03T14:00:00.500Z` / `2026-09-03T14:00:59.000Z` / `2026-09-03T14:01:01.000Z` | first two: same window (appended, list length 2); third: new window (list length 1)                      |
| 7   | limits has a `weekly` window and a `session` window, ids carried = both                                          | only the session id has an entry                                                                         |
| 8   | two session windows A, B; `windowIds {A}`                                                                        | only A recorded; B's pre-existing entry untouched (same entry object)                                    |
| 9   | `windowIds: undefined`, history has entries A and C, limits has session A only                                   | C removed, A updated                                                                                     |
| 10  | `windowIds: undefined`, `limits: undefined`                                                                      | all entries removed (returns an empty map)                                                               |
| 11  | 405 successive changing values (alternate 10/11) each 61 s apart                                                 | list length 400; first retained sample is the 6th recorded; last is the 405th                            |
| 12  | After 1, a value 41 stamped 10 s **before** T0                                                                   | appended with `at === T0` (clamped to the last sample's `at`); list stays ascending                      |
| 13  | `at: "not a date"`                                                                                               | same history object (partial mode); full mode still prunes absent windows                                |
| 14  | window without `resetsAt` twice (40 then 41)                                                                     | one list of two (undefined === undefined is the same window); then a defined `resetsAt` -> list restarts |
| 15  | `windowIds` empty set                                                                                            | same history object                                                                                      |

`attachUsageHistory`:

| #   | Input                                                                     | Expected                                                                                                                                         |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16  | limits [session, weekly]; history has entry for the session id            | session window has `history` identical (`toBe`) to the entry's `samples`; weekly window is the same object as before; no `history` key on weekly |
| 17  | limits with no windows needing change (session window with no entry)      | returns the same `limits` object (`toBe`)                                                                                                        |
| 18  | session window already carrying `history` equal by reference to the entry | returns the same `limits` object                                                                                                                 |
| 19  | session window carrying a stale `history`, no entry in history map        | returned window has no `history` key                                                                                                             |
| 20  | a weekly window carrying `history` (misbehaving source)                   | `history` removed                                                                                                                                |
| 21  | limits with `credentialFingerprint`, `resetCredits`, `unavailable`        | all preserved on the returned object                                                                                                             |
| 22  | `limits: undefined`                                                       | `undefined`                                                                                                                                      |

- [ ] **Step 2: Run to verify they fail.** `vp test run packages/provider-core/src/server/usageLimits.test.ts` -> import errors / failures for the new functions; existing tests pass.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run to verify they pass.** Same command.
- [ ] **Step 5: Typecheck, lint, format.** `vp run @t3tools/provider-core#typecheck`; `vp lint packages/provider-core/src/server/usageLimits.ts packages/provider-core/src/server/usageLimits.test.ts`; `vp fmt` the two files.
- [ ] **Step 6: Commit.**

```sh
git add packages/provider-core/src/server/usageLimits.ts packages/provider-core/src/server/usageLimits.test.ts
git commit -m "feat(provider-core): record session usage samples per window

<attribution line your harness specifies>"
```

---

## Task 4: Wire history into `makeManagedServerProvider`

**Files:**

- Modify: `packages/provider-core/src/server/managedProvider.ts` (import line 19; `ProviderSnapshotState` line ~22; `Ref.make` of `snapshotStateRef` lines 69-72; `applySnapshotBase` modify body lines ~156-195; `applyUsageLimits` lines ~200-222)
- Test: `packages/provider-core/src/server/managedProvider.test.ts`

**Interfaces:**

- Consumes: Task 3 `EMPTY_USAGE_HISTORY`, `UsageHistory`, `recordUsageSamples`, `attachUsageHistory`; Task 1 `history` field.
- Produces: published snapshots whose session windows carry `history` per index 6.2; no change to `ManagedServerProvider` (`snapshot.ts`) or any caller.

Design (decisions made; no open choices):

- The history lives in `ProviderSnapshotState.usageHistory` (not inside `snapshot`), so one `Ref.modify` updates snapshot and history atomically. The _published_ `snapshot` also carries it (as `history` on the windows) because `getSnapshot` and `streamChanges` read the stored snapshot. Every code path that rebuilds `usageLimits` re-attaches via `attachUsageHistory`.
- `publishEnrichedSnapshot` needs no change: it already takes `state.snapshot.usageLimits` (history included) over the enrichment's copy. Add a test that proves it.
- The `checkProviderOnSettingsChange === false` branch spreads `...state`, so it preserves `usageHistory` unchanged.

Edits (full code, because ordering inside the `Ref.modify` matters):

1. State and initial value:

```ts
interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  /** Session-window samples; published as `history` on the snapshot's windows. */
  readonly usageHistory: UsageHistory;
}
// Ref.make(...) gains:  usageHistory: EMPTY_USAGE_HISTORY,
```

2. Runtime path (`applyUsageLimits`):

```ts
const snapshotToPublish =
  yield *
  Ref.modify(snapshotStateRef, (state) => {
    const usageLimits = applyUsageLimitsUpdate({
      previous: state.snapshot.usageLimits,
      update,
      checkedAt: update.checkedAt,
    });
    const usageHistory =
      update.windows.length === 0
        ? state.usageHistory
        : recordUsageSamples({
            history: state.usageHistory,
            limits: usageLimits,
            windowIds: new Set(update.windows.map((window) => window.id)),
            at: update.checkedAt,
          });
    // Both helpers hand back their input when nothing moved, which is the
    // common case for Codex's per-token notification.
    if (usageLimits === state.snapshot.usageLimits && usageHistory === state.usageHistory) {
      return [null, state] as const;
    }
    const snapshot = withUsageLimits(state.snapshot, attachUsageHistory(usageLimits, usageHistory));
    return [snapshot, { ...state, snapshot, usageHistory }] as const;
  });
```

3. Probe path (`applySnapshotBase`'s `Ref.modify`). Keep the existing `previous`, `differs`, `switchedAccount`, `usageLimits`, `workspaceId` computation exactly; after `usageLimits` is computed add:

```ts
// The probe's limits replaced what was published, or a failed read kept it.
const probeAccepted = usageLimits === probedSnapshot.usageLimits;
const fingerprintChanged = differs(
  state.snapshot.usageLimits?.credentialFingerprint,
  probedSnapshot.usageLimits?.credentialFingerprint,
);
const carried = switchedAccount || fingerprintChanged ? EMPTY_USAGE_HISTORY : state.usageHistory;
const usageHistory = probeAccepted
  ? recordUsageSamples({
      history: carried,
      limits: usageLimits,
      windowIds: undefined,
      at: usageLimits?.checkedAt ?? probedSnapshot.checkedAt,
    })
  : carried;
```

then change the snapshot assembly to `withUsageLimits(<same first argument>, attachUsageHistory(usageLimits, usageHistory))` and the returned state to `{ ...state, snapshot, enrichmentGeneration: generation, usageHistory }` (today it builds `{ snapshot, enrichmentGeneration: generation }`, which would drop the new field). Note `differs` treats an undefined side as "unknown, not a change", exactly like the existing email comparison.

Known limit, comment it in code: `applyUsageLimitsUpdate` rebuilds limits without `credentialFingerprint`, so fingerprint changes are only detected between two probes. Providers that publish a fingerprint (Antigravity, OpenCode) have no runtime updates today.

- [ ] **Step 1: Write the failing tests** in `managedProvider.test.ts`, as new `it.effect` cases in the existing describe, reusing the file's `layerAlwaysRunTest`, `maintenanceCapabilities`, `initialSnapshot`, `refreshedSnapshot` and the prelude of "applies runtime usage updates onto the published snapshot" (construct the provider with `refreshInterval: "1 hour"`, then `yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain)` to let the initial probe finish). Drive probes by making `checkProvider` read a `Ref` holding the next `ServerProvider` to return, and call `yield* provider.refresh`. Every update passes an explicit `checkedAt`, so no clock or TestClock is involved. Constants: `T0 = "2026-10-11T10:00:00.000Z"`, `R1 = "2026-10-11T15:00:00.000Z"`, `W = "2026-10-17T00:00:00.000Z"`; `probe(percent, { at, resets, workspaceId?, fingerprint?, failed? })` builds a snapshot with `five_hour` (session) and `seven_day` (weekly) windows. Read results with `provider.getSnapshot`.

| #   | Scenario (in order)                                                                                                                                                                | Expected                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Initial probe: five_hour 10 (reset R1), seven_day 20 at `checkedAt` T0                                                                                                             | snapshot windows: five_hour has `history: [{ at: T0, usedPercent: 10 }]`; seven_day has no `history` key (assert with `deepStrictEqual` on the whole `windows` array) |
| 2   | Then `applyUsageLimits` at T0+30 s: five_hour 12                                                                                                                                   | published (stream emits once); five_hour history `[{T0,10},{T0+30s,12}]`; `usedPercent` 12 equals the newest sample                                                   |
| 3   | Then `applyUsageLimits` at T0+60 s: five_hour 12 again (unchanged)                                                                                                                 | **not published**: `getSnapshot` returns the same object as before (`strictEqual`), nothing on the stream                                                             |
| 4   | Then `applyUsageLimits` at T0+95 s: five_hour 12 again                                                                                                                             | published; history gains `{T0+95s,12}` (>= 60 s after the previous sample at T0+30 s); window `usedPercent` unchanged                                                 |
| 5   | Update carries only `seven_day` 25 (percent change)                                                                                                                                | five_hour keeps its history (same array reference); seven_day has no history; one publish                                                                             |
| 6   | Update with five_hour 15 and `resetsAt` R1 + 5 h (a new window)                                                                                                                    | five_hour history is exactly `[{ at: <update>, usedPercent: 15 }]`                                                                                                    |
| 7   | Update where `resetsAt` is absent (`applyUsageLimitsUpdate` keeps the stored one)                                                                                                  | list continues (append), not cleared                                                                                                                                  |
| 8   | `refresh` with the same account, five_hour 16, `checkedAt` after the last sample                                                                                                   | history = previous samples + one probe sample; seven_day still no history                                                                                             |
| 9   | `refresh` where the probe fails (`usageLimits: { windows: [], unavailable: { reason: "probeFailed" } }`, same email/workspace)                                                     | windows and history exactly as before; no extra sample                                                                                                                |
| 10  | `refresh` returning `unavailable: { reason: "unsupported" }`                                                                                                                       | no windows, no history anywhere on the snapshot                                                                                                                       |
| 11  | Account switch: first probe `auth.workspaceId: "ws-a"` with history built up by 3 updates; next probe `ws-b`, five_hour 5                                                          | history is only the new probe's sample                                                                                                                                |
| 12  | Same as 11 but via `auth.email` change (`a@x.com` -> `b@x.com`)                                                                                                                    | cleared                                                                                                                                                               |
| 13  | Two successive probes with `credentialFingerprint` `fp-a` then `fp-b` (same email/workspace)                                                                                       | cleared on the second                                                                                                                                                 |
| 14  | Same account, two probes 5 min apart, same percent                                                                                                                                 | second probe appends (heartbeat; >= 60 s); window object otherwise unchanged                                                                                          |
| 15  | Cap: 405 `applyUsageLimits` calls alternating 10/11, 61 s apart                                                                                                                    | `history.length === 400`, first retained sample is the 6th call's                                                                                                     |
| 16  | Enrichment: provider with `enrichSnapshot` that waits on a `Deferred`; apply two runtime updates; release the enrichment (it publishes a snapshot derived from the pre-update one) | the enriched publish still carries `history` with both samples (modelled on "keeps live usage windows across a failed probe and a stale enrichment")                  |
| 17  | Update to a provider whose published snapshot has no `usageLimits` yet                                                                                                             | creates windows, records samples (history present on first publish)                                                                                                   |

- [ ] **Step 2: Run to verify they fail.** `vp test run packages/provider-core/src/server/managedProvider.test.ts` -> new cases fail (no `history`); existing cases still pass.
- [ ] **Step 3: Implement** the three edits.
- [ ] **Step 4: Run to verify they pass.** Same command, whole file green. Two existing tests assert session windows with `deepStrictEqual` and will fail once history is attached; update exactly these expectations (the only legitimate edits to existing tests, called out in the commit body): (a) "applies runtime usage updates onto the published snapshot" (line ~583): the `five_hour` window gains `history: [{ at: "2026-04-10T00:00:01.000Z", usedPercent: 10 }]` (the initial probe's sample; the seven_day-only update records nothing for five_hour); (b) "keeps live usage windows across a failed probe and a stale enrichment" (lines ~669 and ~674): replace `[liveWindow]` with `[{ ...liveWindow, history: [{ at: "2026-04-10T00:00:01.000Z", usedPercent: 10 }, { at: "2026-04-10T00:00:02.000Z", usedPercent: 60 }] }]` (probe sample, then the runtime update; the failed probe keeps both).
- [ ] **Step 5: Run the neighbours.** `vp test run packages/provider-core/src/server/usageLimits.test.ts packages/provider-core/src/server/managedProvider.test.ts apps/server/src/provider/ProviderRegistry.test.ts apps/server/src/provider/antigravityUsageLimits.test.ts packages/shared/src/usageLimits.test.ts` (these consume snapshots or `usageLimits` helpers; expect green).
- [ ] **Step 6: Typecheck, lint, format.** `vp run @t3tools/provider-core#typecheck`; `vp run t3#typecheck`; `vp lint packages/provider-core/src/server/managedProvider.ts packages/provider-core/src/server/managedProvider.test.ts`; `vp fmt` the two files.
- [ ] **Step 7: Commit.**

```sh
git add packages/provider-core/src/server/managedProvider.ts packages/provider-core/src/server/managedProvider.test.ts
git commit -m "feat(server): publish session usage history with provider snapshots

<attribution line your harness specifies>"
```

---

## Task 5: Keep `history` out of the on-disk provider status cache

**Files:**

- Modify: `apps/server/src/provider/providerStatusCache.ts` (`writeProviderStatusCache`, line ~151)
- Test: `apps/server/src/provider/providerStatusCache.test.ts` (inside the `it.layer(NodeServices.layer)` block, next to "writes and reads provider status snapshots", line ~79)

Why: `ProviderRegistry.persistProvider` writes every changed snapshot, pretty-printed, to `<baseDir>/caches/<instanceId>.json`. With history that is roughly 35 KB rewritten on every heartbeat for no benefit: `hydrateCachedProvider` never restores `usageLimits`, and the spec makes history memory-only. Clients and `ws.ts` are unaffected (the registry's in-memory snapshots keep `history`).

Behaviour: `writeProviderStatusCache` serializes the provider with `history` removed from every `usageLimits.windows[]`, leaving everything else byte-identical; a provider without any `history` (or without `usageLimits`) is serialized from the same object as today.

Code:

```ts
function withoutUsageHistory(provider: ServerProvider): ServerProvider {
  const limits = provider.usageLimits;
  if (!limits?.windows.some((window) => window.history !== undefined)) return provider;
  return {
    ...provider,
    usageLimits: {
      ...limits,
      windows: limits.windows.map(({ history: _history, ...window }) => window),
    },
  };
}
// in writeProviderStatusCache: JSON.stringify(withoutUsageHistory(cacheableProvider), null, 2)
```

- [ ] **Step 1: Write the failing test** `"does not persist session usage history"`: write a provider whose `usageLimits.windows` has a session window with a two-sample `history` and a weekly window; read the cache back with `readProviderStatusCache`. Expected: decoded `usageLimits.windows` equal the input windows minus `history`; the raw file text (`fs.readFileString`) does not contain the substring `"history"`; the in-memory input object still has its `history` (not mutated).
- [ ] **Step 2: Run to verify it fails.** `vp test run apps/server/src/provider/providerStatusCache.test.ts`.
- [ ] **Step 3: Implement** as above (import nothing new; `ServerProvider` is already imported as a type).
- [ ] **Step 4: Run to verify it passes.** Same command; the other tests in the file stay green.
- [ ] **Step 5: Typecheck, lint, format.** `vp run t3#typecheck`; `vp lint apps/server/src/provider/providerStatusCache.ts apps/server/src/provider/providerStatusCache.test.ts`; `vp fmt` the two files.
- [ ] **Step 6: Commit.**

```sh
git add apps/server/src/provider/providerStatusCache.ts apps/server/src/provider/providerStatusCache.test.ts
git commit -m "fix(server): usage history stays out of the provider status cache file

<attribution line your harness specifies>"
```

---

## Task 6: Final verification and handoff

- [ ] **Step 1: Run every touched test file together.**

```sh
vp test run packages/contracts/src/server.test.ts packages/provider-core/src/server/usageLimits.test.ts packages/provider-core/src/server/managedProvider.test.ts apps/server/src/provider/claudeUsageLimits.test.ts apps/server/src/provider/providerStatusCache.test.ts
```

- [ ] **Step 2: Typecheck the three packages touched** (one command each, never repo-wide): `vp run @t3tools/contracts#typecheck`, `vp run @t3tools/provider-core#typecheck`, `vp run t3#typecheck`. The web, mobile and desktop typechecks are not needed: the only cross-package type change is an optional property.
- [ ] **Step 3: Lint and format every changed file** (list from `git diff --name-only feat/usage-pacing`): `vp lint <files>`, `vp fmt --check <files>`.
- [ ] **Step 4: Confirm file ownership.** `git diff --name-only feat/usage-pacing` must list only the ten files in "File Structure" above (in particular, not `ClaudeAdapterV2.ts`).
- [ ] **Step 5: Surface checklist (AGENTS.md "Hit every surface"), recorded in the handoff message:** entry points n/a (server-only); clients: web/mobile/desktop ignore the optional field until P4/P5 (mobile never reads it); providers: history is generic to every provider's `session` windows (Codex `primary`, Antigravity, OpenCode, Cursor) with no per-adapter code, only Claude gets the `unifiedWindows` fix; agents/MCP n/a; contracts: optional field, old clients ignore it, old servers omit it; connection modes: same stream for local and remote; docs: none here (P4 writes `docs/user/usage.md`).
- [ ] **Step 6: Independent review.** Per the user's rules, hand the branch to a fresh reviewer (narrow code-grounding review per the plan set's policy) with this plan, the spec 5.1/5.2 and `git diff feat/usage-pacing`; fix or justify every finding before handing off.
- [ ] **Step 7: Report** the P2-contract SHA (Task 1) and the branch head; the orchestrator performs the merges (index 5).

---

## Open questions / spec deviations

Each item: what, options, recommendation. All recommendations are followed in this plan.

1. **Sub-second reset drift, so "prune on `resetsAt` change" needs a tolerance (contract 6.2 rule 2, spec 5.2).** Context: the probe's `resets_at` is an ISO string that may carry a fractional second, while `rate_limit_event.resetsAt` is whole epoch seconds, so the same window's reset can differ by under a second between sources. Options: (a) exact string equality, which would clear a window's history every time a probe and an event alternate, destroying the very data the feature needs; (b) treat resets within 60 s as the same window. A genuine rollover moves the reset by hours. Recommendation: (b), constant `USAGE_HISTORY_RESET_TOLERANCE_MS = 60_000` in `usageLimits.ts`. Changes no user-visible behaviour except preventing a bug. Spec 5.2 and contract 6.2 rule 2 can say "moves to a new window (resets differ by more than a minute)".
2. **Events round utilization to two decimals (not in the spec or contract).** Context: `0.58 * 100` is `57.99999999999999`; events and probes would never compare equal, breaking heartbeat coalescing (contract C2) and republishing on every probe/event alternation, and it leaks float noise to the UI. Options: leave raw products; round in the mapper. Recommendation: round in `claudeRateLimitEventToUpdate` with `Math.round(x * 10000) / 100`. Existing test values are unchanged. A hygiene fix for the mapper only.
3. **`providerStatusCache.ts` is edited (outside contract file ownership).** Context: the registry persists every changed snapshot to `caches/<instanceId>.json`, so history would be written to disk (about 35 KB pretty-printed per heartbeat) although spec 5.2 says no persistence and `hydrateCachedProvider` never reads `usageLimits` back. Options: leave it (harmless but wasteful disk churn and a hidden persistence); strip `history` in `writeProviderStatusCache`. Recommendation: strip it (Task 5, ten lines, no other plan touches the file). Contract deviation recorded.
4. **Heartbeat gate also governs probes.** Context: contract 6.2 rule 4 (index item C2) skips an unchanged sample within 60 s. Probes are minutes apart so they always append; two probes within 60 s with unchanged values (a manual refresh button) skip the second. Recommendation: accept; no action. A manual refresh within a minute adds no information to a burn estimate.
5. **Publish size with history.** Context: `ws.ts` resends the whole provider list as JSON on each snapshot change (200 ms debounce); a full Claude history is about 400 x 55 B = 22 KB inside every `providerStatuses` push, and a heartbeat publish happens at most once a minute per provider while a turn is active (percent changes are already published today). Options: keep 400 per spec; cap lower (for example 200); send deltas. Recommendation: keep 400 and the contract's full-list transport (a lower cap shortens the 30 min half-life window the burn needs; deltas are new protocol). Revisit only if P6 shows stream traffic problems.
6. **`credentialFingerprint` is only compared between two probes.** Context: `applyUsageLimitsUpdate` rebuilds limits without the fingerprint, so after a runtime update the published fingerprint is gone and the next probe compares against `undefined` (treated as "unknown", not a change). Only Antigravity and OpenCode publish a fingerprint and neither emits runtime updates; Claude and Codex publish none and rely on `auth.email` / `auth.workspaceId`. Options: carry the fingerprint through `applyUsageLimitsUpdate` (like `resetCredits`); document. Recommendation: document in a code comment only; carrying it would also change `shared/usageLimits.ts` account identity keys (line ~123), a separate concern.
7. **Reset-less windows.** A session window that arrives without any `resetsAt` ever (some providers) keeps one list under "undefined reset"; the first update that carries a reset restarts it. Recommendation: accept; the burn needs a reset anyway (the client returns a blank burn without `resetsAt`).
8. **Spec citation fixes for the coherence agent (index C7).** Spec 5.2 "`ManagedServerProvider` keeps ..." should name `makeManagedServerProvider` (`packages/provider-core/src/server/managedProvider.ts`; `ManagedServerProvider` is only the interface in `snapshot.ts`). Spec 5.1 should say `utilization` is a 0-1 fraction, `resetsAt` epoch seconds, that `allowed` events carry no top-level `utilization` (so most events updated nothing before this fix), and that the installed SDK typings (0.3.276) do not declare `unifiedWindows`.
9. **Index 1 / P2 says "A failed probe ... records no sample" (6.2 rule 6) and "an unsupported probe".** The index does not say what an `unsupported` result does to history. Recommendation (implemented, Task 4 case 10): a full read with no windows empties history, because the account cannot report windows at all.
