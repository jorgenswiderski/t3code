import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  type PriorityRef,
  type ThreadTicketKey,
  type ThreadTicketSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  JiraAuthError,
  JiraResponseError,
  type JiraTicketFetchResult,
  JiraUnavailableError,
} from "./JiraService.ts";

const REQUEST_TIMEOUT = "20 seconds";
export const RANK_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-lexo-rank";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
export const MAX_KEYS_PER_REQUEST = 100;

export interface JiraConnection {
  /** Normalized https origin. */
  readonly siteUrl: string;
  readonly email: string;
  /** The literal token, already resolved. */
  readonly apiToken: string;
}

const UNREADABLE_REPLY = "Jira returned a reply T3 Code couldn't read.";

/** Sends one Jira request and decodes its 2xx JSON body; messages never carry credentials or bodies. */
const sendJira = Effect.fn("Jira.send")(
  function* <S extends Schema.Decoder<unknown>>(
    connection: JiraConnection,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        request.pipe(
          HttpClientRequest.basicAuth(connection.email, connection.apiToken),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        // A redirect could carry the credential to another origin.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(() => new JiraUnavailableError({ message: "Couldn't reach Jira." })),
      );
    const status = response.status;
    if (status === 401) {
      return yield* new JiraAuthError({
        status,
        message: "Jira rejected the email or API token (401).",
      });
    }
    if (status === 403) {
      return yield* new JiraAuthError({
        status,
        message: "Jira refused access for this account (403).",
      });
    }
    if (status === 429) {
      const seconds = Number(response.headers["retry-after"]);
      return yield* new JiraUnavailableError({
        message: "Jira is rate-limiting requests (429).",
        ...(Number.isFinite(seconds) && seconds >= 0
          ? { retryAfterMs: Math.ceil(seconds * 1000) }
          : {}),
      });
    }
    if (status >= 500) {
      return yield* new JiraUnavailableError({ message: `Jira returned HTTP ${status}.` });
    }
    if (status < 200 || status >= 300) {
      return yield* new JiraResponseError({ message: `Jira returned HTTP ${status}.` });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(() => new JiraResponseError({ message: UNREADABLE_REPLY })),
    );
    return yield* Schema.decodeEffect(schema)(body).pipe(
      Effect.mapError(() => new JiraResponseError({ message: UNREADABLE_REPLY })),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new JiraUnavailableError({ message: "Jira took too long to respond." })),
      }),
    ),
);

const Myself = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
});
const PriorityPage = Schema.Struct({
  values: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  isLast: Schema.optional(Schema.Boolean),
});
const Fields = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    schema: Schema.optional(Schema.Struct({ custom: Schema.optional(Schema.String) })),
  }),
);
const ProjectPage = Schema.Struct({
  values: Schema.Array(Schema.Struct({ key: Schema.String })),
  isLast: Schema.optional(Schema.Boolean),
});
const BulkFetch = Schema.Struct({
  issues: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        fields: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  ),
});
const IssueFields = Schema.Struct({
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.String,
        statusCategory: Schema.optional(Schema.Struct({ key: Schema.String })),
      }),
    ),
  ),
  priority: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  ),
});
const decodeIssueFields = Schema.decodeUnknownOption(IssueFields);

const url = (connection: JiraConnection, path: string) => `${connection.siteUrl}${path}`;

const readPages = Effect.fn("Jira.readPages")(function* <
  S extends Schema.Decoder<{
    readonly values: ReadonlyArray<unknown>;
    readonly isLast?: boolean | undefined;
  }>,
>(connection: JiraConnection, path: string, schema: S) {
  const values: Array<S["Type"]["values"][number]> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = yield* sendJira(
      connection,
      HttpClientRequest.get(url(connection, path)).pipe(
        HttpClientRequest.setUrlParams({ startAt: values.length, maxResults: PAGE_SIZE }),
      ),
      schema,
    );
    values.push(...body.values);
    if (body.values.length === 0 || body.isLast !== false) break;
  }
  return values;
});

export const readAccountName = Effect.fn("Jira.readAccountName")(function* (
  connection: JiraConnection,
) {
  const myself = yield* sendJira(
    connection,
    HttpClientRequest.get(url(connection, "/rest/api/3/myself")),
    Myself,
  );
  return myself.displayName?.trim() || myself.emailAddress?.trim() || myself.accountId;
});

export const readPriorityScale = Effect.fn("Jira.readPriorityScale")(function* (
  connection: JiraConnection,
) {
  const values = yield* readPages(connection, "/rest/api/3/priority/search", PriorityPage);
  const scale: ReadonlyArray<PriorityRef> = values
    .map((value) => ({ id: value.id, name: value.name.trim() }))
    .filter((value) => value.id !== "" && value.name !== "");
  if (scale.length === 0) {
    yield* Effect.logWarning("Jira listed no priorities; using the default scale");
    return DEFAULT_TICKET_PRIORITY_SCALE;
  }
  return scale;
});

export const readRankFieldId = Effect.fn("Jira.readRankFieldId")(function* (
  connection: JiraConnection,
) {
  const fields = yield* sendJira(
    connection,
    HttpClientRequest.get(url(connection, "/rest/api/3/field")),
    Fields,
  );
  const rankFields = fields.filter((field) => field.schema?.custom === RANK_FIELD_TYPE);
  return (rankFields.find((field) => field.name === "Rank") ?? rankFields[0])?.id ?? null;
});

export const readProjectKeys = Effect.fn("Jira.readProjectKeys")(function* (
  connection: JiraConnection,
) {
  const values = yield* readPages(connection, "/rest/api/3/project/search", ProjectPage);
  return new Set(values.map((value) => value.key.toUpperCase())) as ReadonlySet<string>;
});

function toTicketSnapshot(
  fields: Readonly<Record<string, unknown>>,
  rankFieldId: string | null,
): Omit<ThreadTicketSnapshot, "syncedAt"> | null {
  const decoded = decodeIssueFields(fields);
  if (Option.isNone(decoded)) return null;
  const { summary, status, priority } = decoded.value;
  const category = status?.statusCategory?.key;
  const rank = rankFieldId === null ? undefined : fields[rankFieldId];
  const priorityId = priority?.id.trim() ?? "";
  const priorityName = priority?.name.trim() ?? "";
  return {
    title: summary ?? "",
    statusName: status?.name ?? "",
    statusCategory: category === "indeterminate" || category === "done" ? category : "new",
    priority:
      priorityId !== "" && priorityName !== "" ? { id: priorityId, name: priorityName } : null,
    rank: typeof rank === "string" && rank !== "" ? rank : null,
  };
}

/** One chunk of at most MAX_KEYS_PER_REQUEST keys; missing and invisible issues read not_found. */
export const fetchTicketBatch = Effect.fn("Jira.fetchTicketBatch")(function* (
  connection: JiraConnection,
  keys: ReadonlyArray<ThreadTicketKey>,
  rankFieldId: string | null,
) {
  const body = yield* sendJira(
    connection,
    HttpClientRequest.post(url(connection, "/rest/api/3/issue/bulkfetch")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        issueIdsOrKeys: keys,
        fields: ["summary", "status", "priority", ...(rankFieldId === null ? [] : [rankFieldId])],
        fieldsByKeys: false,
      }),
    ),
    BulkFetch,
  );
  const byKey = new Map((body.issues ?? []).map((issue) => [issue.key.toUpperCase(), issue]));
  return new Map<ThreadTicketKey, JiraTicketFetchResult>(
    keys.map((key) => {
      const issue = byKey.get(key);
      const snapshot = issue === undefined ? null : toTicketSnapshot(issue.fields, rankFieldId);
      return [
        key,
        snapshot === null
          ? { type: "unreachable", syncError: "not_found" }
          : { type: "found", snapshot },
      ];
    }),
  );
});
