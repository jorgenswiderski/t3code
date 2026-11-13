# Thread tickets and priority — design

Status: approved 2026-11-13. Paths are relative to the repo root.

## Intent

The user works from the sidebar inbox with the Working section on (`sidebarWorkingShelfEnabled`),
so running threads fold away and the inbox holds only threads waiting on them. They want that inbox
ordered by what matters in Jira, so they can click the top item and trust it is the most important
thing on their plate, without curating the order by hand.

So: threads get linked to Jira tickets (agents do this proactively), each thread gets an effective
priority, and the inbox can sort by it, following both Jira priority and Jira board rank (dragging a
card on a kanban board moves the thread in T3).

## Goals

1. Threads carry links to Jira tickets. Agents link tickets on their own; T3 also links keys it finds
   in the thread's branch name. The user can link and unlink by hand.
2. Each thread has an **effective priority**, resolved in this order (user decision):
   **user-set > Jira > agent provisional.**
   - User-set: chosen by the user (UI, command palette, or an agent acting on the user's explicit
     request). Always wins until cleared.
   - Jira: the highest priority among linked tickets whose data T3 could read. Tickets in a Done
     status still count, for both priority and rank: the thread keeps its place until the user
     settles it (user decision).
   - Agent provisional: set by the thread's agent; only used when neither of the above exists.
3. The priority **scale is the linked Jira site's own priority list and order** (user decision).
   User-set and agent values are picked from that same list.
4. A new client setting, **Inbox order**, with options "Recently returned" (today's behavior,
   default) and "Priority". With "Priority" (user decisions):
   - Pinned threads stay above everything, unchanged.
   - Inbox threads sort by effective priority, highest first.
   - Within one priority level, threads with a Jira rank sort by rank (board order); threads with no
     rank (no ticket, or ticket without rank) follow, newest-returned first.
   - Threads with no effective priority go to the bottom, newest-returned first.
5. T3 keeps ticket data fresh on its own from Jira (user picked server-side sync over
   agent-reported values).

## Non-goals

- Trackers other than Jira (Linear, GitHub Issues). The link shape carries a `tracker` field so one
  could be added later; nothing else is generalized.
- Jira Server / Data Center. Jira Cloud (REST v3, email + API token) only.
- Writing back to Jira (changing priority or rank from T3).
- Priority ordering in the boring (folder) sidebar, the Working shelf, Snoozed, or Settled. Only the
  inbox ("active") list sorts by priority.
- Filtering or grouping by priority or ticket.

## Anti-goals (would make this a failure even if it "works")

- A stale order presented as current: a priority bumped in Jira that never moves the thread.
- Thread history and websocket traffic growing on every sync tick. Sync must write nothing when
  nothing changed.
- Users without Jira paying for it: no extra agent prompt text and no sync work when Jira is not
  configured.
- A one-way door: anything linkable must be unlinkable; any priority set must be clearable; an
  auto-linked branch ticket the user removes must stay removed.

## Constraints

- Event-sourced server (`docs/internals/overview.md`): links and priorities are thread state changed
  only by commands → events → projections. Side effects (Jira calls) run in a reactor, after commit.
- Every client surface: web, desktop, mobile share `packages/client-runtime`; the sort lives there.
- Remote ready: the Jira credential and sync live on each environment (server). Each machine the
  user connects to needs its own Jira connection. Clients never talk to Jira.
- Performance: the sync is one batched Jira search per sweep, not one call per ticket; refreshes
  only change thread state when a ticket's data actually changed.
- Model-facing text (agent instructions, MCP tool descriptions) changes go through `evals/` per
  `evals/README.md`, with cases that fail before the change.

## Approaches considered

- **A. Ticket links stored on the thread, mirroring PR links (chosen by the user).** Thread gets
  `ticketLinks` with the latest Jira snapshot per link, plus user and agent priority fields. A
  server reactor refreshes snapshots like `PullRequestSyncReactor`. The site priority list rides in
  `ServerConfig`. Sorting stays in client-runtime. Trade-off: a ticket linked to several threads is
  stored and refreshed per thread, and each real change writes a thread event. Acceptable because
  Jira rank changes only for the card actually moved.
- **B. Separate server-side ticket store plus a new client stream.** One record per ticket, no thread
  event churn, but a new projection and a new subscription that web and mobile must merge with the
  thread list. Rejected as much more machinery for a small gain.
- Rejected outright: clients fetching Jira directly (CORS, every client needs the token, breaks
  mobile/remote); a generic tracker abstraction (YAGNI); agent-refreshed priorities (go stale,
  defeating the goal).

## Design (decided parts)

### Thread state (contracts)

In `packages/contracts/src/orchestrationV2.ts` (thread schema near `pullRequests`, L475/L2150), new
optional fields, absent on old threads and read as empty/null (lenient decoding like
`StoredThreadTags`, so a later rule change never fails a whole thread):

- `ticketLinks: ThreadTicketLink[]`, new file `packages/contracts/src/threadTicket.ts`:
  - `tracker: "jira"`, `key` (e.g. `PROJ-123`, canonical upper case), `url`
  - `source: "manual" | "agent" | "branch" | "branch-dismissed"` — `branch-dismissed` keeps a link
    the user removed from being re-added by branch detection (mirrors PR `stack-dismissed`) and is
    hidden from display.
  - `linkedAt`
  - `snapshot: null | { title, statusName, statusCategory ("new"|"indeterminate"|"done"),
    priority: { id, name } | null, rank: string | null, syncedAt }`
  - `syncError: null | "not_found" | "forbidden"` — the ticket could not be read; it contributes no
    priority or rank, and the UI shows it as unreachable.
- `priority: { user: PriorityRef | null, agent: PriorityRef | null }` where `PriorityRef` is
  `{ id, name }` from the scale. Resolution against the current scale is by id, then by
  case-insensitive name, so values survive connecting or disconnecting Jira (the default five match
  Jira's default names); a value matching neither still displays but is ignored for sorting (falls
  through to the next source). *(Builder-check call: resolve in the client, no migration command.)*

Neither field bumps the thread's `updatedAt` (list them beside `thread.tags-updated` in
`packages/client-runtime/src/state/orchestrationV2Projection.ts:297-299`), so linking or a Jira
refresh never reorders a thread by recency.

Projection: threads are stored as a JSON blob, so no SQL migration is needed (per recon); add
the events to `ProjectionStore.ts` beside `thread.tags-updated` and carry the fields on
`EnvironmentThreadShell`.

### Commands and events

- `thread.ticket.link` { threadId, key, url?, source } and `thread.ticket.unlink` { threadId, key }.
  Unlinking a `branch` link turns it into `branch-dismissed` instead of removing it.
- `thread.ticket-link.sync` { threadId, key, snapshot | syncError } — server-only, dispatched by
  the reactor, guarded like `thread.pull-request.sync` against stale writes, and a no-op (no event)
  when the incoming snapshot equals the stored one ignoring `syncedAt`.
- `thread.priority.set` { threadId, source: "user" | "agent", priority: PriorityRef | null }.
  `null` clears that source.
- Events: `thread.ticket-links-updated`, `thread.priority-updated`. Add protected client commands to
  `CLIENT_GUARDED_RPC_SCOPES` and extend the permission tests (AGENTS.md "Taste").

### Effective priority and sort (client-runtime)

New pure helpers in `packages/client-runtime/src/state/` (beside `threadInbox.ts`):

- `effectiveThreadPriority(thread, scale)` → `{ ref, source: "user"|"jira"|"agent", position } |
  null`, where `position` is the index in the scale (0 = highest). Jira source = best position among
  links with a readable snapshot and a priority in the scale.
- `threadJiraRank(thread)` → the lexicographically smallest `rank` among readable linked tickets
  (Jira LexoRank strings compare lexicographically, and rank is site-global, so tickets from
  different Jira projects compare correctly).
- `sortInboxThreadsByPriority(threads, scaleFor, observedReturnAt)`: position asc; then threads with
  a rank before those without; rank asc; then the existing return-recency order
  (`sortInboxThreadsByReturn` logic) as the final tie-break; unprioritized last.
- Multi-environment inbox: each thread is compared using its own environment's scale position.
  Two environments on the same Jira site compare exactly; different sites compare by position, an
  accepted approximation.

Call sites switch on the new setting: web `apps/web/src/components/Sidebar.tsx:682` (and the
drag-preview path at L396), mobile `apps/mobile/src/features/threads/threadListV2.ts:803` and
`ThreadArrangementSheet.tsx:209`.

While Inbox order is "Priority", reordering *within* the inbox (`activeOrderKey` drags) is disabled,
since the order is derived, not curated. Drags between sections (into or out of the inbox, pinned,
settled) still work. Stored `activeOrderKey`s are left untouched, so switching back to "Recently
returned" restores the hand-made order; the within-level tie-break is the "Recently returned" order.
*(Builder-check call.)*

### Setting

`ClientSettingsSchema` (`packages/contracts/src/settings.ts` L393, patch L2002): `sidebarInboxSortOrder:
"returned" | "priority"`, default `"returned"`. Surfaced in Settings > General next to the Working
section row (with search terms), in the command palette next to the existing sidebar sort entries,
and in mobile's thread arrangement sheet.

### Jira connection (server)

- Server settings (`ServerSettings`, `settings.ts` L1359): `jira: { siteUrl, email, apiToken } |
  null`, with `apiToken` held through the existing settings-secret mechanism
  (`apps/server/src/secrets/settingsSecretValue.ts`), never sent to clients in plaintext.
- A settings UI section to connect, test, and disconnect Jira (a "Test connection" result shows the
  account name or the error).
- A server service, `JiraService`, owning all Jira HTTP:
  - Priority scale: `GET /rest/api/3/priority/search` (ordered highest first), cached; refreshed on
    connect and hourly.
  - Rank field id: discovered once from `GET /rest/api/3/field` (custom field with schema custom
    type `com.pyxis.greenhopper.jira:gh-lexo-rank`).
  - Project keys: cached list, used to filter branch-name matches.
  - Ticket fetch: `POST /rest/api/3/search/jql` with `key in (...)`, fields `summary, status,
    priority, <rankField>`, ≤100 keys per request.
- `ServerConfig` (`packages/contracts/src/server.ts` L624-682) gains optional
  `ticketPriorityScale: { id, name }[]` plus a capability flag. With no Jira connection the scale is
  Jira's default five (`Highest, High, Medium, Low, Lowest`, ids prefixed `default:`), so user and
  agent priorities still work.

### Sync reactor (server)

`apps/server/src/orchestration-v2/TicketSyncReactor.ts`, patterned on `PullRequestSyncReactor.ts`:

- Runs only when Jira is configured.
- Sweep every 2 minutes. It covers tickets linked to threads that are not settled, archived, or
  deleted (inbox, working, pinned, snoozed). It dedupes keys across threads into one batched
  search, then dispatches `thread.ticket-link.sync` per (thread, key) only where the data changed.
- Immediate one-off fetch when a ticket is linked or Jira is (re)connected.
- Errors: 404/not-visible → `syncError`; auth failure or Jira outage → keep last snapshots, log,
  surface a connection error in the Jira settings section; never clear priorities on transient
  failure.

### Branch-name detection (server)

When a thread's branch is set or changes, extract `[A-Z][A-Z0-9_]+-[0-9]+` matches
(case-insensitive, normalized upper) whose project key exists on the Jira site, and link each with
`source: "branch"` unless already linked or `branch-dismissed`. Runs only when Jira is configured.

### Agents (MCP + instructions)

- MCP tools in a new `apps/server/src/mcp/toolkits/tickets/` (registered like `pullRequests/`, with
  display entries in `packages/shared/src/t3McpToolPresentation.ts`):
  - `link_ticket` { key or url, threadId? } / `unlink_ticket` { key, threadId? }
  - `set_thread_priority` { priority (name or id from the scale) | null, userRequested?: boolean,
    threadId? } — default writes the **agent provisional** value; `userRequested: true` writes the
    user value and is only for when the user explicitly asked for that priority. No server-side
    guard: agents already act with the user's authority (rename, launch, delegate), so this is
    enforced by instructions and evals only. *(Builder-check call.)*
  - The scale is listed in the tool description or result so the agent picks valid names.
  - Handlers call service methods (one service method per tool), so UI, MCP, and scheduled tasks
    share the path.
- Instructions: a short `<ticket_linking>` block in
  `packages/provider-core/src/server/runtimeInstructions.ts` beside `PULL_REQUEST_LINKING_INSTRUCTIONS`,
  included only when the environment has Jira configured: link any Jira ticket the work is for
  (mentioned in the prompt, branch, PR, or commit) as soon as it is known; when the thread has no
  linked ticket, set a provisional priority reflecting the request's urgency; never mark a priority
  as user-requested unless the user asked for that value.
- Evals: add cases to `evals/mcp-tool-use/cases/` covering proactive linking, provisional priority
  only when no ticket, and not using `userRequested` unprompted; they must fail before the text
  change.

### Client UI

- Inbox row: a compact priority indicator (glyph shaded by scale position plus the priority name in
  its tooltip, with source: "You", "Jira PROJ-123", or "Agent guess"). No remote Jira icon images
  (they can require auth and leak requests from remote clients).
- Thread header / details: linked tickets as chips (key + title, status), opening the Jira URL;
  unreachable tickets marked; unlink from the chip.
- Thread context menu and command palette: "Priority ▸" (scale + "Clear my priority"), "Link Jira
  ticket…", and unlink per ticket. Mobile thread actions get the same.
- Docs: a concise section in `docs/user/` on linking Jira, priority sources, and Inbox order.

## Left to the builder

- Exact command/event/field names and file layout, within the shapes above.
- Visual design of the indicator and chips (follow `docs/internals/web-ui.md` and existing PR chip
  styling).
- Where in Settings the Jira section lives, as long as it is findable via settings search.
- Sweep gating details beyond the above (e.g. backoff on Jira 429s).
- Test layering per AGENTS.md "Verifying".
