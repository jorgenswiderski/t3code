import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageSample,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

/**
 * Whether publishing `next` would show clients nothing new over `published`.
 * `checkedAt` alone does not count, matching `applyUsageLimitsUpdate`.
 */
export function usageLimitsLookSame(
  next: ServerProviderUsageLimits | undefined,
  published: ServerProviderUsageLimits | undefined,
): boolean {
  if (next === published) return true;
  if (next === undefined || published === undefined) return false;
  return (
    next.unavailable === published.unavailable &&
    next.credentialFingerprint === published.credentialFingerprint &&
    next.resetCredits === published.resetCredits &&
    next.windows.length === published.windows.length &&
    next.windows.every((window, index) => {
      const other = published.windows[index]!;
      return usageWindowEquals(window, other) && window.history === other.history;
    })
  );
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}

const USAGE_HISTORY_MAX_SAMPLES = 400;
const USAGE_HISTORY_HEARTBEAT_MS = 60_000;
/** The probe reports reset times as ISO strings, events as whole epoch seconds. */
const USAGE_HISTORY_RESET_TOLERANCE_MS = 60_000;
/**
 * Points a probe may fall below the previous sample of the same reset period
 * and still count as lagging: probes and runtime events round differently. A
 * larger probe drop is real (a rolling window aging out), kept as is.
 */
const USAGE_HISTORY_LAG_TOLERANCE = 1;

/**
 * The reading to record against the previous sample of the same reset period.
 * A lower runtime-event reading is usually another thread's stale one, so events
 * only raise the window; a probe reads the account directly, so only rounding lag is held.
 */
function heldReading(previous: number | undefined, reading: number, fromProbe: boolean): number {
  if (previous === undefined || reading >= previous) return reading;
  return !fromProbe || previous - reading <= USAGE_HISTORY_LAG_TOLERANCE ? previous : reading;
}

interface UsageHistoryEntry {
  readonly resetsAt: string | undefined;
  readonly samples: ReadonlyArray<ServerProviderUsageSample>;
}
/** Samples of each session window's current reset period, keyed by window id. */
export type UsageHistory = ReadonlyMap<string, UsageHistoryEntry>;
export const EMPTY_USAGE_HISTORY: UsageHistory = new Map();

function sameWindowReset(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return Math.abs(left - right) <= USAGE_HISTORY_RESET_TOLERANCE_MS;
}

/**
 * Add one sample per session window to `history`, from the just-published `limits`.
 * A runtime update passes the ids it carried; a probe passes `undefined` (full read, also
 * drops windows no longer reported). Returns `history` itself when unchanged. History is
 * attached separately by `attachUsageHistory` (`usageWindowEquals` ignores it).
 */
export function recordUsageSamples(input: {
  readonly history: UsageHistory;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly windowIds: ReadonlySet<string> | undefined;
  readonly at: string;
}): UsageHistory {
  const { history, limits, windowIds, at } = input;
  const sessionWindows = (limits?.windows ?? []).filter((window) => window.kind === "session");
  let next: Map<string, UsageHistoryEntry> | undefined;
  const edit = () => (next ??= new Map(history));

  if (windowIds === undefined) {
    const present = new Set(sessionWindows.map((window) => window.id));
    for (const id of history.keys()) {
      if (!present.has(id)) edit().delete(id);
    }
  }
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return next ?? history;

  for (const window of sessionWindows) {
    if (windowIds !== undefined && !windowIds.has(window.id)) continue;
    const previous = history.get(window.id);
    const entry =
      previous !== undefined && sameWindowReset(previous.resetsAt, window.resetsAt)
        ? previous
        : undefined;
    const last = entry?.samples.at(-1);
    const lastMs = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.at);
    // A lagging reading would break the client's burn walk at every dip.
    const usedPercent =
      window.resetsAt !== undefined
        ? heldReading(last?.usedPercent, window.usedPercent, windowIds === undefined)
        : window.usedPercent;
    if (
      last !== undefined &&
      last.usedPercent === usedPercent &&
      atMs - lastMs < USAGE_HISTORY_HEARTBEAT_MS
    ) {
      continue;
    }
    const sample = {
      at: last !== undefined && lastMs > atMs ? last.at : at,
      usedPercent,
    };
    edit().set(window.id, {
      resetsAt: window.resetsAt,
      samples: [...(entry?.samples ?? []), sample].slice(-USAGE_HISTORY_MAX_SAMPLES),
    });
  }
  return next ?? history;
}

/**
 * Publish `history` on the session windows of `limits`, stripping it from any other
 * window. A session reading below the newest sample of the same reset period is
 * raised to it. Returns `limits` itself when no window changes.
 */
export function attachUsageHistory(
  limits: ServerProviderUsageLimits | undefined,
  history: UsageHistory,
): ServerProviderUsageLimits | undefined {
  if (limits === undefined) return limits;
  let changed = false;
  const windows = limits.windows.map((window) => {
    const entry = window.kind === "session" ? history.get(window.id) : undefined;
    const samples = entry?.samples;
    const wanted = samples !== undefined && samples.length > 0 ? samples : undefined;
    const newest = wanted?.at(-1)?.usedPercent;
    const usedPercent =
      newest !== undefined &&
      window.resetsAt !== undefined &&
      sameWindowReset(entry?.resetsAt, window.resetsAt)
        ? Math.max(newest, window.usedPercent)
        : window.usedPercent;
    if (window.history === wanted && window.usedPercent === usedPercent) return window;
    changed = true;
    const { history: _stale, ...rest } = window;
    return wanted === undefined
      ? { ...rest, usedPercent }
      : { ...rest, usedPercent, history: wanted };
  });
  return changed ? { ...limits, windows } : limits;
}
