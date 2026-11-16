import type { PriorityRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RANK_FIELD_TYPE } from "../jiraApi.ts";

export const FAKE_RANK_FIELD_ID = "customfield_10019";

export interface FakeJiraIssue {
  readonly summary: string | null;
  readonly statusName: string;
  readonly statusCategoryKey: string;
  readonly priority: { readonly id: string; readonly name: string } | null;
  readonly rank: string | null;
}

export interface FakeJiraField {
  readonly id: string;
  readonly name?: string;
  readonly schema?: { readonly custom?: string };
}

export interface FakeJiraState {
  accountName: string;
  priorities: Array<PriorityRef>;
  fields: Array<FakeJiraField>;
  projects: Array<string>;
  issues: Map<string, FakeJiraIssue>;
  /** Largest page the site answers, whatever maxResults asks for. */
  pageSize: number;
}

export type FakeJiraResponse =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  | { readonly type: "network-error" };

export interface FakeJiraRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | null;
  readonly accept: string | null;
  readonly redirect: RequestInit["redirect"];
}

export interface FakeJiraHold {
  /** Completes once the held request has reached the site. */
  readonly arrived: Effect.Effect<void>;
  /** Answers the held request. */
  readonly release: Effect.Effect<void>;
}

const DEFAULT_PRIORITIES: Array<PriorityRef> = [
  { id: "1", name: "Highest" },
  { id: "2", name: "High" },
  { id: "3", name: "Medium" },
  { id: "4", name: "Low" },
  { id: "5", name: "Lowest" },
];

/** An in-memory Jira Cloud site behind a fake `fetch`. */
export function makeFakeJira(initial: Partial<FakeJiraState> = {}) {
  const state: FakeJiraState = {
    accountName: "Ada Lovelace",
    priorities: [...DEFAULT_PRIORITIES],
    fields: [
      { id: "summary", name: "Summary" },
      { id: FAKE_RANK_FIELD_ID, name: "Rank", schema: { custom: RANK_FIELD_TYPE } },
    ],
    projects: ["PROJ"],
    issues: new Map(),
    pageSize: 100,
    ...initial,
  };
  const requests: Array<FakeJiraRequest> = [];
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  const scripted = new Map<string, Array<FakeJiraResponse>>();
  const holds = new Map<
    string,
    Array<{ response: FakeJiraResponse | undefined; arrive: () => void; gate: Promise<void> }>
  >();

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const page = <A>(items: ReadonlyArray<A>, url: URL) => {
    const startAt = Number(url.searchParams.get("startAt") ?? 0);
    const maxResults = Math.min(Number(url.searchParams.get("maxResults") ?? 50), state.pageSize);
    const values = items.slice(startAt, startAt + maxResults);
    return json({ startAt, maxResults, values, isLast: startAt + values.length >= items.length });
  };

  const answer = (method: string, url: URL, body: unknown): Response => {
    const route = `${method} ${url.pathname}`;
    switch (route) {
      case "GET /rest/api/3/myself":
        return json({
          accountId: "account-1",
          displayName: state.accountName,
          emailAddress: "me@example.com",
        });
      case "GET /rest/api/3/priority/search":
        return page(state.priorities, url);
      case "GET /rest/api/3/field":
        return json(state.fields);
      case "GET /rest/api/3/project/search":
        return page(
          state.projects.map((key) => ({ key })),
          url,
        );
      case "POST /rest/api/3/issue/bulkfetch": {
        const request = body as { issueIdsOrKeys: Array<string>; fields: Array<string> };
        const issues = request.issueIdsOrKeys.flatMap((key) => {
          const issue = state.issues.get(key);
          if (issue === undefined) return [];
          const fields: Record<string, unknown> = {
            summary: issue.summary,
            status: { name: issue.statusName, statusCategory: { key: issue.statusCategoryKey } },
            priority: issue.priority,
          };
          for (const field of request.fields) {
            if (field === FAKE_RANK_FIELD_ID && issue.rank !== null) fields[field] = issue.rank;
          }
          return [{ id: `id-${key}`, key, fields }];
        });
        const issueErrors = request.issueIdsOrKeys
          .filter((key) => !state.issues.has(key))
          .map((key) => ({ issueIdsOrKeys: [key], status: 404, errorMessages: ["Not found"] }));
        return json({ issues, issueErrors });
      }
      default:
        return json({ errorMessages: ["Not found"] }, 404);
    }
  };

  const respond = (response: FakeJiraResponse): Response => {
    if ("type" in response) throw new TypeError("fetch failed");
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json", ...response.headers },
    });
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const text =
      rawBody === undefined || rawBody === null
        ? undefined
        : typeof rawBody === "string"
          ? rawBody
          : new TextDecoder().decode(rawBody as Uint8Array);
    const body: unknown = text === undefined ? undefined : JSON.parse(text);
    requests.push({
      method,
      path: url.pathname,
      url: url.href,
      body,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      redirect: init?.redirect,
    });
    for (const waiter of requestWaiters.filter((entry) => requests.length >= entry.count)) {
      requestWaiters.splice(requestWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const held = holds.get(url.pathname)?.shift();
    if (held !== undefined) {
      held.arrive();
      await held.gate;
      return held.response === undefined ? answer(method, url, body) : respond(held.response);
    }
    const next = scripted.get(url.pathname)?.shift();
    return next === undefined ? answer(method, url, body) : respond(next);
  };

  return {
    fetch,
    state,
    requests,
    /** Answers the next request to `path` with `response` instead of the site's normal answer. */
    failNext: (path: string, response: FakeJiraResponse) => {
      scripted.set(path, [...(scripted.get(path) ?? []), response]);
    },
    /** Completes once the site has received at least `count` requests in total. */
    untilRequests: (count: number): Effect.Effect<void> =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (requests.length >= count) resolve();
            else requestWaiters.push({ count, resolve });
          }),
      ),
    /** Parks the next request to `path` until `release` runs, then answers it. */
    holdNext: (path: string, response?: FakeJiraResponse): FakeJiraHold => {
      let arrive!: () => void;
      let open!: () => void;
      const arrived = new Promise<void>((resolve) => (arrive = resolve));
      const gate = new Promise<void>((resolve) => (open = resolve));
      holds.set(path, [...(holds.get(path) ?? []), { response, arrive, gate }]);
      return {
        arrived: Effect.promise(() => arrived),
        release: Effect.sync(() => open()),
      };
    },
  };
}

export type FakeJira = ReturnType<typeof makeFakeJira>;
