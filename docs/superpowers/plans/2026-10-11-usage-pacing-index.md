# Usage pacing: plan index and shared contract

Spec: `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` (read it in full first).
Ground truth: worktree `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing`, branch
`feat/usage-pacing` at `2ca9e43bb` (tag `v0.0.46-nightly.20261011.2980` plus the spec commit).
Porting source (read-only, never edited): `/home/jorgen/Code/statusline`.

Plan writers run in parallel from this document. Everything two or more plans must agree on
is pinned here. Where a plan needs something another plan produces, it codes against the
interface in section 6 and does not wait for the other plan's text. If a writer finds this
contract wrong against the code, it records the problem in its plan's "Open questions /
spec deviations" section, follows the contract anyway, and names the contract item.

Every path, line and name below was checked against the code at `2ca9e43bb`. Line numbers
drift; re-locate by symbol before editing.

---

## 1. Plans

| Id               | Plan file                                     |
| ---------------- | --------------------------------------------- |
| P1-shared        | `2026-10-11-usage-pacing-p1-shared.md`        |
| P2-server-usage  | `2026-10-11-usage-pacing-p2-server-usage.md`  |
| P3-server-thread | `2026-10-11-usage-pacing-p3-server-thread.md` |
| P4-web-header    | `2026-10-11-usage-pacing-p4-web-header.md`    |
| P5-web-glyph     | `2026-10-11-usage-pacing-p5-web-glyph.md`     |
| P6-e2e-install   | `2026-10-11-usage-pacing-p6-e2e-install.md`   |

All live in `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/docs/superpowers/plans/`.

Three plans publish an early **milestone**: a commit, partway through the plan's branch,
that is merged forward into `feat/usage-pacing` before the rest of the plan is done, so a
downstream plan can start sooner (section 3). A milestone is not a separate branch or PR.
It is a commit the plan's own task list reaches first, whose content is fixed in section 6.

### P1-shared

Pure, framework-free functions in a new `packages/shared/src/usagePacing.ts`, with
`packages/shared/src/usagePacing.test.ts`. Add the subpath export
`"./usagePacing": { "types": "./src/usagePacing.ts", "import": "./src/usagePacing.ts" }`
to `packages/shared/package.json` (the package has no barrel; every module is an explicit
subpath, see `"./usageLimits"` at line ~350). Scope is spec §4 in full plus the formatters
and the work-hours parser listed in §6.1, with exactly the exported API in §6.1 (no extra
exports: knip flags unused exports, and the web plans consume only what is listed).

Port verbatim, adapting only input shapes:

- `burn-tier.ts` (`roundBurn`, `burnTier`, the `+1e-9` nudge, `exponent === 1` fast path).
- `burn-rate.ts` `computeBurn`, including the details the spec omits: `dt < 1` is clamped
  to 1; a current reading more than 0.1 below the newest sample zeroes `iv` and `obs`;
  a negative rate is clamped to 0; `burnx <= 0` returns null.
- `weekly-burn.ts` `scheduleWeight` (local calendar-day walk via the
  `new Date(y, m, d, 0, min)` normalisation trick, wrap past midnight) and
  `computeWeeklyBurn`, with Sat/Sun replaced by the configurable work-day set and the
  non-work-day weight fixed at 0.
- `cache-warmth.ts` `sameIdentity` / `cacheWarmth`, with the field set reduced to
  model / effort / fastMode (no `version`, no `hasCurrentUsage`), `[...]` suffix stripping
  on model kept, and the `expiry - now <= warn` boundary kept (see §9 item C3).
- `colors.ts` `usageRank` / `tokenRank` reshaped into `contextTier` with the 50/65/80 %
  thresholds (integer part of the percentage, as `intPart` does) and 200k/300k/400k tokens.

Port the statusline tests for burn-tier, burn-rate (including the tier characterization
table), weekly-burn (including both America/Los_Angeles DST cases and the 20:00-02:00 wrap)
and cache-warmth into vitest (`import { describe, expect, it } from "@effect/vitest"`, as
`dateTime.test.ts` does). The DST tests scope `process.env.TZ` per test exactly as
`weekly-burn.test.ts` lines 69-80 and 233-245 do. Add tests for configurable work days,
the context tiers, role/label helpers and every formatter. No React, no I/O, no timers.
Does not edit `packages/shared/src/usageLimits.ts`; it may import `formatDuration` from it.

Verification: `PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts`
and `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/shared#typecheck`.

### P2-server-usage

Server-side usage freshness and history, spec §5.1 and §5.2.

(a) `apps/server/src/provider/claudeUsageLimits.ts`: `claudeRateLimitEventToUpdate(info, names)`
reads the untyped `info.unifiedWindows` structurally and returns one window per listed key
that is in `WINDOWS` (`five_hour`, `seven_day`). Field semantics, confirmed in the user's
real provider logs (`~/.t3/userdata/logs/provider/events.*.log`): `utilization` is a 0-1
fraction, `resetsAt` is epoch seconds, e.g.
`"unifiedWindows":{"five_hour":{"utilization":0.02,"resetsAt":1791654000},"seven_day":{"utilization":0.62,"resetsAt":1791828000}}`.
Those same log lines carry **no top-level `utilization`** when `status` is `allowed`, so
today's function returns `undefined` for most events. The `unifiedWindows` path must not
be gated on the top-level `utilization`. The single-window `rateLimitType` path stays for
events without `unifiedWindows` and stays the only path for `seven_day_overage_included`
(scoped window via `names.overageIncluded`). When both paths name the same window id, the
`unifiedWindows` entry wins. The exported signature does not change, so **P2 does not edit
`ClaudeAdapterV2.ts`** (its call site at line ~6577 keeps working unchanged).

(b) `packages/provider-core/src/server/managedProvider.ts` (+ `usageLimits.ts` helpers):
an in-memory sample list per window id for windows of `kind: "session"`, outside the
published snapshot, re-attached as `history` whenever the snapshot is published (both
`applyUsageLimits` and the probe path in `applySnapshotBase`, which today replace windows
wholesale and would otherwise drop it). Recording, pruning and transport rules are in §6.2.
`applyUsageLimitsUpdate` currently returns the previous object when nothing moved, which
keeps Codex's per-token-tick notification from publishing; the heartbeat rule in §6.2 keeps
that property.

(c) Contract: `history` on `ServerProviderUsageWindow` (§6.2). This is milestone
**P2-contract**.

(d) (coherence) `apps/server/src/provider/providerStatusCache.ts` strips `history` from the
on-disk `caches/<instanceId>.json` copy (spec §5.2 "No persistence"); single owner P2.

Tests: `claudeUsageLimits.test.ts` (an event with `rateLimitType: "seven_day"` and
`unifiedWindows` updates both windows; the real logged payload above with no top-level
utilization updates both), `usageLimits.test.ts` / `managedProvider.test.ts` (append,
heartbeat coalescing, prune on reset / credential / workspace change, 400 cap, survives a
probe replace), contract decode in `packages/contracts/src/server.test.ts` (it already
decodes `usageLimits.windows`, line ~184). No web changes.

### P3-server-thread

Per-thread token usage reaching the sidebar, spec §5.3. Gets a full review.

(a) Contracts and client-runtime mirror, exactly as §6.3. This is milestone **P3-contract**.

(b) `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, top-level assistant
usage path (the `provider_turn.updated` emitted at line ~6943 inside
`if (message.type === "assistant" && input.replayed !== true)`, guarded by
`parent_tool_use_id === null` and `model !== "<synthetic>"`, built by
`claudeProviderTurnTokenUsage` at line ~192): fill `requestIdentity` per §6.3 and carry
forward the provider thread's last known `promptCacheTtlMs` when the report has none.
The compaction path (line ~6795, `tokenUsage: { usedTokens: afterTokenCount, ... }`) gets
neither (§9 item D2).

(c) Projection: `latestTokenUsage` on `OrchestrationV2ThreadShell`, sourced from the
persisted provider-turn rows (`orchestration_v2_projection_provider_turns.payload_json`)
so historical threads are covered without backfill, and updated live on the shell stream
whenever a top-level provider turn's `tokenUsage` changes. Follow `activeProviderGoalForShell`
(`ProjectionStore.ts` line ~1576), which is wired in two places: the full-projection shell
builder (line ~1524) and the row-based shell state (line ~5743). This is a D-level spot:
the plan spells out the projection/shell mechanics in code. Shell pushes must not exceed
one per `tokenUsage` change of the active provider thread; if the shell stream already
coalesces (see `ThreadLiveEventCoalescer.ts`, `ShellStream.ts`), ride it.

(d) Regression test pinning the 0.0.45 1m/1m bug: a `task_progress` or `task_notification`
frame with a large `usage.total_tokens` must not change any `tokenUsage` (the only reader
of `total_tokens` today is `claudeWorkflowProgress.ts` line ~188, which feeds workflow
progress, not token usage).

Tests per AGENTS.md: drain `OrchestrationEffectWorkerV2` or await the persisted event or
`Deferred`; no sleeps. `requestIdentity` and TTL carry-forward in `ClaudeAdapterV2.test.ts`;
`latestTokenUsage` live and historical in `ProjectionStore.test.ts` / `ShellStream.test.ts`;
the existing `ProviderTurnTokenUsage.test.ts` shows the `upsertProviderTurn` style. No web
changes beyond the client-runtime model.

### P4-web-header

Header pacing widget, popover and the Usage pacing settings section: spec §3.1, §3.2, the
pacing rows of §3.4, and the `PacingWidget` / `PacingPopover` / `useNowTick` parts of §5.4.

Milestone **P4-foundation** (first tasks of the plan, content fixed in §6.4 and §6.5):
`useNowTick`, the tier-colour class map, the six client settings, and the Usage pacing
settings route/section/nav/search/restore-defaults, including extracting the weekday
picker into a shared component.

Then the widget and popover: new components under `apps/web/src/components/pacing/`,
mounted from `ChatView.tsx` into the fixed top-right controls cluster (`panelLayoutControls`,
line ~11262, a `position: fixed` div that holds `PanelLayoutControls`) to the left of the
toggles. (Coherence: P4 resolves a placement per layout with `resolvePacingPlacement`: the
cluster when no right panel is present; beside the thread-details toggle inside
`threadPanelHeaderControl` when the inline right panel owns the title bar, because the
cluster then covers the panel's tab bar; nowhere while the sheet is open or the panel is
closing. See Decisions needed.) The breadcrumb truncates because the widget publishes its
width as the CSS variable `--pacing-widget-reserve` on `<header data-chat-header>` and
`ChatHeader.tsx` applies it as `mr-[var(--pacing-widget-reserve,0px)]` on its `flex-1` root;
the existing `rightPanelOpen ? "pr-10" : "pr-24"` padding (line ~305) stays (an arbitrary
padding value fails `shadcn/no-arbitrary-values`; margin is in the allowed `layout` category). The provider is
`activeProviderStatus` (`selectedProviderEntry?.snapshot`, ChatView line ~3273), a
`ServerProvider`; read `usageLimits` from it. Breakpoints: below 560 px of header width drop
the reset column, below 420 px hide the widget. Note the cluster is rendered outside
`<header data-chat-header>` when `rightPanelControlsAtRoot` is true, so a CSS container
query on the header cannot reach it from there; the plan picks the mechanism and records it
as a spec deviation. (Coherence: P4 picked `observeResize` on the header's border box feeding
`pacingLayoutForHeaderWidth`; spec §3.1 now says "measured on the header".)
Visual values come from spec §3.1/§3.2 and the mockups in
`docs/superpowers/specs/assets/usage-pacing/` (`header-widget.png`, `header-popover.png`);
the plan restates every value. Popover via `apps/web/src/components/ui/popover.tsx`
(`Popover`, `PopoverTrigger` with `openOnHover`, `PopoverPopup`); hover opens, click pins,
outside click or Escape closes a pinned popover. Footer: `Usage details →` to `/usage`
(`apps/web/src/routes/usage.tsx`), `Settings` to `/settings/usage-pacing`.

User docs: a concise section in `docs/user/usage.md`.

Web logic tests (no static-markup rendering, per AGENTS.md): row visibility from toggles,
row order and roles, the breakpoint decision, `useNowTick` sharing one timer. Verification:
targeted `vp test run`, `vp run @t3tools/web#typecheck`, `vp run @t3tools/contracts#typecheck`,
`vp lint <changed files>`.

### P5-web-glyph

Thread context glyph, spec §3.3, the meter-toggle row of §3.4, and the
`ThreadContextGlyph` part of §5.4.

A shared SVG component `apps/web/src/components/pacing/ThreadContextGlyph.tsx` with the
exact geometry in code (D-level spot): ring = context fraction in the context tier colour
(§6.1 `CONTEXT_TIER_COLORS`), stroke 1.6 px at 14 px and 2 px at 18 px, round caps, track
muted at 25 % opacity, arc from 12 o'clock clockwise; dot radius 15 % of size, fill
`color-mix(in oklab, <state colour> 45%, <muted>)`, warm state colour = muted (plain grey
dot), expiring = `--warning`, cold / unknown = no dot. Mounts:

- 14 px in `SidebarThreadRow` (`apps/web/src/components/Sidebar.tsx` line ~1107),
  immediately before the relative timestamp in the row's top status slot (the
  `threadTimeLabel(thread)` spans, lines ~1893 and ~2086; the slim list at ~2387 is a
  third time slot the plan must decide on). Fed by `thread.latestTokenUsage` (§6.3) and
  `thread.modelSelection`.
- 18 px inside `ContextWindowMeter` (`apps/web/src/components/chat/ContextWindowMeter.tsx`),
  replacing its inline ring `<svg>` while keeping the popover (tokens, cost, Compact,
  resume-compaction offer). Fed by the live snapshot (`activeContextWindow` for tokens, and
  `activeThreadLiveTokenUsage`, ChatView line ~1725, for TTL and identity, since
  `ContextWindowSnapshot` carries neither) and the composer's selected model selection.

Tooltip via `formatThreadContextTooltip` (§6.1); in the sidebar the text is a line in the
row's existing hover card (`SidebarThreadTooltip`), because the status slot holding the glyph
is `pointer-events-none` and fades under row hover; in the composer it is the meter button's
`aria-label` plus a cache line in the meter popover (coherence; see Decisions needed). Time via
`useNowTick(30_000)` (§6.4), called inside the glyph wrapper, not in the row, so a tick
re-renders glyphs only. Settings:
the composer-ring toggle moves out of "Legacy features" into the Usage pacing section
(§6.5, §9 items D3 and D4). User docs: `docs/user/composer.md` (line ~218 mentions the
context meter). Spec §6's "maxTokens missing: track only, no arc; colour by the token tier"
is self-contradictory (no arc to colour); P5 follows "tint the 25 %-opacity track with the
tier colour" provisionally (see Decisions needed).

Mockups `sidebar-glyph.png` and `composer-glyph.png` predate the grey warm dot and the new
tiers.

### P6-e2e-install

Runbook-detail plan in two parts.

(1) End-to-end validation of spec §7 items 1-6, run once on `feat/usage-pacing` after
P1-P5 have fully merged, against the integration worktree's dev server with isolated
`.t3` state (coherence: a fresh home in the session scratchpad passed as
`dev-runner.ts dev --home-dir`, not the worktree's own `.t3`, so P6 owns and can restart
that server), driven by Playwright + headless Chrome, saving screenshots as handoff evidence.
It locates UI through the DOM hooks in §6.6. Environment facts the plan must bake in:
`vp` is not on PATH globally (run dev as
`PATH="$PWD/node_modules/.bin:$PATH" node scripts/dev-runner.ts dev` and read ports and
`pairingUrl` from the `[dev-runner]` output); the user's shell wraps `cd` via fnm and returns
127 (use `builtin cd` and `;`, not `&&`); `vp run migrate-dev-db` cannot seed (the live
`~/.t3/userdata` has only the V1 `state.sqlite`, confirmed), so the dev DB starts empty and
the agent creates a project and threads; Codex is not installed in the dev instance, so
Claude must be the selected provider; Playwright lives in `/tmp/t3-snap` (google-chrome at
`/usr/bin/google-chrome`, persistent profile `/tmp/t3-snap/profile` with a dev pairing
cookie; re-pair via `node apps/server/src/bin.ts pair --base-dir <dev home>`; every `bin.ts`
call passes `--base-dir`, because without it the CLI falls back to `T3CODE_HOME` or `~/.t3`);
the repo's `test-t3-app` skill
prefers the T3 Browser panel, which is unavailable headless, and the user approved
Playwright. A few short real Claude turns plus one subagent/workflow turn (item 4) are
allowed. Stop only processes it started, by tracked PID (AGENTS.md rule 1).

(2) Build the fork's `t3` CLI from the integration branch (investigate
`scripts/build-cli-archive.ts`, `scripts/smoke-cli-archive.ts`, `packaging/`, and how
`~/.t3/runtime/versions/<v>/` and `t3 update` resolve installs), verify it starts against a
throwaway `--base-dir`, and write a runbook the user executes to switch their daily T3
(stable 0.0.45 now, nightly channel first) to the fork build, with rollback. Agents never
touch `~/.t3/userdata` and never restart the user's T3 service.

---

## 2. Plan-time DAG

Which finished plan each writer reads before writing. All writers work from this index
alone, in parallel.

```
P1-shared        <- []
P2-server-usage  <- []
P3-server-thread <- []
P4-web-header    <- []
P5-web-glyph     <- []
P6-e2e-install   <- []
```

---

## 3. Implement-time DAG

Which plan's code builds on which. Drives branch bases and merge order (section 5).
`X:m` means milestone `m` of plan X has merged into `feat/usage-pacing`; a bare `X` means
the whole plan has.

```
P1-shared         <- []
P2-server-usage   <- []            (publishes milestone P2-contract)
P3-server-thread  <- []            (publishes milestone P3-contract)
P4-web-header     <- [P1, P2:P2-contract]           (publishes milestone P4-foundation)
P5-web-glyph      <- [P1, P3:P3-contract, P4:P4-foundation]
P6-e2e-install    <- [P1, P2, P3, P4, P5]
```

Decisions behind it:

- **`useNowTick` belongs to P4**, inside P4-foundation, and P5 builds on P4-foundation.
  P1 cannot own it (P1 is framework-free), and a P5-owned hook would put P4 behind P5.
  P4-foundation also carries what P5 shares with P4 anyway: the tier-colour class map and
  the Usage pacing settings section that P5's toggle row lands in. The rest of P4 (widget,
  popover, ChatView/ChatHeader mount) and all of P5 then run in parallel.
- **P4 and P5 depend on contract milestones, not whole server plans.** Their code reads only
  the optional contract fields; the server behaviour behind those fields matters only for
  the end-to-end run, which is P6's.
- P1, P2, P3 are independent roots and start immediately. P1 is the shortest root and gates
  P4, so it is worth starting first.

Critical path: P1 -> P4-foundation -> P5 -> P6 (P3 runs alongside; P5 also waits for
P3-contract, which is P3's first task).

---

## 4. Deploy-ordering constraints

None bind any plan. Server and client ship in one build (the fork's `t3` CLI bundles both),
and every new wire field is optional:

- `ServerProviderUsageWindow.history` (P2), `OrchestrationV2ProviderTurnTokenUsage.requestIdentity`
  and `OrchestrationV2ThreadShell.latestTokenUsage` (P3) are all `Schema.optional`.
- Mixed versions degrade, they do not break (AGENTS.md "Remote ready"): a fork client on an
  upstream server gets no `history` (session burn uses the linear fallback, spec §5.2), no
  `latestTokenUsage` (no sidebar glyph, spec §3.3 "No data") and no `requestIdentity`
  (identity check skipped, spec §4.5). An upstream client on a fork server ignores the fields.
- New client settings decode with defaults, so stored settings from before the fork load.
  P5 renames `contextWindowMeterEnabled` to `composerContextRingEnabled`; a stored old key is
  dropped on decode (no error), and going back to an upstream build re-reads its own default.
- P2's `history` is stripped from the on-disk provider status cache, so a downgrade never
  reads it back.

The one ordering rule outside code: P6's runbook (switching the user's daily T3 to the fork
build) runs only after P6 part 1 passed on the fully merged integration branch. It binds P6
only, and the user executes it.

---

## 5. Branch topology

Repo for every branch: `/home/jorgen/Code/t3code` (worktrees of that repository). The
statusline repo gets no branch. No branch tracks an upstream and nothing is pushed.

| Unit             | Branch                               | Base                                | Worktree                                                                                                                                                                                                                                                                      | Created when                                           | Merges into                                                       |
| ---------------- | ------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| Integration      | `feat/usage-pacing`                  | tag `v0.0.46-nightly.20261011.2980` | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing`                                                                                                                                                                                                                     | exists (holds the spec commit; will hold plan commits) | (end state)                                                       |
| P1-shared        | `feat/usage-pacing-p1-shared`        | `feat/usage-pacing`                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p1-shared`                                                                                                                                                                                                           | immediately                                            | `feat/usage-pacing`                                               |
| P2-server-usage  | `feat/usage-pacing-p2-server-usage`  | `feat/usage-pacing`                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p2-server-usage`                                                                                                                                                                                                     | immediately                                            | `feat/usage-pacing` (P2-contract commit first, then the branch)   |
| P3-server-thread | `feat/usage-pacing-p3-server-thread` | `feat/usage-pacing`                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p3-server-thread`                                                                                                                                                                                                    | immediately                                            | `feat/usage-pacing` (P3-contract commit first, then the branch)   |
| P4-web-header    | `feat/usage-pacing-p4-web-header`    | `feat/usage-pacing`                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p4-web-header`                                                                                                                                                                                                       | after P1 and P2-contract merged                        | `feat/usage-pacing` (P4-foundation commit first, then the branch) |
| P5-web-glyph     | `feat/usage-pacing-p5-web-glyph`     | `feat/usage-pacing`                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p5-web-glyph`                                                                                                                                                                                                        | after P1, P3-contract and P4-foundation merged         | `feat/usage-pacing`                                               |
| P6-e2e-install   | none (runs on `feat/usage-pacing`)   | n/a                                 | `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing` (Part 1); detached build worktree `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build` at the validated SHA, no branch (Part 2; holds the release version bump and the mirror the user's runbook serves) | after P1-P5 fully merged                               | n/a (fixes found by P6 go through a fix branch, procedure below)  |

### Procedures (all commands use `builtin cd` and `;`, never `&&` after `cd`)

**Create a child worktree** (from the integration worktree, which is the only place `vp`
binaries exist before the child's install):

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git worktree add -b feat/usage-pacing-<id> /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id> feat/usage-pacing
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id>; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/node_modules/.bin:$PATH" node scripts/setup-worktree.ts
```

`setup-worktree.ts` runs `vp i`, links env files from the main checkout (none exist today;
it skips missing ones) and warms the web dependency cache. After it, use the child's own
`node_modules/.bin`.

**Merge a milestone forward** (P2-contract, P3-contract, P4-foundation). The implementing
agent reports the milestone commit SHA after that commit's verification passed; the
orchestrator merges that commit, not the branch head:

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git merge --no-ff <milestone-sha> -m "merge: <milestone> (feat/usage-pacing-<id>)"
```

The child keeps working on its branch; its later full merge brings only the remaining
commits.

**Merge a plan forward** when its verification passes and its independent review findings
are resolved:

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git merge --no-ff feat/usage-pacing-<id> -m "merge: <plan id>"
```

The integration worktree must be clean before any merge. A dev server may be running from
it; never stop or restart it for a merge.

**When a parent or sibling merges after a child was created**, and the child must pick up
that code or would conflict at its own merge: rebase the child onto the new base, never
merge the base into the child.

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id>; git rebase feat/usage-pacing
```

Then re-run the plan's verification commands before merging forward. These branches are
local with no upstream, so rebasing needs no permission. If any branch has been pushed
(none should be), rebasing it needs the user's explicit permission; ask instead of
back-merging. The expected rebases are: whichever of P4 (widget/popover tasks) and P5
merges second rebases over the other's `ChatView.tsx` hunks; whichever of P2 and P3 merges
second rebases if `packages/contracts` diffs collide (they edit different files, so this
should be a no-op).

**Fix a failure P6 found** (the owning plan's branch was deleted after its full merge, so a
fix gets its own branch from the integration head, with the owning plan's verification
commands and review policy):

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git worktree add -b feat/usage-pacing-<id>-fix /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id>-fix feat/usage-pacing
# ... fix, verify, review, commit in that worktree ...
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git merge --no-ff feat/usage-pacing-<id>-fix -m "merge: <plan id> fix"
```

Then P6 re-runs from the first task the fix can affect.

**Remove a child worktree** after its full merge (orchestrator, once the merge is
verified): `git worktree remove /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id>`
and `git branch -d feat/usage-pacing-<id>`.

Commit titles follow AGENTS.md (conventional, plain language), for example
`feat(shared): usage pacing burn and schedule maths`.

---

## 6. Shared interfaces

### 6.1 P1 public API (`@t3tools/shared/usagePacing`)

Consumed by P4 and P5 (and later mobile). P1 implements exactly these exports; P4/P5 import
nothing else from the module. Types reference `@t3tools/contracts` only for
`ModelSelection` and `TimestampFormat`, both of which exist today
(`packages/contracts/src/modelSelection.ts`, `packages/contracts/src/settings.ts` line ~51).

Input types are **structural**, not the contract types, because P1 merges before P2/P3
add `history` and `requestIdentity`; the contract types (`ServerProviderUsageWindow`,
`OrchestrationV2ProviderTurnTokenUsage`) are assignable to them once those land. The repo
compiles with `exactOptionalPropertyTypes`, so optional inputs are written `?: T | undefined`.

Units: high-level functions take epoch **milliseconds** (`nowMs`) and ISO strings as they
appear on the wire. The three ported low-level functions take epoch **seconds**, exactly as
the statusline does, so its tests port one-to-one.

```ts
import type { ModelSelection, TimestampFormat } from "@t3tools/contracts";

// ---- §4.1 burn colour ladder ------------------------------------------------
export type PaceTier = 0 | 1 | 2 | 3;
export const BURN_TIER_YELLOW = 1.15;
export const BURN_TIER_ORANGE = 1.3;
/** round(x * 10 + 1e-9) / 10 */
export function roundBurn(x: number): number;
/** Callers pass the rounded burn. green <= greenCut, yellow <= 1.15^exponent, orange <= 1.3^exponent, else red. */
export function burnTier(burn: number, greenCut?: number, exponent?: number): PaceTier;

/** Semantic colour names; the web maps them to classes (§6.4). Not CSS. */
export type PaceTierColor = "success" | "yellow" | "orange" | "destructive" | "muted";
export const BURN_TIER_COLORS: Readonly<Record<PaceTier, PaceTierColor>>;
//   { 0: "success", 1: "yellow", 2: "orange", 3: "destructive" }
export const CONTEXT_TIER_COLORS: Readonly<Record<PaceTier, PaceTierColor>>;
//   { 0: "muted", 1: "yellow", 2: "orange", 3: "destructive" }

// ---- work schedule ------------------------------------------------------------
export interface WorkHours {
  /** Minutes past local midnight, 0..1439. */
  readonly startMin: number;
  /** Exclusive end, 1..1440 (1440 = midnight). endMin <= startMin wraps past midnight. */
  readonly endMin: number;
}
export interface WorkSchedule extends WorkHours {
  /** Weekday ints, 0 = Sunday .. 6 = Saturday (matches scheduledTask.ts weekdays). */
  readonly workDays: ReadonlyArray<number>;
  /** Weight of a work-day second outside work hours, 0..1. Non-work days weigh 0. */
  readonly offHoursWeight: number;
}
export const DEFAULT_WORK_HOURS = "09:00-17:00";
export const DEFAULT_WORK_DAYS: ReadonlyArray<number>; // [1, 2, 3, 4, 5]
export const DEFAULT_OFF_HOURS_WEIGHT = 0.2;
/** "HH:MM-HH:MM", minutes optional ("9-17"), "24:00" legal as an end; an end of "00:00" normalises to 1440; a start of "24:00" or any value > 1440 is null; null when malformed. */
export function parseWorkHours(value: string): WorkHours | null;
/** Inverse of parseWorkHours, zero-padded "HH:MM-HH:MM"; endMin 1440 prints "24:00". */
export function formatWorkHours(hours: WorkHours): string;
/**
 * Settings -> schedule. Malformed workHours falls back to 09:00-17:00 for that field alone;
 * workDays keeps unique integers 0..6; offHoursWeight is clamped to 0..1 (NaN -> 0.2).
 */
export function resolveWorkSchedule(settings: {
  readonly workHours: string;
  readonly workDays: ReadonlyArray<number>;
  readonly offHoursWeight: number;
}): WorkSchedule;
/** Weighted seconds in [fromSec, toSec), local time, walking local calendar days (DST-safe). */
export function scheduleWeight(fromSec: number, toSec: number, schedule: WorkSchedule): number;

// ---- §4.2 burn, low level (epoch seconds) --------------------------------------
export interface BurnResult {
  /** Rounded to one decimal (roundBurn). */
  readonly burn: number;
  readonly tier: PaceTier;
}
/**
 * Port of statusline computeBurn. Constants HL 1800, idle cap 3600, min obs 90, fallback min elapsed 1800.
 * Deviations (P1): zero samples fall through to the linear used/elapsed fallback instead of null;
 * no upper `t <= now` sample filter (sample age clamped >= 0, client clock skew); non-finite used -> null.
 */
export function computeSessionBurn(input: {
  readonly nowSec: number;
  readonly usedPercent: number;
  readonly resetsAtSec: number;
  /** Window length; see §9 item C1. */
  readonly windowSec: number;
  /** Ascending by atSec; already limited to this window by the server. */
  readonly samples: ReadonlyArray<{ readonly atSec: number; readonly usedPercent: number }>;
}): BurnResult | null;
/** Elapsed fraction of [resetsAt - windowSec, resetsAt) at now; schedule null = wall clock. Null when now is outside the window or the window weighs 0. */
export function weeklyElapsedFraction(input: {
  readonly nowSec: number;
  readonly resetsAtSec: number;
  readonly windowSec: number;
  readonly schedule: WorkSchedule | null;
}): number | null;
/** Port of statusline computeWeeklyBurn: roundBurn((used/100)/frac), null when frac < minElapsedFrac (default 0.02). */
export function computeWeeklyBurn(input: {
  readonly nowSec: number;
  readonly usedPercent: number;
  readonly resetsAtSec: number;
  readonly windowSec: number;
  readonly schedule: WorkSchedule | null;
  readonly minElapsedFrac?: number | undefined;
}): BurnResult | null;

// ---- §4.2 / §4.3 per window, high level ---------------------------------------
export interface PaceWindowInput {
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
  readonly windowDurationMins?: number | undefined;
  readonly history?:
    ReadonlyArray<{ readonly at: string; readonly usedPercent: number }> | undefined;
}
export interface WindowPace {
  /** Clamped 0..100: the bar fill. */
  readonly usedPercent: number;
  /** Null = blank burn column (spec §6). */
  readonly burn: number | null;
  /** Null exactly when burn is null. */
  readonly burnTier: PaceTier | null;
  /** 0..1 tick position; null when resetsAt is missing/unparseable or now is outside the window. */
  readonly paceFraction: number | null;
  /** Null when resetsAt is missing/unparseable. */
  readonly resetsAtMs: number | null;
}
/**
 * session -> computeSessionBurn over history, tick = wall-clock elapsed fraction;
 * weekly -> computeWeeklyBurn with the schedule, tick = schedule-weighted frac (the tick is
 *           drawn even while frac < 0.02 suppresses the burn);
 * monthly / other -> computeWeeklyBurn with schedule null, tick = wall-clock fraction.
 * Window length: windowDurationMins * 60, falling back to 18000 (session) or 604800 (others) when the
 * duration is missing, 0, non-finite or above 400 days (P1 safety cap: scheduleWeight walks one local day per step).
 */
export function computeWindowPace(
  window: PaceWindowInput,
  input: { readonly nowMs: number; readonly schedule: WorkSchedule },
): WindowPace;

// ---- roles and labels (§3.1/§3.2) ---------------------------------------------
export type PaceWindowRole = "session" | "weekly" | "modelScoped" | "other";
/**
 * kind "session" -> "session"; kind "weekly" whose label starts with "Weekly · " -> "modelScoped"
 * (Claude's scoped windows: id seven_day_<name>, label "Weekly · <display name>",
 * claudeUsageLimits.ts scopedWindow); other kind "weekly" -> "weekly"; monthly/other -> "other".
 */
export function paceWindowRole(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
}): PaceWindowRole;
/** Header label: modelScoped -> display name ("Fable"); else from windowDurationMins: < 60 -> "<m>m", < 1440 -> "<h>h" ("5h"), else "<d>d" ("7d"); no duration (or 0) -> window.label. */
export function paceWindowShortLabel(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
  readonly windowDurationMins?: number | undefined;
}): string;
/** Popover title: session with a known duration -> "Session · <short>" (else window.label); weekly -> "Weekly · all models"; modelScoped and other -> window.label. */
export function paceWindowTitle(window: {
  readonly kind: PaceWindowInput["kind"];
  readonly label: string;
  readonly windowDurationMins?: number | undefined;
}): string;
/** Stable order: session, weekly, modelScoped, other; ties by id. */
export function orderPaceWindows<
  T extends { readonly id: string; readonly kind: PaceWindowInput["kind"]; readonly label: string },
>(windows: ReadonlyArray<T>): ReadonlyArray<T>;

// ---- formatters ----------------------------------------------------------------
/** "1.2x" */
export function formatBurn(burn: number): string;
/** Clock time in local time: "2:40pm" (12-hour, lowercase, always minutes) or "14:40" (24-hour). "locale" resolves to one of the two from Intl's resolved hour12 (cached). */
export function formatClockTime(ms: number, timestampFormat: TimestampFormat): string;
/** windowDurationMins <= 1440 -> formatClockTime; otherwise weekday + hour: "Thu 9am" / "Thu 9:30am" (12-hour), "Thu 09:00" (24-hour). Undefined duration counts as > 1 day. */
export function formatResetLabel(
  resetsAtMs: number,
  windowDurationMins: number | undefined,
  timestampFormat: TimestampFormat,
): string;
/** "in " + formatDuration(ms) from usageLimits.ts: "in 1h 52m", "in 3d 21h", "in 4m"; ms <= 0 (or non-finite) -> "now"; 0 < ms < 60 s -> "in <1m". */
export function formatCountdown(msRemaining: number): string;
/** "950", "9.5k", "380k", "1M", "1.5M" (uppercase M; 999_500 must not print "1000k"). */
export function formatTokenCount(tokens: number): string;

// ---- §4.4 context tier ---------------------------------------------------------
/** max(% tier, token tier); % tier only when maxTokens > 0. % = integer part of used/max*100: >=80 red, >=65 orange, >=50 yellow. Tokens: >=400k, >=300k, >=200k. */
export function contextTier(usage: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}): PaceTier;
/** used / max clamped 0..1; null when maxTokens is missing or <= 0 (track only, no arc). */
export function contextFraction(usage: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}): number | null;

// ---- §4.5 cache warmth ---------------------------------------------------------
export interface RequestIdentity {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly fastMode?: boolean | undefined;
}
export interface CacheUsageInput {
  readonly updatedAt: string;
  readonly promptCacheTtlMs?: number | undefined;
  readonly requestIdentity?: RequestIdentity | undefined;
}
export type CacheWarmth = "unknown" | "cold" | "expiring" | "warm";
export const CACHE_WARN_MS = 600_000;
/** The identity the next request would carry: model = selection.model; effort / fastMode = raw option values ("effort", "fastMode") via getModelSelection{String,Boolean}OptionValue from ./model.ts; absent when unset. */
export function requestIdentityFromModelSelection(
  selection: ModelSelection | null | undefined,
): RequestIdentity | null;
/** Field absent (or empty string) on either side is skipped; model compares with a trailing "[...]" stripped. */
export function sameRequestIdentity(a: RequestIdentity, b: RequestIdentity): boolean;
/** Date.parse(updatedAt) + promptCacheTtlMs; null when either is missing/unparseable. */
export function cacheExpiresAtMs(usage: CacheUsageInput | null | undefined): number | null;
/**
 * unknown: no usage, no TTL, or unparseable updatedAt.
 * cold: identity mismatch (skipped when next is null), or nowMs >= expiry.
 * expiring: expiry - nowMs <= min(CACHE_WARN_MS, ttl / 4).
 * warm: otherwise.
 */
export function cacheWarmth(
  usage: CacheUsageInput | null | undefined,
  next: RequestIdentity | null | undefined,
  nowMs: number,
): CacheWarmth;
/**
 * "Context 380k / 1M (38%) · Cache warm, expires 3:12pm"; no maxTokens -> "Context 380k";
 * expiring -> "· Cache expiring 3:12pm"; cold -> "· Cache cold"; unknown -> clause omitted.
 * Percent = Math.round(used / max * 100). Clock via formatClockTime.
 */
export function formatThreadContextTooltip(input: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
  readonly warmth: CacheWarmth;
  readonly expiresAtMs: number | null;
  readonly timestampFormat: TimestampFormat;
}): string;
```

### 6.2 Usage history (P2 produces, P4 consumes through P1)

Contract, `packages/contracts/src/providerUsageLimits.ts` (milestone **P2-contract**):

```ts
/** One observation of a session window, recorded by the server on every usage update. */
export const ServerProviderUsageSample = Schema.Struct({
  at: IsoDateTime,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
});
export type ServerProviderUsageSample = typeof ServerProviderUsageSample.Type;

// added to ServerProviderUsageWindow, after windowDurationMins:
  /** Session windows only: samples of the current window, oldest first. Omitted when empty. */
  history: Schema.optional(Schema.Array(ServerProviderUsageSample)),
```

P2-contract also adds a decode test (a window with and without `history`). Nothing else.

Semantics the client relies on (P2 implements, P1/P4 assume):

1. Only windows with `kind: "session"` carry `history`; other kinds never do. An empty list
   is omitted, never sent as `[]`.
2. Samples are ascending by `at`, at most 400 (newest kept), and all belong to the window's
   current `resetsAt`: a change of `resetsAt` clears the list before the new sample is added.
   Two resets within 60 s of each other count as the same window (probe ISO strings and event
   epoch seconds differ by sub-second amounts; a real rollover moves the reset by hours).
   A change of `usageLimits.credentialFingerprint` or of the snapshot's `auth.workspaceId`
   (or `auth.email`, matching `switchedAccount` in `applySnapshotBase`) clears every list.
3. A sample is recorded on every usage update that carries the window, from a runtime event
   (`applyUsageLimits`) or a successful probe: `at` = the update's `checkedAt`,
   `usedPercent` = the window's merged `usedPercent` after the update. The newest sample
   therefore equals the published `usedPercent`. Claude event utilization is rounded to two
   decimals in the mapper (`Math.round(f * 10000) / 100`) so it compares equal to probe values.
4. Heartbeat coalescing (§9 item C2): a sample whose `usedPercent` equals the previous
   sample's is skipped if fewer than 60 s have passed since that previous sample. When
   nothing in the snapshot (windows or history) changed, nothing is published.
5. In memory only. After a restart there is no history until updates arrive.
6. A failed probe that keeps the last good snapshot (`resolveUsageLimitsAfterProbe`) records
   no sample. An `unsupported` probe result (a full read with no windows) clears history.
7. `history` never reaches the on-disk provider status cache (`providerStatusCache.ts`
   strips it; P2).

### 6.3 Request identity and shell token usage (P3 produces, P5 consumes)

Contract, `packages/contracts/src/orchestrationV2.ts` (milestone **P3-contract**):

```ts
/** What a request targeted, for prompt-cache identity checks. Absent fields are unknown, not mismatches. */
export const OrchestrationV2ProviderTurnRequestIdentity = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2ProviderTurnRequestIdentity =
  typeof OrchestrationV2ProviderTurnRequestIdentity.Type;

// added to OrchestrationV2ProviderTurnTokenUsage (line ~1057), before updatedAt:
  requestIdentity: Schema.optional(OrchestrationV2ProviderTurnRequestIdentity),

// added to OrchestrationV2ThreadShell (line ~1927), right after goal:
  /** Newest top-level token usage on the active provider thread; omitted by servers that predate it. */
  latestTokenUsage: Schema.optional(Schema.NullOr(OrchestrationV2ProviderTurnTokenUsage)),
```

Client-runtime mirror, `packages/client-runtime/src/state/models.ts` (same milestone):

```ts
// EnvironmentThreadShell, right after goal:
  /** Newest top-level token usage on the active provider thread. */
  readonly latestTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null;
// presentThreadShell, right after goal:
    latestTokenUsage: thread.latestTokenUsage ?? null,
```

`SidebarThreadSummary` is an alias of `EnvironmentThreadShell` (`apps/web/src/types.ts`
line ~125), so the web sidebar reads `thread.latestTokenUsage` with no web change. Mobile
builds shells only through `presentThreadShell`, so it needs no change. P3-contract also
adds decode tests (shell with and without the field; token usage with and without
`requestIdentity`).

Semantics:

- **`latestTokenUsage`**: among provider turns whose `providerThreadId` equals the shell's
  `activeProviderThreadId`, the `tokenUsage` with the greatest `Date.parse(updatedAt)`
  (ties: higher `ordinal`). `null` when `activeProviderThreadId` is null or no such turn has
  `tokenUsage`. Turns of subagent provider threads never count (they are other provider
  threads; the Claude adapter also only reports top-level usage).
- **`requestIdentity`** on Claude's top-level assistant usage:
  - `model` = `resolveClaudeModelSlug(subagentModelCatalog, <trimmed model with a trailing
"[...]" suffix removed by /\[.*$/, the same regex as P1's sameRequestIdentity>)`
    (the canonical catalog slug, the same vocabulary as `ModelSelection.model`; the adapter
    already resolves subagent models this way via `canonicalClaudeSubagentModel`, line
    ~3030), omitted when the trimmed model is empty;
  - `effort` = `getModelSelectionStringOptionValue(context.input.modelSelection, "effort")`;
  - `fastMode` = `getModelSelectionBooleanOptionValue(context.input.modelSelection, "fastMode")`;
  - each omitted when undefined. Raw option values, no default resolution (§9 item C5).
    The client builds the "next" identity with P1's `requestIdentityFromModelSelection`,
    which applies the same rule to the composer selection or the thread's `modelSelection`.
- **TTL carry-forward**: on that same path only, a report without `promptCacheTtlMs` gets
  the last TTL observed on the same provider thread. How P3 remembers it (adapter memory,
  seeded from persisted rows or not) is P3's choice. The compaction report gets neither
  carry-forward nor identity (§9 item D2).

### 6.4 Shared web pieces (P4-foundation produces, P5 consumes)

`apps/web/src/hooks/useNowTick.ts` (next to the existing `useNowMinute.ts`, which shows the
module-level-timer + `useSyncExternalStore` pattern to copy):

```ts
/** Epoch ms, refreshed every intervalMs. One timer per distinct intervalMs, shared by every consumer; stopped when the last unsubscribes. */
export function useNowTick(intervalMs: number): number;
```

Every consumer in this feature calls `useNowTick(30_000)`. With no subscribers the snapshot
re-reads `Date.now()` on render, as `useNowMinute`'s `getSnapshot` does.

`apps/web/src/components/pacing/paceTierClasses.ts`:

```ts
import type { PaceTierColor } from "@t3tools/shared/usagePacing";
/** Full literal class names so Tailwind's scanner emits them. */
export const PACE_TIER_CLASSES: Readonly<
  Record<PaceTierColor, { readonly text: string; readonly bg: string; readonly stroke: string }>
> = {
  success: { text: "text-success", bg: "bg-success", stroke: "stroke-success" },
  yellow: { text: "text-yellow-400", bg: "bg-yellow-400", stroke: "stroke-yellow-400" },
  orange: { text: "text-orange-500", bg: "bg-orange-500", stroke: "stroke-orange-500" },
  destructive: { text: "text-destructive", bg: "bg-destructive", stroke: "stroke-destructive" },
  muted: {
    text: "text-muted-foreground",
    bg: "bg-muted-foreground",
    stroke: "stroke-muted-foreground",
  },
};
```

`--color-success`, `--color-destructive`, `--color-warning` and `--color-muted-foreground`
are theme tokens in `apps/web/src/index.css` (lines ~222-246). In inline `color-mix(...)`
styles (the glyph dot), "muted" is `var(--color-muted-foreground)` (what
`text-muted-foreground` resolves to, contrast-aware) and the expiring colour is
`var(--color-warning)` (§9 item C6). Lint (`vite.config.ts`): `fill-[color-mix(...)]` fails
`shadcn/no-arbitrary-values` and a literal `fill="color-mix(...)"` fails `shadcn/no-raw-colors`,
so P5 defines the mix as an arbitrary custom property and paints with `fill-(--var)`, the
`ContextChip.tsx` precedent.

Folder: all new feature components live in `apps/web/src/components/pacing/`. P4 owns
`PacingWidget.tsx`, `PacingPopover.tsx`, `PacingBar.tsx`, `pacingRows.logic.ts` (+ test) and
`paceTierClasses.ts`, plus `apps/web/src/components/settings/usagePacingSettings.logic.ts`
(+ test) and `WeekdayToggleGroup.tsx`; P5 owns `ThreadContextGlyph.tsx` (exports
`ThreadContextGlyph`, `useThreadContextGlyphModel`, `ThreadContextGlyphBadge`,
`ThreadContextTooltipLine`) and `threadContextGlyph.logic.ts` (+ test; includes the P5-local
`glyphCacheClause`, which cuts P1's tooltip at the first `" · "` because §6.1 has no
cache-clause formatter).

P4's `PACING_RESERVE_CSS_VAR = "--pacing-widget-reserve"` (in `pacingRows.logic.ts`) is the
contract between `PacingWidget` (writes it on `<header data-chat-header>`) and
`ChatHeader.tsx` (reads it as a right margin); both sides name the other in a comment.

### 6.5 Client settings, route and search ids

P4 adds to `ClientSettingsSchema` (`packages/contracts/src/settings.ts` line ~321) as one
commented block after `contextWindowMeterEnabled` (line ~450), and the matching
`Schema.optionalKey(...)` entries to `ClientSettingsPatch` (line ~1619):

| Key                          | Schema (ClientSettingsSchema)                                                                                                                    | Default           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `usagePacingShowSession`     | `Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))`                                                                          | `true`            |
| `usagePacingShowWeekly`      | `Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))`                                                                          | `true`            |
| `usagePacingShowModelScoped` | `Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))`                                                                          | `true`            |
| `usagePacingWorkHours`       | `Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("09:00-17:00")))`                                                                  | `"09:00-17:00"`   |
| `usagePacingWorkDays`        | `Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).pipe(Schema.withDecodingDefault(Effect.succeed([1, 2, 3, 4, 5])))` | `[1, 2, 3, 4, 5]` |
| `usagePacingOffHoursWeight`  | `Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.withDecodingDefault(Effect.succeed(0.2)))`                        | `0.2`             |

`usagePacingWorkHours` is a plain string on purpose: client settings persist as one full
object (`clientPersistenceStorage.ts`, desktop `DesktopClientSettings.ts`), so a strict
pattern check that ever failed would discard the whole object. Validation lives in P1's
`parseWorkHours` / `resolveWorkSchedule` (malformed -> default for that field), mirroring
the statusline. The settings UI writes only values `formatWorkHours` produced. Defaults
must equal P1's `DEFAULT_*` constants (contracts cannot import shared, so they are
duplicated; P4 adds a test asserting equality).

P5 replaces `contextWindowMeterEnabled` (line ~450, patch line ~1664) with
`composerContextRingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))`
(provisional, §9 item D3), updating every reader: `ChatComposer.tsx` (lines ~2416, ~7669),
`SettingsPanels.tsx` (lines ~623, ~695, ~809, ~2148), `settings.test.ts` (line ~656),
`DesktopClientSettings.test.ts` (line ~36).

Route and search (P4 unless marked P5), all in `apps/web/src/components/settings/settingsSearch.ts`
plus the files named:

- `SettingsPath` gains `"/settings/usage-pacing"`; `SETTINGS_SECTION_LABELS` entry
  `"Usage pacing"`; `SETTINGS_CATEGORY_SCOPES` entry `null` (device-local);
  `SETTINGS_SECTION_ICONS` in `SettingsSidebarNav.tsx` gets a lucide icon (P4 picks).
- Route file `apps/web/src/routes/settings.usage-pacing.tsx`, component
  `UsagePacingSettingsPanel` exported from `apps/web/src/components/settings/UsagePacingSettings.tsx`;
  `apps/web/src/routeTree.gen.ts` regenerated (committed file).
- Search item ids, all `to: "/settings/usage-pacing"`: `usage-pacing-show-session`,
  `usage-pacing-show-weekly`, `usage-pacing-show-model-scoped`, `usage-pacing-work-hours`,
  `usage-pacing-work-days`, `usage-pacing-off-hours-weight`; and (P5)
  `usage-pacing-context-ring`, replacing `legacy-context-window-indicator`.
- Section layout: `SettingsPageContainer > SettingsSection` (`SettingsSection` already draws
  the grouped card). P4's six rows first (three switches, then work hours, work days, off-hours
  weight); P5 appends one `SettingsRow` "Show context ring in composer" as the seventh (last)
  direct child of the same `SettingsSection`. (Coherence: an earlier draft said "one
  `SettingsGroup`"; there is no separate group or second section.)
- P4 also adds `"/settings/usage-pacing"` to `SETTINGS_DEVICE_ONLY_PATHS` in
  `SettingsScopeSentence.tsx` (single owner P4).
- Weekday picker: P4 extracts the `ToggleGroup` block in `ScheduledTasksSettings.tsx`
  (lines ~1300-1318, with `WEEKDAY_ORDER` / `WEEKDAY_LABELS` / `WEEKDAY_SHORT`, line ~107)
  into `apps/web/src/components/settings/WeekdayToggleGroup.tsx` and uses it in both places.
  Work hours use two `<Input type="time" nativeInput>` controls like `scheduled-task-time`.

### 6.6 DOM hooks (P4 and P5 produce, P6 consumes)

Plain `data-*` attributes, matching the repo's style (`data-chat-header`,
`data-workspace-titlebar-controls`). P6's Playwright selectors use only these.

| Attribute                                                                                                                                                             | Element                                                     | Owner |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----- |
| `data-pacing-widget`                                                                                                                                                  | widget root (absent when it renders nothing)                | P4    |
| `data-pacing-row="<window id>"`                                                                                                                                       | one header row                                              | P4    |
| `data-pacing-burn`                                                                                                                                                    | burn cell of a row (empty text when blank)                  | P4    |
| `data-pacing-reset`                                                                                                                                                   | reset cell of a row (absent when dropped)                   | P4    |
| `data-pacing-tick`                                                                                                                                                    | the pace tick (absent when no tick)                         | P4    |
| `data-pacing-popover`                                                                                                                                                 | popover popup root                                          | P4    |
| `data-pacing-section="<window id>"` + `data-hidden="true\|false"`                                                                                                     | one popover section                                         | P4    |
| `data-thread-context-glyph` + `data-size="14\|18"` + `data-cache-state="warm\|expiring\|cold\|unknown"` + `data-context-tier="0\|1\|2\|3"`                            | glyph root `<svg>`                                          | P5    |
| `aria-label` = `formatThreadContextTooltip(...)` (e.g. `Context 380k / 1M (38%) · Cache warm, expires 3:12pm`), replacing today's `Context window N% used`            | the composer meter `<button>` that contains the 18 px glyph | P5    |
| sidebar tooltip text (same string) inside the row's hover card; rows are located by `[data-thread-item*="<threadId>"]` (existing attribute holding `scopedThreadKey`) | `SidebarThreadTooltip` hover card                           | P5    |

### 6.7 Milestone contents and order

| Milestone     | Plan | Contains (and nothing else)                                                                                                                                                                                                                             | Unblocks |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| P2-contract   | P2   | §6.2 contract + its decode test                                                                                                                                                                                                                         | P4 start |
| P3-contract   | P3   | §6.3 contract + client-runtime mirror + their decode tests                                                                                                                                                                                              | P5 start |
| P4-foundation | P4   | `useNowTick` (+ test), `paceTierClasses.ts`, §6.5 settings keys (+ `settings.test.ts`), `UsagePacingSettings.tsx`, route, nav, search items (+ `settingsSearch.test.ts`), restore-defaults in `useSettingsRestore`, `WeekdayToggleGroup.tsx` extraction | P5 start |

Each milestone is the first task (or first tasks) of its plan, ends in one commit whose
verification commands pass on their own, and is reported by SHA.

No new server config, env vars, tables, migrations, log fields or alerts are introduced by
any plan.

---

## 7. File ownership (files more than one plan edits)

| File                                                           | Edits, in order                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/settings.ts`                           | 1. P4-foundation: six `usagePacing*` keys in schema + patch. 2. P5: `contextWindowMeterEnabled` -> `composerContextRingEnabled` (default true) in schema + patch.                                                                                                                                                                                                                                                                                   |
| `packages/contracts/src/settings.test.ts`                      | 1. P4-foundation: a `describe("ClientSettings usage pacing")` block. 2. P5: rewrites `describe("ClientSettings context window meter")` (line ~652).                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/settings/SettingsPanels.tsx`          | 1. P4-foundation: six keys in `useSettingsRestore` (dirty labels ~line 560-640, deps ~line 690, reset object ~line 800). 2. P5: removes the legacy row (~2143) and its `LEGACY_FEATURE_TARGET_IDS` entry (~2088), renames the key in `useSettingsRestore` (label "Context ring in composer").                                                                                                                                                       |
| `apps/web/src/components/settings/settingsSearch.ts`           | 1. P4-foundation: path, label, scope, six items. 2. P5: replaces item `legacy-context-window-indicator` (~line 605) with `usage-pacing-context-ring`.                                                                                                                                                                                                                                                                                               |
| `apps/web/src/components/settings/settingsSearch.test.ts`      | 1. P4-foundation: new items. 2. P5: drops `legacy-context-window-indicator` from the loop at ~line 478, asserts the new id.                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/settings/UsagePacingSettings.tsx`     | 1. P4-foundation creates it. 2. P5 appends one `SettingsRow` as the last child of P4's `SettingsSection`.                                                                                                                                                                                                                                                                                                                                           |
| `apps/web/src/components/ChatView.tsx`                         | P4 (after P4-foundation): mounts `PacingWidget` in `panelLayoutControls` (~line 11262) or `threadPanelHeaderControl` (~11249) per `resolvePacingPlacement`, passing `activeProviderStatus?.usageLimits` and `threadPanelPopoverAnchorRef` as the header ref. P5: passes `activeThreadLiveTokenUsage` and the composer selection through to `ChatComposer` / `ContextWindowMeter` (~lines 1725, 3621, 11762). Parallel; the second to merge rebases. |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | P3 only. P2 must not edit it (its call site stays valid because `claudeRateLimitEventToUpdate`'s signature is unchanged).                                                                                                                                                                                                                                                                                                                           |
| `packages/contracts/src/*`                                     | P2: `providerUsageLimits.ts` (+ `server.test.ts`). P3: `orchestrationV2.ts` (+ `orchestrationV2.test.ts`). P4/P5: `settings.ts` as above. No file shared across P2/P3.                                                                                                                                                                                                                                                                              |
| `docs/user/*`                                                  | P4: `usage.md`. P5: `composer.md`. Neither edits the other's file.                                                                                                                                                                                                                                                                                                                                                                                  |

Single-owner files worth naming so nobody else touches them: `packages/shared/package.json`
(P1), `packages/client-runtime/src/state/models.ts` (P3), `ProjectionStore.ts` (P3),
`ShellStream.test.ts` / `ProviderSwitch.integration.test.ts` / `entities.test.ts` (P3),
`managedProvider.ts` / `provider-core/.../usageLimits.ts` (P2),
`apps/server/src/provider/providerStatusCache.ts` (+ test) and `claudeUsageLimits.ts` (+ test)
(P2), `ChatHeader.tsx` (P4), `SettingsSidebarNav.tsx` (P4), `SettingsScopeSentence.tsx` (P4),
`SettingsPanels.restore.test.tsx` (P4 adds cases; P5 only runs it),
`ScheduledTasksSettings.tsx` (P4), `routeTree.gen.ts` (P4),
`Sidebar.tsx` (P5), `ChatComposer.tsx` (P5), `ContextWindowMeter.tsx` (P5),
`apps/desktop/src/settings/DesktopClientSettings.test.ts` (P5; P4's keys need no change
there because the fixture spreads `DEFAULT_CLIENT_SETTINGS`). The spec file is edited only
by the coherence agent.

---

## 8. Shared test fixtures and harnesses

| Fixture / harness                                                                                                                                                        | Built by      | Reused by |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------- |
| Local-time helpers in `usagePacing.test.ts` (`localSec(y, m, d, h, min)`, per-test `process.env.TZ` scoping), ported from the statusline tests; test-local, not exported | P1            | P1 only   |
| Real `rate_limit_info` payload with `unifiedWindows` and no top-level `utilization` (the log line quoted in §1 P2), as a fixture in `claudeUsageLimits.test.ts`          | P2            | P2 only   |
| `managedProvider.test.ts` / `usageLimits.test.ts` existing harnesses                                                                                                     | existing      | P2        |
| `ClaudeAdapterV2.test.ts`, `ProjectionStore.test.ts`, `ShellStream.test.ts`, `ProviderTurnTokenUsage.test.ts`, `apps/server/src/orchestration-v2/testkit/`               | existing      | P3        |
| `packages/client-runtime/src/state/orchestrationV2TestFixtures.ts` (shell fixtures; the new field is optional so it needs no change)                                     | existing      | P3, P5    |
| Web logic-test builders (`makeUsageWindow`, `makeTokenUsage`): each plan writes its own inline in its `*.logic.test.ts`; no shared builder                               | P4, P5        | —         |
| Playwright harness `/tmp/t3-snap` (Chrome, persistent profile with dev cookie); P6's driver scripts live in the session scratchpad, not the repo                         | existing / P6 | P6        |
| DOM hooks (§6.6)                                                                                                                                                         | P4, P5        | P6        |

Per-plan verification is hermetic plus targeted typecheck and lint, per AGENTS.md
("Subagents do not launch their own dev servers"). The end-to-end pass for the integrated
feature is P6's, once.

---

## 9. Contract-level open questions and spec deviations

Each item: what, recommendation (followed provisionally by every plan), and whether it
changes user-visible behaviour. "C" items are clearly-correct, small fixes the coherence
agent may apply to the spec; "D" items change user-visible behaviour and go to Decisions
needed.

Coherence status: C1-C7 were applied to the spec (marked per item); D1-D6 change
user-visible behaviour and are in "Decisions needed" at the end, not applied.

**C1. Session window length.** (Applied to spec §4.2.) Spec §4.2 fixes the session window at 18000 s. The session
producers set `windowDurationMins` (Claude 300; OpenCode 300; Codex from its payload,
defaulting to 300). Recommendation:
`windowSec = windowDurationMins * 60`, falling back to 18000 for sessions (and 604800 for
the rest, as spec §4.2 already says for weekly). Identical for Claude.

**C2. History heartbeat coalescing.** (Applied to spec §5.2.) Spec §5.2 appends a sample "on every usage update,
even if the value didn't change". Codex's `account/rateLimits/updated` arrives beside every
token-usage tick, and `applyUsageLimitsUpdate` deliberately avoids publishing for it
(`usageLimits.ts` comment, line ~70); appending there would publish a growing snapshot over
the websocket per tick (AGENTS.md performance rule). Recommendation: §6.2 rule 4 (skip an
unchanged sample within 60 s of the previous one). Probes (minutes apart) still act as idle
heartbeats, which is the spec's intent.

**C3. Expiring boundary.** (Applied to spec §4.5.) Spec §4.5 says "expiring when the time remaining is less than
`min(600 s, ttl / 4)`"; the statusline code and its test "expiring exactly at the warn edge"
use `<=`. Recommendation: port `<=`; spec wording becomes "at most".

**C4. Model identity vocabulary.** (Applied to spec §5.3, including P3's suffix strip.) Spec §5.3 says the identity's model is "`message.model`".
The code field is `message.message.model`, an API model id, while the "next" side is
`ModelSelection.model`, a catalog slug or alias. Recommendation: §6.3 (resolve through
`resolveClaudeModelSlug`), so a warm thread is not reported cold on vocabulary alone.

**C5. Effort and fast mode are raw selection values.** (Applied to spec §4.5.) Switching between an implicit
default effort and the same value chosen explicitly reads as a mismatch (cold). This
understates warmth, the safe direction the statusline also accepts. Recommendation: accept
and document in the spec.

**C6. Muted colour variable.** (Applied to spec §3.3.) Spec §3.3 writes `var(--muted-foreground)`; Tailwind's
`text-muted-foreground` resolves to `--color-muted-foreground` (=
`--contrast-muted-foreground`, honouring the contrast setting). Recommendation: use the
`--color-*` tokens (§6.4). Identical at default contrast.

**C7. Spec citations to correct.** (Applied to spec §3.1, §3.4, §5.1, §5.2.) §3.4 "reusing the scheduled-tasks weekday picker": the
picker is inline in `ScheduledTasksSettings.tsx`, so P4 extracts it (§6.5). §5.2
"`ManagedServerProvider` keeps": `ManagedServerProvider` is the interface
(`provider-core/src/server/snapshot.ts`); the state lives in `makeManagedServerProvider`
(`managedProvider.ts`). §5.1: `unifiedWindows` utilization is a 0-1 fraction and `resetsAt`
epoch seconds, and allowed-status events carry no top-level `utilization` (so the bug is
larger than described: most events update nothing today). §3.1 "container query on the
header": the controls cluster can render outside the header (§1 P4).

**D1. Monthly and other windows.** Spec §3.4 has toggles for session, weekly and
model-scoped windows only; Cursor, OpenCode and Grok also report `monthly` / `other`
windows (Cursor reports three). Recommendation: role `other` never gets a header row and
always appears in the popover (no `hidden` tag). Untested beyond Claude either way.

**D2. Cache state after a compaction.** The compaction report (`ClaudeAdapterV2.ts`
line ~6795) becomes the newest token usage. Carrying the TTL forward onto it would show a
warm dot on a cache the compaction just invalidated. Recommendation: no carry-forward and
no identity on that report, so the state reads `unknown` (ring only, cache clause omitted
from the tooltip) until the next assistant usage report.

**D3. The composer-ring default does not reach existing installs.** Client settings persist
as a full object, so every install that ever saved settings has
`contextWindowMeterEnabled: false` stored and keeps the ring off; spec §9.3's "on by
default" would only reach fresh installs, not the user's own T3. Recommendation: replace
the key with a fresh one, `composerContextRingEnabled` (default true), following the repo's
own precedent (`legacySidebarEnabled` replaced `sidebarV2Enabled` so decoding dropped the
old value, `settings.ts` line ~466). Alternative: keep `contextWindowMeterEnabled` per the
spec text and have the user flip it once.

**D4. Where the composer-ring toggle goes.** Spec §3.4 moves it "out of the legacy group"
without naming a destination. Recommendation: the bottom of the Usage pacing section (§6.5),
labelled "Show context ring in composer", search id `usage-pacing-context-ring`.

**D5. Clock format.** Spec examples are 12-hour (`2:40pm`, `Thu 9am`). The app has a
`timestampFormat` client setting (`locale` / `12-hour` / `24-hour`). Recommendation: P1's
formatters take it and P4/P5 pass `settings.timestampFormat`, so 24-hour users see
`14:40` / `Thu 09:00`; on the default `locale` an en-US browser shows the spec's examples.

**D6. Bar fill colour while the burn is blank.** Spec §3.1 colours the fill by the burn,
which may be unknown (§6 "Burn column blank"). Recommendation: fill uses `muted` while
`burnTier` is null. P4 owns the choice.

---

## 10. Spec coverage matrix

Every spec requirement has exactly one owning plan: the plan whose code or run makes it true.
Where another plan supplies a helper or data, it is named under "Uses"; that is a dependency,
not shared ownership. Written by the coherence pass against the spec as amended by it.

| Spec            | Requirement                                                                                                                                 | Owner | Uses                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| §2 J1           | Pace the 5 h session from the header widget                                                                                                 | P4    | P1, P2                                                              |
| §2 J2           | Pace the week against work hours from the same widget                                                                                       | P4    | P1                                                                  |
| §2 J3           | Cache dot on every sidebar row and in the composer                                                                                          | P5    | P1, P3                                                              |
| §2 J4           | Context ring (same glyph)                                                                                                                   | P5    | P1, P3                                                              |
| §2 out of scope | No overage / extra-cost tracking (the overage-included window stays a plain scoped window)                                                  | P2    | —                                                                   |
| §2 out of scope | No warnings in the model picker (no picker changes)                                                                                         | P4    | —                                                                   |
| §2 out of scope | Mobile app untouched; maths stays framework-free for later reuse                                                                            | P1    | P3 (mobile only receives the optional shell field)                  |
| §3.1            | Placement left of the panel-layout controls; breadcrumb truncates instead of overlapping                                                    | P4    | —                                                                   |
| §3.1            | Row order session, weekly, model-scoped                                                                                                     | P4    | P1 `orderPaceWindows`                                               |
| §3.1            | Label `5h` / `7d` / scoped display name                                                                                                     | P4    | P1 `paceWindowShortLabel`                                           |
| §3.1            | Bar 76 x 3 px, fill = usedPercent in burn colour, 1.5 px foreground tick at pace position                                                   | P4    | P1 `computeWindowPace`                                              |
| §3.1            | Burn `1.2x` in burn colour, fixed-width right-aligned column                                                                                | P4    | P1 `formatBurn`                                                     |
| §3.1            | Reset time (clock time for windows <= 1 day, weekday + hour otherwise), never run-out time                                                  | P4    | P1 `formatResetLabel`                                               |
| §3.1            | 11 px text; row gap 5 px for 1-2 rows, 1 px for 3                                                                                           | P4    | —                                                                   |
| §3.1            | Row only if window exists and its toggle is on; widget renders nothing without rows / `unavailable`; blank burn keeps bar and reset         | P4    | —                                                                   |
| §3.1            | Below 560 px drop reset column, below 420 px hide; measured on the header                                                                   | P4    | —                                                                   |
| §3.1            | Hover opens, click pins, outside click / Escape closes                                                                                      | P4    | —                                                                   |
| §3.2            | Popover 280 px; one section per reported window incl. toggled-off ones at 55 % with `hidden` tag                                            | P4    | —                                                                   |
| §3.2            | Section lines: title + `62%` + burn; 4 px bar with tick; reset clock + countdown                                                            | P4    | P1 `paceWindowTitle`, `formatCountdown`                             |
| §3.2            | Footer `Usage details →` to `/usage`, `Settings` to the Usage pacing section; no prose                                                      | P4    | —                                                                   |
| §3.3            | One SVG glyph; 14 px in every sidebar row before the timestamp; 18 px replacing the meter ring, meter popover kept                          | P5    | —                                                                   |
| §3.3            | Ring geometry: stroke 1.6 / 2 px, round caps, 25 % track, arc from 12 o'clock clockwise, tier colour                                        | P5    | P1 `contextFraction`, `CONTEXT_TIER_COLORS`; P4 `PACE_TIER_CLASSES` |
| §3.3            | Dot radius 15 %, colour-mix fill; warm grey, expiring warning, cold/unknown none                                                            | P5    | P1 `cacheWarmth`                                                    |
| §3.3            | No token usage: no glyph; unknown cache: ring only                                                                                          | P5    | P3                                                                  |
| §3.3            | Tooltip string `Context 380k / 1M (38%) · Cache ...`                                                                                        | P1    | —                                                                   |
| §3.3            | Tooltip shown in sidebar and composer                                                                                                       | P5    | P1 `formatThreadContextTooltip`                                     |
| §3.3            | Composer reads live usage; sidebar reads the shell summary                                                                                  | P5    | P3 `latestTokenUsage`                                               |
| §3.4            | Usage pacing settings section, per-device client settings, each registered in `settingsSearch.ts`                                           | P4    | —                                                                   |
| §3.4            | Six settings (three switches, work hours, work days, off-hours weight) with their defaults                                                  | P4    | P1 `DEFAULT_*`, `parseWorkHours`                                    |
| §3.4            | Composer ring toggle leaves "legacy", relabelled "Show context ring in composer", default on; no sidebar toggle                             | P5    | P4-foundation section                                               |
| §3.4            | Every other statusline knob is a fixed constant                                                                                             | P1    | —                                                                   |
| §4              | Pure functions in `packages/shared/src/usagePacing.ts`, ported with tests                                                                   | P1    | —                                                                   |
| §4              | Shared 30 s client tick                                                                                                                     | P4    | —                                                                   |
| §4.1            | `roundBurn`, `burnTier`, tier on the rounded value                                                                                          | P1    | —                                                                   |
| §4.1            | Tier palette names (green/yellow-400/orange-500/red; ring tier 0 muted)                                                                     | P1    | —                                                                   |
| §4.1            | Palette as Tailwind classes                                                                                                                 | P4    | —                                                                   |
| §4.2            | Session EWMA: constants, window length, input, interval walk, rate, fallback, burn, dynamic cutoffs                                         | P1    | P2 `history`                                                        |
| §4.2            | Weekly burn: `roundBurn(used/frac)`, none while `frac < 0.02`, duration fallback 10080                                                      | P1    | —                                                                   |
| §4.2            | `scheduleWeight` local-day walk (DST), work-hour / off-hour / non-work-day weights, configurable work days                                  | P1    | —                                                                   |
| §4.2            | Monthly / other kinds use the wall-clock fraction                                                                                           | P1    | —                                                                   |
| §4.3            | Tick = wall-clock fraction (session) / schedule-weighted `frac` (weekly)                                                                    | P1    | —                                                                   |
| §4.4            | Context tier: max of % (50/65/80) and tokens (200k/300k/400k); token tier only without `maxTokens`                                          | P1    | —                                                                   |
| §4.5            | Warmth states unknown / cold / expiring (`<= min(600 s, ttl/4)`) / warm; identity compare with absent fields skipped; raw values            | P1    | —                                                                   |
| §4.5            | Inputs: latest top-level report's `updatedAt`, TTL, identity                                                                                | P3    | —                                                                   |
| §4.5            | "Next" identity = composer selection (composer), thread `modelSelection` (sidebar)                                                          | P5    | P1 `requestIdentityFromModelSelection`                              |
| §5.1            | `unifiedWindows` read on every event, single-window fallback                                                                                | P2    | —                                                                   |
| §5.1            | Test: `rateLimitType: "seven_day"` + `unifiedWindows` updates both windows                                                                  | P2    | —                                                                   |
| §5.2            | In-memory per-instance session sample list, heartbeat coalescing                                                                            | P2    | —                                                                   |
| §5.2            | Pruning on reset (60 s tolerance), credential / workspace change, 400 cap                                                                   | P2    | —                                                                   |
| §5.2            | Transport as optional `history` on session windows                                                                                          | P2    | —                                                                   |
| §5.2            | No persistence; linear fallback after restart                                                                                               | P2    | P1 (fallback maths)                                                 |
| §5.2            | Nothing from the envelope / pool-swap machinery                                                                                             | P2    | —                                                                   |
| §5.3            | `requestIdentity` contract field and Claude top-level fill                                                                                  | P3    | —                                                                   |
| §5.3            | TTL carry-forward per provider thread                                                                                                       | P3    | —                                                                   |
| §5.3            | `latestTokenUsage` on the shell from persisted rows, live, `goal` pattern                                                                   | P3    | —                                                                   |
| §5.3            | Regression test: `task_progress` / `task_notification` usage never changes `tokenUsage`                                                     | P3    | —                                                                   |
| §5.4            | `PacingWidget` / `PacingPopover` mounted from `ChatView`                                                                                    | P4    | —                                                                   |
| §5.4            | Shared `ThreadContextGlyph` in `SidebarThreadRow` and `ContextWindowMeter`                                                                  | P5    | —                                                                   |
| §5.4            | Usage pacing settings section                                                                                                               | P4    | —                                                                   |
| §5.4            | `useNowTick(30_000)`, one interval shared by all consumers                                                                                  | P4    | —                                                                   |
| §6              | No `usageLimits` or `unavailable`: widget hidden                                                                                            | P4    | —                                                                   |
| §6              | Window lacks `resetsAt`: bar only                                                                                                           | P4    | P1                                                                  |
| §6              | Session burn not computable: blank                                                                                                          | P4    | P1                                                                  |
| §6              | Weekly `frac < 0.02`: blank                                                                                                                 | P4    | P1                                                                  |
| §6              | No token usage: no glyph                                                                                                                    | P5    | —                                                                   |
| §6              | No TTL ever observed: ring, no dot                                                                                                          | P5    | P1, P3                                                              |
| §6              | `maxTokens` missing: track only, token-tier colour                                                                                          | P5    | P1                                                                  |
| §7 hermetic     | Ported statusline suites (burn-tier, burn-rate, weekly-burn incl. DST and wrap, cache-warmth); work days; 50/65/80 tiers; time-based expiry | P1    | —                                                                   |
| §7 hermetic     | `unifiedWindows` mapping; history recording / pruning / reset                                                                               | P2    | —                                                                   |
| §7 hermetic     | `requestIdentity` and TTL carry-forward in `ClaudeAdapterV2.test.ts`; task-progress regression; `latestTokenUsage` live and historical      | P3    | —                                                                   |
| §7 hermetic     | Web logic: row visibility from toggles; narrow-header breakpoints                                                                           | P4    | —                                                                   |
| §7 hermetic     | Web logic: tooltip text                                                                                                                     | P5    | P1                                                                  |
| §7 e2e 1-6      | Real-instance run with screenshots (items 1-6 as amended)                                                                                   | P6    | P1-P5 DOM hooks (§6.6)                                              |
| §8              | Fork CLI build and the user's switch runbook                                                                                                | P6    | —                                                                   |
| §9.1            | Narrow headers degrade by dropping / hiding                                                                                                 | P4    | —                                                                   |
| §9.2            | History in memory only                                                                                                                      | P2    | —                                                                   |
| §9.3            | Composer ring on by default, sidebar glyph always on                                                                                        | P5    | —                                                                   |
| §9.4            | Non-Claude threads show their provider's windows with the same logic                                                                        | P4    | P1                                                                  |

No gaps and no double ownership remain. Testing coverage: every §7 hermetic item has a test
task in its owner's plan, and P6 Tasks 2-7 cover items 1-6 (Task 8 adds the breakpoint
sweep); P1-P5 each state that end-to-end is deferred to P6 because AGENTS.md bars subagents
from launching dev servers.

---

## Decisions needed

Consolidated by the coherence pass from index §9 and every plan's "Open questions / spec
deviations". Each plan already follows the recommendation provisionally. "Spec: applied"
means the coherence pass edited the spec to match; "Spec: not applied" means the item changes
user-visible behaviour and waits for the user.

1. **Monthly and "other" windows in the header.** Context: spec §3.4 has header toggles only
   for session, weekly and model-scoped windows, but Cursor, OpenCode and Grok also report
   `monthly` / `other` windows (Cursor reports three). Options: (a) never a header row, always
   in the popover with no `hidden` tag; (b) add a fourth toggle; (c) treat them as weekly.
   Recommendation: (a). Affects P4 (and P1 `paceWindowRole`). Spec: not applied.
2. **Cache dot after a compaction and after a server restart.** Context: the compaction report
   becomes the newest token usage; carrying the TTL onto it would show a warm dot on a cache the
   compaction just invalidated. The adapter remembers the last TTL per provider thread in memory
   only. Options: (a) compaction report carries no TTL and no identity (state `unknown`, ring
   without dot until the next assistant report); the remembered TTL survives compactions; after
   a server restart the dot is missing until a response writes cache; (b) seed the TTL from
   persisted rows on session open (needs a projection read the adapter lacks); (c) fall back to
   an older report's TTL in the projection (would also warm the compaction report).
   Recommendation: (a). Affects P3, P5. Spec: not applied.
3. **Composer ring toggle: storage key, default and location.** Context: client settings
   persist as one full object, so every install that ever saved settings has
   `contextWindowMeterEnabled: false` stored; flipping the default would not reach the user's
   own T3. Spec §3.4 also names no destination for the toggle. Options: (a) new key
   `composerContextRingEnabled` (default on; the stored old value is dropped on decode, repo
   precedent `legacySidebarEnabled`), row "Show context ring in composer" as the last row of
   the Usage pacing section, search id `usage-pacing-context-ring`; (b) keep the old key and
   have the user flip it once. Recommendation: (a). Affects P5 (P4 hosts the section). Spec:
   not applied.
4. **Clock format of reset and expiry times.** Context: spec examples are 12-hour (`2:40pm`,
   `Thu 9am`); the app has a `timestampFormat` setting (`locale` / `12-hour` / `24-hour`).
   Options: (a) follow the setting; `locale` resolves to 12- or 24-hour from the browser's hour
   cycle (on Electron that can differ from other timestamps, which use the OS locale); (b)
   always 12-hour. Recommendation: (a). Affects P1, P4, P5. Spec: not applied.
5. **Bar fill colour while the burn is blank.** Context: §3.1 colours the fill by the burn,
   which can be unknown. Options: (a) muted grey until a burn exists; (b) green. Recommendation:
   (a). Affects P4. Spec: not applied.
6. **Glyph when `maxTokens` is missing.** Context: spec §6 says "track only, no arc; colour by
   the token tier", which is self-contradictory. Options: (a) tint the 25 %-opacity track with
   the token-tier colour; (b) full-opacity ring in the tier colour above tier 0; (c) neutral
   track. Recommendation: (a). Affects P5. Spec: not applied.
7. **Where the sidebar tooltip appears.** Context: the sidebar glyph sits in the row's status
   slot, which is `pointer-events-none` and fades out under row hover, so a tooltip on the glyph
   is unreachable. Options: (a) a line (glyph + the spec string) in the row's existing hover
   card; (b) move the glyph out of the fading slot and nest a second tooltip. Recommendation:
   (a). Affects P5 (P6 checks it). Spec: not applied.
8. **Which sidebar rows carry the glyph.** Context: busy card rows show Working / Approval /
   Input / Failed / Done / Woke instead of the timestamp; search results use a fixed `w-8`
   column; drafts have no usage. Options: (a) glyph first in the status slot in both states,
   none in search-result or draft rows (search results still get the hover-card line); (b)
   glyph only where the timestamp shows. Recommendation: (a). Affects P5. Spec: not applied.
9. **Composer popover changes.** Context: spec §3.3 keeps the meter popover as is, but it is
   the composer's only visible hover surface. Options: (a) add one cache line (e.g.
   `Cache warm, expires 3:12pm`) and colour its progress bar by the §4.4 tier (replacing
   red-above-90 %), keeping its existing token formatter (`380k / 1m`, lowercase, while the new
   tooltip strings use `1M`); (b) leave the popover untouched; (c) as (a) and also switch the
   popover to the shared `formatTokenCount`. Recommendation: (a). Affects P5 (P1 formatter).
   Spec: not applied.
10. **Composer shows no dot when its snapshot comes from a fallback source.** Context: the
    composer's TTL and identity come only from the live provider-turn report; when the context
    snapshot comes from `providerThread.contextUsage` or a compaction item there is none, so the
    composer can show a ring without a dot while the sidebar shows one. Options: accept; or also
    read the shell's `latestTokenUsage` in the composer. Recommendation: accept (the live report
    wins whenever it exists). Affects P5. Spec: not applied.
11. **Widget placement with the right panel open.** Context: with the inline right panel open,
    the fixed top-right cluster sits over the panel's tab bar. Options: (a) beside the
    thread-details toggle in the header when the inline panel is open, in the cluster otherwise,
    hidden while the sheet is open or the panel is closing; (b) always in the cluster
    (covers the tabs); (c) hide whenever a right panel is open. Recommendation: (a); needs P6
    screenshots with the panel open. Affects P4. Spec: not applied.
12. **More than three qualifying windows.** Context: three rows fit the 52 px header; four do
    not. Options: (a) cap at three (session, weekly, first scoped by id), the popover lists all
    (a fourth window is then neither in the header nor tagged `hidden`); (b) shrink the font;
    (c) let the header grow. Recommendation: (a); unreachable for Claude today. Affects P4. Spec:
    not applied.
13. **Windows past their reset.** Context: between a reset and the next probe or event the
    snapshot still holds the old window. Options: (a) show as is, burn and tick blank,
    countdown `now`; (b) show 0 %; (c) drop the row. Recommendation: (a). Affects P4 (P1 returns
    null outside the window). Spec: not applied.
14. **Countdown in the last minute.** Context: `formatDuration` floors, so 59 s reads `in 0m`.
    Options: `in 0m`; `in <1m`. Recommendation: `in <1m`. Affects P1, P4. Spec: not applied.
15. **Settings input details.** Context: the extracted weekday picker refuses to deselect the
    last day (zero work days would blank the weekly burn); `<input type="time">` cannot hold
    `24:00`; native time inputs render in the browser's style, not `timestampFormat`; spec says
    "step 0.05" for the weight. Options: as described, or allow an empty work-day set / a typed
    `24:00`. Recommendation: keep the last day; show an end of `24:00` as `00:00` and store
    `00:00` back as `24:00`; accept the native time style; snap a typed weight to the nearest
    0.05. Affects P4. Spec: not applied.
16. **Sidebar glyph after a provider switch.** Context: only the active provider thread counts,
    so right after a switch `latestTokenUsage` is null until the new provider's first usage
    report. Options: accept the brief absence; or show the previous provider's last usage.
    Recommendation: accept (the old context size is wrong for the new provider). Affects P3, P5.
    Spec: not applied.
17. **Wire traffic the feature adds.** Context: each Claude top-level assistant message now
    sends one shell update (about 1-2 KB, coalesced per 50 ms per thread) that was previously
    dropped as unchanged; a full session history adds about 22 KB to each `providerStatuses`
    push (at most one heartbeat publish per minute during a turn). Options: accept; quantise
    shell pushes; cap history lower or send deltas. Recommendation: accept and watch in P6.
    Affects P2, P3. Spec: not applied (no behaviour change).
18. **Deviations from a verbatim statusline port.** Context: P1 removes the statusline's
    "no samples -> null" (an upstream or restarted server sends no history, and the spec wants
    the linear fallback), drops the `t <= now` sample filter (client clock behind a remote
    server), treats a `windowDurationMins` of 0 as unknown, caps window length at 400 days,
    labels sub-hour windows `45m`, titles a duration-less session by its label, normalises a
    work-hours end of `00:00` to `24:00` and rejects a start of `24:00`, and skips the foreign-
    window / envelope tests. Options: accept; or port literally and handle the cases in P4.
    Recommendation: accept. Affects P1. Spec: applied (§4.2 now states the window length and the
    empty-history fallback); the rest is below spec level.
19. **Context tier on 1M windows.** Context: the ring takes the more severe of the % and token
    tiers, so on a 1M window 200k tokens is already yellow and 400k red, whatever the
    percentage. Options: keep the spec as written; or use the token tier only without
    `maxTokens`. Recommendation: keep the spec. Affects P1, P5. Spec: unchanged (already says
    this).
20. **Server-side usage details beyond the contract.** Context: probe and event reset times
    differ by sub-second amounts; event utilization has float noise (`0.58 * 100`); the
    provider registry writes every snapshot to `caches/<instanceId>.json`; an `unsupported`
    probe has no rule; the heartbeat gate also applies to two probes within 60 s; the
    credential fingerprint is only compared between two probes (runtime updates drop it; only
    Antigravity and OpenCode publish one and neither sends runtime updates). Options: as
    implemented, or exact reset equality / raw percentages / persisting history.
    Recommendation: 60 s reset tolerance, round to two decimals in the mapper, strip `history`
    from the cache file, clear history on `unsupported`, accept the probe and fingerprint
    limits; a session window that never reports a reset keeps one list until a reset appears. Affects P2. Spec: applied (§5.2 reset tolerance and heartbeat rule); index §6.2
    updated.
21. **Claude model identity vocabulary.** Context: the response names an API id
    (`claude-haiku-4-5-20251001`, sometimes with `[1m]`); the client compares against
    `ModelSelection.model`, a catalog slug. Options: (a) strip a trailing `[...]` (same regex as
    P1) then resolve through the catalog; (b) resolve without stripping (a suffixed dated id
    would read cold). Recommendation: (a). Affects P3 (P1). Spec: applied (§5.3); index §6.3
    updated.
22. **Regression test scope.** Context: the 0.0.45 "1m/1m" cause cannot be reproduced on the
    nightly code, so the test pins the property (task frames never change `tokenUsage`) and P6
    item 4 checks the real CLI. Recommendation: as written. Affects P3, P6. Spec: applied
    (§5.3 wording).
23. **Small P3 robustness choices.** Context: a stored `tokenUsage` this build cannot decode
    would fail the whole shell snapshot; `threadShellFromProjection` (in-memory builder) must
    match the SQL path but would be wrong for a windowed projection. Recommendation: read an
    undecodable row as "no usage"; never build client shells from a bounded projection.
    Affects P3. Spec: not needed.
24. **Fork version scheme.** Context: the fork build needs a new version directory and decides
    which channel a plain `t3 update` follows. Options: (a) nightly-shaped
    `0.0.46-nightly.20261011.902980`: plain `t3 update` leaves the fork as soon as a newer
    official nightly exists; (b) custom prerelease `0.0.46-usagepacing.1`: sticky (plain
    `t3 update` refuses until 0.0.46 stable), but returning to the nightly needs
    `--allow-downgrade`. Recommendation: (a). Affects P6. Spec: not applied.
25. **T3 Connect in the fork build.** Context: the user's install is linked to T3 Connect;
    release builds embed the relay URL and Clerk public keys at build time. Options: (a) embed
    upstream's public values extracted from the official base archive, omit upstream's
    telemetry token; (b) build without them (no relay or sign-in). Recommendation: (a), if the
    user accepts a fork build talking to upstream's relay (the relay their install uses today).
    Affects P6. Spec: not applied.
26. **Moving to the nightly before the fork.** Context: `t3 update --channel nightly` installs
    the newest nightly, which may carry DB migrations the fork lacks, making the fork a
    downgrade over a newer schema. Options: (a) install the exact base nightly
    `0.0.46-nightly.20261011.2980` first; (b) the latest nightly, then rebase and rebuild the
    fork on it. Recommendation: (a); if the user already moved to a newer nightly, do (b).
    Affects P6. Spec: not applied.
27. **P6 run environment.** Context: the index asked for the worktree's `.t3` and a bare
    `bin.ts pair`; the worktree `.t3` holds a project rooted in the repo, another session's dev
    server may own it, item 5 must restart a server P6 owns, CLI calls without `--base-dir` fall
    back to `~/.t3`, the release version bump would dirty the integration worktree, and child
    branches are deleted before P6 runs. Recommendation (all followed): fresh scratch home via
    `--home-dir`, `--base-dir` on every CLI call, a detached build worktree
    `usage-pacing-build`, and a `feat/usage-pacing-<id>-fix` branch for P6-found fixes.
    Affects P6 (orchestrator for fixes). Spec: not needed; index §1, §5 updated.
28. **End-to-end item wording.** Context: header rows show no percentage (only the popover
    does), and the linear fallback yields a session burn whenever 30 min of the window have
    elapsed, so "after enough samples the burn appears" and "returns to the linear fallback"
    hold only in some window positions. Recommendation: compare popover percentages; assert the
    burn against P1's maths over the history (item 2) and the linear fallback or blank in the
    first 30 min (item 5). Affects P6. Spec: applied (§7 items 1, 2, 5).
29. **Header breakpoint mechanism.** Context: the controls cluster is `position: fixed` and is
    sometimes rendered outside the header, so a CSS container query on the header cannot drive
    it. Recommendation: measure the header's border box with `observeResize`; same 560 / 420 px
    behaviour. Affects P4. Spec: applied (§3.1).
30. **Spec citations and small semantic fixes (index C1-C7).** Context: session window length
    from `windowDurationMins`; heartbeat coalescing; `<=` at the expiring edge; raw effort /
    fast-mode values; `--color-*` tokens; the weekday picker is extracted; `makeManagedServerProvider`
    holds the state; `unifiedWindows` semantics. Recommendation: as in §9. Affects P1, P2, P3,
    P4, P5. Spec: applied.
31. **Contract additions made during planning.** Context: plans added files and exports the
    index did not list: P2 edits `providerStatusCache.ts`; P4 adds `PacingBar.tsx`,
    `usagePacingSettings.logic.ts`, the `--pacing-widget-reserve` variable and
    `SettingsScopeSentence.tsx`; P5 exports `useThreadContextGlyphModel`,
    `ThreadContextGlyphBadge`, `ThreadContextTooltipLine` and the local `glyphCacheClause`
    (no P1 cache-clause formatter); P5 threads `activeThreadLiveTokenUsage` from `ChatView`
    through `ChatComposer`. Recommendation: accept; all stay inside their owner's files and
    are now recorded in §6 / §7. Affects P2, P4, P5. Spec: not needed.
