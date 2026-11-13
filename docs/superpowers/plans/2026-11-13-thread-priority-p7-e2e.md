# Thread tickets and priority P7: end-to-end validation (acceptance criteria)

> **For agentic workers:** This is a text deliverable, not a script. It states what must be proven, what is out of scope, and what must never happen. Use superpowers:executing-plans to run it; choose the exact commands yourself from `.agents/skills/test-t3-app/SKILL.md`, `.agents/skills/test-t3-mobile/SKILL.md` and AGENTS.md. There is no feature code, no hermetic test and no commit. Steps use checkbox syntax for tracking.

**Goal:** On the integrated `feat/thread-priority` (P1-P6 merged), prove in the real system, with the user's real Jira Cloud site read-only, that linking, priority precedence, sync, the "Priority" inbox order, settings, secrecy of the token and the reverse states all behave as the spec says, and look at the rendered result.

**Spec:** `docs/superpowers/specs/2026-11-13-thread-priority-design.md`. **Contract:** `docs/superpowers/plans/2026-11-13-thread-priority-index.md` (section 1 P7, 4, 5, 6.3, 6.8, 6.12, 6.13, 8).

## Implementation Location

- **Branch:** feat/thread-priority (P7 has no branch of its own; fixes go through `feat/thread-priority-fix-<slug>`, see Failure policy)
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority
- **Base branch:** n/a

## Preconditions (all must hold before starting)

- P1-P6 are merged into `feat/thread-priority` and the integration worktree is clean (`git status` shows no tracked changes). Rebuild state with `vp i` only if no `.t3/setup-done` marker exists and no live `.t3/setup-running` PID (AGENTS.md "Dev servers").
- The user has named a few Jira tickets for the run, covering at least: one open ticket with a Jira priority and a rank, one more open ticket in the same project with a different priority, one ticket in a Done status category, and one key that does not exist or is not visible to the account. If the user named fewer, ask via the orchestrator before starting; do not invent keys on their site.
- The Jira site URL, account email and API token are obtained with `request_secret` (never typed into a prompt, a file in the repo, a commit, a screenshot or a reply). The token should be a read-only-capable account token; T3 only ever issues GET and read-style POST (search) requests.
- The run executes in the integration worktree, so `vp run dev` uses that worktree's gitignored `.t3` as its home.

## Invariants (violating any one fails the run, whatever else passes)

1. **T3 never writes to Jira.** No ticket, comment, transition, rank or priority is ever created or changed by T3. The user alone changes tickets in Jira for the live-sync checks. Evidence: the list of Jira requests the dev server made (server logs or a recording HTTP proxy in front of the site) contains only the read-only calls P2 makes: `GET /rest/api/3/myself`, `/priority/search`, `/field`, `/project/search`, and `POST /rest/api/3/issue/bulkfetch` (or `POST /rest/api/3/search/jql` only if P2 recorded that its probe forced the fallback). Any other method or path fails the run.
2. **Never touch `~/.t3/userdata`.** No server against it, no read-write open, no cleanup. Seeding goes through the worktree's own `.t3` (first `vp run dev` auto-seeds, or `vp run migrate-dev-db` with the dev server stopped). If the seed is missing or empty, create a throwaway project and threads instead.
3. **Kill only PIDs captured at spawn.** No `pkill -f`, no `pgrep | kill`, no PID found by name or path. Stop only the dev server (and any Metro/simulator process) this run started, by the PID recorded when it was spawned, and only after the evidence is saved. Leave it running if a check failed and report PID and URL.
4. **Never set `VITE_HTTP_URL` or `VITE_WS_URL`.** Every `node apps/server/src/bin.ts ...` CLI call passes `--base-dir` pointing at the worktree `.t3`.
5. **The token never leaves the server.** It is not present in any client-visible payload, log excerpt, screenshot or evidence file kept after the run.
6. **No real paid agent turns unless unavoidable.** Agent-side behaviour uses the free `Replay (dev)` provider (`vp run dev` registers it). A real provider is allowed only for a check that depends on real model behaviour, with that provider's cheapest model (Haiku for Claude), one short turn, and the reason recorded in the evidence.
7. **Evidence is scratchpad-only.** Screenshots, captured payloads and notes go in the session scratchpad, not the repo. Nothing is committed or pushed.
8. **One integrated pass, driven by the primary agent.** Subagents do not start dev servers (AGENTS.md "Verifying").

## Acceptance criteria

Each criterion is pass/fail and names the evidence that proves it. "Look at" means open the rendered screenshot with vision and compare it with the stated expectation; DOM or source assertions do not count for visual items. Use the hooks in contract 6.13 (`data-thread-priority`, `data-thread-priority-position`, `data-ticket-key`, `data-ticket-unreachable`, `id="jira-connection"`, palette values `action:inbox-order`, `action:thread-priority`, `action:link-jira-ticket`, `action:unlink-jira-ticket:<KEY>`) to drive and observe.

### A. Capability and no-Jira baseline

- [ ] A1. Before Jira is connected, the server advertises `capabilities.threadTickets === true`, `jiraStatus.state === "disconnected"` and (absent or default) `ticketPriorityScale` equal to the five defaults (Highest..Lowest, ids `default:*`). Evidence: the `subscribeServerConfig` snapshot.
- [ ] A2. Without Jira: the Priority submenu and `action:thread-priority` exist and set a user priority on the default scale; "Link Jira ticket..." and `action:link-jira-ticket` are not offered; no ticket chips; the agent has no ticket tools or `<ticket_linking>` text (Replay run, check the tool list/instructions the session was opened with). This is the "no extra prompt text for users without Jira" check.
- [ ] A3. Existing threads (seeded or created before the feature) open and render normally with no ticket or priority fields (lenient decode, deploy constraint D1). The inbox order default is "Recently returned" and unchanged from `main` behaviour.

### B. Settings: connect, test, disconnect, secrecy (web/desktop)

- [ ] B1. Settings > Source control shows the Jira section (`id="jira-connection"`), reachable from settings search ("Jira", "api token"). Look at the screenshot: fields readable, no overlap or clipping at desktop and narrow widths, light and dark.
- [ ] B2. Test connection with the real credentials, before saving, shows the account name. A wrong token and a malformed or wrong site URL each show a distinct, readable error. Testing does not change saved settings or the connection status.
- [ ] B3. Save and connect: status becomes `connected` with the account name; the priority scale in `ServerConfig` becomes the site's scale in the site's order (compare with the site's own priority list read independently, for example in the Jira admin UI as the user reports it); the scale update arrives without reloading the client (late-update path).
- [ ] B4. Token secrecy, checked at every client-facing surface: the `subscribeServerConfig` snapshot and every later `settingsUpdated`/`ticketTrackerUpdated` frame show `jira.apiToken` as `""` or the redaction marker only, never the real value; the settings form never fills the token back in; the settings JSON a client reads over the API and the browser's local storage contain no token; grep the captured frames and server log excerpt for the token's literal value and for the site's token prefix, with zero hits. The stored token exists only in the worktree's secret store on the server side.
- [ ] B5. Disconnect (patch `jira: null`) clears the stored token (the secret slot is gone), status returns to `disconnected`, the scale returns to the default five, the link UI is withdrawn, the tickets MCP tools (`link_ticket`, `unlink_ticket`, `set_thread_priority`) are no longer listed by the dev server's MCP endpoint for a new session (anti-goal: no agent prompt text without Jira), and existing links and chips remain visible with an unlink control (no one-way door, Q8). Reconnect restores everything and triggers an immediate fetch (see D3).
- [ ] B6. A forced auth failure (revoke or replace the token in the form with a bad one and save, or ask the user to revoke it) shows the sync error in the Jira section and keeps existing snapshots and priorities in the inbox; nothing is cleared (criterion F4).

### C. Linking

- [ ] C1. Manual link by key and by Jira URL (both `.../browse/KEY` and a board URL with `selectedIssue=KEY`) from the thread context menu dialog and from the command palette: a chip with `data-ticket-key` appears, then fills with title, status and URL within seconds (immediate fetch on link, not the 2-minute sweep).
- [ ] C2. A key that does not exist or is not visible shows the unreachable state (`data-ticket-unreachable`) and does not contribute a priority. A case-insensitive typed key (`proj-12`) links as upper case. Linking the same key twice does nothing and shows no duplicate chip.
- [ ] C3. Agent link: with the `Replay (dev)` provider (or, only if the replay scenarios cannot call the tool, one short cheapest-model turn), the agent calls `link_ticket` with a key or URL and `set_thread_priority` without `userRequested`, and the result is a chip with source `agent` and an agent-sourced priority only. Evidence: the tool call/result in the thread and the thread's stored `ticketLinks`/`priority` (read through the API or CLI, not by writing to the DB). If the Replay provider has no scenario that calls these tools, record that, and prove the tool path by calling the MCP tools through the real MCP endpoint of the dev server with the thread's own credentials instead; real model behaviour is covered by the P4 evals, not here.
- [ ] C4. Branch detection: setting or changing a thread's branch to a name containing a key of a project that exists on the site (`feature/PROJ-123-slug`) adds a link with source `branch`; a key whose project is not on the site is not linked; a key already linked manually is not duplicated; changing the branch to one with a new key adds that key too.
- [ ] C5. Thread state does not churn: linking, syncing and setting priority never change the thread's recency. Evidence: the thread's `updatedAt` and its place in "Recently returned" order are the same before and after (a thread does not jump to the top because a ticket synced).

### D. Priority precedence and Done tickets

- [ ] D1. Precedence user > Jira > agent. For one thread, in order: set only an agent priority (indicator shows source `agent`, tooltip "Agent guess"); link an open ticket with a Jira priority (indicator switches to source `jira`, tooltip names the key); set a user priority (switches to source `user`, tooltip "You"). Clearing the user priority falls back to Jira; unlinking the ticket falls back to the agent value. Each step is checked in the DOM (`data-thread-priority`, `data-thread-priority-position`) and by looking at the screenshot (glyph differs by position; tooltip text readable; no remote Jira image loaded).
- [ ] D2. A thread with several linked tickets takes the best (highest) Jira priority among the readable ones; an unreachable ticket among them is ignored for priority.
- [ ] D3. A ticket in Done status still counts: link the Done ticket alone on a thread that has a Jira priority on it; the indicator shows that priority and the chip shows the Done status. If the Done ticket's Jira priority is empty, state so and use another Done ticket or skip with the reason recorded; do not edit the ticket.
- [ ] D4. A Jira priority name not in the scale (or no priority at all) falls through to the next source without error.
- [ ] D5. Priority UI is gated by capability, not by connection: confirmed in A2/B5.

### E. Inbox order "Priority"

Set up at least six active inbox threads: three at distinct priority positions (one user, one Jira, one agent), two at the same position with different Jira ranks (rank order differs from recency order), one with a ranked Jira ticket and one same-position thread with no rank, and two with no priority at all.

- [ ] E1. Settings > General shows the "Inbox order" row (options "Recently returned", "Priority"), found via settings search; command palette `action:inbox-order` switches it. Default is "Recently returned".
- [ ] E2. Under "Priority" with the Working section on, the inbox shows: higher position first; within a position, ranked before unranked and rank ascending (compared by code unit); remaining ties and the unprioritized group in the previous "Recently returned" order; unprioritized threads last. Compare the observed order with an independent computation from the thread data and scale (a short script in the scratchpad, not the repo). Look at the screenshot of the sidebar at a normal and a narrow width.
- [ ] E3. Under "Recently returned" the order is exactly the pre-feature order (flip back and compare to the earlier screenshot).
- [ ] E4. With the Working section off, "Priority" applies as well (contract Q9) and "Recently returned"/manual order is restored when switched back; stored manual order is not lost (flip back and the previous manual order returns).
- [ ] E5. Under "Priority", dragging within the inbox is disabled; dragging a thread to another section (for example Snoozed or Settled) still works; after switching back to "Recently returned", the stored manual order from before is intact.
- [ ] E6. A running thread in the Working section, a snoozed thread and a settled thread are not reordered by priority (spec non-goal).
- [ ] E7. The setting persists across reload, and a thread's priority change re-sorts the inbox without a reload.

### F. Live sync from Jira (the user changes Jira; T3 only reads)

For each step the user (or the user's reported manual action) changes the ticket in Jira, and the agent observes T3 without reloading. All changes must show within about 2 minutes (the sweep period); record the actual delay.

- [ ] F1. Change a linked ticket's Jira priority in Jira: chip and indicator update, the thread's inbox position moves under "Priority", tooltip still names the Jira key.
- [ ] F2. Reorder two same-priority linked tickets by rank in Jira (drag in the backlog/board): the corresponding inbox order within that priority level swaps within about 2 minutes.
- [ ] F3. Move a ticket to Done in Jira and back: the chip status changes; the priority is retained throughout.
- [ ] F4. Outage/auth error: while the token is invalid (B6), or Jira unreachable, existing snapshots and priorities stay; recovering the token clears the error without re-linking.
- [ ] F5. A change that makes no difference to T3 data (for example editing a ticket field T3 does not read) causes no thread event (no re-render churn). Evidence: server event log or projection `updated_at`/event count unchanged for that thread.
- [ ] F6. Reconnecting (B5) refreshes all links immediately, not after the next sweep.

### G. Reverse states

- [ ] G1. Unlink a manual and an agent link: the chip disappears and does not return on its own (including after a sweep and after a reconnect).
- [ ] G2. Unlink a branch-detected link, and unlink a manually linked key that is also in the branch name: the link becomes dismissed (hidden). Then re-set the thread's branch to the same name, switch to another branch and back, and disconnect/reconnect Jira: the key does not reappear. Linking it manually again does reappear it (undismiss).
- [ ] G3. Clear my priority removes only the user value; the agent value or Jira value takes over per D1. Setting the identical priority twice causes no event.
- [ ] G4. Every way in has a visible way out on web and mobile (context menu, palette `action:unlink-jira-ticket:<KEY>`, chip control).

### H. Remote readiness and mixed versions (checked where reachable without extra infrastructure)

- [ ] H1. A second browser origin (for example the tailnet/LAN share via `vp run dev --share` as AGENTS.md describes, started in the background with a tracked PID) sees the same chips, priorities and order, and the token is not visible there either (repeat B4 on that client). Skip only if sharing is unavailable on the machine, and record why.
- [ ] H2. The client tolerates a server without the new fields: against a server snapshot lacking `ticketPriorityScale`, `jiraStatus` and `capabilities.threadTickets`, nothing breaks and no ticket UI shows. Use a client-side check (a stubbed config in a browser session or the existing client-runtime tests' behaviour reproduced in the page); this is the D2/D4 constraint. If it cannot be driven autonomously, record that the hermetic P5/P6 tests are the only proof.

### I. Surfaces (web, desktop, mobile)

- [ ] I1. Web in the Browser panel via `test-t3-app`: A through H as listed, screenshots at desktop width and a narrow viewport, in light and dark, saved to the scratchpad and viewed.
- [ ] I2. Mobile via `test-t3-mobile`: install the dev client with `vp run mobile:install <ios|android>` (a missing client is an install step, not a blocker), start Metro and pair against the same dev server. Verify on a device or simulator: the inbox shows the priority indicator and order under "Priority" (Arrange threads option), the thread actions offer Priority, Link Jira ticket (only when connected) and unlink, a ticket chip with open-in-Jira, and "Move up"/"Move down" are unavailable under "Priority". View the screenshots. If no simulator/device is available on the host, say exactly what is missing, test the web in a mobile-width viewport instead, and mark I2 as not run rather than passed.
- [ ] I3. Desktop (Electron): not run unless a display and the desktop build are already available; the desktop app wraps the web client. State it as skipped with that reason.
- [ ] I4. Walk AGENTS.md "Hit every surface" against what was observed (entry points, clients, providers, agents, contracts, reverse states, connection modes, docs) and state which were exercised and which were not.
- [ ] I5. Provider coverage: the tool and instruction path is exercised for one provider (Replay or the cheapest real model). Other providers' instruction wiring is covered by P4's hermetic tests and is not re-proven here.

### J. Docs and cleanliness

- [ ] J1. `docs/user/jira-tickets.md` and the Inbox order paragraph in `docs/user/thread-sidebar.md` match what was observed (settings path, source precedence, Done tickets counting, the "Priority" setting); mismatches are reported as findings.
- [ ] J2. After the run: only the tracked dev-server PIDs were stopped; `git status` in the integration worktree shows no new tracked or untracked repo files created by this run; `~/.t3/userdata` was never opened (no new `-wal` or mtime change attributable to this run, checked read-only).
- [ ] J3. Everything left in the scratchpad that holds credentials (a copy of settings, a captured frame) is deleted or redacted before handoff.

## Non-goals

- No performance or load testing; no Jira-side scale testing beyond a few tickets; no Jira Server/Data Center, no OAuth (API token only, as in the spec).
- No testing of ticket creation, transitions or comments in Jira (T3 never writes).
- No paid-model evaluation of instruction wording; that is P4's eval run.
- No new hermetic tests and no feature code; P1-P6 own those.
- No multi-site or multi-environment priority comparison beyond confirming each thread uses its own environment's scale (D8) if a second environment already exists.
- No Electron packaging or release build.

## Testing Strategy

- **End-to-end (this whole plan):** the integrated server (`vp run dev` in the integration worktree, seeded worktree `.t3`) talking to the user's real Jira Cloud site, driven through the real web client (`test-t3-app`) and the real mobile client (`test-t3-mobile`), with real MCP tool calls through the dev server. Agent behaviour uses `Replay (dev)` first; one short cheapest-model turn only if C3 cannot be proven otherwise.
- **Hermetic:** none here. P1-P6 own `vp test run` coverage (reducers, projections, fake Jira HTTP, sort comparator, redaction tests). Before starting, run `vp run check:changed` once on the integration branch's diff against `main` is optional; the gate to start is that P1-P6 have each passed their own checks and reviews.
- **Visual:** every UI state named above (settings section, inbox order, row indicators, tooltips, chips, unreachable chip, dialogs, mobile screens) is rendered to a screenshot and viewed, at desktop and narrow widths, light and dark. DOM assertions are used only to drive and to cross-check, never as the visual proof.
- **Skipped, with reasons:** desktop Electron (needs a display, I3); mixed-version server for H2 when it cannot be driven autonomously; mobile only if the host has no simulator or device (then explicitly "not run"). Real Jira changes (F) need the user to act in Jira, because T3 and the agent must never write there; the agent asks the user for each step and waits on the observed result.

## Failure policy

P7 does not edit feature code. For each failure: capture a screenshot and the relevant payload or log (credentials redacted) into the scratchpad as `FAIL-<criterion>.*`; diagnose to the owning plan (P1 data/reducers, P2 Jira/settings, P3 sync/branch detection, P4 tools/instructions, P5 sort/setting, P6 UI/docs); stop and report to the orchestrator with the criterion, evidence paths, diagnosis and owning plan. The fix lands via a branch `feat/thread-priority-fix-<slug>` from the integration branch, is independently reviewed, merges forward like a plan, and P7 re-runs from the first criterion it can affect. Leave the dev server running on a failure and report its PID and URL.

## Review

No independent review of this plan's execution is required (it changes no code). The handoff reports each criterion as passed, failed, skipped or not run, with its evidence path, and calls out anything unreviewed.

## Open questions / spec deviations

**Resolved by the user (2026-11-13), binding:** D1 bulkfetch is on the allowed read-only endpoint list; D12 no backfill (don't expect pre-existing branches to gain links on connect); D17 tie-break check per the single comparator; D20 as P6; D21 ask for credentials and tickets once, up front. Where an item below conflicts, this wins.

1. **Credentials and tickets must come from the user.** Context: the run needs a Jira site URL, email, API token (through `request_secret`) and a few named tickets, including a Done one and a missing one. Options: (a) the orchestrator asks the user before P7 starts; (b) the executor requests the secret itself. Recommendation: (a) at the start of the P7 phase, so a user who is away does not block mid-run, and ask at the same time which ticket to move in Jira for F1-F3.
2. **Live Jira changes need a human.** Context: F requires changing priority, rank and status in Jira, but T3 and agents must never write to Jira, and the Atlassian connector available to this session can write. Options: (a) the user makes the changes when prompted; (b) the agent uses the Atlassian connector to make them. Recommendation: (a), keeping the "T3 never writes" invariant unambiguous and avoiding agent writes to the user's real tickets. The executor should batch the requested Jira edits into one request to the user with the exact ticket and change for each.
3. **Atlassian connector is read-only evidence only.** Context: the session's Atlassian MCP connector requires OAuth and is not available non-interactively. Options: use it (if authorized) only to read tickets independently as ground truth for D and F, or rely on the user's report. Recommendation: use it read-only if it is authorized when P7 runs, otherwise rely on the user's report and the raw Jira REST reads the dev server makes.
4. **Q9 (priority also applies with the Working section off) is under test as decided.** Context: E4 asserts the contract's provisional decision. If P5 recorded a different decision, E4 follows P5's recorded decision and the spec's wording ("with Working section on") rather than this text.
5. **Replay provider may not call the new tools.** Context: `Replay (dev)` replays recorded scenarios, and none calls `link_ticket` or `set_thread_priority`. Options: add a replay scenario in P4 (costs P4 scope), call the MCP tools directly with the thread's MCP credentials (C3 fallback), or spend one cheapest-model turn. Recommendation: the direct MCP call fallback in C3 first; a real Haiku turn only if the user wants model-behaviour confirmation beyond the P4 evals.
6. **Mobile host availability.** Context: an iOS simulator is not available on Linux, and an Android emulator or device may not be present on this host (the repository is on Linux). Options: run mobile on an available Android device/emulator, ask the user for a device host, or mark I2 not run. Recommendation: attempt Android if a device or emulator is already present; otherwise report I2 as not run and let the user choose a device host, since the e2e rule counts a skipped path only when no autonomous route exists.
7. **Contract note.** The index (section 1, P7) says the token must not appear in "`settings.json` as a client sees it"; the code exposes settings to clients only through `ServerConfig.settings` and the `settingsUpdated` stream, so B4 checks those frames and the settings API response rather than a file. No contract change needed.
