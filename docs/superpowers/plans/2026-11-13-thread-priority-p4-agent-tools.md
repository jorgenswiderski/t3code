# Thread tickets and priority: P4 agent tools and instructions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents running in a Jira-connected environment link tickets on their own, set a provisional priority, and can unlink or (only on the user's explicit request) set the user's priority, through three MCP tools and one instruction block that exist only when Jira is configured.

**Architecture:** A new `tickets` MCP toolkit modeled on `toolkits/pullRequests/`, hidden from `tools/list` unless a per-request `ticketTracker` flag (computed from `JiraService.isConfigured` in the MCP auth middleware, the same way `linkedEnvironments` is) is true. Handlers parse and validate input, then call P1's `ThreadTicketService`. A `<ticket_linking>` block rides `buildRuntimeInstructions({ ticketLinking: true })`, fed by a new `ticketLinking?: Effect<boolean>` on the adapter `openSession` input that `ProviderSessionManager` fills from `JiraService.isConfigured`. The eval harness learns a Jira-configured world so the model sees exactly what T3 shows it.

**Tech Stack:** Effect (`effect/ai` Tool/Toolkit, `McpSchema.EnabledWhen`), Effect Schema, `@effect/vitest`, the `evals/mcp-tool-use` harness (paid model calls).

**Spec:** `docs/superpowers/specs/2026-11-13-thread-priority-design.md`, section "Agents (MCP + instructions)". Contract: `docs/superpowers/plans/2026-11-13-thread-priority-index.md` (§6.1, §6.4, §6.7, §6.11, D5, Q8). This plan runs after P1 and P2 have merged into `feat/thread-priority`; it codes against their interfaces exactly as the contract pins them.

## Global Constraints

- Tool names are pinned (P7 and the evals use them): `link_ticket`, `unlink_ticket`, `set_thread_priority`.
- Users without Jira pay nothing: no tool listed, no instruction text, no sync work (spec "Anti-goals", D5). The agent context budget (`apps/server/src/provider/agentContextBudget.json`) measures the registered tool list, so it grows; the instruction block does not enter the measured appends (flag absent).
- Default `set_thread_priority` writes `source: "agent"`; `userRequested: true` writes `source: "user"` and is only for an explicit user request. There is no server-side guard (spec, builder-check call): instructions and evals are the guard.
- T3 never writes to Jira. No tool here talks to Jira except through `JiraService` reads (`priorityScale`, `browseUrl`, `projectKeys`, `isConfigured`).
- Everything anyone can link is unlinkable and everything set is clearable (`null`), including `userRequested: true` with `null`.
- Model-facing text changes go through `evals/` with cases that fail before the text (`evals/README.md`). Cases carry no user data (`acme/app`, `ACME-123`, `acme.atlassian.net`).
- Contract names used as given: `parseTicketReference`, `findPriorityInScale`, `PriorityRef`, `ThreadTicketKey` (§6.1), `ThreadTicketService.linkTicket/unlinkTicket/setThreadPriority` (§6.4), `JiraService.isConfigured/priorityScale/browseUrl/projectKeys` (§6.7).
- Follow AGENTS.md "Taste": handlers are thin, `Effect.fn("TicketsToolkit.<op>")` spans, inferred types, no restating comments.

## Review Focus

Failure modes the spec implies that no plain happy-path test would hit, each pinned in the owning task:

1. An agent pastes a Jira URL from a different site. The key alone would then sync the wrong ticket from the configured site. Expect a refusal naming the configured site (Task 2).
2. An agent links a string that only looks like a key (`UTF-8`, `ISO-8601`). Expect a refusal when the project is not on the site, and a link when `projectKeys` itself fails (outage must not block linking) (Task 2).
3. The agent passes a priority name that is not on the site's scale. Expect a failure that lists the valid names, so one retry succeeds (Task 2).
4. Jira is disconnected after the tool list was fetched, or the scope flag is stale. Expect a clear "Jira is not connected" failure, never a link to nowhere (Task 2).
5. Jira is connected after a session opened. Expect no instruction text ahead of the tools in that session (Task 3).

## Implementation Location
- **Branch:** feat/thread-priority-p4
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p4
- **Base branch:** feat/thread-priority

Create it with the `git-tools:worktree` skill after P1 and P2 have merged into `feat/thread-priority`. If `.t3/setup-running` names a live PID, wait; if no `.t3/setup-*` marker exists, run `vp i` once. Do not start dev servers (AGENTS.md: subagents do not).

## Decisions made here

| Topic | Decision | Why |
| --- | --- | --- |
| Hiding the toolkit when Jira is off | New optional `ticketTracker?: boolean` on `McpInvocationScope`, set per request by the auth middleware from `JiraService.isConfigured` (looked up with `Effect.serviceOption`, absent means false). New `McpInvocationContext.visibleWhileTicketsOn` for `McpSchema.EnabledWhen`: true only when `scope.ticketTracker === true`. Handlers re-check `JiraService.isConfigured`. | Same machinery as `linkedEnvironments`/`hiddenWhileLinksOff`, which the eval harness already models. A new `McpCapability` would be frozen into issued credentials and force credential rotation on connect/disconnect. Absent means hidden so the in-process server and tests that omit it never list tickets tools. |
| Tool parameters | `link_ticket { ticket: string, threadId? }`, `unlink_ticket { ticket: string, threadId? }` (`ticket` is a key or a browse URL, parsed by `parseTicketReference`); `set_thread_priority { priority: string \| null, userRequested?: boolean, threadId? }`. No `environmentId` (not a linked-environment tool). | The spec's "key or url" is one string. Each environment owns its Jira connection (spec "Remote ready"), so forwarding a ticket call to a linked environment has no use case. Fewer parameters is fewer schema bytes in the budget. |
| URL stored on a link | Always `JiraService.browseUrl(key)`, never the agent's URL. A URL whose origin differs from the configured site is refused. | Review Focus 1. |
| Scale exposure | The tool description names the default-five order and says the site's own scale applies; every `set_thread_priority` result carries `scale` (names, highest first); an unknown priority fails with the valid names. | Tool descriptions are static per server, the scale is per environment. |
| When the instruction flag is read | Claude reads `ticketLinking` per query (a query is a fresh MCP connection, so tools and text are fetched together). Every other adapter reads it once in `openSession` and reuses it for the session. | Their MCP tool list is fixed for the session; text must never be ahead of the tools (Review Focus 5). A (dis)connect takes effect on the next session. |
| Antigravity | Leave `sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS` as is. The ACP adapter's per-turn runtime text already goes out on every non-slash turn, so the ticket block rides it with `pullRequestLinking: false`. | The session append is static and cannot follow Jira state; the per-turn text can. |
| Delegated children | No special casing: all three tools and the block are visible to children, and default to the child's own thread. | See open question 2. |

## File Structure

- Create `apps/server/src/mcp/toolkits/tickets/tools.ts` (tool declarations, result schemas, errors), `handlers.ts` (handlers), `handlers.test.ts`.
- Modify `apps/server/src/mcp/McpInvocationContext.ts` (scope flag, predicate), `McpInvocationContext.test.ts` only if it enumerates fields, `McpHttpServer.ts` (middleware flag, `layerTicketsToolkit`, `layerTools`), `McpHttpServer.test.ts` (hide/show test), `apps/server/src/server.ts` (only if typecheck shows the MCP layer cannot see `JiraService` / `ThreadTicketService`; see Task 2).
- Modify `apps/server/src/provider/AgentContextBudget.test.ts` (mock the two services) and `agentContextBudget.json` (new `mcpToolListJsonBytes`).
- Modify `packages/shared/src/t3McpToolPresentation.ts` (+ `.test.ts`), `packages/client-runtime/src/t3ToolSummary.ts` (+ `.test.ts`).
- Modify `packages/provider-core/src/server/runtimeInstructions.ts` (+ `.test.ts`), `ProviderAdapter.ts`.
- Modify every instruction site listed in Task 3, `ProviderSessionManager.ts` (+ test).
- Modify `evals/mcp-tool-use/run.ts` (+ `run.test.ts`), create `evals/mcp-tool-use/cases/tickets.ndjson`, update `evals/mcp-tool-use/README.md` (cases table row).

---

### Task 1: Per-request `ticketTracker` flag and visibility predicate

**Files:**
- Modify: `apps/server/src/mcp/McpInvocationContext.ts`, `apps/server/src/mcp/McpHttpServer.ts` (`makeMcpAuthMiddleware`, ~L195-240)
- Test: `apps/server/src/mcp/McpHttpServer.test.ts` (extend the "hides tools for links" pattern, ~L1184)

**Interfaces:**
- Produces: `McpInvocationScope.ticketTracker?: boolean`; `McpInvocationContext.visibleWhileTicketsOn: () => boolean` (reads the fiber's scope exactly like `hiddenWhileLinksOff`, returns `scope?.ticketTracker === true`). Task 2 and the eval harness (`enabledWhen(visibleWhileTicketsOn)`) consume the predicate.
- Consumes: `JiraService.JiraService` (`isConfigured: Effect<boolean>`, §6.7) via `Effect.serviceOption`.

- [ ] **Step 1: Write the failing test** `lists ticket tools only while Jira is configured`, copying the structure of the links test: a one-tool toolkit annotated `McpSchema.EnabledWhen, visibleWhileTicketsOn`, `P2`'s `makeTestJiraService` controller flipping configured. Assertions: `tools/list` omits the tool while unconfigured, includes it after the controller sets configured, omits it again after unconfigure (no cache across requests); and with no `JiraService` in the layer it is omitted.
- [ ] **Step 2: Run** `vp test run apps/server/src/mcp/McpHttpServer.test.ts -t "ticket tools"`. Expected: FAIL (predicate does not exist).
- [ ] **Step 3: Implement** the scope field and predicate in `McpInvocationContext.ts`, and in `makeMcpAuthMiddleware` read `Effect.serviceOption(JiraService.JiraService)` once, compute `ticketTracker` per request (`isConfigured`, falling back to false when absent or failing), and spread it into the admitted scope beside `linkedEnvironments`.
- [ ] **Step 4: Run** the same test plus `vp test run apps/server/src/mcp/McpInvocationContext.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): MCP scope knows whether Jira is configured`.

### Task 2: Tickets toolkit, handlers, registration, presentation, budget

**Files:**
- Create: `apps/server/src/mcp/toolkits/tickets/tools.ts`, `handlers.ts`, `handlers.test.ts`
- Modify: `McpHttpServer.ts` (add `layerTicketsToolkit = toolkitRegistration(TicketsToolkit, TicketsHandlers.layer)` beside `layerPullRequestsToolkit` ~L1201, add to `layerTools` ~L1260), `apps/server/src/server.ts` (expected: no change. P2 provides `JiraService.layer` in the `Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer)` group and P1 provides `ThreadTicketService.layer` as the first `provideMerge` of `layerRuntimeCoreDependenciesBase`, and `McpHttpServer.layer` (~L805) is built over those outputs. Add a provide only if typecheck says otherwise, and then pass the same `JiraService.layer` reference so layer memoization keeps one stateful instance per server; never construct a second one. Typecheck proves the tool dependencies, Task 1's `serviceOption` does not, so also cover it in the Task 3 wiring test), `packages/shared/src/t3McpToolPresentation.ts`, `packages/client-runtime/src/t3ToolSummary.ts`, `AgentContextBudget.test.ts`, `agentContextBudget.json`
- Test: `handlers.test.ts`, `packages/shared/src/t3McpToolPresentation.test.ts`, `packages/client-runtime/src/t3ToolSummary.test.ts`

**Interfaces:**
- Consumes: `ThreadTicketService` (`linkTicket({threadId,key,url,source:"agent"}) -> {linked}`, `unlinkTicket({threadId,key}) -> {unlinked}`, `setThreadPriority({threadId,source,priority}) -> {changed}`, errors `ThreadTicketError`), `JiraService`, `parseTicketReference`, `findPriorityInScale`, `jiraBrowseUrl`, `Orchestrator.OrchestratorV2.getThreadShell` (existing-link and thread-not-found checks, as `requireThread` in `toolkits/pullRequests/handlers.ts`), `McpToolAccess.writesThreads`.
- Produces: `TicketsToolkit` with tools and exact schemas:
  - `link_ticket`: params `{ ticket: TrimmedNonEmptyString, threadId?: ThreadId }`; success `{ key: string, url: string, alreadyLinked: boolean }`.
  - `unlink_ticket`: params `{ ticket: TrimmedNonEmptyString, threadId?: ThreadId }`; success `{ key: string, wasLinked: boolean }`.
  - `set_thread_priority`: params `{ priority: Schema.NullOr(TrimmedNonEmptyString), userRequested?: boolean, threadId?: ThreadId }`; success `{ source: "agent" | "user", priority: PriorityRef | null, changed: boolean, scale: string[] }`.
  - All three annotated `McpSchema.EnabledWhen, visibleWhileTicketsOn`; `Tool.Readonly false`, `Idempotent true`, `OpenWorld false`, `Destructive` true only for `unlink_ticket`.
  - Tagged errors (messages written for the agent, in the style of `PullRequest*Error`): `TicketTrackerNotConfiguredError`, `TicketReferenceInvalidError`, `TicketSiteMismatchError { siteUrl }`, `TicketProjectUnknownError { project }`, `TicketPriorityUnknownError { priority, scale: string[] }`, `TicketThreadRequiredError`, `TicketLinkFailedError / TicketUnlinkFailedError / TicketPriorityFailedError { cause }`; `TicketToolError` union also includes `OrchestratorMcpFailure`.
- Tool description text: first-draft, plain statements of what each tool does and its parameters. The real text is Task 5; the descriptions here are the "before" text for the eval baseline.

Handler behavior (the decisions; bodies are the implementer's):
- Every handler first fails `TicketTrackerNotConfiguredError` when `JiraService.isConfigured` is false. Thread = `threadId` or the caller's thread, else `TicketThreadRequiredError`; deleted/unknown thread uses `threadNotFound` from `../../threadAccess.ts`.
- `link_ticket`: `parseTicketReference(ticket)` null gives `TicketReferenceInvalidError`; a parsed `url` whose origin differs from `JiraService.browseUrl(key)`'s origin gives `TicketSiteMismatchError`; if `projectKeys` succeeds and lacks the key's project prefix give `TicketProjectUnknownError`, if `projectKeys` fails (any `JiraError`) continue. Call `linkTicket` with `url = browseUrl(key)`, `source: "agent"`. `alreadyLinked = !linked`.
- `unlink_ticket`: same parse and site checks, no project check; `wasLinked = unlinked`.
- `set_thread_priority`: resolve a non-null `priority` with `findPriorityInScale(scale, priority)` against `JiraService.priorityScale`; no match gives `TicketPriorityUnknownError` with the scale names. `source = userRequested === true ? "user" : "agent"`. `null` clears that source. Result echoes the resolved `PriorityRef` and `scale` names.
- Dispatch failures map like `dispatchFailure` in the PR handlers (interrupt-only causes stay interrupts).

- [ ] **Step 1: Write the failing handler tests** (harness: copy `makeHarness`/`call` from `pullRequests/handlers.test.ts`, with `makeTestJiraService` and P1's `makeTicketLink` fixtures; a recording fake `ThreadTicketService`). Table of cases, input then expected:

| Case | Input | Expected |
| --- | --- | --- |
| link by key | `ticket: "acme-123"` | `linkTicket({threadId: caller, key: "ACME-123", url: "https://acme.atlassian.net/browse/ACME-123", source: "agent"})`; result `{key, url, alreadyLinked: false}` |
| link by URL, same site, with query | `https://acme.atlassian.net/jira/software/projects/ACME/boards/1?selectedIssue=ACME-9` | key `ACME-9`, stored url is the canonical browse URL |
| already linked | service returns `{linked: false}` | `alreadyLinked: true`, no error |
| other site URL | `https://other.atlassian.net/browse/ACME-1` | `TicketSiteMismatchError`, no dispatch |
| not a ticket | `"ISO-8601"` with project set lacking `ISO` | `TicketProjectUnknownError`, no dispatch |
| project list outage | `projectKeys` fails `JiraUnavailableError` | link proceeds |
| garbage | `"fix the bug"` | `TicketReferenceInvalidError` |
| explicit thread | `threadId: other` | dispatch targets `other` (and `writesThreads` limits apply) |
| not configured | `isConfigured` false | `TicketTrackerNotConfiguredError`, no dispatch |
| unlink | `ticket: "ACME-123"`, service `{unlinked: true}` | `{key, wasLinked: true}` |
| priority default | `priority: "high"` | `setThreadPriority(source "agent", {id,name} of "High")`; result source agent, `scale` names in site order |
| priority user-requested | `priority: "Low", userRequested: true` | source `"user"` |
| priority by id, custom scale | scale `[Blocker, Critical, Major]`, `priority: "10002"`-style id | resolves by id |
| priority unknown | `"urgent"` | `TicketPriorityUnknownError` listing every scale name, no dispatch |
| clear | `priority: null`; and `null` with `userRequested: true` | clears `agent`; clears `user` |
| unchanged | service `{changed: false}` | `changed: false`, no error |

- [ ] **Step 2: Run** `vp test run apps/server/src/mcp/toolkits/tickets/handlers.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `tools.ts` and `handlers.ts` to the interface above, modeled file-for-file on `toolkits/pullRequests/tools.ts` and `handlers.ts`.
- [ ] **Step 4: Run** the handler tests. Expected: PASS.
- [ ] **Step 5: Presentation.** Add `link_ticket`, `unlink_ticket`, `set_thread_priority` to `T3_MCP_TOOLS` (labels like `["Link", "Linking", "Linked", "a Jira ticket"]`, `["Unlink", ..., "a Jira ticket"]`, `["Set", "Setting", "Set", "thread priority"]`, icon `t3-code`) with new `T3McpToolSummaryAction` members `link-ticket`, `unlink-ticket`, `set-priority`, and matching `case`s in `summarizeT3ToolCalls` (`t3ToolSummary.ts`, beside `link-pr`). Extend both existing test files with one row per tool. Run `vp test run packages/shared/src/t3McpToolPresentation.test.ts packages/client-runtime/src/t3ToolSummary.test.ts`. Expected: PASS.
- [ ] **Step 6: Registration and budget.** Add the layer to `McpHttpServer.ts` (and `server.ts` only per the note above); add `Layer.mock(JiraService)({})` and `Layer.mock(ThreadTicketService)({})` to `toolHandlerServices` in `AgentContextBudget.test.ts`; run it, copy the measured `mcpToolListJsonBytes` into `agentContextBudget.json` (the other two values must not change: if `claudeSystemAppendBytes` or `codexAdditionalContextBytes` moved, the instruction block leaked into the default path, fix that instead). Run `vp run t3#typecheck` and `vp test run apps/server/src/provider/AgentContextBudget.test.ts apps/server/src/mcp`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(server): agents can link tickets and set thread priority`.

### Task 3: `ticketLinking` plumbing to every instruction site

**Files:**
- Modify: `packages/provider-core/src/server/runtimeInstructions.ts`, `packages/provider-core/src/server/ProviderAdapter.ts`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts` (~L371 and the `openSession` call ~L2476), and the sites below
- Test: `runtimeInstructions.test.ts`, `ProviderSessionManager.test.ts`, `apps/server/src/provider/CodexDeveloperInstructions.test.ts`

**Interfaces:**
- Produces: `export const TICKET_LINKING_INSTRUCTIONS` (a `<ticket_linking>...</ticket_linking>` block; in this task the body is an empty placeholder, replaced in Task 5; tests assert the tags only, never wording); `buildRuntimeInstructions(runtime)` gains `readonly ticketLinking?: boolean`: when true, the block follows `runtimeInfo` and the PR block (or follows `runtimeInfo` alone when `pullRequestLinking === false`); `ProviderAdapterV2OpenSessionInput.ticketLinking?: Effect.Effect<boolean>` (doc line: "read live, absent means off").
- Consumes: `JiraService.isConfigured`.

Sites (re-locate by symbol; all at `ddec2d528a`), and how each reads the flag:

| Site | How |
| --- | --- |
| `ProviderSessionManager.ts` | `Effect.serviceOption(JiraService.JiraService)` beside `serverSettings`; `ticketLinkingEnabled = isConfigured.pipe(orElseSucceed false)` or `Effect.succeed(false)` when absent; pass `ticketLinking: ticketLinkingEnabled` in the `adapter.openSession({...})` input |
| `ClaudeAdapterV2.ts` `makeClaudeQueryOptions` | new input `ticketLinking?: boolean` passed to `buildRuntimeInstructions({ harness: "Claude Code", ticketLinking })`; the per-turn call site (~L11176, next to `promptSuggestions`) sets it from `input.ticketLinking`, read per query |
| `CodexAdapterV2.ts` (`buildCodexAdditionalContext` call ~L805) and `provider/CodexDeveloperInstructions.ts` | add `ticketLinking?: boolean` to `CodexRuntimeInfo` (flows into `t3_code_runtime` through the existing spread); the adapter evaluates the flag once in `openSession` |
| `packages/provider-acp/src/server/adapter.ts` (~L8025) | evaluate once at the top of `openSession`; pass `ticketLinking` beside `pullRequestLinking`; unchanged `sessionCarriesPullRequestLinking` logic |
| `AntigravityAdapterV2.ts` | no code change (decision above); covered by the ACP site |
| `packages/provider-cursor/src/server/adapter.ts` (~L2374), `packages/provider-opencode/src/server/adapter.ts` (~L2968) and `.../v2/adapter.ts` (~L3990), `packages/provider-muse/src/server/adapter.ts` (~L2188) | evaluate once in `openSession`, pass into `buildRuntimeInstructions` |
| `testkit/ReplayRuntimeInstructions.ts` and the three `scripts/record-*-replay-fixture.ts` | no change: they run with Jira off and the flag defaults off, so recorded frames are unchanged (see deviations) |

- [ ] **Step 1: Write failing tests.** `runtimeInstructions.test.ts`: default and `ticketLinking: false` output contains no `<ticket_linking>`; `ticketLinking: true` contains it after `<pull_request_linking>`; with `pullRequestLinking: false, ticketLinking: true` it contains the ticket block and no PR block. `CodexDeveloperInstructions.test.ts`: the existing per-entry byte-cap test also runs with `ticketLinking: true` and every entry stays within `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES` (the cap is the acceptance limit for Task 5's wording). `ProviderSessionManager.test.ts`: with a configured `makeTestJiraService`, the fake adapter's received `openSession` input has a `ticketLinking` that evaluates true; unconfigured or no `JiraService` in the layer evaluates false (this pins the `serviceOption` wiring that typecheck cannot).
- [ ] **Step 2: Run** `vp test run packages/provider-core/src/server/runtimeInstructions.test.ts apps/server/src/provider/CodexDeveloperInstructions.test.ts apps/server/src/orchestration-v2/ProviderSessionManager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interface and each site. One focused unit test per adapter is not required (AGENTS.md: no callback-wiring tests); adapters are proven by typecheck plus the real instruction path checked in Task 6.
- [ ] **Step 4: Run** the same tests, then `vp run @t3tools/provider-core#typecheck`, `@t3tools/provider-acp#typecheck`, `@t3tools/provider-cursor#typecheck`, `@t3tools/provider-opencode#typecheck`, `@t3tools/provider-muse#typecheck`, `vp run t3#typecheck`. Expected: PASS, and `agentContextBudget` test still passes unchanged for the two append values.
- [ ] **Step 5: Commit** `feat(server): agents hear about ticket linking only when Jira is connected`.

### Task 4: Eval harness support and the ticket cases (baseline run)

**Files:**
- Modify: `evals/mcp-tool-use/run.ts` (symbols: `McpToolUseCase.setup`, `t3SourceTools`, `hiddenWhileLinksOff`/`visibleT3Tools`, `claudeQueryOptions`/`t3SystemAppend`, `buildBase`, `buildCodexBase`, `baseKey`/`buildFor`, `t3Default`), `evals/mcp-tool-use/run.test.ts`, `evals/mcp-tool-use/README.md`
- Create: `evals/mcp-tool-use/cases/tickets.ndjson`

**Interfaces:**
- Produces: case field `setup.jira?: { scale?: string[], linkedTickets?: { key: string, title: string }[] }` (presence means Jira is configured: tickets tools listed, `ticketLinking: true` passed to `makeClaudeQueryOptions` and to `buildCodexAdditionalContext`, a `ticket` bit added to the `baseKey`). `TicketsToolkit` added to `t3SourceTools`; `visibleT3Tools` hides tools whose `EnabledWhen` is `visibleWhileTicketsOn` unless `options.tickets`. `t3Default` answers the three tools with the real result shapes (links recorded on the sample, `scale` from `setup.jira.scale` or the default five), `world.linkedTickets` seeding `alreadyLinked`/`wasLinked`.
- Never copy tool text or schemas into the harness: tools come from `TicketsToolkit`, the system text from `makeClaudeQueryOptions`/`buildCodexAdditionalContext` (README rule).

Cases (`tickets.ndjson`; one JSON object per line, ids prefixed `tickets-`, `source` = the spec path, `privacy: "commit-safe"`, prompts and files authored Acme data, `setup.jira` set on all but the harness-level off check):

| id | kind | prompt and world | expect |
| --- | --- | --- | --- |
| `tickets-link-key-named-in-prompt` | bad | Prompt names `ACME-123` and a bug to fix; Jira on | `calls: link_ticket {ticket: "~ACME-123"}`; `notCalls: set_thread_priority` (a linked ticket supplies priority, so no provisional value) |
| `tickets-link-key-from-branch` | bad | Prompt does not name a ticket; world branch `fix/acme-412-checkout-retry`, a commit subject carrying `ACME-412` | `calls: link_ticket {ticket: "~ACME-412"}` |
| `tickets-provisional-priority-no-ticket` | bad | No ticket anywhere; prompt describes checkout returning 500 for every customer | `calls: set_thread_priority {priority: "~high"}` (matches High and Highest); `callsMustNot: set_thread_priority {userRequested: true}`; `notCalls: link_ticket` |
| `tickets-urgent-wording-is-not-a-user-request` | bad | No ticket; the user says it is urgent and asks for a fix, never names a priority value | `callsMustNot: set_thread_priority {userRequested: true}` |
| `tickets-explicit-priority-request` | guard | "Set this thread's priority to Low, I'm only exploring"; no ticket | `calls: set_thread_priority {priority: "~low", userRequested: true}` (guards against overcorrecting to never writing the user value) |
| `tickets-custom-scale-names` | guard | `setup.jira.scale` = `[Blocker, Critical, Major, Minor]`; no ticket; production-outage prompt | a `set_thread_priority` call whose final successful value is a name on that scale (grade through the call's result or a retry after the unknown-priority error; no `userRequested: true`) |
| `tickets-unlink-on-request` | guard | `linkedTickets: [ACME-9]`; "ACME-9 is not part of this work, remove it" | `calls: unlink_ticket {ticket: "~ACME-9"}`; `notCalls: link_ticket` |
| `tickets-plain-question-control` | control | No ticket; "Explain how reconnect works in src/session.ts" | `notCalls: link_ticket, unlink_ticket`; `callsMustNot: set_thread_priority {userRequested: true}` (priority use is not constrained here, see open question 1) |

- [ ] **Step 1: Write failing harness tests** in `run.test.ts`: with `setup.jira`, `buildBase` lists the three tools and the system text contains `<ticket_linking>`; without it neither appears (and the Codex base likewise); each default tool result decodes with `Schema.decodeUnknownSync(LinkTicketResult / UnlinkTicketResult / SetThreadPriorityResult)` imported from `tickets/tools.ts` (prevents shape drift); the new case file decodes with `McpToolUseCase`.
- [ ] **Step 2: Run** `vp test run evals/mcp-tool-use/run.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the harness changes and write `tickets.ndjson`. Add a row and a short section to `evals/mcp-tool-use/README.md` (cases, the `setup.jira` field, what "before" means).
- [ ] **Step 4: Run** the harness tests (PASS), `vp run @t3tools/evals#typecheck`, then `cd evals && pnpm mcp-tool-use --cases mcp-tool-use/cases/tickets.ndjson --dry-run` (builds every case, no model calls).
- [ ] **Step 5: Baseline run on the pre-text commit** (tools with Task 2's first-draft descriptions, empty `<ticket_linking>` body). Commit the harness and cases first (`test(evals): ticket linking and priority cases`), then from `evals/`: `pnpm mcp-tool-use --cases mcp-tool-use/cases/tickets.ndjson --samples 3 --model claude-sonnet-5-5 --out runs/tickets-baseline-sonnet` and the same with `claude-opus-5-5` (`runs/` is gitignored). Never print `.env` keys. Expected: the `bad` cases fail on at least one of the two models; the `guard` and `control` cases pass. A `bad` case that passes on both models is not discriminating: fix the case (a harder or more realistic prompt) rather than loosen it, per README. Record per-case pass counts in the handoff.
- [ ] **Step 6: Commit** the case fixes, if any.

### Task 5: The model-facing text (instruction block and tool descriptions)

This is a text deliverable. Acceptance criteria, not wording. **Implementer: Opus 5.5, effort `high`**, because the work is prompt writing judged by eval runs, and a wording slip can pass every unit test. A second agent (fresh context, Opus `medium`) reads the final text cold and checks it against these criteria before the eval run is reported.

**Files:**
- Modify: `packages/provider-core/src/server/runtimeInstructions.ts` (`TICKET_LINKING_INSTRUCTIONS` body), `apps/server/src/mcp/toolkits/tickets/tools.ts` (descriptions and parameter annotations)

**Acceptance criteria for `TICKET_LINKING_INSTRUCTIONS`:**
- Tells the agent to link, with `link_ticket`, any Jira ticket the work is for, as soon as it is known from the prompt, branch name, PR, or commit, and to treat an `alreadyLinked` result as success.
- Tells the agent that when the thread has no linked ticket it sets a provisional priority with `set_thread_priority`, reflecting the request's urgency and importance, and that a ticket's Jira priority takes over once one is linked.
- States plainly that `userRequested` stays unset unless the user asked for that specific priority value in so many words; urgent wording in a request is not that.
- Says to unlink only on the user's request or when a link was clearly wrong, and to say so when linking fails.
- Keeps references to tickets that are only background (mentioned, not worked on) out of linking, in the way the PR block does.
- Invariants: names the three tools exactly; no mention of Jira API details, ranks, sorting or the inbox; the same block serves top-level and delegated threads, so it must not tell a child to do something its parent owns without saying so (see open question 2); written in the same voice and density as `PULL_REQUEST_LINKING_INSTRUCTIONS`.
- Size: the whole `t3_code_runtime` Codex entry stays within `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES` with `ticketLinking: true` (Task 3 test), and the block is no longer than about half the PR block.
- Non-goals: teaching Jira, explaining the priority sources to the agent, prescribing how to pick a priority beyond "reflect urgency".

**Acceptance criteria for the three tool descriptions and parameter annotations:**
- Each says what the tool does in one or two sentences and carries only what the agent cannot infer: `ticket` is a key or a browse URL of the connected site; `threadId` defaults to this thread; `priority` is a name or id from the connected site's scale (default scale when untouched, ordered highest first: Highest, High, Medium, Low, Lowest), an unknown value fails with the valid names, `null` clears; `userRequested` writes the user's own priority and is only for an explicit user request.
- `set_thread_priority`'s description states the default (agent provisional) before the exception (`userRequested`).
- No restating of the instruction block's policy beyond what the tool needs; combined size of the three descriptions stays small enough that `mcpToolListJsonBytes` grows by no more than what Task 2 first measured plus the wording change (re-measure and update `agentContextBudget.json`).

- [ ] **Step 1: Draft** the text to the criteria; update Task 3's tag-only assertions only if the tags changed.
- [ ] **Step 2: Run** `vp test run packages/provider-core/src/server/runtimeInstructions.test.ts apps/server/src/provider/CodexDeveloperInstructions.test.ts apps/server/src/provider/AgentContextBudget.test.ts`; update `agentContextBudget.json` to the measured values. Expected: PASS.
- [ ] **Step 3: Eval run on the new text,** same models and flags as the baseline plus `--baseline runs/tickets-baseline-<model>/results.jsonl`: `pnpm mcp-tool-use --cases mcp-tool-use/cases/tickets.ndjson --samples 3 --model <model> --baseline <baseline results.jsonl> --out runs/tickets-after-<model>`. Required result: every `bad` case that failed at baseline now passes (half or more of samples), every `guard` and `control` case still passes, no regression versus baseline. Also one Codex-path run (`--model gpt-6.1-sol`) if the proxy is available; otherwise say so in the handoff. If a case fails, change the text, not the case, unless the case is wrong (then it must still fail on the baseline commit's text).
- [ ] **Step 4: Run once over the neighboring suites most likely to feel the new tools** (`pull-requests.ndjson`, `threads-vs-tasks.ndjson`) on one model with `--baseline` from a run on the pre-P4 commit, to show the new tools did not shift unrelated behavior (the tools only list when `setup.jira` is set, so this should be a no-op; a diff means the harness leaks tickets text into Jira-off cases).
- [ ] **Step 5: Commit** `feat(agents): ticket linking instructions and tool text`, with the baseline and after pass counts in the body.

### Task 6: Verification and independent review

- [ ] **Step 1:** `vp run check:changed`. Expected: PASS.
- [ ] **Step 2: Independent review** by a fresh-context reviewer (Opus `medium`, read-only; use `/code-review` or `superpowers:requesting-code-review`) over the branch diff against `feat/thread-priority`, told to check: the Review Focus list, that no instruction or tool text exists on the Jira-off path (`claudeSystemAppendBytes` and `codexAdditionalContextBytes` unchanged in the budget file), each adapter site in Task 3's table, the eval cases' discriminating power (baseline numbers), and that the text meets Task 5's criteria. Fix or justify every finding; report them in the handoff.
- [ ] **Step 3: Hand off** with: baseline versus after pass counts per case and model, the budget byte deltas, the list of adapter sites touched, and a note that the PR to `main` needs the `agent-context-increase` label (the tool list grows; the budget test comment says CI rejects growth without it). No PR is opened unless the user asks.

## Testing Strategy

- **Hermetic (this plan's own tests):** toolkit handlers against a fake `ThreadTicketService` and P2's `makeTestJiraService` (table in Task 2); the `tools/list` visibility test over a real HTTP MCP transport (Task 1); instruction builder, Codex byte cap and `ProviderSessionManager` wiring (Task 3); presentation and summary rows; harness build tests (Task 4); the agent context budget test. Never a real Jira.
- **Evals (the validation for model-facing text, per `evals/README.md`):** `tickets.ndjson`, baseline then after, Sonnet 5.5 and Opus 5.5 (plus GPT-6.1 Sol when the proxy is up), 3 samples each, with `--baseline`. A text change is not done until the bad cases flip and the guards and controls hold. Rough cost: eight cases times three samples times two models, a few dollars; the eval calls paid models, so run one case with one sample first (`--case <id> --samples 1`).
- **End-to-end:** not run by this plan. AGENTS.md says subagents do not launch dev servers, and P4's real-path proof (an agent in a real worktree dev server linking a ticket, a provisional priority, the toolkit absent after disconnect) belongs to P7 and the primary agent's integrated pass, which has the Jira credentials via `request_secret`. P7 must check three things specific to P4: the tools appear and disappear with the Jira connection, a real agent links a ticket named in its prompt, and no ticket text reaches a Jira-off environment.
- **Visual:** none; P4 has no rendered UI beyond a work-log label that follows existing patterns.

## Open questions / spec deviations

1. **Does every ticketless thread get a provisional priority?** Context: the spec says "when the thread has no linked ticket, set a provisional priority reflecting the request's urgency", which read literally means every ticketless thread in a Jira-connected environment gets an agent value, including a plain question. Under the Priority inbox order, an agent value outranks "no priority", so a Medium on every thread would lift all agent threads above unprioritized ones (threads with no signal at all). Options: (a) literal: always set one; (b) only when the request carries a signal of urgency or importance, otherwise leave it unset. Recommendation: (b), because it keeps the unprioritized bucket meaningful. The plan's acceptance criteria say "reflecting the request's urgency and importance", which allows both, and the control case does not constrain priority use; the user should pick, and Task 5 and `tickets-plain-question-control` change accordingly (the control would gain `notCalls: set_thread_priority` under (b)).
2. **Delegated children.** Context: the instruction block is shared with children (Claude's append is the same text), and all three tools default to the child's own thread. A child's priority and links land on a thread the user probably never sees in the inbox, while the parent owns the work. Options: (a) no special casing (this plan); (b) hide `set_thread_priority` from subagents with an `EnabledWhen` that combines `ticketTracker` and `hiddenFromSubagents`, and tell children in the text not to set priority. Recommendation: (a) now, revisit after P7 shows whether child threads reach the inbox. (b) is one annotation and one sentence, so switching is cheap.
3. **Missing Anthropic key at implementation time.** Context: Task 4 step 5 and Task 5 step 3 need paid model calls through `ANTHROPIC_API_KEY` in the repo root `.env` (the worktree root has an `.env`; the plan does not read it). If the key or the Codex proxy is not usable by the implementing agent, the baseline and after runs cannot be produced. Options: stop and ask the user for the key or for permission to run the evals themselves; or hand off with only `--dry-run` evidence and say that the text is unproven. Recommendation: stop and ask; shipping model-facing text without the eval run breaks `evals/README.md`.
4. **Deviation from contract §6.11 (instruction sites).** `ReplayRuntimeInstructions.ts` is listed as a site P4 must cover. It builds the expected frames for recorded transcripts that run with Jira off and the flag defaults to off, so the expected text is already identical; the plan changes nothing there. It also leaves `AntigravityAdapterV2.ts` unchanged on purpose (its static session append cannot follow Jira state; the per-turn ACP text carries the block). If a replay test with Jira on is ever added, `materializeReplayTranscriptRuntimeInstructions` needs a `ticketLinking` option.
5. **Deviation from contract §6.11 (read timing).** The contract types `ticketLinking` as a live-read `Effect<boolean>`. This plan keeps that type but evaluates it once per session for every adapter except Claude, so the instruction text is never ahead of an MCP tool list that is fixed for the session. Connecting Jira mid-session therefore takes effect on the next session for those harnesses, which §6.11 already accepts for session-level appends.
6. **Tool parameter naming vs the spec.** The spec writes `link_ticket { key or url }` and `unlink_ticket { key }`; this plan uses one `ticket` string for both because `parseTicketReference` already accepts either form and agents paste URLs for unlink too. Pure naming (left to the builder), no contract impact: the pinned names are the tool names.
7. **Extra validation beyond the spec.** The handlers refuse a URL from another Jira site and, when the project list is readable, a key whose project is not on the site (Review Focus 1 and 2). The spec does not ask for either; both protect against a link that would sync the wrong ticket or never resolve, and both fall back to linking when Jira cannot be asked. Drop them if the maintainers want the thinnest possible handlers.
