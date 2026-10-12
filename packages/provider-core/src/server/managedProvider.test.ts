import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

/** A host whose settings never change and whose background demand is fixed. */
function layerProviderHost(input: {
  readonly runBackgroundWork: boolean;
  readonly settings?: Pick<ProviderHost.ProviderHost["Service"], "settings">["settings"];
}) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: input.settings ?? {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(input.runBackgroundWork),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });
const layerNeverRunTest = layerProviderHost({ runBackgroundWork: false });

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("does not enrich a disabled provider's snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let enrichmentCalls = 0;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: false }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed({ ...initialSnapshot, enabled: false }),
          checkProvider: Effect.succeed({ ...refreshedSnapshot, enabled: false }),
          enrichSnapshot: () => {
            enrichmentCalls += 1;
            return Effect.void;
          },
        });

        yield* provider.refresh;

        assert.strictEqual(enrichmentCalls, 0);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("skips periodic provider refreshes without foreground provider-status demand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerNeverRunTest, TestClock.layer()))),
  );

  it.effect("disables periodic provider refreshes when the explicit interval is zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: 0,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("keeps manual refresh when interval refresh is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
          refreshOnInterval: false,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* provider.refresh;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("wakes a sleeping provider refresh loop when its interval changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerHealthRefreshInterval: Duration.hours(1),
        };
        const serverSettingsRef = yield* Ref.make(initialServerSettings);
        const serverSettingsChanges = yield* PubSub.unbounded<typeof initialServerSettings>();
        const hostSettings: ProviderHost.ProviderHost["Service"]["settings"] = {
          get: Ref.get(serverSettingsRef),
          withSnapshot: (use) => Ref.get(serverSettingsRef).pipe(Effect.flatMap(use)),
          changes: Stream.empty,
          subscribe: PubSub.subscribe(serverSettingsChanges).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        };
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const periodicCheckDone = yield* Deferred.make<void>();

        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Deferred.succeed(periodicCheckDone, undefined).pipe(Effect.ignore),
            ),
            Effect.as(refreshedSnapshot),
          ),
        }).pipe(
          Effect.provide(layerProviderHost({ runBackgroundWork: true, settings: hostSettings })),
        );

        yield* Deferred.await(initialCheckDone);
        const nextServerSettings = {
          ...initialServerSettings,
          providerHealthRefreshInterval: Duration.seconds(1),
        };
        yield* Ref.set(serverSettingsRef, nextServerSettings);
        yield* PubSub.publish(serverSettingsChanges, nextServerSettings);
        yield* Effect.yieldNow;

        yield* TestClock.adjust("999 millis");
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(periodicCheckDone);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("can update settings and disable periodic checks without probing again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const enrichmentCalls = yield* Ref.make(0);
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          enrichSnapshot: () => Ref.update(enrichmentCalls, (count) => count + 1),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Ref.get(enrichmentCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("applies runtime usage updates onto the published snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [
                { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 20,
                  resetsAt: "2026-04-17T00:00:00.000Z",
                },
              ],
            },
          } satisfies ServerProvider),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        // Percent-only weekly update: keeps the probe's reset time.
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
        });
        // No windows: nothing to merge, nothing published.
        yield* provider.applyUsageLimits({ checkedAt: "2026-04-10T00:06:00.000Z", windows: [] });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(update?.usageLimits, {
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              history: [{ at: "2026-04-10T00:00:01.000Z", usedPercent: 10 }],
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
              resetsAt: "2026-04-17T00:00:00.000Z",
            },
          ],
        });
        assert.deepStrictEqual(yield* provider.getSnapshot, update);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps live usage windows across a failed probe and a stale enrichment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const refreshCount = yield* Ref.make(0);
        const probedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    ...refreshedSnapshot,
                    auth: { ...refreshedSnapshot.auth, workspaceId: "ws-a" },
                    usageLimits: probedLimits,
                  }
                : {
                    ...refreshedSnapshotSecond,
                    ...(count === 3
                      ? { auth: { ...refreshedSnapshotSecond.auth, workspaceId: "ws-b" } }
                      : {}),
                    usageLimits: {
                      checkedAt: "2026-04-10T00:00:03.000Z",
                      windows: [],
                      unavailable: { reason: "probeFailed" },
                    },
                  },
            ),
          ),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() =>
                publishSnapshot({
                  ...enrichedSnapshot,
                  ...snapshot,
                  models: enrichedSnapshot.models,
                }),
              ),
            ),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const liveWindow = {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 60,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [liveWindow],
        });

        // Enrichment computed from the pre-update snapshot lands afterwards.
        yield* Deferred.succeed(releaseEnrichment, undefined);
        const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]!),
        );
        assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
        const liveWindowWithHistory = {
          ...liveWindow,
          history: [
            { at: "2026-04-10T00:00:01.000Z", usedPercent: 10 },
            { at: "2026-04-10T00:00:02.000Z", usedPercent: 60 },
          ],
        };
        assert.deepStrictEqual(enriched.usageLimits?.windows, [liveWindowWithHistory]);

        // A probe that could not read usage keeps the last good windows.
        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindowWithHistory]);
        // ...and the workspace they were read for.
        assert.strictEqual(refreshed.auth.workspaceId, "ws-a");

        // A failed read for another workspace does not inherit those windows.
        const switched = yield* provider.refresh;
        assert.strictEqual(switched.auth.workspaceId, "ws-b");
        assert.strictEqual(switched.usageLimits?.unavailable?.reason, "probeFailed");
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  describe("session usage history", () => {
    const T0 = "2026-10-11T10:00:00.000Z";
    const R1 = "2026-10-11T15:00:00.000Z";
    const R2 = "2026-10-11T20:00:00.000Z";
    const W = "2026-10-17T00:00:00.000Z";
    const plus = (seconds: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(T0) + seconds * 1000));

    interface ProbeOptions {
      readonly at?: string;
      readonly resets?: string;
      readonly workspaceId?: string;
      readonly email?: string;
      readonly fingerprint?: string;
      readonly failed?: boolean;
      readonly unsupported?: boolean;
    }

    const probe = (percent: number, options: ProbeOptions = {}): ServerProvider => {
      const checkedAt = options.at ?? T0;
      const usageLimits: NonNullable<ServerProvider["usageLimits"]> =
        options.unsupported || options.failed
          ? {
              checkedAt,
              windows: [],
              unavailable: { reason: options.unsupported ? "unsupported" : "probeFailed" },
            }
          : {
              checkedAt,
              windows: [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: percent,
                  resetsAt: options.resets ?? R1,
                },
                { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: W },
              ],
              ...(options.fingerprint ? { credentialFingerprint: options.fingerprint } : {}),
            };
      return {
        ...refreshedSnapshot,
        auth: {
          status: "authenticated",
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.email ? { email: options.email } : {}),
        },
        usageLimits,
      };
    };

    const fiveHour = (usedPercent: number, resetsAt?: string) =>
      ({
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      }) as const;

    const sessionHistory = (snapshot: ServerProvider) =>
      snapshot.usageLimits?.windows.find((window) => window.id === "five_hour")?.history;

    /** Drives probes through `next` and records every publish. */
    const makeUsageProvider = (
      initial: ServerProvider,
      enrichSnapshot?: Parameters<
        typeof makeManagedServerProvider<TestSettings>
      >[0]["enrichSnapshot"],
    ) =>
      Effect.gen(function* () {
        const next = yield* Ref.make(initial);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, current) => previous.enabled !== current.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.get(next),
          ...(enrichSnapshot ? { enrichSnapshot } : {}),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
        yield* Stream.runForEach(provider.streamChanges, (snapshot) =>
          Ref.update(published, (list) => [...list, snapshot]),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const publishCount = Effect.yieldNow.pipe(
          Effect.andThen(Ref.get(published)),
          Effect.map((list) => list.length),
        );
        return { provider, next, publishCount };
      });

    it.effect("records, coalesces and prunes samples across runtime updates", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, publishCount } = yield* makeUsageProvider(probe(10));

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial.usageLimits?.windows, [
            { ...fiveHour(10, R1), history: [{ at: T0, usedPercent: 10 }] },
            { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: W },
          ]);

          yield* provider.applyUsageLimits({ checkedAt: plus(30), windows: [fiveHour(12)] });
          const afterChange = yield* provider.getSnapshot;
          assert.strictEqual(yield* publishCount, 1);
          assert.deepStrictEqual(sessionHistory(afterChange), [
            { at: T0, usedPercent: 10 },
            { at: plus(30), usedPercent: 12 },
          ]);
          assert.strictEqual(afterChange.usageLimits?.windows[0]?.usedPercent, 12);

          // Codex-style repeat inside the heartbeat window publishes nothing.
          yield* provider.applyUsageLimits({ checkedAt: plus(60), windows: [fiveHour(12)] });
          assert.strictEqual(yield* provider.getSnapshot, afterChange);
          assert.strictEqual(yield* publishCount, 1);

          // The same value 65 s after the last sample is a heartbeat sample.
          yield* provider.applyUsageLimits({ checkedAt: plus(95), windows: [fiveHour(12)] });
          const afterHeartbeat = yield* provider.getSnapshot;
          assert.strictEqual(yield* publishCount, 2);
          assert.deepStrictEqual(sessionHistory(afterHeartbeat)?.at(-1), {
            at: plus(95),
            usedPercent: 12,
          });
          assert.strictEqual(afterHeartbeat.usageLimits?.windows[0]?.usedPercent, 12);

          // An update for another window leaves the session list alone.
          yield* provider.applyUsageLimits({
            checkedAt: plus(100),
            windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
          });
          const afterWeekly = yield* provider.getSnapshot;
          assert.strictEqual(yield* publishCount, 3);
          assert.strictEqual(sessionHistory(afterWeekly), sessionHistory(afterHeartbeat));
          assert.strictEqual(afterWeekly.usageLimits?.windows[1]?.history, undefined);

          // A new reset starts a new list.
          yield* provider.applyUsageLimits({ checkedAt: plus(110), windows: [fiveHour(15, R2)] });
          assert.deepStrictEqual(sessionHistory(yield* provider.getSnapshot), [
            { at: plus(110), usedPercent: 15 },
          ]);

          // An update without a reset keeps the stored one, so the list continues.
          yield* provider.applyUsageLimits({ checkedAt: plus(120), windows: [fiveHour(16)] });
          assert.deepStrictEqual(sessionHistory(yield* provider.getSnapshot), [
            { at: plus(110), usedPercent: 15 },
            { at: plus(120), usedPercent: 16 },
          ]);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("never lets a lagging probe pull the published session reading down", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(23));
          yield* provider.applyUsageLimits({ checkedAt: plus(30), windows: [fiveHour(24, R1)] });

          // The probe reads 23 after an event already said 24.
          yield* Ref.set(next, probe(23, { at: plus(90) }));
          const probed = yield* provider.refresh;
          assert.strictEqual(probed.usageLimits?.windows[0]?.usedPercent, 24);
          assert.deepStrictEqual(sessionHistory(probed), [
            { at: T0, usedPercent: 23 },
            { at: plus(30), usedPercent: 24 },
            { at: plus(90), usedPercent: 24 },
          ]);

          yield* provider.applyUsageLimits({ checkedAt: plus(100), windows: [fiveHour(25, R1)] });
          const raised = yield* provider.getSnapshot;
          assert.strictEqual(raised.usageLimits?.windows[0]?.usedPercent, 25);
          assert.deepStrictEqual(sessionHistory(raised)?.at(-1), {
            at: plus(100),
            usedPercent: 25,
          });
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("publishes nothing for runtime events that lag a higher probe", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, publishCount } = yield* makeUsageProvider(probe(24));
          const initial = yield* provider.getSnapshot;

          for (const seconds of [1, 2, 3]) {
            yield* provider.applyUsageLimits({
              checkedAt: plus(seconds),
              windows: [fiveHour(23, R1)],
            });
          }
          assert.strictEqual(yield* publishCount, 0);
          assert.strictEqual(yield* provider.getSnapshot, initial);

          // Another thread's stale reading lags by more than rounding; still nothing.
          yield* provider.applyUsageLimits({ checkedAt: plus(4), windows: [fiveHour(20, R1)] });
          assert.strictEqual(yield* publishCount, 0);
          assert.strictEqual(yield* provider.getSnapshot, initial);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("publishes a probe's real drop and ratchets later events from it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(24));

          // A rolling window aging out (OpenCode Go) shows up on a probe.
          yield* Ref.set(next, probe(20, { at: plus(90) }));
          const dropped = yield* provider.refresh;
          assert.strictEqual(dropped.usageLimits?.windows[0]?.usedPercent, 20);
          assert.deepStrictEqual(sessionHistory(dropped)?.at(-1), {
            at: plus(90),
            usedPercent: 20,
          });

          yield* provider.applyUsageLimits({ checkedAt: plus(100), windows: [fiveHour(18, R1)] });
          assert.strictEqual(
            (yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent,
            20,
          );
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("samples on probes but not on failed or unsupported ones", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(10));
          yield* provider.applyUsageLimits({ checkedAt: plus(30), windows: [fiveHour(12)] });

          yield* Ref.set(next, probe(16, { at: plus(200) }));
          const probed = yield* provider.refresh;
          assert.deepStrictEqual(sessionHistory(probed), [
            { at: T0, usedPercent: 10 },
            { at: plus(30), usedPercent: 12 },
            { at: plus(200), usedPercent: 16 },
          ]);
          assert.strictEqual(probed.usageLimits?.windows[1]?.history, undefined);

          // A failed read keeps the windows and history, and adds no sample.
          yield* Ref.set(next, probe(0, { at: plus(300), failed: true }));
          const failed = yield* provider.refresh;
          assert.deepStrictEqual(failed.usageLimits?.windows, probed.usageLimits?.windows);

          // An unsupported account has no windows, so nothing to keep.
          yield* Ref.set(next, probe(0, { at: plus(400), unsupported: true }));
          const unsupported = yield* provider.refresh;
          assert.deepStrictEqual(unsupported.usageLimits?.windows, []);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    const accountChange = (first: ProbeOptions, second: ProbeOptions) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(10, first));
          for (const [seconds, percent] of [
            [10, 11],
            [20, 12],
            [30, 13],
          ] as const) {
            yield* provider.applyUsageLimits({
              checkedAt: plus(seconds),
              windows: [fiveHour(percent)],
            });
          }
          assert.strictEqual(sessionHistory(yield* provider.getSnapshot)?.length, 4);

          yield* Ref.set(next, probe(5, { ...second, at: plus(100) }));
          assert.deepStrictEqual(sessionHistory(yield* provider.refresh), [
            { at: plus(100), usedPercent: 5 },
          ]);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest));

    it.effect("clears samples when the workspace changes", () =>
      accountChange({ workspaceId: "ws-a" }, { workspaceId: "ws-b" }),
    );

    it.effect("clears samples when the email changes", () =>
      accountChange({ email: "a@x.com" }, { email: "b@x.com" }),
    );

    it.effect("clears samples when two probes report different credential fingerprints", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(10, { fingerprint: "fp-a" }));
          yield* Ref.set(next, probe(10, { fingerprint: "fp-b", at: plus(100) }));
          assert.deepStrictEqual(sessionHistory(yield* provider.refresh), [
            { at: plus(100), usedPercent: 10 },
          ]);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("appends a heartbeat sample for an unchanged value on a later probe", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider, next } = yield* makeUsageProvider(probe(10));
          yield* Ref.set(next, probe(10, { at: plus(300) }));
          const refreshed = yield* provider.refresh;
          assert.deepStrictEqual(sessionHistory(refreshed), [
            { at: T0, usedPercent: 10 },
            { at: plus(300), usedPercent: 10 },
          ]);
          const { history: _history, ...window } = refreshed.usageLimits!.windows[0]!;
          assert.deepStrictEqual(window, fiveHour(10, R1));
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("keeps the newest 400 samples", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { provider } = yield* makeUsageProvider(probe(10));
          for (let call = 1; call <= 405; call += 1) {
            yield* provider.applyUsageLimits({
              checkedAt: plus(call * 61),
              windows: [fiveHour(10 + (call % 2))],
            });
          }
          const history = sessionHistory(yield* provider.getSnapshot)!;
          assert.strictEqual(history.length, 400);
          assert.strictEqual(history[0]?.at, plus(6 * 61));
          assert.strictEqual(history.at(-1)?.at, plus(405 * 61));
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("keeps history on an enrichment derived from a snapshot older than the updates", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseEnrichment = yield* Deferred.make<void>();
          const { provider } = yield* makeUsageProvider(
            probe(10),
            ({ snapshot, publishSnapshot }) =>
              Deferred.await(releaseEnrichment).pipe(
                Effect.flatMap(() =>
                  publishSnapshot({ ...snapshot, models: enrichedSnapshot.models }),
                ),
              ),
          );
          yield* provider.applyUsageLimits({ checkedAt: plus(10), windows: [fiveHour(12)] });
          yield* provider.applyUsageLimits({ checkedAt: plus(80), windows: [fiveHour(14)] });

          yield* Deferred.succeed(releaseEnrichment, undefined);
          const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)[0]!),
          );
          assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
          assert.deepStrictEqual(sessionHistory(enriched), [
            { at: T0, usedPercent: 10 },
            { at: plus(10), usedPercent: 12 },
            { at: plus(80), usedPercent: 14 },
          ]);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );

    it.effect("creates windows and samples when the snapshot had no usage limits yet", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { usageLimits: _none, ...withoutLimits } = probe(10);
          const { provider } = yield* makeUsageProvider(withoutLimits);
          yield* provider.applyUsageLimits({ checkedAt: plus(10), windows: [fiveHour(30, R1)] });
          assert.deepStrictEqual(sessionHistory(yield* provider.getSnapshot), [
            { at: plus(10), usedPercent: 30 },
          ]);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
    );
  });
});
