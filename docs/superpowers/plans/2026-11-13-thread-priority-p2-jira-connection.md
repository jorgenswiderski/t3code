# Thread priority P2: Jira connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each environment can connect to one Jira Cloud site (site URL, email, API token). The token is stored as a settings secret and never reaches a client. A server `JiraService` owns all Jira HTTP: priority scale, rank field, project keys, batched ticket reads, connection test and connection status. The scale and status reach clients through `ServerConfig` and a gated late-update event. Web and desktop get a Settings section to connect, test, disconnect and see errors.

**Architecture:** The contracts are a new `packages/contracts/src/jira.ts` plus `ServerSettings.jira` / `ServerSettingsPatch.jira`, two optional `ServerConfig` fields, one stream event, and one RPC. For secrets, `jira.apiToken` is registered in `mapSecretFieldGroups`, the function behind `mapSettingsSecrets` and `mapSettingsSecretValues`. Persistence to the secret store, materialization, stale-secret cleanup and `redactServerSettingsForClient` all work through those two functions, so this one registration covers every path. The service is `JiraService` (`Context.Service`), built on the `UsageLimitSources` pattern: Ref + PubSub state, a stream over settings changes that (re)connects, and an hourly refresh loop. `ws.ts` puts the scale and status in every config snapshot. It sends `ticketTrackerUpdated` only to subscribers that opt in, and folds that event into late discovery snapshots. Client-runtime projects the event onto the config.

**Tech Stack:** TypeScript, Effect v4 (`effect/Schema`, `effect/http` `HttpClient`, `Ref`, `PubSub`, `Stream`), `@effect/vitest` via `vp test run`, React (web settings).

**Spec:** `docs/superpowers/specs/2026-11-13-thread-priority-design.md`, section "Jira connection (server)". **Contract:** `docs/superpowers/plans/2026-11-13-thread-priority-index.md`: §1 "P2", §4 D3/D6, §6.6, §6.7, §6.8, §6.10, §6.11, §6.13, §7, §8, §9. Read both first. Where this plan says "contract §x", the contract text is binding and this plan only adds detail.

**Detail level:** targeted. Exact code appears only where the code is the decision: contracts, secret registration, Jira REST usage, the status transition, the config stream, and the projection. Everything else is given as interface plus prose.

## Global Constraints

- Contract shapes are verbatim from §6.6–§6.8. Names are pinned: `JiraService`, `JiraSettings`, `JiraConnectionStatus`, `JiraTestConnectionInput`, `JiraTestConnectionResult`, `ticketPriorityScale`, `jiraStatus`, `ticketTrackerUpdated`, `ticketTracker`, `server.testJiraConnection`, `testJiraConnection`, `jira-api-token`, `jira-connection`.
- **Token invariant:** the API token never leaves the server in plain text. That covers `ServerConfig.settings`, `settingsUpdated`, the `server.updateSettings` reply, `server.getConfig`, logs, error messages and the `JiraConnectionStatus` text. Clients see only `""` (none saved), `SECRET_REDACTED` (saved), or a secret-provider reference object (a reference is not secret).
- **T3 never writes to Jira.** Only `GET`, plus the read-only `POST /rest/api/3/issue/bulkfetch` (or `search/jql`, see Task 3).
- Every Jira request sets `redirect: "error"`, because a redirect could carry the Basic credential to another origin. It also sets `HttpClient.TracerPropagationEnabled` to false (as `textGeneratorDrivers.ts` does).
- No sync work and no requests while Jira is not configured. One connect costs four GETs: `myself`, `priority/search` (paged), `field`, `project/search` (paged). After that, one refresh group per hour, plus whatever `fetchTickets` P3 asks for.
- `status` and `priorityScale` publish only when their content changes. Error messages are fixed strings chosen from (kind, HTTP status), with no timestamps or request ids, so a persistent error never re-emits.
- `testConnection` never changes settings or `status`.
- Repo rules (AGENTS.md): targeted checks only (`vp test run <files>`, per-package typecheck, `vp run check:changed`), never repo-wide. No sleeps or polling in tests; use `TestClock` for the hourly refresh. Inferred types. No low-value comments. Subagents do not start dev servers. Do not commit plans or scratch files. Do not push.

## Review Focus

These are failure modes no obvious test exercises. Each has its test in the task named in brackets.

1. **Token leak through a path that bypasses `mapSettingsSecrets`.** Every client-bound settings object must pass `redactServerSettingsForClient`. The snapshot test asserts that the raw token string appears nowhere in the serialized `subscribeServerConfig` snapshot or in a `settingsUpdated` event. [Tasks 2, 6]
2. **Patch with the token omitted or redacted wipes the stored token.** `ServerSettingsPatch.jira` omits `apiToken` when the user edits only the site or email. `deepMerge` keeps the saved (stored-form) `apiToken` in that case, and an echoed `SECRET_REDACTED` is kept by `persistSettingsSecrets`; a future refactor that replaces `jira` wholesale would turn the missing token into `""` and delete the secret. The patch table pins this. [Tasks 1, 2]
3. **Disconnect leaves the secret on disk.** `jira: null` must remove `jira-api-token` from the secret store. This is the existing "remove-stale-secret" path; the test proves the registration reaches it. [Task 2]
4. **Late discovery snapshot rolls back Jira state.** `withLateConfigDiscovery` resends whole snapshots. Without a `ticketTrackerUpdated` case it would resend the initial `jiraStatus`/scale after a change was already sent. [Task 6]
5. **Stale request from an old connection overwrites a new connection's status.** Outcomes are tagged with a connection generation and ignored when stale. [Task 4]
6. **Repeated 401s lock the Atlassian account.** P3 sweeps every 2 minutes. While `status.error.kind === "auth"`, `fetchTickets` and `projectKeys` fail fast without a request until the hourly re-check or a settings change. [Task 4]
7. **Unknown or invisible keys fail the whole batch.** `fetchTickets` must return per-key `not_found` and never turn one deleted ticket into a sync outage (contract Q2). [Task 3]
8. **Old clients lose their config subscription.** `ticketTrackerUpdated` is sent only with `ticketTracker: true` (D3). [Task 6]

---

## Implementation Location
- **Branch:** feat/thread-priority-p2
- **Worktree:** /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p2
- **Base branch:** feat/thread-priority

Create the worktree only after **P1-contract** has merged into `feat/thread-priority` (contract §3: `P2 <- [P1:P1-contract]`). Use the `git-tools:worktree` skill, or the equivalent from `/home/lima/workspace/t3code`:

```sh
git worktree add -b feat/thread-priority-p2 /home/lima/workspace/t3code/.claude/worktrees/feat+thread-priority-p2 feat/thread-priority
```

Then follow AGENTS.md "Dev servers": wait while `.t3/setup-running` names a live PID. If no marker ever appears, run `vp i` in the new worktree. Before starting, check that `packages/contracts/src/threadTicket.ts` (with `PriorityRef` and `DEFAULT_TICKET_PRIORITY_SCALE`) and `ExecutionEnvironmentCapabilities.threadTickets` exist.

If `feat/thread-priority` moves (P1 merges) before P2 merges, rebase this branch onto it (`git rebase feat/thread-priority`); never merge the integration branch in. `apps/server/src/server.ts` will need a rebase over P1's `ThreadTicketService.layer` hunk (contract §9). The branch is local with no upstream, so rebasing needs no permission.

## File Structure

| File | Change |
| --- | --- |
| `packages/contracts/src/jira.ts` | **new**: Jira schemas, `normalizeJiraSiteUrl`, `JiraSiteUrl` |
| `packages/contracts/src/jira.test.ts` | **new**: site URL table, secret field, decode defaults |
| `packages/contracts/src/index.ts` | `export * from "./jira.ts"` (after P1's `threadTicket.ts` line) |
| `packages/contracts/src/settings.ts` | `ServerSettings.jira`, `ServerSettingsPatch.jira` |
| `packages/contracts/src/server.ts` | `ServerConfig.ticketPriorityScale`, `ServerConfig.jiraStatus`, `ServerConfigStreamTicketTrackerUpdatedEvent` in `ServerConfigStreamEvent` |
| `packages/contracts/src/rpc.ts` | `WS_METHODS.serverTestJiraConnection`, `WsServerTestJiraConnectionRpc`, group entry; `ticketTracker` on `WsSubscribeServerConfigRpc` payload |
| `packages/contracts/src/clientRpcPermissions.ts` | `[WS_METHODS.serverTestJiraConnection]: AuthSettingsWriteScope` |
| `packages/shared/src/serverSettings.test.ts` | `applyServerSettingsPatch` table for `jira` (no source change expected; see 1.3) |
| `apps/server/src/settingsSecrets.ts` | register `jira.apiToken` in `mapSecretFieldGroups` |
| `apps/server/src/sourceControl/sourceControlHostSecrets.ts` | `invalidateSettingsSecrets` includes the Jira reference |
| `apps/server/src/serverSettings.test.ts` | Jira secret store / redaction / disconnect test |
| `apps/server/src/jira/JiraService.ts` | **new**: service, errors, layer |
| `apps/server/src/jira/jiraApi.ts` | **new**: pure request builders, response schemas, `sendJira`, snapshot extraction |
| `apps/server/src/jira/JiraService.test.ts` | **new** |
| `apps/server/src/jira/testing/FakeJiraHttp.ts` | **new**: fake Jira site (contract §7) |
| `apps/server/src/jira/testing/JiraServiceTest.ts` | **new**: `makeTestJiraService` double (contract §7) |
| `apps/server/src/server.ts` | provide `JiraService.layer` |
| `apps/server/src/ws.ts` | config fields, `ticketTrackerUpdated` stream, late-discovery fold, `server.testJiraConnection` handler |
| `apps/server/src/observability/RpcInstrumentation.ts` | `[WS_METHODS.serverTestJiraConnection]: "server"` |
| `apps/server/src/ws.test.ts`, `apps/server/src/auth/RpcAuthorization.test.ts` | extend |
| `packages/client-runtime/src/rpc/session.ts` (+ test) | `ticketTracker` option forwarded |
| `packages/client-runtime/src/state/server.ts` (+ test) | `ticketTracker` subscription option; `testJiraConnection` command |
| `packages/client-runtime/src/state/serverConfigProjection.ts` (+ test) | apply `ticketTrackerUpdated` |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | extend the OTLP case to a table |
| `apps/web/src/connection/runtime.ts`, `apps/web/src/state/server.ts`, `apps/mobile/src/connection/runtime.ts`, `apps/mobile/src/state/server.ts` | opt in `ticketTracker: true` |
| `apps/web/src/components/settings/JiraSettings.tsx` (+ `JiraSettings.logic.ts`, `.logic.test.ts`) | **new**: Settings section |
| `apps/web/src/components/settings/SourceControlSettings.tsx` | mount `<JiraSettingsSection />` |
| `apps/web/src/components/settings/settingsSearch.ts` | `jira-connection` entry |
| `apps/web/src/components/settings/SecretsSettings.logic.ts` (+ test) | list Jira as a secret-provider use |

---

## Task 1: Contracts

**Files:** `packages/contracts/src/jira.ts` (new), `jira.test.ts` (new), `index.ts`, `settings.ts`, `server.ts`, `rpc.ts`, `clientRpcPermissions.ts`, `packages/shared/src/serverSettings.test.ts`.

- [ ] **1.1 `jira.ts`.** Exact content (the schemas are the contract):

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { PriorityRef } from "./threadTicket.ts";

/** The site's https origin; a bare host gets https, and any path (a pasted board URL) is dropped. */
export function normalizeJiraSiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export const JiraSiteUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => normalizeJiraSiteUrl(value) === value),
);

export const JiraSettings = Schema.Struct({
  // Stored leniently so an odd saved value cannot fail the whole settings file; JiraService normalizes.
  siteUrl: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  /** `secretSetting` from settings.ts, which imports this module. */
  apiToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
});
export type JiraSettings = typeof JiraSettings.Type;

export const JiraErrorKind = Schema.Literals(["auth", "unavailable", "response"]);
export type JiraErrorKind = typeof JiraErrorKind.Type;

export const JiraConnectionStatus = Schema.Struct({
  state: Schema.Literals(["disconnected", "connected", "error"]),
  siteUrl: Schema.NullOr(TrimmedNonEmptyString),
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(
    Schema.Struct({ kind: JiraErrorKind, message: Schema.String, since: IsoDateTime }),
  ),
});
export type JiraConnectionStatus = typeof JiraConnectionStatus.Type;

/** Unsaved settings to test; an empty or redacted token uses the saved one. */
export const JiraTestConnectionInput = Schema.Struct({ settings: Schema.optional(JiraSettings) });
export type JiraTestConnectionInput = typeof JiraTestConnectionInput.Type;

export const JiraTestConnectionResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    accountName: TrimmedNonEmptyString,
    priorityScale: Schema.Array(PriorityRef),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    kind: Schema.Literals(["auth", "unavailable", "response", "invalid_site"]),
    message: Schema.String,
  }),
]);
export type JiraTestConnectionResult = typeof JiraTestConnectionResult.Type;
```

Verify the `Schema.makeFilter`/`.check` call shape against `TextGeneratorBaseUrl` in `settings.ts` (~L947), which uses the same form.

- [ ] **1.2 `settings.ts`.** Import `JiraSettings` and `JiraSiteUrl` from `./jira.ts`. Then:

```ts
// ServerSettings, after textGenerators:
jira: Schema.NullOr(JiraSettings).pipe(Schema.withDecodingDefault(Effect.succeed(null))),

// ServerSettingsPatch, after textGenerators:
// null disconnects; an omitted or redacted apiToken keeps the saved one.
jira: Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      siteUrl: JiraSiteUrl,
      email: TrimmedNonEmptyString,
      apiToken: Schema.optionalKey(SettingsSecretValue),
    }),
  ),
),
```

`requiredScopesForServerSettingsPatch` needs no change, because `jira` falls into the default branch, which is `AuthSettingsWriteScope`. Check that `DEFAULT_SERVER_SETTINGS` (decoded from `{}`) gets `jira: null`.

- [ ] **1.3 `applyServerSettingsPatch`** (`packages/shared/src/serverSettings.ts` ~L383): **no source change expected.** `jira` goes through the generic `deepMerge` (`packages/shared/src/Struct.ts`), which already does the right thing. A saved object merged with `{ siteUrl, email }` keeps the saved `apiToken`. A patch with `apiToken` replaces it. `null` replaces the object. With no saved Jira, the patch object is taken as is, so a missing `apiToken` decodes to `""` on normalization. In `updateAndPersistSettings` the saved value is the stored form (`SECRET_REDACTED` or a reference), and `persistSettingsSecrets` keeps the stored secret for it. The table test in 1.7 pins this behaviour. Add an explicit `jira` case beside `textGenerators: textGeneratorsPatch` only if a row of that table fails.

- [ ] **1.4 `server.ts`.** `ServerConfig` gains these fields (after `usageLimitSources`):

```ts
  /** The environment's ticket priority scale, highest first; Jira's default five when not connected. */
  ticketPriorityScale: Schema.optionalKey(Schema.Array(PriorityRef)),
  jiraStatus: Schema.optionalKey(JiraConnectionStatus),
```

The new event joins `ServerConfigStreamEvent`:

```ts
export const ServerConfigTicketTrackerUpdatedPayload = Schema.Struct({
  ticketPriorityScale: Schema.Array(PriorityRef),
  jiraStatus: JiraConnectionStatus,
});
export const ServerConfigStreamTicketTrackerUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("ticketTrackerUpdated"),
  payload: ServerConfigTicketTrackerUpdatedPayload,
});
```

Export the `Type` aliases the same way the neighbouring `usageLimitSourcesUpdated` schemas do.

- [ ] **1.5 `rpc.ts`.** Add `serverTestJiraConnection: "server.testJiraConnection"` to `WS_METHODS`, beside `serverListTextGeneratorModels` (~L544). Then define:

```ts
const WsServerTestJiraConnectionRpc = Rpc.make(WS_METHODS.serverTestJiraConnection, {
  payload: JiraTestConnectionInput,
  success: JiraTestConnectionResult,
  error: EnvironmentAuthorizationError,
});
```

Add it to the group list beside `WsServerListTextGeneratorModelsRpc` (~L2122). In the `WsSubscribeServerConfigRpc` payload (~L1955), add `ticketTracker: Schema.optional(Schema.Boolean)` with a one-line comment: "Opt-in protects older clients that reject unknown event types."

- [ ] **1.6 `clientRpcPermissions.ts`.** Add the entry beside `serverListTextGeneratorModels`:

```ts
  // Testing spends the stored Jira token, so only those who can change settings may.
  [WS_METHODS.serverTestJiraConnection]: AuthSettingsWriteScope,
```

- [ ] **1.7 Tests.**

`packages/contracts/src/jira.test.ts`, `normalizeJiraSiteUrl` table:

| input | expected |
| --- | --- |
| `"acme.atlassian.net"` | `"https://acme.atlassian.net"` |
| `" https://acme.atlassian.net/ "` | `"https://acme.atlassian.net"` |
| `"https://acme.atlassian.net/jira/software/projects/X/boards/1?selectedIssue=X-1"` | `"https://acme.atlassian.net"` |
| `"http://acme.atlassian.net"` | `null` |
| `"https://user:pw@acme.atlassian.net"` | `null` |
| `""`, `"   "`, `"not a url ::"` | `null` |

Also in `jira.test.ts`:

- `secretSettingsFields(JiraSettings)` equals `["apiToken"]`. This proves the `annotateKey` stands in for `secretSetting`.
- `Schema.decodeUnknownSync(ServerSettings)({}).jira === null`.
- `ServerConfig` decodes without `ticketPriorityScale`/`jiraStatus`. Put this row in an existing ServerConfig decode test if one fits.
- `JiraSiteUrl` rejects `"https://acme.atlassian.net/"` and accepts `"https://acme.atlassian.net"`.

In `packages/shared/src/serverSettings.test.ts`, add one `applyServerSettingsPatch` table:

| current.jira | patch.jira | result.jira |
| --- | --- | --- |
| `null` | `{ siteUrl, email }` | `{ siteUrl, email }` with no `apiToken` key (normalization decodes it to `""`) |
| `{ …, apiToken: SECRET_REDACTED_LITERAL }` | `{ siteUrl: other, email }` | `apiToken` unchanged |
| `{ …, apiToken: "old" }` | `{ siteUrl, email, apiToken: "new" }` | `apiToken: "new"` |
| `{ … }` | `null` | `null` |
| `{ … }` | omitted | unchanged |

`SECRET_REDACTED_LITERAL` is the literal `"••••••"`. The shared package cannot import the server constant.

- [ ] **1.8 Verify.**

```sh
vp test run packages/contracts/src/jira.test.ts packages/shared/src/serverSettings.test.ts
vp run @t3tools/contracts#typecheck
vp run @t3tools/shared#typecheck
```

Expected: pass. Commit: `feat(contracts): Jira connection settings, status and test RPC`.

## Task 2: Secret registration and redaction

**Files:** `apps/server/src/settingsSecrets.ts`, `apps/server/src/sourceControl/sourceControlHostSecrets.ts`, `apps/server/src/serverSettings.test.ts`, `apps/web/src/components/settings/SecretsSettings.logic.ts` (+ test).

How redaction works at `ddec2d528a`, verified in the code. Everything is keyed off one function, `mapSecretFieldGroups` (`settingsSecrets.ts`):

- `mapSettingsSecrets` (storage, materialization, stale cleanup, client redaction) and `mapSettingsSecretValues` (secret-provider references, echoed references, removed-provider cleanup) both walk the secret fields through `mapSecretFieldGroups`.
- `redactServerSettingsForClient` (`serverSettings.ts` ~L142) maps every sensitive value to `""` / `SECRET_REDACTED`.
- `ws.ts` calls `redactServerSettingsForClient` for the config snapshot (`loadServerConfig` ~L1916), the `server.updateSettings` reply (~L2729) and `settingsUpdated` (~L3417).
- `persistSettingsSecrets` moves inline values to the secret store and removes secrets whose slot disappeared ("remove-stale-secret").

A field that `mapSecretFieldGroups` does not visit would be stored in `settings.json` in plain text and sent to every client.

- [ ] **2.1 Register the field.** Exact code in `settingsSecrets.ts`:

```ts
import { JiraSettings /* …existing imports */ } from "@t3tools/contracts";
const jiraSecretFields = secretSettingsFields(JiraSettings);

// in mapSecretFieldGroups, before the return:
  const jira =
    settings.jira === null
      ? null
      : (mapFields(settings.jira, jiraSecretFields, () => "jira-api-token") as JiraSettings);

// in the returned object:
    jira,
```

The slot name ignores `serverHost` because `apiToken` is a single value and never a per-host record. The name is stable across releases.

- [ ] **2.2 `invalidateSettingsSecrets`.** Add `"jira"` to its `Pick<ServerSettings, …>` and add this to the reference list:

```ts
      ...(current.jira !== null && isSecretReference(current.jira.apiToken)
        ? [current.jira.apiToken]
        : []),
```

- [ ] **2.3 Web secret-provider uses.** In `SecretsSettings.logic.ts`, add `"jira"` to `SecretUseSettings` and push `{ id: "jira", label: "Jira" }` when `settings.jira?.apiToken` is a reference to `providerId`. Removing a secret provider then lists Jira as a reader. Add a row to the existing `it.each` in `SecretsSettings.logic.test.ts`.

- [ ] **2.4 Test** (`serverSettings.test.ts`, modeled on "keeps source control host secrets in the secret store and tells clients only that one is set", ~L1636). One `it.effect` that:
  1. Calls `updateSettings({ jira: { siteUrl: "https://acme.atlassian.net", email: "me@example.com", apiToken: "jira-secret-123" } })`. The returned (materialized) settings have `apiToken === "jira-secret-123"`.
  2. Checks that the raw settings file does not include `"jira-secret-123"` but does include `"me@example.com"`.
  3. Checks `redactServerSettingsForClient(saved, { secretReferences: true })`: `.jira.apiToken === SECRET_REDACTED`, `siteUrl`/`email` are visible, and `JSON.stringify(client)` does not include the token.
  4. Patches `{ jira: { siteUrl: "https://other.atlassian.net", email: "me@example.com" } }` (token omitted). `getSettings` still materializes `"jira-secret-123"`.
  5. Patches `{ jira: { ...client.jira } }` (echoing the redacted marker). The token is kept.
  6. Patches `{ jira: null }`. `getSettings().jira === null`, and `ServerSecretStore.get("jira-api-token")` is `Option.none()`.

- [ ] **2.5 Verify.**

```sh
vp test run apps/server/src/serverSettings.test.ts apps/web/src/components/settings/SecretsSettings.logic.test.ts
vp run t3#typecheck
```

Commit: `feat(server): store the Jira API token as a settings secret`.

## Task 3: Jira REST client and fake site

**Files:** `apps/server/src/jira/jiraApi.ts` (new), `apps/server/src/jira/testing/FakeJiraHttp.ts` (new), and the error classes in `apps/server/src/jira/JiraService.ts`.

- [ ] **3.0 Read-only probe (implementation time, before finalizing 3.3).** Get the site URL, email and API token from the user with `request_secret`. Never write them to a file in the repo, a log line, or a commit. From a scratch script in the session scratchpad, check these against the user's Jira Cloud site:

  - (a) `POST /rest/api/3/issue/bulkfetch` with one real key, one nonexistent key in a real project, and one key in a nonexistent project. Expected: HTTP 200, the real issue in `issues`, the others in `issueErrors` or simply absent.
  - (b) `POST /rest/api/3/search/jql` with the same keys. Expected per contract Q2: HTTP 400 for unknown keys.
  - (c) Whether `GET /rest/api/3/priority/search` returns priorities in the order shown in Jira admin → Priorities.
  - (d) That `GET /rest/api/3/field` lists exactly one field with `schema.custom === "com.pyxis.greenhopper.jira:gh-lexo-rank"`.

  Record the outcome (no secrets) in the PR/handoff. If (a) fails, use option (c) of contract Q2: search/jql, dropping keys named in a 400 `errorMessages` and retrying once. If (c) fails, use the older `GET /rest/api/3/priority` (unpaged, ordered) for the scale.

- [ ] **3.1 Errors** (in `JiraService.ts`, `Schema.TaggedError`, contract §6.7):

```ts
export class JiraNotConfiguredError extends Schema.TaggedError<JiraNotConfiguredError>()("JiraNotConfiguredError", {}) {}
export class JiraAuthError extends Schema.TaggedError<JiraAuthError>()("JiraAuthError", { status: Schema.Number, message: Schema.String }) {}
export class JiraUnavailableError extends Schema.TaggedError<JiraUnavailableError>()("JiraUnavailableError", { message: Schema.String, retryAfterMs: Schema.optional(Schema.Number) }) {}
export class JiraResponseError extends Schema.TaggedError<JiraResponseError>()("JiraResponseError", { message: Schema.String }) {}
export type JiraError = JiraNotConfiguredError | JiraAuthError | JiraUnavailableError | JiraResponseError;
export type JiraTicketFetchResult =
  | { readonly type: "found"; readonly snapshot: Omit<ThreadTicketSnapshot, "syncedAt"> }
  | { readonly type: "unreachable"; readonly syncError: ThreadTicketSyncError };
```

Keep the errors in `JiraService.ts` as the contract pins. `jiraApi.ts` imports them from there, and `JiraService.ts` imports `jiraApi.ts` functions. If that cycle trips knip or the linter, move the error classes to `jiraApi.ts` and re-export them from `JiraService.ts`. The names stay the same.

- [ ] **3.2 `sendJira`**, the one function every Jira request goes through. Exact behaviour:

```ts
const REQUEST_TIMEOUT = "20 seconds";

export interface JiraConnection {
  readonly siteUrl: string; // normalized origin
  readonly email: string;
  readonly apiToken: string; // literal, already resolved
}

export const sendJira = Effect.fn("Jira.send")(function* <S extends Schema.Decoder<unknown>>(
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
    return yield* new JiraAuthError({ status, message: "Jira rejected the email or API token (401)." });
  }
  if (status === 403) {
    return yield* new JiraAuthError({ status, message: "Jira refused access for this account (403)." });
  }
  if (status === 429) {
    const seconds = Number(response.headers["retry-after"]);
    return yield* new JiraUnavailableError({
      message: "Jira is rate-limiting requests (429).",
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.ceil(seconds * 1000) } : {}),
    });
  }
  if (status >= 500) {
    return yield* new JiraUnavailableError({ message: `Jira returned HTTP ${status}.` });
  }
  if (status < 200 || status >= 300) {
    return yield* new JiraResponseError({ message: `Jira returned HTTP ${status}.` });
  }
  const body = yield* response.json.pipe(
    Effect.mapError(() => new JiraResponseError({ message: "Jira returned a reply T3 Code couldn't read." })),
  );
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(() => new JiraResponseError({ message: "Jira returned a reply T3 Code couldn't read." })),
  );
}, (effect) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new JiraUnavailableError({ message: "Jira took too long to respond." })),
    }),
  ),
);
```

`S extends Schema.Decoder<unknown>` (decoding services `never`) follows `cli/thread.ts` and `peer/PeerMcpClient.ts`; `Schema.Top` would put `unknown` services into the effect's requirements and fail the typecheck.

Messages are fixed strings. They never include the token, the email, the URL or response bodies. If the `Effect.fn` combinator-argument form does not type-check with `timeoutOrElse`, wrap the body instead; the behaviour must stay the same.

- [ ] **3.3 Requests and response schemas** (`jiraApi.ts`). All URLs are `${connection.siteUrl}${path}`. Response structs list only the keys read; excess keys are ignored on decode.

```ts
export const RANK_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-lexo-rank";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
export const MAX_KEYS_PER_REQUEST = 100;

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
    Schema.Array(Schema.Struct({ key: Schema.String, fields: Schema.Record(Schema.String, Schema.Unknown) })),
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
  priority: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String }))),
});
```

Functions (each one `Effect.fn("Jira.<name>")`, error type `JiraAuthError | JiraUnavailableError | JiraResponseError`):

| Function | Request | Result |
| --- | --- | --- |
| `readAccountName(c)` | `GET /rest/api/3/myself` | `displayName?.trim() \|\| emailAddress?.trim() \|\| accountId` |
| `readPriorityScale(c)` | `GET /rest/api/3/priority/search?startAt=<n>&maxResults=100`, pages until `isLast !== false`, an empty page, or `MAX_PAGES` | `values.map(v => ({ id: v.id, name: v.name.trim() })).filter(v => v.id !== "" && v.name !== "")` in response order. Empty → `DEFAULT_TICKET_PRIORITY_SCALE` (logged at warning) |
| `readRankFieldId(c)` | `GET /rest/api/3/field` | among fields with `schema?.custom === RANK_FIELD_TYPE`: the one named `"Rank"`, else the first, else `null` |
| `readProjectKeys(c)` | `GET /rest/api/3/project/search?startAt=<n>&maxResults=100`, paged as above | `new Set(values.map(v => v.key.toUpperCase()))` |
| `fetchTicketBatch(c, keys, rankFieldId)` | below | `Map<ThreadTicketKey, JiraTicketFetchResult>` with an entry for every key |

`fetchTicketBatch` exact request and mapping (one chunk of at most `MAX_KEYS_PER_REQUEST` keys; the service chunks):

```ts
HttpClientRequest.post(`${c.siteUrl}/rest/api/3/issue/bulkfetch`).pipe(
  HttpClientRequest.bodyJsonUnsafe({
    issueIdsOrKeys: keys,
    fields: ["summary", "status", "priority", ...(rankFieldId === null ? [] : [rankFieldId])],
    fieldsByKeys: false,
  }),
);
// mapping
const byKey = new Map((body.issues ?? []).map((issue) => [issue.key.toUpperCase(), issue]));
return new Map(
  keys.map((key) => {
    const issue = byKey.get(key);
    const snapshot = issue === undefined ? null : toTicketSnapshot(issue.fields, rankFieldId);
    return [key, snapshot === null ? { type: "unreachable", syncError: "not_found" } : { type: "found", snapshot }];
  }),
);

export function toTicketSnapshot(
  fields: Readonly<Record<string, unknown>>,
  rankFieldId: string | null,
): Omit<ThreadTicketSnapshot, "syncedAt"> | null {
  const decoded = decodeIssueFields(fields); // Schema.decodeUnknownOption(IssueFields)
  if (Option.isNone(decoded)) return null;
  const { summary, status, priority } = decoded.value;
  const category = status?.statusCategory?.key;
  const rank = rankFieldId === null ? undefined : fields[rankFieldId];
  const priorityName = priority?.name.trim() ?? "";
  return {
    title: summary ?? "",
    statusName: status?.name ?? "",
    statusCategory: category === "indeterminate" || category === "done" ? category : "new",
    priority: priority && priority.id !== "" && priorityName !== "" ? { id: priority.id, name: priorityName } : null,
    rank: typeof rank === "string" && rank !== "" ? rank : null,
  };
}
```

`not_found` covers both missing and invisible issues, because Jira does not distinguish them (contract Q3). `forbidden` stays in the schema but `fetchTickets` never produces it at `ddec2d528a`. A moved issue answers under its new key, so its old key reads `not_found` (see Open questions).

- [ ] **3.4 Fake Jira site** (`testing/FakeJiraHttp.ts`, contract §7). Export `makeFakeJira(initial?)`, which returns:
  - `fetch: typeof globalThis.fetch`, for `Effect.provideService(FetchHttpClient.Fetch, fake.fetch)` or `Layer.succeed(FetchHttpClient.Fetch, fake.fetch)`, following `textGeneration/TextGenerators.test.ts`.
  - A controller with mutable state: `accountName`, `priorities: PriorityRef[]`, `fields` (by default including `{ id: "customfield_10019", name: "Rank", schema: { custom: RANK_FIELD_TYPE } }`), `projects: string[]`, `issues: Map<key, { summary, statusName, statusCategoryKey, priority, rank }>`.
  - `failNext(path, response)` for scripted `401`/`403`/`429` (with `retry-after`)/`500` replies or a network throw.
  - `holdNext(path, response?)`, which parks the next request to `path` until the returned `release` effect runs and then answers with `response` (default: the normal answer). The generation-guard test needs it, and it involves no sleeps.
  - `requests: Array<{ method, path, body, authorization }>` for counting calls and asserting the `Authorization` header and `redirect: "error"`.

  It answers the five endpoints in 3.3 (and `search/jql` only if 3.0 made it the fallback), plus 404 for anything else. Pages are `PAGE_SIZE`; a `pageSize` override keeps paging testable.

- [ ] **3.5 Tests** (`JiraService.test.ts`, `describe("jiraApi")`), as one table-driven `it.effect.each` where possible:

| Case | Fake setup | Expected |
| --- | --- | --- |
| basic auth | any | `Authorization: Basic base64("me@example.com:tok")`, `Accept: application/json` |
| 401 / 403 | `failNext(…, 401/403)` | `JiraAuthError` with the fixed message and status |
| 429 with `retry-after: 7` | | `JiraUnavailableError { retryAfterMs: 7000 }` |
| 500 / network throw | | `JiraUnavailableError` |
| 404 / undecodable body | | `JiraResponseError` |
| priority paging | 150 priorities, page size 100 | 150 refs in order |
| rank field | two lexo-rank fields, one named "Rank" | the "Rank" id; none → `null` |
| batch mapping | keys `[A-1, A-2, B-9]`, only `A-1` exists, status category `"undefined"` | `A-1` found with `statusCategory: "new"`, the others `not_found` |
| empty priority / rank | issue with `priority: null`, no rank value | `priority: null`, `rank: null` |

- [ ] **3.6 Verify.** Run `vp test run apps/server/src/jira/JiraService.test.ts` and `vp run t3#typecheck`. Commit: `feat(server): Jira Cloud REST client`.

## Task 4: `JiraService`

**Files:** `apps/server/src/jira/JiraService.ts`, `JiraService.test.ts`.

- [ ] **4.1 Service shape.** Exactly contract §6.7:

```ts
export class JiraService extends Context.Service<JiraService, {
  readonly isConfigured: Effect.Effect<boolean>;
  readonly status: Effect.Effect<JiraConnectionStatus>;
  readonly streamStatus: Stream.Stream<JiraConnectionStatus>;
  readonly priorityScale: Effect.Effect<ReadonlyArray<PriorityRef>>;
  readonly streamPriorityScale: Stream.Stream<ReadonlyArray<PriorityRef>>;
  readonly browseUrl: (key: ThreadTicketKey) => Effect.Effect<string | null>;
  readonly projectKeys: Effect.Effect<ReadonlySet<string>, JiraError>;
  readonly fetchTickets: (keys: ReadonlyArray<ThreadTicketKey>) => Effect.Effect<ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>, JiraError>;
  readonly testConnection: (input: JiraTestConnectionInput) => Effect.Effect<JiraTestConnectionResult>;
}>()("t3/jira/JiraService") {}

export const layer = Layer.effect(JiraService, make).pipe(
  Layer.provide([SecretResolverLayer.layer, FetchHttpClient.layer]),
);
```

`make` depends on `ServerSettings.ServerSettingsService`, `SecretResolver.SecretResolver` and `HttpClient.HttpClient`, the same set as `TextGenerators.make`.

- [ ] **4.2 Reading the connection.** `readConnection` is an `Effect.fn` that runs on settings from `settingsService.getSettings`, which are materialized, so a stored token is already a literal. It returns:
  - `{ type: "none" }` when `jira === null`, or when `apiToken` is the literal `""`.
  - `{ type: "invalid", siteUrl, message }` when `normalizeJiraSiteUrl(siteUrl) === null` ("The saved Jira site URL is not a valid https address."), or when a secret reference does not resolve (`requireSettingsSecret` fails; the message is the `SettingsSecretUnresolvedError` message).
  - `{ type: "ready", connection: JiraConnection }` otherwise. The token comes from `requireSettingsSecret(secrets, jira.apiToken)`.

  The token is resolved on every request group, not cached in the service, so rotating a referenced secret takes effect after `invalidateSettingsSecrets`.

  `isConfigured` is `readConnection` mapped to `type === "ready"`, with errors read as `false`. `browseUrl(key)` is `jiraBrowseUrl(normalizedSiteUrl, key)` when `jira !== null` and the site URL is valid (even without a token), else `null`.

- [ ] **4.3 State.** Use the same pattern as `UsageLimitSources`: a `Ref` and a `PubSub`, published only when `!Equal.equals(previous, next)`, and `stream*` getters that emit the current value and then each change. Two separate states:
  - `statusRef` starts as `{ state: "disconnected", siteUrl: null, accountName: null, error: null }`.
  - `scaleRef` starts as `DEFAULT_TICKET_PRIORITY_SCALE`.

  Per-connection caches live in one `Ref<ConnectionCache>`, reset on every (re)connect: `{ generation: number, rankFieldId: Option<string | null>, projectKeys: ReadonlySet<string> | null }`.

- [ ] **4.4 Status transition.** Exact code (the decision). It runs after every Jira request made by the service, except inside `testConnection`:

```ts
type RequestOutcome =
  | { readonly type: "success"; readonly accountName?: string }
  | { readonly type: "failure"; readonly error: JiraAuthError | JiraUnavailableError | JiraResponseError };

export function nextJiraStatus(
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
```

`record(generation, outcome)` reads the time from `Clock` (TestClock-friendly), formats it with `DateTime.formatIso`, and applies `nextJiraStatus` only when `generation` equals the cache's current generation. Without that check, a request still in flight from the previous connection would overwrite the new one's status. Per-key `not_found` results are successes. Cache writes (`projectKeys`, `rankFieldId`) are guarded by the same generation check (`Ref.update` that no-ops when the generation moved), so an old connection's project list or rank field never lands in the new connection's cache. The guard matters for calls made outside the connection loop (`fetchTickets`, `projectKeys` from P3), because `switchMap` already interrupts the loop's own `refreshSite`.

- [ ] **4.5 Connection loop.** Forked with `Effect.forkScoped` in `make`:

```ts
// Subscribe before the first read, so a save between the read and the subscription is not lost.
const settingsChanges = yield* settingsService.subscribeChanges;
yield* Stream.concat(
  Stream.fromEffect(settingsService.getSettings.pipe(Effect.orElseSucceed(() => null))),
  settingsChanges,
).pipe(
  Stream.map((settings) => settings?.jira ?? null),
  // A reconnect only when what Jira sees changes; the token compares raw (literal or reference).
  Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  Stream.switchMap((jira) => Stream.fromEffect(connect(jira))),
  Stream.runDrain,
  Effect.forkScoped,
);
```

`connect(jira)`:

1. Increment the generation and reset the cache.
2. Set the status base:
   - `none` → `{ state: "disconnected", siteUrl: normalized-or-null, accountName: null, error: null }`, and set the scale to `DEFAULT_TICKET_PRIORITY_SCALE`.
   - `invalid` → `{ state: "error", siteUrl, accountName: null, error: { kind: "response" or "auth" (unresolved secret), message, since: now } }`, with the default scale.
   - `ready` → `{ state: "connected", siteUrl, accountName: null, error: null }`. The UI reads `accountName === null` as "Checking…".
3. For `ready` only, run `Effect.forever(refreshSite.pipe(Effect.ignoreCause({ log: true }), Effect.andThen(Effect.sleep("1 hour"))))`. `switchMap` interrupts this loop on the next settings change.

`refreshSite` runs in sequence and stops at the first failure, recording each outcome:

1. `readAccountName`, recorded as `success` with `accountName`.
2. `readPriorityScale`, published to `scaleRef` on success. On failure the previous scale is kept: never clear on a transient failure.
3. `readProjectKeys`, stored in the cache.
4. The rank field id, only if `rankFieldId` is `Option.none()`.

The hourly loop is not gated by `BackgroundPolicy`. It costs four requests an hour, and skipping it would leave a stale scale.

- [ ] **4.6 `fetchTickets` and `projectKeys`.**
  - Read the connection. If it is not `ready`, fail `JiraNotConfiguredError`.
  - **Auth short-circuit:** if the current `status.error?.kind === "auth"`, fail with `new JiraAuthError({ status: 401, message: status.error.message })` without a request. The hourly `refreshSite` (via `myself`) and any settings change are the only things that retry. This keeps P3's 2-minute sweep from sending 30 failing Basic-auth requests an hour, which can lock the Atlassian account.
  - `fetchTickets`: dedupe the keys (order kept). An empty list → an empty map, with no request. Discover the rank field lazily if it is still `none`. Chunk the keys by `MAX_KEYS_PER_REQUEST` and run the chunks in sequence (`concurrency: 1`). Record each outcome. Merge the maps. Any chunk failure fails the whole call with that `JiraError`, and results already read are discarded: P3 then keeps every snapshot (contract §1 P3).
  - `projectKeys`: return the cached set, or read it (recording the outcome) when the cache is `null`.

- [ ] **4.7 `testConnection(input)`.** Never touches `statusRef`, `scaleRef` or the cache.

  1. Take `settings = input.settings ?? saved.jira`. If both are `null` → `{ type: "failed", kind: "invalid_site", message: "Enter your Jira site URL." }`.
  2. If `normalizeJiraSiteUrl(settings.siteUrl) === null` → `invalid_site` with "Enter your Jira Cloud site, like https://your-team.atlassian.net."
  3. Token: if `settings.apiToken` is `""` or `SECRET_REDACTED`, use `saved.jira?.apiToken ?? ""` (the same rule as `TextGenerators.listModels`). If that is still `""` → `{ kind: "auth", message: "Enter an API token." }`. Resolve it with `requireSettingsSecret`; a failure → `kind: "auth"` with its message.
  4. Run `readAccountName` then `readPriorityScale` → `{ type: "connected", accountName, priorityScale }`. Map a `JiraError` to `{ type: "failed", kind: <auth|unavailable|response>, message }`.

- [ ] **4.8 Tests** (`JiraService.test.ts`, `describe("JiraService")`). Build the layer as `Layer.effect(JiraService, make)` over a settings layer, `Layer.mock(SecretResolver.SecretResolver)({})`, `FetchHttpClient.layer` and `Layer.succeed(FetchHttpClient.Fetch, fake.fetch)`.

  The settings layer must emit changes. `ServerSettings.layerTest` does not: its `streamChanges` is `Stream.empty` and its `subscribeChanges` is `Effect.succeed(Stream.empty)` (`serverSettings.ts` `makeTest`). Use the real `ServerSettings.layer` wired as `layerServerSettingsWithSecrets` in `serverSettings.test.ts` (`ServerSecretStore.layer`, `ManagedPolicy.layerTest()`, `SqlitePersistence.layerMemory`, `ServerConfig.layerTest` on a temp dir), and seed `jira` with `updateSettings`. `layerTest` is enough only for cases that never change settings.

  Await milestones through `streamStatus` / `streamPriorityScale` taken into a `Queue` (`Queue.take`). Advance the hourly loop only with `TestClock.adjust("1 hour")`. No sleeps and no polling.

| Case | Expected |
| --- | --- |
| not configured | `status.state === "disconnected"`, scale is the default, `isConfigured` false, `fetchTickets` fails `JiraNotConfiguredError`, `fake.requests` empty |
| configured, healthy | status becomes `connected` with `accountName`; scale equals the site priorities; exactly 4 requests (`myself`, `priority/search`, `project/search`, `field`) |
| healthy hour passes, nothing changed | one more refresh group of requests; `streamStatus` and `streamPriorityScale` emit nothing new |
| site reorders priorities, then 1 hour passes | `streamPriorityScale` emits the new order once |
| `myself` → 401 | `state: "error"`, `kind: "auth"`, `since` = clock time; scale stays as before; a later `fetchTickets` fails `JiraAuthError` **without a request**; after `TestClock.adjust("1 hour")` with the fake healthy, the status is `connected` again and `fetchTickets` sends a request |
| two consecutive 500s | `since` unchanged after the second; one status emission in total |
| settings change mid-request: fork `fetchTickets` with `holdNext("/rest/api/3/issue/bulkfetch", 401)`, change `jira.email`, wait for the new connection's `connected` status, then release | the released 401 from the old generation leaves the new status `connected` and does not engage the auth short-circuit |
| `fetchTickets` with 150 keys including duplicates | two bulkfetch calls (100 + rest), one map entry per distinct key |
| `jira: null` patch after connected | status becomes `disconnected`, scale is the default, the hourly loop stops (no requests after `TestClock.adjust("2 hours")`) |
| `testConnection` with a redacted token and a saved token | uses the saved token (Authorization header), returns `connected` + scale, `status` unchanged |
| `testConnection` with `"http://x"` | `invalid_site`, no request |

- [ ] **4.9 Verify** with `vp test run apps/server/src/jira/JiraService.test.ts` and `vp run t3#typecheck`. Commit: `feat(server): JiraService connection status and priority scale`.

## Task 5: `JiraService` test double

**File:** `apps/server/src/jira/testing/JiraServiceTest.ts` (contract §7; P3 and P4 build on it).

- [ ] **5.1 Interface.**

```ts
export interface JiraServiceTestState {
  readonly configured: boolean;
  readonly status: JiraConnectionStatus;
  readonly priorityScale: ReadonlyArray<PriorityRef>;
  readonly siteUrl: string | null;
  readonly projectKeys: ReadonlySet<string> | JiraError;
  readonly tickets: ReadonlyMap<ThreadTicketKey, JiraTicketFetchResult>; // missing key -> not_found
  readonly fetchError: JiraError | null;                                  // fails every fetchTickets
  readonly testResult: JiraTestConnectionResult;
}
export interface JiraServiceTestController {
  readonly update: (patch: Partial<JiraServiceTestState>) => Effect.Effect<void>; // publishes status/scale changes to the streams
  readonly fetchCalls: Effect.Effect<ReadonlyArray<ReadonlyArray<ThreadTicketKey>>>;
}
export const makeTestJiraService: (initial?: Partial<JiraServiceTestState>) => Effect.Effect<{
  readonly layer: Layer.Layer<JiraService>;
  readonly controller: JiraServiceTestController;
}>;
```

Defaults: not configured, disconnected status, the default scale, no tickets. The `stream*` getters follow the same current-then-changes semantics as the real service, and `browseUrl` uses `jiraBrowseUrl` with `siteUrl`.

- [ ] **5.2** Use the double in `ws.test.ts` (Task 6). No separate test for the double itself; the tests that use it exercise it.

## Task 6: Server wiring, config stream, RPC

**Files:** `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `apps/server/src/ws.test.ts`, `apps/server/src/auth/RpcAuthorization.test.ts`.

- [ ] **6.1 Layer.** In `server.ts`, add `JiraService.layer` to the `Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer)` group (~L699). `UsageLimitSources` has the same dependencies (settings and the secret resolver), so it proves they resolve there. The runtime layer then provides `JiraService` to `ws.ts` and later to P3's reactor and P4's toolkit. If typechecking shows it is not reachable from `layerRuntimeCoreDependenciesBase`'s reactor block, move it to `Layer.provideMerge` right above `Layer.provideMerge(SecretResolver.layer)`, and say so in the handoff for P3.

- [ ] **6.2 `loadServerConfig`** (`ws.ts` ~L1902). Add `const jira = yield* JiraService.JiraService;` beside `textGenerators` (~L1542), and put these in the returned config:

```ts
          ticketPriorityScale: yield* jira.priorityScale,
          jiraStatus: yield* jira.status,
```

This fills both `server.getConfig` and every snapshot.

- [ ] **6.3 `ticketTrackerUpdated`** in the `subscribeServerConfig` handler (~L3396), beside `usageLimitSourceUpdates`. Exact code:

```ts
              const ticketTrackerUpdates =
                input.ticketTracker === true
                  ? Stream.zipLatestWith(
                      jira.streamPriorityScale,
                      jira.streamStatus,
                      (ticketPriorityScale, jiraStatus) => ({ ticketPriorityScale, jiraStatus }),
                    ).pipe(
                      // Both streams start with their current value; comparing to the snapshot sends only later changes.
                      (updates) =>
                        Stream.concat(
                          rpcInitialItems([
                            { ticketPriorityScale: trackerSnapshot.ticketPriorityScale, jiraStatus: trackerSnapshot.jiraStatus },
                          ]),
                          updates,
                        ),
                      Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
                      Stream.drop(1),
                      Stream.map((payload) => ({
                        version: 1 as const,
                        type: "ticketTrackerUpdated" as const,
                        payload,
                      })),
                    )
                  : Stream.empty;
```

`trackerSnapshot` holds the two values `loadServerConfig` returned. Return them typed as non-optional from a small helper, or read `config.ticketPriorityScale ?? DEFAULT_TICKET_PRIORITY_SCALE` and `config.jiraStatus ?? <disconnected>`; pick whichever type-checks without casts. Merge it into `liveUpdates` next to `usageLimitSourceUpdates`. Old clients never send `ticketTracker` and so never receive the event (D3).

- [ ] **6.4 Late discovery fold** (`withLateConfigDiscovery` ~L366). Without this case, a late `snapshot` resend would roll the client back to the initial Jira state:

```ts
          case "ticketTrackerUpdated":
            return [{ ...current, ...event.payload }, [event]];
```

- [ ] **6.5 RPC handler.** In the main handlers, beside `serverListTextGeneratorModels` (~L2747): `[WS_METHODS.serverTestJiraConnection]: (input) => jira.testConnection(input),`. In `RpcInstrumentation.ts`, add `[WS_METHODS.serverTestJiraConnection]: "server",`.

- [ ] **6.6 Tests.**
  - `ws.test.ts`, extending "resends late editors without rolling back updates already sent" (~L165). Add a `ticketTrackerUpdated` event (status `error`) to the `Stream.make(…)` input. Assert that the late `snapshot`'s `jiraStatus` and `ticketPriorityScale` equal the event's payload.
  - `ws.test.ts`, config subscription. In the shared config-RPC test services (`layerUnusedConfigRpcServices` and the per-test `configRpcServices` blocks that list `UsageLimitSources` mocks), provide `makeTestJiraService(...)`'s layer. Then add one test on top of the existing real-settings subscription tests (the ones using `settings.updateSettings`, ~L1000) that:
    1. saves `jira` with token `"jira-secret-123"`,
    2. subscribes with `{ ticketTracker: true }`,
    3. asserts the snapshot has `ticketPriorityScale` and `jiraStatus` from the double, and `JSON.stringify(snapshot)` does not include `"jira-secret-123"`,
    4. changes the double's status → exactly one `ticketTrackerUpdated` with the new status,
    5. updates `jira.email` → the `settingsUpdated` payload does not include the token,
    6. resubscribes without `ticketTracker` and confirms no `ticketTrackerUpdated` arrives after a status change. Prove the absence by sending a later `settingsUpdated` and checking it is the next event, with no timeout.
  - `RpcAuthorization.test.ts`: add `expect(requiredScopeForRpcMethod(WS_METHODS.serverTestJiraConnection)).toBe(AuthSettingsWriteScope)` as a row in an existing scope test. The "exactly one scope for every RPC" test covers registration.

- [ ] **6.7 Verify.**

```sh
vp test run apps/server/src/ws.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/jira/JiraService.test.ts
vp run t3#typecheck
```

Commit: `feat(server): ticket priority scale and Jira status in server config`.

## Task 7: Client runtime

**Files:** `packages/client-runtime/src/rpc/session.ts`, `packages/client-runtime/src/state/server.ts`, `packages/client-runtime/src/state/serverConfigProjection.ts`, their tests, `packages/client-runtime/src/state/commandPermissions.test.ts`, and the four app opt-in files.

- [ ] **7.1 Projection.** `applyServerConfigProjection`, exact case:

```ts
    case "ticketTrackerUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          ticketPriorityScale: reuseUnchanged(
            projection.config.ticketPriorityScale,
            event.payload.ticketPriorityScale,
          ),
          jiraStatus: reuseUnchanged(projection.config.jiraStatus, event.payload.jiraStatus),
        },
        latestEvent: event,
        source: "live",
      }));
```

The `snapshot` case needs nothing: new servers always send both fields, and a snapshot from an old server rightly has neither, so `ticketPriorityScaleOf` falls back (D4). The replay in `session.ts` (`serverConfigReplayEvents`) needs no extra event either, because the folded config already carries both fields.

Both fields stay in the persisted client config cache (`makeEnvironmentServerConfigState`'s `persist` and `withoutEnvironmentThemes` strip only themes, usage-limit sources and the stall). This is deliberate: an offline environment's threads still sort by its last known scale (P5). The cached `jiraStatus` is replaced by the first live snapshot, which always carries it from a P2 server.

- [ ] **7.2 Opt-in plumbing.** Add `readonly ticketTracker?: boolean` to `RpcSessionOptions` (session.ts ~L65), `ServerConfigSubscriptionOptions` (state/server.ts ~L364) and the `createServerEnvironmentAtoms` options (~L757). Forward it exactly as `usageLimitSources` is forwarded at session.ts ~L177, state/server.ts ~L488 and ~L774. Set `ticketTracker: true` in:
  - `apps/web/src/connection/runtime.ts` (~L38)
  - `apps/web/src/state/server.ts` (~L36)
  - `apps/mobile/src/connection/runtime.ts` (~L40)
  - `apps/mobile/src/state/server.ts` (~L14)

  Mobile opts in because P5/P6 sort and show priorities from the scale.

- [ ] **7.3 Command.** In `createServerEnvironmentAtoms`' command map (state/server.ts ~L1618), add:

```ts
    testJiraConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:test-jira-connection",
      tag: WS_METHODS.serverTestJiraConnection,
    }),
```

- [ ] **7.4 Tests.**
  - `serverConfigProjection.test.ts`: one `describe("applyServerConfigProjection ticketTrackerUpdated")` with two cases. (a) The event writes both fields. (b) Repeating the same payload keeps the same `ticketPriorityScale` and `jiraStatus` object identity, via `reuseUnchanged`.
  - `session.test.ts`: in the existing opt-in coverage (the `it.effect.each` at ~L499, or `completeInitialConfig`'s payload assertion), add `{ ticketTracker: true }` so the subscribe payload is shown to carry `ticketTracker: true`.
  - `commandPermissions.test.ts`: turn "requires the destination settings grant to check OTLP endpoints" (~L186) into `it.effect.each([WS_METHODS.serverCheckOtlpEndpoint, WS_METHODS.serverTestJiraConnection])`.

- [ ] **7.5 Verify.**

```sh
vp test run packages/client-runtime/src/state/serverConfigProjection.test.ts packages/client-runtime/src/rpc/session.test.ts packages/client-runtime/src/state/commandPermissions.test.ts
vp run @t3tools/client-runtime#typecheck
vp run @t3tools/web#typecheck
vp run @t3tools/mobile#typecheck
```

Commit: `feat(client-runtime): receive Jira status and priority scale`.

## Task 8: Web and desktop Settings section

**Files:** `apps/web/src/components/settings/JiraSettings.tsx` (new), `JiraSettings.logic.ts` (new) + `.logic.test.ts`, `SourceControlSettings.tsx`, `settingsSearch.ts`.

- [ ] **8.1 Placement and gating.** Export `JiraSettingsSection` and render it in `SourceControlSettingsPanel` directly above `<SourceControlWritingSettingsSection />`. It is a `SettingsSection` with `id={searchableSetting("jira-connection").id}` (`"jira-connection"`, §6.13) and title "Jira". It renders:
  - nothing when the scoped environment's `serverConfig.environment.capabilities.threadTickets !== true` (D6: an older server would drop the patch),
  - the `SettingsScopeNotice target="environment"` pattern from `TelemetryExportSettings.tsx` when the scope covers more than one environment ("Choose one environment to connect it to Jira."),
  - the "Connect an environment" text when none is connected.

  Edit permission is `useAtomValue(serverEnvironment.testJiraConnection.permissionAtom(environmentId))`, which is the same scope as `updateSettings`. Without it, the section shows the status only (read-only).

- [ ] **8.2 States** (read `settings.jira` via `useEnvironmentSettings(environmentId, (s) => s.jira)` and `jiraStatus` from the environment's server config):

| `jiraStatus` | Shows |
| --- | --- |
| absent (server predates P2 but has the capability) or `disconnected` | Form: Site URL (placeholder `your-team.atlassian.net`), Email, API token (`SecretSourceInput` with `useSecretSources`, like `SourceControlTokenSettings`), an "Create an API token" external link to `https://id.atlassian.com/manage-profile/security/api-tokens`, and buttons "Test connection" and "Connect" |
| `connected`, `accountName === null` | Site and email, "Checking…" text, buttons "Test connection", "Edit", "Disconnect" |
| `connected` | "Connected as <accountName>" on <site host>, same buttons |
| `error` | The same plus an error row: kind label ("Authentication failed" / "Jira unavailable" / "Unexpected reply") with `message` and "since <relative time>". This row is where P3's sync errors appear, because JiraService records them (contract Q7) |

  - **Test connection** sends `testJiraConnection({ environmentId, input: { settings: draft } })`, where the draft's token is the typed value, or `SECRET_REDACTED`/the saved reference when untouched. In view mode it sends `input: {}`. It shows "Connected as X · N priorities" or the failure message inline. It never saves.
  - **Connect / Save** sends `updateSettings({ environmentId, input: { patch: { jira: jiraSettingsPatch(draft, saved) } } })`.
  - **Disconnect** sends `patch: { jira: null }`. No confirmation, because reconnecting is the way back. Afterwards the form is empty except for the email, which is kept in local state for convenience.
  - **Edit** returns to the form with the saved site and email, and the token left blank, which means "keep the saved one".

  Use `components/ui` variants only (`Button` `variant`/`size`, `Input`, `Label`, `Badge`). Layout classes go on parents (AGENTS.md Taste; `shadcn/no-restyle`).

- [ ] **8.3 `JiraSettings.logic.ts`** holds the pure decision code. Exact signatures:

```ts
export interface JiraDraft { readonly siteUrl: string; readonly email: string; readonly apiToken: string | SecretReference }
/** null when the draft cannot be saved; the message says why. */
export function jiraSettingsPatch(
  draft: JiraDraft,
  saved: JiraSettings | null,
): { readonly patch: NonNullable<ServerSettingsPatch["jira"]> } | { readonly error: string };
```

  Rules:
  - The site goes through `normalizeJiraSiteUrl`; invalid → `{ error: "Enter your Jira Cloud site, like your-team.atlassian.net." }`.
  - The email is trimmed; empty → error.
  - The token: a typed non-empty string or a reference → `apiToken` set. Blank with a saved token (`saved.apiToken !== ""`) → `apiToken` omitted (the server keeps the saved one). Blank with no saved token → `{ error: "Enter an API token." }`.

  Test table in `JiraSettings.logic.test.ts`:

| draft | saved | result |
| --- | --- | --- |
| `{ "acme.atlassian.net", "me@x.com", "tok" }` | `null` | `patch { siteUrl: "https://acme.atlassian.net", email, apiToken: "tok" }` |
| `{ "https://acme.atlassian.net/jira/x", "me@x.com", "" }` | saved, token redacted | `patch` without `apiToken` |
| `{ "acme.atlassian.net", "me@x.com", "" }` | `null` | `error` "Enter an API token." |
| `{ "http://acme", … }` | any | `error` site |
| `{ …, email: " " }` | any | `error` email |

  No browser test for the component: its logic is in the pure helper, and its look is checked by capture (AGENTS.md: no tests for static markup or callback wiring).

- [ ] **8.4 Settings search.** Add the contract §6.10 entry to `SETTINGS_SEARCH_ITEMS`, next to the `source-control` item (~L1159). It adds one field beyond the contract text, `environmentOnly: true`, as the host credential entries have, so the entry is hidden when there is no environment to configure:

```ts
  {
    id: "jira-connection",
    title: "Jira",
    to: "/settings/source-control",
    targetId: "jira-connection",
    scope: "environment-defaults",
    environmentOnly: true,
    searchTerms: ["jira atlassian ticket issue priority rank api token connect"],
  },
```

  If the settings-search test file has a "every item resolves to an anchor" style check, the section's `id` satisfies it.

- [ ] **8.5 Mobile decision (recorded, no code).** Mobile gets **no** Jira settings UI in this feature:
  - Connecting Jira is a one-time, per-environment admin task. It needs an API token created on Atlassian's account page, which in practice happens on a computer.
  - Web, desktop and app.t3.codes can configure any environment, remote ones included, through the same settings RPC.
  - Mobile still receives `ticketPriorityScale` and `jiraStatus` (Task 7.2 opt-in) and all ticket and priority data, so P5 and P6 work there unchanged.
  - Adding a mobile form would mean a second credential form and secret input to maintain for a rare action. A one-way door is not created, because disconnecting is available on every surface that can connect.

  If the maintainers want mobile parity, it is a follow-up using `jiraSettingsPatch` and `testJiraConnection`, both of which live in shared code or are trivially portable.

- [ ] **8.6 Verify.**

```sh
vp test run apps/web/src/components/settings/JiraSettings.logic.test.ts
vp run @t3tools/web#typecheck
```

Commit: `feat(web): connect Jira in Source control settings`.

## Task 9: Integrated verification and handoff

- [ ] **9.1** Run `vp run check:changed` in the P2 worktree and fix everything it reports.
- [ ] **9.2 End-to-end (primary agent only, once, contract §8).**
  1. Start `vp run dev` in the P2 worktree, in the background, capturing the PID. Its state is the worktree's own seeded `.t3`, never `~/.t3/userdata`. Read the real ports from the `[dev-runner]` line.
  2. Use `test-t3-app` to open Settings → Source control.
  3. Connect with the user's Jira Cloud site URL, email and API token from `request_secret`.
  4. Test connection shows the account name.
  5. The status shows "Connected as …".
  6. Read the `subscribeServerConfig` payload in the browser and `settings.json` in the worktree `.t3`. Neither contains the token. Check this with a search in the page's network/WebSocket frames and with `grep -c` on the file, without printing the token.
  7. `ticketPriorityScale` matches the site's priorities in Jira admin order.
  8. Enter a wrong token and save → the error row appears with "Authentication failed". Restore the token → the error clears.
  9. Disconnect → the state is disconnected, the scale is the default five, and the secret is gone from `.t3` secrets.
  10. Reconnect works.
  11. Settings search "jira" lands on the section.
  12. Stop the dev server by the captured PID (AGENTS.md rule 1).
- [ ] **9.3 Visual.** Render the Jira section in each state at the default settings width and capture images: disconnected form, checking, connected, error, test success, test failure, and read-only (no permission), in light and dark. View each one and check alignment, wrapping of long site URLs and error messages, and that no restyled `components/ui` element appears.
- [ ] **9.4 Independent review.** A fresh-context reviewer subagent (or `/code-review`) reviews the whole P2 diff against this plan, the spec section, and contract §6.6–§6.8. It focuses on the Review Focus list, checks the testing claims, and views the 9.3 captures. Fix or justify every finding. The handoff reports the findings and what was done about each.
- [ ] **9.5** Hand off for the plan merge (contract §5): `git merge --no-ff feat/thread-priority-p2 -m "merge: P2"` from the integration worktree, done by the orchestrator. Report the commit list, the test commands and results, the 3.0 probe outcome (no secrets), and any deviation that P3/P4 need to know (for example, the layer placement from 6.1).

## Testing Strategy

- **End-to-end (Task 9.2):** one real-client pass by the primary agent on the P2 worktree's dev server, connected read-only to the user's Jira Cloud site with credentials from `request_secret`. It covers connect, test, the status display (connected, auth error, recovery), disconnect and reconnect, the scale matching Jira's order, settings search, and the token being absent from the client-visible config payload and from `settings.json`. Ticket sync itself is P3's and is validated end to end in P7; P2 only proves `fetchTickets` against the real site in the 3.0 probe (bulkfetch with real, missing and foreign keys). Subagents do not run dev servers (AGENTS.md).
- **Hermetic:**
  - Contracts: decode defaults, the site URL table, and the secret field annotation (`jira.test.ts`).
  - Patch merge table (`packages/shared/src/serverSettings.test.ts`).
  - Secret storage, redaction and stale-secret removal through the real settings service (`serverSettings.test.ts`).
  - Jira REST mapping and error classes against the fake site (`JiraService.test.ts`).
  - The service lifecycle with `TestClock` for the hourly refresh: generation guard, auth short-circuit, and no emission when nothing changed.
  - ws: snapshot fields, token absence, gated `ticketTrackerUpdated`, and the late-discovery fold (`ws.test.ts`).
  - RPC scope (`RpcAuthorization.test.ts`, `commandPermissions.test.ts`), client projection, and the session opt-in.
  - Settings form → patch logic (`JiraSettings.logic.test.ts`).

  Commands: `vp test run <files>` per task, per-package `vp run <pkg>#typecheck`, and `vp run check:changed` before handoff. No repo-wide checks.
- **Visual (Task 9.3):** captures of every state of the Jira section in light and dark, viewed with vision. No UI unit tests for markup.
- **Skipped:** mobile end-to-end and visual checks. P2 adds no mobile UI, only the `ticketTracker: true` opt-in, which the session test covers. P6/P7 exercise mobile with real data.

## Open questions / spec deviations

**Resolved by the user (2026-11-13), binding:** D1 bulkfetch; D7 **a successful Test connection using the saved settings (view mode, `input: {}`) also clears the auth-error pause and status** — implement and test it (contract §6.7 relaxed accordingly); D8, D9, D10, D11 accepted as recommended. Where an item below conflicts, this wins.

1. **Ticket fetch endpoint: `issue/bulkfetch` instead of the spec's `search/jql`.**
   - Context: the spec names `POST /rest/api/3/search/jql` with `key in (...)`. JQL fails the whole query when any key does not exist or is not visible, so one deleted ticket would stop syncing for every thread. Contract Q2 left the choice to P2. `POST /rest/api/3/issue/bulkfetch` takes up to 100 keys and the same `fields`, and answers the readable ones while leaving out the rest.
   - Options: (a) search/jql as specified; (b) bulkfetch; (c) search/jql that retries without the keys named in a 400.
   - Recommendation: (b), confirmed by the read-only probe in Task 3.0, with (c) as the fallback if the probe shows bulkfetch unavailable. `fetchTickets` hides the choice, so no other plan changes.
2. **`JiraSettings.apiToken` uses `Schema.annotateKey({ settingsSecret: true })`, not `secretSetting`** (contract §6.6).
   - Context: `settings.ts` imports `jira.ts`, so `jira.ts` importing `secretSetting` from `settings.ts` would be a cycle. `device.ts` already solves the same problem the same way (`EasDeviceHostConfig.accessToken`). `secretSetting` is exactly `schema.annotateKey({ settingsSecret: true })`.
   - Options: move `JiraSettings` into `settings.ts` (the contract's fallback), or annotate directly.
   - Recommendation: annotate directly and keep `JiraSettings` in `jira.ts`. All names stay as the contract pins them, and the jira.test.ts row `secretSettingsFields(JiraSettings) === ["apiToken"]` pins the behaviour.
3. **Client opt-in touches four app files the contract does not list** (contract §1 P2 and §9 name only `session.ts`, `serverConfigProjection.ts` and `state/server.ts`).
   - Context: the `subscribeServerConfig` flags are set in two places per app: the connection layer (`apps/{web,mobile}/src/connection/runtime.ts`) and the server-config atoms (`apps/{web,mobile}/src/state/server.ts`). Without `ticketTracker: true` there, no client receives late scale or status changes.
   - Recommendation: P2 edits all four, each a one-line change. No other plan edits those lines.
4. **`applyServerSettingsPatch` handles `jira` through the generic `deepMerge`** (`packages/shared/src/serverSettings.ts`, not listed in contract §9).
   - Context: an earlier draft added an explicit `jira` case, on the theory that `deepMerge` would drop a saved `apiToken`. Reading `deepMerge` (`packages/shared/src/Struct.ts`) shows it keeps the saved token when the patch omits it. With no saved Jira, it yields the same missing-then-`""` result the explicit case produced. The explicit case was dead weight.
   - Options: (a) rely on `deepMerge`, pinned by the 1.7 table; (b) add the explicit case anyway as documentation.
   - Recommendation: (a). P2 adds only a test to `packages/shared/src/serverSettings.test.ts`; no other plan touches it.
5. **Auth-error short-circuit in `fetchTickets` / `projectKeys`** (an addition to contract §6.7 behaviour; the signature is unchanged).
   - Context: P3 sweeps every 2 minutes. With a revoked token, that is about 30 failing Basic-auth requests an hour, which risks Atlassian locking the account behind a CAPTCHA.
   - Options: let P3 back off on auth errors, or have JiraService fail fast while the status is `auth`.
   - Recommendation: JiraService fails fast. P3 just sees `JiraAuthError` as before, and the hourly refresh or any settings change re-checks. Side effect: after the user fixes an account-side problem in Jira without changing T3 settings, recovery can take up to an hour. Saving new settings is immediate. Is that acceptable, or should the Settings section's "Test connection" success also trigger an immediate re-check? That would contradict contract §6.7's "testConnection never mutates status", so it would be a contract change.
6. **Initial `connected` state before the first reply.**
   - Context: contract §6.8 has no "checking" state, and P6 gates link UI on `state !== "disconnected"`. A configured connection therefore starts as `connected` with `accountName: null` until `myself` answers, and the Settings section shows "Checking…" for that case.
   - Options: add a `"checking"` state to `JiraConnectionStatus`, which would be a contract change touching P6.
   - Recommendation: keep the contract.
7. **Moved Jira issues read as unreachable.**
   - Context: when an issue moves to another project, its key changes. Bulkfetch answers under the new key, so the linked old key maps to `not_found`.
   - Options: follow the move by matching issue ids (needs an id in the link schema: P1/P3 change); or accept it.
   - Recommendation: accept for now. The chip shows "unreachable" and the user can relink. Record as a follow-up if it shows up in practice.
8. **Changing the site URL keeps the saved token.**
   - Context: an omitted token in a patch keeps the saved one even when `siteUrl` changes, and `testConnection` with a redacted token and a new site uses the saved token. This matches `TextGenerators.listModels` (a redacted key with a new base URL). Atlassian API tokens are per account, not per site, so this is the useful behaviour. Only settings writers (`AuthSettingsWriteScope`) can trigger it, and they could read the token's effect anyway by saving.
   - Recommendation: keep parity with the existing pattern. No extra guard.
9. **Spec says "a capability flag" in `ServerConfig`.**
   - Context: per contract §6.8, the flag is `ExecutionEnvironmentCapabilities.threadTickets`, added by P1-contract, not a new `ServerConfig` boolean. The presence of `ticketPriorityScale` itself tells clients whether the server sends a scale.
   - Recommendation: no extra `ServerConfig` boolean. Recorded so the coherence pass can align the spec wording.
10. **Spec names the wrong file for the settings-secret mechanism.**
   - Context: the spec says `apiToken` is held through `apps/server/src/secrets/settingsSecretValue.ts`. That file only resolves secret references (`requireSettingsSecret`, `resolveSettingsSecrets`). Storage, materialization, stale cleanup and client redaction all key off `mapSecretFieldGroups` in `apps/server/src/settingsSecrets.ts`, which is where Task 2.1 registers the field. `settingsSecretValue.ts` is still used, for resolving a referenced token in 4.2/4.7.
   - Recommendation: a factual fix for the coherence pass (cite both files). No behaviour change.
