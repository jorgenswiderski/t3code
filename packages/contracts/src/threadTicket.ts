import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Canonical Jira issue key, upper case: PROJ-123. */
export const ThreadTicketKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]+-[0-9]+$/),
);
export type ThreadTicketKey = typeof ThreadTicketKey.Type;

/** branch-dismissed: the user removed a branch-detected link; hidden, and branch detection never re-adds it. */
export const ThreadTicketLinkSource = Schema.Literals([
  "manual",
  "agent",
  "branch",
  "branch-dismissed",
]);
export type ThreadTicketLinkSource = typeof ThreadTicketLinkSource.Type;

/** Sources a link command may carry. */
export const ThreadTicketCommandSource = Schema.Literals(["manual", "agent", "branch"]);
export type ThreadTicketCommandSource = typeof ThreadTicketCommandSource.Type;

export const ThreadTicketStatusCategory = Schema.Literals(["new", "indeterminate", "done"]);
export type ThreadTicketStatusCategory = typeof ThreadTicketStatusCategory.Type;

export const PriorityRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type PriorityRef = typeof PriorityRef.Type;

export const ThreadTicketSnapshot = Schema.Struct({
  title: Schema.String,
  statusName: Schema.String,
  statusCategory: ThreadTicketStatusCategory,
  priority: Schema.NullOr(PriorityRef),
  /** Jira LexoRank, compared by code unit. */
  rank: Schema.NullOr(Schema.String),
  /** When the reactor read this data. */
  syncedAt: IsoDateTime,
});
export type ThreadTicketSnapshot = typeof ThreadTicketSnapshot.Type;

export const ThreadTicketSyncError = Schema.Literals(["not_found", "forbidden"]);
export type ThreadTicketSyncError = typeof ThreadTicketSyncError.Type;

export const ThreadTicketLink = Schema.Struct({
  tracker: Schema.Literal("jira"),
  key: ThreadTicketKey,
  /** Canonical browse URL when known. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  source: ThreadTicketLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadTicketSnapshot),
  syncError: Schema.NullOr(ThreadTicketSyncError),
});
export type ThreadTicketLink = typeof ThreadTicketLink.Type;

export const ThreadPriority = Schema.Struct({
  user: Schema.NullOr(PriorityRef),
  agent: Schema.NullOr(PriorityRef),
});
export type ThreadPriority = typeof ThreadPriority.Type;

export const EMPTY_THREAD_PRIORITY: ThreadPriority = { user: null, agent: null };

/** Links read back from storage or a peer. Lenient so a value this build cannot read never fails a whole thread. */
export const StoredThreadTicketLinks = Schema.Array(ThreadTicketLink).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

/** Priority read back from storage or a peer. Lenient like `StoredThreadTicketLinks`. */
export const StoredThreadPriority = ThreadPriority.pipe(
  Schema.catchDecoding(() => Effect.succeedSome(EMPTY_THREAD_PRIORITY)),
);

export const DEFAULT_TICKET_PRIORITY_SCALE: ReadonlyArray<PriorityRef> = [
  { id: "default:highest", name: "Highest" },
  { id: "default:high", name: "High" },
  { id: "default:medium", name: "Medium" },
  { id: "default:low", name: "Low" },
  { id: "default:lowest", name: "Lowest" },
];

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9_]+-[0-9]+$/;
const BROWSE_PATH = /\/browse\/([A-Za-z][A-Za-z0-9_]+-[0-9]+)(?:\/|$)/;
const BRANCH_KEY = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]+-[0-9]+)(?![0-9])/g;

export function parseTicketReference(
  input: string,
): { key: ThreadTicketKey; url: string | null } | null {
  const trimmed = input.trim();
  if (TICKET_KEY.test(trimmed)) return { key: trimmed.toUpperCase(), url: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const candidate = BROWSE_PATH.exec(url.pathname)?.[1] ?? url.searchParams.get("selectedIssue");
  if (candidate === null || candidate === undefined || !TICKET_KEY.test(candidate)) return null;
  const key = candidate.toUpperCase();
  return { key, url: `${url.origin}/browse/${key}` };
}

export function branchTicketKeys(branch: string | null): ReadonlyArray<ThreadTicketKey> {
  if (branch === null) return [];
  const keys = [...branch.matchAll(BRANCH_KEY)].map((match) => match[1]!.toUpperCase());
  return [...new Set(keys)];
}

export function jiraBrowseUrl(siteUrl: string, key: ThreadTicketKey): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${key}`;
}

export function visibleThreadTicketLinks(
  links: ReadonlyArray<ThreadTicketLink>,
): ReadonlyArray<ThreadTicketLink> {
  return links.filter((link) => link.source !== "branch-dismissed");
}

/** Allocation-free `visibleThreadTicketLinks(links).length > 0`, for per-row render gates. */
export function hasVisibleThreadTicketLinks(links: ReadonlyArray<ThreadTicketLink>): boolean {
  return links.some((link) => link.source !== "branch-dismissed");
}

export function isReadableThreadTicketLink(link: ThreadTicketLink): boolean {
  return link.source !== "branch-dismissed" && link.snapshot !== null && link.syncError === null;
}

/** Ignores `syncedAt`, so re-reading unchanged Jira data is not a change. */
export function threadTicketSnapshotsEqual(
  a: ThreadTicketSnapshot,
  b: ThreadTicketSnapshot,
): boolean {
  return (
    a.title === b.title &&
    a.statusName === b.statusName &&
    a.statusCategory === b.statusCategory &&
    a.rank === b.rank &&
    (a.priority === null || b.priority === null
      ? a.priority === b.priority
      : a.priority.id === b.priority.id && a.priority.name === b.priority.name)
  );
}

/** Position 0 is the highest priority. Matches by id first, then by case-insensitive name. */
export function findPriorityInScale(
  scale: ReadonlyArray<PriorityRef>,
  value: { readonly id?: string; readonly name?: string } | string,
): { ref: PriorityRef; position: number } | null {
  const id = typeof value === "string" ? value : value.id;
  const name = typeof value === "string" ? value : value.name;
  const byId = id === undefined ? -1 : scale.findIndex((ref) => ref.id === id);
  const lowered = name?.toLowerCase();
  const position =
    byId >= 0
      ? byId
      : lowered === undefined
        ? -1
        : scale.findIndex((ref) => ref.name.toLowerCase() === lowered);
  const ref = scale[position];
  return ref === undefined ? null : { ref, position };
}

/** Keys thread search matches: every link the thread shows, so not dismissed branch links. */
export function searchableTicketKeys(
  links: ReadonlyArray<ThreadTicketLink> | undefined,
): ReadonlyArray<string> {
  return (links ?? []).flatMap((link) => (link.source === "branch-dismissed" ? [] : [link.key]));
}
