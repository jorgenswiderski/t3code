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

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
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
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
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
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
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

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A successful probe replaces the published windows outright, including any
 * runtime update that landed while it was running. That is a deliberate
 * trade-off: the Codex and Claude reads take a few seconds at most, the
 * probe is the fresher full read in every case except that window, and the
 * per-window epoch bookkeeping needed to reconcile the two was more code
 * than the sub-second regression it prevented. The next runtime event
 * corrects it.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  return probed;
}

const USAGE_HISTORY_MAX_SAMPLES = 400;
const USAGE_HISTORY_HEARTBEAT_MS = 60_000;
/** The probe reports reset times as ISO strings, events as whole epoch seconds. */
const USAGE_HISTORY_RESET_TOLERANCE_MS = 60_000;

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
 * Add one sample per session window to `history`, from the merged `limits`
 * that were just published. A runtime update passes the ids it carried; a
 * probe passes `undefined`, a full read that also drops lists of session
 * windows `limits` no longer reports. Returns `history` itself when nothing
 * changed, so callers can skip a publish. `applyUsageLimitsUpdate` stays
 * history-agnostic: `usageWindowEquals` deliberately ignores `history`, and
 * callers re-attach it with `attachUsageHistory`.
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
    // Usage never falls within one reset period. A lower reading is a source
    // that lags (probe and runtime events round differently), so the list
    // stays monotonic and the burn does not jitter.
    const usedPercent =
      last !== undefined && window.resetsAt !== undefined
        ? Math.max(last.usedPercent, window.usedPercent)
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
 * Publish `history` on the session windows of `limits`, and strip it from any
 * window that should not carry it. A session reading below the newest sample
 * of the same reset period is raised to it, so the published value always
 * equals the newest sample. Returns `limits` itself when no window changes.
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
      newest > window.usedPercent &&
      window.resetsAt !== undefined &&
      sameWindowReset(entry?.resetsAt, window.resetsAt)
        ? newest
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
