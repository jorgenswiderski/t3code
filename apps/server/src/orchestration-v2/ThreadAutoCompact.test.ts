import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const makeAdapter = (id: ProviderInstanceId) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for thread settings"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerProjectionStore = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
const layerTest = Layer.mergeAll(
  layerDatabase,
  layerProjectionStore,
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDatabase,
        layerProjectionStore,
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
      ),
    ),
  ),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-auto-compact" },
    ProviderAdapterRegistry.layerFromAdapters([
      makeAdapter(instanceId),
      makeAdapter(alternateInstanceId),
    ]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId, autoCompactTokens?: number | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("project:auto-compact"),
      title: "Auto-compact",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const readValues = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* projections.getThreadProjection(threadId);
    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    return { thread: projection.thread.autoCompactTokens, shell: shell.autoCompactTokens };
  });

const setValue = (threadId: ThreadId, autoCompactTokens: number | null, suffix: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.auto-compact.set",
      commandId: CommandId.make(`${threadId}:auto-compact:${suffix}`),
      threadId,
      autoCompactTokens,
    });
  });

it.layer(layerTest)("per-thread auto-compact", (it) => {
  it.effect("creates a thread with a stored auto-compact value", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:auto-compact-create");
      yield* createThread(threadId, 300_000);
      assert.deepEqual(yield* readValues(threadId), { thread: 300_000, shell: 300_000 });
    }),
  );

  it.effect("defaults to null when thread.create omits it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:auto-compact-default");
      yield* createThread(threadId);
      assert.deepEqual(yield* readValues(threadId), { thread: null, shell: null });
    }),
  );

  it.effect("sets, changes and clears the value", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:auto-compact-set");
      yield* createThread(threadId);
      for (const [index, value] of [200_000, 400_000, null].entries()) {
        const result = yield* setValue(threadId, value, String(index));
        const events = result.storedEvents.filter(
          (stored) => stored.event.type === "thread.auto-compact-updated",
        );
        assert.equal(events.length, 1);
        const event = events[0]!.event;
        assert.ok(event.type === "thread.auto-compact-updated");
        assert.equal(event.payload.autoCompactTokens, value);
        assert.deepEqual(yield* readValues(threadId), { thread: value, shell: value });
      }
    }),
  );

  it.effect("keeps the value across model and provider switches", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:auto-compact-switch");
      yield* createThread(threadId, 300_000);
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:model`),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      assert.deepEqual(yield* readValues(threadId), { thread: 300_000, shell: 300_000 });
      const switched = yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:provider`),
        threadId,
        modelSelection: { instanceId: alternateInstanceId, model: "gpt-5.5" },
      });
      assert.deepEqual(
        switched.storedEvents.map((stored) => stored.event.type),
        ["thread.provider-switched"],
      );
      assert.deepEqual(yield* readValues(threadId), { thread: 300_000, shell: 300_000 });
    }),
  );

  it.effect("projects a pre-change row as Default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:auto-compact-legacy-row");
      yield* createThread(threadId);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(payload_json, '$.autoCompactTokens')
        WHERE thread_id = ${threadId}
      `;
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      assert.notInclude(rows[0]!.payload_json, "autoCompactTokens");
      const values = yield* readValues(threadId);
      assert.equal(values.thread ?? null, null);
      assert.equal(values.shell, null);
    }),
  );

  it.effect("rejects the command on a deleted thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:auto-compact-deleted");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`${threadId}:delete`),
        threadId,
      });
      const exit = yield* Effect.exit(setValue(threadId, 200_000, "after-delete"));
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("a projection rebuild and event-store compaction keep the value", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("thread:auto-compact-maintenance");
      yield* createThread(threadId);
      yield* setValue(threadId, 200_000, "first");
      yield* setValue(threadId, 300_000, "second");

      yield* maintenance.rebuild;
      assert.deepEqual(yield* readValues(threadId), { thread: 300_000, shell: 300_000 });

      yield* maintenance.compactEventStore;
      const remaining = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'thread.auto-compact-updated'
      `;
      assert.equal(remaining.length, 1);
      assert.include(remaining[0]!.payload_json, "300000");

      yield* maintenance.rebuild;
      assert.deepEqual(yield* readValues(threadId), { thread: 300_000, shell: 300_000 });
    }),
  );
});
