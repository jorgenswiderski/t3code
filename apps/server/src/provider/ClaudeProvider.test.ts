import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "./ClaudeModelCatalog.ts";
import {
  checkClaudeProviderStatus,
  claudeThreadAutoCompactCapability,
  makePendingClaudeProvider,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

describe("claudeThreadAutoCompactCapability", () => {
  it("advertises the range without a default when the instance setting is empty", () => {
    const capability = claudeThreadAutoCompactCapability(decodeClaudeSettings({}));
    assert.deepEqual(capability, { minTokens: 100_000, maxTokens: 967_000 });
    assert.isFalse("defaultTokens" in capability);
  });

  it.each([
    ["300000", 300_000],
    ["1000000", 967_000],
    ["990000", 967_000],
    ["100000", 100_000],
  ])("uses instance %s as default %d", (autoCompactWindow, defaultTokens) => {
    assert.deepEqual(
      claudeThreadAutoCompactCapability(decodeClaudeSettings({ autoCompactWindow })),
      {
        minTokens: 100_000,
        maxTokens: 967_000,
        defaultTokens,
      },
    );
  });
});

describe("makePendingClaudeProvider", () => {
  const settingsWith300k = decodeClaudeSettings({ autoCompactWindow: "300000" });

  it.effect.each([true, false])("advertises threadAutoCompact when enabled=%s", (enabled) =>
    Effect.gen(function* () {
      const draft = yield* makePendingClaudeProvider({ ...settingsWith300k, enabled });
      assert.deepEqual(draft.threadAutoCompact, {
        minTokens: 100_000,
        maxTokens: 967_000,
        defaultTokens: 300_000,
      });
    }),
  );

  it.effect("carries catalog context windows on built-in models only", () =>
    Effect.gen(function* () {
      const draft = yield* makePendingClaudeProvider({
        ...settingsWith300k,
        customModels: ["custom-claude-x"],
      });
      const opus = draft.models.find((model) => model.slug === "claude-opus-5-5");
      assert.equal(
        opus?.contextWindowTokens,
        resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        }),
      );
      const custom = draft.models.find((model) => model.slug === "custom-claude-x");
      assert.isDefined(custom);
      assert.isFalse("contextWindowTokens" in (custom ?? {}));
    }),
  );
});

const encoder = new TextEncoder();

/** Answers `claude --version` so the status check reaches the ready snapshot. */
const versionOnlySpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) => {
    const args = (command as unknown as { args: ReadonlyArray<string> }).args;
    if (args.join(" ") !== "--version") throw new Error(`Unexpected args: ${args.join(" ")}`);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode("1.0.0\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  }),
);

const authenticatedCapabilities = () =>
  Effect.succeed({
    email: undefined,
    subscriptionType: undefined,
    tokenSource: undefined,
    apiKeySource: undefined,
    apiProvider: undefined,
    slashCommands: [],
  });

const bundledWindow = (model: string) =>
  resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model,
  });

describe("checkClaudeProviderStatus", () => {
  it.effect("ready snapshot advertises threadAutoCompact and catalog windows", () =>
    Effect.gen(function* () {
      const status = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({ autoCompactWindow: "300000" }),
        authenticatedCapabilities,
      );
      assert.equal(status.status, "ready");
      assert.deepEqual(status.threadAutoCompact, {
        minTokens: 100_000,
        maxTokens: 967_000,
        defaultTokens: 300_000,
      });
      const haiku = status.models.find((model) => model.slug === "claude-haiku-4-5");
      assert.isDefined(bundledWindow("claude-haiku-4-5"));
      assert.equal(haiku?.contextWindowTokens, bundledWindow("claude-haiku-4-5"));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, versionOnlySpawner))),
  );

  it.effect("takes windows from the bundled catalog the adapter uses, not the runtime one", () =>
    Effect.gen(function* () {
      // A remote catalog can disagree with the bundled one. The adapter resolves
      // windows from the bundled catalog, so clients must too, or a stored
      // threshold reads as effective on one side and ineffective on the other.
      const runtimeCatalog = {
        models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) =>
          entry.model.slug === "claude-haiku-4-5"
            ? { ...entry, runtime: { ...entry.runtime, fixedContextWindowTokens: 400_000 } }
            : entry,
        ),
      };
      const status = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({}),
        authenticatedCapabilities,
        undefined,
        undefined,
        runtimeCatalog,
      );
      const haiku = status.models.find((model) => model.slug === "claude-haiku-4-5");
      assert.notEqual(bundledWindow("claude-haiku-4-5"), 400_000);
      assert.equal(haiku?.contextWindowTokens, bundledWindow("claude-haiku-4-5"));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, versionOnlySpawner))),
  );
});
