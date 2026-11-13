# Thread tickets and priority: plan index and shared contract (plan 0)

Spec: `docs/superpowers/specs/2026-11-13-thread-priority-design.md` (read it in full first).
Ground truth: worktree `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority`,
branch `feat/thread-priority` at `ddec2d528a` (code identical to local `main` `bd1a3b5cbe`).

Plan writers run in parallel from this document and cannot see each other. Everything two or
more plans must agree on is pinned here. Where a plan needs something another plan produces,
it codes against the interface in section 6 and does not wait for the other plan's text. If a
writer finds this contract wrong against the code, it records the problem in its plan's
"## Open questions / spec deviations" section, follows the contract anyway, and names the
contract item (for example "contract §6.3").

## Resolved decisions (user, 2026-11-13) — binding

The user answered the "Decisions needed" list at the end of this file. These answers override
any conflicting recommendation or open question in this index or in the plans.

- **D3 (user): agents always set a provisional priority on every ticketless thread** in a
  Jira-connected environment, plain questions included (the spec's literal reading, not the
  recommended "only when urgency is signaled"). P4.
- **D5 (user): no paid eval runs.** P4's eval work is limited to building the cases and
  `--dry-run` evidence; no `ANTHROPIC_API_KEY` use. The handoff must state plainly that the new
  model-facing text is not proven by evals, and the independent review of the real text carries
  more weight. P4.
- **D12 (user): no branch-ticket backfill** when Jira is connected later. P3, P7.
- All other items accepted as recommended:
  - D1 bulkfetch endpoint (P2, P7).
  - D2 the Link dialog refuses a URL whose origin differs from `settings.jira.siteUrl`, matching P4's `link_ticket` (P6).
  - D4 no child-thread special casing (P4).
  - D6 the agent flag is read once per session (P4).
  - D7 a successful "Test connection" with the saved settings also clears the auth-error pause; this relaxes contract §6.7 (P2).
  - D8 no "checking" state (P2, P6).
  - D9 moved issues read as unreachable (P2, P6).
  - D10 the token is kept when the site URL changes (P2).
  - D11 no mobile Jira connection UI (P2, P6).
  - D13 sync scope without BackgroundPolicy (P3).
  - D14 whole-array lenient decoding (P1).
  - D15 P1 implementation choices (P1).
  - D16 contract decisions Q4, Q5, Q8 (P1, P4, P6).
  - D17 one comparator everywhere: `sortInboxThreadsByReturn` over the thread's own timestamps (P5, P7).
  - D18 P5's setting placement choices (P5).
  - D19 P6's UI choices (P6).
  - D20 mobile checks use an Android device/emulator if present, otherwise ask the user before reporting them as not run (P6, P7).
  - D21 P7 asks for Jira credentials and tickets once, up front (P7).
  - D22 no keybinding or bulk "Set priority" (P6).

Every path and symbol below was checked against the code at `ddec2d528a`. Line numbers drift;
re-locate by symbol before editing. Paths are relative to the repo root unless absolute.

Every plan carries, beyond the writing-plans format (or the criteria that replace it for text
deliverables): `## Implementation Location` in exactly the format of section 5, `## Testing
Strategy` (end-to-end, hermetic, visual, and why any e2e or visual check is skipped; follows
AGENTS.md "Verifying"), and `## Open questions / spec deviations` (each item self-contained:
context, options, recommendation). Each plan's implementation gets an independent review before
handoff (section 8).

---

## 1. Plans

| Id | Plan file | Size | Detail | Review of the plan |
| --- | --- | --- | --- | --- |
| P1 | `2026-11-13-thread-priority-p1-thread-data.md` | M | targeted | full |
| P2 | `2026-11-13-thread-priority-p2-jira-connection.md` | M | targeted | full |
| P3 | `2026-11-13-thread-priority-p3-ticket-sync.md` | M | targeted | narrow |
| P4 | `2026-11-13-thread-priority-p4-agent-tools.md` | S-M | interface for code; acceptance criteria for text | none |
| P5 | `2026-11-13-thread-priority-p5-priority-sort.md` | M | targeted (exact comparator and resolution code) | narrow |
| P6 | `2026-11-13-thread-priority-p6-ticket-ui.md` | L | interface | narrow |
| P7 | `2026-11-13-thread-priority-p7-e2e.md` | S | acceptance criteria (text deliverable) | none |

All live in `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority/docs/superpowers/plans/`.

Detail levels (binding): **interface** = files, exact types/signatures/names/schemas, behaviour
in prose, test cases as input/expected tables, commands, no code. **targeted** = interface plus
exact code only where the code is the decision. **Text deliverables** = acceptance criteria,
non-goals, invariants; exact wording only where wording is the decision. writing-plans' "complete
code in every step" is overridden for every plan here.

One plan publishes an early **milestone**: P1's first commit, **P1-contract** (content fixed in
§6.1), is merged forward into `feat/thread-priority` before the rest of P1, so P2 can start on top
of it. A milestone is a commit on the plan's own branch, not a separate branch.

### P1 · Thread data core

Spec "Thread state (contracts)" and "Commands and events".

- **P1-contract milestone (first commit):** new `packages/contracts/src/threadTicket.ts` with
  everything in §6.1 plus `threadTicket.test.ts`; `export * from "./threadTicket.ts"` in
  `packages/contracts/src/index.ts`; the `threadTickets` capability field in
  `packages/contracts/src/environment.ts` (`ExecutionEnvironmentCapabilities`, §6.8). Nothing else.
- Thread fields `ticketLinks` and `priority` on `OrchestrationV2AppThread` (~L470) and
  `OrchestrationV2ThreadShell` (~L2138) in `packages/contracts/src/orchestrationV2.ts`, lenient (§6.2).
- Commands and events exactly as §6.3, including the Json event union
  (`OrchestrationV2DomainEventJson`) and the internal command union
  (`OrchestrationV2InternalCommand`, ~L3471).
- `apps/server/src/orchestration-v2/Orchestrator.ts`: `commandThreadId`, the
  `dispatchThreadMutation` command-type unions, guards, reducers, event selection, and the
  top-level dispatch switch (~L13690). Exact code for: link/unlink/dismiss semantics, the sync
  stale guard and no-op equality, the updatedAt preservation (§6.3). The semantics live in four
  pure exported functions in the new `apps/server/src/orchestration-v2/threadTicketReducer.ts`
  (`linkThreadTicketLinks`, `unlinkThreadTicketLinks`, `syncThreadTicketLinks`,
  `setThreadPriorityValue`); `Orchestrator.ts` routes to them (P1 deviation 3). P3 reuses
  `syncThreadTicketLinks` for its change detection, so there is one equality rule.
- `apps/server/src/relay/AgentAwarenessRelay.ts`: its exhaustive event switch (~L117) lists both
  new events (P1 deviation 4).
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: apply the two events in
  `applyToProjection` (group with `thread.tags-updated`, which preserves `updatedAt`), in
  `apply` (the thread-payload case list ~L2114), in the "does not bump updated_at" exclusion list
  (~L2932), and carry both fields on every shell builder.
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` and
  `apps/server/src/telemetry/FeatureUsage.ts` (`thread.ticket.link`, `thread.priority.set`
  features) for the new command types.
- `apps/server/src/environment/ServerEnvironment.ts`: `threadTickets: true` (beside
  `threadActiveReorder: true`, ~L257).
- Server service `ThreadTicketService` (§6.4) and its layer wiring in `apps/server/src/server.ts`
  as the first `Layer.provideMerge` of `layerRuntimeCoreDependenciesBase`, so P3's reactor and
  P4's MCP layer reach it with no further provide. Its test lives in `runtimeLayer.test.ts`.
- Client-runtime: `packages/client-runtime/src/state/orchestrationV2Projection.ts` lists both new
  events beside `thread.tags-updated` in the "skip the updatedAt bump" group (~L297);
  `EnvironmentThreadShell` fields in `presentThreadShell` (`models.ts` ~L300), the only builder at
  `ddec2d528a`: `threadExecution.ts`, `threadSearch.ts` and `shell.ts`/`shellReducer.ts` only read
  shells, and `shellReducer`'s equivalence covers new fields (P1 deviation 2, corrected here);
  client commands per §6.5. No ws methods (Q1).
- Tests: Orchestrator reducer tables (link, relink, unlink manual/agent/branch, unlink of a key in
  the branch name, branch link onto a dismissed key, sync equal/changed/stale/unreachable/missing
  link/dismissed link, priority set/clear/no-op, updatedAt unchanged), ProjectionStore apply,
  client projection updatedAt, contracts decode leniency, and a decode test proving
  `thread.ticket-link.sync` is rejected by the client `OrchestrationV2Command` schema.
- Builds the server ticket fixtures in §7.

### P2 · Jira connection

Spec "Jira connection (server)". Starts after P1-contract merged.

- `packages/contracts/src/jira.ts` (new; §6.6) and its index export; `ServerSettings.jira` and
  `ServerSettingsPatch.jira` in `packages/contracts/src/settings.ts` (§6.6).
- Secret handling: register `jira.apiToken` in `mapSecretFieldGroups`, the function behind
  `mapSettingsSecrets` and `mapSettingsSecretValues` (`apps/server/src/settingsSecrets.ts`), in
  `SecretsSettings.logic.ts` (web secret-provider uses), and in `invalidateSettingsSecrets`
  (`apps/server/src/sourceControl/sourceControlHostSecrets.ts`), so the token is stored as a
  settings secret and `redactServerSettingsForClient` (`apps/server/src/serverSettings.ts`, used
  by every `ServerConfig.settings` and `settingsUpdated` emission in `ws.ts`) never sends it.
  Pin it with a test on `redactServerSettingsForClient` and one on the `subscribeServerConfig`
  snapshot. Exact code for redaction registration.
- `JiraService` (§6.7) in `apps/server/src/jira/JiraService.ts`, with pure request builders and
  response schemas in the new `apps/server/src/jira/jiraApi.ts`; layer wired in
  `apps/server/src/server.ts` inside the `Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer,
  UsageLimitSources.layer)` group, so `ws.ts`, P3's reactor and P4's MCP layer reach it. Nobody
  builds a second instance: any later provide passes the same `JiraService.layer` reference (Effect
  memoizes layers by reference). Exact code for the Jira REST calls (paths, bodies, field
  extraction, rank field discovery). Tickets are read with `POST /rest/api/3/issue/bulkfetch`
  (Q2, resolved).
- `ServerConfig.ticketPriorityScale` and `ServerConfig.jiraStatus` (§6.8) in
  `packages/contracts/src/server.ts`, filled by `loadServerConfig` in `apps/server/src/ws.ts`
  (~L1902), and the late-update stream event `ticketTrackerUpdated` gated by the
  `subscribeServerConfig` input flag `ticketTracker` (§6.8). Client side:
  `packages/client-runtime/src/rpc/session.ts` (opt in, accept the event) and
  `packages/client-runtime/src/state/serverConfigProjection.ts` (apply it), plus the one-line
  `ticketTracker: true` opt-in in `apps/{web,mobile}/src/connection/runtime.ts` and
  `apps/{web,mobile}/src/state/server.ts` (P2 deviation 3); `ws.ts` also folds the event into
  late-discovery snapshots.
- RPC `server.testJiraConnection` (§6.6): `packages/contracts/src/rpc.ts`, handler in `ws.ts`
  calling `JiraService.testConnection`, `CLIENT_GUARDED_RPC_SCOPES` entry
  (`AuthSettingsWriteScope`), client command `testJiraConnection` in
  `packages/client-runtime/src/state/server.ts` via `createEnvironmentRpcCommand`; extend
  `apps/server/src/auth/RpcAuthorization.test.ts` and
  `packages/client-runtime/src/state/commandPermissions.test.ts`.
- Web/desktop Settings section: new `apps/web/src/components/settings/JiraSettings.tsx`, mounted
  in `SourceControlSettingsPanel` (`apps/web/src/components/settings/SourceControlSettings.tsx`,
  route `/settings/source-control`), shown only when the environment advertises
  `capabilities.threadTickets`. Connect (site URL, email, API token), Test connection (account
  name or error), Disconnect (patch `jira: null`), and the current `jiraStatus` error. Settings
  search entry per §6.10.
- Mobile gets no Jira settings UI (decided by P2: connection is a per-environment admin task done
  from web/desktop; mobile still gets ticket data and priorities).
- Builds the fake Jira HTTP layer and the JiraService test double in §7.

### P3 · Ticket sync and branch detection

Spec "Sync reactor (server)" and "Branch-name detection (server)". After P1 and P2.

- `apps/server/src/orchestration-v2/TicketSyncReactor.ts` patterned on
  `PullRequestSyncReactor.ts` (`makeDrainableWorker`, `forkParked`, `engine.streamDomainEvents`,
  `Schedule.spaced`), service shape §6.9, started in `layerRuntimeCoreDependenciesBase` in
  `apps/server/src/server.ts` beside the `PullRequestSyncReactor` block (~L655).
- New `ProjectionStore` query `getThreadsWithTicketLinks` (§6.9) next to
  `getThreadsWithPullRequests` (~L6930).
- Sweep every 2 minutes, only while `JiraService.isConfigured`. Eligible threads: not archived,
  not deleted, not settled (`settledOverride !== "settled" && settledAt === null`, the
  `isUnsettled` predicate in `PullRequestSyncReactor.ts` ~L318). Visible links only (§6.1
  `visibleThreadTicketLinks`). Done tickets are still synced. Keys deduped across threads into
  `JiraService.fetchTickets`. One `thread.ticket-link.sync` per (thread, key) only when the result
  differs from the stored link (§6.3 rules; uses `threadTicketSnapshotsEqual`).
- Immediate fetch: on `thread.ticket-links-updated` for links with `snapshot === null &&
  syncError === null`, and on Jira (re)connect (§6.9).
- Errors: per-ticket unreachable → `syncError`; `JiraError` for the whole batch → keep every
  snapshot, dispatch nothing, log; `JiraService` records the status itself (§6.7). Never clears
  priorities. Backoff on `JiraUnavailableError.retryAfterMs` (429).
- Branch detection: on `thread.created` and on any thread event whose payload `branch` differs
  from the last seen value for that thread, take `branchTicketKeys(branch)` (§6.1), keep keys
  whose project is in `JiraService.projectKeys`, and call `ThreadTicketService.linkTicket` with
  `source: "branch"` (the reducer itself refuses already-linked and `branch-dismissed` keys).
  Detection never runs from the periodic sweep, so a dismissed or manually removed key is not
  re-added by time passing. Exact code for change detection and dedupe.

### P4 · Agent tools and instructions

Spec "Agents (MCP + instructions)". After P1 and P2.

- New toolkit `apps/server/src/mcp/toolkits/tickets/` (`tools.ts`, `handlers.ts`,
  `handlers.test.ts`) modeled on `toolkits/pullRequests/`, registered in
  `apps/server/src/mcp/McpHttpServer.ts` beside `layerPullRequestsToolkit` (~L1201). Tool names
  (pinned, P7 and evals use them): `link_ticket`, `unlink_ticket`, `set_thread_priority`. Handlers
  parse with `parseTicketReference` (§6.1), resolve priority names/ids with `findPriorityInScale`
  against `JiraService.priorityScale`, and call `ThreadTicketService` (§6.4); a URL-less link
  gets its URL from `JiraService.browseUrl`. `set_thread_priority` writes `source: "agent"` by
  default and `source: "user"` only with `userRequested: true`.
- The tickets toolkit is not listed to agents while Jira is not configured (anti-goal: no extra
  agent prompt text for users without Jira). If the toolkit machinery cannot hide tools per
  environment state, P4 records it as a deviation with the cheapest alternative.
- Presentation entries in `packages/shared/src/t3McpToolPresentation.ts` (beside
  `link_pull_request`, ~L99).
- Instructions: `TICKET_LINKING_INSTRUCTIONS` (`<ticket_linking>` block) beside
  `PULL_REQUEST_LINKING_INSTRUCTIONS` in `packages/provider-core/src/server/runtimeInstructions.ts`,
  appended by `buildRuntimeInstructions` only when `ticketLinking: true` (§6.11). The signal reaches
  every instruction site listed in §6.11 except two left unchanged on purpose (P4 deviation 4):
  `AntigravityAdapterV2.ts`'s static session append (the per-turn ACP text, which
  `packages/provider-acp/src/server/adapter.ts` appends on every non-slash turn, carries the
  block) and `ReplayRuntimeInstructions.ts` (recorded with Jira off). Tool visibility uses a new
  `McpInvocationScope.ticketTracker` flag and a `visibleWhileTicketsOn` `EnabledWhen` predicate in
  `apps/server/src/mcp/McpInvocationContext.ts`; P4 also edits
  `packages/client-runtime/src/t3ToolSummary.ts`, `agentContextBudget.json` and
  `evals/mcp-tool-use/run.ts`.
- Evals in `evals/mcp-tool-use/cases/tickets.ndjson` per `evals/README.md`, failing before the
  text change: proactive linking, provisional priority only when no ticket is linked, no
  unprompted `userRequested`.
- Instruction text, tool descriptions and eval cases are text deliverables (acceptance
  criteria, non-goals, invariants). P4 names the implementer model and effort for the text,
  chosen for prompt-writing ability, and requires the real text to be reviewed and eval-run at
  implementation time.

### P5 · Priority sort and setting

Spec "Effective priority and sort (client-runtime)" and "Setting". After P1 and P2.

- New `packages/client-runtime/src/state/threadPriority.ts` with the exact API in §6.12, subpath
  export `"./state/thread-priority"` in `packages/client-runtime/package.json` (beside
  `"./state/thread-inbox"`, ~L346), tests beside it. Exact code for resolution and comparator.
- Client setting `sidebarInboxSortOrder` (§6.10) in `ClientSettingsSchema` (~L393) and
  `ClientSettingsPatch` (~L2002) of `packages/contracts/src/settings.ts`, read by web/desktop.
  Mobile does not read `ClientSettings`; it stores the same `SidebarInboxSortOrder` as the
  mobile preference `inboxSortOrder` in `apps/mobile/src/persistence/mobile-preferences.ts`,
  beside `workingShelfEnabled` (P5 deviation 1).
- Call sites: web `apps/web/src/components/Sidebar.tsx` (sorted active list ~L682 and the
  drag-preview path ~L396), mobile `apps/mobile/src/features/threads/threadListV2.ts` (~L803)
  and `ThreadArrangementSheet.tsx` (~L209).
- Under `"priority"`: within-inbox reorder is disabled (web `activeReorderableThreadKeys` in
  `Sidebar.tsx`; mobile "Move up"/"Move down" by setting `reorderSupported` false in
  `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx`, which `thread-list-v2-items.tsx` already
  honours unchanged, and the arrangement sheet's inbox reordering); cross-section drags keep working; stored
  `activeOrderKey`s are never written or cleared.
- Surfaces: Settings > General row next to the Working section row
  (`apps/web/src/components/settings/SettingsPanels.tsx` ~L893, plus its restore-defaults lists
  ~L493 and ~L696), settings search entry (§6.10), a command palette entry in
  `apps/web/src/components/CommandPalette.tsx` (there are no existing sidebar sort entries in the
  palette at `ddec2d528a`; place it with the general actions and say so), and the mobile
  arrangement sheet option. Decides whether mobile Settings > General also gets the row.
- No docs (P6 writes them).

### P6 · Ticket and priority UI

Spec "Client UI". After P5 (and so after P1, P2). May ship as two PRs, web and mobile (section 5),
but is one plan.

- Web: inbox row priority indicator in `SidebarThreadRow` (`Sidebar.tsx`), glyph by scale
  position, tooltip "<name> · You" / "<name> · Jira <KEY>" / "<name> · Agent guess", no remote
  Jira images; ticket chips in thread header/details (key, title, status, unreachable state, open
  URL, unlink); thread context menu (`apps/web/src/components/threadActionMenu.logic.ts`,
  `apps/web/src/hooks/useThreadActionMenu.ts`) and command palette (`CommandPalette.tsx`):
  "Priority" submenu (scale + "Clear my priority"), "Link Jira ticket…" dialog, unlink per ticket.
  Follows `docs/internals/web-ui.md`, existing PR chip styling, and the components/ui variants rule.
- Mobile: row indicator and context-menu actions in
  `apps/mobile/src/features/threads/thread-list-v2-items.tsx` with a new row-level
  `useThreadTicketActions.ts` hook (not `useThreadListActions.ts`, P6 deviation 1), ticket chips
  and actions in a new `ThreadTicketsSheet.tsx` opened from `ThreadHeader.tsx`. On web, chips live
  in the thread details card only (P6 deviation 2). Shared pure decisions go in the new subpath
  `@t3tools/client-runtime/state/thread-ticket-presentation`.
- Uses P1's client commands (§6.5), P5's `effectiveThreadPriority` and `ticketPriorityScaleOf`
  (§6.12), and `jiraBrowseUrl` (§6.1) with `serverConfig.settings.jira?.siteUrl` when a link has
  no URL. DOM hooks for P7 in §6.13.
- Gating: priority UI when `capabilities.threadTickets === true`; link UI additionally when
  `jiraStatus.state !== "disconnected"` (contract question Q8).
- Docs: new `docs/user/jira-tickets.md` (connect Jira, link and unlink tickets, priority sources
  and precedence, Done tickets keep counting) and an Inbox order paragraph in
  `docs/user/thread-sidebar.md` next to the Working section text (~L140).
- Walks AGENTS.md "Hit every surface" and states each entry.

### P7 · End-to-end validation

Acceptance criteria, non-goals and invariants (not a script), run on the integration worktree
after P1-P6 merged: worktree dev server (`vp run dev`, seeded worktree `.t3`, never
`~/.t3/userdata`) connected read-only to the user's Jira Cloud site with site URL, email and API
token obtained via `request_secret`, on a few tickets the user names. Verifies linking (manual,
agent via the free `Replay (dev)` provider or the cheapest real model only if needed, branch
detection), precedence user > Jira > agent, Done tickets still counting, Jira priority/rank
changes made by the user in Jira reflected within about 2 minutes, inbox order under "Priority"
with the Working section on, settings connect/test/disconnect, token never visible to clients
(inspect the `subscribeServerConfig` payload, the `settingsUpdated` frames and the settings API
response; clients never read `settings.json` directly), reverse
states (unlink, clear priority, dismissed branch link stays dismissed after a branch re-set and a
reconnect). Web via `test-t3-app`, mobile via `test-t3-mobile`; visual checks by viewing rendered
screenshots. Invariants: T3 never writes to Jira; kill only PIDs captured at spawn; uses the DOM
hooks in §6.13.

---

## Spec coverage matrix

Every requirement in the spec has exactly one owning plan. The owner implements it and its
hermetic proof. "Also" names plans that consume or show it without owning it. P7 validates every
row end to end, so it owns only the end-to-end row. Composite goals are split so each part has
one owner.

| Spec requirement | Owner | Also |
| --- | --- | --- |
| Goal 1a: threads carry links to Jira tickets (state, commands, reducer) | P1 | P6 shows them |
| Goal 1b: agents link tickets on their own | P4 | — |
| Goal 1c: T3 links keys found in branch names | P3 | — |
| Goal 2: effective priority, user > Jira > agent | P5 (resolution) | P1 stores `priority`; P6 shows the source |
| Goal 3: scale is the Jira site's own priority list and order | P2 (reads it, `ticketPriorityScale`) | P5 resolves against it; P6 lists it |
| Goal 4: "Inbox order" client setting, Recently returned / Priority | P5 | P6 documents it |
| Goal 5: server keeps ticket data fresh from Jira | P3 | — |
| Non-goals (other trackers, Jira Server/DC, write-back, priority in folder/Working/Snoozed/Settled lists, filter/group) | scope limits, no owner | Guarded by P1 (`tracker: "jira"` only), P2 (Cloud REST v3, read-only calls), P5 (inbox list only; folder sidebar excluded), P7 invariant 1 |
| Anti-goal: a stale order shown as current | P3 (2-minute sweep, immediate fetch on link and reconnect) | P6 "last known data" notice; P7 F |
| Anti-goal: history and ws traffic growing per sync tick | P1 (no-op equality, stale guard, `updatedAt` preserved) | P3 dispatches only on a change via P1's reducer; P2 emits status/scale only on content change |
| Anti-goal: users without Jira pay for it, prompt text | P4 (tools hidden and instructions off while not configured) | P7 A, B5 |
| Anti-goal: users without Jira pay for it, sync work | P3 (sweep only while `isConfigured`) | — |
| Anti-goal: one-way doors (unlink, clear, dismissed branch link stays dismissed) | P1 (reducer: unlink, clear, tombstones incl. Q4) | P6 exposes every way out; P4 `unlink_ticket`, `null` priority |
| Constraint: event-sourced, Jira calls in a reactor after commit | P1 (commands/events/projections) | P3 is the reactor |
| Constraint: every client surface, sort in `packages/client-runtime` | P5 | P6 mobile + web |
| Constraint: remote ready, credential and sync per environment, clients never call Jira | P2 | P6 uses no remote Jira images |
| Constraint: one batched request per sweep, write only on change | P3 | P2 batches ≤100 keys per `bulkfetch` |
| Constraint: model-facing text through `evals/` with failing-first cases | P4 | — |
| Design: Thread state (contracts) | P1 (P1-contract milestone) | — |
| Design: Commands and events | P1 | — |
| Design: Effective priority and sort (client-runtime) | P5 | — |
| Design: Setting | P5 | P2 places the Jira section; P6 nothing |
| Design: Jira connection (server), incl. settings section and test connection | P2 | — |
| Design: Sync reactor (server) | P3 | — |
| Design: Branch-name detection (server) | P3 | — |
| Design: Agents (MCP + instructions) | P4 | — |
| Design: Client UI (row indicator, chips, menus, palette, mobile, user docs) | P6 | — |
| Left to the builder: Jira section location findable by search | P2 (Settings → Source control, `jira-connection`) | — |
| Left to the builder: indicator and chip visuals | P6 | — |
| Left to the builder: sweep gating and 429 backoff | P3 | — |
| End-to-end validation in a real client (user rule, AGENTS.md) | P7 | Per-plan real-client passes in §8 |

Testing strategies, together: P1-P5 ship focused hermetic tests at the lowest failing layer
(reducer tables, projection, decode, JiraService against `FakeJiraHttp`, reactor with
`TestClock`, comparator tables); P4 runs the MCP evals before and after the text change; P2, P5
and P6 each get one real-client pass by the primary agent (§8); P7 runs the whole feature against
the user's Jira read-only, on web and, where a device host exists, mobile, viewing screenshots for
the visual checks. Hermetic tests never call a real Jira (§7). This meets the spec's constraints
and AGENTS.md "Verifying"; the one possible gap is mobile on a Linux host (Decisions needed 20).

---

## 2. Plan-time DAG

All writers run in parallel from this contract.

```
P1 <- []   P2 <- []   P3 <- []   P4 <- []   P5 <- []   P6 <- []   P7 <- []
```

---

## 3. Implement-time DAG

`X:m` means milestone `m` of plan X has merged into `feat/thread-priority`; a bare `X` means the
whole plan has.

```
P1 <- []                    (publishes milestone P1-contract as its first commit)
P2 <- [P1:P1-contract]
P3 <- [P1, P2]
P4 <- [P1, P2]
P5 <- [P1, P2]
P6 <- [P1, P2, P5]
P7 <- [P1, P2, P3, P4, P5, P6]
```

- P1 and P2 run in parallel: P2 only waits for P1's first commit, because P2's contracts
  (`ServerConfig.ticketPriorityScale`, `JiraService.priorityScale`, the default scale) use
  `PriorityRef` and `DEFAULT_TICKET_PRIORITY_SCALE` from `threadTicket.ts`, and P2's settings UI
  gates on the `threadTickets` capability.
- P3, P4, P5 run in parallel after both P1 and P2 merged. P6 starts when P5 merged. Merge order
  into the integration branch is finish order among P3/P4/P5.
- Critical path: P1 → P5 → P6 → P7 (P2 alongside P1).

---

## 4. Deploy and version constraints

Server and clients ship from one integration branch that lands on `main` once, but remote
clients and servers of other versions must keep working (AGENTS.md "Remote ready").

| # | Constraint | Binds |
| --- | --- | --- |
| D1 | `ticketLinks` and `priority` are `Schema.optional` on thread and shell and decode leniently (a bad value becomes empty/null, never fails the thread). Old threads read as `[]` and `{ user: null, agent: null }`. | P1 |
| D2 | Clients dispatch `thread.ticket.link`, `thread.ticket.unlink`, `thread.priority.set` and show ticket/priority UI only when the thread's environment advertises `capabilities.threadTickets === true`. An older server would reject the unknown command type. | P1 (flag), P5, P6 |
| D3 | `ServerConfig.ticketPriorityScale` and `ServerConfig.jiraStatus` are `Schema.optionalKey`. The `ticketTrackerUpdated` stream event is sent only to subscribers that pass `ticketTracker: true`, because older clients reject unknown config event types and lose their subscription (pattern: `environmentThemes`, `usageLimitSources` in `WsSubscribeServerConfigRpc`). | P2 |
| D4 | Clients treat a missing `ticketPriorityScale` as `DEFAULT_TICKET_PRIORITY_SCALE` (`ticketPriorityScaleOf`), so a server without the field never breaks sorting. | P5, P6 |
| D5 | Agent instruction text and the tickets toolkit appear only when the environment has Jira configured. | P4 |
| D6 | `ServerSettings.jira` decodes with default `null`; `ServerSettingsPatch.jira` is `optionalKey`. The Jira settings section renders only when `capabilities.threadTickets` is present, so a new client never sends a patch an older server would silently drop. | P2 |
| D7 | `thread.ticket-link.sync` is in `OrchestrationV2InternalCommand` only; no client of any version can dispatch it. | P1 |
| D8 | Multi-environment inbox: each thread resolves priority against its own environment's scale; different Jira sites compare by position only (accepted approximation). | P5 |
| D9 | Downgrade: an older server re-writing a thread drops the unknown fields (Effect Schema ignores excess keys on decode). Accepted; nothing to build. | none |

---

## 5. Branch topology

Repository for every branch: `/home/lima/workspace/t3code` (worktrees of that repository).

| Unit | Branch | Base | Worktree | Created when | Merges into |
| --- | --- | --- | --- | --- | --- |
| Integration | `feat/thread-priority` | `main` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority` | exists (spec + plans) | `main`, once, at the end |
| P1 | `feat/thread-priority-p1` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p1` | immediately | `feat/thread-priority` (P1-contract commit first, then the branch) |
| P2 | `feat/thread-priority-p2` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p2` | after P1-contract merged | `feat/thread-priority` |
| P3 | `feat/thread-priority-p3` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p3` | after P1 and P2 merged | `feat/thread-priority` |
| P4 | `feat/thread-priority-p4` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p4` | after P1 and P2 merged | `feat/thread-priority` |
| P5 | `feat/thread-priority-p5` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p5` | after P1 and P2 merged | `feat/thread-priority` |
| P6 (web, or whole plan if not split) | `feat/thread-priority-p6` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p6` | after P5 merged | `feat/thread-priority` |
| P6 mobile (only if split) | `feat/thread-priority-p6-mobile` | `feat/thread-priority` | `/home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p6-mobile` | after P5 merged; after P6 web merged if it needs web-branch code | `feat/thread-priority` |
| P7 | none (runs on `feat/thread-priority`) | n/a | the integration worktree | after P1-P6 merged | n/a; fixes go through a branch `feat/thread-priority-fix-<slug>` from the integration branch, reviewed and merged forward like a plan |

Each plan's `## Implementation Location` uses exactly this format with its row's values (one block
per PR if P6 splits):

```
## Implementation Location
- **Branch:** feat/thread-priority-p1
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p1
- **Base branch:** feat/thread-priority
```

Rules:

- **Create** each child worktree with the `git-tools:worktree` skill (equivalent: `git worktree add
  -b <branch> <worktree> feat/thread-priority` from `/home/lima/workspace/t3code`). Then follow
  AGENTS.md "Dev servers": if no `.t3/setup-*` marker appears, run `vp i` (or
  `node scripts/setup-worktree.ts`) in the child.
- **Milestone merge (P1-contract):** after the milestone commit's own checks pass, merge that commit
  (not the branch head) into the integration worktree: `git merge --no-ff <sha> -m "merge:
  P1-contract (feat/thread-priority-p1)"`. P1 keeps working; its later merge brings the rest.
- **Plan merge:** when a plan's verification passes and its independent review findings are
  resolved, from the integration worktree: `git merge --no-ff feat/thread-priority-pN -m "merge: PN"`.
  The integration worktree must be clean before any merge.
- **Rebase on parent merge:** when the integration branch moves after a child was created and the
  child needs that code or would conflict at its merge, rebase the child onto it
  (`git rebase feat/thread-priority` in the child), never merge the integration branch into the
  child. Re-run the plan's checks afterwards. These branches are local without upstream, so
  rebasing needs no permission; rebasing a branch that has been pushed needs the user's explicit
  permission (ask instead of back-merging). Expected rebases: P1 over nothing; whichever of P3/P4/P5
  merges later rebases over the earlier ones' `server.ts` / `settings.ts` / `settingsSearch.ts`
  hunks (section 9 lists the shared files).
- Nothing is pushed and no PR is opened unless the user asks. The integration branch lands on
  `main` once, after P7.

---

## 6. Shared interfaces (exact)

### 6.1 `packages/contracts/src/threadTicket.ts` (P1-contract; read-only for everyone else)

Schemas (Effect Schema, imports from `./baseSchemas.ts`: `IsoDateTime`, `TrimmedNonEmptyString`):

```ts
/** Canonical Jira issue key, upper case: PROJ-123. */
export const ThreadTicketKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9_]+-[0-9]+$/));
export type ThreadTicketKey = typeof ThreadTicketKey.Type;

/** branch-dismissed: the user removed a branch-detected link; hidden, and branch detection never re-adds it. */
export const ThreadTicketLinkSource = Schema.Literals(["manual", "agent", "branch", "branch-dismissed"]);
/** Sources a link command may carry. */
export const ThreadTicketCommandSource = Schema.Literals(["manual", "agent", "branch"]);

export const ThreadTicketStatusCategory = Schema.Literals(["new", "indeterminate", "done"]);

export const PriorityRef = Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString });
export type PriorityRef = typeof PriorityRef.Type;

export const ThreadTicketSnapshot = Schema.Struct({
  title: Schema.String,
  statusName: Schema.String,
  statusCategory: ThreadTicketStatusCategory,
  priority: Schema.NullOr(PriorityRef),
  rank: Schema.NullOr(Schema.String),   // Jira LexoRank, compared by code unit
  syncedAt: IsoDateTime,                // when the reactor read this data
});

export const ThreadTicketSyncError = Schema.Literals(["not_found", "forbidden"]);

export const ThreadTicketLink = Schema.Struct({
  tracker: Schema.Literal("jira"),
  key: ThreadTicketKey,
  url: Schema.NullOr(TrimmedNonEmptyString),   // canonical browse URL when known
  source: ThreadTicketLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadTicketSnapshot),
  syncError: Schema.NullOr(ThreadTicketSyncError),
});

export const ThreadPriority = Schema.Struct({
  user: Schema.NullOr(PriorityRef),
  agent: Schema.NullOr(PriorityRef),
});
export const EMPTY_THREAD_PRIORITY: ThreadPriority = { user: null, agent: null };

/** Lenient storage forms (like StoredThreadTags): a value this build cannot read becomes empty. */
export const StoredThreadTicketLinks  // Schema.Array(ThreadTicketLink) + catchDecoding -> []
export const StoredThreadPriority     // ThreadPriority + catchDecoding -> EMPTY_THREAD_PRIORITY

export const DEFAULT_TICKET_PRIORITY_SCALE: ReadonlyArray<PriorityRef> = [
  { id: "default:highest", name: "Highest" },
  { id: "default:high", name: "High" },
  { id: "default:medium", name: "Medium" },
  { id: "default:low", name: "Low" },
  { id: "default:lowest", name: "Lowest" },
];
```

Every schema exports its `Type` alias with the same name. Helpers (pure, no I/O):

| Signature | Behaviour |
| --- | --- |
| `parseTicketReference(input: string): { key: ThreadTicketKey; url: string \| null } \| null` | Trims. A bare key matching `^[A-Za-z][A-Za-z0-9_]+-[0-9]+$` → upper-cased key, `url: null`. An `http(s)` URL whose path contains `/browse/<KEY>` or whose query has `selectedIssue=<KEY>` → upper-cased key and `url` = `${origin}/browse/${KEY}`. Anything else → `null`. |
| `branchTicketKeys(branch: string \| null): ReadonlyArray<ThreadTicketKey>` | All matches of `/(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]+-[0-9]+)(?![0-9])/g`, upper-cased, deduped, in order of appearance. `null` → `[]`. |
| `jiraBrowseUrl(siteUrl: string, key: ThreadTicketKey): string` | `${siteUrl without trailing slashes}/browse/${key}`. |
| `visibleThreadTicketLinks(links: ReadonlyArray<ThreadTicketLink>): ReadonlyArray<ThreadTicketLink>` | Links whose `source !== "branch-dismissed"`. |
| `isReadableThreadTicketLink(link: ThreadTicketLink): boolean` | `source !== "branch-dismissed" && snapshot !== null && syncError === null`. |
| `threadTicketSnapshotsEqual(a: ThreadTicketSnapshot, b: ThreadTicketSnapshot): boolean` | Equal in `title`, `statusName`, `statusCategory`, `rank`, and `priority` (both null, or same `id` and `name`); ignores `syncedAt`. |
| `findPriorityInScale(scale: ReadonlyArray<PriorityRef>, value: { readonly id?: string; readonly name?: string } \| string): { ref: PriorityRef; position: number } \| null` | Match by exact `id` first, then by case-insensitive `name`. A string is tried as id, then as name. `position` is the index in `scale` (0 = highest). No match → `null`. |

### 6.2 Thread fields (`packages/contracts/src/orchestrationV2.ts`, P1)

On both `OrchestrationV2AppThread` and `OrchestrationV2ThreadShell`, next to `pullRequests`:

```ts
ticketLinks: Schema.optional(StoredThreadTicketLinks),
priority: Schema.optional(StoredThreadPriority),
```

No change to the `*Json` `mapFields` variants is needed (all new date fields are `IsoDateTime`
strings). Client model `EnvironmentThreadShell` (`packages/client-runtime/src/state/models.ts`)
gets normalized, non-optional fields:

```ts
readonly ticketLinks: ReadonlyArray<ThreadTicketLink>;   // absent -> []
readonly priority: ThreadPriority;                         // absent -> EMPTY_THREAD_PRIORITY
```

### 6.3 Commands and events (P1)

Client commands, added to `OrchestrationV2Command` (dispatched by clients through the existing
`orchestration.dispatchCommand`, which `RPC_REQUIRED_SCOPES` in
`apps/server/src/auth/RpcAuthorization.ts` already guards with `AuthOrchestrationOperateScope`):

```ts
{ type: "thread.ticket.link", commandId: CommandId, threadId: ThreadId,
  key: ThreadTicketKey, url: Schema.optional(TrimmedNonEmptyString), source: ThreadTicketCommandSource }
{ type: "thread.ticket.unlink", commandId: CommandId, threadId: ThreadId, key: ThreadTicketKey }
{ type: "thread.priority.set", commandId: CommandId, threadId: ThreadId,
  source: Schema.Literals(["user", "agent"]), priority: Schema.NullOr(PriorityRef) }
```

Server-only command, added to `OrchestrationV2InternalCommand`:

```ts
{ type: "thread.ticket-link.sync", commandId: CommandId, threadId: ThreadId, key: ThreadTicketKey,
  observedAt: IsoDateTime,
  result: Schema.Union([
    Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: ThreadTicketSnapshot }),
    Schema.Struct({ type: Schema.Literal("unreachable"), syncError: ThreadTicketSyncError }),
  ]) }
```

Events: `"thread.ticket-links-updated"` and `"thread.priority-updated"`, both added to the
thread-payload literal list (payload `OrchestrationV2AppThread`) in `OrchestrationV2DomainEvent`
(~L1936) and `OrchestrationV2DomainEventJson` (~L2836, payload `OrchestrationV2AppThreadJson`).
Link, unlink and sync emit `thread.ticket-links-updated`; priority set emits
`thread.priority-updated`. A command that changes nothing emits no event and succeeds.

Reducer rules (P1 writes the exact code):

| Command | Rule |
| --- | --- |
| link | Key absent → append `{ tracker: "jira", key, url: url ?? null, source, linkedAt: now, snapshot: null, syncError: null }`. Present and not `branch-dismissed` → no-op. Present as `branch-dismissed`: `source: "branch"` → no-op (stays dismissed); `manual`/`agent` → set `source` to the command's (undismiss), keep snapshot, set `url` if given. |
| unlink | Key absent or already `branch-dismissed` → no-op. Link `source === "branch"`, **or** the key is in `branchTicketKeys(thread.branch)` → becomes `{ ...link, source: "branch-dismissed", snapshot: null, syncError: null }`. Otherwise removed. |
| sync | No link with the key, or link is `branch-dismissed` → no-op. `link.snapshot !== null && observedAt < link.snapshot.syncedAt` → no-op (stale). `snapshot` result: no-op when `link.syncError === null && link.snapshot !== null && threadTicketSnapshotsEqual(link.snapshot, result.snapshot)`, else `{ snapshot: result.snapshot, syncError: null }`. `unreachable` result: no-op when `link.syncError === result.syncError`, else `{ syncError: result.syncError }` keeping the old snapshot (for its title). |
| priority.set | Writes `priority[source] = priority` (null clears). No-op when the stored value equals it (both null, or same `id` and `name`). |

All four keep `updatedAt` unchanged on the server thread; `ProjectionStore` and the client
projection treat both events like `thread.tags-updated` (no `updatedAt` bump), so linking, syncing
and setting priority never reorder a thread by recency. Archived threads accept all four (no new
guard); the existing missing/deleted-thread guards apply.

### 6.4 `ThreadTicketService` (P1; used by P3 and P4)

File `apps/server/src/orchestration-v2/ThreadTicketService.ts`; `export class ThreadTicketService
extends Context.Service<...>()("t3/orchestration-v2/ThreadTicketService")`, `export const layer`.
Depends on `Orchestrator.OrchestratorV2`, `ProjectionStore.ProjectionStoreV2`, `SecureRandom`.
Methods use `Effect.fn("ThreadTicketService.<method>")`:

```ts
readonly linkTicket: (input: {
  readonly threadId: ThreadId;
  readonly key: ThreadTicketKey;
  readonly url: string | null;
  readonly source: ThreadTicketCommandSource;
}) => Effect.Effect<{ readonly linked: boolean }, ThreadTicketError>;   // false: reducer no-op
readonly unlinkTicket: (input: {
  readonly threadId: ThreadId;
  readonly key: ThreadTicketKey;
}) => Effect.Effect<{ readonly unlinked: boolean }, ThreadTicketError>;
readonly setThreadPriority: (input: {
  readonly threadId: ThreadId;
  readonly source: "user" | "agent";
  readonly priority: PriorityRef | null;
}) => Effect.Effect<{ readonly changed: boolean }, ThreadTicketError>;
```

`ThreadTicketError = ThreadTicketThreadNotFoundError | ThreadTicketDispatchError` (both
`Schema.TaggedError` in the same file; the dispatch error wraps the orchestrator's cause). Each
method checks the thread exists, dispatches the §6.3 command with a server command id, and returns
`storedEvents.length > 0` from the dispatch result (these commands emit one event on a change and
none otherwise), so the boolean cannot disagree with what committed (P1 deviation 1).
Inputs are canonical: parsing keys/URLs and resolving priority names is the caller's job
(§6.1 helpers). Clients do not use this service; they dispatch the same commands, so UI, MCP and
the reactor share one reducer.

### 6.5 Client commands (P1; used by P6)

`packages/client-runtime/src/operations/commands.ts`, next to `linkThreadPullRequest`:

```ts
export type LinkThreadTicketInput = Omit<Extract<OrchestrationV2Command, { type: "thread.ticket.link" }>, "type" | "commandId"> & CommandMetadata;
export type UnlinkThreadTicketInput = Omit<Extract<OrchestrationV2Command, { type: "thread.ticket.unlink" }>, "type" | "commandId"> & CommandMetadata;
export type SetThreadPriorityInput = Omit<Extract<OrchestrationV2Command, { type: "thread.priority.set" }>, "type" | "commandId"> & CommandMetadata;
export const linkThreadTicket    // Effect.fn("EnvironmentCommands.linkThreadTicket")
export const unlinkThreadTicket  // Effect.fn("EnvironmentCommands.unlinkThreadTicket")
export const setThreadPriority   // Effect.fn("EnvironmentCommands.setThreadPriority")
```

`createThreadEnvironmentAtoms` (`packages/client-runtime/src/state/threadCommands.ts`) gains
`linkTicket`, `unlinkTicket`, `setPriority` via `createEnvironmentCommand` with labels
`environment-data:commands:thread:link-ticket`, `:unlink-ticket`, `:set-priority`, sharing the
per-thread serial `concurrency`. UI reaches them as `threadEnvironment.linkTicket` etc.
(`apps/web/src/state/threads.ts`, `apps/mobile/src/state/threads.ts`). No new ws method and no
`CLIENT_GUARDED_RPC_SCOPES` entry for thread mutations (contract question Q1).

### 6.6 Jira contracts (P2): `packages/contracts/src/jira.ts` and `settings.ts`

```ts
// jira.ts
export const JiraSettings = Schema.Struct({
  siteUrl: TrimmedNonEmptyString,   // stored leniently; the patch schema enforces JiraSiteUrl
  email: TrimmedNonEmptyString,
  apiToken: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true })),   // = secretSetting, which settings.ts would cycle on
});
export function normalizeJiraSiteUrl(input: string): string | null;   // https origin or null
export const JiraSiteUrl = TrimmedNonEmptyString.check(/* normalizeJiraSiteUrl(v) === v */);
export const JiraErrorKind = Schema.Literals(["auth", "unavailable", "response"]);
export const JiraConnectionStatus = Schema.Struct({
  state: Schema.Literals(["disconnected", "connected", "error"]),
  siteUrl: Schema.NullOr(TrimmedNonEmptyString),
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.Struct({ kind: JiraErrorKind, message: Schema.String, since: IsoDateTime })),
});
/** Unsaved settings to test; a redacted token keeps the stored one (as ListTextGeneratorModelsInput). */
export const JiraTestConnectionInput = Schema.Struct({ settings: Schema.optional(JiraSettings) });
export const JiraTestConnectionResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), accountName: TrimmedNonEmptyString,
                  priorityScale: Schema.Array(PriorityRef) }),
  Schema.Struct({ type: Schema.Literal("failed"),
                  kind: Schema.Literals(["auth", "unavailable", "response", "invalid_site"]),
                  message: Schema.String }),
]);
```

(`JiraSettings` stays in `jira.ts`; it annotates the key directly, as `device.ts` does, because
`settings.ts` imports `jira.ts`. A `jira.test.ts` row pins `secretSettingsFields(JiraSettings)` to
`["apiToken"]`.)

`settings.ts`:
- `ServerSettings.jira: Schema.NullOr(JiraSettings).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`.
- `ServerSettingsPatch.jira: Schema.optionalKey(Schema.NullOr(Schema.Struct({ siteUrl: JiraSiteUrl,
  email, apiToken: Schema.optionalKey(SettingsSecretValue) })))`; `applyServerSettingsPatch` needs
  no change (generic `deepMerge` keeps a saved token; P2 adds only a test); `null` disconnects (clears the stored
  token), an omitted or redacted `apiToken` keeps the stored one. Scope: `AuthSettingsWriteScope`
  (the default branch of `requiredScopesForServerSettingsPatch`).
- Secret slot name `jira-api-token`, registered in `mapSecretFieldGroups`. Clients only ever see `""` or
  `SECRET_REDACTED` for `apiToken`; `siteUrl` and `email` are visible to clients.

RPC: `WS_METHODS.serverTestJiraConnection = "server.testJiraConnection"`, payload
`JiraTestConnectionInput`, success `JiraTestConnectionResult`, error
`EnvironmentAuthorizationError`; `CLIENT_GUARDED_RPC_SCOPES[serverTestJiraConnection] =
AuthSettingsWriteScope` (it spends the stored token). Client command name `testJiraConnection` in
`packages/client-runtime/src/state/server.ts`.

### 6.7 `JiraService` (P2; used by P3, P4, ws)

File `apps/server/src/jira/JiraService.ts`; `export class JiraService extends
Context.Service<...>()("t3/jira/JiraService")`, `export const layer`. Owns all Jira HTTP (Effect
`HttpClient`, so tests swap `FetchHttpClient.Fetch`), reads `ServerSettings.jira` live from the
settings service, resolves the token through the settings-secret mechanism.

```ts
readonly isConfigured: Effect.Effect<boolean>;              // jira !== null and token resolves non-empty; live
readonly status: Effect.Effect<JiraConnectionStatus>;
readonly streamStatus: Stream.Stream<JiraConnectionStatus>; // current value first, then each distinct change
readonly priorityScale: Effect.Effect<ReadonlyArray<PriorityRef>>;              // site order, highest first; DEFAULT_TICKET_PRIORITY_SCALE when not connected or not yet read
readonly streamPriorityScale: Stream.Stream<ReadonlyArray<PriorityRef>>;        // current first, then distinct changes
readonly browseUrl: (key: ThreadTicketKey) => Effect.Effect<string | null>;     // jiraBrowseUrl(siteUrl, key); null when not configured
readonly projectKeys: Effect.Effect<ReadonlySet<string>, JiraError>;            // cached project keys (upper case)
readonly fetchTickets: (
  keys: ReadonlyArray<ThreadTicketKey>,
) => Effect.Effect<ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>, JiraError>;
readonly testConnection: (input: JiraTestConnectionInput) => Effect.Effect<JiraTestConnectionResult>;
```

```ts
export type JiraTicketFetchResult =
  | { readonly type: "found"; readonly snapshot: Omit<ThreadTicketSnapshot, "syncedAt"> }
  | { readonly type: "unreachable"; readonly syncError: ThreadTicketSyncError };
export type JiraError = JiraNotConfiguredError | JiraAuthError | JiraUnavailableError | JiraResponseError;
// Schema.TaggedError classes in JiraService.ts:
//   JiraNotConfiguredError {}
//   JiraAuthError { status: number; message: string }               401/403 on the site or token
//   JiraUnavailableError { message: string; retryAfterMs?: number }  network, 5xx, 429 (Retry-After)
//   JiraResponseError { message: string }                            unexpected status or shape
```

Behaviour pinned for consumers:
- `fetchTickets` returns an entry for every requested key; it batches at most 100 keys per Jira
  request and reads summary, status (name and category key), priority (id and name) and the rank
  field. Status category keys other than `new`/`indeterminate`/`done` map to `new`.
- `JiraService` updates its own `status` from every Jira request it makes (an auth or outage error
  sets `state: "error"` with `since` set when the error first appears and unchanged while it
  persists; the next success clears it). Consumers do not report into it. `status` and
  `priorityScale` change only when their content changes, so a healthy sweep emits nothing.
- Scale: read on connect and hourly; project keys cached and refreshed on the same schedule; rank
  field id discovered once per connection.
- `testConnection` never mutates settings. Exception (D7, resolved): a successful test that used the *saved* settings clears an auth-error status/pause.
- Auth fail-fast: while `status.error?.kind === "auth"`, `fetchTickets` and `projectKeys` fail with
  `JiraAuthError` without a request; only the hourly refresh (`/myself`) or a settings change
  retries. This keeps a revoked token from sending 30 failing requests an hour (P2 deviation 5).
- `JiraTicketFetchResult` `forbidden` is never produced: Jira reports invisible and missing issues
  alike, so both read `not_found` (Q3). A moved issue also reads `not_found` under its old key.
- Endpoints, all read-only: `GET /rest/api/3/myself`, `/priority/search`, `/field`,
  `/project/search`, and `POST /rest/api/3/issue/bulkfetch`.

### 6.8 `ServerConfig`, capability, late updates

- Capability (P1-contract, `packages/contracts/src/environment.ts`,
  `ExecutionEnvironmentCapabilities`): `threadTickets: Schema.optionalKey(Schema.Boolean)` with a
  one-line doc comment; set to `true` by P1 in `ServerEnvironment.ts`. Meaning: the server accepts
  the §6.3 commands, carries the §6.2 fields, and (once P2 lands) sends the fields below.
- `ServerConfig` (P2, `packages/contracts/src/server.ts`):
  `ticketPriorityScale: Schema.optionalKey(Schema.Array(PriorityRef))` and
  `jiraStatus: Schema.optionalKey(JiraConnectionStatus)`, both filled in every snapshot from
  `JiraService.priorityScale` / `JiraService.status`.
- Late updates (P2): `ServerConfigStreamTicketTrackerUpdatedEvent = { version: 1, type:
  "ticketTrackerUpdated", payload: { ticketPriorityScale: Array(PriorityRef), jiraStatus:
  JiraConnectionStatus } }`, added to `ServerConfigStreamEvent`, emitted on changes of either
  stream, only when the subscribe payload has `ticketTracker: true`
  (`WsSubscribeServerConfigRpc` payload gains `ticketTracker: Schema.optional(Schema.Boolean)`).
  `applyServerConfigProjection` writes both fields onto the projected config.
- Client accessor (P5): `ticketPriorityScaleOf(config)` (§6.12).

### 6.9 `TicketSyncReactor` and its query (P3)

```ts
export class TicketSyncReactor extends Context.Service<TicketSyncReactor, {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}>()("t3/orchestration-v2/TicketSyncReactor") {}
```

`ProjectionStoreV2Shape.getThreadsWithTicketLinks: (threadId?: ThreadId) =>
Effect<ReadonlyArray<ProjectionThreadTicketLinks>, ProjectionStoreV2Error>` with
`ProjectionThreadTicketLinks = Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage" |
"settledOverride" | "settledAt" | "branch" | "ticketLinks">`, selecting non-deleted, non-archived
threads with `json_array_length(payload_json, '$.ticketLinks') > 0`.

Reconnect trigger: an emission of `JiraService.streamStatus` with `state: "connected"` when the
previous emission was not `"connected"` (including the first) enqueues a full immediate fetch.
New links are fetched from the `thread.ticket-links-updated` event (any visible link with
`snapshot === null && syncError === null`), so linking needs no extra API. Commands dispatched:
`thread.ticket-link.sync` (`observedAt` = the read time, `snapshot.syncedAt` = the same value) and
`ThreadTicketService.linkTicket({ source: "branch" })`.

### 6.10 Client setting and settings search

`packages/contracts/src/settings.ts` (P5):

```ts
export const SidebarInboxSortOrder = Schema.Literals(["returned", "priority"]);
export type SidebarInboxSortOrder = typeof SidebarInboxSortOrder.Type;
export const DEFAULT_SIDEBAR_INBOX_SORT_ORDER: SidebarInboxSortOrder = "returned";
// ClientSettingsSchema:
sidebarInboxSortOrder: SidebarInboxSortOrder.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_INBOX_SORT_ORDER))),
// ClientSettingsPatch:
sidebarInboxSortOrder: Schema.optionalKey(SidebarInboxSortOrder),
```

UI labels: setting "Inbox order", options "Recently returned" (`returned`) and "Priority"
(`priority`).

`apps/web/src/components/settings/settingsSearch.ts` entries:
- P2: `{ id: "jira-connection", title: "Jira", to: "/settings/source-control", targetId:
  "jira-connection", scope: "environment-defaults", environmentOnly: true, searchTerms: ["jira
  atlassian ticket issue priority rank api token connect"] }`; the section root element has
  `id="jira-connection"`. P6 adds `jira tickets` to the existing `thread-details-items` terms.
- Mobile stores the order as the mobile preference `inboxSortOrder` (P5 deviation 1), with a row
  in mobile Settings beside the Working section switch. The setting has no capability gate.
- P5: `{ id: "inbox-order", title: "Inbox order", to: "/settings/general", searchTerms: ["inbox
  sort order priority jira recently returned"] }`, next to the `working-shelf` entry (~L462).

### 6.11 "Is Jira configured" signal and instructions (P2 provides, P3/P4 consume)

- Server truth: `JiraService.isConfigured` (live). The reactor checks it at each sweep and reacts
  to `streamStatus`. Branch detection checks it too.
- Instructions: `buildRuntimeInstructions(runtime)` gains `readonly ticketLinking?: boolean`
  (absent = false); when true it appends `TICKET_LINKING_INSTRUCTIONS` after the pull request block.
  `ProviderAdapterV2OpenSessionInput` (`packages/provider-core/src/server/ProviderAdapter.ts`)
  gains `readonly ticketLinking?: Effect.Effect<boolean>`, mirroring `promptSuggestions` ("read
  live"), filled from `JiraService.isConfigured` where `ProviderSessionManager.ts` fills
  `promptSuggestions` (~L2476). Instruction sites P4 must cover (all at `ddec2d528a`):
  `ClaudeAdapterV2.ts` (session `systemPrompt.append`, ~L1951), `AntigravityAdapterV2.ts`
  (`sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS`, ~L148),
  `apps/server/src/provider/CodexDeveloperInstructions.ts`, `packages/provider-acp/src/server/adapter.ts`,
  `packages/provider-cursor/src/server/adapter.ts`, `packages/provider-opencode/src/server/adapter.ts`
  and `.../v2/adapter.ts`, `packages/provider-muse/src/server/adapter.ts`, and
  `apps/server/src/orchestration-v2/testkit/ReplayRuntimeInstructions.ts`. P4 leaves
  `AntigravityAdapterV2.ts` (covered by the ACP per-turn text) and `ReplayRuntimeInstructions.ts`
  (Jira off in recordings) unchanged. P4 evaluates `ticketLinking` once per session for every
  adapter except Claude, so the text never runs ahead of the session's fixed MCP tool list; a
  (dis)connect takes effect on the next session (P4 deviation 5).
- Clients: `capabilities.threadTickets` for priority UI; `jiraStatus.state !== "disconnected"` for
  Jira-dependent UI (link dialog, chips' "open in Jira").

### 6.12 Client-runtime priority helpers (P5; used by P6)

`packages/client-runtime/src/state/threadPriority.ts`, imported as
`@t3tools/client-runtime/state/thread-priority`:

```ts
export type ThreadPrioritySource = "user" | "jira" | "agent";
export interface EffectiveThreadPriority {
  readonly ref: PriorityRef;               // the matched scale entry
  readonly source: ThreadPrioritySource;
  readonly position: number;               // index in the scale, 0 = highest
  readonly ticketKey: ThreadTicketKey | null;  // the link that supplied it when source is "jira"
}
type PriorityThreadInput = Pick<EnvironmentThreadShell, "ticketLinks" | "priority">;
export function effectiveThreadPriority(thread: PriorityThreadInput, scale: ReadonlyArray<PriorityRef>): EffectiveThreadPriority | null;
export function threadJiraRank(thread: Pick<EnvironmentThreadShell, "ticketLinks">): string | null;
export function sortInboxThreadsByPriority<T extends InboxThreadInput & PriorityThreadInput>(
  threads: readonly T[],
  scaleFor: (thread: T) => ReadonlyArray<PriorityRef>,
  observedReturnAt?: (thread: T) => number | undefined,
): T[];
export function ticketPriorityScaleOf(config: { readonly ticketPriorityScale?: ReadonlyArray<PriorityRef> } | null | undefined): ReadonlyArray<PriorityRef>;
```

(`InboxThreadInput` is the `Pick` used by `sortInboxThreadsByReturn` in `threadInbox.ts`; P5
exports or re-declares it.) Semantics: user value (resolved with `findPriorityInScale`) > best
position among readable links (`isReadableThreadTicketLink`, Done included) whose
`snapshot.priority` resolves > agent value; an unresolvable value falls through to the next source.
Rank = smallest non-null `snapshot.rank` among readable links, compared by code unit (`<`), not
`localeCompare`. `InboxThreadInput` is exported from `threadInbox.ts` (P5). Sort: prioritized
before unprioritized; position ascending; within a position,
ranked before unranked, rank ascending; remaining ties and the unprioritized group in
`sortInboxThreadsByReturn` order, with the Working section on or off (Q9; with it off,
`inboxReturns` observes nothing, so the tie-break uses the thread's own timestamps).
`ticketPriorityScaleOf` returns the config's scale, or `DEFAULT_TICKET_PRIORITY_SCALE` when the
scale is absent or empty (P5 deviation 2).

### 6.13 DOM and command hooks (P5, P6 add; P7 uses)

- Web inbox row indicator: `data-thread-priority="<user|jira|agent>"` and
  `data-thread-priority-position="<n>"` on the indicator element; absent when no effective priority.
- Ticket chip: `data-ticket-key="<KEY>"`, plus `data-ticket-unreachable` when `syncError !== null`.
- Jira settings section root: `id="jira-connection"` (§6.10).
- Command palette `value`s: P5 `action:inbox-order`; P6 `action:thread-priority`,
  `action:link-jira-ticket`, `action:unlink-jira-ticket:<KEY>`.
- Mobile: P6 exposes `testID`s with the same names where React Native needs them.

---

## 7. Shared test fixtures and harnesses

| Fixture | Built by | File | Reused by |
| --- | --- | --- | --- |
| Server ticket builders `makeTicketLink(overrides)`, `makeTicketSnapshot(overrides)` | P1 | `apps/server/src/orchestration-v2/testkit/ticketFixtures.ts` (pattern: `testkit/pullRequestFixtures.ts`) | P1 tests, P3 reactor tests, P4 handler tests |
| Fake Jira HTTP: an in-memory site (priorities, fields incl. a `gh-lexo-rank` field, projects, issues, per-key not-found/forbidden, scripted 401/429/5xx) served through a fake `FetchHttpClient.Fetch` (pattern: `textGeneration/TextGenerators.test.ts`) | P2 | `apps/server/src/jira/testing/FakeJiraHttp.ts` | P2's `JiraService.test.ts` and ws/config tests |
| `JiraService` test double: `makeTestJiraService(initial)` returning a `Layer` plus a controller to set configured/status/scale/project keys/ticket results/errors and to count `fetchTickets` calls and keys | P2 | `apps/server/src/jira/testing/JiraServiceTest.ts` | P3 (reactor), P4 (handlers, instruction gating) |
| Client shell objects with ticket links and priority | P5 | inline in `threadPriority.test.ts` (helpers take `Pick<>` inputs, plain objects suffice) | P6 (copies the pattern; no shared module) |
| MCP eval harness | existing | `evals/mcp-tool-use/` | P4 |

Test homes the plans chose: P1's `ThreadTicketService` test is in `runtimeLayer.test.ts`; P3's
`getThreadsWithTicketLinks` test is in `ProjectionSettlement.test.ts`; P2's patch-merge row is in
`packages/shared/src/serverSettings.test.ts`.

Hermetic tests never call a real Jira. Only P7 (and optional read-only probes during P2's
implementation) talk to the user's Jira Cloud site, with credentials from `request_secret`.

---

## 8. Verification and review (all implementing plans)

- Iterate with `vp test run <files>`; typecheck affected packages with
  `vp run @t3tools/contracts#typecheck`, `vp run @t3tools/client-runtime#typecheck`,
  `vp run t3#typecheck` (server), `vp run @t3tools/web#typecheck`, `vp run @t3tools/mobile#typecheck`,
  `vp run @t3tools/provider-core#typecheck` as relevant; before handoff `vp run check:changed`.
  No repo-wide checks (`vp check`, `vp run -r ...`).
- Tests follow AGENTS.md: drain the effect worker or await persisted events / `Deferred`s, no
  sleeps or polling, `TestClock` for the 2-minute sweep and hourly refresh.
- Subagents do not launch dev servers. The primary agent does one integrated real-client pass per
  user-visible plan (P2 settings, P5, P6) with `test-t3-app` / `test-t3-mobile` against the
  child worktree's own `.t3`, and P7 does the full run.
- Every plan's implementation gets an independent review (fresh-context reviewer) before it merges
  forward; findings fixed or justified, and the handoff reports them.

---

## 9. File ownership for files more than one plan edits

Order = merge order; a later plan rebases over the earlier plan's hunks. Files not listed have a
single owner (named in section 1).

| File | Plans and their edits | Order |
| --- | --- | --- |
| `packages/contracts/src/index.ts` | P1: export `threadTicket.ts` (P1-contract). P2: export `jira.ts`. | P1 → P2 |
| `packages/contracts/src/settings.ts` | P2: `ServerSettings.jira`, `ServerSettingsPatch.jira` (and `JiraSettings` if it lives here). P5: `SidebarInboxSortOrder`, `ClientSettingsSchema` / `ClientSettingsPatch` field. | P2 → P5 |
| `packages/contracts/src/environment.ts` | P1 only (`threadTickets`, in P1-contract). Listed because P2, P5, P6 read the flag. | P1 |
| `packages/contracts/src/orchestrationV2.ts` | P1 only. | P1 |
| `packages/contracts/src/server.ts`, `rpc.ts`, `clientRpcPermissions.ts` | P2 only. | P2 |
| `apps/server/src/server.ts` | P1: `ThreadTicketService.layer` as the first `provideMerge` of `layerRuntimeCoreDependenciesBase`. P2: `JiraService.layer` in the `Keybindings`/`EnvironmentTheme`/`UsageLimitSources` `mergeAll` group. P3: start `TicketSyncReactor` beside `PullRequestSyncReactor`; no provide for either service. P4: expected no change; if typecheck says a service is unreachable, fix the placement in P1/P2's hunk or pass the same `JiraService.layer` reference, never a second instance. | P1 ∥ P2 (second rebases) → P3 ∥ P4 |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` | P1: event application and shell fields. P3: `getThreadsWithTicketLinks` (test in `ProjectionSettlement.test.ts`). | P1 → P3 |
| `apps/server/src/orchestration-v2/threadTicketReducer.ts` | P1 creates. P3 imports `syncThreadTicketLinks` (no edit). | P1 |
| `apps/server/src/mcp/McpInvocationContext.ts`, `packages/client-runtime/src/t3ToolSummary.ts`, `evals/mcp-tool-use/run.ts` | P4 only. | P4 |
| `apps/server/src/jira/jiraApi.ts`, `apps/server/src/settingsSecrets.ts`, `apps/server/src/sourceControl/sourceControlHostSecrets.ts`, `apps/web/src/components/settings/SecretsSettings.logic.ts`, `packages/shared/src/serverSettings.test.ts` | P2 only. | P2 |
| `apps/{web,mobile}/src/connection/runtime.ts`, `apps/{web,mobile}/src/state/server.ts` | P2 only (`ticketTracker: true` opt-in). | P2 |
| `apps/server/src/ws.ts` | P2 only (config fields, stream event, `server.testJiraConnection`). P1 needs no ws change. | P2 |
| `apps/server/src/mcp/McpHttpServer.ts` | P4 only. | P4 |
| `packages/shared/src/t3McpToolPresentation.ts` | P4 only. | P4 |
| `packages/provider-core/src/server/runtimeInstructions.ts`, `ProviderAdapter.ts`, all adapters in §6.11, `ProviderSessionManager.ts` | P4 only. | P4 |
| `packages/client-runtime/src/state/models.ts`, `orchestrationV2Projection.ts`, `operations/commands.ts`, `state/threadCommands.ts` | P1 only. | P1 |
| `packages/client-runtime/src/rpc/session.ts`, `state/serverConfigProjection.ts`, `state/server.ts` | P2 only. | P2 |
| `packages/client-runtime/package.json` | P5 (subpath `./state/thread-priority`). P6 (subpath `./state/thread-ticket-presentation`). | P5 → P6 |
| `packages/client-runtime/src/state/threadInbox.ts` | P5 only (exports `InboxThreadInput`). | P5 |
| `apps/web/src/components/Sidebar.tsx` | P5: priority sort at the sorted-active site and in `resolveDraggedOrders`, reorder disabled under "priority". P6: ticket actions in `handleThreadContextMenu` (the indicator itself goes in `sidebar/SidebarThreadRow.tsx`, P6 only). `Sidebar.logic.ts` is untouched. | P5 → P6 |
| `apps/web/src/components/CommandPalette.tsx` | P5: `action:inbox-order`. P6: priority, link, unlink actions next to "Link pull request to thread" (~L1421). | P5 → P6 |
| `apps/web/src/components/settings/settingsSearch.ts` | P2: `jira-connection`. P5: `inbox-order`. P6: `jira tickets` term on `thread-details-items`. | P2 → P5 → P6 |
| `apps/web/src/components/settings/SettingsPanels.tsx` | P5 only (Inbox order row, restore defaults). P2 mounts Jira in `SourceControlSettings.tsx` instead. | P5 |
| `apps/web/src/components/threadActionMenu.logic.ts`, `apps/web/src/hooks/useThreadActionMenu.ts` | P6 only. | P6 |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx` | P6 only (row glyph, Priority submenu, "Jira tickets…"). P5 needs no change: Move up/down already hide when `reorderSupported !== true`. | P6 |
| `apps/mobile/src/features/home/useThreadListActions.ts` | Nobody (P6 uses a row-level `useThreadTicketActions.ts`). | — |
| `apps/mobile/src/features/threads/threadListV2.ts`, `ThreadArrangementSheet.tsx`, `useThreadListV2.ts`, `use-thread-list-v2-shelf-preferences.ts`, `ThreadNavigationSidebar.tsx`, `apps/mobile/src/features/home/HomeScreen.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts`, `apps/mobile/src/features/settings/ThreadSettingsSections.tsx` | P5 only. | P5 |
| `docs/user/thread-sidebar.md`, `docs/user/jira-tickets.md`, `docs/README.md` | P6 only (P2 and P5 write no user docs); the web PR writes them, the mobile PR adds the mobile paragraphs. | P6 web → P6 mobile |

---

## 10. Contract-level open questions

Each is decided here provisionally so writers can proceed; the coherence pass or the user may
overturn it.

**Q1. Thread mutations go through `orchestration.dispatchCommand`, not new ws RPC methods.**
Context: the run's scope text asks P1 for "ws RPC methods and client-runtime
`createEnvironmentRpcCommand` commands" and the spec says to add protected client commands to
`CLIENT_GUARDED_RPC_SCOPES`. In the code, every thread mutation (pin, tag, PR link/unlink/watch)
is an orchestration command dispatched by `createEnvironmentCommand` over
`orchestration.dispatchCommand`, which `RPC_REQUIRED_SCOPES` already guards with
`AuthOrchestrationOperateScope`; `CLIENT_GUARDED_RPC_SCOPES` holds only ws methods. Options: (a)
reuse dispatchCommand with three commands (no new ws method, no scope entry); (b) add three ws
methods calling `ThreadTicketService`. Recommendation: (a). It is the existing pattern, keeps one
reducer for UI, MCP and reactor, and adds no transport. The only new protected ws method is P2's
`server.testJiraConnection`, which does get a `CLIENT_GUARDED_RPC_SCOPES` entry and permission
tests. P1's permission coverage is the decode test that clients cannot send
`thread.ticket-link.sync`.

**Q2. Which Jira endpoint fetches tickets.** Context: the spec names `POST /rest/api/3/search/jql`
with `key in (...)`. JQL on unknown or invisible keys may fail the whole query instead of
omitting them, which would turn one deleted ticket into a sync outage. Jira Cloud also has
`POST /rest/api/3/issue/bulkfetch` (`issueIdsOrKeys` ≤ 100, `fields`), which returns `issues` and
per-key `issueErrors`. Options: (a) search/jql; (b) bulkfetch; (c) search/jql with a retry that
drops keys named in the error. Recommendation: P2 verifies both read-only against the user's site
at implementation time and uses (b) if search/jql rejects unknown keys. `fetchTickets` (§6.7)
hides the choice, so no other plan is affected. **Resolved by P2:** bulkfetch, confirmed by P2's
Task 3.0 probe, with (c) as the fallback only if the probe shows bulkfetch unavailable. The spec
still says search/jql; that is a design choice, listed under "Decisions needed".

**Q3. `not_found` and `forbidden` are mostly indistinguishable.** Context: Jira reports an
invisible issue the same as a missing one. Options: keep both literals (spec) or collapse to one.
Recommendation: keep both in the schema, map ambiguous cases to `not_found`, and have P6 show both
as "unreachable". P2 never produces `forbidden`.

**Q4. Unlinking a key that appears in the branch name tombstones it.** Context: the spec
tombstones only `source: "branch"` links. A manually linked key that is also in the branch would
otherwise be re-added by branch detection after the user removed it (a one-way door the
anti-goals forbid). Options: (a) tombstone when the key is in `branchTicketKeys(thread.branch)`;
(b) spec only. Recommendation: (a), pinned in §6.3.

**Q5. `ThreadTicketLink.url` is nullable.** Context: the spec lists `url` as a plain field, but
the orchestrator reducer does no I/O and a manual key-only link has no URL until Jira is
configured. Options: (a) `NullOr`, with server callers (P3, P4) filling it from
`JiraService.browseUrl` and clients deriving it with `jiraBrowseUrl(settings.jira.siteUrl, key)`;
(b) require it and refuse key-only links without Jira. Recommendation: (a).

**Q6. P1-contract milestone.** Context: the gate says P1 and P2 run in parallel, but P2 needs
`PriorityRef`, the default scale and the capability flag. Recommendation: P1's first commit
(threadTicket.ts + capability field) merges first; P2 starts on top of it. They remain parallel
for everything else.

**Q7. `JiraService` records its own connection status.** Context: the scope says P3 "reports
into" the status. Every Jira request goes through `JiraService`, so it already sees every
outcome. Recommendation: no reporting API; P3 only reads. Removes a cross-plan method.

**Q8. Gating Jira UI and tools when Jira is not connected.** Context: links without Jira never
sync, and tool descriptions are agent prompt text the anti-goals keep away from users without
Jira. Recommendation: the tickets MCP toolkit is hidden and "Link Jira ticket…" is not offered
while `jiraStatus.state === "disconnected"`; the Priority submenu (user priority on the default
scale) stays available whenever `capabilities.threadTickets` is set; existing links and chips
always render (with unlink) so nothing becomes a one-way door after a disconnect.

**Q9. "Priority" inbox order with the Working section off.** Context: `sortInboxThreadsByReturn`
is used only when `sidebarWorkingShelfEnabled` is on; with it off the inbox uses
`sortThreadsForSidebar` and manual `activeOrderKey` order. Options: apply priority in both modes,
or only with the Working section on. Recommendation: apply it in both modes (the setting is named
"Inbox order"), with the §6.12 tie-break in both; P5 owns the decision and records it. P5 decided
yes; the tie-break with the Working section off is a separate open item under "Decisions needed".

**Q10. Spec defects for the coherence agent (factual, not judgment).** *Applied by the coherence
pass:* the `CLIENT_GUARDED_RPC_SCOPES` sentence, the palette placement, the full path of
`ThreadArrangementSheet.tsx`, the settings-secret files (`mapSecretFieldGroups` in
`settingsSecrets.ts`, references resolved in `settingsSecretValue.ts`), and the capability flag
(`ExecutionEnvironmentCapabilities.threadTickets`, not a `ServerConfig` boolean). Original note: The spec says to add the
client commands to `CLIENT_GUARDED_RPC_SCOPES` (see Q1: dispatchCommand is guarded in
`RPC_REQUIRED_SCOPES`); it places the Inbox order palette entry "next to the existing sidebar sort
entries", but `CommandPalette.tsx` has none at `ddec2d528a`. The spec's other line citations
checked out (`orchestrationV2.ts` L475/L2150, `orchestrationV2Projection.ts` L297-299,
`Sidebar.tsx` L396/L682, `threadListV2.ts` L803, `ThreadArrangementSheet.tsx` L209, `settings.ts`
L393/L1359/L2002, `server.ts` L624).

---

## Decisions needed (all resolved — see "Resolved decisions" at the top)

The coherence pass collected every open question and deviation from all plans here, with
duplicates merged. Each item stands alone. Unless an item says otherwise, the plans already
follow its recommendation, so "accept" means no plan changes.

1. **Ticket fetch endpoint: `issue/bulkfetch` instead of the spec's `search/jql`.**
   - Context: the spec (Jira connection; Constraint "one batched Jira search per sweep") names `POST /rest/api/3/search/jql` with `key in (...)`. A JQL query fails as a whole when one key is deleted or invisible, so one dead ticket would stop sync for every thread. `POST /rest/api/3/issue/bulkfetch` takes up to 100 keys, returns the readable issues, and lists the rest separately. It is still one batched read per sweep.
   - Options: (a) search/jql as specified; (b) bulkfetch; (c) search/jql that retries without the keys a 400 names.
   - Recommendation: (b), confirmed by P2's read-only probe (Task 3.0), with (c) as the fallback.
   - Affects: P2 (implements it), P7 invariant 1 (allowed endpoint list). `fetchTickets` hides the choice from P3.
2. **Links to another Jira site: refuse in both clients, or in neither.**
   - Context: a pasted URL from a Jira site other than the connected one carries a key that T3 then reads from the connected site. The chip shows "unreachable", or, if the connected site has an issue with the same key, a different ticket. P4's `link_ticket` refuses such a URL (`TicketSiteMismatchError`). When the project list is readable, it also refuses a key whose project is not on the site (`TicketProjectUnknownError`). P6's "Link Jira ticket…" dialog accepts any URL. After this pass, both store the canonical `jiraBrowseUrl(siteUrl, key)`.
   - Options: (a) the P6 dialog also refuses a URL whose origin differs from `settings.jira.siteUrl` (one rule everywhere); (b) drop P4's two extra checks (thinnest handlers, the spec asks for neither); (c) keep as planned (agent and UI disagree).
   - Recommendation: (a). It is one inline error in the dialog. Skip the project check in the UI, because the user can see the result.
   - Affects: P6 Task 4 and open question 9, P4 open question 7.
3. **Does every ticketless thread get a provisional agent priority?**
   - Context: the spec says that when a thread has no linked ticket, the agent sets a provisional priority "reflecting the request's urgency". Read literally, every ticketless thread in a Jira-connected environment gets one, including plain questions. Under the "Priority" inbox order, any agent value outranks "no priority", so the unprioritized bucket would empty out.
   - Options: (a) always set one; (b) set one only when the request signals urgency or importance.
   - Recommendation: (b).
   - Affects: P4. Under (b), the instruction text changes and the `tickets-plain-question-control` eval case gains `notCalls: set_thread_priority`. P7 C3 is unaffected.
4. **Delegated child threads see the ticket tools and instructions.**
   - Context: children share the instruction block, and the tools default to the child's own thread. A child's links and priority land on a thread the user rarely sees, while the parent owns the work.
   - Options: (a) no special casing; (b) hide `set_thread_priority` from subagents with an `EnabledWhen` that combines `ticketTracker` and `hiddenFromSubagents`, plus one sentence in the text.
   - Recommendation: (a) now. Revisit if P7 shows child threads reaching the inbox; (b) is cheap to add later.
   - Affects: P4.
5. **P4's evals need a paid model key.**
   - Context: `evals/README.md` requires before-and-after eval runs for model-facing text. They use `ANTHROPIC_API_KEY` from the repo root `.env`. If the implementing agent cannot use it, the text ships unproven.
   - Options: (a) stop and ask the user for the key, or for permission to run the evals themselves; (b) hand off with `--dry-run` evidence only.
   - Recommendation: (a). Confirm the key works before P4 starts, so the run does not stall midway.
   - Affects: P4.
6. **Instruction timing, Antigravity and Replay.**
   - Context: contract §6.11 typed `ticketLinking` as a live read. P4 reads it once per session for every adapter except Claude, so the text never runs ahead of the session's fixed MCP tool list. Connecting Jira mid-session therefore takes effect on the next session. P4 also leaves `AntigravityAdapterV2.ts`'s static session append unchanged, because the ACP adapter appends the per-turn instructions on every non-slash turn (verified). `ReplayRuntimeInstructions.ts` stays unchanged as well (its recordings run with Jira off).
   - Recommendation: accept.
   - Affects: P4. The contract has been updated to match.
7. **Auth failures pause ticket reads for up to an hour.**
   - Context: with a revoked token, P3's 2-minute sweep would send about 30 failing Basic-auth requests an hour, which can lock the Atlassian account behind a CAPTCHA. While the status is `auth`, P2's `JiraService` fails `fetchTickets` and `projectKeys` without a request. Only the hourly `/myself` refresh or a settings save retries. If the user fixes the problem on the Jira side without touching T3 settings, recovery can take up to an hour.
   - Options: (a) as planned; (b) also clear the pause when "Test connection" succeeds with the saved settings.
   - Recommendation: (b). It is a small addition in P2 and gives the user an immediate way out.
   - Affects: P2 (`testConnection` currently "never mutates status", contract §6.7).
8. **No "checking" connection state.**
   - Context: a newly configured connection reports `state: "connected"` with `accountName: null` until `/myself` answers. P2's settings section shows "Checking…" for that case. P6 offers the link UI because the state is not `"disconnected"`.
   - Options: keep the contract, or add a `"checking"` state, which changes the contract and P6.
   - Recommendation: keep it.
   - Affects: P2, P6.
9. **Moved Jira issues read as unreachable.**
   - Context: moving an issue to another project changes its key. The linked old key then reads `not_found`.
   - Options: follow moves by issue id (a schema change in P1 and P3), or accept.
   - Recommendation: accept. The chip shows "unreachable" and the user relinks.
   - Affects: P2, P6.
10. **Changing the Jira site URL keeps the saved token.**
    - Context: Atlassian API tokens belong to an account, not a site. An omitted or redacted token in a patch keeps the saved one, the same as the existing text-generator key handling. Only `AuthSettingsWriteScope` holders can change it.
    - Recommendation: accept.
    - Affects: P2.
11. **Mobile gets no Jira connection UI.**
    - Context: connecting Jira is a per-environment admin task done from web or desktop. Mobile still shows ticket data, priorities and link actions.
    - Recommendation: accept.
    - Affects: P2, P6.
12. **No branch-ticket backfill when Jira is connected later.**
    - Context: the spec runs branch detection when a branch is set or changes, and only while Jira is configured. Threads whose branch was set before the connection never get their branch link.
    - Options: (a) no backfill; (b) on (re)connect, detect over every non-archived thread's current branch. Tombstones are respected, but it links many old threads at once.
    - Recommendation: (a), unless you expect connecting Jira to annotate existing threads.
    - Affects: P3, P7.
13. **Sync scope details.**
    - Context: P3 does not use `BackgroundPolicy`, unlike the PR reactor. Its reason: one batched request covers all tickets, and inbox priority must stay fresh for threads no client has open. The immediate fetch after linking also covers settled threads, so their chips get a title. The periodic sweep stays unsettled-only, per the spec.
    - Recommendation: accept.
    - Affects: P3.
14. **Stored ticket links: drop the whole array, or only the unreadable element?**
    - Context: following `StoredThreadTags`, P1 decodes `ticketLinks` leniently: if any element fails, the thread reads as having no links. A thread written by a newer build (for example with a new `source` literal) then loses every link, including `branch-dismissed` tombstones, the next time this build writes it. Branch detection could then re-add a ticket the user removed. This only happens on a downgrade or a mixed-version write.
    - Options: (a) whole-array fallback, as contracted; (b) per-element leniency (drop only the unreadable elements).
    - Recommendation: (a) for consistency with tags, unless you run mixed versions against one database. (b) changes only that schema and one test row.
    - Affects: P1.
15. **Other P1 implementation choices.**
    - `ThreadTicketService` returns `storedEvents.length > 0` instead of predicting the outcome.
    - The reducer semantics live in a new `threadTicketReducer.ts`.
    - `AgentAwarenessRelay.ts` gains the two events.
    - A small stale-guard gap remains after an `unreachable` result. It needs two overlapping reads, and P3 never overlaps reads.
    - Forks start without links or priority.
    - `snapshot.syncedAt` means "last read with changed data". P6 never shows it as freshness.
    - Recommendation: accept all.
    - Affects: P1 (P3 and P6 consume the choices).
16. **Contract decisions that go beyond the spec.**
    - Q4: unlinking a manually linked key that also appears in the branch name tombstones it, so branch detection cannot bring it back.
    - Q5: `ThreadTicketLink.url` is nullable, for key-only links made before Jira is configured.
    - Q8: the Priority submenu works on the default scale whenever the server has `threadTickets`, even without Jira. Linking and the ticket tools need a configured Jira, and existing links always show with an unlink control.
    - Recommendation: accept.
    - Affects: P1, P4, P6.
17. **Tie-break inside a priority level with the Working section off.**
    - Context: the spec breaks ties by "the Recently returned order", and Goal 4 says unranked threads go newest-returned first. With the Working section on, that order is `sortInboxThreadsByReturn`. With it off, today's inbox uses `sortThreadsForSidebar` plus hand-set manual order, and no returns are observed.
    - Options: (a) one comparator everywhere: `sortInboxThreadsByReturn` over the thread's own timestamps; (b) with the Working section off, keep the manual order inside a level.
    - Recommendation: (a). The stored manual order still comes back intact when switching back to "Recently returned".
    - Affects: P5, P7 E4.
18. **Where the Inbox order lives, and other P5 choices.**
    - Web and desktop store the setting in `ClientSettings`. Mobile stores it as a mobile preference, the same way it stores the Working section, so the two choices are independent per app.
    - Mobile Settings gets a row.
    - An empty Jira scale falls back to the default five.
    - The folder ("boring") sidebar keeps its own order.
    - The setting is shown without a capability gate.
    - Recommendation: accept all. Wiring `ClientSettings` into mobile is a separate, larger change.
    - Affects: P5.
19. **P6 UI choices beyond the spec.**
    - Ticket chips live in the thread details card, not the width-constrained chat header. The header menu still carries Priority, Link and Unlink. The spec says "header / details".
    - A muted "last known data" notice appears while `jiraStatus` has an error.
    - A neutral "not on this scale" indicator appears for a stored priority the current scale cannot resolve.
    - The priority glyph is hidden on settled rows.
    - A server without `jiraStatus` counts as disconnected.
    - Recommendation: accept all.
    - Affects: P6.
20. **Mobile verification on a Linux host.**
    - Context: there is no iOS simulator on Linux, and an Android emulator or device may not be present. P6's mobile real-client pass and P7 I2 need one.
    - Options: (a) use an Android device or emulator if present; (b) you name a device host; (c) report the mobile checks as not run.
    - Recommendation: (a), falling back to asking you before choosing (c).
    - Affects: P6 (mobile PR), P7.
21. **P7 needs you at its start.**
    - Context: the end-to-end run needs your Jira site URL, email and API token (through `request_secret`), plus a few named tickets: one Done, and one key that does not exist. The live-sync checks need priority, rank and status changes made in Jira, and T3 and agents must never write to Jira. The Atlassian connector in this environment is not authorized for non-interactive use, so independent ground truth comes from your report or raw read-only REST calls.
    - Recommendation: ask for the credentials and tickets once, before P7 starts. You make the Jira edits when prompted, batched into one request.
    - Affects: P7.
22. **Deferred entry points.**
    - Context: AGENTS.md lists keybindings and multi-select as usual entry points. P6 adds the Priority, Link and Unlink actions to the context menu, the header menu, the command palette and mobile, but not:
      - a keybinding (it needs a new contract command id);
      - a bulk "Set priority" on sidebar multi-select.
    - Recommendation: defer both.
    - Affects: P6.
