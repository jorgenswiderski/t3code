# P5 Thread Context Glyph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared SVG glyph (context ring plus prompt-cache dot) shown 14 px in every sidebar thread row and 18 px inside the composer's context meter, with the composer-ring toggle moved into the Usage pacing settings section and defaulted on.

**Architecture:** Pure logic (tier, fraction, cache state, SVG geometry, tooltip strings) lives in `threadContextGlyph.logic.ts` and is unit-tested; the component file renders it and owns the 30 s clock subscription so a tick re-renders glyphs only. Data comes from `thread.latestTokenUsage` (P3, sidebar) and the live provider-turn usage plus the composer snapshot (composer). All maths comes from `@t3tools/shared/usagePacing` (P1).

**Tech Stack:** React 19, Tailwind 4, Base UI popover/tooltip wrappers, Effect Schema (settings), vitest via `vp test run`.

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` (sections 3.3, 3.4 meter row, 4.4, 4.5, 5.4, 6). Shared contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` (sections 6.1, 6.3, 6.4, 6.5, 6.6, 7, 9). Read both first.

## Implementation Location

- **Branch:** `feat/usage-pacing-p5-web-glyph`
- **Worktree:** `/home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p5-web-glyph`
- **Base branch:** `feat/usage-pacing`

Created only after P1, P3-contract and P4-foundation are merged into `feat/usage-pacing` (index section 5). Create it with the index's "Create a child worktree" procedure. Every shell command below assumes that worktree as the working directory and uses `builtin cd` and `;` (never `&&` after `cd`; the user's shell wraps `cd` through fnm and returns 127). `vp` is not on PATH globally: prefix every `vp` call with `PATH="$PWD/node_modules/.bin:$PATH"`.

## Dependencies on other plans (code against these, do not wait for their text)

| Needs                                                                                                                                                                                                                              | From          | Exact name                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| `contextTier`, `contextFraction`, `cacheWarmth`, `cacheExpiresAtMs`, `requestIdentityFromModelSelection`, `formatThreadContextTooltip`, `CONTEXT_TIER_COLORS`, types `PaceTier`, `PaceTierColor`, `CacheWarmth`, `RequestIdentity` | P1            | `@t3tools/shared/usagePacing` (index 6.1)                       |
| `useNowTick(intervalMs): number`                                                                                                                                                                                                   | P4-foundation | `apps/web/src/hooks/useNowTick.ts` (index 6.4)                  |
| `PACE_TIER_CLASSES: Record<PaceTierColor, { text; bg; stroke }>`                                                                                                                                                                   | P4-foundation | `apps/web/src/components/pacing/paceTierClasses.ts`             |
| `UsagePacingSettingsPanel`, route `/settings/usage-pacing`, `SettingsPath` entry, nav, restore-defaults for P4's six keys                                                                                                          | P4-foundation | `apps/web/src/components/settings/UsagePacingSettings.tsx` etc. |
| `OrchestrationV2ProviderTurnTokenUsage.requestIdentity`, `thread.latestTokenUsage` on `SidebarThreadSummary` (`OrchestrationV2ProviderTurnTokenUsage \| null`)                                                                     | P3-contract   | index 6.3                                                       |

If any of these is missing in the worktree when you start, stop and report; do not recreate it.

## Global Constraints

- Ring: stroke **1.6 px at 14 px, 2 px at 18 px**, round caps; track = muted foreground at **25 % opacity**; arc starts at **12 o'clock** and runs **clockwise** for the context fraction.
- Ring colour is the context tier (spec 4.4, `CONTEXT_TIER_COLORS`: tier 0 muted, 1 yellow-400, 2 orange-500, 3 destructive). Tiers: max of % tier (>=50 / >=65 / >=80, integer part) and token tier (>=200k / >=300k / >=400k). P1 owns this; P5 never re-derives it.
- Dot: **radius 15 % of the glyph size**, fill `color-mix(in oklab, <state colour> 45%, var(--color-muted-foreground))`. Warm: state colour = muted foreground (plain grey dot). Expiring: state colour = `var(--color-warning)`. Cold or unknown: **no dot**. (Index 9 item C6: use the `--color-*` tokens, not the bare `--muted-foreground`.)
- Tooltip text (P1 `formatThreadContextTooltip`): `Context 380k / 1M (38%) · Cache warm, expires 3:12pm`; cache clause becomes `Cache expiring 3:12pm`, `Cache cold`, or is omitted when unknown.
- No token usage at all: **no glyph**. Usage present but cache unknown: ring, no dot.
- Time-dependent state recomputes on `useNowTick(30_000)` and on data change; never `setInterval` in this plan.
- Sidebar glyph has no toggle. Composer glyph is governed by the client setting `composerContextRingEnabled` (default `true`, label **Show context ring in composer**).
- Web tests: logic only. Do not render components to static markup (AGENTS.md "Verifying"). Test imports use `import { describe, expect, it } from "vite-plus/test"` as `ContextWindowMeter.logic.test.ts` does.
- `components/ui` primitives are not restyled with `className` (lint rule `shadcn/no-restyle`); new classes go on this plan's own elements. Layout classes on a primitive (the existing `size-7` on the meter `Button`) stay as they are.
- knip flags unused exports: export from the new files only what a task below consumes.
- Mobile is out of scope.

## Review Focus

Inputs and conditions the spec implies but the obvious tests would miss, most likely first. Each has a test in the task named in brackets.

1. **Usage with `maxTokens` missing, `null` or `0`** (Claude always has one, Codex/OpenCode fallbacks may not): no arc, no `NaN` in the SVG, tier still comes from the token tier. [Task 1: resolve table rows 5-6, arc table]
2. **`usedTokens > maxTokens`** (1M window reporting 1.2M): arc clamps to a full ring, never a dash longer than the circumference. [Task 1: resolve row 7, arc table]
3. **Switching the composer model or effort** must drop the dot at once and switching back must restore it, with no data change. [Task 1: resolve rows 10-12]
4. **Time passing without data changes**: a warm thread must become expiring then cold purely from `nowMs` advancing; an unparseable `updatedAt` or absent TTL must read unknown, never throw. [Task 1: resolve rows 8-9, 13-14]
5. **Stale persisted settings**: a stored client-settings object that still contains `contextWindowMeterEnabled: false` and no `composerContextRingEnabled` must decode with the ring **on**; the old key must not leak through. [Task 3: settings table]
6. **Compaction report** (P3 gives it no TTL and no identity, index 9 D2): the composer ring must still render (cache unknown, no dot), not disappear. [Task 1: composerGlyphUsage rows 2-3]

## File Structure

| File                                                                | Action | Responsibility                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/pacing/threadContextGlyph.logic.ts`        | create | Pure: `ThreadContextUsage` input type, `resolveThreadContextGlyph`, `composerGlyphUsage`, `glyphGeometry`, `arcDashArray`, `dotFillClass`, `formatGlyphTooltip`, `glyphCacheClause` |
| `apps/web/src/components/pacing/threadContextGlyph.logic.test.ts`   | create | Tables below                                                                                                                                                                        |
| `apps/web/src/components/pacing/ThreadContextGlyph.tsx`             | create | `ThreadContextGlyph` (SVG), `useThreadContextGlyphModel`, `ThreadContextGlyphBadge` (sidebar), `ThreadContextTooltipLine` (sidebar hover card)                                      |
| `apps/web/src/components/chat/ContextWindowMeter.tsx`               | modify | Replace inline ring `<svg>` with the 18 px glyph; tier-coloured popover bar; cache line; aria-label                                                                                 |
| `apps/web/src/components/chat/ChatComposer.tsx`                     | modify | New prop `activeThreadLiveTokenUsage`; pass identity/TTL inputs to the meter; rename the setting key (lines ~2416, ~7669)                                                           |
| `apps/web/src/components/ChatView.tsx`                              | modify | Pass `activeThreadLiveTokenUsage` to `ChatComposer` (next to `activeContextWindow`, ~line 11762)                                                                                    |
| `apps/web/src/components/Sidebar.tsx`                               | modify | Mount badge in the slim and card time slots; hover-card line in `SidebarThreadTooltip`                                                                                              |
| `packages/contracts/src/settings.ts`                                | modify | `contextWindowMeterEnabled` -> `composerContextRingEnabled` (schema ~450, patch ~1664)                                                                                              |
| `packages/contracts/src/settings.test.ts`                           | modify | Rewrite `describe("ClientSettings context window meter")` (~652)                                                                                                                    |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`           | modify | Fixture key rename (line ~36)                                                                                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`               | modify | Remove legacy row and its `LEGACY_FEATURE_TARGET_IDS` entry; rename key in `useSettingsRestore` (~623, ~695, ~809)                                                                  |
| `apps/web/src/components/settings/settingsSearch.ts` (+ `.test.ts`) | modify | Replace item `legacy-context-window-indicator` (~605) with `usage-pacing-context-ring`                                                                                              |
| `apps/web/src/components/settings/UsagePacingSettings.tsx`          | modify | Append one `SettingsRow` as the last row of P4's `SettingsSection`                                                                                                                  |
| `docs/user/composer.md`                                             | modify | One short paragraph at ~line 217                                                                                                                                                    |

Line numbers were checked at `2ca9e43bb`; re-locate by symbol before editing.

## Verified facts the tasks rely on

- `ContextWindowMeter` (`chat/ContextWindowMeter.tsx`) takes `usage: ContextWindowSnapshot` and draws its own `<svg viewBox="0 0 24 24">` ring with `radius 9.75`, red above 90 %. Its `Button` (`size-7`, `ghost-muted`) wraps `<span className="relative flex size-5 ...">`. The popover (tokens, total processed, cost, auto-compact message, Compact button) stays.
- `ContextWindowSnapshot` (`lib/contextWindow.ts`) carries `usedTokens`, `maxTokens` (nullable), `updatedAt`, **no TTL and no identity**. `deriveLatestContextWindowSnapshot` prefers the live provider-turn usage (`activeThreadLiveTokenUsage`, `ChatView.tsx` ~1725, from `latestProviderTurnTokenUsage`) and then falls back to `providerThread.contextUsage` / a compaction item; in the fallbacks there is no live usage, so cache state is unknown.
- `ChatView.tsx` renders `ChatComposer` once (~11642) and passes `activeContextWindow` (~11762). `ChatComposer` forwards it to `ComposerFooterPrimaryActions` (props block ~1356, JSX ~7665), which mounts `ContextWindowMeter` or `ContextWindowMeterPlaceholder`.
- `ChatComposer` already has `selectedModelSelection: ModelSelection` (memo, ~2374): `createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch)`. Its options are the _explicit_ option selections, the same vocabulary the server writes into `requestIdentity` (index 6.3), so it is the composer's "next request" identity.
- `Sidebar.tsx`: `SidebarThreadRow` (~1107) has two variants. Slim: time label inside `<span className="inline-flex justify-end tabular-nums text-secondary-label transition-opacity ...">` (~1861). Card: the top status slot `<span className="group/sidebar-status-slot ...">` (~2019) holds an inner `<span>` that shows `topStatus` (Working/Approval/Input/Failed/Done/Woke) **or** `threadTimeLabel(thread)` (~2086). Both inner spans fade out (`group-any-hover/sidebar-row:opacity-0`, plus `pointer-events-none`) when the row is hovered, so an own tooltip on the glyph can never be reached. The row-level hover card is `SidebarThreadTooltip` (~431), mounted via `detailsTooltip` (~1380) and by `SidebarSearchResultRow` (~2401). `SidebarThreadSummary` is an alias of `EnvironmentThreadShell`, so `thread.latestTokenUsage` and `thread.modelSelection` are available.
- `useClientSettings` is already imported in `Sidebar.tsx` (line 144); `timestampFormat` is read via `useClientSettings((s) => s.timestampFormat)` in the sidebar body (~2431) and passed to `SidebarThreadRow` as a prop (~1152), so P5's components read it themselves via `useClientSettings`.

---

### Task 1: Pure glyph logic (TDD)

**Files:**

- Create: `apps/web/src/components/pacing/threadContextGlyph.logic.ts`
- Create: `apps/web/src/components/pacing/threadContextGlyph.logic.test.ts`

**Interfaces:**

- Consumes (P1, `@t3tools/shared/usagePacing`): `contextTier`, `contextFraction`, `cacheWarmth`, `cacheExpiresAtMs`, `requestIdentityFromModelSelection`, `formatThreadContextTooltip`, `CONTEXT_TIER_COLORS`, types `PaceTier`, `PaceTierColor`, `CacheWarmth`, `RequestIdentity`. Type `ModelSelection`, `TimestampFormat` from `@t3tools/contracts`.
- Produces (exact names; Tasks 2, 4, 5 import them):

```ts
export type GlyphSize = 14 | 18;

/** Structural subset of OrchestrationV2ProviderTurnTokenUsage; the contract type is assignable to it. */
export interface ThreadContextUsage {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
  readonly updatedAt: string;
  readonly promptCacheTtlMs?: number | undefined;
  readonly requestIdentity?: RequestIdentity | undefined;
}

export interface ThreadContextGlyphModel {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly tier: PaceTier;
  readonly tierColor: PaceTierColor; // CONTEXT_TIER_COLORS[tier]
  readonly fraction: number | null; // contextFraction(usage): null = no arc
  readonly cacheState: CacheWarmth;
  readonly expiresAtMs: number | null; // cacheExpiresAtMs(usage)
}

export function resolveThreadContextGlyph(
  usage: ThreadContextUsage | null | undefined,
  nextSelection: ModelSelection | null | undefined,
  nowMs: number,
): ThreadContextGlyphModel | null;

export function composerGlyphUsage(
  snapshot: {
    readonly usedTokens: number;
    readonly maxTokens: number | null;
    readonly updatedAt: string;
  },
  live:
    | {
        readonly promptCacheTtlMs?: number | undefined;
        readonly requestIdentity?: RequestIdentity | undefined;
      }
    | null
    | undefined,
): ThreadContextUsage;

export interface GlyphGeometry {
  readonly size: GlyphSize;
  readonly center: number;
  readonly radius: number;
  readonly strokeWidth: number;
  readonly circumference: number;
  readonly dotRadius: number;
}
export function glyphGeometry(size: GlyphSize): GlyphGeometry;
export function arcDashArray(fraction: number | null, circumference: number): string | null;
export function dotFillClass(cacheState: CacheWarmth): string | null;
export function formatGlyphTooltip(
  model: ThreadContextGlyphModel,
  timestampFormat: TimestampFormat,
): string;
export function glyphCacheClause(
  model: ThreadContextGlyphModel,
  timestampFormat: TimestampFormat,
): string | null;
```

**Behaviour, precisely:**

- `resolveThreadContextGlyph`: returns `null` when `usage` is `null`/`undefined` (this is the single "no glyph" rule; a report with `usedTokens: 0` still yields a model). Otherwise: `maxTokens = usage.maxTokens ?? null`; `tier = contextTier(usage)`; `tierColor = CONTEXT_TIER_COLORS[tier]`; `fraction = contextFraction(usage)`; `next = requestIdentityFromModelSelection(nextSelection)`; `cacheState = cacheWarmth(usage, next, nowMs)`; `expiresAtMs = cacheExpiresAtMs(usage)`. No clamping or tier logic of its own.
- `composerGlyphUsage`: `{ usedTokens, maxTokens, updatedAt }` from the snapshot, plus `promptCacheTtlMs` and `requestIdentity` copied from `live` **only when defined** (build the object with conditional spreads; the repo uses `exactOptionalPropertyTypes`, so never assign `undefined` to an optional key). `live` is the same report the snapshot was derived from whenever it is non-null (`deriveLatestContextWindowSnapshot` prefers it), so no timestamp comparison is needed.
- `dotFillClass`: `warm` -> `"fill-muted-foreground"` (`color-mix(muted 45%, muted)` is exactly muted, so the plain class is the spec's formula); `expiring` -> the literal class below; `cold`/`unknown` -> `null`. Keep the class strings as full literals so Tailwind's scanner emits them. A `fill-[color-mix(...)]` arbitrary value would fail lint (`shadcn/no-arbitrary-values` allows arbitrary values only in the `layout`/`transition` categories plus a fixed list in `vite.config.ts`; `fill-[...]` is a colour value), and a literal `fill="color-mix(...)"` attribute fails `shadcn/no-raw-colors`. The repo's precedent (`ContextChip.tsx` line ~76) defines the mix as an arbitrary CSS custom property and paints with the variable shorthand, which passes both rules:

```ts
const EXPIRING_DOT_CLASS =
  "[--thread-glyph-dot:color-mix(in_oklab,var(--color-warning)_45%,var(--color-muted-foreground))] fill-(--thread-glyph-dot)";
```

If `vp lint` still rejects it, fall back to `style={{ fill: "color-mix(in oklab, var(--color-warning) 45%, var(--color-muted-foreground))" }}` on the dot `<circle>` (`no-raw-colors` inspects JSX colour attributes and classes, not `style` objects, and `shadcn/no-inline-styles` is not enabled) and note it in the handoff.

- `formatGlyphTooltip`: `formatThreadContextTooltip({ usedTokens, maxTokens, warmth: cacheState, expiresAtMs, timestampFormat })`.
- `glyphCacheClause`: the part of the tooltip after the first `" · "`, or `null` when there is none (cache unknown). P1 exports no cache-clause formatter (index 6.1), and the composer popover needs one, so this derives it from the single formatter instead of duplicating its wording. Record that in the code comment.

**The SVG geometry (the code is the decision):**

```ts
const STROKE_WIDTH: Record<GlyphSize, number> = { 14: 1.6, 18: 2 };

export function glyphGeometry(size: GlyphSize): GlyphGeometry {
  const strokeWidth = STROKE_WIDTH[size];
  // The stroke is centred on the path, so inset the radius by half of it to keep
  // the outer edge exactly on the viewBox (14 -> r 6.2, 18 -> r 8).
  const radius = (size - strokeWidth) / 2;
  return {
    size,
    center: size / 2,
    radius,
    strokeWidth,
    circumference: 2 * Math.PI * radius,
    dotRadius: size * 0.15, // 14 -> 2.1, 18 -> 2.7
  };
}

/** Dash pattern that paints `fraction` of the circle from the path start, or null for "no arc". */
export function arcDashArray(fraction: number | null, circumference: number): string | null {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return null;
  const painted = Math.min(1, fraction) * circumference;
  return `${painted} ${circumference}`;
}
```

A circle's path starts at 3 o'clock and runs clockwise in screen space, so the component rotates the arc circle by -90 degrees about the centre to start at 12 o'clock (Task 2). `fraction === 0` yields no arc element at all: a zero-length dash with round caps paints a speck.

- [ ] **Step 1: Write the failing test file.** Cases (all with `nowMs = Date.parse("2026-10-11T12:00:00.000Z")`, `usage.updatedAt` written as ISO strings relative to it; build `ModelSelection` values as `{ instanceId: ProviderInstanceId.make("claudeAgent"), model, options? }`; build inline, no shared builder):

`resolveThreadContextGlyph`

| #   | usage                                                                                                 | next selection                                                             | expected                                                                      |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `null`                                                                                                | any                                                                        | `null`                                                                        |
| 2   | used 40k, max 200k, no ttl                                                                            | null                                                                       | tier 0, color `muted`, fraction 0.2, cacheState `unknown`, expiresAtMs `null` |
| 3   | used 120k, max 200k (60 %), ttl 3_600_000, updatedAt now-60s                                          | null                                                                       | tier 1, `yellow`, fraction 0.6, `warm`, expiresAtMs = updatedAt + ttl         |
| 4   | used 380k, max 1M, ttl 3_600_000, updatedAt now-60s                                                   | null                                                                       | tier 2 (token tier >= 300k beats 38 %), `orange`, fraction 0.38, `warm`       |
| 5   | used 250k, max `null`                                                                                 | null                                                                       | tier 1 (token tier), fraction `null`, `maxTokens` null                        |
| 6   | used 250k, max 0                                                                                      | null                                                                       | fraction `null`                                                               |
| 7   | used 1_200_000, max 1_000_000                                                                         | null                                                                       | tier 3, fraction 1                                                            |
| 8   | used 100k, max 200k, ttl 300_000, updatedAt now-240s (60 s left, warn window min(600 s, 75 s) = 75 s) | null                                                                       | `expiring`                                                                    |
| 9   | same but updatedAt now-400s                                                                           | null                                                                       | `cold`                                                                        |
| 10  | ttl 3_600_000, updatedAt now-60s, `requestIdentity {model: "claude-opus-4-7", effort: "high"}`        | selection model `claude-opus-4-7`, options `[{id:"effort", value:"low"}]`  | `cold` (effort mismatch)                                                      |
| 11  | same usage as 10                                                                                      | selection model `claude-opus-4-7`, options `[{id:"effort", value:"high"}]` | `warm` (switching back restores)                                              |
| 12  | same usage as 10                                                                                      | selection model `claude-opus-4-7`, no options                              | `warm` (absent field skipped)                                                 |
| 13  | ttl 3_600_000, `updatedAt: "not a date"`                                                              | null                                                                       | `unknown`, `expiresAtMs` null, does not throw                                 |
| 14  | row 3 evaluated at nowMs + 58 min then + 60 min (expiry is nowMs + 59 min: 60 s left, then past it)   | null                                                                       | `expiring` then `cold` (clock alone drives it)                                |
| 15  | used 0, max 200k                                                                                      | null                                                                       | non-null model, tier 0, fraction 0                                            |

`composerGlyphUsage`

| #   | snapshot                          | live                                                            | expected result keys                                                                                                       |
| --- | --------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | used 380k, max 1M, updatedAt T    | `{ promptCacheTtlMs: 3_600_000, requestIdentity: {model:"m"} }` | usedTokens, maxTokens, updatedAt, promptCacheTtlMs, requestIdentity all present                                            |
| 2   | used 50k, max `null`, updatedAt T | `null`                                                          | exactly `usedTokens`, `maxTokens: null`, `updatedAt`; **no** `promptCacheTtlMs` / `requestIdentity` keys (`toStrictEqual`) |
| 3   | used 50k, max 200k                | `{}` (compaction-style report)                                  | same as row 2 (so the ring renders, cache unknown)                                                                         |

`glyphGeometry` (use `toBeCloseTo`)

| size | strokeWidth | radius | center | dotRadius | circumference |
| ---- | ----------- | ------ | ------ | --------- | ------------- |
| 14   | 1.6         | 6.2    | 7      | 2.1       | 2*pi*6.2      |
| 18   | 2           | 8      | 9      | 2.7       | 2*pi*8        |

`arcDashArray(fraction, C=40)`

| fraction | expected  |
| -------- | --------- |
| `null`   | `null`    |
| 0        | `null`    |
| -0.1     | `null`    |
| `NaN`    | `null`    |
| 0.25     | `"10 40"` |
| 1        | `"40 40"` |
| 1.7      | `"40 40"` |

`dotFillClass`: `warm` -> `"fill-muted-foreground"`; `expiring` -> `EXPIRING_DOT_CLASS` literal (assert it contains `var(--color-warning)`, `45%` written `_45%`, and `var(--color-muted-foreground)`); `cold` -> `null`; `unknown` -> `null`.

`formatGlyphTooltip` / `glyphCacheClause` (model from resolve; `timestampFormat` `"24-hour"`; do **not** assert the clock digits, they depend on the machine's timezone; assert the prefix/suffix and equality with P1's output):

| model                          | tooltip                                                                                                             | clause                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 380k/1M warm                   | starts with `"Context 380k / 1M (38%) · Cache warm, expires "` and equals `formatThreadContextTooltip(same inputs)` | starts with `"Cache warm, expires "` |
| expiring                       | contains `"· Cache expiring "`                                                                                      | starts with `"Cache expiring "`      |
| cold                           | exactly `"Context 380k / 1M (38%) · Cache cold"`                                                                    | `"Cache cold"`                       |
| unknown                        | exactly `"Context 380k / 1M (38%)"`                                                                                 | `null`                               |
| max `null`, used 250k, unknown | exactly `"Context 250k"`                                                                                            | `null`                               |

- [ ] **Step 2: Run to verify it fails** (module not found):
      `builtin cd /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p5-web-glyph; PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/pacing/threadContextGlyph.logic.test.ts`
- [ ] **Step 3: Implement `threadContextGlyph.logic.ts`** per the behaviour and code above.
- [ ] **Step 4: Run the same command; expect all PASS.**
- [ ] **Step 5: Typecheck and lint.**
      `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/pacing/threadContextGlyph.logic.ts apps/web/src/components/pacing/threadContextGlyph.logic.test.ts`
- [ ] **Step 6: Commit** `feat(web): context glyph state, geometry and tooltip logic`.

---

### Task 2: The glyph component, clock hook, sidebar badge and hover-card line

**Files:**

- Create: `apps/web/src/components/pacing/ThreadContextGlyph.tsx`

**Interfaces:**

- Consumes: Task 1 exports; `PACE_TIER_CLASSES` (`./paceTierClasses`); `useNowTick` (`~/hooks/useNowTick`); `cn` from `~/lib/utils`; `useClientSettings` from `~/hooks/useSettings`; `SidebarThreadSummary` type from `~/types`.
- Produces (exact):

```ts
export function ThreadContextGlyph(props: {
  size: GlyphSize;
  model: ThreadContextGlyphModel;
  className?: string | undefined;
}): JSX.Element;

/** Subscribes to the shared 30 s clock; the only place the glyph reads time. */
export function useThreadContextGlyphModel(
  usage: ThreadContextUsage | null | undefined,
  nextSelection: ModelSelection | null | undefined,
): ThreadContextGlyphModel | null;

/** 14 px glyph for a sidebar row; renders nothing without usage. */
export function ThreadContextGlyphBadge(props: {
  thread: Pick<SidebarThreadSummary, "latestTokenUsage" | "modelSelection">;
  className?: string | undefined;
}): JSX.Element | null;

/** Hover-card row: glyph + the tooltip string; renders nothing without usage. */
export function ThreadContextTooltipLine(props: {
  thread: Pick<SidebarThreadSummary, "latestTokenUsage" | "modelSelection">;
}): JSX.Element | null;
```

**Behaviour:**

- `useThreadContextGlyphModel`: `const nowMs = useNowTick(30_000)`; return `useMemo(() => resolveThreadContextGlyph(usage, nextSelection, nowMs), [usage, nextSelection, nowMs])`.
- `ThreadContextGlyphBadge`: when `thread.latestTokenUsage` is `null`/`undefined` return `null` **before** any hook subscription (split into an outer component that checks and an inner `ThreadContextGlyphLive` that calls the hook, so rows without usage do not subscribe to the clock). Otherwise render `ThreadContextGlyph size={14}`. `usage` = `thread.latestTokenUsage`, `nextSelection` = `thread.modelSelection`.
- `ThreadContextTooltipLine`: same split. Inner component calls the hook and `useClientSettings((s) => s.timestampFormat)`; renders `<div className="flex min-w-0 items-center gap-2"><ThreadContextGlyph size={14} model className="shrink-0" /><div className="min-w-0 truncate text-foreground/75">{formatGlyphTooltip(model, timestampFormat)}</div></div>`. It mounts only while the hover card is open (Base UI tooltip popups are unmounted when closed), so its clock subscription is short-lived.
- `ThreadContextGlyph` is a plain function component (no hooks, no `memo`; the model object changes every tick anyway).

**The SVG (the code is the decision):** root `<svg>` is `aria-hidden="true"` (the row/button owns the accessible name) with these data attributes (index 6.6, P6 selects on them): `data-thread-context-glyph=""`, `data-size={size}`, `data-cache-state={model.cacheState}`, `data-context-tier={model.tier}`.

```tsx
const SIZE_CLASS: Record<GlyphSize, string> = { 14: "size-3.5", 18: "size-4.5" };

export function ThreadContextGlyph({ size, model, className }: {...}) {
  const g = glyphGeometry(size);
  const dash = arcDashArray(model.fraction, g.circumference);
  const dotClass = dotFillClass(model.cacheState);
  // With no arc to colour (window size unknown), tint the track with the tier
  // colour instead, so a 300k+ context without a known window is not mistaken
  // for a healthy one. A known fraction keeps the neutral track.
  const trackColor = model.fraction === null ? model.tierColor : "muted";
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
      data-thread-context-glyph=""
      data-size={size}
      data-cache-state={model.cacheState}
      data-context-tier={model.tier}
      className={cn("mx-0! shrink-0", SIZE_CLASS[size], className)}
    >
      <circle
        cx={g.center}
        cy={g.center}
        r={g.radius}
        fill="none"
        strokeWidth={g.strokeWidth}
        className={cn("opacity-25", PACE_TIER_CLASSES[trackColor].stroke)}
      />
      {dash === null ? null : (
        <circle
          cx={g.center}
          cy={g.center}
          r={g.radius}
          fill="none"
          strokeWidth={g.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={dash}
          transform={`rotate(-90 ${g.center} ${g.center})`}
          className={cn(
            "transition-[stroke-dasharray,stroke] duration-500 ease-out motion-reduce:transition-none",
            PACE_TIER_CLASSES[model.tierColor].stroke,
          )}
        />
      )}
      {dotClass === null ? null : (
        <circle cx={g.center} cy={g.center} r={g.dotRadius} className={dotClass} />
      )}
    </svg>
  );
}
```

`mx-0!` is carried over from the old meter ring (it cancels the margin the `Button` primitive applies to child svgs). `size-4.5` is 18 px at the default 16 px root; the viewBox scales the drawing with it, so geometry stays proportional if the interface font size changes. No other class is needed.

- [ ] **Step 1: Implement the file** per the above. No test file: the logic is covered in Task 1 and AGENTS.md forbids static-markup render tests.
- [ ] **Step 2: Typecheck and lint.**
      `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/pacing/ThreadContextGlyph.tsx`
- [ ] **Step 3: Commit** `feat(web): thread context glyph component`.

---

### Task 3: Settings key `composerContextRingEnabled` (TDD)

**Files:**

- Modify: `packages/contracts/src/settings.ts` (schema line ~450 comment + key; patch ~1664)
- Modify: `packages/contracts/src/settings.test.ts` (`describe("ClientSettings context window meter")`, ~652-664)
- Modify: `apps/desktop/src/settings/DesktopClientSettings.test.ts` (line ~36)
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` (~623, ~695, ~809, `LEGACY_FEATURE_TARGET_IDS` ~2088, legacy row ~2143)
- Modify: `apps/web/src/components/settings/settingsSearch.ts` (item ~605) and `settingsSearch.test.ts` (~478)
- Modify: `apps/web/src/components/settings/UsagePacingSettings.tsx`

**Interfaces:**

- Consumes: P4-foundation's `UsagePacingSettingsPanel`, search path `/settings/usage-pacing`.
- Produces: client setting `composerContextRingEnabled: boolean` (default `true`) in `ClientSettingsSchema` and `ClientSettingsPatch`; search item id `usage-pacing-context-ring`. Task 4 reads `settings.composerContextRingEnabled`.

**Decisions (index 9 D3/D4, followed provisionally):** a fresh key, so decoding drops the stored `contextWindowMeterEnabled: false` that every existing install has persisted and everyone, including the user's own install, gets the new default. Same precedent as `legacySidebarEnabled` (settings.ts comment ~466). The row lives at the bottom of the Usage pacing section, not in Legacy features.

**Schema edit.** Replace the block at ~448-450:

```ts
  // Composer context ring (spec: usage pacing 3.3/3.4). A fresh key rather than
  // a flipped default: client settings persist as one full object, so every
  // install that ever saved settings has the retired `contextWindowMeterEnabled:
  // false` stored; decoding drops that key and the new default reaches them too.
  composerContextRingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
```

and in `ClientSettingsPatch` replace `contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean)` with `composerContextRingEnabled: Schema.optionalKey(Schema.Boolean)`.

**Test table (`settings.test.ts`, replace the old describe with `describe("ClientSettings composer context ring")`):**

| Input                                                              | Expected                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `decodeClientSettings({})`                                         | `.composerContextRingEnabled === true`                                                       |
| `decodeClientSettings({ composerContextRingEnabled: false })`      | `false`                                                                                      |
| `decodeClientSettings({ contextWindowMeterEnabled: false })`       | `.composerContextRingEnabled === true` and `"contextWindowMeterEnabled" in result === false` |
| `decodeClientSettingsPatch({ composerContextRingEnabled: false })` | `.composerContextRingEnabled === false`                                                      |
| `decodeClientSettingsPatch({ composerContextRingEnabled: "no" })`  | throws                                                                                       |

`DesktopClientSettings.test.ts`: rename the fixture entry to `composerContextRingEnabled: false` (non-default now, so the persist/reload round trip still exercises a non-default value).

**Web readers:**

- `SettingsPanels.tsx` `useSettingsRestore`: the dirty-label entry (~623) becomes `settings.composerContextRingEnabled !== DEFAULT_UNIFIED_SETTINGS.composerContextRingEnabled ? ["Context ring in composer"] : []`; the dependency list entry (~695) and the reset object entry (~809) rename the key. Do not touch P4's six `usagePacing*` entries.
- `SettingsPanels.tsx` `LegacyFeaturesSection`: delete the `legacy-context-window-indicator` `SettingsRow` (~2143-2155) and its entry in `LEGACY_FEATURE_TARGET_IDS` (~2088). The other two legacy rows stay.
- `settingsSearch.ts`: replace the item at ~605 with

  ```ts
  {
    id: "usage-pacing-context-ring",
    title: "Show context ring in composer",
    to: "/settings/usage-pacing",
    searchTerms: ["context window meter usage tokens circle cache dot composer ring"],
  },
  ```

  Scope needs no entry of its own: the section's `SETTINGS_CATEGORY_SCOPES["/settings/usage-pacing"]` is `null` (P4).

- `settingsSearch.test.ts` (~478): the loop becomes `for (const id of ["legacy-plan-mode", "legacy-sidebar", "usage-pacing-context-ring"])` (all scope `null`); add one assertion that no search item has id `legacy-context-window-indicator`.
- `UsagePacingSettings.tsx`: P4's panel is `SettingsPageContainer > SettingsSection` holding six rows; append **one** `SettingsRow` for the ring as the seventh (last) child of that `SettingsSection` (index 6.5; there is no separate group or section, `SettingsSection` already draws the grouped card). Read the file first and copy the import lines and row shape of P4's three "Show ... window" switches (same settings hooks, same `searchableSetting(...)` spread, same `SettingResetButton` pattern as the `composer-rich-text` row in `SettingsPanels.tsx` ~2742). Row content: `{...searchableSetting("usage-pacing-context-ring")}`; `description="Shows the thread's context size and prompt-cache state as a ring next to the send button. The sidebar always shows it."`; `resetAction` shown when the value differs from `DEFAULT_UNIFIED_SETTINGS.composerContextRingEnabled` (label `"context ring in composer"`); `control` a `Switch` with `checked={settings.composerContextRingEnabled}`, `onCheckedChange={(checked) => updateSettings({ composerContextRingEnabled: Boolean(checked) })}`, `aria-label="Show context ring in composer"`.

- [ ] **Step 1: Rewrite the contracts test** per the table (it fails: key does not exist).
      `PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/contracts/src/settings.test.ts`
- [ ] **Step 2: Edit `settings.ts`**; re-run; expect PASS.
- [ ] **Step 3: Update the settings-search test** (loop + new assertion); run `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/settingsSearch.test.ts`; expect FAIL.
- [ ] **Step 4: Edit `settingsSearch.ts`, `SettingsPanels.tsx`, `UsagePacingSettings.tsx`** and the desktop fixture; re-run the search test (PASS) plus the restore test file that exists next to the panels:
      `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/SettingsPanels.restore.test.tsx apps/desktop/src/settings/DesktopClientSettings.test.ts`
- [ ] **Step 5: Typecheck** every package whose files changed (the composer readers in `ChatComposer.tsx` still use the old key until Step 6, so run contracts and desktop now and the web typecheck after Step 6):
      `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/contracts#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/desktop#typecheck`
- [ ] **Step 6: Rename the two `settings.contextWindowMeterEnabled` readers in `ChatComposer.tsx` (lines ~2416 and ~7669) in this task too, so the commit leaves the web typecheck green.** Then run the web typecheck and lint below, then commit: `feat(settings): composer context ring setting moves to Usage pacing, default on`.

  Lint: `PATH="$PWD/node_modules/.bin:$PATH" vp lint packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/UsagePacingSettings.tsx apps/web/src/components/chat/ChatComposer.tsx`

---

### Task 4: Composer glyph in `ContextWindowMeter`

**Files:**

- Modify: `apps/web/src/components/chat/ContextWindowMeter.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx` (`ComposerFooterPrimaryActions` props ~1356 and JSX ~1398; `ChatComposer` props ~1612 and destructure ~1757; JSX ~7665)
- Modify: `apps/web/src/components/ChatView.tsx` (~11762)

**Interfaces:**

- Consumes: Task 1/2 exports, `settings.composerContextRingEnabled` (Task 3).
- Produces: `ContextWindowMeter` new props (all required except where noted):

```ts
usage: ContextWindowSnapshot;                       // unchanged
liveUsage: { promptCacheTtlMs?: number | undefined; requestIdentity?: RequestIdentity | undefined } | null;
nextModelSelection: ModelSelection | null | undefined;
timestampFormat: TimestampFormat;
// modelDisplayName, onCompact, compactDisabled, compactDisabledReason unchanged
```

`ChatComposer` new prop `activeThreadLiveTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null` (type from `@t3tools/contracts`), placed with the "Context window" props next to `activeContextWindow`.

**Behaviour of `ContextWindowMeter`:**

- `const model = useThreadContextGlyphModel(composerGlyphUsage(usage, liveUsage), nextModelSelection)`. Memoise the `composerGlyphUsage(...)` call on `[usage, liveUsage]` so the hook's `useMemo` dependency is stable. `model` is non-null here (the meter only mounts with a snapshot); still guard with `model === null ? null : ...` rather than a non-null assertion.
- Inside the `Button`, replace the whole `<span className="relative flex size-5 ..."><svg ...>...</svg></span>` with `<span className="flex size-5 items-center justify-center"><ThreadContextGlyph size={18} model={model} /></span>`. Delete `radius`, `circumference`, `dashOffset`, `isOverloaded`, and the `usageColor` ring maths that fed the old SVG.
- Button `aria-label`: `formatGlyphTooltip(model, timestampFormat)` (the spec tooltip, e.g. `Context 380k / 1M (38%) · Cache warm, expires 3:12pm`). Keep the old label strings as the fallback only if `model` were null.
- Popover progress bar: fill class becomes `PACE_TIER_CLASSES[model.tierColor].bg` instead of the inline `backgroundColor: usageColor` (tier 0 muted, then yellow/orange/red), so the bar and the ring agree. Keep `style={{ width: ... }}` (runtime value) and the transition classes. Drop `usageColor`.
- Popover body: directly under the progress bar (or under the header row when `maxTokens` is null) add, when `glyphCacheClause(model, timestampFormat)` is non-null: `<div className="text-pretty text-secondary-label text-2xs">{clause}</div>`. Nothing else in the popover changes (total processed, cost, auto-compact message, Compact button, `composerFloatingLayerProps`).
- `formatPercentage` and the "Context Window" header stay.

**Plumbing in `ChatComposer`:**

- `ComposerFooterPrimaryActions` gets three new props: `activeThreadLiveTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null`, `nextModelSelection: ModelSelection`, `timestampFormat: TimestampFormat`; it passes them to `ContextWindowMeter` as `liveUsage`, `nextModelSelection`, `timestampFormat`.
- At the JSX site (~7665) pass `activeThreadLiveTokenUsage={activeThreadLiveTokenUsage}`, `nextModelSelection={selectedModelSelection}`, `timestampFormat={settings.timestampFormat}`. `selectedModelSelection` is the picker's current selection (a memo), so changing model or effort re-resolves the glyph on the next render, with no server round trip: that is spec 7 item 3's "removes the dot immediately".
- `ChatView.tsx` passes `activeThreadLiveTokenUsage={activeThreadLiveTokenUsage}` right after `activeContextWindow={activeContextWindow}`. The variable already exists (~1725).
- The existing resume-compaction offer in `ChatView.tsx` (~7742) keeps using `activeThreadLiveTokenUsage?.promptCacheTtlMs` and `nowMinute`; do not touch it.

**Tests:** logic is covered by Task 1; there is no new pure function here. Existing tests that must still pass: `ContextWindowMeter.logic.test.ts`.

- [ ] **Step 1: Edit `ContextWindowMeter.tsx`** as above.
- [ ] **Step 2: Edit `ChatComposer.tsx` and `ChatView.tsx`** as above.
- [ ] **Step 3: Run** `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/chat/ContextWindowMeter.logic.test.ts apps/web/src/components/pacing/threadContextGlyph.logic.test.ts` (PASS).
- [ ] **Step 4: Typecheck and lint** `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/chat/ContextWindowMeter.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/ChatView.tsx`
- [ ] **Step 5: Commit** `feat(web): composer context meter uses the shared glyph`.

---

### Task 5: Sidebar glyph

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**

- Consumes: `ThreadContextGlyphBadge`, `ThreadContextTooltipLine` (Task 2).
- Produces: nothing new.

**Edits, by anchor:**

1. **Card variant** (`group/sidebar-status-slot`, ~2019): inside the first inner `<span className={cn(isWokeStatus ? ... , "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity", ...)}>`, insert `<ThreadContextGlyphBadge thread={thread} className="mr-1.5" />` as its **first child**, before the `{topStatus ? (...) : (threadTimeLabel(thread))}` expression. It therefore sits immediately before the relative timestamp, and also before a `Working`/`Approval`/`Input`/`Failed`/`Done`/`Woke` label when one replaces the timestamp (every row carries the glyph, spec 3.3). It shares the span's hover-fade and `pointer-events-none`, so it yields to the settle/snooze actions exactly like the timestamp.
2. **Slim variant** (`inline-flex justify-end tabular-nums text-secondary-label transition-opacity`, ~1861): add `items-center` to that span's classes and insert `<ThreadContextGlyphBadge thread={thread} className="mr-1.5" />` as its first child (before the snooze-wake / Woke / `threadTimeLabel` branches).
3. **`SidebarThreadTooltip`** (~431): the hover card is the only tooltip surface a user can reach, because the status span fades out under the pointer. Add `<ThreadContextTooltipLine thread={thread} />` as a child of `ThreadHoverCard`, immediately **after** the `driverKind ? (...)` model row and before the `previousProviderNames` row. The component reads `thread.latestTokenUsage` / `thread.modelSelection` itself and the timestamp format from `useClientSettings`, so neither `SidebarThreadRow` nor `SidebarSearchResultRow` needs new props, and search results get the line for free.
4. Do **not** add the glyph to `SidebarSearchResultRow` (~2387, a fixed `w-8` timestamp column in a search listbox) or to `SidebarDraftRow`. Record: see Open question 3.
5. Import `ThreadContextGlyphBadge` and `ThreadContextTooltipLine` from `./pacing/ThreadContextGlyph`.

`SidebarThreadRow` stays a `memo` component: the badge's clock subscription lives in the badge, so a 30 s tick re-renders glyphs only, never rows.

**Tests:** none new (placement only; logic covered in Task 1; AGENTS.md forbids markup-assertion tests). Run the existing sidebar logic tests that live next to the file to confirm nothing regressed:
`PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.snooze.test.ts`.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run the sidebar tests above (PASS).**
- [ ] **Step 3: Typecheck and lint** `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/Sidebar.tsx`
- [ ] **Step 4: Commit** `feat(web): context ring and cache dot on sidebar thread rows`.

---

### Task 6: User docs and final verification

**Files:**

- Modify: `docs/user/composer.md` (around the `/compact` paragraph, line ~217-218)

Replace the sentence "Web and desktop also offer compaction from the context meter." context with a short paragraph (product voice, no implementation detail):

> The ring beside the send button, and on every thread in the sidebar, shows how full the thread's context is. It turns yellow, orange and red as the context grows. A small dot means the thread's prompt cache is still warm; it turns amber shortly before the cache expires and disappears once it has. Hover the ring for the exact numbers. Turn the composer's ring off in **Settings > Usage pacing**; the sidebar always shows it. Web and desktop also offer compaction from the composer's ring.

- [ ] **Step 1: Edit the doc.**
- [ ] **Step 2: Run the plan's whole verification set** (targeted, never repo-wide):
      `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/pacing/threadContextGlyph.logic.test.ts apps/web/src/components/chat/ContextWindowMeter.logic.test.ts apps/web/src/components/settings/settingsSearch.test.ts packages/contracts/src/settings.test.ts apps/desktop/src/settings/DesktopClientSettings.test.ts`
      `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/contracts#typecheck; PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/desktop#typecheck`
      `PATH="$PWD/node_modules/.bin:$PATH" vp lint <every file this plan changed>` and `PATH="$PWD/node_modules/.bin:$PATH" vp fmt --check <same files>` (drop `--check` and re-run if the formatter reports changes).
- [ ] **Step 3: Grep for leftovers:** `grep -rn "contextWindowMeterEnabled\|legacy-context-window-indicator" apps packages --include=*.ts --include=*.tsx` must print nothing (the spec and plan files under `docs/` are expected to mention them).
- [ ] **Step 4: Commit** `docs(user): context ring and cache dot`.
- [ ] **Step 5: Report** the branch head SHA and the verification output to the orchestrator. Do not launch a dev server (AGENTS.md "Verifying"); the end-to-end pass is P6's.

## Hit-every-surface walk (AGENTS.md)

| Surface          | Applies?                                                                                                                                                                        | Where  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Entry points     | Settings toggle (Task 3), settings search (Task 3), sidebar and composer (Tasks 4-5). No command palette or keybinding applies.                                                 |        |
| Clients          | Web and desktop (desktop wraps web; only its settings fixture changes). Mobile out of scope; `presentThreadShell` already carries the field (P3).                               | Task 3 |
| Providers        | Glyph renders for any provider that reports usage; non-Claude threads get the ring and no dot (no TTL or identity), consistent with spec 9.4. Not tested beyond Claude.         |        |
| Agents/MCP       | N/A, UI only.                                                                                                                                                                   |        |
| Contracts        | Client setting key swap only.                                                                                                                                                   | Task 3 |
| Reverse states   | The toggle turns the composer ring off and on; Restore defaults covers the key.                                                                                                 | Task 3 |
| Connection modes | Pure client rendering from synced shell/projection data; works local and remote. A fork client on an upstream server gets no `latestTokenUsage`, so no sidebar glyph (index 4). |        |
| Docs             | `docs/user/composer.md`.                                                                                                                                                        | Task 6 |

## Testing Strategy

- **Hermetic (this plan, all of it):** the `threadContextGlyph.logic` tables (tier, fraction clamp, cache state across identity and clock, geometry, arc dash, dot class, tooltip strings, composer input assembly) and the settings decode / search tests. Plus targeted typecheck (web, contracts, desktop), lint and format on changed files. Per AGENTS.md no component is rendered to static markup and no tests assert wiring.
- **End-to-end: not run by this plan.** AGENTS.md says subagents do not launch dev servers and the integrated browser pass is done once by the primary agent; P6 owns it. P6 covers, for this plan: spec 7 item 3 (sidebar and composer glyphs appear after a turn with the dot present while warm; switching the composer's model or effort removes the dot at once and switching back restores it; located through `[data-thread-context-glyph]`, `data-cache-state`, `data-context-tier`, `data-size`) and item 4 (after a subagent/workflow turn the ring stays at the real context size). Expiry by waiting (5 min / 1 h) is covered hermetically by Task 1 rows 8, 9 and 14.
- **Mockups:** `docs/superpowers/specs/assets/usage-pacing/sidebar-glyph.png` and `composer-glyph.png` predate the grey warm dot and the new tiers; use them only for placement and size, not colour.

## Open questions / spec deviations

1. **Spec 6 "`maxTokens` missing: track only, no arc; colour by the token tier" is self-contradictory (index section 1 P5).** There is no arc to colour. Options: (a) tint the track with the tier colour (still 25 % opacity, so tier 0 looks exactly like today's neutral track); (b) draw a full-opacity full ring in the tier colour when the tier is above 0; (c) ignore the tier and show a neutral track. Recommendation: (a), implemented in `ThreadContextGlyph` as `trackColor = model.fraction === null ? model.tierColor : "muted"`. It keeps "track only, no arc", still signals a 200k+ context, and needs no new geometry. Changes user-visible behaviour only for providers without a window size; the coherence agent should list it under Decisions needed rather than apply it to the spec.
2. **Sidebar tooltip lives in the row's hover card, not on the glyph (deviates from spec 3.3 "Tooltip (sidebar and composer)").** The glyph sits in a status span that is `pointer-events-none` and fades to opacity 0 under the row's hover, so a tooltip bound to the glyph is unreachable. Options: (a) a line inside the existing thread hover card (`SidebarThreadTooltip`) showing the glyph plus the spec string; (b) move the glyph out of the fading span so it stays hoverable and nest a second tooltip inside the row's tooltip trigger, which also shifts the hover actions. Recommendation: (a). Same text, one tooltip surface, no layout change. User-visible: where the text appears.
3. **Glyph scope in the sidebar.** Spec 3.3 says "every thread row ... immediately before the relative timestamp", but the card row shows a status label (Working, Approval, Input, Failed, Done, Woke) instead of the timestamp for non-idle threads, and the search-result and draft rows have their own layouts. Options: glyph only where the timestamp shows, or on every row. Recommendation: glyph first in the status slot in both states, so the ring is visible on exactly the threads a user is about to act on; none in search results (fixed `w-8` column inside a listbox, but they do get the hover-card line) or draft rows (no usage exists). User-visible.
4. **P1 exports no cache-clause formatter (contract 6.1), but the composer popover needs the cache state as text.** This plan derives the clause by cutting `formatThreadContextTooltip`'s output at the first `" · "` (`glyphCacheClause`). Recommendation: keep it; if the coherence agent edits the index, add `formatCacheClause` to P1's API and have `glyphCacheClause` call it. No behaviour impact.
5. **Composer popover gains a cache line and the progress bar takes the tier colour.** Spec 3.3 says the popover stays as is, and gives the tooltip text for the composer too, but the popover is the composer's only hover surface. Recommendation: one added text line (the cache clause) and the bar fill in the tier colour so the bar and ring agree. The old red-above-90 % rule is replaced by the 4.4 tiers. User-visible, small.
6. **`ContextWindowSnapshot` carries neither TTL nor identity (index section 1 P5, confirmed).** The composer therefore needs `activeThreadLiveTokenUsage` threaded from `ChatView` into `ChatComposer` and the meter (Task 4). When the snapshot came from `providerThread.contextUsage` or a compaction item there is no live report, so the composer shows a ring with no dot even when the sidebar (reading `latestTokenUsage`) might show one. Recommendation: accept; both paths agree in the normal case because the live report wins whenever it exists.
7. **Sidebar identity uses `thread.modelSelection`, composer uses the picker's selection.** Server `thread.modelSelection` is replaced by each run's selection (`Orchestrator.ts` `selectionChanged`), so after a turn it equals what produced `requestIdentity` and the dot shows. If P6 observes a warm thread reading cold in the sidebar right after a turn, the likely cause is an options difference between the thread's stored selection and the server's identity (raw values, index 9 C5); the fix would be in P3's identity fields, not here.
8. **Stored `contextWindowMeterEnabled` is deliberately dropped (index 9 D3), contrary to spec 9.3's literal "default changes to on".** Users who had turned the meter on lose nothing (default is on); users who had it off (the old default, stored explicitly) get it on. Recommendation: keep the fresh key. User-visible; belongs in Decisions needed.
