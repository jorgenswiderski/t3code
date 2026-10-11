# Usage Pacing P1: Shared Pacing Maths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@t3tools/shared/usagePacing`: pure, framework-free burn, schedule, context-tier, cache-warmth and formatting functions that the web header widget and the thread context glyph (and later mobile) consume.

**Architecture:** One new module, `packages/shared/src/usagePacing.ts`, plus its test file and one `package.json` subpath export. It is a port of the Claude Code statusline's `burn-tier`, `burn-rate`, `weekly-burn`, `cache-warmth` and `colors` models (read-only source: `/home/jorgen/Code/statusline/src`), with the statusline's inputs reshaped from strings/rows to typed values, Sat/Sun replaced by a configurable work-day set, and cache identity reduced to model/effort/fastMode. No React, no I/O, no timers; "now" is always an argument.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `@effect/vitest` run through `vp test run`, `Intl` for host clock-style detection only. Types from `@t3tools/contracts` (`ModelSelection`, `TimestampFormat`), helpers from `./model.ts`, `./usageLimits.ts`, `./Array.ts`.

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` (section 4 in full, section 3.3 tooltip, section 6 degraded states). Shared contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` (section 6.1 is the exact export list; section 9 items C1, C3, C5, D5 apply).

## Implementation Location

- **Branch:** `feat/usage-pacing-p1-shared`
- **Worktree:** `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p1-shared`
- **Base branch:** `feat/usage-pacing`

## Global Constraints

- Public surface is **exactly** index section 6.1: no extra exports (P4/P5 import nothing else; knip flags unused exports). Internal constants and helpers stay unexported. Type exports are free of knip (`"types": "off"`), but still listed exactly.
- Statusline constants, copied verbatim: half-life `1800` s, idle cap `3600` s, minimum observation `90` s, fallback minimum elapsed `1800` s, default session window `18000` s, default non-session window `604800` s, weekly minimum elapsed fraction `0.02`.
- Burn ladder: `roundBurn(x) = round(x * 10 + 1e-9) / 10`; tiers green `<= greenCut` (default `1.0`), yellow `<= 1.15^exponent`, orange `<= 1.3^exponent`, else red; callers tier off the **rounded** burn; `exponent === 1` takes the flat-threshold fast path.
- Context tiers (spec 4.4): percentage `>= 50` yellow, `>= 65` orange, `>= 80` red; absolute tokens `>= 200_000` yellow, `>= 300_000` orange, `>= 400_000` red; severity is the max.
- Cache: expiring when `expiry - now <= min(600_000 ms, ttl / 4)` (`<=`, index C3); cold when `now >= expiry` or identity mismatch; identity fields model, effort, fastMode; a field absent (or empty string) on either side is skipped; model compared with a trailing `[...]` stripped.
- Units: the ported low-level functions (`scheduleWeight`, `computeSessionBurn`, `weeklyElapsedFraction`, `computeWeeklyBurn`) take epoch **seconds** so statusline tests port one-to-one; everything else takes epoch **milliseconds** and ISO strings as on the wire.
- Non-work days weigh `0`; work-day seconds outside work hours weigh `offHoursWeight`; work-hours seconds weigh `1`. Default work hours `09:00-17:00`, work days `[1,2,3,4,5]` (0 = Sunday), off-hours weight `0.2`.
- Repo rules: relative imports use the `.ts` extension; no `Array#toSorted`/`toReversed` (Hermes, mobile reuse), copy then `.sort` or use `copySorted` from `./Array.ts`; tests use `it.each` not loops (`t3code/no-test-in-loop`); every `@effect-diagnostics` pragma carries a ` -- reason` (`t3code/require-suppression-reason`); `new Date(...)` needs `// @effect-diagnostics globalDate:off -- <reason>` on line 1 of both new files (precedent: `usageFormat.ts`, `usageFormat.test.ts`).
- Does not edit `packages/shared/src/usageLimits.ts` (imports `formatDuration` from it). No web, server or contracts changes.
- Do not run repo-wide checks (AGENTS.md "Verifying").

## Review Focus

Inputs the spec implies but the ported statusline tests do not exercise, most likely first. Each has a pinning test in the task named in brackets.

1. **Stale snapshot after the window reset** (`resetsAt <= now`): burn and tick must be `null`, not a negative-remaining projection or a tick past 100 %. [Task 6]
2. **No history at all** (upstream server without `history`, or just after a restart): session burn must fall back to `used / elapsed`, not go blank (index section 4, spec 5.2). The statusline returned null here. [Task 3, Task 6]
3. **Client clock behind the server** (remote servers are first-class): a newest sample timestamped a few seconds in the client's future must still count. [Task 3]
4. **Malformed or hostile settings** reaching `resolveWorkSchedule`: garbage hours, `[]` / out-of-range / fractional / duplicate work days, `NaN`/`Infinity` weight. Must never throw or hang; an empty work-day set must give a null weekly burn and tick. [Task 2, Task 6]
5. **Absurd `windowDurationMins`** (`0`, `NaN`, millions): `scheduleWeight` walks one iteration per local day, so an unbounded window would freeze the UI thread. Falls back to the default length. [Task 6]
6. **DST and half-hour zones**: 23- and 25-hour work days, `Asia/Kolkata`, `Pacific/Auckland`; the whole suite must pass under several ambient `TZ` values. [Tasks 2, 3, 7]
7. **Context tier edge inputs**: `maxTokens` null/0, `usedTokens > maxTokens`, exact threshold percentages (float error must not move a boundary). [Task 1]

---

## File structure

| File                                      | Action | Responsibility                                                                                                                                                                                                                     |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/usagePacing.ts`      | create | All maths and formatters, sections in this order: burn ladder and palettes; work schedule; session/weekly burn; context tier; clocks and formatters; request identity and cache warmth; tooltip; per-window pace; roles and labels |
| `packages/shared/src/usagePacing.test.ts` | create | Ported statusline tests plus new coverage                                                                                                                                                                                          |
| `packages/shared/package.json`            | modify | Add the `./usagePacing` subpath export directly after `"./usageLimits"` (block at lines 350-353 at base commit `2ca9e43bb`; re-locate by symbol)                                                                                   |

Reuse, do not duplicate: `formatDuration` (`usageLimits.ts` line ~596, floors to `3d 21h` / `1h 52m` / `4m`), `getModelSelectionStringOptionValue` and `getModelSelectionBooleanOptionValue` (`model.ts` lines ~72 and ~79), `copySorted` (`Array.ts`). Do **not** reuse `elapsedShare`/`paceOf` from `usageLimits.ts` (different semantics, used by the Limits page) and leave `apps/web/src/lib/contextWindow.ts` `formatContextWindowTokens` alone (lowercase `m`, different rounding; see Open questions item 10).

The port sources, for reference while implementing (all read-only): `models/burn-tier.ts`, `models/burn-rate.ts` (`computeBurn`), `models/weekly-burn.ts` (`scheduleWeight`, `computeWeeklyBurn`), `models/cache-warmth.ts`, `util/colors.ts` (`usageRank`, `tokenRank`), `config.ts` (`parseActiveHours`), and the colocated `*.test.ts`. The statusline's `usage-envelope` / `pool-swap` / `transcript` machinery is deliberately not ported (spec 5.2); neither are `liveState`, `hasCurrentUsage` or the `version` identity field.

---

## Task 0: Create the child worktree

**Files:** none (git only).

- [ ] **Step 1: Create the worktree and install**

Exact procedure from index section 5 (use `builtin cd` and `;`, never `&&` after `cd`: the user's shell wraps `cd` via fnm and returns 127):

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing; git worktree add -b feat/usage-pacing-p1-shared /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p1-shared feat/usage-pacing
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p1-shared; T3CODE_PROJECT_ROOT=/home/jorgen/Code/t3code PATH="/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing/node_modules/.bin:$PATH" node scripts/setup-worktree.ts
```

If the orchestrator already created it, skip. Every later command runs from the child worktree root with `PATH="$PWD/node_modules/.bin:$PATH"` (`vp` is not on the global PATH).

- [ ] **Step 2: Baseline**

```sh
builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p1-shared; PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/dateTime.test.ts
```

Expected: `1 passed`. Then `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/shared#typecheck`; expected output is one pre-existing suggestion, `src/symlink.ts(29,9) ... TS377114`. That line is baseline noise; any diagnostic naming `usagePacing` is yours to fix.

---

## Task 1: Module scaffold, burn ladder, tier palettes, context tier

**Files:**

- Create: `packages/shared/src/usagePacing.ts`, `packages/shared/src/usagePacing.test.ts`
- Modify: `packages/shared/package.json` (export after `"./usageLimits"`)

**Interfaces:**

- Produces (index 6.1, signatures verbatim): `PaceTier`, `BURN_TIER_YELLOW = 1.15`, `BURN_TIER_ORANGE = 1.3`, `roundBurn`, `burnTier`, `PaceTierColor`, `BURN_TIER_COLORS`, `CONTEXT_TIER_COLORS`, `formatBurn`, `contextTier`, `contextFraction`.

**Source to port:** `burn-tier.ts` (copy `roundBurn`, `burnTier` and the long comment on the `+1e-9` nudge; rename `TIER_YELLOW/TIER_ORANGE` to `BURN_TIER_YELLOW/BURN_TIER_ORANGE`, return type `PaceTier`). `colors.ts` `usageRank`/`tokenRank` become `contextTier`.

File header (line 1, then the module doc):

```ts
// @effect-diagnostics globalDate:off -- Schedule weighting and clock labels read the viewer's local calendar fields.
/**
 * Pure usage-pacing maths shared by web (and later mobile): burn projection, work-schedule
 * weighting, context tiers, prompt-cache warmth and their formatters. Ported from the
 * Claude Code statusline; no React, no I/O, no timers.
 *
 * @module usagePacing
 */
```

`package.json` entry (insert after the `"./usageLimits"` block):

```json
    "./usagePacing": {
      "types": "./src/usagePacing.ts",
      "import": "./src/usagePacing.ts"
    },
```

Palettes are data, not CSS: `BURN_TIER_COLORS = { 0: "success", 1: "yellow", 2: "orange", 3: "destructive" }`, `CONTEXT_TIER_COLORS = { 0: "muted", 1: "yellow", 2: "orange", 3: "destructive" }`, typed `Readonly<Record<PaceTier, PaceTierColor>>`.

`formatBurn(burn)` = `` `${burn.toFixed(1)}x` ``.

`contextFraction({usedTokens, maxTokens})`: `null` when `maxTokens` is `null`/`undefined`/`<= 0`/non-finite; else `used / max` clamped to `[0, 1]` (non-finite or negative `used` counts as 0).

`contextTier` is a spot where a plausible implementation is wrong (float division moves a boundary: `0.29 * 100 === 28.999999999999996`). The statusline's "integer part of the percentage `>= T`" is exactly "`percentage >= T`" for integer `T`, which integer arithmetic decides without division:

```ts
function maxTier(a: PaceTier, b: PaceTier): PaceTier {
  return a >= b ? a : b;
}

export function contextTier(usage: {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}): PaceTier {
  const used = Number.isFinite(usage.usedTokens) && usage.usedTokens > 0 ? usage.usedTokens : 0;
  const tokenTier: PaceTier = used >= 400_000 ? 3 : used >= 300_000 ? 2 : used >= 200_000 ? 1 : 0;
  const max = usage.maxTokens;
  if (max === null || max === undefined || !(max > 0)) return tokenTier;
  // used / max * 100 >= T  <=>  used * 100 >= T * max; exact for integer token counts.
  const percentTier: PaceTier =
    used * 100 >= 80 * max ? 3 : used * 100 >= 65 * max ? 2 : used * 100 >= 50 * max ? 1 : 0;
  return maxTier(percentTier, tokenTier);
}
```

The percentage tier applies whenever `maxTokens > 0` (spec 4.4: "more severe of two tiers"); without a usable `maxTokens` only the token tier applies.

- [ ] **Step 1: Write the failing tests** in `usagePacing.test.ts`. File header: line 1 `// @effect-diagnostics globalDate:off -- Fixtures build local-time instants to exercise DST and zone handling.`; `import { afterEach, describe, expect, it, vi } from "@effect/vitest";` (it re-exports `vi`; precedent for `vi.stubEnv("TZ", ...)`: `usageFormat.test.ts`, `customSnooze.test.ts`); `import * as UsagePacing from "./usagePacing.ts";` is added in Task 7. Port `burn-tier.test.ts` one-to-one (rename `TIER_*` to `BURN_TIER_*`, `it.each` is not needed there). Then:

`roundBurn` / `burnTier` (ported):

| call                                                                             | expected                 |
| -------------------------------------------------------------------------------- | ------------------------ |
| `roundBurn(1.23)`, `roundBurn(1.26)`                                             | `1.2`, `1.3`             |
| `roundBurn(1.35)`, `roundBurn(0.45)`                                             | `1.4`, `0.5` (tie nudge) |
| `burnTier(0.1)`, `(1.0)`, `(1.1)`, `(1.15)`, `(1.2)`, `(1.3)`, `(1.4)`           | `0,0,1,1,2,2,3`          |
| `burnTier(1.0000001)`, `(1.15 + 1e-9)`, `(1.3 + 1e-9)`                           | `1, 2, 3`                |
| `burnTier(1.05, 1.05)`, `(1.06, 1.05)`, `(1.2, 1.05)`                            | `0, 1, 2`                |
| `burnTier(1.15, 1.0, 1.5)`, `(1.2, 1.0, 1.5)`, `(1.3^1.5 + 1e-9, 1.0, 1.5)`      | `1, 1, 3`                |
| `burnTier(b, 1.0, 1)` equals `burnTier(b)` for `[0.5,1.0,1.15,1.2,1.3,1.31,2.0]` | equal                    |

Palettes and formatBurn:

| call                                      | expected                                              |
| ----------------------------------------- | ----------------------------------------------------- |
| `BURN_TIER_COLORS`                        | `{0:"success",1:"yellow",2:"orange",3:"destructive"}` |
| `CONTEXT_TIER_COLORS`                     | `{0:"muted",1:"yellow",2:"orange",3:"destructive"}`   |
| `formatBurn(1.2)`, `(1)`, `(0.4)`, `(12)` | `"1.2x"`, `"1.0x"`, `"0.4x"`, `"12.0x"`               |

`contextTier` (`it.each`; `[used, max]`):

| used, max                                                 | tier                  | why                         |
| --------------------------------------------------------- | --------------------- | --------------------------- |
| 0, 1_000_000                                              | 0                     |                             |
| 199_999, 1_000_000                                        | 0                     | just under token tier 1     |
| 200_000, 1_000_000                                        | 1                     | token tier, 20 %            |
| 300_000, 1_000_000                                        | 2                     | token tier                  |
| 399_999, 1_000_000                                        | 2                     |                             |
| 400_000, 1_000_000                                        | 3                     | token tier                  |
| 99_999, 200_000                                           | 0                     | 49.9995 %                   |
| 100_000, 200_000                                          | 1                     | 50 % exactly                |
| 129_999, 200_000                                          | 1                     | 64.9995 %                   |
| 130_000, 200_000                                          | 2                     | 65 % exactly                |
| 159_999, 200_000                                          | 2                     |                             |
| 160_000, 200_000                                          | 3                     | 80 % exactly                |
| 49, 100 / 50, 100 / 64, 100 / 65, 100 / 79, 100 / 80, 100 | 0 / 1 / 1 / 2 / 2 / 3 | small-number exactness      |
| 250_000, 200_000                                          | 3                     | used above max, 125 %       |
| 199_999, undefined                                        | 0                     | no max: token tier only     |
| 200_000, null                                             | 1                     |                             |
| 400_000, 0                                                | 3                     | max 0 is treated as missing |
| 1_000_000, null                                           | 3                     |                             |
| NaN, 1_000_000 / -5, 100                                  | 0 / 0                 | hostile input               |

`contextFraction`: `(380_000, 1_000_000)` is `0.38`; `(2, 1)` is `1`; `(-5, 100)` is `0`; `(5, null)`, `(5, undefined)`, `(5, 0)` are `null`.

- [ ] **Step 2: Run, expect failure**

```sh
PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
```

Expected: FAIL (module `./usagePacing.ts` not found, until you create it with the header only; then `... is not a function`).

- [ ] **Step 3: Implement** the section above (header, `PaceTier`, constants, `roundBurn`, `burnTier`, palettes, `formatBurn`, `contextTier`, `contextFraction`) and add the `package.json` export.
- [ ] **Step 4: Run, expect pass** (same command). Also `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/shared#typecheck` shows no `usagePacing` diagnostic.
- [ ] **Step 5: Commit**

```sh
git add packages/shared/package.json packages/shared/src/usagePacing.ts packages/shared/src/usagePacing.test.ts
git commit -m "feat(shared): usage pacing burn ladder and context tiers"
```

Commit bodies end with the attribution line your harness specifies (AGENTS.md "Pull requests" convention applies to commit style: conventional title, plain language).

---

## Task 2: Work schedule (parse, format, resolve, weigh)

**Files:** modify `usagePacing.ts`, `usagePacing.test.ts`.

**Interfaces:**

- Consumes: nothing new.
- Produces: `WorkHours`, `WorkSchedule`, `DEFAULT_WORK_HOURS = "09:00-17:00"`, `DEFAULT_WORK_DAYS = [1,2,3,4,5]`, `DEFAULT_OFF_HOURS_WEIGHT = 0.2`, `parseWorkHours`, `formatWorkHours`, `resolveWorkSchedule`, `scheduleWeight` (all index 6.1 verbatim).

**`parseWorkHours(value)`** ports `parseActiveHours` (`config.ts` lines 12-19) but returns `null` instead of a default (the default lives in `resolveWorkSchedule`). Regex after `trim()`: `/^(\d{1,2})(?::([0-5]\d))?-(\d{1,2})(?::([0-5]\d))?$/`; `startMin = h1 * 60 + (m1 ?? 0)`, `endMin = h2 * 60 + (m2 ?? 0)`. Reject (`null`) when either exceeds `1440` (as the statusline), **and** when `startMin === 1440` (contract range `0..1439`). Normalise `endMin === 0` to `1440` (the contract range is `1..1440`; "22:00-00:00" is the natural way to say "until midnight", and the two are equivalent under the wrap rule: end 0 wraps to "start..midnight plus nothing", which is the same set of seconds as end 1440). An end at or before the start is kept as written (it wraps).

**`formatWorkHours({startMin, endMin})`**: `HH:MM-HH:MM` zero-padded, `endMin = 1440` prints `24:00`; `parseWorkHours(formatWorkHours(x))` round-trips.

**`resolveWorkSchedule(settings)`** returns `WorkSchedule`: `parseWorkHours(workHours)` or, when that is `null`, the private constant `{ startMin: 540, endMin: 1020 }` (the value `DEFAULT_WORK_HOURS` parses to; a test asserts the two agree); `workDays` = unique integers `0..6` from the input, sorted ascending (`Number.isInteger` filter, so `2.5`, `7`, `-1`, `NaN` drop); `offHoursWeight` = `DEFAULT_OFF_HOURS_WEIGHT` when `NaN`, else clamped to `[0, 1]` (so `Infinity` is `1`, `-Infinity` is `0`). A malformed field falls back for that field alone.

**`scheduleWeight(fromSec, toSec, schedule)`** is the DST-safe spot. Port `weekly-burn.ts` lines 25-76 with exactly two changes: the Sat/Sun branch becomes `schedule.workDays.includes(d.getDay())` (non-work days add nothing), and field names are `offHoursWeight` / `workDays`. Keep the `localMin` normalisation trick and the day-walk; do not "simplify" to `cursor += 86400` or `Math.floor(sec / 86400)`:

```ts
// Minutes past local midnight on a local calendar day, as epoch seconds. The Date constructor
// normalises an out-of-range minute (1440 = next local midnight) BEFORE resolving the zone,
// which keeps 23- and 25-hour DST days correct.
function localMin(y: number, m: number, d: number, min: number): number {
  return new Date(y, m, d, 0, min, 0, 0).getTime() / 1000;
}

function overlap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

export function scheduleWeight(fromSec: number, toSec: number, schedule: WorkSchedule): number {
  if (!(toSec > fromSec)) return 0;
  let total = 0;
  let cursor = fromSec;
  while (cursor < toSec) {
    const d = new Date(cursor * 1000);
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const segEnd = Math.min(localMin(y, m, day, 1440), toSec);
    if (schedule.workDays.includes(d.getDay())) {
      // Every work-day second earns offHoursWeight; work-hours seconds earn the remainder on
      // top, so only the work-hours overlap is needed, not its complement.
      const active =
        schedule.endMin > schedule.startMin
          ? overlap(
              cursor,
              segEnd,
              localMin(y, m, day, schedule.startMin),
              localMin(y, m, day, schedule.endMin),
            )
          : // wraps past midnight (20:00-02:00): this calendar day's head and tail
            overlap(cursor, segEnd, localMin(y, m, day, 0), localMin(y, m, day, schedule.endMin)) +
            overlap(
              cursor,
              segEnd,
              localMin(y, m, day, schedule.startMin),
              localMin(y, m, day, 1440),
            );
      total += schedule.offHoursWeight * (segEnd - cursor) + (1 - schedule.offHoursWeight) * active;
    }
    cursor = segEnd;
  }
  return total;
}
```

- [ ] **Step 1: Write the failing tests.**

Fixtures (test-local, not exported; index section 8): `localSec(y, m, d, h = 0, min = 0) = Math.trunc(new Date(y, m, d, h, min, 0, 0).getTime() / 1000)`. Anchors for the week of 2026-07-06 (July has no DST in common zones): `MON = localSec(2026,6,6)`, `FRI = (2026,6,10)`, `SAT = (2026,6,11)`, `SUN = (2026,6,12)`, `NEXT_MON = (2026,6,13)`, `DAY = 86400`. Schedules: `ALL_DAY = {startMin:0,endMin:1440,offHoursWeight:0,workDays:[1,2,3,4,5]}` (reproduces the statusline's old business-days mask); `WORK_HOURS = {startMin:630,endMin:1170,offHoursWeight:0.2,workDays:[1,2,3,4,5]}`. Add `afterEach(() => vi.unstubAllEnvs())` at file top level.

`parseWorkHours` (`it.each`):

| input                                                                                                        | expected                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `"10:30-19:30"`                                                                                              | `{630, 1170}`                                   |
| `"9-17"`                                                                                                     | `{540, 1020}`                                   |
| `"09:00-17:00"`                                                                                              | `{540, 1020}`                                   |
| `"00:00-24:00"`                                                                                              | `{0, 1440}`                                     |
| `"20:00-02:00"`                                                                                              | `{1200, 120}` (wrap kept as written)            |
| `" 9-17 "`                                                                                                   | `{540, 1020}` (trimmed)                         |
| `"22:00-00:00"`                                                                                              | `{1320, 1440}` (end 0 normalised)               |
| `"00:00-00:00"`                                                                                              | `{0, 1440}`                                     |
| `"09:00-09:00"`                                                                                              | `{540, 540}` (equal means wrap, i.e. whole day) |
| `""`, `"nonsense"`, `"9:99-17:00"`, `"25:00-26:00"`, `"9-17-19"`, `"24:00-02:00"`, `"9-25"`, `"24:30-25:00"` | `null`                                          |

`formatWorkHours`: `{540,1020}` is `"09:00-17:00"`; `{630,1170}` `"10:30-19:30"`; `{0,1440}` `"00:00-24:00"`; `{1200,120}` `"20:00-02:00"`; round-trip for those four.

`resolveWorkSchedule` (`toEqual`):

| input `{workHours, workDays, offHoursWeight}`      | expected                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `"10:30-19:30"`, `[1,2,3,4,5]`, `0.35`             | `{startMin:630,endMin:1170,workDays:[1,2,3,4,5],offHoursWeight:0.35}`                                                |
| `"nonsense"`, `[1,2,3,4,5]`, `0.2`                 | start/end `540/1020`, other fields untouched                                                                         |
| `"9-17"`, `[5,1,1,7,-1,2.5,3]`, `0.2`              | `workDays: [1,3,5]`                                                                                                  |
| `"9-17"`, `[]`, `0.2`                              | `workDays: []`                                                                                                       |
| `"9-17"`, `[1]`, `NaN` / `1.5` / `-1` / `Infinity` | `0.2` / `1` / `0` / `1`                                                                                              |
| constants                                          | `DEFAULT_WORK_HOURS === "09:00-17:00"`, `DEFAULT_WORK_DAYS` equals `[1,2,3,4,5]`, `DEFAULT_OFF_HOURS_WEIGHT === 0.2` |

`scheduleWeight` with `ALL_DAY` (ported `businessWeight` suite; same expectations):

| from, to                                                                              | expected         |
| ------------------------------------------------------------------------------------- | ---------------- |
| guard: `new Date(MON*1000).getDay()` is `1`, `SAT` is `6`                             |                  |
| `MON, SAT` and `MON, NEXT_MON`                                                        | `5 * DAY`        |
| `SAT, NEXT_MON`                                                                       | `0`              |
| `MON, localSec(2026,6,6,6)`                                                           | `6 * 3600`       |
| `MON, SAT` equals `MON, localSec(2026,6,12)`                                          | equal            |
| `localSec(2026,6,11,12), localSec(2026,6,13,6)`                                       | `6 * 3600`       |
| `MON, MON` and `FRI, MON`                                                             | `0`              |
| DST (stub `TZ` = `America/Los_Angeles`): `localSec(2026,9,26), localSec(2026,10,2,1)` | `5 * DAY + 3600` |

Every DST or zone-specific row calls `vi.stubEnv("TZ", ...)` first and computes its `localSec(...)` instants **inside the test body, after the stub**; module-level anchors (`MON`, `SAT`, ...) are evaluated at import in the ambient zone and must only be used by rows that run in that zone.

With `WORK_HOURS` (ported profile suite; the statusline's weekend floor `0.1` becomes `0` because non-work days weigh 0). `DAY_WEIGHT = 0.8*9*3600 + 0.2*86400 = 43200`. Use `toBe` for integers and `toBeCloseTo(x, 6)` for fractional sums:

| case                                                                                       | expected                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| full Monday `MON, localSec(2026,6,7)`                                                      | `43200`                                           |
| `MON, localSec(2026,6,6,12)` (half-hour boundary, 10:30-12:00 active plus 12 h floor)      | `12960` (= `0.8*5400 + 0.2*43200`)                |
| weekend `SAT, NEXT_MON`                                                                    | `0`                                               |
| wrap schedule `{startMin:1200,endMin:120,offHoursWeight:0.2,workDays:[1..5]}`, full Monday | `34560` (= `0.8*6*3600 + 0.2*86400`)              |
| `offHoursWeight: 1` flat                                                                   | `DAY` for a full Monday                           |
| `WORK_HOURS` over the DST week `localSec(2026,9,26)..localSec(2026,10,2,1)` (TZ LA)        | `216720` (= `5*43200 + 720`; Sat and Sun weigh 0) |

New, configurable work days:

| case                                                                                                                             | expected                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ALL_DAY` with `workDays:[0,1,2,3,4]` over `localSec(2026,6,5)` (Sun) to `SUN`                                                   | `5 * DAY`                                                                   |
| same schedule over `FRI, NEXT_MON` (Fri and Sat off, Sun on)                                                                     | `DAY`                                                                       |
| `ALL_DAY` with `workDays: []` over `MON, NEXT_MON`                                                                               | `0`                                                                         |
| `ALL_DAY` with `workDays:[0]` over Sun 2026-11-01 00:00 to Mon 00:00 (`localSec(2026,10,1)`, `(2026,10,2)`), TZ LA (25-hour day) | `25 * 3600`                                                                 |
| same for Sun 2026-03-08 (`(2026,2,8)`, `(2026,2,9)`), TZ LA (23-hour day)                                                        | `23 * 3600`                                                                 |
| `WORK_HOURS` with `workDays:[0..6]`, Sun 2026-11-01 whole day, TZ LA                                                             | `43920` (= `0.8*32400 + 0.2*90000`: 10:30-19:30 is 9 h after the fall-back) |
| `WORK_HOURS` with `workDays:[0..6]` over the DST week `(2026,9,26)..(2026,10,2,1)`, TZ LA                                        | `303840`                                                                    |

- [ ] **Step 2: Run, expect failure** (`... is not a function`).
- [ ] **Step 3: Implement** the section above.
- [ ] **Step 4: Run, expect pass**; run once more with `TZ=Asia/Kolkata` prefixed to prove the non-DST rows are ambient-zone independent.
- [ ] **Step 5: Commit** `feat(shared): usage pacing work-schedule weighting`.

---

## Task 3: Session burn, weekly elapsed fraction, weekly burn

**Files:** modify `usagePacing.ts`, `usagePacing.test.ts`.

**Interfaces:**

- Consumes: `roundBurn`, `burnTier`, `scheduleWeight`, `WorkSchedule`, `PaceTier`.
- Produces: `BurnResult`, `computeSessionBurn`, `weeklyElapsedFraction`, `computeWeeklyBurn` (index 6.1 verbatim).

**`computeSessionBurn`** is a port of `burn-rate.ts` `computeBurn` with the constants as module-private `const`s (`HALF_LIFE_SEC = 1800`, `IDLE_CAP_SEC = 3600`, `MIN_OBS_SEC = 90`, `FALLBACK_MIN_ELAPSED_SEC = 1800`). Changes from the source, each deliberate (Open questions items 1-3):

1. Input is `{nowSec, usedPercent, resetsAtSec, windowSec, samples: [{atSec, usedPercent}]}`; there is no string parsing, no `windowSeries` (the server already scoped history to the current `resetsAt`, index 6.2), no envelope.
2. The statusline's `if (n < 1) return null` is **removed**: with zero samples the interval loop is simply empty and the linear fallback `u / elapsed` applies (needed for upstream servers without `history` and for a freshly restarted server; index section 4).
3. The upper bound `t <= now` of the time filter is **removed** and a sample's age is clamped to `>= 0`, so a newest sample stamped slightly ahead of the client's clock still counts. The lower bound `atSec >= nowSec - windowSec` stays.
4. Non-finite `usedPercent` returns `null`; a `NaN` would otherwise propagate into the tier.

Keep everything else exactly: `rem = resetsAtSec - nowSec`, `null` when `!(rem > 0)`; `elapsed = max(windowSec - rem, 1)`; newest-to-oldest interval walk breaking on `du < -0.1` or `dt > IDLE_CAP`; `dt < 1` clamped to 1; weight `exp(-ln2 * age / HL)`; a current reading more than `0.1` below the newest kept sample zeroes `iv` and `obs`; rate from the weighted intervals when `iv >= 2 && obs >= MIN_OBS && sumWdt > 0`, else `u / elapsed` when `elapsed >= FALLBACK_MIN_ELAPSED_SEC`, else `null`; negative rate clamped to 0; `burnx = (u + r * rem) / 100`, `null` when `!(burnx > 0)`; dynamic cutoffs `greenCut = 1 + 0.1 * clamp(rem / windowSec, 0, 1)`, `exponent = 1 + 2 * (1 - 10 / (rem / elapsed + 10))`; round first, then tier off the rounded value. Full code, because the deviations touch the middle of the function:

```ts
export function computeSessionBurn(input: {
  readonly nowSec: number;
  readonly usedPercent: number;
  readonly resetsAtSec: number;
  readonly windowSec: number;
  readonly samples: ReadonlyArray<{ readonly atSec: number; readonly usedPercent: number }>;
}): BurnResult | null {
  const { nowSec, usedPercent: u, windowSec } = input;
  if (!Number.isFinite(u)) return null;
  const rem = input.resetsAtSec - nowSec;
  if (!(rem > 0)) return null;

  const rows = input.samples.filter((s) => s.atSec >= nowSec - windowSec);
  const n = rows.length;
  const elapsed = Math.max(windowSec - rem, 1);
  let sumWdu = 0;
  let sumWdt = 0;
  let obs = 0;
  let iv = 0;
  for (let i = n - 1; i >= 1; i--) {
    const cur = rows[i]!;
    const prev = rows[i - 1]!;
    let dt = cur.atSec - prev.atSec;
    const du = cur.usedPercent - prev.usedPercent;
    if (du < -0.1) break; // window boundary or torn read
    if (dt > IDLE_CAP_SEC) break; // no-data gap
    if (dt < 1) dt = 1;
    const age = Math.max(0, nowSec - cur.atSec);
    const w = Math.exp((-Math.log(2) * age) / HALF_LIFE_SEC);
    sumWdu += w * du;
    sumWdt += w * dt;
    obs += dt;
    iv++;
  }
  // current reading below the newest sample: the samples describe a prior window
  if (n > 0 && u < rows[n - 1]!.usedPercent - 0.1) {
    iv = 0;
    obs = 0;
  }

  let rate: number;
  if (iv >= 2 && obs >= MIN_OBS_SEC && sumWdt > 0) rate = sumWdu / sumWdt;
  else if (elapsed >= FALLBACK_MIN_ELAPSED_SEC) rate = u / elapsed;
  else return null;
  if (rate < 0) rate = 0;

  const burnx = (u + rate * rem) / 100;
  if (!(burnx > 0)) return null;

  const remFrac = Math.min(1, Math.max(0, rem / windowSec));
  const greenCut = 1.0 + 0.1 * remFrac;
  const exponent = 1.0 + 2.0 * (1.0 - 10 / (rem / elapsed + 10));
  const burn = roundBurn(burnx);
  return { burn, tier: burnTier(burn, greenCut, exponent) };
}
```

**`weeklyElapsedFraction({nowSec, resetsAtSec, windowSec, schedule})`**: `start = resetsAtSec - windowSec`; `null` unless `resetsAtSec > nowSec && nowSec > start`; with a schedule, `denom = scheduleWeight(start, resetsAtSec, schedule)`, `null` when `!(denom > 0)`, else `scheduleWeight(start, nowSec, schedule) / denom`; with `schedule: null`, `(nowSec - start) / windowSec`. It may legitimately return `0` (window just started inside a non-work stretch); the burn function, not this one, applies the `> 0` and minimum guards. This is the number the tick uses (spec 4.3).

**`computeWeeklyBurn({nowSec, usedPercent, resetsAtSec, windowSec, schedule, minElapsedFrac = 0.02})`**: `null` when `usedPercent` is non-finite; `frac = weeklyElapsedFraction(...)`; `null` when `frac === null || !(frac > 0) || frac < minElapsedFrac`; `burn = roundBurn(usedPercent / 100 / frac)`; `null` when `!(burn > 0)` (zero usage blanks the burn); `{ burn, tier: burnTier(burn) }`. Default ladder (no dynamic cutoffs), as the statusline.

- [ ] **Step 1: Write the failing tests.**

Fixtures: `NOW = 1_750_000_000` (seconds); `run(samples, used, reset)` calls `computeSessionBurn({nowSec: NOW, usedPercent: used, resetsAtSec: reset, windowSec: 18000, samples})`; `flat(used, spanSec, step = 60)` yields samples `{atSec: NOW - t, usedPercent: used}` for `t = spanSec, spanSec - step, ..., 0` ascending.

`computeSessionBurn` ported cases (`burn-rate.test.ts`):

| case                                 | input                                                                                                     | expected               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| idle series                          | reset `NOW+600`, `flat(40, 3600)`, used 40                                                                | `{burn: 0.4, tier: 0}` |
| window-average fallback, one old row | reset `NOW+9000`, `[{NOW-9000, 30}]`, used 30                                                             | `{burn: 0.6, tier: 0}` |
| too early, too little data           | reset `NOW+17880`, `[{NOW-60,5},{NOW,6}]`, used 6                                                         | `null`                 |
| idle-cap gap stops the scan          | reset `NOW+3600`, rows `(NOW-7200,5)(NOW-7140,25)(NOW-200,40)(NOW-140,40)(NOW-80,40)(NOW-20,40)`, used 40 | `{0.4, 0}`             |
| expired window                       | reset `NOW-10`                                                                                            | `null`                 |

Tier characterization (the `computeBurn tier characterization` block; keep its explanatory comment, adapted): reset `NOW+9000`, `flat(used, 3600)`, `[used, burn, tier]` via `it.each`: `[95,1,0] [104,1,0] [105,1.1,1] [106,1.1,1] [114,1.1,1] [115,1.2,2] [117,1.2,2] [118,1.2,2] [124,1.2,2] [125,1.3,2] [134,1.3,2] [135,1.4,3] [136,1.4,3] [137,1.4,3] [144,1.4,3] [145,1.5,3] [150,1.5,3]`. (Verified against a scratch run of the port; identical to the statusline's table.)

New cases (values from the same scratch run; reset `NOW+9000`, window 18000 unless stated):

| case                                          | input                                                                        | expected                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| no samples at all (upstream server)           | `[]`, used 30                                                                | `{0.6, 0}` (linear fallback)                             |
| no samples and too early                      | `[]`, used 5, reset `NOW+17880`                                              | `null`                                                   |
| steady rise 1 point/min                       | 11 samples `10, 11, ..., 20` one per 60 s ending `NOW`, used 20              | `{1.7, 3}` (rate 1/60 per s: `(20 + 150)/100`)           |
| rise, but current reading below newest sample | same samples, used 19                                                        | `{0.4, 0}` (history discarded; fallback `(19 + 19)/100`) |
| a drop stops the scan                         | rows `(NOW-600,90)(NOW-540,10)(NOW-480,12)(NOW-420,14)(NOW-360,16)`, used 16 | `{3.2, 3}` (the pre-drop 90 is ignored)                  |
| negative rate clamps to 0                     | 6 samples one per 60 s ending `NOW`, `30, 29.95, ..., 29.75`, used 29.75     | `{0.3, 0}`                                               |
| sample slightly in the future                 | `[{NOW-3000,10},{NOW+5,20}]`, used 20                                        | `{0.4, 0}` (kept, not dropped; Review Focus 3)           |
| non-finite used                               | `NaN`                                                                        | `null`                                                   |

`weeklyElapsedFraction` (schedule `ALL_DAY`, window `7*DAY`, reset `NEXT_MON`): `now = localSec(2026,6,8)` (Wed 00:00) gives `0.4`; `schedule: null` at the same `now` gives `2/7` (close); `now = NEXT_MON` or `now = MON` (equal to start) give `null`; a window entirely inside a weekend (`windowSec: 7200`, `now = localSec(2026,6,11,11)`, reset `localSec(2026,6,11,12)`) gives `null` (zero weight); `workDays: []` gives `null`.

`computeWeeklyBurn` (ported, input shape `{nowSec, usedPercent, resetsAtSec, windowSec: 7*DAY, schedule}`; `WED = localSec(2026,6,8)`, reset `NEXT_MON`):

| case                                                                  | expected                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 20 % at `WED`, `ALL_DAY`                                              | `{0.5, 0}`                                                          |
| Saturday and Sunday, 50 %                                             | both `{0.5, 0}` (clock frozen on weekends)                          |
| `schedule: null`, 20 % at `WED`                                       | `{0.7, 0}`                                                          |
| tiers at `WED` for 40 / 45 / 51 / 60 %                                | `(1.0, 0)` `(1.1, 1)` `(1.3, 2)` `(1.5, 3)` (rounds before tiering) |
| one hour in (`localSec(2026,6,6,1)`), 5 %                             | `null` (under the 0.02 floor)                                       |
| non-finite percent                                                    | `null`                                                              |
| reset in the past (`WED - 10`)                                        | `null`                                                              |
| 0 % used                                                              | `null`                                                              |
| exact tenths tie: `now = MON + 3200`, 1 %, `minElapsedFrac: 0.001`    | `{1.4, 3}`                                                          |
| window entirely in the future (reset `NEXT_MON + 7*DAY`, `now = MON`) | `null`                                                              |
| window inside a weekend                                               | `null`                                                              |

Work-hours and work-day cases:

| case                                                                                                                                                                                         | expected                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| default-style schedule `{540,1020,[1..5],0.2}`, 40 % at Wed 12:00 (`localSec(2026,6,8,12)`)                                                                                                  | frac `0.4857142857` (close), burn `{0.8, 0}` |
| same schedule, Saturday noon, 50 %                                                                                                                                                           | frac `1` (close), `{0.5, 0}`                 |
| `workDays: [0,1,2,3,4]` (Sun-Thu), `ALL_DAY` hours, `offHoursWeight: 0`, window `windowSec: 7*DAY` ending Sun 2026-07-12 00:00 local (so it starts Sun 07-05 00:00), frac at Wed 07-08 00:00 | `0.6` (close; 3 of 5 work days elapsed)      |
| same window, frac at Thu 07-09 00:00                                                                                                                                                         | `0.8` (close)                                |
| same window, frac at Fri 07-10 12:00                                                                                                                                                         | `1` (close; Fri and Sat carry no weight)     |

The two usage-curve sweeps, ported from `computeWeeklyBurn under a work-hours schedule` with `USAGE = {630,1170,offHoursWeight:0,workDays:[1..5]}` (weekend weight is already 0 here), `pctAt(now) = 100 * scheduleWeight(MON, now, USAGE) / scheduleWeight(MON, NEXT_MON, USAGE)`, a 30-minute sweep, `reset = NEXT_MON`:

| case                                                              | expected (verified in a scratch run)                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `WORK_HOURS` schedule swept from `MON + DAY` to `NEXT_MON`        | more than 100 readings; min `> 0.8`; max `< 1.25` (observed `0.9` to `1.0`, 288 readings)            |
| first-day swing, `ALL_DAY` vs `WORK_HOURS`, swept Mon 11:00-23:00 | `max/min` of the flat profile `> 8` (observed `12.0`), of the shaped profile `< 5` (observed `3.67`) |

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run, expect pass**; repeat under `TZ=America/Los_Angeles` and `TZ=Pacific/Auckland`.
- [ ] **Step 5: Commit** `feat(shared): usage pacing session and weekly burn`.

---

## Task 4: Clocks and formatters

**Files:** modify `usagePacing.ts`, `usagePacing.test.ts`.

**Interfaces:**

- Consumes: `TimestampFormat` (contracts), `formatDuration` (`./usageLimits.ts`).
- Produces: `formatClockTime`, `formatResetLabel`, `formatCountdown`, `formatTokenCount` (index 6.1 verbatim); internal `uses12HourClock`, `pad2`, `WEEKDAYS`.

Behaviour:

- **Clock style.** `"12-hour"` and `"24-hour"` are explicit. `"locale"` resolves to a style from the host's hour cycle, once, cached at module level (the hour cycle depends only on the locale, not on the zone or instant): the spec's examples are `2:40pm`, not Intl's `2:40 PM`, so Intl is used only to decide 12 vs 24:

```ts
let localeUses12Hour: boolean | undefined;

function uses12HourClock(format: TimestampFormat): boolean {
  if (format !== "locale") return format === "12-hour";
  localeUses12Hour ??=
    new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
  return localeUses12Hour;
}
```

- **`formatClockTime(ms, format)`**: local time from `new Date(ms)`'s `getHours()`/`getMinutes()`; non-finite `ms` returns `""`. 12-hour: `` `${h % 12 || 12}:${pad2(m)}${h < 12 ? "am" : "pm"}` `` (minutes always shown, lowercase suffix, no space, `0:05` is `12:05am`, noon is `12:00pm`). 24-hour: `` `${pad2(h)}:${pad2(m)}` ``.
- **`formatResetLabel(resetsAtMs, windowDurationMins, format)`**: when `windowDurationMins` is defined and `0 < mins <= 1440` return `formatClockTime`; otherwise (including `undefined` and `0`, which `NonNegativeInt` allows but means "unknown") weekday plus hour with a fixed English abbreviation table `["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]` (not Intl: the rest of the label is not localized either, and the spec shows `Thu`). 12-hour: `Thu 9am`, minutes only when non-zero (`Thu 9:30am`), noon `Thu 12pm`, midnight `Thu 12am`. 24-hour: `Thu 09:00`.
- **`formatCountdown(msRemaining)`**: `<= 0` or non-finite returns `"now"`; `< 60_000` returns `"in <1m"` (Open questions item 4); otherwise `"in " + formatDuration(msRemaining)` (floors: `in 1h 52m`, `in 3d 21h`, `in 4m`).
- **`formatTokenCount(tokens)`**: boundary-sensitive, so full code. Non-finite or `<= 0` is `"0"`; `< 1000` the rounded integer; thousands as one decimal under 10 (`9.5k`, trailing `.0` dropped) and rounded integer from 10 up (`380k`); millions the same rule with `M`; the switch to `M` happens at `999_500`, not `1_000_000`, so `999_500` is `1M` and never `1000k`:

```ts
function compactUnit(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) return `${compactUnit(tokens / 1000)}k`;
  return `${compactUnit(tokens / 1_000_000)}M`;
}
```

- [ ] **Step 1: Write the failing tests.** Local instants via `new Date(2026, 6, 6, h, m).getTime()` (July 2026, Monday 7/6; `new Date(2026,6,9,...)` is Thursday 7/9). `it.each` tables:

`formatClockTime(ms, format)`:

| local time | `"12-hour"` | `"24-hour"` |
| ---------- | ----------- | ----------- |
| 14:40      | `2:40pm`    | `14:40`     |
| 00:05      | `12:05am`   | `00:05`     |
| 12:00      | `12:00pm`   | `12:00`     |
| 09:05      | `9:05am`    | `09:05`     |
| 23:59      | `11:59pm`   | `23:59`     |

`formatClockTime(NaN, "12-hour")` is `""`. `"locale"`: the result is one of the 12-hour or 24-hour strings for the same instant (the host locale is not controlled by the test); calling it twice returns identical output.

`formatResetLabel` (reset on Thu 2026-07-09):

| local time, duration mins, format  | expected     |
| ---------------------------------- | ------------ |
| 14:40, 300, `"12-hour"`            | `2:40pm`     |
| 14:40, 1440 (boundary: clock)      | `2:40pm`     |
| 09:00, 10080, `"12-hour"`          | `Thu 9am`    |
| 09:30, 10080, `"12-hour"`          | `Thu 9:30am` |
| 12:00, 10080, `"12-hour"`          | `Thu 12pm`   |
| 00:00, 10080, `"12-hour"`          | `Thu 12am`   |
| 09:00, 10080, `"24-hour"`          | `Thu 09:00`  |
| 09:00, 1441                        | `Thu 9am`    |
| 09:00, `undefined` and 0 (12-hour) | `Thu 9am`    |
| 14:40, 300, `"24-hour"`            | `14:40`      |

`formatCountdown`:

| ms                        | expected    |
| ------------------------- | ----------- |
| `0`, `-5`, `NaN`          | `now`       |
| `30_000`, `59_999`        | `in <1m`    |
| `60_000`                  | `in 1m`     |
| `4 * 60_000`              | `in 4m`     |
| `(1*60 + 52) * 60_000`    | `in 1h 52m` |
| `(3*24 + 21) * 3_600_000` | `in 3d 21h` |

`formatTokenCount`:

| tokens                    | expected       |
| ------------------------- | -------------- |
| `0`, `-1`, `NaN`          | `0`            |
| `950`, `999`              | `950`, `999`   |
| `1000`, `1049`            | `1k`, `1k`     |
| `9500`                    | `9.5k`         |
| `9999`, `10_000`          | `10k`, `10k`   |
| `199_999`, `200_000`      | `200k`, `200k` |
| `380_000`                 | `380k`         |
| `999_499`                 | `999k`         |
| `999_500`, `1_000_000`    | `1M`, `1M`     |
| `1_500_000`               | `1.5M`         |
| `9_960_000`, `10_000_000` | `10M`, `10M`   |

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass**; repeat with `TZ=Asia/Kolkata` (half-hour offset; the instants are local so results must not change).
- [ ] **Step 5: Commit** `feat(shared): usage pacing clock and token formatters`.

---

## Task 5: Request identity, cache warmth, thread tooltip

**Files:** modify `usagePacing.ts`, `usagePacing.test.ts`.

**Interfaces:**

- Consumes: `ModelSelection` (contracts), `getModelSelectionStringOptionValue`, `getModelSelectionBooleanOptionValue` (`./model.ts`), `formatClockTime`, `formatTokenCount`.
- Produces: `RequestIdentity`, `CacheUsageInput`, `CacheWarmth`, `CACHE_WARN_MS = 600_000`, `requestIdentityFromModelSelection`, `sameRequestIdentity`, `cacheExpiresAtMs`, `cacheWarmth`, `formatThreadContextTooltip` (index 6.1 verbatim).

Behaviour (port of `cache-warmth.ts`, fields `model`/`effort`/`fastMode` only):

- **`requestIdentityFromModelSelection(selection)`**: `null` for `null`/`undefined`; else an object holding `model: selection.model`, `effort: getModelSelectionStringOptionValue(selection, "effort")` and `fastMode: getModelSelectionBooleanOptionValue(selection, "fastMode")`, each key **omitted** when undefined (build with conditional spreads so `toStrictEqual` works). Raw option values, no default resolution (index C5): an option that is present with the wrong value type is treated as absent by the two helpers.
- **`sameRequestIdentity(a, b)`**: for each of model, effort, fastMode: a value that is `undefined` or `""` on either side is skipped; otherwise unequal values mean `false`. Model values are compared after stripping a trailing variant suffix with `replace(/\[.*$/, "")` (`claude-opus-5[1m]` equals `claude-opus-5`); do **not** apply any display-name cleanup to a model id. Two empty identities match.
- **`cacheExpiresAtMs(usage)`**: `Date.parse(usage.updatedAt) + usage.promptCacheTtlMs`; `null` when `usage` is nullish, the TTL is missing, non-finite or `<= 0`, or `updatedAt` does not parse.
- **`cacheWarmth(usage, next, nowMs)`**, in this order: `expiry = cacheExpiresAtMs(usage)`, `"unknown"` when `null` (covers no usage, no TTL, bad timestamp); `"cold"` when `next` is non-null and `!sameRequestIdentity(usage.requestIdentity ?? {}, next)`; `"cold"` when `nowMs >= expiry`; `warn = Math.min(CACHE_WARN_MS, usage.promptCacheTtlMs / 4)`; `"expiring"` when `expiry - nowMs <= warn`; else `"warm"`. A `null`/`undefined` `next` skips the identity check.
- **`formatThreadContextTooltip({usedTokens, maxTokens, warmth, expiresAtMs, timestampFormat})`**: context part is `` `Context ${formatTokenCount(used)} / ${formatTokenCount(max)} (${Math.round(used / max * 100)}%)` `` when `maxTokens > 0`, else `` `Context ${formatTokenCount(used)}` ``. Cache clause by state: warm `Cache warm, expires <clock>`; expiring `Cache expiring <clock>`; cold `Cache cold`; unknown none. `<clock>` is `formatClockTime(expiresAtMs, timestampFormat)`; with `expiresAtMs === null` the warm clause is `Cache warm` and the expiring clause is `Cache expiring`. Parts joined with `" · "` (U+00B7 with spaces).

- [ ] **Step 1: Write the failing tests.** Fixtures: `NOW = 1_750_000_000_000` (ms); `usage(o)` builds `{updatedAt: new Date(NOW - 60_000).toISOString(), promptCacheTtlMs: 3_600_000, requestIdentity: {model:"claude-opus-5", effort:"xhigh", fastMode:false}, ...o}`; `next(o)` builds `{model:"claude-opus-5[1m]", effort:"xhigh", fastMode:false, ...o}`. For selections: `createModelSelection(ProviderInstanceId.make("claude"), "claude-opus-5", [{id:"effort", value:"high"}, {id:"fastMode", value:true}])` (`createModelSelection` from `./model.ts`, `ProviderInstanceId` from `@t3tools/contracts`).

`requestIdentityFromModelSelection`:

| input                                              | expected                                  |
| -------------------------------------------------- | ----------------------------------------- |
| `null`, `undefined`                                | `null`                                    |
| selection with no options                          | `{model: "claude-opus-5"}`                |
| effort `high` and fastMode `true`                  | `{model, effort: "high", fastMode: true}` |
| options `[{id:"effort", value:true}]` (wrong type) | `{model}` only                            |

`sameRequestIdentity` (ported `sameIdentity` suite, minus `version`):

| a, b                                                                     | expected                 |
| ------------------------------------------------------------------------ | ------------------------ |
| `{model:"claude-opus-5"}`, `{model:"claude-opus-5[1m]"}` and the reverse | `true`                   |
| `{model:"claude-opus-5[1m]"}`, `{model:"claude-sonnet-5"}`               | `false`                  |
| `{fastMode:false}`, `{}` and `{}`, `{fastMode:true}`                     | `true` (absent skipped)  |
| `{effort:"xhigh", fastMode:false}`, `{effort:"xhigh"}`                   | `true`                   |
| `{effort:""}`, `{effort:"xhigh"}`                                        | `true` (empty is absent) |
| `{fastMode:false}`, `{fastMode:true}`                                    | `false`                  |
| `{}`, `{}`                                                               | `true`                   |

`cacheWarmth` (ported, `warnSec` is now the 600 s constant). `updatedAt` below is `NOW - X` unless stated:

| case                                                                     | expected                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `usage` is `null` / `undefined`                                          | `unknown`                                                                                          |
| no `promptCacheTtlMs`; or `updatedAt: "garbage"`                         | `unknown`                                                                                          |
| baseline (60 s old, 1 h TTL, same identity)                              | `warm`                                                                                             |
| `next = null` with a different identity on the usage                     | `warm` (identity check skipped)                                                                    |
| `usage.requestIdentity` undefined, any `next`                            | `warm`                                                                                             |
| `updatedAt = NOW - 3_600_000` (exactly at expiry)                        | `cold` at `NOW`; `expiring` at `NOW - 1000`                                                        |
| expiry exactly `NOW + 600_000` (`updatedAt = NOW + 600_000 - 3_600_000`) | `expiring` at `NOW`; `warm` at `NOW - 1000`                                                        |
| 5-minute TTL `300_000`, `updatedAt = NOW`                                | `warm` at `NOW`; `expiring` at `NOW + 225_000` (remaining 75 s = ttl/4); `warm` at `NOW + 224_000` |
| model changed (`next({model:"claude-sonnet-5"})`), still inside TTL      | `cold`                                                                                             |
| effort changed (`"low"`)                                                 | `cold`                                                                                             |
| fastMode toggled (`true`)                                                | `cold`                                                                                             |
| `next({effort: undefined, fastMode: undefined})`                         | `warm`                                                                                             |

`cacheExpiresAtMs`: baseline is `NOW - 60_000 + 3_600_000`; missing TTL, TTL `0`, bad timestamp, `null` all give `null`. `CACHE_WARN_MS` is `600_000`.

`formatThreadContextTooltip` (format `"12-hour"` unless stated; `expiresAtMs` = local 15:12 on any day):

| input                         | expected                                               |
| ----------------------------- | ------------------------------------------------------ |
| `380_000 / 1_000_000`, warm   | `Context 380k / 1M (38%) · Cache warm, expires 3:12pm` |
| same, expiring                | `Context 380k / 1M (38%) · Cache expiring 3:12pm`      |
| same, cold                    | `Context 380k / 1M (38%) · Cache cold`                 |
| same, unknown                 | `Context 380k / 1M (38%)`                              |
| `380_000`, max `null`, warm   | `Context 380k · Cache warm, expires 3:12pm`            |
| max `0`, unknown              | `Context 380k`                                         |
| `"24-hour"`, warm             | `... expires 15:12`                                    |
| `199_999 / 1_000_000`         | `Context 200k / 1M (20%)`                              |
| warm with `expiresAtMs: null` | `Context 380k / 1M (38%) · Cache warm`                 |

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(shared): usage pacing cache warmth and context tooltip`.

---

## Task 6: Per-window pace, roles and labels

**Files:** modify `usagePacing.ts`, `usagePacing.test.ts`.

**Interfaces:**

- Consumes: `computeSessionBurn`, `computeWeeklyBurn`, `weeklyElapsedFraction`, `WorkSchedule`, `PaceTier`, `BurnResult`, `copySorted`.
- Produces: `PaceWindowInput`, `WindowPace`, `computeWindowPace`, `PaceWindowRole`, `paceWindowRole`, `paceWindowShortLabel`, `paceWindowTitle`, `orderPaceWindows` (index 6.1 verbatim; the structural input types stay assignable from the contract's `ServerProviderUsageWindow`, which a compile-time test pins).

**`computeWindowPace(window, {nowMs, schedule})`** wires the pieces. Decisions it fixes:

- `usedPercent` in the result is clamped to `[0, 100]` (non-finite counts as 0); the burn functions receive the value floored at 0 but **not** capped at 100 (a window reading 101 % projects honestly).
- `resetsAt` missing or unparseable returns `{usedPercent, burn: null, burnTier: null, paceFraction: null, resetsAtMs: null}`.
- Window length: `windowDurationMins * 60` when finite, `> 0` and at most 400 days; otherwise 18000 s for `session`, 604800 s for every other kind (index C1). The 400-day cap is a safety net: `scheduleWeight` iterates once per local day of the window, so a bogus huge duration would stall the UI thread (Review Focus 5).
- `session`: tick is the wall-clock fraction (`weeklyElapsedFraction` with `schedule: null`); burn is `computeSessionBurn` over `history` mapped to `{atSec: Date.parse(at) / 1000, usedPercent}` (samples with unparseable `at` dropped, order kept: the server guarantees ascending).
- `weekly`: both tick and burn use `input.schedule`; the tick is drawn even while the 0.02 floor suppresses the burn.
- `monthly` and `other`: schedule `null` for both.
- Outside the window (reset already passed, or `now <= start`) the tick and burn are `null` (stale snapshot; Review Focus 1); `resetsAtMs` is still returned so the UI can show the clock.
- `burnTier` is `null` exactly when `burn` is `null`.

```ts
const MAX_WINDOW_SEC = 400 * 86_400;

function windowLengthSec(kind: PaceWindowInput["kind"], mins: number | undefined): number {
  const fallback = kind === "session" ? 18_000 : 604_800;
  if (mins === undefined || !Number.isFinite(mins) || mins <= 0) return fallback;
  const sec = mins * 60;
  return sec > MAX_WINDOW_SEC ? fallback : sec;
}

export function computeWindowPace(
  window: PaceWindowInput,
  input: { readonly nowMs: number; readonly schedule: WorkSchedule },
): WindowPace {
  const used = Number.isFinite(window.usedPercent) ? Math.max(0, window.usedPercent) : 0;
  const usedPercent = Math.min(100, used);
  const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) {
    return { usedPercent, burn: null, burnTier: null, paceFraction: null, resetsAtMs: null };
  }
  const nowSec = input.nowMs / 1000;
  const resetsAtSec = resetsAtMs / 1000;
  const windowSec = windowLengthSec(window.kind, window.windowDurationMins);
  const schedule = window.kind === "weekly" ? input.schedule : null;
  const paceFraction = weeklyElapsedFraction({ nowSec, resetsAtSec, windowSec, schedule });
  const result =
    window.kind === "session"
      ? computeSessionBurn({
          nowSec,
          usedPercent: used,
          resetsAtSec,
          windowSec,
          samples: toSamples(window.history),
        })
      : computeWeeklyBurn({ nowSec, usedPercent: used, resetsAtSec, windowSec, schedule });
  return {
    usedPercent,
    burn: result?.burn ?? null,
    burnTier: result?.tier ?? null,
    paceFraction,
    resetsAtMs,
  };
}
```

`toSamples(history)` is the private mapper described above (`undefined` gives `[]`).

**Roles and labels** (index 6.1 comments are normative; extra decisions):

- `paceWindowRole`: kind `session` is `"session"`; kind `weekly` whose `label` starts with `"Weekly · "` (U+00B7; Claude's `scopedWindow` in `apps/server/src/provider/claudeUsageLimits.ts` builds `` `Weekly · ${displayName}` ``) is `"modelScoped"`; other `weekly` is `"weekly"`; `monthly`/`other` are `"other"`. Keep the prefix in a private constant.
- `paceWindowShortLabel`: `modelScoped` returns the label after the prefix (`"Fable"`); otherwise from `windowDurationMins`: unknown, `0` or non-finite returns `window.label`; `< 60` returns `` `${mins}m` `` (extension for sub-hour windows); `< 1440` returns `` `${Math.round(mins / 60)}h` ``; else `` `${Math.round(mins / 1440)}d` `` (300 gives `5h`, 10080 gives `7d`, 1440 gives `1d`).
- `paceWindowTitle`: `session` with a known duration is `` `Session · ${short}` `` (`Session · 5h`); `session` without one is `window.label` (avoids `Session · Session`); `weekly` is `"Weekly · all models"`; `modelScoped` and `other` are `window.label`.
- `orderPaceWindows`: new array via `copySorted`, role rank `session 0, weekly 1, modelScoped 2, other 3`, ties by `id` using plain `<`/`>` comparison (deterministic across locales).

- [ ] **Step 1: Write the failing tests.** Fixtures: `T = new Date(2026, 6, 6, 12).getTime()` (Mon 12:00 local, ms); `iso(ms) = new Date(ms).toISOString()`; `schedule(overrides)` via `resolveWorkSchedule({workHours:"09:00-17:00", workDays:[1,2,3,4,5], offHoursWeight:0.2, ...})`; `ALL_DAY_SCHEDULE = resolveWorkSchedule({workHours:"00:00-24:00", workDays:[1,2,3,4,5], offHoursWeight:0})`.

`computeWindowPace`:

| case                                   | window / input                                                                                                                                                | expected `{usedPercent, burn, burnTier, paceFraction, resetsAtMs}`                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| session with history                   | `kind:"session"`, used 20, `windowDurationMins: 300`, `resetsAt = iso(T + 9000_000)`, history = 11 samples `10..20` one per 60 s ending at `T`                | `{20, 1.7, 3, 0.5, T + 9_000_000}` (`paceFraction` close to 0.5)                     |
| session, `history` undefined           | used 30, same window, `resetsAt = iso(T + 9000_000)`                                                                                                          | burn `0.6`, tier `0`, tick `0.5`                                                     |
| session, empty `history: []`           | same                                                                                                                                                          | same as above                                                                        |
| session, early in window, no history   | used 5, `resetsAt = iso(T + 17_880_000)`                                                                                                                      | burn `null`, tier `null`, tick close to `120/18000` (not null)                       |
| session, no `windowDurationMins`       | used 30, `resetsAt = iso(T + 9000_000)`                                                                                                                       | falls back to 18000 s: burn `0.6`, tick `0.5`                                        |
| weekly, work-day schedule              | `kind:"weekly"`, `windowDurationMins: 10080`, used 20, `resetsAt = iso(Mon 2026-07-13 00:00 local)`, `nowMs` = Wed 2026-07-08 00:00 local, `ALL_DAY_SCHEDULE` | burn `0.5`, tier `0`, tick `0.4`                                                     |
| weekly, default schedule               | used 40, now Wed 07-08 12:00 local, `schedule()` defaults                                                                                                     | burn `0.8`, tier `0`, tick close to `0.4857142857`                                   |
| weekly, blank burn but tick drawn      | used 5, now Mon 07-06 01:00 local, `ALL_DAY_SCHEDULE`                                                                                                         | burn `null`, tier `null`, tick close to `1/120`                                      |
| weekly, empty work days                | `schedule({workDays: []})`                                                                                                                                    | burn `null`, tick `null`, `resetsAtMs` set                                           |
| weekly, no `windowDurationMins`        | used 20, `resetsAt` = Mon 07-13, now Wed 07-08, `ALL_DAY_SCHEDULE`                                                                                            | window length falls back to 604800 s: burn `0.5`                                     |
| monthly                                | `kind:"monthly"`, `windowDurationMins: 43200`, used 30, `resetsAt = iso(T + 15 days)`, now `T`                                                                | burn `0.6`, tier `0`, tick `0.5` (wall clock; the schedule is ignored)               |
| other, no duration                     | `kind:"other"`, used 30, `resetsAt = iso(T + 3.5 days)`, now `T`                                                                                              | wall-clock tick `0.5` over 604800 s, burn `0.6`                                      |
| `resetsAt` missing                     | any kind                                                                                                                                                      | `{usedPercent, null, null, null, null}`                                              |
| `resetsAt` garbage                     | `"not a date"`                                                                                                                                                | same as missing                                                                      |
| stale snapshot (`resetsAt` before now) | session, `resetsAt = iso(T - 1000)`                                                                                                                           | burn `null`, tier `null`, tick `null`, `resetsAtMs = T - 1000`                       |
| `usedPercent` 120 / -5 / `NaN`         | session, `resetsAt` in window                                                                                                                                 | result `usedPercent` `100` / `0` / `0`                                               |
| absurd duration                        | weekly, `windowDurationMins: 100_000_000` (and `0`, and `NaN`), `resetsAt` Mon 07-13, now Wed 07-08, `ALL_DAY_SCHEDULE`                                       | completes immediately and equals the no-duration weekly row (`burn 0.5`, tick `0.4`) |

Roles and labels (`it.each`):

| window `{kind, label, windowDurationMins}` | role          | short label | title                 |
| ------------------------------------------ | ------------- | ----------- | --------------------- |
| `session`, `"Session"`, 300                | `session`     | `5h`        | `Session · 5h`        |
| `session`, `"Session"`, undefined          | `session`     | `Session`   | `Session`             |
| `session`, `"Session"`, 0                  | `session`     | `Session`   | `Session`             |
| `weekly`, `"Weekly"`, 10080                | `weekly`      | `7d`        | `Weekly · all models` |
| `weekly`, `"Weekly · Fable"`, 10080        | `modelScoped` | `Fable`     | `Weekly · Fable`      |
| `weekly`, `"Weekly"`, undefined            | `weekly`      | `Weekly`    | `Weekly · all models` |
| `monthly`, `"Monthly"`, 43200              | `other`       | `30d`       | `Monthly`             |
| `other`, `"Overall"`, undefined            | `other`       | `Overall`   | `Overall`             |
| `session`, `"Session"`, 45                 | `session`     | `45m`       | `Session · 45m`       |
| `session`, `"Session"`, 1440               | `session`     | `1d`        | `Session · 1d`        |

`orderPaceWindows`: input ids/kinds `[monthly "extra"/"Extra", weekly "seven_day_fable"/"Weekly · Fable", weekly "seven_day"/"Weekly", session "five_hour"/"Session", session "a_session"/"Session"]` gives id order `a_session, five_hour, seven_day, seven_day_fable, extra`; the input array is not mutated; an empty array returns `[]`.

Type-level conformance (compile-time, in a `describe` that runs trivially): `const asInput: PaceWindowInput = {} as ServerProviderUsageWindow;` and `const asUsage: CacheUsageInput = {} as OrchestrationV2ProviderTurnTokenUsage;` (type imports from `@t3tools/contracts`) and `const asContext: Parameters<typeof contextTier>[0] = {} as OrchestrationV2ProviderTurnTokenUsage;`. These fail `vp run @t3tools/shared#typecheck` if the structural inputs drift from the wire types (this is the check that P2's `history` and P3's `requestIdentity` will later still satisfy).

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect pass**; repeat under `TZ=America/Los_Angeles` (the weekly rows span July only, but the walk runs in the ambient zone).
- [ ] **Step 5: Commit** `feat(shared): usage pacing per-window pace and labels`.

---

## Task 7: Public-surface guard and full verification

**Files:** modify `usagePacing.test.ts`; no source changes expected.

- [ ] **Step 1: Add the surface test.** `import * as UsagePacing from "./usagePacing.ts";` and one test: `[...Object.keys(UsagePacing)].sort()` equals the sorted list of exactly these runtime exports (types are erased): `BURN_TIER_COLORS, BURN_TIER_ORANGE, BURN_TIER_YELLOW, CACHE_WARN_MS, CONTEXT_TIER_COLORS, DEFAULT_OFF_HOURS_WEIGHT, DEFAULT_WORK_DAYS, DEFAULT_WORK_HOURS, burnTier, cacheExpiresAtMs, cacheWarmth, computeSessionBurn, computeWeeklyBurn, computeWindowPace, contextFraction, contextTier, formatBurn, formatClockTime, formatCountdown, formatResetLabel, formatThreadContextTooltip, formatTokenCount, formatWorkHours, orderPaceWindows, paceWindowRole, paceWindowShortLabel, paceWindowTitle, parseWorkHours, requestIdentityFromModelSelection, resolveWorkSchedule, roundBurn, sameRequestIdentity, scheduleWeight, weeklyElapsedFraction` (34 names). It guards index 6.1's "no extra exports" rule; if an implementation helper leaked, un-export it rather than extending the list.
- [ ] **Step 2: Run the full file under four ambient zones**

```sh
PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
TZ=UTC PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
TZ=America/Los_Angeles PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
TZ=Asia/Kolkata PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
TZ=Pacific/Auckland PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/shared/src/usagePacing.test.ts
```

Expected: every run green. A failure in one zone only means a test used UTC arithmetic instead of local constructors; fix the test (or the code, if a real DST bug).

- [ ] **Step 3: Typecheck, lint, format** (targeted, never repo-wide)

```sh
PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/shared#typecheck
PATH="$PWD/node_modules/.bin:$PATH" vp lint --report-unused-disable-directives packages/shared/src/usagePacing.ts packages/shared/src/usagePacing.test.ts
PATH="$PWD/node_modules/.bin:$PATH" vp fmt packages/shared/src/usagePacing.ts packages/shared/src/usagePacing.test.ts packages/shared/package.json
PATH="$PWD/node_modules/.bin:$PATH" vp fmt --check packages/shared/src/usagePacing.ts packages/shared/src/usagePacing.test.ts packages/shared/package.json
```

Expected: typecheck prints only the pre-existing `symlink.ts` suggestion; lint prints no findings for the two files; `fmt --check` reports all files correctly formatted.

- [ ] **Step 4: Confirm scope.** `git status` / `git diff --stat feat/usage-pacing` shows exactly three files: `packages/shared/package.json`, `usagePacing.ts`, `usagePacing.test.ts`. `usageLimits.ts` and everything else untouched.
- [ ] **Step 5: Commit** `test(shared): pin the usage pacing public surface` (squash into the previous commit is not needed; these are local-only branches, but do not rewrite history after a SHA has been reported).
- [ ] **Step 6: Report** the final branch HEAD SHA and the five-zone test result to the orchestrator. No milestone is published by this plan; the whole branch merges into `feat/usage-pacing` (index section 5) and gates P4.

---

## Testing Strategy

**Hermetic (all of P1).** Every function is pure, so the unit tests are the real check: the statusline's burn-tier, burn-rate (including the tier characterization table), weekly-burn (both America/Los_Angeles DST cases and the wrap-past-midnight schedule) and cache-warmth suites are ported with inputs adapted, plus new tables for configurable work days, 23/25-hour work days, the 50/65/80 and 200k/300k/400k context tiers, request identity, every formatter, per-window pace, roles and ordering. Expected values were cross-checked by running the port against the statusline's own numbers in a scratch harness (outside the repo) before being written into this plan. Time-dependent code is run under five ambient zones (`UTC`, `America/Los_Angeles`, `Asia/Kolkata`, `Pacific/Auckland`, default) because the weekly schedule walk uses local calendar days. A compile-time conformance block pins that the contract wire types (`ServerProviderUsageWindow`, `OrchestrationV2ProviderTurnTokenUsage`) stay assignable to the structural inputs.

**End-to-end: not run in this plan, deliberately.** P1 has no runtime surface of its own: nothing renders, listens or persists. The only end-to-end view of these functions is through the header widget and the glyph, which do not exist until P4 and P5 merge, and AGENTS.md forbids subagents from launching their own dev servers. That integrated pass is P6's (spec section 7 items 1-6), run once on `feat/usage-pacing`: item 2 exercises session/weekly burn and tick, item 3 the cache dot and identity switch, item 6 the work-hours settings moving the weekly burn. No autonomous path to observe P1's output in a real client exists before then.

**Review.** No per-plan review is scheduled for P1 (orchestrator policy: coherence runs code-grounding checks on it). The implementing agent still reports plainly that the change is **unreviewed by an independent agent** at handoff, with the verification output above attached.

---

## Open questions / spec deviations

Each item is followed provisionally as recommended.

1. **Empty session history falls back to the linear projection (deviation from the statusline's `computeBurn`).** The statusline returns `null` when no rows survive its filter (`if (n < 1) return null`), because its samples always include the current reading. Here `history` is optional (an upstream server sends none; a restarted fork server has none until the first update), and index section 4 plus spec 5.2 say the burn then uses the linear `used / elapsed` fallback. Options: (a) keep the statusline's early `null` and let P4 compute the fallback separately; (b) remove the early return in `computeSessionBurn`. Recommendation: (b), implemented here. Effect: with zero samples, burn appears once 1800 s of the window has elapsed and is blank before. This only matches the spec text; no user-visible change from the spec.
2. **Future-dated samples are kept (deviation from the statusline's `t <= now` filter).** Server timestamps are compared to the client's clock, and remote servers are first-class (AGENTS.md "Remote ready"). A client clock a few seconds behind would drop the newest samples and silently blank the burn. Options: keep the upper bound; or drop it and clamp the age to `>= 0`. Recommendation: drop it (implemented). Cost: none for same-host setups.
3. **Foreign-window and envelope tests are not ported.** The statusline test "ignores rows belonging to another 5h window" and everything in `usage-envelope` / `pool-swap` exercise machinery deliberately not ported (spec 5.2); the server (index 6.2 rule 2) scopes history to the current `resetsAt`, so `computeSessionBurn` applies only the time-window filter. Likewise `liveState`, `hasCurrentUsage` and the `version` identity field are dropped (index 6.1). Recommendation: as written.
4. **Sub-minute countdown prints `in <1m`, not `in 0m`.** Index 6.1 defines `formatCountdown` as `"in " + formatDuration(ms)`; `formatDuration` floors, so 59 s would read "in 0m", which looks like a bug at the moment the user is most likely to be watching. Options: accept `in 0m`; or print `in <1m`. Recommendation: `in <1m` (implemented). Visible only in the final minute before a reset.
5. **`"locale"` timestamp format is collapsed to 12- or 24-hour by the host's hour cycle** (needed so an en-US browser shows the spec's `2:40pm`, not Intl's `2:40 PM`; index D5). The web app's other timestamps on desktop use a host-reported system locale (`resolveTimestampLocale` in `apps/web/src/timestampFormat.ts`), which this framework-free module cannot see, so on Electron the clock style could differ from other timestamps if Chromium's locale differs from the OS locale. Options: accept; or have P4/P5 resolve `"locale"` to `"12-hour"`/`"24-hour"` themselves before calling. Recommendation: accept now, and P4/P5 may resolve it if they observe a mismatch.
6. **Edge decisions the contract leaves open, fixed here:** `windowDurationMins` of `0` is treated as unknown (the schema allows `0`, but it cannot mean a zero-length window); sub-hour windows get a minutes label (`45m`) instead of `0h`; a session window with no duration titles as its label (`Session`) instead of `Session · Session`; `parseWorkHours` normalises an end of `00:00` to `24:00` (equivalent under the wrap rule) and rejects a start of `24:00` (contract range `0..1439`); `cacheExpiresAtMs` treats a TTL `<= 0` as missing; an empty work-day set yields a null weekly burn and tick rather than an error (the settings UI is P4's to constrain).
7. **Window-length sanity cap (new, not in the contract).** `windowDurationMins * 60` above 400 days (or non-finite/non-positive) falls back to the default length. Reason: `scheduleWeight` iterates once per local day of the window, so a malformed server value could stall the UI thread. Real windows are at most about 31 days. Recommendation: keep.
8. **Context tier wording.** The orchestrator brief for this plan summarises spec 4.4 as "token tier only when maxTokens missing". The spec table and index 6.1 say the ring takes the more severe of the percentage tier and the token tier, and "without `maxTokens`, only the token tier applies". This plan follows the spec and contract: both tiers always, the percentage tier only when `maxTokens > 0`. Consequence worth knowing: on a 1M window, 200k tokens is already yellow and 400k red regardless of percentage. Spec section 6's "`maxTokens` missing: track only, no arc; colour by the token tier" is the case where `contextFraction` is `null` (P5 owns that wording).
9. **Spec 4.2 says history is "filtered to the current `resetsAt` and the last `windowSec`".** Only the second half is P1's job (the server does the first, index 6.2). No behaviour change; the coherence pass may want the spec to say so.
10. **Two token formatters will exist.** `formatTokenCount` (this plan; `380k`, `1M`, uppercase `M`, never `1000k`) differs from `formatContextWindowTokens` in `apps/web/src/lib/contextWindow.ts` (lowercase `m`, and `999_500` prints `1000k` because `Math.round(999.5)` is `1000`). The composer popover keeps the old one unless P5 switches it. Recommendation: P5 decides; if the popover and tooltip sit side by side, switch the popover to the shared formatter so one screen does not show `1m` and `1M`.
11. **`<=` at the expiring boundary** (index C3; spec 4.5 says "less than"): ported as `<=`, matching the statusline code and its "expiring exactly at the warn edge" test. Spec wording should become "at most".
12. **knip.** `knip --exports` may flag exports that only P4/P5 consume (for example `BURN_TIER_YELLOW`, `weeklyElapsedFraction`, `scheduleWeight`, `cacheExpiresAtMs`) until those plans merge. Types are exempt (`"types": "off"`). knip is CI-owned and is not run by this plan; if CI flags something P4/P5 does not end up using, un-export it at that time.
