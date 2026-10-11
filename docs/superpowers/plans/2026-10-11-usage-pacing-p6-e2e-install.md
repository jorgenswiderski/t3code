# Usage pacing P6: end-to-end validation and fork install runbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this plan task by task. It is a runbook: there is no feature code, no hermetic test and no commit. Steps use checkbox (`- [ ]`) syntax for tracking. Run the tasks in order; each one assumes the state the previous one left.

**Goal:** Prove the merged usage-pacing feature works in a real T3 dev instance (spec §7 items 1-6) with screenshot evidence, then build the fork's `t3` CLI archive, rehearse its install against a throwaway T3 home, and hand the user a runbook that switches their daily T3 to the fork build and back.

**Architecture:** Part 1 runs the integration worktree's own dev server against a fresh, isolated T3 home in the session scratchpad, drives it with Playwright + headless Chrome from `/tmp/t3-snap`, and checks every UI reading against an independent source: the provider event log, the `/usage` page, the server-config WebSocket frames, and P1's own maths run in Node. Part 2 builds the release archive exactly as `.github/workflows/release-desktop.yml` does, serves it from a local mirror that `t3 update` already supports (`T3CODE_RELEASE_BASE_URL`), and rehearses the user's exact command against a throwaway `--base-dir`.

**Tech Stack:** Node 24 (repo scripts, type-stripped `.ts`), `vp` from `node_modules/.bin`, Playwright 1.64 at `/tmp/t3-snap`, `/usr/bin/google-chrome`, `python3 -m http.server` (local mirror), `tar`, `sha256sum`, `systemctl --user` (read-only queries).

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` (§7 end-to-end items 1-6, §8). Contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` (§1 P6, §4, §5, §6.6, §8).

## Implementation Location

- **Branch:** `feat/usage-pacing`
- **Worktree:** `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing`
- **Base branch:** n/a

P6 has no branch, no PR and no commit (index §5). Part 2 additionally creates a throwaway **detached** worktree at `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build` (no branch) so the release version bump never dirties the integration worktree (see Open questions item 3). Fixes for failures P6 finds are not made by P6 (see "Failure policy").

## Testing Strategy

- **End-to-end (this plan, once, on the fully merged `feat/usage-pacing`):** spec §7 items 1-6 in a real dev instance with real Claude turns, plus one extra check of the narrow-header breakpoints (spec §3.1 / §9.1). Part 2 smoke-tests the built archive twice: `scripts/smoke-cli-archive.ts` (`--version` + `serve` answers 200 from an extracted tree with an empty `PATH`), and a rehearsal of the user's real install command (`t3 update <fork version>`) against a throwaway `--base-dir`, followed by serving the installed runtime and loading its UI.
- **Hermetic:** none added here. All hermetic coverage lives in P1-P5 (their `vp test run` targets). P6 reuses P1's exported functions in Node only to compute expected values for the UI.
- **Skipped end-to-end, and why:**
  - Time-based cache expiry and the `expiring` state at the 5 min / 1 h edges: the spec (§7, last paragraph) assigns them to hermetic tests; waiting them out costs an hour per run.
  - Non-Claude providers, the mobile app, the Electron desktop shell, and remote/relay connection modes: out of scope (spec §1, §2) or no autonomous headless path (Electron needs a display; relay needs the user's T3 Connect account).
  - The user's actual switch to the fork build: the user runs it (binding decision); agents only rehearse it against a throwaway home.

## Global Constraints

Every task implicitly includes these. Values copied from the spec, the index and AGENTS.md.

- Run against "this worktree's dev server (`vp run dev`, isolated `.t3` state), driven by Playwright in headless Chrome as approved, with screenshots saved for the handoff" (spec §7).
- `vp` is not on PATH: always `PATH="<worktree>/node_modules/.bin:$PATH"`.
- The user's shell wraps `cd` through fnm and returns 127: use `builtin cd <dir>;` and `;`, never `cd ... &&`. Every Bash call starts from a reset cwd, so use absolute paths and re-`source` the env file (Task 0).
- Kill only a PID (or the process group of a PID) you captured at spawn. Never `pkill`, `pgrep | kill`, or a PID found by name (AGENTS.md rule 1).
- Never start a server against, open read-write, or clean up `~/.t3/userdata`. Reading and copying from it is allowed (AGENTS.md rule 2). Never restart, stop or reconfigure `t3code.service`, never touch `~/.local/bin/t3` or `~/.t3/runtime/service-state.json`.
- Never set `VITE_HTTP_URL` or `VITE_WS_URL` (AGENTS.md rule 3).
- Every `node apps/server/src/bin.ts ...` CLI call passes `--base-dir "$DEV_HOME"` explicitly. Without it the CLI falls back to `T3CODE_HOME` or `~/.t3` (`resolveBaseDir`, `apps/server/src/os-jank.ts:105`) and would act on the live install.
- Do not run `vp run migrate-dev-db`: the live `~/.t3/userdata` holds only the V1 `state.sqlite`, so it cannot seed. The dev DB starts empty and this plan creates the project and threads.
- Claude is the only provider used. Codex is not installed in the dev instance.
- Real Claude turns allowed: a few short turns plus one subagent turn (item 4). Budget for this plan: at most 6 short turns and 1 subagent turn per full run.
- Strip launcher context from every spawned `t3`/server process: `env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT -u T3CODE_HOME ...`. If this session itself runs under the T3 service those leak in and a server refuses to start ("The service launcher started a different t3 version", `scripts/dev-runner.ts` ~line 333).
- No repo-wide checks, no commits, no pushes. Scratch files go in the session scratchpad (`$P6`), never in the repo.
- Playwright replaces the repo's `test-t3-app` Browser-panel workflow for this run only (user approval; the panel is unavailable headless).

## Review Focus

The five failure modes most likely to bite a person following this plan, each pinned by a check in the owning task:

1. **The user runs the install command from a terminal hosted by T3 itself.** `t3 update` stops the service mid-run, which kills that terminal and the update with it. Runbook step R0 makes the user confirm the terminal is outside T3 (`systemd-cgls`/cgroup check). Task 12 asserts the rehearsal never touched the service.
2. **The fork's version collides with or sorts below what is installed.** A reused version is treated as "already on disk" and silently keeps the old build; a lower version needs `--allow-downgrade` and may sit on a newer DB schema. Task 10 derives the version and checks `~/.t3/runtime/versions/` for collisions; runbook R1 pins the user to the base nightly first.
3. **The fork build ships without T3 Connect public config.** The user's live install is linked to T3 Connect (`~/.t3/userdata/secrets/cloud-*` exists). Release builds embed the relay URL and Clerk public keys at build time; a local build has none. Task 10 extracts them from the official base archive; Task 11 asserts they are in the fork binary and client.
4. **An agent CLI call lands on the live home.** Pinned by the Global Constraint on `--base-dir`; Task 1 asserts the `[dev-runner]` line's `baseDir=` equals `$DEV_HOME` before anything else runs.
5. **The cache dot reads cold after switching effort back.** Effort is compared as the raw selection value (index §9 C5), so an implicit default and the same value chosen explicitly differ. Task 2 sets an explicit effort before the first turn so "switch back" restores an identical identity.

## Failure policy

P6 does not edit feature code. When a check fails:

1. Capture a screenshot and the relevant data (WS window JSON, log line, DB row) into `$EVID`, named `FAIL-<task>-<check>.*`.
2. Diagnose to the owning plan (P1 maths, P2 history/usage, P3 shell token usage, P4 widget/popover/settings, P5 glyph) using the file ownership in index §7.
3. Stop and report to the orchestrator: failing check, evidence paths, diagnosis, owning plan. The orchestrator applies the fix per Open questions item 6 and re-runs P6 from the first task the fix can affect (Task 1 if server code changed, since the dev server must restart).

Leave the dev server running when stopping on a failure, and report its PID and URL.

---

## Part 1: end-to-end validation

### Task 0: Preflight and scratch environment

**Files:**

- Create: `$P6/env.sh`, `$P6/drivers/p6lib.mjs` (scratchpad only)
- Read: the integration worktree

**Interfaces:**

- Produces: `$P6/env.sh` (sourced by every later Bash call); `$P6/drivers/p6lib.mjs` (imported by every driver script).

- [ ] **Step 1: Pick the scratch root and write the env file.** `P6` is `<session scratchpad>/p6` (the harness-provided scratchpad directory of this session). Run, substituting the real scratchpad path:

```sh
P6="<session scratchpad>/p6"; mkdir -p "$P6/drivers" "$P6/evidence" "$P6/chrome-profile"; cat > "$P6/env.sh" <<EOF
export P6="$P6"
export WT=/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing
export BWT=/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build
export DEV_HOME="$P6/t3home"
export PROJ="$P6/project"
export EVID="$P6/evidence"
export PW=/tmp/t3-snap/node_modules/playwright/index.mjs
EOF
echo ok
```

- [ ] **Step 2: Verify the integration branch is complete and clean.**

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; git status --porcelain; git log --oneline -1; git log --oneline --merges -12 | grep -E "merge: (P1-shared|P2-server-usage|P3-server-thread|P4-web-header|P5-web-glyph)$"
```

Expected: empty porcelain output; five `merge: <plan id>` lines (P1-P5 full merges, not only milestones). If any is missing, stop: P6 runs only after P1-P5 fully merged (index §3).

- [ ] **Step 3: Verify the DOM hooks and shared API exist** (index §6.6, §6.1).

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; for h in data-pacing-widget data-pacing-row data-pacing-burn data-pacing-reset data-pacing-tick data-pacing-popover data-pacing-section data-thread-context-glyph; do printf '%s ' "$h"; grep -rl -- "$h" apps/web/src/components/pacing | head -1; done; grep -c "export function computeWindowPace\|export function resolveWorkSchedule\|export function computeSessionBurn" packages/shared/src/usagePacing.ts
```

Expected: every hook prints a file under `apps/web/src/components/pacing/`; the count is `3`.

- [ ] **Step 4: Verify the fork adds no DB migration** (the rollback in the runbook depends on it).

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; git diff --stat "$(git describe --tags --match 'v*-nightly.*' --abbrev=0 HEAD)" HEAD -- apps/server/src/persistence/Migrations apps/server/src/persistence/Migrations.ts | tail -1
```

Expected: no output. Any output: stop and report (the runbook's rollback section would be wrong).

- [ ] **Step 5: Verify tools.** `ls "$PW" /usr/bin/google-chrome "$WT/node_modules/.bin/vp"` all exist; `node --version` is v24 or later. If `$WT/node_modules/.bin/vp` is missing, run `builtin cd "$WT"; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="$WT/node_modules/.bin:$PATH" node scripts/setup-worktree.ts` once.

- [ ] **Step 6: Write the driver library** `$P6/drivers/p6lib.mjs`. This is a D-level spot (WebSocket capture and the window walk are easy to get subtly wrong), so the code is given in full:

```js
// $P6/drivers/p6lib.mjs - shared Playwright helpers for the P6 run. Scratch only.
import { chromium } from "/tmp/t3-snap/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";

export const P6 = process.env.P6;
export const EVID = process.env.EVID;
const SHARED =
  "/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/packages/shared/src/usagePacing.ts";
export const pacing = await import(SHARED); // P1 API, type-stripped by Node

/** WEB origin from the dev log's [dev-runner] line. */
export function webOrigin() {
  const log = readFileSync(`${P6}/dev.log`, "utf8");
  const m = [...log.matchAll(/\[dev-runner\] mode=dev .*?webPort=(\d+)/g)].at(-1);
  if (!m) throw new Error("no [dev-runner] line in dev.log");
  return `http://localhost:${m[1]}`;
}

/** Persistent headless Chrome; every text WS frame is kept in `frames`. */
export async function openApp(path = "/", viewport = { width: 1440, height: 900 }) {
  const ctx = await chromium.launchPersistentContext(`${P6}/chrome-profile`, {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    viewport,
    colorScheme: "dark",
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const frames = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      if (typeof f.payload === "string") frames.push({ at: Date.now(), payload: f.payload });
    }),
  );
  await page.goto(`${webOrigin()}${path}`, { waitUntil: "domcontentloaded" });
  return { ctx, page, frames };
}

/**
 * Newest Claude usage windows seen on the wire. Walks every JSON frame and keeps
 * the last object that has `usageLimits.windows` containing id "five_hour".
 */
export function latestClaudeWindows(frames) {
  let found = null;
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const windows = node.usageLimits?.windows;
    if (Array.isArray(windows) && windows.some((w) => w?.id === "five_hour")) found = windows;
    for (const value of Object.values(node)) walk(value);
  };
  for (const { payload } of frames) {
    try {
      walk(JSON.parse(payload));
    } catch {
      /* non-JSON frame */
    }
  }
  return found; // ServerProviderUsageWindow[] | null
}

/** Waits for a turn: the Stop button appears, then goes away. */
export async function waitTurn(page, timeoutMs = 240_000) {
  const stop = page.locator('button[aria-label="Stop generation"]');
  await stop.first().waitFor({ state: "visible", timeout: 60_000 });
  await stop.first().waitFor({ state: "detached", timeout: timeoutMs });
}

/** Types into the composer and sends. */
export async function sendPrompt(page, text) {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.pressSequentially(text);
  await page.keyboard.press("Enter");
}

/** Tick position 0..1 inside its bar (the tick's offsetParent is the bar). */
export async function tickFraction(page, rowSelector) {
  return page
    .locator(`${rowSelector} [data-pacing-tick]`)
    .first()
    .evaluate((tick) => {
      const bar = tick.offsetParent ?? tick.parentElement;
      const t = tick.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return (t.left + t.width / 2 - b.left) / b.width;
    });
}

export async function shot(page, name, locator) {
  const path = `${EVID}/${name}.png`;
  await (locator ?? page).screenshot({ path });
  return path;
}

export function record(name, data) {
  writeFileSync(`${EVID}/${name}.json`, JSON.stringify(data, null, 2));
}
```

Expected: `node -e 'import(process.env.P6 + "/drivers/p6lib.mjs").then(m => console.log(typeof m.pacing.computeWindowPace))'` (after `source env.sh`) prints `function`. If the import of `usagePacing.ts` fails, stop and report (P1 module is not Node-loadable; check its relative imports carry `.ts` extensions).

### Task 1: Isolated dev instance, pairing, project

**Files:**

- Create: `$DEV_HOME/userdata/settings.json`, `$PROJ/` (a tiny git repo), `$P6/dev.log`, `$P6/dev.pid`

**Interfaces:**

- Produces: a running dev server owned by PID in `$P6/dev.pid` (process-group leader), a paired Chrome profile, a project titled `P6 pacing` rooted at `$PROJ`.

- [ ] **Step 1: Seed the dev home's server settings** so Claude is the only enabled provider (copied from the shape of the user's live `~/.t3/userdata/settings.json`, which is read-only to us):

```sh
source "<session scratchpad>/p6/env.sh"; mkdir -p "$DEV_HOME/userdata"; cat > "$DEV_HOME/userdata/settings.json" <<'EOF'
{
  "providers": { "cursor": { "enabled": false }, "grok": { "enabled": false }, "opencode": { "enabled": false } },
  "providerInstances": {
    "codex": { "driver": "codex", "enabled": false, "config": { "binaryPath": "codex", "homePath": "", "shadowHomePath": "", "launchArgs": "", "customModels": [] } }
  }
}
EOF
echo ok
```

- [ ] **Step 2: Create the throwaway project repo** (agent turns run here, never in the T3 repo):

```sh
source "<session scratchpad>/p6/env.sh"; mkdir -p "$PROJ"; builtin cd "$PROJ"; git init -q; printf 'alpha\n' > a.txt; printf 'beta\n' > b.txt; printf 'gamma\n' > c.txt; printf '# P6 pacing scratch project\n' > README.md; git add -A; git -c user.email=p6@example.invalid -c user.name=p6 commit -qm init; ls
```

Expected: `README.md a.txt b.txt c.txt`.

- [ ] **Step 3: Start the dev server as its own process group** and record the PID:

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT -u T3CODE_HOME PATH="$WT/node_modules/.bin:$PATH" setsid node scripts/dev-runner.ts dev --home-dir "$DEV_HOME" > "$P6/dev.log" 2>&1 < /dev/null & echo $! > "$P6/dev.pid"; cat "$P6/dev.pid"
```

Then wait (until-loop; use the Monitor tool if foreground sleep is blocked) for `pairingUrl:` in `$P6/dev.log`, up to 180 s.

- [ ] **Step 4: Assert ownership and isolation.**

```sh
source "<session scratchpad>/p6/env.sh"; PID=$(cat "$P6/dev.pid"); ps -o pid=,pgid=,cmd= -p "$PID"; readlink "/proc/$PID/cwd"; grep -m1 '\[dev-runner\] mode=' "$P6/dev.log"; grep -m1 -o 'pairingUrl: \S*' "$P6/dev.log" | sed 's/token=.*/token=<redacted>/'
```

Expected: PID equals PGID; cwd is `$WT`; the `[dev-runner]` line contains `baseDir=$DEV_HOME` (exact path) plus `serverPort=<n> webPort=<m>`. Any other `baseDir`: stop the group (Task 9 Step 1) and report. Never paste the token into replies or screenshots.

- [ ] **Step 5: Pair the Chrome profile.** Driver `$P6/drivers/pair.mjs`: read the last `pairingUrl: (\S+)` from `$P6/dev.log`, `launchPersistentContext` exactly as `openApp` does, `goto(url, { waitUntil: "networkidle" })`, wait until `location.pathname` no longer starts with `/pair` (timeout 30 s), screenshot `$EVID/00-paired.png`, close. If the page reports the token consumed or expired, mint a fresh one with `builtin cd "$WT"; node apps/server/src/bin.ts pair --base-dir "$DEV_HOME"` and use its `Pairing URL:`.

- [ ] **Step 6: Add the project through the CLI** (live mode against the running server):

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; env -u T3CODE_HOME node apps/server/src/bin.ts project add "$PROJ" --title "P6 pacing" --base-dir "$DEV_HOME"
```

Expected: `Added project <id> (P6 pacing) at <$PROJ>.`

- [ ] **Step 7: Confirm Claude is the selected provider.** Driver `check-provider.mjs`: `openApp("/")`, wait for `[contenteditable="true"]` (30 s; the index route opens a draft for the most recent project). If the page shows "Failed to fetch dynamically imported module" (Vite's first-run dep optimisation, seen in an earlier run), reload once. Read the aria-label of `[data-chat-provider-model-picker="true"]`. Expected: it names a Claude model (matches `/claude|opus|sonnet|haiku|fable/i`). If not, click the trigger, click the first row inside `[data-model-picker-provider]` whose text matches the same regex, and re-check. Screenshot `$EVID/01-draft-claude.png`.

### Task 2: Thread A turns, usage history, and the identity switch (spec §7 items 2 and 3)

**Interfaces:**

- Consumes: Task 0 `p6lib.mjs`, Task 1 running instance.
- Produces: thread A with 3 completed turns; `$EVID/item3-*.json`; the effort label `EFFORT_A` recorded in `$EVID/effort.json`.

All of this task runs in one driver script, `$P6/drivers/thread-a.mjs`, so the cache is fresh when the identity checks run.

- [ ] **Step 1: Set an explicit effort before the first turn.** On the draft from `openApp("/")`: click `[data-composer-shortcut="composer.effort"]`, collect the names of `[role="menuitemradio"]` items. Pick `EFFORT_A` = the item named `High` if present, else the second item; click it. Pick `EFFORT_B` = the first item whose name differs from `EFFORT_A`. Record both to `$EVID/effort.json`.

- [ ] **Step 2: Turn 1.** `sendPrompt(page, "Reply with the single word: ok. Do not use any tools.")`, `waitTurn(page)`. Record `t1 = Date.now()`.

- [ ] **Step 3: Turns 2 and 3, spaced so history coalescing records them.** Wait until `Date.now() - t1 >= 70_000` (this is real-time pacing in an e2e driver, not a test sleep; index §6.2 rule 4 skips an unchanged sample within 60 s). Send the same prompt, `waitTurn`. Repeat once more 70 s after turn 2. Record `t3done = Date.now()`.

- [ ] **Step 4: Item 3, glyphs present and warm** (immediately, within 3 minutes of `t3done`; a 5-minute TTL turns `expiring` at 75 s remaining).

| Check                             | Selector / source                                                                                                                                                                                                                                                                                                                                                                             | Expected                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Sidebar glyph exists for thread A | `THREAD_A = new URL(page.url()).pathname.split("/").at(-1)` (the chat route is `/<environmentId>/<threadId>`, `routes/_chat.$environmentId.$threadId.tsx`; thread titles are model-generated, so do not match on prompt text); then `[data-thread-item*="<THREAD_A>"] [data-thread-context-glyph][data-size="14"]` (`data-thread-item` holds `scopedThreadKey`, which contains the thread id) | present                                                                         |
| Sidebar cache state               | its `data-cache-state`                                                                                                                                                                                                                                                                                                                                                                        | `warm` (accept `expiring`; record which)                                        |
| Composer glyph exists             | `[data-thread-context-glyph][data-size="18"]`                                                                                                                                                                                                                                                                                                                                                 | present                                                                         |
| Composer cache state              | its `data-cache-state`                                                                                                                                                                                                                                                                                                                                                                        | `warm` (accept `expiring`)                                                      |
| Composer context tier             | `data-context-tier`                                                                                                                                                                                                                                                                                                                                                                           | `0` (short turns are far below 50 % and 200k)                                   |
| Sidebar tooltip                   | hover the thread A row (`[data-thread-item*="<THREAD_A>"]`, not the glyph: the glyph sits in a `pointer-events-none` status span, so Playwright's hover on it would time out); P5 puts the text in the row's hover card (`SidebarThreadTooltip`), so wait up to 3 s for `page.getByText(/^Context [0-9.]+[kM]? \//).first()` and read its `innerText()`                                       | matches `/^Context [0-9.]+[kM]? \/ [0-9.]+[kM]? \(\d+%\) · Cache (warm, expires | expiring) .+$/` |

Screenshots: `$EVID/02-sidebar-glyph.png` (the thread item locator), `$EVID/03-composer-glyph-warm.png` (the composer footer: `[data-chat-composer-footer="true"]`, else the glyph's grandparent).

- [ ] **Step 5: Item 3, effort switch removes the dot immediately, switching back restores it.**

| Action                             | Expected composer `data-cache-state` within 2 s | Screenshot                          |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Open effort menu, click `EFFORT_B` | `cold` (the dot `<circle>` for state is absent) | `04-composer-glyph-cold-effort.png` |
| Open effort menu, click `EFFORT_A` | `warm` or `expiring` (dot back)                 | `05-composer-glyph-restored.png`    |

The sidebar glyph must stay `warm`/`expiring` throughout (it compares against the thread's stored `modelSelection`, spec §4.5).

- [ ] **Step 6: Item 3, model switch.** Click `[data-chat-provider-model-picker="true"]`; inside `[data-model-picker-content]`, click the first Claude model row whose text differs from the current trigger label. Expected composer state `cold` within 2 s (`06-composer-glyph-cold-model.png`). Re-open the picker, click the original model row, then re-select `EFFORT_A` in the effort menu (a model change may reset effort). Expected `warm`/`expiring` (`07-composer-glyph-restored-model.png`).

- [ ] **Step 7:** Write `$EVID/item3.json` with every observed attribute and timestamp; close the context.

### Task 3: Percentages agree across sources (spec §7 item 1)

**Interfaces:**

- Consumes: thread A from Task 2; provider event log at `$DEV_HOME/userdata/logs/provider/events*.log`.

Driver `$P6/drivers/item1.mjs`.

- [ ] **Step 1: Wire snapshot.** `openApp("/")`, wait for `[data-pacing-widget]` (30 s), wait 3 s more for frames, `W = latestClaudeWindows(frames)`. Expected: `W` contains ids `five_hour` (`kind: "session"`) and `seven_day` (`kind: "weekly"`).

- [ ] **Step 2: Header rows.** Expected rows `[data-pacing-row="five_hour"]` then `[data-pacing-row="seven_day"]` in DOM order, plus one `[data-pacing-row^="seven_day_"]` per model-scoped window in `W`. Screenshot the widget: `$EVID/08-header-widget.png`.

- [ ] **Step 3: Popover.** Hover `[data-pacing-widget]`; expect `[data-pacing-popover]` visible within 1 s. Click the widget (pins); move the mouse to the page centre; expect the popover still visible. Screenshot `$EVID/09-popover-pinned.png`. Read the first `/(\d+)%/` in each `[data-pacing-section="<id>"]`. Press Escape; expect the popover gone.

- [ ] **Step 4: `/usage` page.** `page.goto(origin + "/usage")`, read `aria-label` of `[role="img"][aria-label^="Session:"]` and `[role="img"][aria-label^="Weekly:"]` (format `"<label>: <remaining>% left, ..."`, `UsageLimits.tsx` `WindowBar`). Used = `100 - remaining`. Screenshot `$EVID/10-usage-page.png`.

- [ ] **Step 5: Provider log.**

```sh
source "<session scratchpad>/p6/env.sh"; grep -h '"unifiedWindows"' "$DEV_HOME"/userdata/logs/provider/events*.log | tail -1 | grep -o '"unifiedWindows":{[^}]*}[^}]*}}'
```

Log used % = `utilization * 100`.

- [ ] **Step 6: Assert.**

| Window    | Pass condition                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| five_hour | popover % == `Math.round(W.five_hour.usedPercent)` ± 1; `/usage` used == same ± 1; log used == `W.five_hour.usedPercent` ± 1 |
| seven_day | same three comparisons                                                                                                       |

Also record whether the newest log line's `rateLimitType` was `seven_day` while its `five_hour` utilization matches `W` (that is P2's `unifiedWindows` fix observed live; informational, not a pass condition). Write `$EVID/item1.json` with all four readings per window.

### Task 4: Burns appear; toggling hides a row (spec §7 item 2)

Driver `$P6/drivers/item2.mjs`.

- [ ] **Step 1: History on the wire.** From `latestClaudeWindows(frames)`: `five_hour.history` exists, has ≥ 3 samples, ascending `at`, last `usedPercent` == window `usedPercent`, span (last.at - first.at) ≥ 90 s. `seven_day.history` is absent. If fewer than 3 samples, keep the page open and re-read every 30 s for up to 12 minutes (5-minute probes add samples); if still short, FAIL (P2).

- [ ] **Step 2: Expected burns via P1.** `now = await page.evaluate(() => Date.now())`; `schedule = pacing.resolveWorkSchedule({ workHours: "09:00-17:00", workDays: [1,2,3,4,5], offHoursWeight: 0.2 })` (defaults; Task 6 changes them later); `E5 = pacing.computeWindowPace(W.five_hour, { nowMs: now, schedule })`, `E7 = ... W.seven_day ...`.

- [ ] **Step 3: Assert header burns.**

| Row                                 | Pass condition                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| five_hour `[data-pacing-burn]` text | `E5.burn === null` → empty text; else equals `pacing.formatBurn(x)` for some `x` with `abs(x - E5.burn) <= 0.1`                             |
| seven_day `[data-pacing-burn]` text | same against `E7` (spec: "the weekly burn appears immediately" unless `frac < 0.02`, in which case `E7.burn` is null and the cell is empty) |
| five_hour tick                      | `abs(tickFraction(page, '[data-pacing-row="five_hour"]') - E5.paceFraction) <= 0.03`                                                        |
| seven_day tick                      | same against `E7.paceFraction`                                                                                                              |

Also assert E5 used the EWMA path, not the fallback: compute `L = pacing.computeSessionBurn({ ...same inputs, samples: [] })`; record both `E5.burn` and `L?.burn` in `$EVID/item2.json` (they may coincide numerically; the pass condition is Step 1 plus the equality above). Screenshot `$EVID/11-burns.png` (widget).

- [ ] **Step 4: Toggle the weekly window off.** `goto(origin + "/settings/usage-pacing")`. Locate the switch: `page.getByText("Show weekly window", { exact: true }).locator('xpath=ancestor::*[.//*[@role="switch"]][1]').locator('[role="switch"]')`; click; expect `aria-checked="false"`. Screenshot `$EVID/12-settings-weekly-off.png`. Go back to `/` (thread A via the sidebar item).

| Check                                                      | Expected                                              |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `[data-pacing-row="seven_day"]`                            | absent                                                |
| `[data-pacing-row="five_hour"]`                            | present                                               |
| Popover (hover widget) `[data-pacing-section="seven_day"]` | present, `data-hidden="true"`, text contains `hidden` |
| Popover `[data-pacing-section="five_hour"]`                | `data-hidden="false"`                                 |

Screenshots `$EVID/13-header-weekly-hidden.png`, `$EVID/14-popover-weekly-hidden.png`.

- [ ] **Step 5: Restore.** Toggle the switch back on (`aria-checked="true"`), confirm `[data-pacing-row="seven_day"]` returns.

### Task 5: Subagent turn keeps the real context size (spec §7 item 4)

Driver `$P6/drivers/item4.mjs`.

- [ ] **Step 1: New thread B.** `openApp("/")` lands on a draft (or press `Control+n`). Set effort to `EFFORT_A` as in Task 2 Step 1.

- [ ] **Step 2: Send the subagent prompt** and wait with `waitTurn(page, 420_000)`:

  `Use the Task tool to launch exactly one general-purpose subagent. The subagent must list the files in the current directory and report how many there are. Then reply with only that number.`

- [ ] **Step 3: Assert.**

| Check                      | Source                                                                                                                                                                                                                                     | Expected                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn used a subagent       | the thread timeline contains a subagent/task item (text `Task` or the subagent's description)                                                                                                                                              | present; if absent, re-send once with the same prompt; if still absent, record "no subagent spawned" and FAIL (inconclusive item 4)                                   |
| Composer meter label       | `aria-label` of the meter button that contains `[data-thread-context-glyph][data-size="18"]` (P5 replaces the old `Context window N% used` label with the glyph tooltip string, e.g. `Context 38k / 1M (4%) · Cache warm, expires 3:12pm`) | matches `/^Context ([0-9.]+[kM]?)(?: \/ ([0-9.]+[kM]?) \((\d+)%\))?/` with the percentage `< 50` when present and the used tokens `< 200k`; never `1M / 1M` or `100%` |
| Composer glyph tier        | `[data-thread-context-glyph][data-size="18"]` `data-context-tier`                                                                                                                                                                          | `0`                                                                                                                                                                   |
| Sidebar glyph for thread B | 14 px glyph in `[data-thread-item*="<THREAD_B>"]`, `THREAD_B` taken from `page.url()` as in Task 2 Step 4                                                                                                                                  | present                                                                                                                                                               |
| Persisted usage            | query below                                                                                                                                                                                                                                | `usedTokens < maxTokens` and `usedTokens < 200000`                                                                                                                    |

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; node apps/server/scripts/t3-sqlite-state.ts query --base-dir "$DEV_HOME" --sql "SELECT provider_thread_id, ordinal, json_extract(payload_json,'$.tokenUsage.usedTokens') AS used, json_extract(payload_json,'$.tokenUsage.maxTokens') AS max, json_extract(payload_json,'$.tokenUsage.updatedAt') AS at FROM orchestration_v2_projection_provider_turns ORDER BY at DESC LIMIT 6"
```

Screenshots `$EVID/15-subagent-turn.png` (full page), `$EVID/16-subagent-composer-meter.png` (hover the meter so its popover shows tokens).

### Task 6: Work hours and days move the weekly burn and tick (spec §7 item 6)

Driver `$P6/drivers/item6.mjs`. Settings are per-device client settings, so they persist in the Chrome profile.

- [ ] **Step 1: Baseline.** On thread A, read seven_day burn text and tick fraction; compute `E7_0` with the default schedule (Task 4 Step 2). Assert as in Task 4 Step 3. Screenshot `$EVID/17-weekly-before.png`.

- [ ] **Step 2: Change the schedule.** `goto("/settings/usage-pacing")`. Today's weekday `d = new Date().getDay()`. Set the two `input[type="time"]` inside the row containing the text `Work hours` to `06:00` and `22:00` (`fill`, then press Tab). In the `Work days` toggle group, click the toggle whose `aria-label` is `["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]` (flips today's membership). Leave off-hours weight at 0.2. Screenshot `$EVID/18-settings-schedule.png`. New settings: `workHours "06:00-22:00"`, `workDays` = defaults with `d` toggled.

- [ ] **Step 3: Assert the move.** Back on thread A, within 2 s (settings change re-renders immediately; no 30 s tick needed):

| Check                   | Expected                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| seven_day burn text     | matches `E7_1 = computeWindowPace(W.seven_day, { nowMs: now, schedule: resolveWorkSchedule(new settings) })` per the Task 4 Step 3 rule             |
| seven_day tick          | within 0.03 of `E7_1.paceFraction`                                                                                                                  |
| it moved                | `E7_1.paceFraction !== E7_0.paceFraction` or the burn text changed; if P1 says neither changes (degenerate window), also flip `d + 1` and re-assert |
| five_hour burn and tick | unchanged from before the change (session windows are wall-clock)                                                                                   |

Screenshot `$EVID/19-weekly-after.png`.

- [ ] **Step 4: Restore defaults** in the settings section (`09:00`/`17:00`, today's toggle back), so Task 7 compares against defaults.

### Task 7: Server restart: widget recovers, burn falls back (spec §7 item 5)

- [ ] **Step 1: Stop the dev server group** (only our PID):

```sh
source "<session scratchpad>/p6/env.sh"; PID=$(cat "$P6/dev.pid"); SP=$(grep -m1 -o 'serverPort=[0-9]*' "$P6/dev.log" | cut -d= -f2); kill -TERM -- "-$PID"; echo "stopped group $PID, serverPort $SP"
```

Wait (until-loop, ≤ 20 s) until `ss -H -ltn "sport = :$SP"` prints nothing. If it still listens after 20 s, `kill -KILL -- "-$PID"` and re-check. Never kill anything else.

- [ ] **Step 2: Restart** with the Task 1 Step 3 command, appending to a new log: write to `$P6/dev2.log` and then `cp "$P6/dev2.log" "$P6/dev.log"` once the `[dev-runner]` line appears (the drivers read `dev.log`). Re-run Task 1 Step 4's assertions. The pairing cookie survives (sessions live in the dev DB).

- [ ] **Step 3: Widget recovers.** Driver `item5.mjs`: `openApp("/")`, open thread A. Wait up to 90 s for `[data-pacing-widget]`. If absent, send one short prompt (Task 2's) and wait up to 120 s more. Screenshot `$EVID/20-after-restart-widget.png`.

- [ ] **Step 4: History reset and fallback burn.**

| Check                           | Expected                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `five_hour.history` on the wire | absent or ≤ 2 samples, all with `at` after the restart time                                                                                                                                                                                                                                                                                |
| five_hour burn                  | per Task 4 Step 3 rule against `computeWindowPace` on the new window. Independently: let `elapsed = now/1000 - (resetsAtSec - windowSec)`, `windowSec = windowDurationMins*60`. If `elapsed >= 1800` the burn must equal `roundBurn((used/100) * windowSec / elapsed)` ± 0.1 (linear fallback); if `elapsed < 1800` the cell must be empty |
| seven_day burn                  | unchanged rule (schedule-weighted, no history involved)                                                                                                                                                                                                                                                                                    |

Screenshot the pinned popover `$EVID/21-after-restart-popover.png`; write `$EVID/item5.json`.

### Task 8: Extra: narrow-header breakpoints (spec §3.1, §9.1)

Driver `item7.mjs`, thread A open.

- [ ] **Step 1:** For viewport widths 1400 down to 480 in steps of 20 (height 900): set viewport, wait 300 ms, read `hw = [data-chat-header].getBoundingClientRect().width`, presence of `[data-pacing-widget]` and of `[data-pacing-reset]`.

- [ ] **Step 2: Assert** for every sample outside the slack bands 552-568 and 412-428: `hw >= 568` → widget and reset present; `428 <= hw < 552` → widget present, reset absent; `hw < 412` → widget absent. Screenshots at the first sample in each band: `$EVID/22-wide.png`, `23-no-reset.png`, `24-hidden.png`. If the header never goes below 412 px, record that and skip that row.

- [ ] **Step 3: Right panel open (P4 placement, index Decisions needed item 11).** Back at 1440 x 900, click `button[aria-label="Toggle right panel"]` (`PanelLayoutControls.tsx`) and wait 500 ms for the panel to settle. Assert: `[data-pacing-widget]` is present (if the header is still >= 420 px wide) and is a descendant of `header[data-chat-header]`; its bounding box does not intersect the bounding box of the right panel's tab bar (the element containing the right-panel and terminal toggles, i.e. the `button[aria-label="Toggle right panel"]`'s parent cluster); the breadcrumb text does not overlap the widget. Screenshot `$EVID/25-right-panel-open.png`. Click the toggle again to close it and confirm the widget returns to the cluster left of the toggles (`$EVID/26-right-panel-closed.png`). A failed assertion is a P4 finding (Failure policy).

### Task 9: Part 1 teardown and evidence index

- [ ] **Step 1: Stop the dev server** exactly as Task 7 Step 1. Confirm the port is free. Leave `$DEV_HOME`, `$PROJ` and `$EVID` in place.
- [ ] **Step 2:** `ls -1 "$EVID"`; write `$EVID/INDEX.txt` (plain list: file, which spec §7 item it proves, PASS/FAIL). This list goes into the handoff message.
- [ ] **Step 3: Gate.** Part 2 starts only if items 1-6 are PASS (index §4: the runbook runs only after Part 1 passed). If any FAIL, follow the Failure policy and stop.

---

## Part 2: build the fork CLI and rehearse the install

Facts this part relies on, verified at `2ca9e43bb`:

- The archive is assembled by `scripts/build-cli-archive.ts` from `apps/server/dist-exe/t3` (`node apps/server/scripts/cli.ts build-exe`), `apps/server/dist/client` (`vp run --filter t3 build`, which depends on `@t3tools/web#build`), a resource-monitor dir laid out `<platform-key>/t3-resource-monitor`, and a `vp install --prod` of the runtime externals. CI order: `.github/workflows/release-desktop.yml` lines ~463-547.
- The binary's version is `apps/server/package.json`'s `version`, which is `0.0.45` on the nightly tag: release CI rewrites it with `scripts/update-release-package-versions.ts <version>` (server, desktop, web, contracts package.json). `t3 --version` prints `t3 v<version>`; installers verify it with `/\bv(\S+)\s*$/`.
- Installs live in `<baseDir>/runtime/versions/<version>/` with a `.install-complete` sentinel (`apps/server/src/cloud/pinnedRuntime.ts`); a present sentinel means "already installed, skip download".
- `t3 update [version] [--channel] [--allow-downgrade] [--yes] [--base-dir]` (`apps/server/src/cli/update.ts`) downloads `<base>/v<version>/SHA256SUMS` and `<base>/v<version>/t3-<version>-linux-x64.tar.gz`, where `<base>` is `T3CODE_RELEASE_BASE_URL` or GitHub releases (`packages/shared/src/cliRelease.ts`), verifies the checksum, extracts with `--strip-components=1`, runs `--version`, repoints `~/.local/bin/t3` only when it is a symlink into that home's `runtime/versions`, and rewrites/restarts the boot service only when the service serves that same home.
- The channel of a version is `nightly` only for the exact shape `X.Y.Z-nightly.YYYYMMDD.N` (`cliReleaseChannelOf`).
- The user's machine today: `~/.local/bin/t3 -> ~/.t3/runtime/versions/0.0.45/t3`; `~/.config/systemd/user/t3code.service` runs `~/.t3/runtime/versions/0.0.45/t3 __service-launcher` with `T3CODE_HOME=/home/jorgen/.t3`; `~/.t3/runtime/service-state.json` has `activeVersion: "0.0.45"`; the live DB is V1 `state.sqlite` (0.0.45 reads `state.sqlite`; the nightly reads `statev2.sqlite`, created by copying `state.sqlite` once when missing, `apps/server/src/persistence/initializeV2Database.ts`).
- No `cargo` on this machine, so the resource monitor comes from the official base archive; its source is unchanged since `v0.0.45` (`git diff --stat v0.0.45 HEAD -- native/resource-monitor` is empty).

### Task 10: Build worktree, fork version, base archive, public config

**Interfaces:**

- Produces: `$BWT` (detached at the Part 1 HEAD, deps installed); `$P6/fork.env` with `BASE_VERSION`, `FORK_VERSION`, `BASE_DIR_X` (extracted base archive) and the four public-config variables.

- [ ] **Step 1: Create the detached build worktree** at the exact commit Part 1 validated:

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$WT"; HEAD_SHA=$(git rev-parse HEAD); git worktree add --detach "$BWT" "$HEAD_SHA"; builtin cd "$BWT"; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="$WT/node_modules/.bin:$PATH" node scripts/setup-worktree.ts; git -C "$BWT" rev-parse HEAD
```

Expected: the printed SHA equals `HEAD_SHA`. If `$BWT` already exists from an earlier run, `git -C "$BWT" status --porcelain` must list only the four package.json files from Step 3; then `git -C "$BWT" checkout -- .` and `git -C "$BWT" checkout --detach "$HEAD_SHA"` instead of re-adding.

- [ ] **Step 2: Derive the versions.**

```sh
source "<session scratchpad>/p6/env.sh"; builtin cd "$BWT"; BASE_VERSION=$(git describe --tags --match 'v*-nightly.*' --abbrev=0 HEAD | sed 's/^v//'); BASE_RUN=${BASE_VERSION##*.}; K=0; while [ -e "$HOME/.t3/runtime/versions/${BASE_VERSION%.*}.$((900000 + BASE_RUN + K))" ]; do K=$((K+1)); done; FORK_VERSION="${BASE_VERSION%.*}.$((900000 + BASE_RUN + K))"; printf 'export BASE_VERSION=%s\nexport FORK_VERSION=%s\n' "$BASE_VERSION" "$FORK_VERSION" > "$P6/fork.env"; cat "$P6/fork.env"
```

Expected at `2ca9e43bb`: `BASE_VERSION=0.0.46-nightly.20261011.2980`, `FORK_VERSION=0.0.46-nightly.20261011.902980` (K increments only if the user already installed an earlier fork build on this base; reading `~/.t3/runtime/versions` is allowed, writing is not). Rationale for the scheme: Open questions item 4.

- [ ] **Step 3: Write the fork version into the release manifests** (build worktree only):

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; builtin cd "$BWT"; node scripts/update-release-package-versions.ts "$FORK_VERSION"; git status --porcelain
```

Expected: exactly `apps/server/package.json`, `apps/desktop/package.json`, `apps/web/package.json`, `packages/contracts/package.json` modified.

- [ ] **Step 4: Download and verify the official base archive** (source of the resource monitor and the public config):

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; mkdir -p "$P6/base"; builtin cd "$P6/base"; U="https://github.com/pingdotgg/t3code/releases/download/v$BASE_VERSION"; curl -fsSLO "$U/SHA256SUMS"; curl -fsSLO "$U/t3-$BASE_VERSION-linux-x64.tar.gz"; grep " t3-$BASE_VERSION-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -; mkdir -p x; tar -xzf "t3-$BASE_VERSION-linux-x64.tar.gz" -C x --strip-components=1; ls x; x/t3 --version; echo "export BASE_DIR_X=$P6/base/x" >> "$P6/fork.env"
```

Expected: `OK`; `x` lists `client node_modules resource-monitor t3`; `--version` prints `t3 v$BASE_VERSION`. Fallback only if GitHub is unreachable: copy `~/.t3/runtime/versions/0.0.45/resource-monitor` (read-only copy) into `$P6/base/x/resource-monitor`, and extract the public config from `~/.t3/runtime/versions/0.0.45/{t3,client}` in Step 5 instead.

- [ ] **Step 5: Extract the build-time public config** from the official binary and client. These values are public by design (shipped in every release binary); keep them in `$P6/fork.env` only, never in a repo `.env`, and never print them in replies.

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; B="$BASE_DIR_X"
RELAY=$(grep -aoE 'const buildTimeRelayUrl = normalizeSecureRelayUrl\("https://[^"]+"\)' "$B/t3" | head -1 | sed -E 's/.*\("([^"]+)"\)/\1/')
PK=$(grep -aoE 'const buildTimeClerkPublishableKey = readBuildTimeValue\("pk_[A-Za-z0-9_]+"\)' "$B/t3" | head -1 | sed -E 's/.*\("([^"]+)"\)/\1/')
CID=$(grep -aoE 'const buildTimeClerkCliOAuthClientId = readBuildTimeValue\("[A-Za-z0-9_-]+"\)' "$B/t3" | head -1 | sed -E 's/.*\("([^"]+)"\)/\1/')
JWT=$(grep -rhoE 'VITE_CLERK_JWT_TEMPLATE:`[^`]+`' "$B/client/assets" | head -1 | sed -E 's/.*`([^`]+)`/\1/')
for v in RELAY PK CID JWT; do eval "val=\$$v"; [ -n "$val" ] && echo "$v found (${#val} chars)" || echo "$v MISSING"; done
printf 'export T3CODE_RELAY_URL=%s\nexport T3CODE_CLERK_PUBLISHABLE_KEY=%s\nexport T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=%s\nexport T3CODE_CLERK_JWT_TEMPLATE=%s\n' "$RELAY" "$PK" "$CID" "$JWT" >> "$P6/fork.env"
```

Expected: four `found` lines (at `v0.0.45` the relay is `https://relay.t3.codes` and the JWT template `t3-relay`). Any `MISSING`: stop and report (Review Focus item 3); do not build without it. The relay-client OTLP tracing values are deliberately not copied (Open questions item 5).

### Task 11: Build the archive and smoke it

**Interfaces:**

- Consumes: `$P6/fork.env`, `$BWT`.
- Produces: `$BWT/fork-mirror/v$FORK_VERSION/t3-$FORK_VERSION-linux-x64.tar.gz` and `SHA256SUMS` next to it.

- [ ] **Step 1: Build web + server bundle** with the public config in the environment (`loadRepoEnv` maps `T3CODE_*` to the `VITE_*` and `__T3CODE_BUILD_*__` defines, `scripts/lib/public-config.ts`):

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; builtin cd "$BWT"; PATH="$BWT/node_modules/.bin:$PATH" vp run --filter t3 build; ls apps/server/dist/client/index.html
```

- [ ] **Step 2: Build the single executable** with the Node CI pins (`SEA_NODE_VERSION` in `apps/server/vite.config.ts`):

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; builtin cd "$BWT"; VP_NODE_VERSION=26.8.2 PATH="$BWT/node_modules/.bin:$PATH" node apps/server/scripts/cli.ts build-exe --verbose; apps/server/dist-exe/t3 --version
```

Expected: `t3 v$FORK_VERSION`. If `vp pack` fails because the Node in use lacks `--build-sea`, run `fnm install 26.8.2` and repeat the command prefixed with `fnm exec --using=26.8.2`.

- [ ] **Step 3: Assemble the archive** straight into the mirror layout:

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; builtin cd "$BWT"; M="$BWT/fork-mirror/v$FORK_VERSION"; mkdir -p "$M"; PATH="$BWT/node_modules/.bin:$PATH" node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$FORK_VERSION" --resource-monitor-dir "$BASE_DIR_X/resource-monitor" --output-dir "$M"; builtin cd "$M"; sha256sum "t3-$FORK_VERSION-linux-x64.tar.gz" > SHA256SUMS; cat SHA256SUMS; ls -la
```

Expected: `[cli-archive] Wrote .../t3-$FORK_VERSION-linux-x64.tar.gz (<bytes>)`; `SHA256SUMS` holds one `<64 hex>  t3-...tar.gz` line (the format `parseChecksums` reads).

- [ ] **Step 4: Repo smoke test:**

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; builtin cd "$BWT"; env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT -u T3CODE_HOME PATH="$BWT/node_modules/.bin:$PATH" node scripts/smoke-cli-archive.ts --archive "$BWT/fork-mirror/v$FORK_VERSION/t3-$FORK_VERSION-linux-x64.tar.gz" --expect-version "$FORK_VERSION"
```

Expected: `[cli-smoke] t3-<FORK_VERSION>-linux-x64: --version passed and serve answered on <port>.`

- [ ] **Step 5: Content assertions** on a scratch extraction:

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; rm -rf "$P6/forkx"; mkdir -p "$P6/forkx"; tar -xzf "$BWT/fork-mirror/v$FORK_VERSION/t3-$FORK_VERSION-linux-x64.tar.gz" -C "$P6/forkx" --strip-components=1; F="$P6/forkx"; grep -rlq 'data-pacing-widget' "$F/client/assets" && echo widget-ok; grep -rlq 'data-thread-context-glyph' "$F/client/assets" && echo glyph-ok; grep -aq "const buildTimeRelayUrl = normalizeSecureRelayUrl(\"$T3CODE_RELAY_URL\")" "$F/t3" && echo relay-ok; grep -aq "readBuildTimeValue(\"$T3CODE_CLERK_PUBLISHABLE_KEY\")" "$F/t3" && echo pk-ok; grep -rlq "$T3CODE_CLERK_PUBLISHABLE_KEY" "$F/client/assets" && echo client-pk-ok; ls "$F/resource-monitor/linux-x64/t3-resource-monitor" && echo rm-ok
```

Expected: all six `-ok` lines.

### Task 12: Mirror rehearsal against a throwaway home

**Interfaces:**

- Consumes: the mirror from Task 11, the official base binary `$BASE_DIR_X/t3` (stands in for the user's post-nightly `t3`).
- Produces: `$EVID/part2-rehearsal.txt`, `$EVID/30-fork-ui.png`.

- [ ] **Step 1: Snapshot the live install's state** (read-only) to prove nothing changes:

```sh
source "<session scratchpad>/p6/env.sh"; { readlink ~/.local/bin/t3; sha256sum ~/.t3/runtime/service-state.json ~/.config/systemd/user/t3code.service; systemctl --user show t3code.service -p MainPID -p ActiveState; ls ~/.t3/runtime/versions; } > "$P6/live-before.txt"; cat "$P6/live-before.txt"
```

- [ ] **Step 2: Start the local mirror** on port 47811 (check it is free first: `ss -H -ltn "sport = :47811"` prints nothing; otherwise use 47812, 47813, ... and substitute everywhere):

```sh
source "<session scratchpad>/p6/env.sh"; setsid python3 -m http.server 47811 --bind 127.0.0.1 --directory "$BWT/fork-mirror" > "$P6/mirror.log" 2>&1 < /dev/null & echo $! > "$P6/mirror.pid"; cat "$P6/mirror.pid"
```

Then `curl -fsS "http://127.0.0.1:47811/v$FORK_VERSION/SHA256SUMS"` prints the checksum line.

- [ ] **Step 3: Rehearse the user's command** with the base nightly binary against a throwaway home:

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; TH="$P6/throwaway-home"; mkdir -p "$TH"; env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT -u T3CODE_HOME T3CODE_RELEASE_BASE_URL=http://127.0.0.1:47811 "$BASE_DIR_X/t3" update "$FORK_VERSION" --base-dir "$TH" < /dev/null 2>&1 | tee "$EVID/part2-rehearsal.txt"; ls "$TH/runtime/versions/$FORK_VERSION"; cat "$TH/runtime/versions/$FORK_VERSION/.install-complete"
```

Expected output contains `$BASE_VERSION → $FORK_VERSION (nightly)`, `Installed T3 Code $FORK_VERSION`, `Run $TH/runtime/versions/$FORK_VERSION/t3`, and `The background service serves /home/jorgen/.t3 and was left unchanged.`; the version dir lists `client node_modules resource-monitor t3`; the sentinel prints `$FORK_VERSION`.

- [ ] **Step 4: Prove the live install is untouched.** Re-run the Step 1 command into `$P6/live-after.txt`; `diff "$P6/live-before.txt" "$P6/live-after.txt"` prints nothing. Any difference: stop everything and report immediately.

- [ ] **Step 5: Serve the installed fork and load its UI.** Port 47821 (free-check as in Step 2):

```sh
source "<session scratchpad>/p6/env.sh"; source "$P6/fork.env"; TH="$P6/throwaway-home"; env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT -u T3CODE_HOME setsid "$TH/runtime/versions/$FORK_VERSION/t3" serve --base-dir "$TH" --host 127.0.0.1 --port 47821 --no-browser > "$P6/forkserve.log" 2>&1 < /dev/null & echo $! > "$P6/forkserve.pid"
```

Wait (≤ 60 s) for `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47821/` to print `200`. Driver `fork-ui.mjs`: read `Pairing URL: (\S+)` from `$P6/forkserve.log`, launch a **non-persistent** headless Chrome (`chromium.launch({ executablePath: "/usr/bin/google-chrome" })`), goto the pairing URL, wait until off `/pair`, screenshot `$EVID/30-fork-ui.png`, close. Expected: the app shell renders (no error page).

- [ ] **Step 6: Stop what this task started**, by tracked PID only: `kill -TERM -- "-$(cat "$P6/forkserve.pid")"`; `kill -TERM -- "-$(cat "$P6/mirror.pid")"`; confirm ports 47821 and 47811 are free. Leave `$BWT/fork-mirror` in place (the user's runbook serves it). Delete `$P6/throwaway-home` and `$P6/forkx`.

### Task 13: Handoff

- [ ] **Step 1:** Restate the runbook below with the real `FORK_VERSION`, `BASE_VERSION`, mirror path and port filled in, in the final handoff message (the user executes it; no runbook file is written to the repo).
- [ ] **Step 2:** Report: Part 1 results per item with evidence paths from `$EVID/INDEX.txt`; Part 2 artifact path and SHA-256; rehearsal output; the dev home and build worktree locations; confirmation that every process P6 started is stopped (list PIDs and their final state).

---

## User runbook: switch the daily T3 to the fork build

For the user to run, after the agent reports Part 1 passed and Part 2's rehearsal succeeded. Values below are the ones at `2ca9e43bb`; the agent's handoff restates them if they changed.

- Base nightly: `0.0.46-nightly.20261011.2980`
- Fork build: `0.0.46-nightly.20261011.902980`
- Mirror: `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build/fork-mirror` on `http://127.0.0.1:47811`

**R0. Use a terminal outside T3.** Restarting the service kills every T3 terminal and agent turn, including a `t3 update` run from one. Open a normal desktop terminal (Konsole etc.) and check:

```sh
grep -c t3code.service /proc/$$/cgroup
```

It must print `0`. Also let running agent turns finish first.

**R1. Move to the base nightly first** (the exact version, not just the channel, so the DB schema matches the fork, which adds no migrations):

```sh
t3 update 0.0.46-nightly.20261011.2980
```

Answer `y` to restarting the background service. Expect `Installed T3 Code 0.0.46-nightly.20261011.2980` and `Background service restarted on ...`. On first start the nightly creates `~/.t3/userdata/statev2.sqlite` from your `state.sqlite`, which it leaves untouched. Use T3 normally for a few minutes. If you already moved to a newer nightly, tell the agent the version before continuing: the fork would then be a downgrade.

**R2. Start the fork mirror** in a second outside terminal and leave it running:

```sh
python3 -m http.server 47811 --bind 127.0.0.1 --directory /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build/fork-mirror
```

**R3. Install the fork build** in the first terminal:

```sh
T3CODE_RELEASE_BASE_URL=http://127.0.0.1:47811 t3 update 0.0.46-nightly.20261011.902980
```

Answer `y` to the restart. Expect `0.0.46-nightly.20261011.2980 → 0.0.46-nightly.20261011.902980 (nightly)`, `Installed T3 Code 0.0.46-nightly.20261011.902980`, `Run t3 to get started.`, `Background service restarted on 0.0.46-nightly.20261011.902980`. Then stop the mirror (Ctrl-C in its terminal). The environment variable applies to that one command only.

**R4. Check:**

```sh
t3 --version
systemctl --user status t3code.service --no-pager | head -5
cat ~/.t3/runtime/service-state.json
```

Expect `t3 v0.0.46-nightly.20261011.902980`, `active (running)`, and `"activeVersion": "0.0.46-nightly.20261011.902980"`. In the T3 UI: a Claude thread's header shows the pacing rows; Settings shows a "Usage pacing" section; Settings → Connections still shows your T3 Connect link.

**Staying on the fork.** A plain `t3 update` (nightly channel) moves you off the fork as soon as a newer official nightly exists, and so does accepting "Update server" from a client. Both drop the feature; reinstall with R2-R3 (a new fork build if the branch was rebased).

**Rollback.**

- To the base nightly (DB compatible, nothing lost): `t3 update 0.0.46-nightly.20261011.2980 --allow-downgrade`. It is already on disk, so nothing downloads; answer `y` to the restart.
- To stable 0.0.45: `t3 update 0.0.45 --allow-downgrade`. 0.0.45 reads the V1 `state.sqlite`, so threads and settings changed while on the nightly or fork are not visible there. They stay in `statev2.sqlite` and come back if you move to the nightly again.
- If `t3` itself will not start: `ln -sfn ~/.t3/runtime/versions/0.0.46-nightly.20261011.2980/t3 ~/.local/bin/t3`, then `t3 service install --allow-downgrade` (it pins the service to the version of the `t3` you run).
- After a rollback you may delete `~/.t3/runtime/versions/0.0.46-nightly.20261011.902980`, and ask the agent to remove the build worktree (`git worktree remove /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build`).

---

## Open questions / spec deviations

1. **CLI calls need an explicit `--base-dir` (index §1 P6 wording).** Context: the index says "re-pair via `node apps/server/src/bin.ts pair`". `pair` searches the worktree's `.t3` first, but falls back to `T3CODE_HOME` or `~/.t3` (`discoverPairTarget`, `apps/server/src/cli/pair.ts:239`), and `project add` / `query` resolve straight to `~/.t3` without the flag (`resolveBaseDir`, `os-jank.ts:105`). An agent running under the T3 service inherits `T3CODE_HOME=/home/jorgen/.t3`. Options: (a) rely on discovery; (b) always pass `--base-dir`. Recommendation: (b), followed here; fix the index wording to `node apps/server/src/bin.ts pair --base-dir <dev home>`.

2. **Dev state lives in a fresh scratch home, not the worktree's `.t3` (contract §1 P6 deviation).** Context: the worktree `.t3` already holds a project rooted at `<worktree>/apps/server` (real agent turns there could edit the repo), the index route opens a draft for the most recent project (so a second project makes thread placement ambiguous), and item 5 needs to restart a server that P6 owns, while another session's dev server may already hold the worktree `.t3`. Options: (a) worktree `.t3`; (b) `vp run dev --home-dir <scratchpad>/p6/t3home`, the same worktree code with its own isolated state. Recommendation: (b), followed here. It is still "isolated `.t3` state" per spec §7. Ports shift if the default ones are taken; they are read from the `[dev-runner]` line.

3. **Part 2 builds in a detached throwaway worktree (contract §5 deviation).** Context: the build must rewrite four `package.json` versions (`update-release-package-versions.ts`), which would dirty the integration worktree (merges need it clean) and could disturb a dev server running from it. Recommendation: build in `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-build`, detached at the validated SHA, no branch. It doubles as the persistent home of the mirror the user's runbook serves, so it is removed only after the user switched or rolled back.

4. **Fork version scheme (affects the user's later `t3 update` behaviour).** Context: the version must be a new directory name (a reused one counts as already installed), must make `t3 --version` match what installers verify, and decides which channel plain `t3 update` follows. Options: (a) nightly-shaped `<base core>-nightly.<base date>.<900000 + base run + k>`, e.g. `0.0.46-nightly.20261011.902980`: channel `nightly`, sorts above every official nightly of the base date and below the next date's, so plain `t3 update` leaves the fork only for a newer official nightly; (b) a custom prerelease such as `0.0.46-usagepacing.1`: channel `stable`, plain `t3 update` refuses (0.0.45 is "older") until 0.0.46 stable ships, but it also sorts above every 0.0.46 nightly, so returning to the nightly needs `--allow-downgrade`. Recommendation: (a), followed here, because the user follows the nightly and wants `t3 update` to behave like a nightly install once they leave the fork. Decision for the user if they prefer the fork to be sticky.

5. **The fork build embeds upstream's public T3 Connect config, but not upstream's tracing token.** Context: the user's install is linked to T3 Connect; release CI embeds `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` at build time (`apps/server/vite.config.ts` defines, `scripts/lib/public-config.ts`), and a local build without them has no relay or sign-in. They are public (in every shipped binary and client bundle), so Task 10 extracts them from the official base archive. The relay-client OTLP tracing URL/dataset/token are omitted: they send upstream's telemetry and nothing breaks without them. Recommendation: as followed. Open for the user: whether connecting a fork build to upstream's relay is acceptable to them (it is the same relay their current install uses).

6. **Fix branches no longer exist when P6 runs (contract §5 gap).** Context: §5 says fixes P6 finds are "follow-up commits on the owning plan's branch", but its own procedure removes each child worktree and deletes its branch after the full merge. Recommendation: the orchestrator recreates a fix branch from the integration head, `git worktree add -b feat/usage-pacing-<id>-fix /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-<id>-fix feat/usage-pacing`, applies the fix with that plan's verification commands and review policy, and merges it with `git merge --no-ff feat/usage-pacing-<id>-fix -m "merge: <plan id> fix"`.

7. **Spec §7 item 1: the header rows show no percentage.** Context: §3.1 rows are label, bar, burn, reset; the `62%` text exists only in the popover (§3.2). Recommendation (C-level spec fix): item 1 reads "The header shows 5h/7d rows, and the popover's percentages match `/usage` and the provider snapshot". Followed here (Task 3 compares popover, `/usage`, wire snapshot and provider log).

8. **Spec §7 items 2 and 5 depend on where the 5 h window is.** Context: the linear fallback produces a session burn as soon as 1800 s of the window have elapsed, with or without history (§4.2), so "after enough samples, the session burn appears" is only observable from a blank state in the first 30 minutes of a window, and "the burn returns to the linear fallback" after a restart only holds past 1800 s (before that the cell is blank). Recommendation (C-level spec fix): item 2 becomes "the session window carries a growing history and the session burn matches the EWMA over it"; item 5 becomes "the history restarts empty and the session burn matches the linear fallback, or is blank in the window's first 30 minutes". Followed here (Tasks 4 and 7 assert against P1's maths for whichever case applies).

9. **`test-t3-app` forbids other automation.** Context: the repo skill says to stop if the Browser panel is unavailable. The user approved Playwright + headless Chrome for this run (binding decision). No change to the skill; recorded so a reviewer does not flag it.

10. **No `cargo` on this machine.** Context: the archive needs `t3-resource-monitor`; release CI compiles it. Recommendation: take it from the official base archive (exact match for the base; `native/resource-monitor` is unchanged since `v0.0.45`). Followed in Task 10. If the fork ever changes `native/resource-monitor`, install Rust and run `vp run build:resource-monitor` instead.

11. **Moving to "the nightly channel" should pin the base nightly (user decision context).** Context: `t3 update --channel nightly` installs the newest nightly at that moment, which may be newer than the fork's base and carry DB migrations the fork lacks; installing the fork afterwards would be a downgrade over a newer schema. Recommendation: runbook R1 installs the exact base nightly (`t3 update 0.0.46-nightly.20261011.2980`). If the user already moved to a newer nightly, the fork should first be rebased onto that nightly and rebuilt.
