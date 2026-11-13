import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
  it.effect("invalidates cached usage and queues one refresh behind an in-flight refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const cache = yield* Cache.makeWith(
          () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (count === 2) {
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
              }
              return {
                ...refreshedSnapshot,
                usageLimits: {
                  checkedAt: refreshedSnapshot.checkedAt,
                  windows: [
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: count === 1 ? 20 : 100,
                    },
                  ],
                },
              } satisfies ServerProvider;
            }),
          { capacity: 1, timeToLive: () => "5 minutes" },
        );
        const warmed = yield* Cache.get(cache, "claude");
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.die("usage refresh must not resolve maintenance"),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(warmed),
          checkProvider: Cache.get(cache, "claude"),
          invalidateUsageCache: Cache.invalidateAll(cache),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        assert.strictEqual(yield* Ref.get(calls), 1);
        const refresh = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(probeStarted);
        const queued = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* provider.refreshUsage!;
        assert.strictEqual(yield* Ref.get(calls), 2);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 20);
        yield* Deferred.succeed(releaseProbe, undefined);
        yield* Fiber.join(refresh);
        yield* Fiber.join(queued);
        assert.strictEqual(yield* Ref.get(calls), 3);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 100);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect("keeps the waiting usage refresh's claim when the running one is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const usageProbeStarted = yield* Deferred.make<void>();
        const statusProbeStarted = yield* Deferred.make<void>();
        const releaseStatusProbe = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
            if (count === 2) {
              yield* Deferred.succeed(usageProbeStarted, undefined);
              return yield* Effect.never;
            }
            if (count === 3) {
              yield* Deferred.succeed(statusProbeStarted, undefined);
              yield* Deferred.await(releaseStatusProbe);
            }
            return {
              ...refreshedSnapshot,
              usageLimits: { checkedAt: refreshedSnapshot.checkedAt, windows: [] },
            } satisfies ServerProvider;
          }),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        const running = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(usageProbeStarted);
        const status = yield* provider.refresh.pipe(Effect.forkChild({ startImmediately: true }));
        const waiting = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(running);
        yield* Deferred.await(statusProbeStarted);
        const extra = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseStatusProbe, undefined);
        yield* Fiber.join(status);
        yield* Fiber.join(waiting);
        yield* Fiber.join(extra);
        assert.strictEqual(yield* Ref.get(calls), 4);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
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
          refreshOnInterval: () => true,
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
    ).pipe(
      Effect.provide(
        Layer.mergeAll(layerProviderHost({ runBackgroundWork: false }), TestClock.layer()),
      ),
    ),
  );

  it.effect("stops periodic recovery checks once the snapshot is ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const failedSnapshot = { ...refreshedSnapshot, status: "error" as const };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: (snapshot) => snapshot.status === "error",
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseInitialCheck).pipe(
            Effect.andThen(Ref.updateAndGet(checkCalls, (count) => count + 1)),
            Effect.map((count) => (count === 1 ? failedSnapshot : refreshedSnapshot)),
          ),
          refreshInterval: "1 second",
        });
        const updates = yield* provider.streamChanges.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* TestClock.adjust("1 second");

        assert.deepStrictEqual(Array.from(yield* Fiber.join(updates)), [
          failedSnapshot,
          refreshedSnapshot,
        ]);
        yield* TestClock.adjust("3 seconds");
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("samples usage history when a periodic usage check recovers a failed probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recovered = {
          checkedAt: "2026-04-10T00:00:05.000Z",
          windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [],
              unavailable: { reason: "probeFailed", message: "Usage probe timed out." },
            },
          }),
          checkUsageLimits: Effect.succeed(recovered),
          refreshInterval: "1 second",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        yield* TestClock.adjust("1 second");

        assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits, {
          ...recovered,
          windows: [
            { ...recovered.windows[0], history: [{ at: recovered.checkedAt, usedPercent: 10 }] },
          ],
        });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
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

  it.effect("keeps consuming settings changes after a provider check fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const thirdCheckStarted = yield* Deferred.make<void>();
        const releaseRecoveredCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : count === 2
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "/t3/userdata/settings.json",
                        operation: "read-file",
                      }),
                    )
                  : Deferred.succeed(thirdCheckStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRecoveredCheck)),
                      Effect.as(refreshedSnapshotSecond),
                    ),
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

        // The first change fails its provider check; the failed application never
        // advances the stored settings, so the same change still differs next time.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        // The subscription must survive that failure and retry on the next change;
        // on main the dead consumer never starts the third check and this times out.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.await(thirdCheckStarted);
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
        yield* Deferred.succeed(releaseRecoveredCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(yield* provider.getSnapshot, refreshedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
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

        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
          authLabel: "tier-1",
        });
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:06:00.000Z",
          windows: [],
          authLabel: "tier-2",
        });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.strictEqual(update?.auth.label, "tier-1");
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

  it.effect.each([
    { name: "a live plan", clearPlan: false },
    { name: "a cleared plan", clearPlan: true },
  ])("keeps $name and usage across a failed probe and stale enrichment", ({ clearPlan }) =>
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
                    auth: { ...refreshedSnapshot.auth, workspaceId: "ws-a", label: "tier-1" },
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
          authLabel: "tier-2",
          windows: [liveWindow],
        });

        if (clearPlan) {
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:00:02.000Z",
            complete: true,
            windows: [liveWindow],
          });
        }

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
        assert.strictEqual(enriched.auth.label, clearPlan ? undefined : "tier-2");

        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindowWithHistory]);
        // ...and the workspace they were read for.
        assert.strictEqual(refreshed.auth.workspaceId, "ws-a");
        assert.strictEqual(refreshed.auth.label, clearPlan ? undefined : "tier-2");

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

  it.effect.each([
    { name: "an empty reading", hasUsage: true, clearPlan: false },
    { name: "no reading", hasUsage: false, clearPlan: false },
    { name: "an empty reading after clearing the plan", hasUsage: true, clearPlan: true },
    { name: "no reading after clearing the plan", hasUsage: false, clearPlan: true },
  ])("keeps the live plan and limits after $name", ({ hasUsage, clearPlan }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.gen(function* () {
            if ((yield* Ref.updateAndGet(count, (n) => n + 1)) > 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return {
              ...refreshedSnapshot,
              auth: { status: "authenticated", label: "tier-1" },
              ...(hasUsage
                ? { usageLimits: { checkedAt: refreshedSnapshot.checkedAt, windows: [] } }
                : {}),
            } satisfies ServerProvider;
          }),
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        const refresh = yield* provider.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:04.000Z",
          authLabel: "tier-2",
          complete: true,
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
        });
        if (clearPlan) {
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:00:04.000Z",
            complete: true,
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
          });
        }
        yield* Deferred.succeed(release, undefined);
        const refreshed = yield* Fiber.join(refresh);
        assert.strictEqual(refreshed.auth.label, clearPlan ? undefined : "tier-2");
        assert.strictEqual(refreshed.usageLimits?.windows[0]?.usedPercent, 70);
        assert.strictEqual(refreshed.usageLimits?.unavailable, undefined);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("drops an earlier plan override after a complete reading without a label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const usageLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({ ...refreshedSnapshot, usageLimits }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        yield* provider.applyUsageLimits({ ...usageLimits, complete: true, authLabel: "tier-2" });
        assert.strictEqual((yield* provider.refresh).auth.label, "tier-2");

        yield* provider.applyUsageLimits({ ...usageLimits, complete: true });
        assert.strictEqual((yield* provider.getSnapshot).auth.label, undefined);
        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.auth.label, undefined);
        assert.deepStrictEqual(refreshed.usageLimits, {
          ...usageLimits,
          windows: [
            {
              ...usageLimits.windows[0],
              history: [{ at: usageLimits.checkedAt, usedPercent: 70 }],
            },
          ],
        });
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("a complete reading that matches the probe still drops the probe's plan label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const usageLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, label: "Pro" },
            usageLimits,
          }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        assert.strictEqual((yield* provider.getSnapshot).auth.label, "Pro");

        yield* provider.applyUsageLimits({ ...usageLimits, complete: true });
        assert.strictEqual((yield* provider.refresh).auth.label, undefined);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps sparse usage unavailable after probe failure until a full probe recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Usage probe timed out." },
        } as const;
        const probeSnapshot = yield* Ref.make<ServerProvider>({
          ...refreshedSnapshot,
          usageLimits: failedLimits,
        });
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.get(probeSnapshot),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const weekly = {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 20,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
        });
        const partial = yield* provider.getSnapshot;
        assert.deepStrictEqual(partial.usageLimits, {
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
          unavailable: failedLimits.unavailable,
        });
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:03.000Z",
          windows: [{ ...weekly }],
        });
        assert.strictEqual(yield* provider.getSnapshot, partial);
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, failedLimits);

        const completeLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            { ...weekly, usedPercent: 25 },
          ],
        } as const;
        yield* Ref.set(probeSnapshot, { ...refreshedSnapshot, usageLimits: completeLimits });
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, {
          ...completeLimits,
          windows: [
            {
              ...completeLimits.windows[0],
              history: [{ at: completeLimits.checkedAt, usedPercent: 10 }],
            },
            completeLimits.windows[1],
          ],
        });
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
