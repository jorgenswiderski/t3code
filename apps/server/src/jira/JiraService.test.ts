import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TICKET_PRIORITY_SCALE,
  type JiraConnectionStatus,
  type PriorityRef,
  ThreadTicketKey,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { FetchHttpClient, type HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  fetchTicketBatch,
  type JiraConnection,
  readAccountName,
  readPriorityScale,
  readRankFieldId,
  RANK_FIELD_TYPE,
} from "./jiraApi.ts";
import { JiraService, make } from "./JiraService.ts";
import {
  FAKE_RANK_FIELD_ID,
  type FakeJira,
  type FakeJiraResponse,
  makeFakeJira,
} from "./testing/FakeJiraHttp.ts";

const connection: JiraConnection = {
  siteUrl: "https://acme.atlassian.net",
  email: "me@example.com",
  apiToken: "s3cr3t-api",
};
const basicAuth = `Basic ${Buffer.from("me@example.com:s3cr3t-api").toString("base64")}`;
const key = (value: string) => ThreadTicketKey.make(value);

const withFake =
  (fake: FakeJira) =>
  <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fake.fetch),
    );

describe("jiraApi", () => {
  it.effect("sends basic auth, asks for JSON and refuses redirects", () =>
    Effect.gen(function* () {
      const fake = makeFakeJira();
      assert.equal(yield* withFake(fake)(readAccountName(connection)), "Ada Lovelace");
      assert.deepEqual(
        fake.requests.map(({ path, authorization, redirect }) => ({
          path,
          authorization,
          redirect,
        })),
        [{ path: "/rest/api/3/myself", authorization: basicAuth, redirect: "error" }],
      );
      assert.include(fake.requests[0]?.accept ?? "", "application/json");
    }),
  );

  it.effect.each<{ name: string; response: FakeJiraResponse; expected: Record<string, unknown> }>([
    {
      name: "401",
      response: { status: 401 },
      expected: {
        _tag: "JiraAuthError",
        status: 401,
        message: "Jira rejected the email or API token (401).",
      },
    },
    {
      name: "403",
      response: { status: 403 },
      expected: {
        _tag: "JiraAuthError",
        status: 403,
        message: "Jira refused access for this account (403).",
      },
    },
    {
      name: "429",
      response: { status: 429, headers: { "retry-after": "7" } },
      expected: {
        _tag: "JiraUnavailableError",
        message: "Jira is rate-limiting requests (429).",
        retryAfterMs: 7000,
      },
    },
    {
      name: "500",
      response: { status: 500 },
      expected: { _tag: "JiraUnavailableError", message: "Jira returned HTTP 500." },
    },
    {
      name: "a network failure",
      response: { type: "network-error" },
      expected: { _tag: "JiraUnavailableError", message: "Couldn't reach Jira." },
    },
    {
      name: "404",
      response: { status: 404 },
      expected: { _tag: "JiraResponseError", message: "Jira returned HTTP 404." },
    },
    {
      name: "an undecodable body",
      response: { status: 200, body: { unexpected: true } },
      expected: {
        _tag: "JiraResponseError",
        message: "Jira returned a reply T3 Code couldn't read.",
      },
    },
  ])("maps $name to a fixed error", ({ response, expected }) =>
    Effect.gen(function* () {
      const fake = makeFakeJira();
      fake.failNext("/rest/api/3/myself", response);
      const error = yield* withFake(fake)(readAccountName(connection)).pipe(Effect.flip);
      assert.deepInclude(error, expected);
      assert.notInclude(JSON.stringify(error), "s3cr3t-api");
    }),
  );

  it.effect("reads every page of priorities in site order", () =>
    Effect.gen(function* () {
      const priorities = Array.from({ length: 150 }, (_, index) => ({
        id: String(index + 1),
        name: `P${index + 1}`,
      }));
      const fake = makeFakeJira({ priorities });
      assert.deepEqual(yield* withFake(fake)(readPriorityScale(connection)), priorities);
      assert.equal(fake.requests.length, 2);
    }),
  );

  it.effect("falls back to the default scale when the site lists no priorities", () =>
    Effect.gen(function* () {
      const fake = makeFakeJira({ priorities: [] });
      assert.deepEqual(
        yield* withFake(fake)(readPriorityScale(connection)),
        DEFAULT_TICKET_PRIORITY_SCALE,
      );
    }),
  );

  it.effect("prefers the lexo-rank field named Rank", () =>
    Effect.gen(function* () {
      const rank = { custom: RANK_FIELD_TYPE };
      const fake = makeFakeJira({
        fields: [
          { id: "customfield_1", name: "Rank (Obsolete)", schema: rank },
          { id: "customfield_2", name: "Rank", schema: rank },
        ],
      });
      assert.equal(yield* withFake(fake)(readRankFieldId(connection)), "customfield_2");
      fake.state.fields = [{ id: "summary", name: "Summary" }];
      assert.isNull(yield* withFake(fake)(readRankFieldId(connection)));
    }),
  );

  it.effect("maps a batch to one result per key, missing keys as not_found", () =>
    Effect.gen(function* () {
      const fake = makeFakeJira();
      fake.state.issues.set("AB-1", {
        summary: "Fix login",
        statusName: "Triage",
        statusCategoryKey: "undefined",
        priority: { id: "2", name: " High " },
        rank: "0|i0000:",
      });
      fake.state.issues.set("AB-3", {
        summary: null,
        statusName: "Done",
        statusCategoryKey: "done",
        priority: null,
        rank: null,
      });
      const results = yield* withFake(fake)(
        fetchTicketBatch(
          connection,
          [key("AB-1"), key("AB-2"), key("BC-9"), key("AB-3")],
          FAKE_RANK_FIELD_ID,
        ),
      );
      assert.deepEqual(Object.fromEntries(results), {
        "AB-1": {
          type: "found",
          snapshot: {
            title: "Fix login",
            statusName: "Triage",
            statusCategory: "new",
            priority: { id: "2", name: "High" },
            rank: "0|i0000:",
          },
        },
        "AB-2": { type: "unreachable", syncError: "not_found" },
        "BC-9": { type: "unreachable", syncError: "not_found" },
        "AB-3": {
          type: "found",
          snapshot: {
            title: "",
            statusName: "Done",
            statusCategory: "done",
            priority: null,
            rank: null,
          },
        },
      });
      assert.deepEqual(fake.requests[0]?.body, {
        issueIdsOrKeys: ["AB-1", "AB-2", "BC-9", "AB-3"],
        fields: ["summary", "status", "priority", FAKE_RANK_FIELD_ID],
        fieldsByKeys: false,
      });
    }),
  );
});

const settingsLayer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-jira-service-test-" })),
  ),
);

const jiraLayer = (fake: FakeJira) =>
  Layer.effect(JiraService, make).pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fake.fetch)),
  );

const savedJira = {
  siteUrl: "https://acme.atlassian.net",
  email: "me@example.com",
  apiToken: "s3cr3t-api",
} as const;
const SITE_PRIORITIES: ReadonlyArray<PriorityRef> = [
  { id: "1", name: "Highest" },
  { id: "2", name: "High" },
  { id: "3", name: "Medium" },
  { id: "4", name: "Low" },
  { id: "5", name: "Lowest" },
];
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Collects each stream's emissions so a test can await the next one or prove there was none. */
const watch = Effect.fn(function* () {
  const jira = yield* JiraService;
  const statuses = yield* Queue.unbounded<JiraConnectionStatus>();
  const scales = yield* Queue.unbounded<ReadonlyArray<PriorityRef>>();
  yield* jira.streamStatus.pipe(
    Stream.runForEach((status) => Queue.offer(statuses, status)),
    Effect.forkScoped,
  );
  yield* jira.streamPriorityScale.pipe(
    Stream.runForEach((scale) => Queue.offer(scales, scale)),
    Effect.forkScoped,
  );
  const until = <A>(queue: Queue.Queue<A>, done: (value: A) => boolean) =>
    Effect.gen(function* () {
      for (;;) {
        const value = yield* Queue.take(queue);
        if (done(value)) return value;
      }
    });
  return {
    statuses,
    scales,
    untilStatus: (done: (status: JiraConnectionStatus) => boolean) => until(statuses, done),
    untilScale: (done: (scale: ReadonlyArray<PriorityRef>) => boolean) => until(scales, done),
  };
});

const connectHealthy = Effect.fn(function* (fake: FakeJira) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const watcher = yield* watch();
  yield* settings.updateSettings({ jira: savedJira });
  yield* watcher.untilStatus((status) => status.accountName === "Ada Lovelace");
  yield* watcher.untilScale((scale) => scale[0]?.id === "1");
  yield* fake.untilRequests(4);
  return watcher;
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("JiraService", (it) => {
  it.effect("does nothing while Jira is not configured", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      assert.equal((yield* jira.status).state, "disconnected");
      assert.deepEqual(yield* jira.priorityScale, DEFAULT_TICKET_PRIORITY_SCALE);
      assert.isFalse(yield* jira.isConfigured);
      assert.isNull(yield* jira.browseUrl(key("PROJ-1")));
      const error = yield* jira.fetchTickets([key("PROJ-1")]).pipe(Effect.flip);
      assert.equal(error._tag, "JiraNotConfiguredError");
      assert.lengthOf(fake.requests, 0);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("connects with four reads and refreshes hourly without re-emitting", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const watcher = yield* connectHealthy(fake);
      assert.deepEqual(
        fake.requests.map((request) => request.path),
        [
          "/rest/api/3/myself",
          "/rest/api/3/priority/search",
          "/rest/api/3/project/search",
          "/rest/api/3/field",
        ],
      );
      assert.deepEqual(yield* jira.status, {
        state: "connected",
        siteUrl: "https://acme.atlassian.net",
        accountName: "Ada Lovelace",
        error: null,
      });
      assert.deepEqual(yield* jira.priorityScale, SITE_PRIORITIES);
      assert.isTrue(yield* jira.isConfigured);
      assert.equal(
        yield* jira.browseUrl(key("PROJ-1")),
        "https://acme.atlassian.net/browse/PROJ-1",
      );

      yield* TestClock.adjust("1 hour");
      // The project read follows the account and priority reads, so both were recorded by then.
      yield* fake.untilRequests(7);
      assert.equal(fake.requests[4]?.path, "/rest/api/3/myself");
      assert.equal(yield* Queue.size(watcher.statuses), 0);
      assert.equal(yield* Queue.size(watcher.scales), 0);

      fake.state.priorities = [...SITE_PRIORITIES].reverse();
      yield* TestClock.adjust("1 hour");
      assert.deepEqual(yield* Queue.take(watcher.scales), [...SITE_PRIORITIES].reverse());
      yield* fake.untilRequests(10);
      assert.equal(yield* Queue.size(watcher.scales), 0);
      assert.equal(yield* Queue.size(watcher.statuses), 0);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("pauses ticket reads after an auth failure until the hourly re-check", () => {
    const fake = makeFakeJira();
    fake.failNext("/rest/api/3/myself", { status: 401 });
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const watcher = yield* watch();
      const since = yield* nowIso;
      yield* settings.updateSettings({ jira: savedJira });
      const failed = yield* watcher.untilStatus((status) => status.state === "error");
      assert.deepEqual(failed.error, {
        kind: "auth",
        message: "Jira rejected the email or API token (401).",
        since,
      });
      assert.deepEqual(yield* jira.priorityScale, DEFAULT_TICKET_PRIORITY_SCALE);

      const requestsBefore = fake.requests.length;
      const paused = yield* jira.fetchTickets([key("PROJ-1")]).pipe(Effect.flip);
      assert.equal(paused._tag, "JiraAuthError");
      assert.equal((yield* jira.projectKeys.pipe(Effect.flip))._tag, "JiraAuthError");
      assert.lengthOf(fake.requests, requestsBefore);

      yield* TestClock.adjust("1 hour");
      yield* watcher.untilStatus((status) => status.state === "connected");
      const results = yield* jira.fetchTickets([key("PROJ-1")]);
      assert.deepEqual(results.get(key("PROJ-1")), {
        type: "unreachable",
        syncError: "not_found",
      });
      assert.equal(fake.requests.at(-1)?.path, "/rest/api/3/issue/bulkfetch");
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("ends an auth pause when a test of the saved settings passes", () => {
    const fake = makeFakeJira();
    fake.failNext("/rest/api/3/myself", { status: 401 });
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const watcher = yield* watch();
      yield* settings.updateSettings({ jira: savedJira });
      yield* watcher.untilStatus((status) => status.state === "error");
      const result = yield* jira.testConnection({});
      assert.equal(result.type, "connected");
      assert.deepEqual(yield* jira.status, {
        state: "connected",
        siteUrl: "https://acme.atlassian.net",
        accountName: "Ada Lovelace",
        error: null,
      });
      yield* jira.fetchTickets([key("PROJ-1")]);
      assert.equal(fake.requests.at(-1)?.path, "/rest/api/3/issue/bulkfetch");
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("keeps the first error time while the same outage persists", () => {
    const fake = makeFakeJira();
    fake.failNext("/rest/api/3/myself", { status: 500 });
    fake.failNext("/rest/api/3/project/search", { status: 500 });
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const watcher = yield* watch();
      const since = yield* nowIso;
      yield* settings.updateSettings({ jira: savedJira });
      const failed = yield* watcher.untilStatus((status) => status.state === "error");
      assert.equal(failed.error?.since, since);

      yield* TestClock.adjust("1 minute");
      const error = yield* jira.projectKeys.pipe(Effect.flip);
      assert.equal(error._tag, "JiraUnavailableError");
      assert.deepEqual(yield* jira.status, failed);
      assert.equal(yield* Queue.size(watcher.statuses), 0);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("ignores a reply from a connection that settings have since replaced", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const watcher = yield* connectHealthy(fake);
      const hold = fake.holdNext("/rest/api/3/issue/bulkfetch", { status: 401 });
      const stale = yield* jira.fetchTickets([key("PROJ-1")]).pipe(Effect.forkScoped);
      yield* hold.arrived;

      yield* settings.updateSettings({ jira: { ...savedJira, email: "other@example.com" } });
      yield* watcher.untilStatus((status) => status.accountName === null);
      yield* watcher.untilStatus((status) => status.accountName === "Ada Lovelace");
      yield* hold.release;
      const staleError = yield* Fiber.join(stale).pipe(Effect.flip);
      assert.equal(staleError._tag, "JiraAuthError");

      assert.equal((yield* jira.status).state, "connected");
      const requestsBefore = fake.requests.length;
      yield* jira.fetchTickets([key("PROJ-1")]);
      assert.isAbove(fake.requests.length, requestsBefore);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("reads tickets in batches of at most 100 distinct keys", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      yield* connectHealthy(fake);
      const keys = Array.from({ length: 150 }, (_, index) => key(`PROJ-${index + 1}`));
      const results = yield* jira.fetchTickets([...keys, ...keys.slice(0, 20)]);
      assert.equal(results.size, 150);
      const batches = fake.requests
        .filter((request) => request.path === "/rest/api/3/issue/bulkfetch")
        .map(
          (request) => (request.body as { issueIdsOrKeys: Array<string> }).issueIdsOrKeys.length,
        );
      assert.deepEqual(batches, [100, 50]);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("disconnects, restores the default scale and stops refreshing", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const watcher = yield* connectHealthy(fake);
      yield* settings.updateSettings({ jira: null });
      yield* watcher.untilStatus((status) => status.state === "disconnected");
      yield* watcher.untilScale((scale) => scale === DEFAULT_TICKET_PRIORITY_SCALE);
      const requestsBefore = fake.requests.length;
      yield* TestClock.adjust("2 hours");
      assert.lengthOf(fake.requests, requestsBefore);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("tests unsaved settings with the saved token without touching the status", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      yield* connectHealthy(fake);
      const before = yield* jira.status;
      fake.state.accountName = "Grace Hopper";
      const result = yield* jira.testConnection({
        settings: { ...savedJira, siteUrl: "acme.atlassian.net", apiToken: SECRET_REDACTED },
      });
      assert.deepEqual(result, {
        type: "connected",
        accountName: "Grace Hopper",
        priorityScale: SITE_PRIORITIES,
      });
      assert.equal(fake.requests.at(-1)?.authorization, basicAuth);
      assert.deepEqual(yield* jira.status, before);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });

  it.effect("refuses to test a site that is not https without a request", () => {
    const fake = makeFakeJira();
    return Effect.gen(function* () {
      const jira = yield* JiraService;
      const result = yield* jira.testConnection({
        settings: { siteUrl: "http://x", email: "me@example.com", apiToken: "tok" },
      });
      assert.equal(result.type === "failed" ? result.kind : result.type, "invalid_site");
      assert.lengthOf(fake.requests, 0);
    }).pipe(Effect.provide(jiraLayer(fake)), Effect.scoped);
  });
});
