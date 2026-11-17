import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  type JiraConnectionStatus,
  type JiraSettings,
  type JiraTestConnectionInput,
  type JiraTestConnectionResult,
  type PriorityRef,
  type ServerSettings,
  type ThreadTicketKey,
  type ThreadTicketSnapshot,
  type ThreadTicketSyncError,
  jiraBrowseUrl,
  normalizeJiraSiteUrl,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  type JiraConnection,
  MAX_KEYS_PER_REQUEST,
  fetchTicketBatch,
  readAccountName,
  readPriorityScale,
  readProjectKeys,
  readRankFieldId,
} from "./jiraApi.ts";

export class JiraNotConfiguredError extends Schema.TaggedError<JiraNotConfiguredError>()(
  "JiraNotConfiguredError",
  {},
) {}
export class JiraAuthError extends Schema.TaggedError<JiraAuthError>()("JiraAuthError", {
  status: Schema.Number,
  message: Schema.String,
}) {}
export class JiraUnavailableError extends Schema.TaggedError<JiraUnavailableError>()(
  "JiraUnavailableError",
  { message: Schema.String, retryAfterMs: Schema.optional(Schema.Number) },
) {}
export class JiraResponseError extends Schema.TaggedError<JiraResponseError>()(
  "JiraResponseError",
  { message: Schema.String },
) {}
export type JiraError =
  | JiraNotConfiguredError
  | JiraAuthError
  | JiraUnavailableError
  | JiraResponseError;
type JiraRequestError = JiraAuthError | JiraUnavailableError | JiraResponseError;

export type JiraTicketFetchResult =
  | { readonly type: "found"; readonly snapshot: Omit<ThreadTicketSnapshot, "syncedAt"> }
  | { readonly type: "unreachable"; readonly syncError: ThreadTicketSyncError };

export class JiraService extends Context.Service<
  JiraService,
  {
    readonly isConfigured: Effect.Effect<boolean>;
    readonly status: Effect.Effect<JiraConnectionStatus>;
    readonly streamStatus: Stream.Stream<JiraConnectionStatus>;
    readonly priorityScale: Effect.Effect<ReadonlyArray<PriorityRef>>;
    readonly streamPriorityScale: Stream.Stream<ReadonlyArray<PriorityRef>>;
    readonly browseUrl: (key: ThreadTicketKey) => Effect.Effect<string | null>;
    readonly projectKeys: Effect.Effect<ReadonlySet<string>, JiraError>;
    readonly fetchTickets: (
      keys: ReadonlyArray<ThreadTicketKey>,
    ) => Effect.Effect<ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>, JiraError>;
    readonly testConnection: (
      input: JiraTestConnectionInput,
    ) => Effect.Effect<JiraTestConnectionResult>;
  }
>()("t3/jira/JiraService") {}

type RequestOutcome =
  | { readonly type: "success"; readonly accountName?: string }
  | { readonly type: "failure"; readonly error: JiraRequestError };

function nextJiraStatus(
  previous: JiraConnectionStatus,
  outcome: RequestOutcome,
  nowIso: string,
): JiraConnectionStatus {
  if (outcome.type === "success") {
    return {
      state: "connected",
      siteUrl: previous.siteUrl,
      accountName: outcome.accountName ?? previous.accountName,
      error: null,
    };
  }
  const kind =
    outcome.error._tag === "JiraAuthError"
      ? "auth"
      : outcome.error._tag === "JiraUnavailableError"
        ? "unavailable"
        : "response";
  return {
    state: "error",
    siteUrl: previous.siteUrl,
    accountName: previous.accountName,
    error: { kind, message: outcome.error.message, since: previous.error?.since ?? nowIso },
  };
}

const DISCONNECTED: JiraConnectionStatus = {
  state: "disconnected",
  siteUrl: null,
  accountName: null,
  error: null,
};

type ConnectionRead =
  | { readonly type: "none"; readonly siteUrl: string | null }
  | {
      readonly type: "invalid";
      readonly siteUrl: string | null;
      readonly kind: "auth" | "response";
      readonly message: string;
    }
  | { readonly type: "ready"; readonly connection: JiraConnection };

interface ConnectionCache {
  readonly generation: number;
  readonly rankFieldId: Option.Option<string | null>;
  readonly projectKeys: ReadonlySet<string> | null;
  /** False when this connection began with a token its secret provider could not read. */
  readonly tokenRead: boolean;
}

const UNREADABLE_TOKEN = "Could not read the Jira API token from its secret provider.";

const stateStream = <A>(ref: Ref.Ref<A>, changes: PubSub.PubSub<A>): Stream.Stream<A> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const current = yield* Ref.get(ref);
      return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription)).pipe(
        Stream.changesWith((left: A, right: A) => Equal.equals(left, right)),
      );
    }),
  );

export const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const withHttp = Effect.provideService(HttpClient.HttpClient, http);

  const statusRef = yield* Ref.make<JiraConnectionStatus>(DISCONNECTED);
  const scaleRef = yield* Ref.make<ReadonlyArray<PriorityRef>>(DEFAULT_TICKET_PRIORITY_SCALE);
  const cacheRef = yield* Ref.make<ConnectionCache>({
    generation: 0,
    rankFieldId: Option.none(),
    projectKeys: null,
    tokenRead: true,
  });
  // Asks the settings stream to connect again with the saved settings.
  const reconnects = yield* Queue.sliding<void>(1);
  const statusChanges = yield* Effect.acquireRelease(
    PubSub.unbounded<JiraConnectionStatus>(),
    PubSub.shutdown,
  );
  const scaleChanges = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<PriorityRef>>(),
    PubSub.shutdown,
  );
  // Serializes generation checks with status writes, so an old connection's outcome cannot land after a reconnect.
  const statusLock = yield* Semaphore.make(1);

  const publish = Effect.fn("JiraService.publish")(function* <A>(
    ref: Ref.Ref<A>,
    changes: PubSub.PubSub<A>,
    next: A,
  ) {
    const changed = yield* Ref.modify(ref, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });
  const publishStatus = (next: JiraConnectionStatus) => publish(statusRef, statusChanges, next);
  const publishScale = (next: ReadonlyArray<PriorityRef>) => publish(scaleRef, scaleChanges, next);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const whenCurrent = (generation: number, effect: Effect.Effect<void>) =>
    Ref.get(cacheRef).pipe(
      Effect.flatMap((cache) => (cache.generation === generation ? effect : Effect.void)),
      statusLock.withPermits(1),
    );

  const record = (generation: number, outcome: RequestOutcome) =>
    whenCurrent(
      generation,
      Effect.gen(function* () {
        const previous = yield* Ref.get(statusRef);
        yield* publishStatus(nextJiraStatus(previous, outcome, yield* nowIso));
      }),
    );

  const updateCache = (generation: number, f: (cache: ConnectionCache) => ConnectionCache) =>
    Ref.update(cacheRef, (cache) => (cache.generation === generation ? f(cache) : cache));

  const tracked = <A>(
    generation: number,
    request: Effect.Effect<A, JiraRequestError, HttpClient.HttpClient>,
    accountName?: (value: A) => string,
  ) =>
    request.pipe(
      withHttp,
      Effect.tapError((error) => record(generation, { type: "failure", error })),
      Effect.tap((value) =>
        record(
          generation,
          accountName === undefined
            ? { type: "success" }
            : { type: "success", accountName: accountName(value) },
        ),
      ),
    );

  const resolveConnection = Effect.fn("JiraService.resolveConnection")(function* (
    jira: JiraSettings | null,
  ) {
    if (jira === null) return { type: "none", siteUrl: null } satisfies ConnectionRead;
    const siteUrl = normalizeJiraSiteUrl(jira.siteUrl);
    if (jira.apiToken === "") return { type: "none", siteUrl } satisfies ConnectionRead;
    if (siteUrl === null) {
      return {
        type: "invalid",
        siteUrl,
        kind: "response",
        message: "The saved Jira site is not a Jira Cloud site (your-team.atlassian.net).",
      } satisfies ConnectionRead;
    }
    const token = yield* requireSettingsSecret(secrets, jira.apiToken).pipe(Effect.result);
    if (token._tag === "Failure" || token.success === "") {
      return {
        type: "invalid",
        siteUrl,
        kind: "auth",
        message: token._tag === "Failure" ? token.failure.message : UNREADABLE_TOKEN,
      } satisfies ConnectionRead;
    }
    return {
      type: "ready",
      connection: { siteUrl, email: jira.email, apiToken: token.success },
    } satisfies ConnectionRead;
  });

  const savedJira = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.jira),
    Effect.orElseSucceed((): JiraSettings | null => null),
  );
  const readConnection = savedJira.pipe(Effect.flatMap(resolveConnection));

  const readyConnection = Effect.gen(function* () {
    const read = yield* readConnection;
    if (read.type !== "ready") return yield* new JiraNotConfiguredError();
    const cache = yield* Ref.get(cacheRef);
    // Only the caller that claims the unread token goes ahead; the rest meet the auth pause until the reconnect runs.
    const claimed =
      !cache.tokenRead &&
      (yield* Ref.modify(cacheRef, (current) =>
        current.generation === cache.generation && !current.tokenRead
          ? [true, { ...current, tokenRead: true }]
          : [false, current],
      ));
    if (claimed) {
      // The token reads now (its provider was unlocked), so no request failed; connect afresh.
      yield* Queue.offer(reconnects, undefined);
    } else {
      const status = yield* Ref.get(statusRef);
      // Repeated failing Basic-auth requests can lock the Atlassian account; only a refresh or a settings change retries.
      if (status.error?.kind === "auth") {
        return yield* new JiraAuthError({ status: 401, message: status.error.message });
      }
    }
    return { connection: read.connection, cache };
  });

  const refreshSite = Effect.fn("JiraService.refreshSite")(function* (
    generation: number,
    connection: JiraConnection,
  ) {
    yield* tracked(generation, readAccountName(connection), (name) => name);
    const scale = yield* tracked(generation, readPriorityScale(connection));
    yield* whenCurrent(generation, publishScale(scale));
    const projectKeys = yield* tracked(generation, readProjectKeys(connection));
    yield* updateCache(generation, (cache) => ({ ...cache, projectKeys }));
    if (Option.isNone((yield* Ref.get(cacheRef)).rankFieldId)) {
      const rankFieldId = yield* tracked(generation, readRankFieldId(connection));
      yield* updateCache(generation, (cache) => ({
        ...cache,
        rankFieldId: Option.some(rankFieldId),
      }));
    }
  });

  const connect = Effect.fn("JiraService.connect")(function* (jira: JiraSettings | null) {
    const read = yield* resolveConnection(jira);
    const now = yield* nowIso;
    const generation = yield* Effect.gen(function* () {
      const next = (yield* Ref.get(cacheRef)).generation + 1;
      yield* Ref.set(cacheRef, {
        generation: next,
        rankFieldId: Option.none(),
        projectKeys: null,
        tokenRead: !(read.type === "invalid" && read.kind === "auth"),
      });
      switch (read.type) {
        case "none":
          yield* publishStatus({ ...DISCONNECTED, siteUrl: read.siteUrl });
          yield* publishScale(DEFAULT_TICKET_PRIORITY_SCALE);
          break;
        case "invalid":
          yield* publishStatus({
            state: "error",
            siteUrl: read.siteUrl,
            accountName: null,
            error: { kind: read.kind, message: read.message, since: now },
          });
          yield* publishScale(DEFAULT_TICKET_PRIORITY_SCALE);
          break;
        case "ready": {
          // Another site's priorities are not this one's; the same site keeps its scale across a reconnect.
          const previous = yield* Ref.get(statusRef);
          if (previous.siteUrl !== read.connection.siteUrl) {
            yield* publishScale(DEFAULT_TICKET_PRIORITY_SCALE);
          }
          yield* publishStatus({
            state: "connected",
            siteUrl: read.connection.siteUrl,
            accountName: null,
            error: null,
          });
          break;
        }
      }
      return next;
    }).pipe(statusLock.withPermits(1));
    if (read.type !== "ready") return;
    // The hour runs alongside each refresh, so refreshes start on a steady hourly cadence.
    return yield* Effect.forever(
      Effect.all(
        [
          Effect.sleep("1 hour"),
          refreshSite(generation, read.connection).pipe(Effect.ignoreCause({ log: true })),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
  });

  // Subscribe before the first read, so a save between the read and the subscription is not lost.
  const settingsChanges = yield* settingsService.subscribeChanges;
  yield* Stream.concat(
    Stream.fromEffect(
      settingsService.getSettings.pipe(Effect.orElseSucceed((): ServerSettings | null => null)),
    ),
    settingsChanges,
  ).pipe(
    Stream.map((settings) => settings?.jira ?? null),
    // A reconnect only when what Jira sees changes; the token compares raw (literal or reference).
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    Stream.merge(Stream.fromQueue(reconnects).pipe(Stream.mapEffect(() => savedJira))),
    Stream.switchMap((jira) => Stream.fromEffect(connect(jira))),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const fetchTickets = Effect.fn("JiraService.fetchTickets")(function* (
    keys: ReadonlyArray<ThreadTicketKey>,
  ) {
    const { connection, cache } = yield* readyConnection;
    const unique = [...new Set(keys)];
    const results = new Map<ThreadTicketKey, JiraTicketFetchResult>();
    if (unique.length === 0) return results as ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>;
    const { generation } = cache;
    let rankFieldId: string | null;
    if (Option.isSome(cache.rankFieldId)) {
      rankFieldId = cache.rankFieldId.value;
    } else {
      rankFieldId = yield* tracked(generation, readRankFieldId(connection));
      const discovered = rankFieldId;
      yield* updateCache(generation, (current) => ({
        ...current,
        rankFieldId: Option.some(discovered),
      }));
    }
    for (let start = 0; start < unique.length; start += MAX_KEYS_PER_REQUEST) {
      const chunk = unique.slice(start, start + MAX_KEYS_PER_REQUEST);
      const batch = yield* tracked(generation, fetchTicketBatch(connection, chunk, rankFieldId));
      for (const [key, result] of batch) results.set(key, result);
    }
    return results as ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>;
  });

  const projectKeys = Effect.gen(function* () {
    const { connection, cache } = yield* readyConnection;
    if (cache.projectKeys !== null) return cache.projectKeys;
    const keys = yield* tracked(cache.generation, readProjectKeys(connection));
    yield* updateCache(cache.generation, (current) => ({ ...current, projectKeys: keys }));
    return keys;
  }).pipe(Effect.withSpan("JiraService.projectKeys"));

  const testConnection = Effect.fn("JiraService.testConnection")(function* (
    input: JiraTestConnectionInput,
  ) {
    const saved = yield* savedJira;
    const settings = input.settings ?? saved;
    if (settings === null) {
      return {
        type: "failed",
        kind: "invalid_site",
        message: "Enter your Jira site URL.",
      } satisfies JiraTestConnectionResult;
    }
    const siteUrl = normalizeJiraSiteUrl(settings.siteUrl);
    if (siteUrl === null) {
      return {
        type: "failed",
        kind: "invalid_site",
        message: "Enter your Jira Cloud site, like https://your-team.atlassian.net.",
      } satisfies JiraTestConnectionResult;
    }
    const apiToken =
      settings.apiToken === "" || settings.apiToken === SECRET_REDACTED
        ? (saved?.apiToken ?? "")
        : settings.apiToken;
    if (apiToken === "") {
      return {
        type: "failed",
        kind: "auth",
        message: "Enter an API token.",
      } satisfies JiraTestConnectionResult;
    }
    const token = yield* requireSettingsSecret(secrets, apiToken).pipe(Effect.result);
    if (token._tag === "Failure" || token.success === "") {
      return {
        type: "failed",
        kind: "auth",
        message: token._tag === "Failure" ? token.failure.message : UNREADABLE_TOKEN,
      } satisfies JiraTestConnectionResult;
    }
    const connection = { siteUrl, email: settings.email, apiToken: token.success };
    const { generation, tokenRead } = yield* Ref.get(cacheRef);
    const result = yield* Effect.all([
      readAccountName(connection),
      readPriorityScale(connection),
    ]).pipe(withHttp, Effect.result);
    if (result._tag === "Failure") {
      const error = result.failure;
      return {
        type: "failed",
        kind:
          error._tag === "JiraAuthError"
            ? "auth"
            : error._tag === "JiraUnavailableError"
              ? "unavailable"
              : "response",
        message: error.message,
      } satisfies JiraTestConnectionResult;
    }
    const [accountName, priorityScale] = result.success;
    // A passing test of the saved settings ends an auth pause without waiting for the hourly refresh.
    if (input.settings === undefined && (yield* readConnection).type === "ready") {
      if (tokenRead) {
        yield* record(generation, { type: "success", accountName });
        yield* whenCurrent(generation, publishScale(priorityScale));
      } else {
        yield* Queue.offer(reconnects, undefined);
      }
    }
    return { type: "connected", accountName, priorityScale } satisfies JiraTestConnectionResult;
  });

  return {
    isConfigured: readConnection.pipe(Effect.map((read) => read.type === "ready")),
    status: Ref.get(statusRef),
    streamStatus: stateStream(statusRef, statusChanges),
    priorityScale: Ref.get(scaleRef),
    streamPriorityScale: stateStream(scaleRef, scaleChanges),
    browseUrl: (key) =>
      savedJira.pipe(
        Effect.map((jira) => {
          const siteUrl = jira === null ? null : normalizeJiraSiteUrl(jira.siteUrl);
          return siteUrl === null ? null : jiraBrowseUrl(siteUrl, key);
        }),
      ),
    projectKeys,
    fetchTickets,
    testConnection,
  } satisfies JiraService["Service"];
});

export const layer = Layer.effect(JiraService, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);
