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
  /** Normalized https origin of a Jira Cloud site. */
  readonly siteUrl: string;
  readonly email: string;
  /** The literal token, already resolved. */
  readonly apiToken: string;
}

/** Where authenticated reads go: scoped API tokens work only through Atlassian's gateway. */
export interface JiraApiConnection {
  readonly cloudId: string;
  readonly email: string;
  readonly apiToken: string;
}

const JIRA_GATEWAY = "https://api.atlassian.com/ex/jira";
const UNREADABLE_REPLY = "Jira returned a reply T3 Code couldn't read.";
const SITE_NOT_FOUND = "Couldn't find that Jira site.";

/** Sends one Jira request and decodes its 2xx JSON body; messages never carry credentials or bodies. */
const sendJira = Effect.fn("Jira.send")(
  function* <S extends Schema.Decoder<unknown>>(
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
    redirect: "error" | "manual" = "error",
  ) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(request.pipe(HttpClientRequest.acceptJson)).pipe(
      // A redirect could carry the credential to another origin.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(() => new JiraUnavailableError({ message: "Couldn't reach Jira." })),
    );
    const status = response.status;
    if (status === 401) {
      return yield* new JiraAuthError({
        status,
        message:
          "Jira rejected the email or API token (401). T3 Code needs an API token with scopes.",
      });
    }
    if (status === 403) {
      return yield* new JiraAuthError({
        status,
        message: "The API token is missing a required read scope (403).",
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
      return yield* new JiraResponseError({ status, message: `Jira returned HTTP ${status}.` });
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
const TenantInfo = Schema.Struct({
  cloudId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
});
const Priorities = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
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

const authed = (connection: JiraApiConnection, request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(
    HttpClientRequest.prependUrl(`${JIRA_GATEWAY}/${connection.cloudId}`),
    HttpClientRequest.basicAuth(connection.email, connection.apiToken),
  );

/** The site's cloud ID, read without credentials so the token never reaches the site host. */
export const readCloudId = Effect.fn("Jira.readCloudId")(function* (siteUrl: string) {
  const siteNotFound = () => Effect.fail(new JiraResponseError({ message: SITE_NOT_FOUND }));
  // No credential is sent, so a redirect is read as a 3xx (a site that isn't there) instead of followed.
  const info = yield* sendJira(
    HttpClientRequest.get(`${siteUrl}/_edge/tenant_info`),
    TenantInfo,
    "manual",
  ).pipe(Effect.catchTags({ JiraAuthError: siteNotFound, JiraResponseError: siteNotFound }));
  return info.cloudId;
});

const readPages = Effect.fn("Jira.readPages")(function* <
  S extends Schema.Decoder<{
    readonly values: ReadonlyArray<unknown>;
    readonly isLast?: boolean | undefined;
  }>,
>(connection: JiraApiConnection, path: string, schema: S) {
  const values: Array<S["Type"]["values"][number]> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = yield* sendJira(
      authed(
        connection,
        HttpClientRequest.get(path).pipe(
          HttpClientRequest.setUrlParams({ startAt: values.length, maxResults: PAGE_SIZE }),
        ),
      ),
      schema,
    );
    values.push(...body.values);
    if (body.values.length === 0 || body.isLast !== false) break;
  }
  return values;
});

export const readAccountName = Effect.fn("Jira.readAccountName")(function* (
  connection: JiraApiConnection,
) {
  const myself = yield* sendJira(
    authed(connection, HttpClientRequest.get("/rest/api/3/myself")),
    Myself,
  );
  return myself.displayName?.trim() || myself.emailAddress?.trim() || myself.accountId;
});

export const readPriorityScale = Effect.fn("Jira.readPriorityScale")(function* (
  connection: JiraApiConnection,
) {
  // /priority/search needs the admin scope manage:jira-configuration; this deprecated list needs only read:priority:jira.
  const values = yield* sendJira(
    authed(connection, HttpClientRequest.get("/rest/api/3/priority")),
    Priorities,
  ).pipe(
    Effect.catchTags({
      // Only a removed endpoint falls back; other errors keep the last good scale and show in the status.
      JiraResponseError: (error) =>
        error.status === 404 || error.status === 410
          ? Effect.logWarning("Jira no longer lists priorities; using the default scale").pipe(
              Effect.as([]),
            )
          : Effect.fail(error),
    }),
  );
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
  connection: JiraApiConnection,
) {
  const fields = yield* sendJira(
    authed(connection, HttpClientRequest.get("/rest/api/3/field")),
    Fields,
  );
  const rankFields = fields.filter((field) => field.schema?.custom === RANK_FIELD_TYPE);
  return (rankFields.find((field) => field.name === "Rank") ?? rankFields[0])?.id ?? null;
});

export const readProjectKeys = Effect.fn("Jira.readProjectKeys")(function* (
  connection: JiraApiConnection,
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
  connection: JiraApiConnection,
  keys: ReadonlyArray<ThreadTicketKey>,
  rankFieldId: string | null,
) {
  const body = yield* sendJira(
    authed(
      connection,
      HttpClientRequest.post("/rest/api/3/issue/bulkfetch").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          issueIdsOrKeys: keys,
          fields: ["summary", "status", "priority", ...(rankFieldId === null ? [] : [rankFieldId])],
          fieldsByKeys: false,
        }),
      ),
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
