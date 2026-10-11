# Usage pacing P4: header pacing widget, popover and settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the active thread's provider rate-limit windows as a stacked pacing widget (bar, pace tick, burn multiple, reset time) in the chat header, with a hover/pin popover and a "Usage pacing" settings section that controls which windows show and what counts as work time.

**Architecture:** All maths comes from P1's `@t3tools/shared/usagePacing`. A pure model builder (`pacingRows.logic.ts`) turns `ServerProviderUsageLimits` + settings + `nowMs` into row models; thin React components (`PacingWidget`, `PacingPopover`, `PacingBar`) render them. `useNowTick(30_000)` is the one shared clock. The widget decides its own layout from the measured width of `<header data-chat-header>` (a `ResizeObserver` via the repo's `observeResize`, not a CSS container query) and publishes its width to the header as a CSS variable so the breadcrumb truncates instead of overlapping. Six new device-local client settings drive it, edited in a new `/settings/usage-pacing` section.

**Tech Stack:** React 19 + React Compiler, Base UI popover (via `components/ui/popover.tsx`), Tailwind v4 (lint rule `shadcn/no-unknown-classes`), Effect `Schema` (contracts), vitest through `vp test run` (import from `vite-plus/test`), TanStack Router (generated `routeTree.gen.ts`).

**Spec:** `docs/superpowers/specs/2026-10-11-usage-pacing-design.md` sections 3.1, 3.2, the pacing rows of 3.4, and the `PacingWidget` / `PacingPopover` / `useNowTick` / settings parts of 5.4. Mockups: `docs/superpowers/specs/assets/usage-pacing/header-widget.png`, `header-popover.png`. Shared contract: `docs/superpowers/plans/2026-10-11-usage-pacing-index.md` (sections 6.1, 6.4, 6.5, 6.6, 6.7, 7, 9). This plan conforms to it except where "Open questions / spec deviations" says otherwise.

## Global Constraints

Every task's requirements include these (values copied from the spec and AGENTS.md):

- Text in the header widget is 11px (`text-2xs`, `--text-2xs: 0.6875rem`). Bar 76px x 3px. Pace tick 1.5px wide, foreground colour. Row gap 5px with one or two rows, 1px with three.
- Popover 280px wide (`w-70`); section bars 4px tall; hidden (toggled-off) sections at 55% opacity (`opacity-55`) with a muted `hidden` tag after the title; no explanatory prose.
- Header width below 560px drops the reset column; below 420px hides the widget. Measured on `<header data-chat-header>`, not the viewport.
- Time-dependent values recompute on one shared 30s tick: `useNowTick(30_000)`.
- Settings defaults: show session on, show weekly on, show model-scoped on, work hours `"09:00-17:00"`, work days `[1, 2, 3, 4, 5]` (0 = Sunday), off-hours weight `0.2` (0 to 1, step 0.05). Defaults must equal P1's `DEFAULT_WORK_HOURS`, `DEFAULT_WORK_DAYS`, `DEFAULT_OFF_HOURS_WEIGHT`.
- Every window the provider reports is in the popover; only windows whose toggle is on are in the header. The widget renders nothing when no header row qualifies, including `usageLimits === undefined` and `usageLimits.unavailable`.
- No continuously repainting animation (AGENTS.md "Taste"): no CSS transitions on bar fill or tick in this feature.
- Lint rules that apply to `apps/web/src/**`: `t3code/no-raw-resize-observer` (use `observeResize` from `~/lib/observeResize`), `shadcn/no-unknown-classes` (only real Tailwind classes; JS hooks use `data-*`), `shadcn/no-raw-colors` (Tailwind palette classes such as `text-yellow-400` pass; hex/`rgb()`/`color-mix()` literals do not), `t3code/require-suppression-reason`.
- Tests (AGENTS.md "Verifying"): no static-markup rendering of components, no tests that only assert callback wiring. Run only targeted `vp test run <files>`, `vp run <pkg>#typecheck`, `vp lint <files>`. Never repo-wide checks. Subagents do not launch dev servers; the integrated browser pass is P6's.
- Do not touch `ClaudeAdapterV2.ts`, `ProjectionStore.ts`, `Sidebar.tsx`, `ChatComposer.tsx`, `ContextWindowMeter.tsx` (other plans). Do not edit the spec file or the statusline repo. No push, no PR.
- Commit titles are conventional and plain, for example `feat(web): usage pacing settings section`.

## Review Focus

Failure modes the spec implies but a straight reading of the tasks would not exercise. Each has a test in the owning task.

1. **Right panel open (inline) or sheet.** The fixed top-right cluster overlays the right panel's tab bar when the inline panel is open, so the widget must not sit in it then (it moves beside the thread-details toggle in the header); with the sheet open or during the panel's closing animation it renders nowhere. A widget in the wrong place covers the panel tabs. Pinned by `resolvePacingPlacement` table (Task 6).
2. **A window with no `resetsAt`, or one whose `resetsAt` already passed** (stale snapshot between probes): row keeps bar and burn column but no tick/reset (missing) or no burn/tick and a `now` countdown (past); nothing throws. Pinned in `buildPacingModel` table (Task 6).
3. **Four or more qualifying windows** (a provider with several model-scoped weeklies; Cursor reports three, Claude may add Sonnet beside Fable): three rows fit the 52px header, four do not. The header caps at three rows; the popover still lists all. Pinned (Task 6).
4. **Hand-edited or legacy persisted settings**: malformed `usagePacingWorkHours` string, `usagePacingWorkDays: []`. The widget must not crash and must fall back (P1's `resolveWorkSchedule`); the settings UI must show the default hours for a malformed string and refuse to deselect the last work day. Pinned (Tasks 3, 6).
5. **Pinned popover vs hover.** Base UI toggles a hover-opened popover closed on a click made more than 500ms after it opened, which is the opposite of "click pins", and a pinned popover must survive the pointer leaving. A controlled reducer fixes both. Pinned by the reducer table (Task 6).

## Implementation Location

- **Branch:** feat/usage-pacing-p4-web-header
- **Worktree:** /home/jorgen/Code/t3code/.claude/worktrees/usage-pacing-p4-web-header
- **Base branch:** feat/usage-pacing

Created by the orchestrator after P1 and `P2-contract` have merged into `feat/usage-pacing` (index section 5). Tasks 1-5 end at milestone **P4-foundation**: after Task 5's verification passes, report `git rev-parse HEAD`; the orchestrator merges that commit forward. Tasks 6-9 continue on the same branch.

## Testing Strategy

**Hermetic (this plan):**

- `useNowTick`: fake timers, shared-timer and cleanup behaviour (Task 1).
- Contracts: decode defaults, patch acceptance and rejection of the six settings (Task 2).
- Settings logic: work-hours input mapping, weight snapping, work-day set equality, defaults equal P1's constants (Task 3).
- Settings search and restore-defaults: items, scope, dirty labels (Task 5).
- Pacing logic: model builder (visibility, order, hidden flags, formatting, burn/tick via P1), layout breakpoint decision, reserve width, placement, popover reducer, aria label (Task 6).
- Typecheck of `@t3tools/contracts` and `@t3tools/web`, lint of every changed file.

**Not tested hermetically, on purpose:** the React components' markup and layout (AGENTS.md forbids static-markup tests; layout is only meaningful in a real browser).

**End-to-end: deferred to P6, not skipped.** AGENTS.md says subagents do not launch dev servers and the integrated browser pass is done once by the primary agent after integration, which the user approved as Playwright in headless Chrome. P6 covers, using the DOM hooks of index section 6.6: header rows appear and match `/usage` percentages (spec section 7 item 1), session burn appears after samples and a toggled-off window leaves its row and shows `hidden` in the popover (item 2), work hours/days changes move weekly burn and tick (item 6), plus the header placement and breakpoints (screenshots at 1400, 500 and 400px header width, and with the right panel open). This plan's implementers must therefore not claim visual correctness; they hand over the DOM hooks and the visual-spec table below.

**Surface checklist (AGENTS.md "Hit every surface")**

| Surface          | Decision                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points     | Chat header widget and popover; Settings section; settings search and command palette pick up the six search items automatically (`SETTINGS_SEARCH_ITEMS`); popover footer links to `/usage` and `/settings/usage-pacing`. No keybinding (not requested).                              |
| Clients          | Web yes. Desktop wraps web; client settings persist as one object, new keys decode with defaults, `DesktopClientSettings.test.ts` needs no change because its fixture spreads `DEFAULT_CLIENT_SETTINGS`. Mobile out of scope; the maths lives in `packages/shared` so it can reuse it. |
| Providers        | Widget shows whatever windows the thread's provider instance reports (spec 9.4). Roles `session`, `weekly`, `modelScoped` get header rows; role `other` (monthly etc.) is popover-only (index item D1). Only Claude is validated.                                                      |
| Contracts        | Six optional-with-default client settings only.                                                                                                                                                                                                                                        |
| Reverse states   | Every toggle can be turned back on; "Restore device defaults" resets all six; hidden windows stay visible in the popover with a tag.                                                                                                                                                   |
| Connection modes | `activeProviderStatus` is the provider snapshot of the thread's own environment, so remote and tunnelled environments show their own limits.                                                                                                                                           |

## Consumed interfaces (from other plans; code against these)

From P1 `@t3tools/shared/usagePacing` (index 6.1). P4 imports only these names:

`computeWindowPace`, `resolveWorkSchedule`, `parseWorkHours`, `formatWorkHours`, `orderPaceWindows`, `paceWindowRole`, `paceWindowShortLabel`, `paceWindowTitle`, `formatBurn`, `formatResetLabel`, `formatCountdown`, `BURN_TIER_COLORS`, `DEFAULT_WORK_HOURS`, `DEFAULT_WORK_DAYS`, `DEFAULT_OFF_HOURS_WEIGHT`, types `PaceTierColor`, `PaceWindowRole`, `WorkSchedule`.

From P2-contract (index 6.2): `ServerProviderUsageWindow.history` is optional on the wire; P4 passes the window object straight to `computeWindowPace` (structurally assignable to `PaceWindowInput`), so P4 never reads `history` itself and does not depend on server behaviour.

Existing code used (verified at `2ca9e43bb`; re-locate by symbol, lines drift):

- `apps/web/src/components/ChatView.tsx`: `activeProviderStatus` (`selectedProviderEntry?.snapshot ?? null`, ~line 3273), `threadPanelPopoverAnchorRef` (`useRef<HTMLElement | null>`, ~1938, attached to `<header data-chat-header>` ~11341), `inlineRightPanelOwnsTitleBar` (~2390), `rightPanelControlsAtRoot` (~2381), `rightPanelControlsInPanel` (~2379), `threadPanelHeaderControl` (~11249, `absolute` in the header), `panelLayoutControls` (~11263, `fixed` cluster), their render sites (~11331 root, ~11362 inside header, ~11363).
- `apps/web/src/components/chat/ChatHeader.tsx`: root div class `rightPanelOpen ? "pr-10" : "pr-24"` (~305).
- `apps/web/src/lib/observeResize.ts`: `observeResize(elements, callback)`; callback gets `ResizeObserverEntry[]`, runs in `flushSync`.
- `apps/web/src/components/ui/popover.tsx`: `Popover`, `PopoverTrigger` (`openOnHover`, `delay`, `closeDelay`), `PopoverPopup` (`padding="none"`, `side`, `align`, `sideOffset`, extra props such as `data-*` pass to the popup element).
- `apps/web/src/hooks/useSettings.ts`: `useClientSettings(selector?)`, `useUpdateClientSettings()` (returns `(patch) => Promise`).
- `apps/web/src/components/settings/settingsLayout.tsx`: `SettingsPageContainer`, `SettingsSection`, `SettingsRow`; `searchableSetting(id)` from `settingsSearch.ts` returns `{ id, title }`.

## Visual spec (exact values; restate in code via the class tables in Task 7)

Header widget (mockup `header-widget.png`, captured at 2x DPR):

| Element      | Value                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root         | `<div data-pacing-widget class="mr-2">`; absent when nothing renders                                                                                                                   |
| Trigger      | raw `<button type="button">`, `rounded-md px-2 py-1`, `hover:bg-accent/50 data-[popup-open]:bg-accent/50`, `cursor-default`                                                            |
| Row stack    | `flex flex-col`; gap 5px (`gap-1.25`, on Tailwind v4's 4px spacing scale; `shadcn/no-arbitrary-values` rejects `gap-[5px]` outside `components/ui`) for 1-2 rows, 1px (`gap-px`) for 3 |
| Row          | `flex items-center gap-x-1.5 text-2xs leading-3.25 tabular-nums whitespace-nowrap` (13px line height; `leading-[13px]` is rejected by `shadcn/no-arbitrary-values`)                    |
| Label column | `w-8 shrink-0 truncate text-muted-foreground` (`5h`, `7d`, `Fable`)                                                                                                                    |
| Bar          | 76px x 3px (`h-[3px] w-[76px]`), `rounded-full`, track `bg-muted-foreground/25`, fill `PACE_TIER_CLASSES[color].bg` at `usedPercent`%                                                  |
| Tick         | 1.5px wide (`w-[1.5px]`), 6px tall (`h-[6px]`), `bg-foreground`, centred on the bar vertically, `left: paceFraction*100%`, `-translate-x-1/2`; absent when `paceFraction` is null      |
| Burn column  | `w-8 shrink-0 text-right`, `PACE_TIER_CLASSES[color].text`; element kept with empty text when burn is null                                                                             |
| Reset column | `w-16 shrink-0 text-muted-foreground`, left aligned; omitted entirely in `compact` layout and when `resetLabel` is null                                                                |
| Width        | full about 238px, compact about 168px                                                                                                                                                  |

Popover (mockup `header-popover.png`; the type sizes are read from the 2x mockup and are approximate, P6 compares them):

| Element | Value                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Popup   | `PopoverPopup padding="none" side="bottom" align="end" sideOffset={6}`, `data-pacing-popover`; content wrapper `w-70` (280px)                                                                                                                                                                                                                                            |
| Section | `data-pacing-section={id}` `data-hidden="true\|false"`, `flex flex-col gap-2 px-4 py-2.5`, separated by `border-t border-border/50` (container `[&>*+*]:border-t [&>*+*]:border-border/50`), hidden sections add `opacity-55`                                                                                                                                            |
| Line 1  | `flex items-baseline justify-between gap-3`. Left: title `text-sm font-medium text-foreground`, then for hidden sections `<span class="ml-2 text-xs font-normal text-muted-foreground">hidden</span>`. Right: `62%` (`text-sm tabular-nums text-muted-foreground`, `Math.round`) then burn (`ml-3 text-sm font-semibold tabular-nums`, tier text class; empty when null) |
| Line 2  | full-width bar, 4px (`h-1 w-full`), tick 1.5px x 8px (`h-2`)                                                                                                                                                                                                                                                                                                             |
| Line 3  | `flex items-center justify-between text-xs tabular-nums text-muted-foreground`: reset label left, countdown right; whole line omitted when `resetsAtMs` is null                                                                                                                                                                                                          |
| Footer  | `flex items-center justify-between border-t border-border/50 px-4 py-2.5 text-xs text-muted-foreground`; two `<button type="button" class="cursor-pointer hover:text-foreground">`: `Usage details →` (navigate `/usage`) and `Settings` (navigate `/settings/usage-pacing`); both close the popover first                                                               |

Bar fill colour: `BURN_TIER_COLORS[burnTier]` when burn is known, else `muted` (index D6, P4's choice). Tier colours by name: `success` green, `yellow` `yellow-400`, `orange` `orange-500`, `destructive` red, `muted`.

## File map

Create:

| File                                                                         | Responsibility                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/web/src/hooks/useNowTick.ts` + `.test.ts`                              | shared interval clock                                                               |
| `apps/web/src/components/pacing/paceTierClasses.ts`                          | tier-name to Tailwind class map (shared with P5)                                    |
| `apps/web/src/components/pacing/pacingRows.logic.ts` + `.test.ts`            | pure model builder, layout/reserve/placement decisions, popover reducer, aria label |
| `apps/web/src/components/pacing/PacingBar.tsx`                               | bar + fill + tick, header and popover sizes                                         |
| `apps/web/src/components/pacing/PacingPopover.tsx`                           | `Popover` root, trigger button, popup content, hover/pin state                      |
| `apps/web/src/components/pacing/PacingWidget.tsx`                            | clock, settings, model, width observation, reserve variable, rows                   |
| `apps/web/src/components/settings/usagePacingSettings.logic.ts` + `.test.ts` | work-hours input mapping, weight snapping, work-day equality                        |
| `apps/web/src/components/settings/UsagePacingSettings.tsx`                   | `UsagePacingSettingsPanel`                                                          |
| `apps/web/src/components/settings/WeekdayToggleGroup.tsx`                    | extracted weekday picker                                                            |
| `apps/web/src/routes/settings.usage-pacing.tsx`                              | route                                                                               |

Modify: `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`, `apps/web/src/components/settings/settingsSearch.ts` (+`.test.ts`), `SettingsSidebarNav.tsx`, `SettingsScopeSentence.tsx`, `SettingsPanels.tsx` (+`SettingsPanels.restore.test.tsx`), `ScheduledTasksSettings.tsx`, `apps/web/src/routeTree.gen.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`, `docs/user/usage.md`.

---

## Task 1: `useNowTick` and the tier class map (foundation)

**Files:**

- Create: `apps/web/src/hooks/useNowTick.ts`, `apps/web/src/hooks/useNowTick.test.ts`, `apps/web/src/components/pacing/paceTierClasses.ts`

**Interfaces:**

- Consumes: `react` `useSyncExternalStore`; P1 type `PaceTierColor`.
- Produces (index 6.4, exact): `export function useNowTick(intervalMs: number): number` and `export const PACE_TIER_CLASSES: Readonly<Record<PaceTierColor, { readonly text: string; readonly bg: string; readonly stroke: string }>>`.

`useNowMinute.ts` (same folder) is the pattern to follow, with one difference that is the point of this task: its snapshot is quantised to a minute string, so `getSnapshot` is stable by construction. A millisecond clock is not, and React throws "getSnapshot should be cached" if two consecutive calls return different values. So the store keeps one cached `value` per interval and only re-reads `Date.now()` when no timer is running and the cached value is at least one interval old.

- [ ] **Step 1: Write the failing test** in `useNowTick.test.ts`. (All test tables in this plan: use `it.each` for per-row cases, or assert in a loop inside one `it`; lint rule `t3code/no-test-in-loop` rejects `it(...)` inside a `for` loop.) Pattern: `useLiveRefresh.test.ts` (`react-test-renderer` `create`, `act`, `vi.useFakeTimers()`, `vi.setSystemTime`). Use the global `setInterval` in the implementation (not `window.`) so no `window` stub is needed. Probe component renders `String(useNowTick(interval))` into a `renderer.toJSON()`; collect the rendered number.

| Case                         | Setup                                                      | Expected                                                               |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| first render                 | system time T0, mount one consumer `useNowTick(30_000)`    | renders T0                                                             |
| tick advances                | advance 30_000 inside `act`                                | renders T0 + 30_000 (equals `Date.now()`)                              |
| no early tick                | advance 29_999                                             | still T0                                                               |
| one timer for many consumers | mount two consumers with 30_000                            | `vi.getTimerCount() === 1`                                             |
| distinct intervals           | one consumer 30_000, one 60_000                            | `vi.getTimerCount() === 2`; advancing 30_000 re-renders only the first |
| cleanup                      | unmount every consumer                                     | `vi.getTimerCount() === 0`                                             |
| fresh remount                | unmount all, `vi.setSystemTime(T0 + 100_000)`, mount again | renders T0 + 100_000, not T0                                           |
| stable snapshot              | render inside `act` with `console.error` spied             | never called (no "getSnapshot should be cached")                       |

- [ ] **Step 2: Run, expect FAIL (module missing).**
      `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/hooks/useNowTick.test.ts`

- [ ] **Step 3: Implement `useNowTick.ts`** exactly this store (the code is the decision: stable `subscribe`/`getSnapshot` identities per interval, first-subscriber refresh, last-unsubscriber cleanup):

```ts
import { useSyncExternalStore } from "react";

/** Epoch-ms clock refreshed every `intervalMs`. One timer per distinct interval, shared by every
    consumer and stopped when the last one unsubscribes. */
interface TickClock {
  value: number;
  timerId: ReturnType<typeof setInterval> | null;
  readonly listeners: Set<() => void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

const clocks = new Map<number, TickClock>();

function createClock(intervalMs: number): TickClock {
  const clock: TickClock = {
    value: Date.now(),
    timerId: null,
    listeners: new Set(),
    subscribe(listener) {
      if (clock.timerId === null) {
        // First subscriber: the cached value may be up to one interval old.
        clock.value = Date.now();
        clock.timerId = setInterval(() => {
          clock.value = Date.now();
          for (const notify of clock.listeners) notify();
        }, intervalMs);
      }
      clock.listeners.add(listener);
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.timerId !== null) {
          clearInterval(clock.timerId);
          clock.timerId = null;
        }
      };
    },
    getSnapshot() {
      // No timer running (first render, or after a full unmount): refresh once the cached value
      // is a full interval old. While a timer runs the cached value is returned untouched, which
      // useSyncExternalStore requires between change notifications.
      if (clock.timerId === null) {
        const now = Date.now();
        if (now - clock.value >= intervalMs) clock.value = now;
      }
      return clock.value;
    },
  };
  return clock;
}

export function useNowTick(intervalMs: number): number {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
```

- [ ] **Step 4: Create `paceTierClasses.ts`** verbatim from index 6.4 (full literal class names so Tailwind's scanner emits them):

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

- [ ] **Step 5: Run tests, typecheck, lint.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/hooks/useNowTick.test.ts` (PASS)
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/hooks/useNowTick.ts apps/web/src/hooks/useNowTick.test.ts apps/web/src/components/pacing/paceTierClasses.ts`
    If `shadcn/no-raw-colors` flags `yellow-400` or `orange-500` (existing code uses `text-amber-600` unflagged, so it should not), add `// oxlint-disable-next-line shadcn/no-raw-colors -- spec 4.1 fixes the tier palette to Tailwind yellow-400 / orange-500` on the offending lines.

- [ ] **Step 6: Commit** `feat(web): shared useNowTick clock and pace tier classes`.

---

## Task 2: Client settings keys in contracts

**Files:**

- Modify: `packages/contracts/src/settings.ts` (`ClientSettingsSchema` after `contextWindowMeterEnabled` ~line 450; `ClientSettingsPatch` after `contextWindowMeterEnabled` ~line 1664)
- Test: `packages/contracts/src/settings.test.ts` (new `describe("ClientSettings usage pacing")` next to `describe("ClientSettings context window meter")`, ~line 652; uses the file's existing `decodeClientSettings` / `decodeClientSettingsPatch` helpers)

**Interfaces:**

- Produces (index 6.5, exact keys and defaults): `usagePacingShowSession`, `usagePacingShowWeekly`, `usagePacingShowModelScoped` (boolean, default `true`), `usagePacingWorkHours` (string, default `"09:00-17:00"`), `usagePacingWorkDays` (array of ints 0..6, default `[1,2,3,4,5]`), `usagePacingOffHoursWeight` (number 0..1, default `0.2`), on `ClientSettings` / `DEFAULT_CLIENT_SETTINGS` / `UnifiedSettings` and as `Schema.optionalKey` entries on `ClientSettingsPatch`.

`usagePacingWorkHours` is a plain string on purpose (client settings persist as one object; a strict pattern failing would discard the whole object). Validation belongs to P1's `parseWorkHours`.

- [ ] **Step 1: Write the failing tests.**

| Case                             | Input                                                                                                                                 | Expected                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| defaults                         | `decodeClientSettings({})`                                                                                                            | the three show flags `true`; `usagePacingWorkHours === "09:00-17:00"`; `usagePacingWorkDays` equals `[1,2,3,4,5]`; `usagePacingOffHoursWeight === 0.2` |
| older stored object loads        | `decodeClientSettings({ chatWidth: "comfortable" })`                                                                                  | no throw, defaults above                                                                                                                               |
| explicit values kept             | `{ usagePacingShowSession: false, usagePacingWorkHours: "20:00-02:00", usagePacingWorkDays: [0, 6], usagePacingOffHoursWeight: 0.5 }` | decoded unchanged                                                                                                                                      |
| patch accepts each key           | `decodeClientSettingsPatch({ <key>: <valid> })` for all six                                                                           | returns the value                                                                                                                                      |
| patch rejects bad day            | `{ usagePacingWorkDays: [7] }` and `{ usagePacingWorkDays: [1.5] }`                                                                   | throws                                                                                                                                                 |
| patch rejects bad weight         | `{ usagePacingOffHoursWeight: 1.01 }` and `-0.01`                                                                                     | throws                                                                                                                                                 |
| work hours is not validated here | `{ usagePacingWorkHours: "garbage" }`                                                                                                 | accepted (by design; P1 resolves it)                                                                                                                   |

- [ ] **Step 2: Run, expect FAIL.** `PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/contracts/src/settings.test.ts`

- [ ] **Step 3: Implement.** Schema block, as one commented group directly after the `contextWindowMeterEnabled` entry (`Effect` and `Schema` are already imported in the file; the weekday element schema is copied from `scheduledTask.ts`):

```ts
  // Usage pacing (header widget). Device-local. Work hours stay a plain string: client settings
  // persist as one object, so a strict pattern that ever failed would discard every setting.
  // Malformed values are repaired by shared/usagePacing's resolveWorkSchedule, not here.
  // The defaults duplicate shared/usagePacing's DEFAULT_* (contracts cannot import shared); a web
  // test asserts they stay equal.
  usagePacingShowSession: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  usagePacingShowWeekly: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  usagePacingShowModelScoped: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  usagePacingWorkHours: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("09:00-17:00"))),
  usagePacingWorkDays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).pipe(
    Schema.withDecodingDefault(Effect.succeed([1, 2, 3, 4, 5])),
  ),
  usagePacingOffHoursWeight: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.2)),
  ),
```

Patch entries after `contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),`:

```ts
  usagePacingShowSession: Schema.optionalKey(Schema.Boolean),
  usagePacingShowWeekly: Schema.optionalKey(Schema.Boolean),
  usagePacingShowModelScoped: Schema.optionalKey(Schema.Boolean),
  usagePacingWorkHours: Schema.optionalKey(Schema.String),
  usagePacingWorkDays: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
  ),
  usagePacingOffHoursWeight: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
```

If the `Schema.Array(...)` default's inferred type trips `exactOptionalPropertyTypes`/readonly in `DEFAULT_CLIENT_SETTINGS`, mirror how another array-with-default in the same file (`favorites`, `providerModelPreferences`) is written; do not widen the schema.

- [ ] **Step 4: Run tests and typecheck.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run packages/contracts/src/settings.test.ts` (PASS)
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/contracts#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts`

- [ ] **Step 5: Commit** `feat(contracts): usage pacing client settings`.

---

## Task 3: Settings logic helpers

**Files:**

- Create: `apps/web/src/components/settings/usagePacingSettings.logic.ts`, `apps/web/src/components/settings/usagePacingSettings.logic.test.ts`

**Interfaces:**

- Consumes: P1 `parseWorkHours(value): WorkHours | null`, `formatWorkHours(hours): string`, `DEFAULT_WORK_HOURS`, `DEFAULT_WORK_DAYS`, `DEFAULT_OFF_HOURS_WEIGHT`; `DEFAULT_CLIENT_SETTINGS` from `@t3tools/contracts/settings`.
- Produces:
  - `workHoursToTimeInputs(value: string): { start: string; end: string }`, `"HH:MM"` strings for two `<input type="time">`. A malformed `value` yields the default hours' inputs. An end of 24:00 (`endMin === 1440`) is shown as `"00:00"` because a time input cannot hold `24:00`.
  - `workHoursFromTimeInputs(start: string, end: string): string | null`: a stored `"HH:MM-HH:MM"` string, or `null` when either input is empty/malformed (the caller then ignores the change). An end of `"00:00"` is written as `24:00` (never `00:00`), so a stored string never depends on how P1 reads a zero end.
  - `snapOffHoursWeight(value: number): number | null`: `null` for non-finite; else clamp to 0..1 and snap to the nearest 0.05 with `Math.round(v * 20) / 20`.
  - `sameWorkDays(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean`: set equality, order and duplicates ignored (used by restore-defaults dirty check).

- [ ] **Step 1: Write the failing test.**

`workHoursToTimeInputs`:

| value             | start / end       |
| ----------------- | ----------------- |
| `"09:00-17:00"`   | `09:00` / `17:00` |
| `"9-17"`          | `09:00` / `17:00` |
| `"20:00-02:00"`   | `20:00` / `02:00` |
| `"00:00-24:00"`   | `00:00` / `00:00` |
| `"garbage"`, `""` | `09:00` / `17:00` |

`workHoursFromTimeInputs`:

| start, end        | result          |
| ----------------- | --------------- |
| `09:00`, `17:00`  | `"09:00-17:00"` |
| `20:00`, `02:00`  | `"20:00-02:00"` |
| `09:00`, `00:00`  | `"09:00-24:00"` |
| `00:00`, `00:00`  | `"00:00-24:00"` |
| `""`, `17:00`     | `null`          |
| `09:00`, `""`     | `null`          |
| `"9:0x"`, `17:00` | `null`          |

Round trip: for every non-null result above, `parseWorkHours(result)` is non-null and `workHoursToTimeInputs(result)` returns the same `{start, end}` the inputs mapped to (with `00:00` end).

`snapOffHoursWeight`: `0.2 -> 0.2`, `0.12 -> 0.1`, `0.31 -> 0.3`, `0.15 -> 0.15`, `1.5 -> 1`, `-1 -> 0`, `NaN -> null`, `Infinity -> null`.

`sameWorkDays`: `[1,2,3,4,5]` vs `[5,4,3,2,1,1]` true; vs `[1,2,3,4]` false; `[]` vs `[]` true; `[0,6]` vs `[6,0]` true.

Defaults equal P1: `DEFAULT_CLIENT_SETTINGS.usagePacingWorkHours === DEFAULT_WORK_HOURS`; `DEFAULT_CLIENT_SETTINGS.usagePacingWorkDays` `toEqual` `DEFAULT_WORK_DAYS`; `DEFAULT_CLIENT_SETTINGS.usagePacingOffHoursWeight === DEFAULT_OFF_HOURS_WEIGHT`. (This is the equality test index 6.5 requires.)

- [ ] **Step 2: Run, expect FAIL.** `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/usagePacingSettings.logic.test.ts`
- [ ] **Step 3: Implement** the four functions per the contract above. Minute to `"HH:MM"` with zero padding (`Math.floor(m / 60)`, `m % 60`); `"HH:MM"` input parse with `/^([01]\d|2[0-3]):([0-5]\d)$/`; build the stored string through P1's `formatWorkHours({ startMin, endMin })` with `endMin = end === "00:00" ? 1440 : minutes`.
- [ ] **Step 4: Run tests, typecheck (`vp run @t3tools/web#typecheck`), lint the two files.** PASS.
- [ ] **Step 5: Commit** `feat(web): usage pacing settings helpers`.

---

## Task 4: Extract the weekday picker

**Files:**

- Create: `apps/web/src/components/settings/WeekdayToggleGroup.tsx`
- Modify: `apps/web/src/components/settings/ScheduledTasksSettings.tsx` (constants ~line 106-108; the picker ~lines 1300-1319; `WEEKDAY_LABELS` is also read by the schedule summary ~line 189)

**Interfaces:**

- Produces: `export const WEEKDAY_LABELS: readonly ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]` (indexed by weekday int, 0 = Sunday) and

```tsx
export function WeekdayToggleGroup(props: {
  readonly value: ReadonlyArray<number>;
  readonly onChange: (days: number[]) => void;
  readonly "aria-label": string;
}): ReactElement;
```

Behaviour is moved, not changed: the same `ToggleGroup multiple variant="outline" size="sm"`, buttons rendered Monday-first (`WEEKDAY_ORDER = [1,2,3,4,5,6,0]`), label `WEEKDAY_SHORT` (`Su Mo Tu We Th Fr Sa`) with `aria-label` from `WEEKDAY_LABELS`, `value` is `value.map(String)`, and an empty selection is ignored (`if (values.length === 0) return;`), so the last selected day cannot be removed. `onChange` receives `values.map(Number)`.

- [ ] **Step 1: Create `WeekdayToggleGroup.tsx`** with `WEEKDAY_ORDER`, `WEEKDAY_LABELS`, `WEEKDAY_SHORT` moved from `ScheduledTasksSettings.tsx` and the component above (imports `ToggleGroup, Toggle` from `../ui/toggle-group`). Export only `WEEKDAY_LABELS` and `WeekdayToggleGroup` (knip flags unused exports).
- [ ] **Step 2: Edit `ScheduledTasksSettings.tsx`:** delete the three constants, import `{ WEEKDAY_LABELS, WeekdayToggleGroup }`, and replace the inline `<ToggleGroup ... aria-label="Days to run">...</ToggleGroup>` with

```tsx
<WeekdayToggleGroup
  aria-label="Days to run"
  value={[...draft.weekdays]}
  onChange={(days) => setDraft((current) => ({ ...current, weekdays: new Set(days) }))}
/>
```

Keep the file's existing `ToggleGroup`/`Toggle` imports because the "Schedule type" group (~line 1150) still uses them.

- [ ] **Step 3: Verify (no new test: a pure move; the existing `scheduledTasksSettings.logic.test.ts` stays green).**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/settings/WeekdayToggleGroup.tsx apps/web/src/components/settings/ScheduledTasksSettings.tsx`
- [ ] **Step 4: Commit** `refactor(web): share the weekday picker between scheduled tasks and settings`.

---

## Task 5: Usage pacing settings section (closes milestone P4-foundation)

**Files:**

- Create: `apps/web/src/components/settings/UsagePacingSettings.tsx`, `apps/web/src/routes/settings.usage-pacing.tsx`
- Modify: `apps/web/src/components/settings/settingsSearch.ts`, `settingsSearch.test.ts`, `SettingsSidebarNav.tsx`, `SettingsScopeSentence.tsx`, `SettingsPanels.tsx`, `SettingsPanels.restore.test.tsx`, `apps/web/src/routeTree.gen.ts`

**Interfaces:**

- Consumes: Task 2 keys, Task 3 helpers, Task 4 `WeekdayToggleGroup`, `useClientSettings`, `useUpdateClientSettings`.
- Produces (index 6.5 / 6.7): path `"/settings/usage-pacing"`, section label `"Usage pacing"`, component `UsagePacingSettingsPanel`, search ids `usage-pacing-show-session`, `usage-pacing-show-weekly`, `usage-pacing-show-model-scoped`, `usage-pacing-work-hours`, `usage-pacing-work-days`, `usage-pacing-off-hours-weight`, restore-defaults coverage of the six keys. P5 later appends one `SettingsRow` ("Show context ring in composer") as the last child of this `SettingsSection` (index 6.5), so keep the panel's JSX as `SettingsPageContainer > SettingsSection > six SettingsRow` with the six rows as the section's direct children and nothing after the section.

### 5a: Search, scope and nav registration (test first)

- [ ] **Step 1: Extend `settingsSearch.test.ts`.**

| Case               | Expectation                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| six ids exist      | for each id, `SETTINGS_SEARCH_ITEMS.find` returns an item with `to === "/settings/usage-pacing"` and a non-empty `title`; `searchableSetting(id).title` equals it |
| scope              | `getSettingsSearchTargetScope("usage-pacing-work-hours")!.scope` is `null` (device-local)                                                                         |
| query "work hours" | `searchSettings("work hours", SETTINGS_SEARCH_ITEMS)[0].id === "usage-pacing-work-hours"`                                                                         |
| query "weekend"    | results include `usage-pacing-work-days`                                                                                                                          |
| query "5h"         | results include `usage-pacing-show-session`                                                                                                                       |

- [ ] **Step 2: Run, expect FAIL.** `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/settingsSearch.test.ts`
- [ ] **Step 3: Edit `settingsSearch.ts`:**
  - `SettingsPath` union: add `| "/settings/usage-pacing"` after `"/settings/scheduled-tasks"`.
  - `SETTINGS_SECTION_LABELS`: add `"/settings/usage-pacing": "Usage pacing",` right after the `scheduled-tasks` entry (this record's order is the sidebar order).
  - `SETTINGS_CATEGORY_SCOPES` (~line 1017): add `"/settings/usage-pacing": null,`.
  - `SETTINGS_SEARCH_ITEMS`: add six items after the `snap-shot-animations` item, each `to: "/settings/usage-pacing"`, no `targetId` (their rows always mount):

| id                               | title                            | searchTerms                                               |
| -------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `usage-pacing-show-session`      | Show session window              | `["5h five hour limit header pace burn usage"]`           |
| `usage-pacing-show-weekly`       | Show weekly window               | `["7d week limit header pace burn usage"]`                |
| `usage-pacing-show-model-scoped` | Show model-scoped weekly windows | `["Fable Opus Sonnet per model weekly limit header"]`     |
| `usage-pacing-work-hours`        | Work hours                       | `["schedule pace weekly start end shift night hours"]`    |
| `usage-pacing-work-days`         | Work days                        | `["weekdays schedule weekend monday friday pace weekly"]` |
| `usage-pacing-off-hours-weight`  | Off-hours weight                 | `["outside work hours counts less pace weekly"]`          |

- [ ] **Step 4: Edit `SettingsSidebarNav.tsx`:** import `GaugeIcon` from `lucide-react` (exists in the installed version) and add `"/settings/usage-pacing": GaugeIcon,` to `SETTINGS_SECTION_ICONS`. The nav list is derived from `SETTINGS_SECTION_LABELS`, nothing else to add.
- [ ] **Step 5: Edit `SettingsScopeSentence.tsx`:** add `"/settings/usage-pacing"` to `SETTINGS_DEVICE_ONLY_PATHS` (no scope notice, same as appearance and snap-shot).
- [ ] **Step 6: Run the search test, expect PASS.**

### 5b: Restore defaults (test first)

- [ ] **Step 7: Extend `SettingsPanels.restore.test.tsx`** with a second `it.each` after the existing one (the existing one sets the key to `true`, which does not fit arrays and numbers):

| key                          | non-default value | dirty label                        | default checked in `update` call |
| ---------------------------- | ----------------- | ---------------------------------- | -------------------------------- |
| `usagePacingShowSession`     | `false`           | `Show session window`              | `true`                           |
| `usagePacingShowWeekly`      | `false`           | `Show weekly window`               | `true`                           |
| `usagePacingShowModelScoped` | `false`           | `Show model-scoped weekly windows` | `true`                           |
| `usagePacingWorkHours`       | `"20:00-02:00"`   | `Work hours`                       | `"09:00-17:00"`                  |
| `usagePacingWorkDays`        | `[0, 6]`          | `Work days`                        | `[1,2,3,4,5]` (`toEqual`)        |
| `usagePacingOffHoursWeight`  | `0.5`             | `Off-hours weight`                 | `0.2`                            |

Each: `state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value }`, `changedSettingLabels` equals `[label]`, `restoreDefaults()` calls `update` once with the default. Add one case that `usagePacingWorkDays: [5, 4, 3, 2, 1]` (same set, different order) is **not** dirty (`changedSettingLabels` equals `[]`).

- [ ] **Step 8: Run, expect FAIL.** `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/settings/SettingsPanels.restore.test.tsx`
- [ ] **Step 9: Edit `SettingsPanels.tsx` `useSettingsRestore`** in its three places (find by symbol; each currently lists `contextWindowMeterEnabled`): (1) in the `changedSettingLabels` array, after the `Context window indicator` entry, add the six labels, each guarded by a comparison with `DEFAULT_UNIFIED_SETTINGS` (`!sameWorkDays(settings.usagePacingWorkDays, DEFAULT_UNIFIED_SETTINGS.usagePacingWorkDays)` for work days); (2) add the six `settings.usagePacing*` fields to that `useMemo` dependency list; (3) in the `updateSettings({...})` reset object add the six keys set to their `DEFAULT_UNIFIED_SETTINGS` values. Import `sameWorkDays` from `./usagePacingSettings.logic`. Do not touch the `contextWindowMeterEnabled` lines (P5 owns them).
- [ ] **Step 10: Run the restore test, expect PASS.**

### 5c: The panel and the route

- [ ] **Step 11: Create `UsagePacingSettings.tsx`** exporting `UsagePacingSettingsPanel`. Structure (patterned on `SnapShotSettings.tsx`): `const settings = useClientSettings(); const updateSettings = useUpdateClientSettings();` rendering

```
<SettingsPageContainer>
  <SettingsSection id="usage-pacing" title="Usage pacing">
    six <SettingsRow {...searchableSetting("<id>")} description=... control=... /> in this order
  </SettingsSection>
</SettingsPageContainer>
```

| Row (search id)                  | Description                                                                               | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-pacing-show-session`      | Show the 5-hour window in the chat header.                                                | `Switch` `checked={settings.usagePacingShowSession}`, `aria-label="Show session window"`, `onCheckedChange={(c) => void updateSettings({ usagePacingShowSession: Boolean(c) })}`                                                                                                                                                                                                                                                                                                    |
| `usage-pacing-show-weekly`       | Show the weekly all-models window in the chat header.                                     | `Switch`, `aria-label="Show weekly window"`, key `usagePacingShowWeekly`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `usage-pacing-show-model-scoped` | Show per-model weekly windows, such as Fable.                                             | `Switch`, `aria-label="Show model-scoped weekly windows"`, key `usagePacingShowModelScoped`                                                                                                                                                                                                                                                                                                                                                                                         |
| `usage-pacing-work-hours`        | Weekly pace counts these hours in full. An end at or before the start runs past midnight. | two `<Input type="time" nativeInput className="w-32">` with `aria-label="Work hours start"` / `"Work hours end"`, values from `workHoursToTimeInputs(settings.usagePacingWorkHours)`, a muted "to" between them; `onChange` computes `workHoursFromTimeInputs(nextStart, currentEnd)` (or `(currentStart, nextEnd)`) and, when non-null and different from the stored string, calls `updateSettings({ usagePacingWorkHours })`; a null result is ignored                            |
| `usage-pacing-work-days`         | Days that count toward weekly pace. Other days do not move the pace.                      | `WeekdayToggleGroup aria-label="Work days"` `value={settings.usagePacingWorkDays}` `onChange={(days) => void updateSettings({ usagePacingWorkDays: days })}` (the last day cannot be deselected, inherited)                                                                                                                                                                                                                                                                         |
| `usage-pacing-off-hours-weight`  | How much an hour outside work hours counts on a work day, from 0 to 1.                    | `NumberField size="sm" className="w-24" min={0} max={1} step={0.05} smallStep={0.05} value={settings.usagePacingOffHoursWeight} format={{ minimumFractionDigits: 0, maximumFractionDigits: 2 }} onValueCommitted={(v) => { const w = v === null ? null : snapOffHoursWeight(v); if (w !== null) void updateSettings({ usagePacingOffHoursWeight: w }); }}` with `NumberFieldGroup`/`NumberFieldInput aria-label="Off-hours weight"` (pattern: `IntegrationsSettings.tsx` ~line 344) |

Imports: `Switch` from `../ui/switch`, `Input` from `../ui/input` (as `ScheduledTasksSettings` does for `type="time"`), `NumberField*` from `../ui/number-field`, layout from `./settingsLayout`, `searchableSetting` from `./settingsSearch`.

- [ ] **Step 12: Create `settings.usage-pacing.tsx`:**

```tsx
import { createFileRoute } from "@tanstack/react-router";

import { UsagePacingSettingsPanel } from "../components/settings/UsagePacingSettings";

function SettingsUsagePacingRoute() {
  return <UsagePacingSettingsPanel />;
}

export const Route = createFileRoute("/settings/usage-pacing")({
  component: SettingsUsagePacingRoute,
});
```

- [ ] **Step 13: Regenerate `routeTree.gen.ts` (committed file, edited by the TanStack router plugin when Vite runs; subagents do not run Vite).** First try the generator directly, from `apps/web`:

```
builtin cd apps/web; node --input-type=module -e '
import { Generator, getConfig } from "../../node_modules/.pnpm/@tanstack+router-generator@1.167.12/node_modules/@tanstack/router-generator/dist/esm/index.js";
const root = process.cwd();
await new Generator({ config: getConfig({}, root), root }).run();
'
```

Then `git diff --stat apps/web/src/routeTree.gen.ts`: it must show only additions mentioning `SettingsUsagePacing` / `/settings/usage-pacing`. If it rewrote anything else, or the script fails, run `git checkout apps/web/src/routeTree.gen.ts` and hand-edit instead: at each of the 11 places `scheduled-tasks` appears (import ~line 23; `.update({...})` block ~93; the three `FileRoutesByFullPath`/`FileRoutesByTo`/`FileRoutesById` maps ~191, 217, 246; the three union lists ~276, 302, 330; the `declare module` block ~429; `SettingsRouteChildren` interface ~564 and object ~581) add the parallel `SettingsUsagePacingRoute` / `'/settings/usage-pacing'` entry (id/path/fullPath `'/usage-pacing'`, `getParentRoute: () => SettingsRoute`), placed in the same relative order the file already uses (entries are alphabetical by route name). P6's dev server run will regenerate this file; any diff it then shows is a follow-up fix on this branch.

- [ ] **Step 14: Verify the whole milestone.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/hooks/useNowTick.test.ts apps/web/src/components/settings/usagePacingSettings.logic.test.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/SettingsPanels.restore.test.tsx apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts packages/contracts/src/settings.test.ts`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/contracts#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint` on every file created or modified in Tasks 1-5.
- [ ] **Step 15: Commit** `feat(web): usage pacing settings section`. **Milestone P4-foundation reached:** report `git rev-parse HEAD` to the orchestrator now (index 6.7 contents: `useNowTick`, `paceTierClasses.ts`, the six settings, `UsagePacingSettings.tsx`, route, nav, search, restore-defaults, `WeekdayToggleGroup.tsx`). Continue with Task 6.

---

## Task 6: Pacing logic (pure)

**Files:**

- Create: `apps/web/src/components/pacing/pacingRows.logic.ts`, `apps/web/src/components/pacing/pacingRows.logic.test.ts`

**Interfaces:**

- Consumes: P1 names listed above; `ServerProviderUsageLimits`, `TimestampFormat` from `@t3tools/contracts`; Task 1 `PACE_TIER_CLASSES` is not needed here (logic stays class-free; it returns `PaceTierColor`).
- Produces (exports are exactly these; each is consumed by Tasks 7 or 8, knip flags the rest):

```ts
export interface PacingSettings {
  readonly showSession: boolean;
  readonly showWeekly: boolean;
  readonly showModelScoped: boolean;
  readonly workHours: string;
  readonly workDays: ReadonlyArray<number>;
  readonly offHoursWeight: number;
}
export interface PacingRowModel {
  readonly id: string; // window id, e.g. "five_hour"
  readonly role: PaceWindowRole;
  readonly shortLabel: string; // "5h" | "7d" | "Fable"
  readonly title: string; // "Session · 5h" | "Weekly · all models" | "Weekly · Fable"
  readonly usedPercent: number; // 0..100, bar fill
  readonly percentText: string; // "62%"
  readonly burnText: string; // "1.2x", "" when burn is null
  readonly burnColor: PaceTierColor; // tier colour; "muted" when burn is null
  readonly paceFraction: number | null; // tick, 0..1
  readonly resetLabel: string | null; // formatResetLabel(...), null without resetsAt
  readonly countdown: string | null; // formatCountdown(resetsAtMs - nowMs), null without resetsAt
  readonly hidden: boolean; // toggled off in the header (always false for role "other")
}
export interface PacingModel {
  readonly headerRows: ReadonlyArray<PacingRowModel>; // at most MAX_PACING_HEADER_ROWS
  readonly popoverSections: ReadonlyArray<PacingRowModel>; // every window, ordered
}
export const MAX_PACING_HEADER_ROWS = 3;
export function buildPacingModel(input: {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly settings: PacingSettings;
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}): PacingModel;

export type PacingLayout = "full" | "compact" | "hidden";
export const PACING_HIDE_BELOW_PX = 420;
export const PACING_COMPACT_BELOW_PX = 560;
export function pacingLayoutForHeaderWidth(headerWidthPx: number | null): PacingLayout;

export const PACING_RESERVE_CSS_VAR = "--pacing-widget-reserve";
export function pacingReservePx(widgetWidthPx: number): number; // Math.ceil(w) + 16

export type PacingPlacement = "cluster" | "panel-header" | "none";
export function resolvePacingPlacement(input: {
  readonly inlineRightPanelOwnsTitleBar: boolean;
  readonly rightPanelControlsAtRoot: boolean;
  readonly rightPanelControlsInPanel: boolean;
}): PacingPlacement;

export interface PacingPopoverState {
  readonly open: boolean;
  readonly pinned: boolean;
}
export const PACING_POPOVER_CLOSED: PacingPopoverState; // { open: false, pinned: false }
export function reducePacingPopover(
  state: PacingPopoverState,
  event: { readonly nextOpen: boolean; readonly reason: string },
): PacingPopoverState;

export const PACING_ROW_GAP_CLASS: { readonly spacious: "gap-1.25"; readonly tight: "gap-px" };
export function pacingRowGapClass(rowCount: number): string; // rowCount >= 3 ? "gap-px" : "gap-1.25"
export function pacingAriaLabel(rows: ReadonlyArray<PacingRowModel>): string;
```

Behaviour of `buildPacingModel`, in order (no design decisions left open):

1. `usageLimits === undefined`, or `usageLimits.unavailable !== undefined`, or `windows.length === 0` -> `{ headerRows: [], popoverSections: [] }`.
2. `schedule = resolveWorkSchedule({ workHours, workDays, offHoursWeight })` (P1 repairs malformed input; never throws).
3. `ordered = orderPaceWindows(usageLimits.windows)`.
4. For each window: `role = paceWindowRole(window)`; `pace = computeWindowPace(window, { nowMs, schedule })`; `resetsAtMs = pace.resetsAtMs`.
   - `shortLabel = paceWindowShortLabel(window)`, `title = paceWindowTitle(window)`.
   - `usedPercent = pace.usedPercent`; `percentText = Math.round(pace.usedPercent) + "%"`.
   - `burnText = pace.burn === null ? "" : formatBurn(pace.burn)`; `burnColor = pace.burnTier === null ? "muted" : BURN_TIER_COLORS[pace.burnTier]` (index D6).
   - `paceFraction = pace.paceFraction`.
   - `resetLabel = resetsAtMs === null ? null : formatResetLabel(resetsAtMs, window.windowDurationMins, timestampFormat)`; `countdown = resetsAtMs === null ? null : formatCountdown(resetsAtMs - nowMs)`.
   - `toggleOn`: role `session` -> `showSession`; `weekly` -> `showWeekly`; `modelScoped` -> `showModelScoped`; `other` -> not applicable.
   - `hidden = role !== "other" && !toggleOn`.
5. `popoverSections` = every row, in order. `headerRows` = rows with `role !== "other" && !hidden`, first `MAX_PACING_HEADER_ROWS` only.

`resolvePacingPlacement`: `inlineRightPanelOwnsTitleBar` -> `"panel-header"`; else `rightPanelControlsAtRoot || rightPanelControlsInPanel` -> `"none"`; else `"cluster"`.

`pacingLayoutForHeaderWidth`: `null` or `< 420` -> `"hidden"`; `< 560` -> `"compact"`; else `"full"`.

`reducePacingPopover` (code, because Base UI's own click handling is wrong for "click pins": a click on a hover-opened popover more than 500ms after it opened toggles it closed, and a hover-leave closes a popover the user meant to keep; `reason` strings are Base UI's `REASONS`: `trigger-press`, `trigger-hover`, `outside-press`, `escape-key`, `focus-out`):

```ts
export const PACING_POPOVER_CLOSED: PacingPopoverState = { open: false, pinned: false };

export function reducePacingPopover(
  state: PacingPopoverState,
  event: { readonly nextOpen: boolean; readonly reason: string },
): PacingPopoverState {
  if (event.reason === "trigger-press") {
    // Click: pins an open or closed popover; a second click on a pinned one unpins and closes.
    return state.pinned ? PACING_POPOVER_CLOSED : { open: true, pinned: true };
  }
  if (!event.nextOpen) {
    // Hover leaving must not close a pinned popover; every other close reason does.
    return state.pinned && event.reason === "trigger-hover" ? state : PACING_POPOVER_CLOSED;
  }
  return { open: true, pinned: state.pinned };
}
```

`pacingAriaLabel(rows)`: `rows.length === 0 -> "Usage pacing"`; else `"Usage pacing: " + rows.map(r => r.shortLabel + " " + r.percentText + (r.burnText ? ", burn " + r.burnText : "")).join("; ")`.

- [ ] **Step 1: Write the failing test** `pacingRows.logic.test.ts` (inline builders; per index section 8 no shared builder). Fixture: `NOW = Date.UTC(2026, 9, 12, 17, 0, 0)`; settings `{ showSession: true, showWeekly: true, showModelScoped: true, workHours: "00:00-24:00", workDays: [0,1,2,3,4,5,6], offHoursWeight: 0.2 }` so the weekly fraction equals the wall-clock fraction in any time zone; `timestampFormat: "24-hour"`. Window builder `makeWindow({ id, kind, label, usedPercent, windowDurationMins, resetsAt })` with `resetsAt = new Date(NOW + offsetMs).toISOString()`.

  Base windows (`HOUR = 3_600_000`):
  - `five_hour`: kind `session`, label `Session`, 300 mins, used 62, resetsAt `NOW + 1h52m`.
  - `seven_day`: kind `weekly`, label `Weekly`, 10080 mins, used 45, resetsAt `NOW + 3d21h`.
  - `seven_day_fable`: kind `weekly`, label `Weekly · Fable`, 10080 mins, used 78, resetsAt `NOW + 4d21h`.

  `buildPacingModel` cases (burn numbers follow the statusline algorithms: session has no history so the linear fallback applies, elapsed 3h08m of 5h):

| #   | Input                                                                                                                         | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the three base windows, all toggles on                                                                                        | `headerRows` ids `[five_hour, seven_day, seven_day_fable]`; `popoverSections` same ids, all `hidden: false`; `shortLabel` `5h`, `7d`, `Fable`; `title` `Session · 5h`, `Weekly · all models`, `Weekly · Fable`; `percentText` `62%`, `45%`, `78%`; `burnText` `1.0x`, `1.0x`, `2.6x`; `burnColor` `success`, `success`, `destructive`; `countdown` `in 1h 52m`, `in 3d 21h`, `in 4d 21h`; `paceFraction` close to 0.627, 0.446, 0.304 (3 digits; Fable: elapsed 51h of 168h, 0.78 / 0.3036 = 2.57, rounds to 2.6); `resetLabel` non-null |
| 2   | case 1 with `showModelScoped: false`                                                                                          | `headerRows` has two ids; the Fable section has `hidden: true`, the other two `false`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | all three toggles off                                                                                                         | `headerRows` empty; `popoverSections` has three, all `hidden: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | `usageLimits: undefined`                                                                                                      | both lists empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | `usageLimits` with windows plus `unavailable: { reason: "probeFailed" }`                                                      | both lists empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | `usageLimits` with `windows: []`                                                                                              | both lists empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7   | add a `monthly` window `{ id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 10, resetsAt: NOW + 10d }` to case 1 | not in `headerRows`; present in `popoverSections` with `hidden: false`, after the Fable section (role order)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | `five_hour` with `resetsAt` omitted                                                                                           | its row: `burnText ""`, `burnColor "muted"`, `paceFraction null`, `resetLabel null`, `countdown null`, `usedPercent 62`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | `five_hour` with `resetsAt = NOW + 4h50m` (elapsed 10 min, below the 30-minute linear-fallback minimum)                       | `burnText ""`, `burnColor "muted"`, `paceFraction` close to 0.033, `resetLabel` non-null                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | `five_hour` with `resetsAt = NOW - 60_000` (already passed)                                                                   | `burnText ""`, `paceFraction null`, `countdown "now"`, no throw                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | add `seven_day_sonnet` (`Weekly · Sonnet`, used 20, resetsAt `NOW + 4d`) to case 1                                            | `headerRows.length === 3` (session, weekly, first scoped by id order); `popoverSections.length === 4`, the fourth `hidden: false`                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | case 1 windows in reversed input order                                                                                        | same ids in the same order as case 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13  | malformed schedule: `workHours: "garbage"`, `workDays: []`, `offHoursWeight: 7`                                               | no throw; `headerRows` still has three rows (weekly burn may be blank)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Other pure functions:

| Function                                         | Cases                                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pacingLayoutForHeaderWidth`                     | `null -> hidden`, `0 -> hidden`, `419.9 -> hidden`, `420 -> compact`, `559.9 -> compact`, `560 -> full`, `1400 -> full`                                                                                |
| `pacingReservePx`                                | `238 -> 254`, `167.2 -> 184`, `0 -> 16`                                                                                                                                                                |
| `resolvePacingPlacement` (owns, atRoot, inPanel) | `(false,false,false) -> cluster`; `(true,true,false) -> panel-header`; `(false,true,false) -> none` (closing animation); `(false,false,true) -> none` (sheet open); `(true,true,true) -> panel-header` |
| `pacingRowGapClass`                              | `0,1,2 -> "gap-1.25"`; `3,4 -> "gap-px"`                                                                                                                                                               |
| `reducePacingPopover`                            | table below                                                                                                                                                                                            |
| `pacingAriaLabel`                                | no rows -> `Usage pacing`; the case-1 header rows -> `Usage pacing: 5h 62%, burn 1.0x; 7d 45%, burn 1.0x; Fable 78%, burn 2.6x`; a row with `burnText ""` omits its `, burn` part                      |

`reducePacingPopover` (state -> event -> result; `closed = {open:false,pinned:false}`, `hoverOpen = {open:true,pinned:false}`, `pinned = {open:true,pinned:true}`):

| State     | `nextOpen` / `reason`                                                                                                                                                                                              | Result             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| closed    | true / `trigger-hover`                                                                                                                                                                                             | hoverOpen          |
| hoverOpen | false / `trigger-hover`                                                                                                                                                                                            | closed             |
| hoverOpen | false / `trigger-press` (Base UI's "patient click" toggle, > 500ms after hover-open)                                                                                                                               | pinned             |
| hoverOpen | true / `trigger-press` (click within 500ms of hover-open: Base UI's `stickIfOpen` path still calls `onOpenChange(true, trigger-press)`, verified in `PopoverStore.setOpen` / `useClick` of `@base-ui/react` 1.5.0) | pinned             |
| closed    | true / `trigger-press`                                                                                                                                                                                             | pinned             |
| pinned    | false / `trigger-hover`                                                                                                                                                                                            | pinned (unchanged) |
| pinned    | true / `trigger-hover`                                                                                                                                                                                             | pinned (unchanged) |
| pinned    | false / `trigger-press`                                                                                                                                                                                            | closed             |
| pinned    | false / `outside-press`                                                                                                                                                                                            | closed             |
| pinned    | false / `escape-key`                                                                                                                                                                                               | closed             |
| pinned    | false / `focus-out`                                                                                                                                                                                                | closed             |
| hoverOpen | false / `escape-key`                                                                                                                                                                                               | closed             |

- [ ] **Step 2: Run, expect FAIL.** `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/pacing/pacingRows.logic.test.ts`
- [ ] **Step 3: Implement** `pacingRows.logic.ts` per the behaviour above (the reducer verbatim). Constants: `PACING_ROW_GAP_CLASS` holds the two literal class strings so Tailwind's scanner sees them. Do not export anything not listed.
- [ ] **Step 4: Run tests, typecheck, lint.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/components/pacing/pacingRows.logic.test.ts` (PASS)
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/pacing/pacingRows.logic.ts apps/web/src/components/pacing/pacingRows.logic.test.ts`
    Numeric expectations in cases 1, 9 assume P1 ported the statusline maths faithfully; a mismatch means P1 or this table is wrong, so check both against `/home/jorgen/Code/statusline/src/models/burn-rate.ts` and `weekly-burn.ts` before changing either.
- [ ] **Step 5: Commit** `feat(web): pacing row model and popover state logic`.

---

## Task 7: `PacingBar`, `PacingPopover`, `PacingWidget`

**Files:**

- Create: `apps/web/src/components/pacing/PacingBar.tsx`, `PacingPopover.tsx`, `PacingWidget.tsx`
- Tests: none for markup (AGENTS.md); behaviour is covered by Task 6 and P6. Verify by typecheck and lint.

**Interfaces:**

- Consumes: Task 1 `useNowTick`, `PACE_TIER_CLASSES`; Task 6 everything; `useClientSettings`; `observeResize`; `Popover`, `PopoverTrigger`, `PopoverPopup`; `useNavigate` from `@tanstack/react-router`; P1 `PaceTierColor`.
- Produces: `PacingWidget(props: { usageLimits: ServerProviderUsageLimits | undefined; headerRef: React.RefObject<HTMLElement | null> })` for Task 8, and the DOM hooks of index 6.6.

DOM hooks (exact): `data-pacing-widget` on the widget root (absent when it renders nothing); `data-pacing-row="<window id>"` on each header row; `data-pacing-burn` on the burn cell (kept, empty text, when burn is null); `data-pacing-reset` on the reset cell (absent in compact layout or without `resetsAt`); `data-pacing-tick` on the tick (absent when `paceFraction` is null); `data-pacing-popover` on the popup root; `data-pacing-section="<window id>"` + `data-hidden="true|false"` on each popover section.

### `PacingBar.tsx`

```tsx
import type { PaceTierColor } from "@t3tools/shared/usagePacing";

import { cn } from "~/lib/utils";
import { PACE_TIER_CLASSES } from "./paceTierClasses";

// Full literal class strings, so Tailwind's scanner emits them and shadcn/no-unknown-classes passes.
const BAR_SIZE = {
  header: { track: "h-[3px] w-[76px] shrink-0", tick: "h-[6px]" },
  popover: { track: "h-1 w-full", tick: "h-2" },
} as const;

export function PacingBar(props: {
  readonly usedPercent: number;
  readonly paceFraction: number | null;
  readonly color: PaceTierColor;
  readonly size: keyof typeof BAR_SIZE;
}) {
  const size = BAR_SIZE[props.size];
  return (
    <div className={cn("relative rounded-full bg-muted-foreground/25", size.track)} aria-hidden>
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full", PACE_TIER_CLASSES[props.color].bg)}
        style={{ width: `${props.usedPercent}%` }}
      />
      {props.paceFraction === null ? null : (
        <div
          data-pacing-tick
          className={cn(
            "absolute top-1/2 w-[1.5px] -translate-x-1/2 -translate-y-1/2 bg-foreground",
            size.tick,
          )}
          style={{ left: `${Math.min(1, Math.max(0, props.paceFraction)) * 100}%` }}
        />
      )}
    </div>
  );
}
```

(Runtime-computed `style` values are allowed by `docs/internals/web-ui.md`.) Lint note (verified against `@shadcn/lint` 0.1.5 and `vite.config.ts`): `shadcn/no-arbitrary-values` allows arbitrary values only in the `layout` category (width, height, margin, position), so `h-[3px]`, `w-[76px]`, `w-[1.5px]`, `h-[6px]` pass, while spacing (`gap-*`, `p*-*`), typography (`leading-*`) and shape (`rounded-*`) arbitrary values fail. That is why the tick has no `rounded-[1px]` and the row uses `gap-1.25` / `leading-3.25`. If `w-[1.5px]` is still rejected, use `w-[2px]` and note it in the handoff; do not drop the tick.

### `PacingPopover.tsx`

Props: `{ sections: ReadonlyArray<PacingRowModel>; triggerLabel: string; children: ReactNode }` where `children` is the trigger's visible content (the row stack). Behaviour:

- Local state `const [state, setState] = useState(PACING_POPOVER_CLOSED)`.
- Controlled root; every Base UI open/close request goes through the reducer:

```tsx
<Popover
  open={state.open}
  onOpenChange={(nextOpen, details) =>
    setState((current) => reducePacingPopover(current, { nextOpen, reason: details.reason }))
  }
>
  <PopoverTrigger
    openOnHover
    delay={150}
    closeDelay={150}
    render={
      <button
        type="button"
        aria-label={triggerLabel}
        className="cursor-default rounded-md px-2 py-1 hover:bg-accent/50 data-[popup-open]:bg-accent/50"
      />
    }
  >
    {children}
  </PopoverTrigger>
  <PopoverPopup data-pacing-popover padding="none" side="bottom" align="end" sideOffset={6}>
    <div className="w-70"> ...sections, footer... </div>
  </PopoverPopup>
</Popover>
```

- Sections and footer exactly per the visual-spec table. Title row: `{section.title}`, then `hidden` tag when `section.hidden`. Right of line 1: `section.percentText` then `section.burnText` coloured with `PACE_TIER_CLASSES[section.burnColor].text` (render the burn span only when `burnText` is non-empty). Line 2: `<PacingBar size="popover" ... />` using the section's `usedPercent`, `paceFraction`, `burnColor`. Line 3 only when `section.resetLabel !== null` (reset label left, `section.countdown` right).
- Footer buttons: `const navigate = useNavigate();` handlers `setState(PACING_POPOVER_CLOSED); void navigate({ to: "/usage" })` and `... navigate({ to: "/settings/usage-pacing" })`.
- Base UI closes on Escape and outside press itself (reasons `escape-key`, `outside-press`), the reducer unpins on them. Do not add manual document listeners.

### `PacingWidget.tsx`

Behaviour, in order:

1. `const nowMs = useNowTick(30_000);`
2. Settings via `useClientSettings` with one selector per primitive (stable): `usagePacingShowSession`, `usagePacingShowWeekly`, `usagePacingShowModelScoped`, `usagePacingWorkHours`, `usagePacingWorkDays`, `usagePacingOffHoursWeight`, `timestampFormat`.
3. `model = useMemo(() => buildPacingModel({ usageLimits, settings, nowMs, timestampFormat }), [...])`.
4. Header width: `const [headerWidth, setHeaderWidth] = useState<number | null>(null)`; effect keyed on `headerRef` that, when `headerRef.current` exists, returns `observeResize(header, (entries) => { const entry = entries.at(-1); if (entry) setHeaderWidth(entry.borderBoxSize?.[0]?.inlineSize ?? header.offsetWidth); })`. This is the border-box inline size of `<header data-chat-header>`. (`t3code/no-raw-resize-observer` forbids a raw `ResizeObserver`.)
5. `layout = pacingLayoutForHeaderWidth(headerWidth)`; `rendered = layout !== "hidden" && model.headerRows.length > 0`; `if (!rendered)` render `null` (the effects below still run).
6. Reserve variable (code, because it mutates a DOM node React does not own, and must clean up): the widget root `rootRef` is observed and its width is written to the header element as `--pacing-widget-reserve`, which `ChatHeader` applies as a right margin on its root (Task 8). The header width is the border box of the _header element_, which this padding does not change, so there is no feedback loop.

```tsx
useEffect(() => {
  const header = headerRef.current;
  const root = rootRef.current;
  if (!header || !root) return;
  const stop = observeResize(root, (entries) => {
    const width = entries.at(-1)?.borderBoxSize?.[0]?.inlineSize ?? root.offsetWidth;
    header.style.setProperty(PACING_RESERVE_CSS_VAR, `${pacingReservePx(width)}px`);
  });
  return () => {
    stop();
    header.style.removeProperty(PACING_RESERVE_CSS_VAR);
  };
}, [headerRef, rendered, layout]);
```

7. Markup when rendered: `<div ref={rootRef} data-pacing-widget className="mr-2">` containing `<PacingPopover sections={model.popoverSections} triggerLabel={pacingAriaLabel(model.headerRows)}>` whose child is the row stack `<div className={cn("flex flex-col", pacingRowGapClass(model.headerRows.length))}>`. Each row: `<div data-pacing-row={row.id} className="flex items-center gap-x-1.5 text-2xs leading-3.25 tabular-nums whitespace-nowrap">` with, left to right: label `<span className="w-8 shrink-0 truncate text-muted-foreground">{row.shortLabel}</span>`; `<PacingBar size="header" usedPercent={row.usedPercent} paceFraction={row.paceFraction} color={row.burnColor} />`; burn `<span data-pacing-burn className={cn("w-8 shrink-0 text-right", PACE_TIER_CLASSES[row.burnColor].text)}>{row.burnText}</span>`; and, only when `layout === "full" && row.resetLabel !== null`, `<span data-pacing-reset className="w-16 shrink-0 text-muted-foreground">{row.resetLabel}</span>`.
8. `React.memo` the component (its props are the `usageLimits` object, which keeps identity until the provider snapshot changes, and the stable ref).

- [ ] **Step 1: Write the three files** per the above.
- [ ] **Step 2: Typecheck and lint.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/pacing/PacingBar.tsx apps/web/src/components/pacing/PacingPopover.tsx apps/web/src/components/pacing/PacingWidget.tsx`
    Fix every `shadcn/no-unknown-classes` finding by correcting the class, not by suppressing.
- [ ] **Step 3: Re-run `vp test run apps/web/src/components/pacing/pacingRows.logic.test.ts`** (still PASS).
- [ ] **Step 4: Commit** `feat(web): pacing widget and popover components`.

---

## Task 8: Mount in `ChatView`, make room in `ChatHeader`

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`

**Interfaces:**

- Consumes: Task 6 `resolvePacingPlacement`; Task 7 `PacingWidget`.
- Produces: the widget mounted in exactly one of two places depending on layout (see Open question 2), and a header whose breadcrumb container gives up the widget's width as right margin.

Three layouts exist, and the cluster is only the right home in one of them:

| Condition (ChatView variables)                                     | Where the controls are                                                                                                                                                                                                                            | Widget                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `inlineRightPanelOwnsTitleBar`                                     | the inline right panel is open: terminal and right-panel toggles sit over the panel's tab bar (which reserves `pr-28` for them); only the thread-details toggle (`threadPanelHeaderControl`, `absolute` in the header) belongs to the chat header | `panel-header`: left of `threadPanelHeaderControl`'s `PanelLayoutControls`, inside it |
| neither `rightPanelControlsAtRoot` nor `rightPanelControlsInPanel` | `panelLayoutControls`, the `fixed` cluster, rendered inside `<header>`                                                                                                                                                                            | `cluster`: first child of the cluster, left of the toggles (spec 3.1)                 |
| sheet open, or the inline panel mid-close                          | controls are in the sheet / at root                                                                                                                                                                                                               | `none`                                                                                |

All three placements keep the widget a descendant of `<header data-chat-header>` (or absent), which is why `headerRef` and the CSS variable work.

- [ ] **Step 1: `ChatView.tsx`.** Import `PacingWidget` from `./pacing/PacingWidget` and `resolvePacingPlacement` from `./pacing/pacingRows.logic`. Where `panelToggleControls` / `threadPanelHeaderControl` / `panelLayoutControls` are defined (~line 11243-11295, all plain consts in the render body; ChatView gains no hook and no state), add before them:

```tsx
const pacingWidgetPlacement = resolvePacingPlacement({
  inlineRightPanelOwnsTitleBar,
  rightPanelControlsAtRoot,
  rightPanelControlsInPanel,
});
const pacingWidget = (
  <div className="pointer-events-auto flex h-full items-center">
    <PacingWidget
      usageLimits={activeProviderStatus?.usageLimits}
      headerRef={threadPanelPopoverAnchorRef}
    />
  </div>
);
```

In `threadPanelHeaderControl`, render `{pacingWidgetPlacement === "panel-header" ? pacingWidget : null}` immediately before its `<PanelLayoutControls ... />`. In `panelLayoutControls`, render `{pacingWidgetPlacement === "cluster" ? pacingWidget : null}` as the first child of the cluster `div`, before the `!shouldUsePlanSidebarSheet` maximize `<span>`. The cluster itself is `pointer-events-none`; the wrapper's `pointer-events-auto` makes the widget interactive, as the toggles' wrapper does. The widget's own `mr-2` provides the gap to the toggles and is absent when it renders nothing.

- [ ] **Step 2: `ChatHeader.tsx`.** Leave the root's `rightPanelOpen ? "pr-10" : "pr-24"` padding untouched and add the published reserve as a right **margin** on the same root `div` (the variable is set on the ancestor `<header>` and inherits; the `0px` fallback keeps today's layout when the widget is absent or hidden). The root is `flex-1` inside the header's flex row, so the margin shrinks it and the breadcrumb truncates. Margin, not padding, because `shadcn/no-arbitrary-values` (enabled for `apps/web/src/**` outside `components/ui`) only allows arbitrary values in the `layout` category, which covers margin but not padding (`pr-[calc(...)]` fails lint):

```tsx
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        // --pacing-widget-reserve: written by PacingWidget (PACING_RESERVE_CSS_VAR) on <header>.
        "mr-[var(--pacing-widget-reserve,0px)]",
        rightPanelOpen ? "pr-10" : "pr-24",
```

The variable name must equal `PACING_RESERVE_CSS_VAR`; keep a comment on both sides naming the other.

- [ ] **Step 3: Typecheck and lint.**
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint apps/web/src/components/ChatView.tsx apps/web/src/components/chat/ChatHeader.tsx`
    `ChatView.tsx` is large; lint warnings that exist on the base commit are not yours, only new ones are.
- [ ] **Step 4: Re-run the P4 test set** (Tasks 1-6 files) and confirm still PASS; run any existing `ChatHeader` / `ChatView` tests that exist for these files (`apps/web/src/components/chat/ChatHeader.test.*`, `ChatView.*test*` if present): `PATH="$PWD/node_modules/.bin:$PATH" vp test run <those files>`.
- [ ] **Step 5: Commit** `feat(web): mount the usage pacing widget in the chat header`.

---

## Task 9: User docs and final verification

**Files:**

- Modify: `docs/user/usage.md` (insert a new `##` section before `## Connect a CLIProxyAPI hub`, after the "Track subscription limits" section)

AGENTS.md "Documentation": user docs describe the task and unintuitive parts, not every UI state.

- [ ] **Step 1: Add this section** (keep this voice; settings path is useful, visual detail is not):

```md
## Watch your pace in the chat header

The chat header shows your subscription windows for the thread's provider, for example the 5-hour
session and the weekly limit. Each row has a bar for how much you have used, a tick for how far
through the window you are, a burn multiple, and when the window resets. A burn of `1.0x` means
you will use the whole window by its reset at your current pace; above `1.0x` you are ahead of
it. Hover the widget for every window with its countdown, and click to keep the popover open.

Weekly burn is judged against when you actually work, not the raw calendar. In
**Settings → Usage pacing**, set your work hours and work days; hours outside them count at the
off-hours weight, and days off do not count at all. Choose which windows show in the header there
too. Windows you hide still appear in the popover.

The 5-hour burn needs a few minutes of activity to appear, and starts from a simpler estimate
after the server restarts. A narrow window drops the reset time, and a very narrow one hides the
widget.
```

- [ ] **Step 2: Final targeted verification** (all must pass):
  - `PATH="$PWD/node_modules/.bin:$PATH" vp test run apps/web/src/hooks/useNowTick.test.ts apps/web/src/components/pacing/pacingRows.logic.test.ts apps/web/src/components/settings/usagePacingSettings.logic.test.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/SettingsPanels.restore.test.tsx apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts packages/contracts/src/settings.test.ts`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp run @t3tools/contracts#typecheck` and `... vp run @t3tools/web#typecheck`
  - `PATH="$PWD/node_modules/.bin:$PATH" vp lint` over every file this plan created or modified (`git diff --name-only feat/usage-pacing...HEAD` filtered to `.ts`/`.tsx`).
  - `git diff --name-only feat/usage-pacing...HEAD` touches none of the single-owner files of other plans (`ClaudeAdapterV2.ts`, `ProjectionStore.ts`, `Sidebar.tsx`, `ChatComposer.tsx`, `ContextWindowMeter.tsx`, `packages/shared/*`, `managedProvider.ts`).
- [ ] **Step 3: Commit** `docs(user): explain the usage pacing header widget`.
- [ ] **Step 4: Handoff note to the orchestrator:** list the DOM hooks, state that visual correctness and the three placements are unverified until P6, and name the two spots P6 must eyeball against the mockups: popover type sizes, and the widget at header widths 560/419 px.

---

## Open questions / spec deviations

Each item is self-contained. The recommendation is what this plan implements.

1. **"Container query on the header" cannot be used as written (spec 3.1, 9.1; index 9 item C7).**
   - Context: the controls cluster that holds the widget is `position: fixed`. A CSS container query needs `container-type: inline-size` on `<header data-chat-header>`, which applies containment to the header. Whether that containment turns the header into the containing block for the `fixed` cluster varies by browser version, and if it does the cluster would stop anchoring to the viewport. Separately, in one layout (`rightPanelControlsAtRoot`) the cluster is rendered outside the header, where no container query on the header can reach it.
   - Options: (a) container query and accept the risk; (b) measure the header with the repo's `observeResize` and decide in JS.
   - Recommendation (implemented): (b). `pacingLayoutForHeaderWidth(border-box width of the header)` with the spec's 560/420 thresholds, unit-tested. Behaviour is identical to the spec; only the mechanism differs. The coherence agent should reword spec 3.1 to "measured on the header" (user-visible behaviour unchanged, so a direct spec fix).

2. **Placement when the inline right panel is open (deviates from index section 1 P4 and spec 3.1 "left of the panel-layout controls").**
   - Context: with the inline right panel open, the fixed cluster (terminal and right-panel toggles) sits over the right panel's tab bar, which reserves `pr-28` for exactly those two toggles. A widget in that cluster would cover the tab bar. The chat header's own control in that state is the thread-details toggle (`threadPanelHeaderControl`).
   - Options: (a) widget always in the fixed cluster, overlapping the panel's tabs when it is open; (b) widget beside the thread-details toggle when the panel is open, in the cluster otherwise, hidden in the sheet/closing states; (c) hide the widget whenever a right panel is open.
   - Recommendation (implemented): (b). The widget keeps its spot immediately left of the controls the header owns. Contract deviation recorded: index 6 text says "mounted into `panelLayoutControls`"; this plan mounts it there only for the `cluster` placement. Needs P6 screenshots with the right panel open.

3. **Header row cap (spec 3.1 is silent).** Three rows fit the 52px header (3 x 13px + 2 x 1px + padding); four do not. Providers can report more than three qualifying windows. Options: cap at three, shrink the font, or let the header grow. Recommendation (implemented): cap at `MAX_PACING_HEADER_ROWS = 3` in order (session, weekly, scoped windows by id); the popover lists all windows. A fourth qualifying window is then neither in the header nor tagged `hidden`; acceptable because it cannot occur for Claude today (one scoped window).

4. **Windows past their `resetsAt` (spec 6 silent).** Between a reset and the next probe or event the snapshot still holds the old window. Options: show it as is, show 0%, or drop the row. Recommendation (implemented): show it as is, with burn and tick blank (P1 returns null outside the window) and countdown `now`. Inventing a 0% would be a guess; the server refreshes within the 5-minute probe.

5. **Burn-less bar colour (index D6).** Followed: fill uses the `muted` tier while the burn is unknown. No change.

6. **Role `other` (monthly etc.) windows (index D1).** Followed: never a header row, always in the popover, no `hidden` tag. Spec 3.4 has no toggle for them. The coherence agent should list this under Decisions needed (changes what users of Cursor/OpenCode/Grok see).

7. **"Click pins" is not Base UI's default (spec 3.1).** Base UI's popover toggles a hover-opened popover closed on a click after 500ms and closes it when the pointer leaves. Implemented through a controlled reducer (`reducePacingPopover`). No spec change needed; the spec's description is the behaviour implemented.

8. **Last work day cannot be removed.** The extracted weekday picker ignores a click that would leave zero days (inherited from scheduled tasks). With zero work days the weekly schedule weighs nothing and weekly burn would be blank. Recommendation (implemented): keep the inherited rule. A stored `[]` (hand-edited) is tolerated: no crash, weekly burn and tick blank.

9. **Work-hours end `00:00`.** `<input type="time">` cannot hold `24:00`. The UI shows an end of 24:00 as `00:00` and writes `00:00` back as `24:00`, so the stored string never contains a zero end, independent of how P1 reads one. Start `00:00` and end `00:00` therefore means the full day.

10. **Time inputs follow the browser locale, not `timestampFormat`.** The widget's labels honour the app's 12/24-hour setting (index D5), but the native time inputs in settings render in the OS/browser style. Accepted: the stored value is always 24-hour `HH:MM`.

11. **Off-hours weight snaps to 0.05.** Spec: "number 0-1, step 0.05". A typed `0.12` is stored as `0.1`. Implemented as `Math.round(v * 20) / 20`.

12. **Typography is approximate.** Popover title/percent/burn use `text-sm` and the third line `text-xs`, read off the 2x mockup. P6 compares against the mockup; adjusting is a class change.

13. **AGENTS.md says not to commit plans.** The user's instruction for this plan set (commit locally on `feat/usage-pacing`, no push) overrides it. Keep plan files out of any future PR.
