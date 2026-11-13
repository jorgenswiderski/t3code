# P6 Ticket and priority UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is at **interface** detail: files, exact names, types and behaviour in prose, test tables, commands. It contains no implementation code; write it test-first from the tables.

**Goal:** Users see where a thread's priority comes from and can act on it from every place they already act on threads: a priority glyph on sidebar rows, ticket chips in the thread details card, a Priority submenu, a "Link Jira ticket" dialog and per-ticket unlink in the thread context menu and command palette, and the same on mobile; plus the user docs.

**Architecture:** One pure presentation module in `packages/client-runtime` (glyph level, tooltip text, chip model, menu model, availability gating, menu-action-id parsing) is the single place the web and mobile UIs read these decisions from, so they cannot drift. The UI never resolves priority itself: it calls P5's `effectiveThreadPriority` with the thread's own environment scale. Mutations are P1's client commands over `orchestration.dispatchCommand`; no new transport, no contract change.

**Tech Stack:** React 19 and Tailwind 4 (web, desktop), React Native with Uniwind (mobile), Effect atoms, vitest through `vp test run`.

**Spec:** `docs/superpowers/specs/2026-11-13-thread-priority-design.md`, section "Client UI". **Contract:** `docs/superpowers/plans/2026-11-13-thread-priority-index.md` (read §4 D2/D4, §6.1, §6.5, §6.8, §6.12, §6.13, §9, §10 Q8 first). Line numbers below were checked at `ddec2d528a`; re-locate by symbol before editing.

## Implementation Location

This plan ships as two PRs (the contract allows it). Web and desktop first; mobile starts after the web branch has merged, because it imports the shared presentation module the web branch creates.

- **Branch:** feat/thread-priority-p6
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p6
- **Base branch:** feat/thread-priority

- **Branch:** feat/thread-priority-p6-mobile
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p6-mobile
- **Base branch:** feat/thread-priority

Create the web worktree only after P5 has merged into `feat/thread-priority` (P1 and P2 are then merged too). Create the mobile worktree after the web branch has merged into `feat/thread-priority`. Create each with the `git-tools:worktree` skill (or `git worktree add -b <branch> <path> feat/thread-priority` from `/home/lima/workspace/t3code`), then follow AGENTS.md "Dev servers": wait for `.t3/setup-running`, run `vp i` only if no marker exists. If the integration branch moves while a branch is open, rebase the child onto it (never back-merge); rebasing a pushed branch needs the user's permission.

## Dependencies on other plans (code against these; stop and report if one is missing)

| Needs | From | Exact name |
| --- | --- | --- |
| `ThreadTicketLink`, `PriorityRef`, `ThreadTicketKey`, `ThreadPriority`, `parseTicketReference`, `jiraBrowseUrl`, `visibleThreadTicketLinks`, `findPriorityInScale`, `DEFAULT_TICKET_PRIORITY_SCALE`, `EMPTY_THREAD_PRIORITY` | P1 | `@t3tools/contracts` (§6.1) |
| `ExecutionEnvironmentCapabilities.threadTickets` | P1 | `packages/contracts/src/environment.ts` (§6.8) |
| `EnvironmentThreadShell.ticketLinks` and `.priority`, non-optional | P1 | §6.2 |
| `threadEnvironment.linkTicket`, `.unlinkTicket`, `.setPriority` (labels `environment-data:commands:thread:link-ticket` etc.; input `{ environmentId, input: { threadId, ... } }` like `updateMetadata`) | P1 | §6.5; web `apps/web/src/state/threads.ts`, mobile `apps/mobile/src/state/threads.ts` |
| `ServerConfig.ticketPriorityScale?` and `ServerConfig.jiraStatus?` (`state: "disconnected" \| "connected" \| "error"`, `error: { kind, message, since } \| null`), `ServerConfig.settings.jira?.siteUrl` | P2 | §6.6, §6.8 |
| `effectiveThreadPriority`, `ticketPriorityScaleOf`, `EffectiveThreadPriority` | P5 | `@t3tools/client-runtime/state/thread-priority` (§6.12) |

Gating facts every task relies on (contract §10 Q8, P7 criterion A2):

- **Priority UI** (indicator, Priority submenu, palette priority actions) needs `capabilities.threadTickets === true` on the thread's environment. It works with no Jira at all, on the default scale.
- **Link UI** ("Link Jira ticket…" item, palette action, "+" in the details section) additionally needs `jiraStatus.state` present and not `"disconnected"`. A missing `jiraStatus` counts as disconnected.
- **Existing links always render and can always be unlinked**, whatever the Jira state, so a disconnect never creates a one-way door.
- Each thread is judged by its own environment's config (multi-environment, remote and tunnel connections all follow from this).
- Mutating actions need `AuthOrchestrationOperateScope` on that environment (web: `readEnvironmentScope`, `useOrchestrationCommand`; mobile: `useEnvironmentScope`). Read-only clients see the indicator and chips and get disabled or absent actions.

## Hit every surface (AGENTS.md checklist, walked)

| Entry | Applies? | Decision |
| --- | --- | --- |
| Entry points: chat/sidebar thread context menu | yes | Task 3 (`buildThreadActionMenuItems`, wired at both call sites: `Sidebar.tsx` `handleThreadContextMenu` and `useThreadActionMenu.ts`) |
| Entry points: command palette | yes | Task 7: `action:thread-priority`, `action:link-jira-ticket`, `action:unlink-jira-ticket:<KEY>` (values pinned by contract §6.13) |
| Entry points: thread details card chips | yes | Task 6 |
| Entry points: Settings | no | Priority has no setting of its own. "Inbox order" is P5, the Jira connection is P2. The details card item toggle ("Jira tickets") appears in the existing Thread details row automatically (Task 6) |
| Entry points: keybinding | no | Not high frequency and every keybinding needs a contract command id, default binding and conflict review. Recorded, not built |
| Entry points: sidebar multi-select menu (`handleMultiSelectContextMenu`) | no | Bulk priority is not in the spec. Recorded as an open question |
| Entry points: search-result rows, palette thread rows | no | They show no pin, snooze or PR state either; the indicator belongs to sidebar rows only |
| Clients: web | yes | Tasks 1-8 |
| Clients: desktop | yes, no extra code | Wraps the web bundle. The native context menu already renders `children`, `checked`, `separatorBefore`, and shows `detail` as a label suffix (`apps/desktop/src/electron/ElectronMenu.ts`). Verify the Priority submenu there in the integrated pass |
| Clients: mobile | yes | Tasks M1-M3 |
| Providers | no | UI only; nothing here is provider-shaped. P4 owns adapter instruction decisions |
| Agents (MCP) | covered elsewhere | Every UI action here has a P4 tool backed by the same `ThreadTicketService` and reducer (link, unlink, set priority). The UI adds no capability an agent lacks |
| Contracts | none changed | P6 adds no wire type. It only reads P1/P2/P5 types |
| Reverse states | yes | Priority: set and "Clear my priority" (enabled only when a user value exists). Tickets: link and unlink (chip control, menu, palette); unlinking a branch-detected ticket tombstones it, so it stays gone (P1 reducer). Indicator shows the fallback source after a clear |
| Connection modes | yes | All reads come from the thread's environment shell and config, so local, remote/relay and tunnel behave the same; an older remote server without `threadTickets` shows no ticket UI at all |
| Docs | yes | Task 8 (`docs/user/jira-tickets.md`, `thread-sidebar.md`, `docs/README.md` index) |

## Verified facts the tasks rely on

- `SidebarThreadSummary` is an alias of `EnvironmentThreadShell` (`apps/web/src/types.ts` ~L107), so P1's shell fields reach every sidebar row with no mapping.
- The sidebar row is `SidebarThreadRow` in `apps/web/src/components/sidebar/SidebarThreadRow.tsx` with variants `card | slim | folder | folder-multiline`. All variants render `pinIndicator` (left of the status slot); the card puts it in the first line next to the project favicon. `variantAction === "unsettle"` marks a settled row; `"unsnooze"` a snoozed one. Nested `Tooltip`s inside the row already exist (pin, draft indicator), so a nested tooltip is safe.
- The existing glyph in the row's status slot (`ThreadContextGlyphBadge`) is replaced by hover controls, so the priority indicator must be a separate element beside the pin, not inside that slot.
- Thread context menus are built by `buildThreadActionMenuItems` (`apps/web/src/components/threadActionMenu.logic.ts`) and consumed at two call sites with duplicated switch statements: `Sidebar.tsx` `handleThreadContextMenu` (~L2592) and `apps/web/src/hooks/useThreadActionMenu.ts` (used only by `ChatHeader.tsx`, which therefore also serves the header title menu). Menu items are `ContextMenuItem<T>` with `children`, `checked`, `detail`, `separatorBefore`, `disabled`. Ids not in `threadActionRequiresOperate`'s read-only list already require the operate scope, so new ids are gated by default.
- The details card sections are `ThreadDetailsSection` blocks in `apps/web/src/components/chat/ThreadDetailsPanel.tsx` (`ThreadServersPanel`, `ThreadAutomationsPanel` are the models), rows are `ThreadDetailsControl` parts (`row`, `icon`, `meta`), visibility comes from `THREAD_DETAILS_ITEMS` in `threadDetailsItems.ts` (ids are persisted in client settings, so add, never rename). `ThreadDetailsItemsMenu` and `settings/ThreadDetailsItemsRow.tsx` iterate that list, so a new item appears in both with no further code. `ThreadDetailsPrRow(s).tsx` is the PR row styling to match.
- The link-PR dialog pattern: an atom holding the target `ScopedThreadRef`, an `open…Dialog(threadRef)` function, and a `…DialogHost` mounted once in `ChatView.tsx` (~L4086, `LinkPullRequestDialogHost`) so it survives the palette closing (`apps/web/src/components/pullRequest/LinkPullRequestDialog.tsx`).
- `Badge` (`components/ui/badge.tsx`) already has `variant` values `success`, `info`, `warning`, `error`, `secondary` and `size="sm"`: the chip status badge uses a variant, never `className` restyling (AGENTS.md Taste, lint `shadcn/no-restyle`).
- Web opens external links with `useOpenLink(threadRef)` (`apps/web/src/browser/useOpenLink.ts`), which honours the user's "Open links in" setting. Mobile uses `tryOpenExternalUrl(url, target)` (`apps/mobile/src/lib/openExternalUrl.ts`); its `ExternalUrlTarget` literal list has no ticket entry yet.
- Command palette: `activeThread` and `activeThreadServerConfig` exist in `CommandPalette.tsx` (~L486, ~L1414); the PR link entries (`action:link-pull-request`, ~L1419) are the model; submenu items are `kind: "submenu"` with `groups` of `kind: "action"` items.
- Mobile: row menu is built from `MenuAction[]` pieces combined by `layoutThreadListV2RowMenuActions` (`apps/mobile/src/features/threads/threadListV2.ts` ~L141) inside `ThreadListV2Row` (`thread-list-v2-items.tsx` ~L646), and rows already call atom commands directly (`threadEnvironment.visit`), so row-level hooks are an existing pattern. `useThreadListActions` is threaded through three consumers (`HomeRouteScreen`, `ThreadNavigationSidebar`, `ThreadArrangementSheet`); adding handlers there would touch all three for no gain (see deviation 1). Sheets follow `ThreadPullRequestsSheet.tsx` + `LinkedPullRequestList.tsx` + `useLinkedPullRequestActions.ts`, registered in `apps/mobile/src/Stack.tsx` (~L685, `sheetRoute`) and listed in `features/layout/workspace-overlay-routes.ts`. `Dialog.prompt` exists for text entry. The thread screen bar is `ThreadHeader.tsx` (`actions: AppBarAction[]`, `menus`).
- Electron/desktop context menu support for `detail` is a label suffix `Label (detail)`.

## Review focus

Things the obvious implementation gets wrong, most likely first. Each has a test or an integrated-pass check named in brackets.

1. **Unresolvable stored priority becomes invisible.** A user priority of "Expedite" after reconnecting to a site whose scale lacks it resolves to nothing, the thread silently drops out of priority order, and the menu offers nothing to see. The spec says such a value "still displays". The indicator must show a neutral "not on this scale" state and "Clear my priority" must stay enabled. [Task 1 indicator rows 7-9]
2. **Menu "checked" and "Clear" wrong for stale refs.** Check state must come from resolving `priority.user` against the current scale (id, then name), not from raw id equality; "Clear my priority" is enabled iff `priority.user !== null`, even when unresolvable. [Task 1 menu rows]
3. **Done tickets and chips.** A Done ticket still counts, so its chip must look settled (success tone) but never hidden, and the indicator must still name that ticket. [Task 1 chip rows 1-3, indicator row 4]
4. **Gating regressions.** Without Jira the Priority submenu must still work and no Link item may appear; with an older server nothing at all appears; after a disconnect existing chips and unlink remain. [Task 1 availability rows; integrated pass]
5. **Per-row cost.** A row with no links and no priority must mount nothing and subscribe to nothing new (AGENTS.md performance). Only rows with ticket data mount the indicator child, which reads its environment config through a selector atom, not the full config map. [Task 5]
6. **Duplicated switch statements.** The context-menu actions are handled in two places; both must route ticket actions through the one shared hook or one of them silently loses the feature (header title menu vs sidebar right-click). [Task 3]
7. **Branch-detected ticket unlink.** After unlinking, the chip disappears (the tombstone is `branch-dismissed`, hidden by `visibleThreadTicketLinks`); never render the tombstone. [Task 1 chip rows, Task 6]
8. **Stale data shown as current.** When `jiraStatus.state === "error"`, the details section and mobile sheet say the data is the last known, with the error time (anti-goal: a stale order presented as current). [Task 6, M2]

## File structure

### Web PR (`feat/thread-priority-p6`)

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/client-runtime/src/state/threadTicketPresentation.ts` | create | Pure decisions shared by web and mobile (Task 1 lists the exports) |
| `packages/client-runtime/src/state/threadTicketPresentation.test.ts` | create | Tables in Task 1 |
| `packages/client-runtime/package.json` | modify | Subpath `"./state/thread-ticket-presentation"` beside `"./state/thread-priority"` (copy its shape) |
| `apps/web/src/components/threadActionMenu.logic.ts` (+ `.test.ts`) | modify | New menu ids and a `tickets` state input; menu items for Priority, Link, Unlink |
| `apps/web/src/contextMenuFallback.ts` | modify | Add `flag`, `link`, `unlink` icon entries used by the new menu items |
| `apps/web/src/hooks/useThreadTicketActions.ts` | create | One hook performing the ticket menu actions with failure toasts, used by both menu call sites |
| `apps/web/src/hooks/useThreadActionMenu.ts` | modify | Build `tickets` state, delegate ticket actions |
| `apps/web/src/components/Sidebar.tsx` | modify | Same, in `handleThreadContextMenu`; mount the indicator child in the row props path if needed |
| `apps/web/src/components/tickets/LinkTicketDialog.tsx` | create | Atom, `openLinkTicketDialog(threadRef)`, `LinkTicketDialogHost` |
| `apps/web/src/components/ChatView.tsx` | modify | Mount `LinkTicketDialogHost` next to `LinkPullRequestDialogHost` |
| `apps/web/src/components/tickets/ThreadPriorityIndicator.tsx` | create | Row glyph + tooltip, `data-thread-priority*` hooks |
| `apps/web/src/components/sidebar/SidebarThreadRow.tsx` | modify | Render the indicator beside `pinIndicator` in every variant |
| `apps/web/src/components/chat/ThreadTicketsPanel.tsx` | create | Details-card section with ticket rows, unlink and "+" link |
| `apps/web/src/components/chat/ThreadDetailsPanel.tsx` | modify | Mount the section |
| `apps/web/src/components/chat/threadDetailsItems.ts` (+ test) | modify | Item `tickets`, label "Jira tickets", default visible |
| `apps/web/src/components/settings/settingsSearch.ts` | modify | Add `jira tickets` to the existing `thread-details-items` search terms |
| `apps/web/src/components/CommandPalette.tsx` | modify | Three action kinds (Task 7) |
| `docs/user/jira-tickets.md`, `docs/user/thread-sidebar.md`, `docs/README.md` | create/modify | Task 8 |

### Mobile PR (`feat/thread-priority-p6-mobile`)

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/mobile/src/features/threads/ThreadPriorityGlyph.tsx` | create | Row glyph with accessibility label |
| `apps/mobile/src/features/threads/useThreadTicketActions.ts` | create | Set/clear priority, link prompt, unlink, open ticket; per thread |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx` | modify | Glyph in the first meta line; Priority submenu and "Jira tickets…" in the row menu |
| `apps/mobile/src/features/threads/ThreadTicketsSheet.tsx` (+ `ThreadTicketRows.tsx` if the list needs splitting) | create | Sheet: priority row, ticket rows, link "+" |
| `apps/mobile/src/Stack.tsx`, `apps/mobile/src/features/layout/workspace-overlay-routes.ts` | modify | Register `ThreadTickets` as a `sheetRoute` and list it as an overlay route |
| `apps/mobile/src/features/threads/ThreadHeader.tsx`, `ThreadDetailScreen.tsx` | modify | Header action opening the sheet when ticket UI is available |
| `apps/mobile/src/lib/openExternalUrl.ts` | modify | Add `"ticket"` to `ExternalUrlTarget` |
| `docs/user/jira-tickets.md`, `docs/user/thread-sidebar.md` | modify | The mobile paragraphs |

## Web PR tasks

### Task 0: Preflight

- [ ] Confirm the worktree is based on an integration branch containing P1, P2 and P5: `git log --oneline feat/thread-priority | head`, then check that the dependency table symbols exist (`grep -rn "effectiveThreadPriority" packages/client-runtime/src/state`, `grep -rn "linkTicket" packages/client-runtime/src/state/threadCommands.ts`, `grep -n "threadTickets" packages/contracts/src/environment.ts`). If any is missing, stop and report; do not recreate it.
- [ ] Read the real shapes of `threadEnvironment.setPriority` and `linkTicket` inputs in P1's merged code and use those names; the table above is the contract, the code wins where they differ (record any difference in the PR description).

### Task 1: Shared presentation module (client-runtime)

**Files:** create `packages/client-runtime/src/state/threadTicketPresentation.ts` and `threadTicketPresentation.test.ts`; modify `packages/client-runtime/package.json` (subpath). Contract §9: P6 may add a subpath for a shared presentation module.

Exports (names are the interface; types are inferred where possible, annotate only the public input shapes):

- `priorityGlyphLevel(position: number, scaleLength: number): 0 | 1 | 2 | 3 | 4`. Five visual levels regardless of scale length, so a three-level or seven-level Jira scale still maps to the same glyph family. Rule: a scale of length 1 or less is level 2; otherwise round(4 × position / (scaleLength − 1)), clamped to 0-4.
- `threadPriorityIndicator(thread: Pick<EnvironmentThreadShell, "ticketLinks" | "priority">, scale: ReadonlyArray<PriorityRef>): ThreadPriorityIndicator | null`. Calls P5's `effectiveThreadPriority`. Result is a discriminated union:
  - `{ kind: "resolved", source: "user" | "jira" | "agent", position, level, name, ticketKey: string | null, tooltip, accessibilityLabel }`. `name` is the scale entry's name. `tooltip` is `"<name> · You"`, `"<name> · Jira <KEY>"` (KEY from `EffectiveThreadPriority.ticketKey`), or `"<name> · Agent guess"`. `accessibilityLabel` is `"Priority <name>, <source phrase>"` with the same source phrases spelled out ("set by you", "from Jira <KEY>", "agent's guess").
  - `{ kind: "unresolved", source: "user" | "agent", name, tooltip, accessibilityLabel }` when `effectiveThreadPriority` is null but `priority.user` (checked first) or `priority.agent` is set: the value matches nothing on the current scale. Tooltip `"<name> · You · not on this scale"` (or `Agent guess`).
  - `null` when there is no resolved or stored priority at all.
- `threadPriorityMenu(thread: Pick<EnvironmentThreadShell, "priority">, scale): { entries: ReadonlyArray<{ ref: PriorityRef; checked: boolean }>; canClear: boolean; currentLabel: string | null }`. `checked` is true for the scale entry that `findPriorityInScale(scale, priority.user)` resolves to; `canClear` is `priority.user !== null` (true even when unresolvable); `currentLabel` is the indicator's tooltip text for the thread, or null (used as the parent item's `detail`).
- `ticketChipModel(link: ThreadTicketLink, context: { jiraConnected: boolean; siteUrl: string | null }): TicketChip`:
  - `key`, `title: string | null` (snapshot title, kept even for an unreachable link that still carries an older snapshot), `url: string | null` (`link.url`, else `jiraBrowseUrl(siteUrl, key)` when `siteUrl` is known, else null, meaning "not openable"), `sourceLabel` ("Linked by you" / "Linked by the agent" / "Found in the branch name"), `priorityName: string | null`.
  - `status`: `{ kind: "synced", name, tone }` with `tone` `"success"` for category done, `"info"` for indeterminate, `"neutral"` for new; `{ kind: "unreachable", reason: "not_found" | "forbidden", label }` (label "Unreachable"; reason text "Not found, or you can't see it" / "No access"); `{ kind: "pending", label }` when there is no snapshot and no error (label "Waiting for Jira" if `jiraConnected`, else "Jira not connected").
  - `unreachable: boolean` (drives `data-ticket-unreachable` and the dimmed style).
- `visibleTicketChips(links, context): ReadonlyArray<TicketChip>`: `visibleThreadTicketLinks` first (tombstones never render), stored order preserved.
- `ticketUiAvailability(config: { environment?: { capabilities?: { threadTickets?: boolean } }; jiraStatus?: { state: "disconnected" | "connected" | "error" } } | null | undefined): { priority: boolean; linkTicket: boolean; jiraConnected: boolean }` implementing the gating facts above (`jiraConnected` is true for `connected` and `error`).
- `jiraSyncNotice(status: { state; error: { message; since } | null } | undefined): { message: string; since: string } | null`: non-null only for `state === "error"`; the UI prints "Jira could not be reached since <time>. Showing the last known data." (the time is formatted by the caller).
- Menu action ids, shared so web and mobile menus agree: constants for the prefixes and `parseTicketMenuAction(id: string): { type: "set-priority"; priorityId: string } | { type: "clear-priority" } | { type: "link-ticket" } | { type: "unlink-ticket"; key: string } | { type: "open-tickets" } | null`. Ids: `priority:set:<scale id>`, `priority:clear`, `link-ticket`, `unlink-ticket:<KEY>`, `open-tickets`. The parent id `priority` and every unrelated id parse to null. Scale ids may themselves contain `:` (`default:high`), so only the prefix is stripped.
- Glyph tone is not decided here (CSS differs per client); levels are.

Test tables (extend nothing: new file). Use `import { describe, expect, it } from "vite-plus/test"`, plain-object threads, no mocks.

`priorityGlyphLevel`:

| position | scaleLength | level |
| --- | --- | --- |
| 0 | 5 | 0 |
| 1 | 5 | 1 |
| 2 | 5 | 2 |
| 3 | 5 | 3 |
| 4 | 5 | 4 |
| 0 | 3 | 0 |
| 1 | 3 | 2 |
| 2 | 3 | 4 |
| 1 | 7 | 1 |
| 3 | 7 | 2 |
| 5 | 7 | 3 |
| 0 | 1 | 2 |
| 0 | 0 | 2 |

`threadPriorityIndicator` (scale = the default five unless stated):

| # | Thread | Expected |
| --- | --- | --- |
| 1 | `priority.user = High` | resolved, user, position 1, tooltip `High · You` |
| 2 | no user; a readable link with snapshot priority Medium, key `PROJ-1` | resolved, jira, ticketKey `PROJ-1`, tooltip `Medium · Jira PROJ-1` |
| 3 | no user, no Jira; `priority.agent = Low` | resolved, agent, tooltip `Low · Agent guess` |
| 4 | Done ticket (`statusCategory: "done"`) with priority Highest, nothing else | resolved, jira (Done still counts) |
| 5 | user = High, ticket Highest | resolved, user (user wins) |
| 6 | unreachable link (`syncError: "not_found"`, stale snapshot priority Highest), agent = Low | resolved, agent (unreachable contributes nothing) |
| 7 | `priority.user = { id: "9", name: "Expedite" }`, nothing else | unresolved, user, tooltip `Expedite · You · not on this scale` |
| 8 | user unresolvable, agent = Low | unresolved, user (the stored user value is what the menu can clear) |
| 9 | user unresolvable, readable ticket Medium | resolved, jira (falls through, as P5) |
| 10 | no links, `EMPTY_THREAD_PRIORITY` | `null` |
| 11 | user by name only (`{ id: "stale", name: "high" }`) on the default scale | resolved, user, position 1, name `High` (name fallback) |
| 12 | `branch-dismissed` link with a priority | ignored (no indicator) |

`threadPriorityMenu`:

| # | Thread | Expected |
| --- | --- | --- |
| 1 | no user value | five entries, none checked, `canClear` false |
| 2 | user = High | `High` checked only, `canClear` true |
| 3 | user by name `high` with a stale id | `High` checked, `canClear` true |
| 4 | user unresolvable | none checked, `canClear` true |
| 5 | scale of seven | seven entries in scale order |

`ticketChipModel` / `visibleTicketChips`:

| # | Link | Context | Expected |
| --- | --- | --- | --- |
| 1 | snapshot done, status "Done" | connected | synced, tone success, not unreachable |
| 2 | snapshot indeterminate "In Progress" | connected | synced, tone info |
| 3 | snapshot new "To Do" | connected | synced, tone neutral |
| 4 | `syncError: "not_found"`, snapshot kept | connected | unreachable, title kept, `unreachable: true` |
| 5 | `syncError: "forbidden"` | connected | unreachable, reason forbidden |
| 6 | no snapshot, no error | connected | pending "Waiting for Jira" |
| 7 | no snapshot, no error | disconnected | pending "Jira not connected" |
| 8 | `url: null`, `siteUrl` set | any | `url` = `jiraBrowseUrl(siteUrl, key)` |
| 9 | `url: null`, `siteUrl` null | any | `url` null |
| 10 | `url` set, `siteUrl` set | any | `url` is the link's own |
| 11 | list of `[manual, branch-dismissed, agent]` | any | two chips, order preserved, tombstone absent |
| 12 | sources manual / agent / branch | any | the three source labels |

`ticketUiAvailability`:

| Config | priority | linkTicket | jiraConnected |
| --- | --- | --- | --- |
| `undefined` / `null` | false | false | false |
| capabilities without `threadTickets` | false | false | false |
| `threadTickets: true`, no `jiraStatus` | true | false | false |
| `threadTickets: true`, `disconnected` | true | false | false |
| `threadTickets: true`, `connected` | true | true | true |
| `threadTickets: true`, `error` | true | true | true |

`jiraSyncNotice`: `undefined` → null; `connected` → null; `disconnected` → null; `error` with message and since → `{ message, since }`.

`parseTicketMenuAction`: `priority:set:default:high` → set-priority `default:high`; `priority:set:10000` → set-priority `10000`; `priority:clear` → clear-priority; `link-ticket` → link-ticket; `unlink-ticket:PROJ-123` → unlink-ticket `PROJ-123`; `open-tickets` → open-tickets; `priority`, `pin`, `snooze:custom`, `unlink-ticket:` (empty key), `priority:set:` (empty id) → null.

- [ ] **Step 1:** write the tables above as failing tests.
- [ ] **Step 2:** implement the module until they pass: `vp test run packages/client-runtime/src/state/threadTicketPresentation.test.ts`.
- [ ] **Step 3:** add the `package.json` subpath; `vp run @t3tools/client-runtime#typecheck`.
- [ ] **Step 4:** commit: `feat(client-runtime): shared ticket and priority presentation`.

### Task 2: Details-items registry entry

**Files:** `apps/web/src/components/chat/threadDetailsItems.ts` and its test, `apps/web/src/components/settings/settingsSearch.ts`.

- [ ] Add `{ id: "tickets", label: "Jira tickets", defaultVisible: true }` to `THREAD_DETAILS_ITEMS`, after `branch` (the item ids are persisted; this only adds one). The existing Thread details row and card menu pick it up.
- [ ] Extend the existing `threadDetailsItems.test.ts` resolve case with one assertion that `visibility.tickets` is true by default and an override `{ tickets: false }` resolves false. Do not add a new `it`.
- [ ] Add `jira ticket tickets priority` to the `thread-details-items` entry's `searchTerms` in `settingsSearch.ts` (and its test if one pins the string).
- [ ] `vp test run apps/web/src/components/chat/threadDetailsItems.test.ts`.

### Task 3: Context menu items and the shared action hook

**Files:** `threadActionMenu.logic.ts` (+ test), new `useThreadTicketActions.ts`, `useThreadActionMenu.ts`, `Sidebar.tsx`.

Menu logic:

- [ ] Extend `ThreadActionMenuId` with `"priority" | "priority:clear" | "link-ticket" | `priority:set:${string}` | `unlink-ticket:${string}``. `threadActionRequiresOperate` stays unchanged (these ids are not in its read-only list, so they require the operate scope, which is right).
- [ ] Extend `ThreadActionMenuState` with an optional `tickets` input: `{ priority: ReturnType<typeof threadPriorityMenu> | null; canLink: boolean; links: ReadonlyArray<{ key: string; label: string }> }` where `priority` is null when `ticketUiAvailability(...).priority` is false, `canLink` mirrors `linkTicket`, and `links` come from `visibleTicketChips` (label = `key`, plus title when known, truncated by the logic to a fixed length). Absent `tickets` means no ticket items, so existing callers and tests are untouched.
- [ ] In `buildThreadActionMenuItems`, after the settle/snooze group and before Rename, add one group: a `priority` submenu item (label "Priority", icon `flag`, `detail` = `currentLabel`, children = the scale entries as `priority:set:<id>` items with `checked`, then `priority:clear` "Clear my priority" with `separatorBefore` and `disabled: !canClear`); then `link-ticket` "Link Jira ticket…" (icon `link`) when `canLink`; then one `unlink-ticket:<KEY>` item per visible link, label `Unlink <KEY>` (icon `unlink`). Icon names are strings resolved by a fixed table in the in-page fallback menu (`apps/web/src/contextMenuFallback.ts`: `archive`, `pin`, `clock`, …) that has no `flag`, `link` or `unlink`; add those three small lucide SVG entries to that table (same shape as its neighbours) so web shows them, or drop the icons. Do not leave an unknown name, which would render a blank slot. The first item of the group carries `separatorBefore`. A group with no items renders nothing. The existing `canOperate === false` mapping disables the top-level items; verify the submenu parent is disabled too.

Menu logic tests (extend `describe("buildThreadActionMenuItems")` in the existing file; add rows to its tables where they fit, new `it` only for what no row covers):

| # | `tickets` input | Expected |
| --- | --- | --- |
| 1 | absent | no `priority`, `link-ticket` or `unlink-ticket:*` ids (existing expectations unchanged) |
| 2 | priority menu present, `canLink` false, no links | `priority` with scale children and `priority:clear`; no link item |
| 3 | user = High | `priority:set:default:high` is `checked`; clear enabled |
| 4 | no user value | clear item `disabled` |
| 5 | `canLink` true, two links | `link-ticket` plus `unlink-ticket:A-1`, `unlink-ticket:B-2` |
| 6 | `canLink` false, one link | no `link-ticket`, but `unlink-ticket:A-1` present (existing links stay removable) |
| 7 | `canOperate: false`, everything present | `priority`, `link-ticket`, `unlink-ticket:*` all disabled |
| 8 | the group sits between the snooze group and `rename` | order assertion on ids |

Action hook (`apps/web/src/hooks/useThreadTicketActions.ts`):

- [ ] `useThreadTicketActions()` returns `handleTicketMenuAction(threadRef: ScopedThreadRef, actionId: string): Promise<boolean>`: parses with `parseTicketMenuAction`; returns false for unrelated ids (caller continues its own switch); for `set-priority` resolves the id against the thread's environment scale read imperatively (`appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)` through `ticketPriorityScaleOf`) and dispatches `threadEnvironment.setPriority` with `source: "user"`; `clear-priority` dispatches the same with `priority: null`; `link-ticket` calls `openLinkTicketDialog(threadRef)`; `unlink-ticket` dispatches `threadEnvironment.unlinkTicket`. Dispatch through `useOrchestrationCommand` (it checks the operate scope); report failures with `stackedThreadToast` titles "Failed to set priority", "Failed to clear priority", "Failed to unlink ticket", following `useThreadActionMenu.ts`' `failureToast`. Returns true when it consumed the id.
- [ ] Also export a small `useThreadTicketMenuState(threadRef)`-style pure builder (not a hook) `buildTicketMenuState(thread, serverConfig)` used by both call sites so the `tickets` input is computed once, in one place: `serverConfig` is read imperatively with `appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)` (`apps/web/src/state/server.ts`; `entities.ts` has no exported config reader beyond `readEnvironmentServerConfigLoaded`, so either use that registry read directly or add one small `readEnvironmentServerConfig` beside it). Menus open on a click, so an imperative read is right; do not subscribe.
- [ ] `useThreadActionMenu.ts`: compute `tickets` with `buildTicketMenuState`, pass it to `buildThreadActionMenuItems`, and call `handleTicketMenuAction` before the existing `switch`. Same in `Sidebar.tsx` `handleThreadContextMenu` (after the operate-permission check, which already covers the new ids, and before its `switch`). `handleThreadContextMenu` is a large-component handler: keep it a plain function wrapped by the existing `useStableCallback`, per `docs/internals/web-ui.md` "Handlers in large components".
- [ ] `vp test run apps/web/src/components/threadActionMenu.logic.test.ts`.
- [ ] Commit: `feat(web): priority and ticket actions in the thread menu`.

### Task 4: Link Jira ticket dialog

**Files:** `apps/web/src/components/tickets/LinkTicketDialog.tsx`, `ChatView.tsx`.

- [ ] Model on `LinkPullRequestDialog.tsx`: a kept-alive atom of `ScopedThreadRef | null`, `openLinkTicketDialog(threadRef)`, `LinkTicketDialogHost` rendering nothing unless the target is set and the thread's environment passes `ticketUiAvailability(...).linkTicket`; mount the host in `ChatView.tsx` beside `LinkPullRequestDialogHost` (non-embedded only, same condition).
- [ ] Dialog contents use `Dialog*`, `Input`, `Button` from `components/ui` (no restyling): title "Link Jira ticket", description "Paste a Jira link or enter a ticket key such as PROJ-123.", one `Input` with placeholder "Jira URL or PROJ-123", Enter submits, Cancel and Link buttons, `Linking...` while pending.
- [ ] Parsing is `parseTicketReference` from `@t3tools/contracts` only (P1 owns key and URL rules, including lower-case keys and `selectedIssue=` board URLs). Valid input shows a one-line preview of the canonical key; invalid shows "Use a Jira link or a key like PROJ-123." after the first edit, as the PR dialog does. Submit dispatches `threadEnvironment.linkTicket` with `{ threadId, key, url, source: "manual" }` through `useOrchestrationCommand`, where `url` is `jiraBrowseUrl(serverConfig.settings.jira.siteUrl, key)` when the environment has a saved site, else the parsed URL when present, else omitted. This matches P4's `link_ticket`, which always stores the canonical browse URL of the connected site, never the pasted one (coherence pass). Linking a key that is already linked is a reducer no-op and succeeds: close the dialog without error (do not special-case it client-side). A command failure keeps the dialog open with the message inline.
- [ ] No hermetic dialog test: parsing is tested in P1, the dispatch is callback wiring (AGENTS.md "Verifying"). It is covered in the integrated pass.

### Task 5: Sidebar row priority indicator

**Files:** `apps/web/src/components/tickets/ThreadPriorityIndicator.tsx`, `SidebarThreadRow.tsx`.

- [ ] `ThreadPriorityIndicator({ thread })` is a child component that reads its environment's config through a selector atom (`serverEnvironment.configValueAtom(thread.environmentId)`, then `ticketPriorityScaleOf`) and calls `threadPriorityIndicator`. It renders null for a null result.
- [ ] The row mounts it only when the thread has ticket data: `thread.ticketLinks.length > 0 || thread.priority.user !== null || thread.priority.agent !== null`. A row without any gets no component, no subscription and no markup. Render it in all four variants directly beside `pinIndicator`, and not on settled rows (`variantAction === "unsettle"`), which are out of play.
- [ ] Visual: a compact glyph of one icon family chosen by `level` (double chevron up, chevron up, equals, chevron down, double chevron down from lucide), `size-3`, `shrink-0`, tone from theme tokens by level (urgent to calm; level 0 the strongest, level 2 and 4 muted). Shape, not colour alone, carries the level (accessibility). The unresolved kind uses a neutral outline glyph. No remote images, no animation, no transition that repaints (AGENTS.md: no continuously repainting animations). Tooltip via `Tooltip`, `TooltipTrigger`, `TooltipPopup side="top"` with `tooltip` text; the trigger is a non-interactive `span role="img"` with `aria-label={accessibilityLabel}` (like the draft indicator), so it never steals the row click.
- [ ] DOM hooks (contract §6.13): on the indicator span, `data-thread-priority="user|jira|agent"` and `data-thread-priority-position="<n>"` for the resolved kind; the unresolved kind sets `data-thread-priority-unresolved` and neither of the other two. Absent when there is no indicator.
- [ ] Lint: effect-free, no `useMemo`/`useCallback` (`t3code/no-manual-memo`); the file must compile under React Compiler (`reactCompilerCoverage.test.ts`). No new hermetic test: the decisions are tested in Task 1; do not render to static markup.

### Task 6: Ticket chips in the thread details card

**Files:** `apps/web/src/components/chat/ThreadTicketsPanel.tsx`, `ThreadDetailsPanel.tsx`.

- [ ] `ThreadTicketsPanel({ environmentId, threadId })`: a `ThreadDetailsSection` titled "Jira tickets" (`headingId="thread-details-tickets-heading"`, `data-thread-tickets-panel`), modelled on `ThreadServersPanel`. It returns null while the environment lacks `ticketUiAvailability(...).priority`, or when there are no visible chips and the Link action is unavailable (so users without Jira see nothing).
- [ ] Mount in `ThreadDetailsPanel.tsx` after the Version Control section: `density === "full" && !props.draftId && visible.tickets`, like `ThreadServersPanel` (drafts have no thread, essential/compact densities stay small).
- [ ] Rows: one per `visibleTicketChips` entry, in the PR row style (`ThreadDetailsControl part="row"` with the styles from `threadDetailsPanelStyles.ts`): leading ticket icon, then the key in the monospace style the PR rows use for `#number`, then the title truncated (`THREAD_DETAILS_PANEL_LABEL_CLASS`), then a `Badge size="sm"` whose `variant` is `success` for done, `info` for in progress, `secondary` for new, `warning` for unreachable and pending. Badge text is the status name (or "Unreachable" / the pending label). Clicking the row opens `chip.url` with `useOpenLink(threadRef)`; a chip with a null `url` is a non-interactive row. The row root carries `data-ticket-key="<KEY>"` and, when unreachable, `data-ticket-unreachable`. Unreachable rows are visually dimmed with the title kept if known.
- [ ] Tooltip (`TooltipPopup`, same container style as `ThreadDetailsPrRow`'s glass tooltip): full title, status, priority name if any, `sourceLabel`, and for unreachable the reason text. Never show `snapshot.syncedAt` as freshness: an equal sync writes nothing, so it means "last read with changed data", not "last checked" (P1 open question 7); connection health comes only from `jiraStatus`.
- [ ] Unlink control: a trailing `ThreadDetailsControl part="icon"` with an X icon and `aria-label="Unlink <KEY>"`, visible on row hover and keyboard focus, shown only when the operate scope is granted; dispatches `unlinkTicket` through `useOrchestrationCommand` with toast-on-failure. It remains available when Jira is disconnected.
- [ ] Section actions: a `+` `ThreadDetailsControl part="icon"` `aria-label="Link Jira ticket"` that calls `openLinkTicketDialog`, shown only when `linkTicket` is available and the scope is granted.
- [ ] Stale notice: when `jiraSyncNotice(config.jiraStatus)` is non-null, a muted one-line note under the rows ("Jira could not be reached since <time>. Showing the last known data."), using the existing relative or absolute time formatter the details card already uses elsewhere.
- [ ] `contentKey` on `ThreadDetailsCard` already derives from visible items; verify the card still measures correctly when the section appears (the usage and servers sections are the precedent).

### Task 7: Command palette

**Files:** `apps/web/src/components/CommandPalette.tsx`.

- [ ] Beside the PR link entries (~L1419), for `activeThread !== null`: when `ticketUiAvailability(activeThreadServerConfig).priority`:
  - a `kind: "submenu"` item `value: "action:thread-priority"`, title "Set thread priority…", `searchTerms: ["priority", "urgent", "important", "jira", "set"]`, one group "Priority" whose items are `kind: "action"` entries, one per scale entry (`value: "action:thread-priority:<scale id>"`, title the name, a check icon when it is the user's value) plus "Clear my priority" (`value: "action:thread-priority:clear"`, disabled when `canClear` is false). `run` dispatches via the same `useThreadTicketActions` hook functions used by the context menu (extract the dispatch half so the palette and menu share it, not a copy).
  - Disabled (not hidden) when the operate scope is missing, as other palette actions that mutate do.
- [ ] When `linkTicket` is available: `action: "action:link-jira-ticket"`, title "Link Jira ticket to thread", `searchTerms: ["link", "jira", "ticket", "issue", "attach"]`, `run: () => openLinkTicketDialog(threadRef)`.
- [ ] For each visible link (regardless of Jira state): `action:unlink-jira-ticket:<KEY>`, title `Unlink <KEY>` with the title as the description when known, `searchTerms: ["unlink", "remove", "jira", "ticket", KEY]`.
- [ ] Place them with the thread-scoped actions (after the PR link block). Icons from lucide already imported there or one new import; use `ITEM_ICON_CLASS` like neighbours.
- [ ] Extend `CommandPalette.browser.test.tsx` only if an existing case already renders thread-scoped actions and a row there can assert the new values appear/disappear with the capability; otherwise rely on the integrated pass (AGENTS.md: no wiring-only tests). Run what exists: `vp test run apps/web/src/components/CommandPalette.logic.test.ts`.

### Task 8: User docs

**Files:** `docs/user/jira-tickets.md` (new), `docs/user/thread-sidebar.md`, `docs/README.md`.

Acceptance criteria (concise, product voice, no implementation or contributor tooling, per AGENTS.md "Documentation"):

- [ ] `jira-tickets.md` covers, as short task-oriented sections: **Connect Jira** (Settings → Source control → Jira on web and desktop, per P2 Task 8; confirm against P2's merged `settingsSearch.ts` entry `jira-connection`: site address, email, API token, **Test connection**, **Disconnect**; it is read-only, T3 Code never changes anything in Jira; each machine you connect to needs its own connection because the connection lives on the server; only tickets the token's account can see are readable). **Link tickets** (an agent links the Jira tickets it works on; T3 Code also picks up a key in a thread's branch name; or link by hand from the thread menu, the command palette, or the thread details card; unlink the same ways; a ticket you remove that came from the branch name stays removed). **Priority** (the scale is your Jira site's own priority list and order, a default Highest-to-Lowest list without Jira; a thread's priority comes from, in order: the one you set, the highest priority among its linked tickets, then the agent's guess; Done tickets still count until you settle the thread; how to set and clear your priority; what the glyph and its tooltip mean; a ticket T3 Code cannot read shows as unreachable and counts for nothing). **Inbox order** (one short pointer to the setting, with the rule: priority first, then board rank within a priority, then most recently returned; threads with no priority last; pinned threads stay on top). **Freshness** (tickets refresh about every two minutes; when Jira cannot be reached the last known data stays and a notice says so). One sentence that remote servers on an older T3 Code version show none of this.
- [ ] `thread-sidebar.md`: under "Fold working threads (beta)" (~L140) add one short paragraph "Inbox order" stating the setting (Settings → General → Inbox order), the two options, that Priority also applies with the Working section off, and linking `./jira-tickets.md`; correct the adjacent sentence "While this is on, the active list is ordered by when each thread last came back to you" so it stays true under Priority (read P5's final wording of the setting first). Check the nearby "cannot drag or move threads within it" sentence still holds under Priority (P5 disables within-inbox reorder there).
- [ ] `docs/README.md`: add `- [Jira tickets and priority](./user/jira-tickets.md)` after "Working with threads".
- [ ] The mobile sentences are added in the mobile PR (Task M3), not here.
- [ ] Check no existing doc becomes inaccurate (`grep -rn "Working section\|Inbox" docs/user`).

### Task 9: Web verification, integrated pass, review, handoff

- [ ] `vp test run packages/client-runtime/src/state/threadTicketPresentation.test.ts apps/web/src/components/threadActionMenu.logic.test.ts apps/web/src/components/chat/threadDetailsItems.test.ts`.
- [ ] `vp run @t3tools/client-runtime#typecheck`, `vp run @t3tools/web#typecheck`, then `vp run check:changed` (no repo-wide checks).
- [ ] Integrated real-client pass by the primary agent only (subagents do not start dev servers): see Testing Strategy.
- [ ] Independent review (fresh context) of the branch diff against this plan, the spec section "Client UI" and AGENTS.md "Hit every surface"; viewing the screenshots for the visual claims. Fix or justify every finding and report them in the handoff.
- [ ] Merge forward from the clean integration worktree: `git merge --no-ff feat/thread-priority-p6 -m "merge: P6 web"`.

## Mobile PR tasks

Starts after the web branch has merged. Mobile must also respect `docs/internals/mobile-layout.md`: a feature screen never branches on platform or width; sheets go through `sheetRoute` and `SheetHeader`.

### Task M1: Row glyph and row menu

**Files:** `ThreadPriorityGlyph.tsx`, `thread-list-v2-items.tsx`, new `useThreadTicketActions.ts`.

- [ ] `ThreadPriorityGlyph({ thread, selected })`: same discipline as web. Mounted only when the thread has ticket data; reads its environment config through `serverEnvironment.configValueAtom`; uses `threadPriorityIndicator`; renders a `SymbolView` (SF Symbols with Android mapping in `AppSymbol.android.tsx`: pick from `chevron.up`, `chevron.up.2`, `equal`, `chevron.down`, `chevron.down.2`; in `apps/mobile/src/components/ui/AppSymbol.android.tsx` only `chevron.up`, `chevron.down`, `ticket`, `plus` and `pin` exist at `ddec2d528a`, so add Tabler mappings for `chevron.up.2`, `chevron.down.2`, `equal` and `flag` (the row menu and the Priority submenu use `flag`); `AppSymbolName` is derived from that map, so an unmapped name fails typecheck) tinted from the row's existing tint class helpers, and exposes `accessibilityLabel` from the model (no tooltips on touch). It is non-interactive (the PR badge is the only tappable item in that line). Place it in the first line beside the pin `SymbolView` (~L1198). Hide on settled rows (`variant === "slim"`), as on web. `testID="thread-priority"` plus `testID` suffix by source for P7.
- [ ] `useThreadTicketActions(thread)` (per row; precedent: the row already calls `useAtomCommand(threadEnvironment.visit)`): exposes `setPriority(ref | null)`, `unlink(key)`, `promptLink()`, `openTicket(url)`. Uses `useAtomCommand(threadEnvironment.setPriority/linkTicket/unlinkTicket, { reportFailure: false })`, guards on `useEnvironmentScope(…, AuthOrchestrationOperateScope)`, reports failures with `Dialog.alert` like `useLinkedPullRequestActions`. `promptLink` uses `Dialog.prompt` ("Link Jira ticket", message "Paste a Jira link or enter a ticket key such as PROJ-123.", `Link` button), parses with `parseTicketReference`, shows `Dialog.alert` for invalid input, dispatches `source: "manual"`. `openTicket` uses `tryOpenExternalUrl(url, "ticket")` and alerts on failure.
- [ ] Row menu: add a `priorityMenuItems` piece (a `MenuAction` with `id: "priority"`, `title: "Priority"`, `image: "flag"`, `subactions` built from `threadPriorityMenu`: `priority:set:<id>` with `state: "on"|"off"`, then `priority:clear` "Clear my priority" with `attributes.disabled` when `canClear` is false) and, when ticket UI is available, an `open-tickets` item "Jira tickets…" (`image: "ticket"`). Both only when `ticketUiAvailability(...).priority`. Add them to the `secondary` group of every variant branch of the `menuActions` memo (card, slim, snoozed, legacy), next to `titleMenuItems`; extend `layoutThreadListV2RowMenuActions` input only if its type forces it. Handle the ids in `handleMenuAction` through `parseTicketMenuAction`, with the same early-return shape as the existing id checks.
- [ ] `open-tickets` navigates to `ThreadTickets` with `{ environmentId, threadId }` (the row has `useNavigation` available; follow `use-open-thread-pull-requests.ts`, but the hook is called in the row because the menu entry is rare and the call is a context read).
- [ ] Hermetic: nothing new beyond Task 1's tables (menu ids and models are shared and tested there). If the row's menu composition has a pure builder with an existing test file (`threadListV2.test.ts`), add rows for the new pieces to it instead of a new file.

### Task M2: Tickets sheet and thread-screen entry

**Files:** `ThreadTicketsSheet.tsx`, `Stack.tsx`, `workspace-overlay-routes.ts`, `ThreadHeader.tsx`, `ThreadDetailScreen.tsx`, `openExternalUrl.ts`.

- [ ] `ThreadTicketsSheet` mirrors `ThreadPullRequestsSheet.tsx`: `SheetHeader` title "Jira tickets" with a "+" action (`accessibilityLabel: "Link Jira ticket"`, icon `plus`) only when `linkTicket` is available and the operate scope is granted; a `LegendList` of ticket rows built from `visibleTicketChips`; a list header row for priority (current indicator text from `threadPriorityIndicator`, with a `Menu` offering the scale and "Clear my priority", same ids as M1) when `priority` is available; a header notice from `jiraSyncNotice` when non-null; empty text "No linked tickets." The thread comes from `useThreadSelection()` like the PR sheet.
- [ ] A ticket row shows key (monospace), title (two lines max), status badge text with tone-mapped colours from the existing theme tokens, unreachable state dimmed with the reason text, source label as the secondary line. Press opens the Jira URL (disabled when `url` is null); a row `Menu` with "Open in Jira", "Copy link" (when `url`), and "Unlink" (destructive, operate scope only, available whatever the Jira state). `testID="ticket-chip-<KEY>"`, and `ticket-chip-unreachable` when unreachable, matching contract §6.13 where React Native needs them.
- [ ] Register route `ThreadTickets` in `Stack.tsx` with `sheetRoute({ detent: 0.55 })` and a `linking` of `${THREAD_LINKING_PREFIX}/tickets`; add the name to `LISTED_OVERLAY_ROUTES` in `workspace-overlay-routes.ts` beside `ThreadPullRequests`; add the param type wherever `ThreadPullRequests`' params are declared (follow its registration end to end).
- [ ] Add `"ticket"` to `ExternalUrlTarget` in `apps/mobile/src/lib/openExternalUrl.ts`.
- [ ] Thread screen: `ThreadHeader` gains an optional `onOpenTickets?: () => void`; when defined it adds one `AppBarAction` (`icon: "ticket"`, `accessibilityLabel: "Jira tickets and priority"`, `separateBackground: false`). `ThreadDetailScreen.tsx` passes it only when `ticketUiAvailability(serverConfig).priority` holds for the selected thread's environment, navigating to `ThreadTickets` as it does for `ThreadAgents` (`Keyboard.dismiss()` first).

### Task M3: Mobile docs, verification, review, handoff

- [ ] `docs/user/jira-tickets.md`: add the mobile sentences (where to set priority: the thread's menu in the list and the ticket button on the thread screen; linking and unlinking in the Jira tickets sheet; Jira connection itself is set up on web or desktop, for the server). `thread-sidebar.md` mobile wording for Inbox order follows what P5 shipped for mobile (arrangement sheet option, and whether mobile Settings has the row): read P5's merged code before writing.
- [ ] `vp run @t3tools/mobile#typecheck`, `vp run @t3tools/client-runtime#typecheck`, `vp run check:changed`, `vp test run` on any mobile test files touched.
- [ ] Integrated mobile pass (`test-t3-mobile`): see Testing Strategy. If no simulator or device is available autonomously, say so in the handoff; mobile is then verified only by typecheck, the shared logic tests and review, and P7 owns the device pass.
- [ ] Independent review as for web; merge: `git merge --no-ff feat/thread-priority-p6-mobile -m "merge: P6 mobile"`.

## Testing Strategy

**Hermetic (the decisions that can break):** all behaviour lives in `threadTicketPresentation.test.ts` (glyph level mapping, indicator resolution including unresolved and Done cases, menu check and clear state, chip model, gating, sync notice, menu-action-id parsing) and in the extended `threadActionMenu.logic.test.ts` and `threadDetailsItems.test.ts` rows. They run in one layer, the lowest one that fails if the decision is wrong (AGENTS.md "Test at one layer"); web and mobile do not copy them. Not tested, by the AGENTS.md rules: callback wiring (dialog submit, hook dispatch), props rendered to static markup, copy text, glyph and tooltip appearance. P1 and P5 already cover resolution, reducers and sort; P6 does not re-test them.

**End-to-end (real system, once, by the primary agent after integrating each PR):** a worktree dev server (`vp run dev`, seeded worktree `.t3` copy of real data, never `~/.t3/userdata`, kill only the PID captured at spawn), the free `Replay (dev)` provider for any agent turn, driven through `test-t3-app` (web) and `test-t3-mobile` (mobile):
- *No Jira connected:* Priority submenu and palette priority actions set, change and clear a user priority on the default scale; indicator appears with `data-thread-priority="user"`; no Link item, no Link palette action, no section "+" ; reverse: Clear removes the indicator (or falls back to the agent value if one is set).
- *Capability off* (an environment without `threadTickets`, or a stubbed config in the page): no ticket UI at all.
- *Link flows:* manual link by key and by a Jira URL from the menu dialog, the palette, and the details "+" (with Jira connected read-only to the user's site via `request_secret`, only if the user has agreed for this run; otherwise link flows are checked as far as the `snapshot === null` pending chip, and the connected cases are left to P7). Unreachable state: link a key that does not exist. Unlink from the chip, menu and palette; a branch-detected ticket stays gone after unlink.
- *States that need real snapshots without Jira:* with the dev server stopped (PID captured), write snapshots into the worktree's own `.t3/userdata/statev2.sqlite` copy by updating `payload_json` of a few rows in `orchestration_v2_projection_threads` (`json_set(payload_json, '$.ticketLinks', json(?))`) covering each priority position, a Done ticket, an in-progress ticket, a `not_found` link and a pending link; restart and look. Confirm on first use that the edit survives startup; if the server rebuilds projections from events, fall back to connected Jira (P7 mode) for those states and say so.
- *Mobile:* the same matrix on a booted simulator or device, using `vp run mobile:install` per AGENTS.md; row glyph, row menu Priority submenu, the sheet, the header button.

**Visual (viewing the rendered images with vision, light and dark theme, each size that changes layout):** web sidebar rows in all four variants (card, slim, folder, folder-multiline) with and without an indicator, each of the five glyph levels and the unresolved glyph, tooltip text readable and correctly sourced ("You", "Jira PROJ-123", "Agent guess"), the glyph not colliding with pin, status slot or hover controls (hover a row), narrow sidebar width; details card section with synced, done, in-progress, unreachable and pending chips, hover unlink control, the "+" and the stale notice, card height with the section present; the context menu on web (in-page fallback) and, if run, the Electron native menu showing the Priority submenu with a check mark and a clear item; the palette submenu; the link dialog empty, valid, invalid; mobile row (glyph beside pin in light and dark, selected row tint), the row menu, the sheet with all chip states, the header button. Save screenshots to the session scratchpad; for PR evidence upload to GitHub, never commit assets (AGENTS.md "Pull requests").

**Why nothing is skipped:** every item above can be driven autonomously. The only conditional parts are (a) the live-Jira chip data, which needs the user's `request_secret` approval and is owned by P7 if not granted, and (b) mobile when no simulator or device is bootable on the host, stated above.

## Review and handoff

Both PRs get an independent fresh-context review of the diff (bugs, perf on the row path, a11y labels, `components/ui` variants rule, React Compiler coverage, "Hit every surface"), including whether the testing claims hold and viewing the screenshots. Every finding is fixed or justified; the handoff to the orchestrator lists the findings, their resolution, the commands run and the evidence paths. No PR is opened unless the user asks (AGENTS.md).

## Open questions / spec deviations

1. **Deviation from the contract file list: mobile handlers do not go through `useThreadListActions.ts`.** Context: contract §1 P6 and §9 list `apps/mobile/src/features/home/useThreadListActions.ts` for priority/link/unlink handlers. That hook is consumed by three screens (`HomeRouteScreen`, `ThreadNavigationSidebar`, `ThreadArrangementSheet`), and every handler added there must be threaded as a prop through the list and row components in each, while rows already call atom commands directly (`threadEnvironment.visit`). Options: (a) follow the contract and thread handlers; (b) a row-level `useThreadTicketActions(thread)` hook plus a self-contained sheet. Recommendation: (b), less churn and no merge conflicts with P5's edits to the same list wiring. Contract §9 lists this file as P5 → P6 shared, but nothing else in P6 then touches it.
2. **Chips live in the thread details card only, not the chat header.** Context: the spec says "thread header / details". The header is a width-constrained breadcrumb (project / parent / title with a menu chevron, and the pacing widget reserve); a chip row there would truncate the title. The header title menu already carries Priority, Link and Unlink (Task 3), and the details card is its own popover from the header. Options: details card only; add a compact badge to `ChatHeader`; both. Recommendation: details card only for now; a header badge is a one-component follow-up if the maintainers want it.
3. **Addition beyond the spec: a "last known data" notice.** Context: the spec's anti-goal is a stale order shown as current, and its Jira settings section shows sync errors, but nothing tells a user looking at a thread or the inbox that Jira is currently unreachable. Task 6 and M2 add one muted line from `jiraStatus.error` in the details card and the mobile sheet. Options: add it (small, one shared helper), or leave the error to the settings section only. Recommendation: add it.
4. **Unresolvable stored priority shows a neutral "not on this scale" indicator.** Context: spec and contract say such a value "still displays but is ignored for sorting", but `effectiveThreadPriority` returns null for it, so without this the value would be invisible and the thread would silently unrank. Options: show the unresolved indicator and keep "Clear my priority" enabled (planned), or show nothing. Recommendation: planned behaviour.
5. **Sidebar multi-select has no bulk "Set priority".** Context: `handleMultiSelectContextMenu` exists, the spec is silent. Options: add a Priority submenu there (one `setPriority` per selected thread), or defer. Recommendation: defer; it is additive and nothing in the spec asks for it.
6. **No keybinding.** Context: AGENTS.md lists keybindings as a usual third entry point. Setting a priority is occasional, the palette covers keyboard use, and a binding needs a new contract command id, default and conflict handling. Recommendation: none now; revisit on request.
7. **Priority indicator hidden on settled rows.** Context: the spec says "Inbox row", the contract only pins the DOM hooks. Showing it on pinned, working, snoozed and folder rows is informational and cheap; showing it on settled rows adds noise to threads the user has put away. Options: all rows, all but settled (planned), inbox only. Recommendation: all but settled.
8. **Contract Q8 is applied literally; `jiraStatus` missing counts as disconnected.** Context: a server that has `threadTickets` but no `jiraStatus` (P1 without P2) would otherwise offer a Link action that can never sync. P1 and P2 land together on `main`, so this only matters for mixed-version remote pairs. Recommendation: as planned.
9. **Link dialog does not check the pasted URL's site against the connected site.** Context: a URL from a different Jira site links its key, which T3 then reads from the connected site: it shows as unreachable, or, if the connected site has an issue with the same key, as that other issue. P4's `link_ticket` refuses such a URL (`TicketSiteMismatchError`); the dialog stores the canonical URL (Task 4) but does not refuse. Listed in the index "Decisions needed". Options: validate the origin against `settings.jira.siteUrl` and refuse, or let it link and show the unreachable chip (planned; the chip is honest and unlinkable). Recommendation: planned; add validation only if testers report confusion.
10. **Presentation module is new shared surface.** Context: contract §9 allows a subpath only "if it creates a shared presentation module". It does: `./state/thread-ticket-presentation`. Knip flags unused exports, so Task 1 must export only what Tasks 3-7 and M1-M2 consume; trim after the last task.
11. **Needs confirming at implementation time.** (a) P1's exact client command input shapes and whether `setPriority` takes `PriorityRef | null` (assumed per contract §6.3). (b) Whether the details card's `contentKey` and height measurement handle a section that appears after data loads (precedent: servers, automations). (c) That the hand-edited `payload_json` seeding survives server startup (Testing Strategy gives the fallback).
