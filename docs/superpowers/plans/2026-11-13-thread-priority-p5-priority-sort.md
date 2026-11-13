# P5 · Priority sort and setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users order the Inbox by effective thread priority (user > Jira > agent) instead of "Recently returned", on web/desktop and mobile.

**Architecture:** Pure helpers in `packages/client-runtime/src/state/threadPriority.ts` (contract §6.12) compute each thread's effective priority against its own environment's scale and sort the inbox. A client setting picks the order; call sites swap `sortInboxThreadsByReturn` for `sortInboxThreadsByPriority` when it is `"priority"` and treat the inbox as time-ordered for drag/move purposes, so within-inbox reorder is off while cross-section moves still work and stored `activeOrderKey`s are never touched.

**Tech stack:** TypeScript, Effect Schema (contracts), React (web), React Native (mobile), Vitest via `vp test run`.

**Detail level:** targeted. Exact code is given for resolution and the comparator; everything else is interface plus prose.

Spec: `docs/superpowers/specs/2026-11-13-thread-priority-design.md`, sections "Effective priority and sort (client-runtime)" and "Setting". Contract: `docs/superpowers/plans/2026-11-13-thread-priority-index.md` (§4 D2/D4/D8, §6.10, §6.12, §6.13, §9, §10 Q9).

## Implementation Location
- **Branch:** feat/thread-priority-p5
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p5
- **Base branch:** feat/thread-priority

Create after P1 and P2 have merged into `feat/thread-priority` (contract §3, §5). If P3 or P4 merges first, rebase onto the integration branch before merging (`settings.ts`, `settingsSearch.ts` hunks).

## Prerequisites (from other plans; code against these)

- P1: `threadTicket.ts` exports `PriorityRef`, `ThreadTicketKey`, `ThreadTicketLink`, `DEFAULT_TICKET_PRIORITY_SCALE`, `findPriorityInScale`, `isReadableThreadTicketLink` (§6.1), re-exported from `@t3tools/contracts`; `EnvironmentThreadShell.ticketLinks` / `.priority` non-optional (§6.2).
- P2: `ServerConfig.ticketPriorityScale?: ReadonlyArray<PriorityRef>` (§6.8). `EnvironmentServerConfig` (`packages/client-runtime/src/connection/presentation.ts`, `Omit<ServerConfig, "providers">`) inherits it.

## File map

| File | Change |
| --- | --- |
| `packages/client-runtime/src/state/threadPriority.ts` | new: helpers (§6.12) |
| `packages/client-runtime/src/state/threadPriority.test.ts` | new: tables below |
| `packages/client-runtime/src/state/threadInbox.ts` | `export` the existing `InboxThreadInput` type (no behaviour change) |
| `packages/client-runtime/package.json` | subpath `"./state/thread-priority"` beside `"./state/thread-inbox"` (copy its shape) |
| `packages/contracts/src/settings.ts` | `SidebarInboxSortOrder`, default, `ClientSettingsSchema` field next to `sidebarWorkingShelfEnabled` (~L553), `ClientSettingsPatch` field (~L2072) |
| `apps/web/src/components/Sidebar.tsx` | sort at the sorted-active site in `partitionSidebarThreads` (~L679) and in `resolveDraggedOrders` (~L378-400); `useSidebarThreads` returns `priorityOrdered`; `activeTimeOrdered` at both `planSidebarThreadDrop` calls (~L2078, ~L2112) |
| `apps/web/src/components/Sidebar.logic.test.ts` | no change: `activeTimeOrdered` cases already exist (~L1133, ~L1423) |
| `apps/web/src/components/settings/SettingsPanels.tsx` | "Inbox order" row after the Working section row (~L893), restore-defaults lists (~L493, ~L696) |
| `apps/web/src/components/settings/settingsSearch.ts` | `inbox-order` entry after `working-shelf` (~L462) |
| `apps/web/src/components/CommandPalette.tsx` | `action:inbox-order` |
| `apps/mobile/src/persistence/mobile-preferences.ts` | `inboxSortOrder?: SidebarInboxSortOrder` preference (see deviation 1) |
| `apps/mobile/src/features/threads/use-thread-list-v2-shelf-preferences.ts` | expose `inboxSortOrder` |
| `apps/mobile/src/features/threads/threadListV2.ts` | `buildThreadListV2Items` input gains `inboxSortOrder?` and `priorityScaleFor?`; sort at ~L802 |
| `apps/mobile/src/features/threads/useThreadListV2.ts`, `apps/mobile/src/features/home/HomeScreen.tsx`, `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | thread the two inputs through (add them to the `buildThreadListV2Items` memo deps); skip `sectionAvailability("active")` in `moveAvailability` (~L104) under `"priority"`; `reorderSupported` (HomeScreen ~L629, ThreadNavigationSidebar ~L469) false for unpinned rows under `"priority"` |
| `apps/mobile/src/features/threads/ThreadArrangementSheet.tsx` | sort at ~L209; `reorderableEnvironmentIds` empty for `active` under `"priority"`; order option |
| `apps/mobile/src/features/settings/ThreadSettingsSections.tsx` | "Inbox order" row in `WorkingSectionSettings`' "Sidebar" section |
| `apps/mobile/src/features/threads/threadListV2.test.ts` | one case: priority order and no move-up/down for active rows |

`ThreadNavigationSidebar.tsx` (tablet/workspace sidebar) calls the same `useThreadListV2` and has its own copy of the `reorderSupported` expression, so it needs the same change as HomeScreen. `thread-list-v2-items.tsx` needs no change: its "Move up/Move down" items already hide when `reorderSupported !== true`, which HomeScreen computes.

---

### Task 1: Pure helpers in client-runtime

**Files:** create `packages/client-runtime/src/state/threadPriority.ts`, `threadPriority.test.ts`; modify `threadInbox.ts` (export `InboxThreadInput`), `packages/client-runtime/package.json`.

- [ ] **Step 1: Write the failing tests** (`threadPriority.test.ts`, plain objects built by a local `shell(overrides)` helper per §7; scale `S = DEFAULT_TICKET_PRIORITY_SCALE` unless stated).

`effectiveThreadPriority`:

| # | priority / links | scale | expected `{source, position, ticketKey}` |
| --- | --- | --- | --- |
| 1 | user High, agent Low, readable link with Highest | S | user, 1, null |
| 2 | user null, links A=Medium, B=High (both readable) | S | jira, 1, B |
| 3 | links A=High, B=High | S | jira, 1, A (first in array wins ties) |
| 4 | link status Done (`statusCategory: "done"`) with Low | S | jira, 3 |
| 5 | link with `syncError: "not_found"` priority Highest; agent Low | S | agent, 3 |
| 6 | link `source: "branch-dismissed"` with Highest | S | null |
| 7 | link `snapshot: null`; agent null | S | null |
| 8 | user `{id: "10003", name: "Medium"}` | `[{id:"10001",name:"Blocker"},{id:"10003",name:"Medium"}]` | user, 1 (id match) |
| 9 | user `{id: "default:high", name: "high"}` | Jira scale containing `{id:"2",name:"High"}` at index 1 | user, 1 (case-insensitive name fallback) |
| 10 | user `{id:"x",name:"Gone"}`, link High | S | jira, 1 (unresolvable falls through) |
| 11 | everything empty | S | null |

`threadJiraRank`: readable ranks `"0|i0000b:"`, `"0|i00003:"` → `"0|i00003:"`; a smaller rank on a link with `syncError` is ignored; `"0|Z"` vs `"0|a"` → `"0|Z"` (code-unit order, not `localeCompare`); no ranks → `null`.

`sortInboxThreadsByPriority` (observedReturnAt omitted; timestamps via `createdAt`, newer = earlier in return order):

| Input threads (id: priority, rank, createdAt) | Expected order |
| --- | --- |
| a: none t3; b: Low t1; c: High t2 | c, b, a |
| a: High rank "0|b" t1; b: High rank "0|a" t1; c: High no rank t3 | b, a, c |
| a: none rank "0|a" t1; b: none t2 | b, a (rank ignored without priority) |
| a: High t1; b: High t2 (no ranks) | b, a (return order tie-break) |
| a (env E1, scale with 3 entries): user=entries[2]; b (env E2, default): Medium | b (pos 2) and a (pos 2) tie → return order (D8: position only across environments) |

`ticketPriorityScaleOf`: `undefined`/`null`/`{}`/`{ticketPriorityScale: []}` → `DEFAULT_TICKET_PRIORITY_SCALE`; non-empty array → same array.

- [ ] **Step 2: Run** `vp test run packages/client-runtime/src/state/threadPriority.test.ts` — expect failure (module missing).

- [ ] **Step 3: Implement** `threadPriority.ts` exactly:

```ts
import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  findPriorityInScale,
  isReadableThreadTicketLink,
  type PriorityRef,
  type ThreadTicketKey,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { sortInboxThreadsByReturn, type InboxThreadInput } from "./threadInbox.ts";

export type ThreadPrioritySource = "user" | "jira" | "agent";

export interface EffectiveThreadPriority {
  readonly ref: PriorityRef;
  readonly source: ThreadPrioritySource;
  readonly position: number;
  readonly ticketKey: ThreadTicketKey | null;
}

type PriorityThreadInput = Pick<EnvironmentThreadShell, "ticketLinks" | "priority">;

export function effectiveThreadPriority(
  thread: PriorityThreadInput,
  scale: ReadonlyArray<PriorityRef>,
): EffectiveThreadPriority | null {
  const user = thread.priority.user && findPriorityInScale(scale, thread.priority.user);
  if (user) return { ...user, source: "user", ticketKey: null };
  let jira: EffectiveThreadPriority | null = null;
  for (const link of thread.ticketLinks) {
    const ticketPriority = isReadableThreadTicketLink(link) ? link.snapshot?.priority : null;
    if (!ticketPriority) continue;
    const match = findPriorityInScale(scale, ticketPriority);
    if (match && (jira === null || match.position < jira.position)) {
      jira = { ...match, source: "jira", ticketKey: link.key };
    }
  }
  if (jira) return jira;
  const agent = thread.priority.agent && findPriorityInScale(scale, thread.priority.agent);
  return agent ? { ...agent, source: "agent", ticketKey: null } : null;
}

export function threadJiraRank(thread: Pick<EnvironmentThreadShell, "ticketLinks">): string | null {
  let best: string | null = null;
  for (const link of thread.ticketLinks) {
    const rank = isReadableThreadTicketLink(link) ? (link.snapshot?.rank ?? null) : null;
    // LexoRank compares by code unit; localeCompare would reorder case and punctuation.
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

export function sortInboxThreadsByPriority<T extends InboxThreadInput & PriorityThreadInput>(
  threads: readonly T[],
  scaleFor: (thread: T) => ReadonlyArray<PriorityRef>,
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const returnIndex = new Map(
    sortInboxThreadsByReturn(threads, observedReturnAt).map((thread, index) => [thread, index]),
  );
  const keys = new Map(
    threads.map((thread) => [
      thread,
      {
        position: effectiveThreadPriority(thread, scaleFor(thread))?.position ?? Infinity,
        rank: threadJiraRank(thread),
      },
    ]),
  );
  return [...threads].sort((left, right) => {
    const a = keys.get(left)!;
    const b = keys.get(right)!;
    if (a.position !== b.position) return a.position - b.position;
    if (a.position !== Infinity && a.rank !== b.rank) {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank < b.rank ? -1 : 1;
    }
    return returnIndex.get(left)! - returnIndex.get(right)!;
  });
}

export function ticketPriorityScaleOf(
  config: { readonly ticketPriorityScale?: ReadonlyArray<PriorityRef> } | null | undefined,
): ReadonlyArray<PriorityRef> {
  const scale = config?.ticketPriorityScale;
  return scale && scale.length > 0 ? scale : DEFAULT_TICKET_PRIORITY_SCALE;
}
```

Notes: `findPriorityInScale` returns `{ ref, position }`, which the spreads above turn into the §6.12 shape. If the implementer finds `EnvironmentThreadShell.priority` typed optional after P1 (contract says non-optional), stop and report rather than adding `?.` silently.

- [ ] **Step 4:** Export `InboxThreadInput` from `threadInbox.ts`; add the `./state/thread-priority` subpath in `package.json` mirroring `./state/thread-inbox`.
- [ ] **Step 5: Run** the test file (pass) and `vp run @t3tools/client-runtime#typecheck`.
- [ ] **Step 6: Commit** `feat(client-runtime): effective thread priority and priority inbox sort`.

### Task 2: Client setting

**Files:** `packages/contracts/src/settings.ts`.

- [ ] Add exactly the §6.10 block: `SidebarInboxSortOrder` (`Schema.Literals(["returned", "priority"])`), its type, `DEFAULT_SIDEBAR_INBOX_SORT_ORDER = "returned"`, `ClientSettingsSchema.sidebarInboxSortOrder` with `Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_INBOX_SORT_ORDER))` next to `sidebarWorkingShelfEnabled`, and `ClientSettingsPatch.sidebarInboxSortOrder: Schema.optionalKey(SidebarInboxSortOrder)`. `DEFAULT_UNIFIED_SETTINGS` derives from `DEFAULT_CLIENT_SETTINGS = decodeSync(ClientSettingsSchema)({})`, so the decoding default is enough.
- [ ] If an existing settings decode test lists client-setting defaults, add the field there (extend, do not add a new test). Run it plus `vp run @t3tools/contracts#typecheck`.
- [ ] Commit `feat(contracts): inbox sort order client setting`.

### Task 3: Web sidebar

**Files:** `apps/web/src/components/Sidebar.tsx`, possibly `Sidebar.logic.test.ts`.

Behaviour:
- Read `const inboxSortOrder = useClientSettings((s) => s.sidebarInboxSortOrder)` beside the `sidebarWorkingShelfEnabled` read (~L442), and compute `priorityOrdered` inside `useSidebarThreads`, add `inboxSortOrder`/`priorityOrdered` to `SidebarThreadPartitionInput` (`partitionSidebarThreads` already receives `serverConfigs`) and return `priorityOrdered` next to `workingShelfEnabled` (the `Sidebar` component destructures that return at ~L1303 and has no other access to it). Pass it to `resolveDraggedOrders` (~L378, returns `{settledOrder, activeOrder}`) as a new input together with `serverConfigs`, which it does not have today (call site ~L2034).
- `const priorityOrdered = inboxSortOrder === "priority" && folderGroups === null` (the boring sidebar keeps its by-send order; see deviation 3).
- `scaleFor = (thread) => ticketPriorityScaleOf(serverConfigs.get(thread.environmentId))`.
- Sorted-active site (~L679): `sortActiveBySend ? sortWorkingThreadsBySend(active) : priorityOrdered ? sortInboxThreadsByPriority(active, scaleFor, inboxObservation.returnedAt) : workingShelfEnabled ? sortInboxThreadsByReturn(...) : sortThreadsForSidebar(active)`. Priority applies with the Working section on or off (contract Q9, decided yes). With the Working section off, `inboxReturns.observe(null)` records no returns, so the within-level tie-break is `sortInboxThreadsByReturn` over the thread's own timestamps (created, unsettled, latest run), not the Working-off `sortThreadsForSidebar` / manual `activeOrderKey` order (see open question 6).
- `resolveDraggedOrders` (~L395): `activeOrder` is computed when `workingShelfEnabled || priorityOrdered`, using `sortInboxThreadsByPriority` when `priorityOrdered`, else the existing call.
- Both `planSidebarThreadDrop` calls: `activeTimeOrdered: workingShelfEnabled || priorityOrdered`. The existing `activeTimeOrdered` branch already returns `none` for active→active and `move-active` with `order: null, assignments: []` for cross-section drops, so no `activeOrderKey` is written or cleared. `activeReorderableThreadKeys` stays as is (it also gates writability of cross-section moves).
- Keep the memoization the call sites already have; the sort is O(n log n) with one priority resolution per thread.

- [ ] `Sidebar.logic.test.ts` already covers `activeTimeOrdered: true` (~L1133, ~L1423) and the planner is unchanged: add nothing.
- [ ] `vp test run apps/web/src/components/Sidebar.logic.test.ts`, `vp run @t3tools/web#typecheck`.
- [ ] Commit `feat(web): priority inbox order in the sidebar`.

### Task 4: Web settings, search and command palette

**Files:** `SettingsPanels.tsx`, `settingsSearch.ts`, `CommandPalette.tsx`.

- [ ] `settingsSearch.ts`: add `{ id: "inbox-order", title: "Inbox order", to: "/settings/general", searchTerms: ["inbox sort order priority jira recently returned"] }` right after `working-shelf`.
- [ ] `SettingsPanels.tsx`: a `SettingsRow {...searchableSetting("inbox-order")}` right after the Working section row in the same `SettingsSection`. Control: the same `Select` pattern as the row above it (~L870–890) with items "Recently returned" (`returned`) and "Priority" (`priority`). Description: "Recently returned shows threads that most recently needed you first. Priority sorts by your priority, then the linked Jira ticket's, then the agent's guess." Reset action like the Working section row. Add the field to both restore-defaults lists (~L493 "changed" list with label "Inbox order", ~L696 reset object).
- [ ] `CommandPalette.tsx`: one action pushed to `actionItems` next to the general actions near `action:use-in-another-app` (there are no sidebar sort entries in the palette, contract §1 P5). `value: "action:inbox-order"`, title is the opposite of the current order — "Sort inbox by priority" when `returned`, "Sort inbox by recently returned" when `priority` — `searchTerms: ["inbox", "sort", "order", "priority", "recently returned"]`, run = `updateSettings({ sidebarInboxSortOrder: next })` using `updateClientSettings` from `apps/web/src/hooks/useSettings.ts` (~L747; a plain client-settings patch, no scope hook) and read the current order with `useClientSettings` (already imported in `CommandPalette.tsx`). Icon: an existing lucide sort icon.
- [ ] `vp run @t3tools/web#typecheck`; no UI tests (copy and wiring, AGENTS.md "Verifying").
- [ ] Commit `feat(web): inbox order setting and command`.

### Task 5: Mobile

**Files:** listed in the file map.

- [ ] Preference: add `inboxSortOrder?: SidebarInboxSortOrder` to both preference types in `mobile-preferences.ts` and parse it like `workingShelfEnabled` (accept only `"returned" | "priority"`). Expose `inboxSortOrder` (default `"returned"` until loaded) from `useThreadListV2ShelfPreferences`.
- [ ] `buildThreadListV2Items` input: `inboxSortOrder?: SidebarInboxSortOrder`, `priorityScaleFor?: (thread: EnvironmentThreadShell) => ReadonlyArray<PriorityRef>`. At ~L802: when `inboxSortOrder === "priority"`, `orderedActive = sortInboxThreadsByPriority(active, priorityScaleFor ?? (() => DEFAULT_TICKET_PRIORITY_SCALE), input.inboxReturnAt)` (no `applyPendingThreadOrder`, since pending orders only come from manual moves, which are off); otherwise the existing expression. Search results path (the early `return` above ~L780) is unchanged.
- [ ] HomeScreen, ThreadNavigationSidebar and useThreadListV2: pass `inboxSortOrder` and `priorityScaleFor = (t) => ticketPriorityScaleOf(configs.get(t.environmentId))` from `environmentServerConfigsAtom`. `reorderSupported` for unpinned rows (HomeScreen ~L629 and `ThreadNavigationSidebar.tsx` ~L469) becomes `!workingShelfEnabled && inboxSortOrder !== "priority" && activeReorderEnvironmentIds.has(...)`.
- [ ] `ThreadArrangementSheet.tsx`: `active` uses `sortInboxThreadsByPriority` under `"priority"` (else the existing branch); `reorderableEnvironmentIds` for `active` is `new Set()` when `workingShelfEnabled || priority`. Section moves (`onSectionMove`) stay. Add an order option at the top of the sheet: a two-option segmented control / row toggle labelled "Inbox order" (Recently returned / Priority) writing the preference, using whatever segmented or switch component the sheet's neighbours use.
- [ ] `ThreadSettingsSections.tsx` `WorkingSectionSettings`: add an "Inbox order" row in the same "Sidebar" section (picker with the two options) so the setting is findable outside the sheet.
- [ ] In `useThreadListV2.ts` the `moveAvailability` memo adds `...(workingShelfEnabled ? [] : sectionAvailability("active"))`; extend that condition with `|| inboxSortOrder === "priority"` (and its deps), otherwise canMoveUp/canMoveDown are computed from the time-ordered list.
- [ ] Test: extend `threadListV2.test.ts` with one case: three active threads with priorities, `inboxSortOrder: "priority"` → priority order. Run `vp test run apps/mobile/src/features/threads/threadListV2.test.ts`, `vp run @t3tools/mobile#typecheck`.
- [ ] Commit `feat(mobile): priority inbox order`.

### Task 6: Verify and hand off

- [ ] `vp run check:changed` in the P5 worktree; fix findings.
- [ ] Integrated real-client pass (primary agent, Testing Strategy below).
- [ ] Independent fresh-context review of the branch diff against this plan and spec sections (contract §8); fix or justify every finding; report them at handoff.
- [ ] Merge forward per contract §5 (`git merge --no-ff feat/thread-priority-p5 -m "merge: P5"` from the clean integration worktree).

## Testing Strategy

- **Hermetic:** `threadPriority.test.ts` carries all precedence, resolution, rank and comparator cases (the lowest layer; not repeated in web/mobile). One mobile `threadListV2` case proves the call site switches sort. One `planSidebarThreadDrop` row only if no `activeTimeOrdered` case exists. Contracts settings decode default via an existing test if one lists defaults. Commands: `vp test run <files>`, the typecheck commands in contract §8, then `vp run check:changed`.
- **End-to-end (primary agent, once after integrating):** `vp run dev` in the P5 worktree with its seeded `.t3` (never `~/.t3/userdata`). Without P3/P6 merged there is no UI to set priority, so seed priorities by dispatching `thread.priority.set` through the dev server (P1's command over `orchestration.dispatchCommand`, e.g. via the dev MCP `t3_*` tools or a one-off client script in the scratchpad) on 3–4 threads with different levels. Verify with `test-t3-app`: switching Settings > General > Inbox order to Priority reorders the inbox (Working section on and off); the command palette action toggles it; dragging within the inbox does nothing under Priority, dragging a settled thread into the inbox still works, and switching back to Recently returned restores the previous order (no `activeOrderKey` change: check the thread shells before and after). Mobile with `test-t3-mobile`: the arrangement sheet option and Settings row switch order; "Move up/Move down" is absent for inbox rows under Priority.
- **Visual:** screenshot the web Settings row (light and dark), the sidebar under both orders, the mobile sheet and settings row; view each image and check alignment with neighbouring rows.
- **Skipped:** Jira-sourced priority end-to-end (needs P2+P3 sync against the real site) is covered hermetically here and end-to-end in P7.

## Open questions / spec deviations

1. **Mobile does not read `ClientSettings`; it stores the order as a mobile preference.** Context: contract §6.10 and the scope put `sidebarInboxSortOrder` in `ClientSettingsSchema`. The mobile app keeps its sidebar preferences (including `workingShelfEnabled`) in `apps/mobile/src/persistence/mobile-preferences.ts`, not in `ClientSettings` (no mobile file references `ClientSettings`). Options: (a) web uses `ClientSettings.sidebarInboxSortOrder`, mobile a parallel `inboxSortOrder` preference typed with the shared `SidebarInboxSortOrder`; (b) wire `ClientSettings` into mobile. Recommendation: (a), same as the Working section today; (b) is a broader change outside this feature.
2. **`ticketPriorityScaleOf` also falls back on an empty scale.** Context: §6.12 says "the config's scale or the default". A Jira site that returns no priorities would make user and agent priorities unresolvable and the Priority submenu empty. Options: fall back only when absent (contract) or also when empty. Recommendation: also when empty (code above); harmless where the scale is non-empty.
3. **The boring sidebar (Labs, project groups) keeps its own order.** Context: with `folderGroups !== null`, `Sidebar.tsx` sorts active threads by send (`sortActiveBySend`) and disables drag. Options: apply priority there too or leave it. Recommendation: leave it; it is a project-grouped view, not the Inbox, and the setting is named "Inbox order". Priority does apply with the Working section on and off (contract Q9).
4. **Mobile Settings also gets the row.** Context: the contract leaves this to P5. Recommendation: add it next to the Working section switch so the order is discoverable outside the arrangement sheet; it is one row.
5. **No capability gate on the setting.** Context: D2 gates dispatching ticket/priority commands, not reading. Threads from servers without `threadTickets` decode to empty priority and simply sort as unprioritized in return order. Recommendation: show the setting unconditionally.
6. **Tie-break with the Working section off (coherence pass).** Context: the spec says the within-level tie-break is "the Recently returned order" and Goal 4 says unranked threads follow "newest-returned first". With the Working section on, "Recently returned" is `sortInboxThreadsByReturn`. With it off, today's inbox order is `sortThreadsForSidebar` plus hand-made `activeOrderKey`s, and `inboxReturns` observes nothing. Options: (a) one comparator everywhere: tie-break by `sortInboxThreadsByReturn` on thread timestamps (planned); (b) with the Working section off, tie-break by the current `sortThreadsForSidebar`/manual order, so hand-curated order survives inside a priority level. Recommendation: (a). It is one rule, matches Goal 4's "newest-returned first", and stored manual order still returns intact when the user switches back to "Recently returned". Listed in the index "Decisions needed".
