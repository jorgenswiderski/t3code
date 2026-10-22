import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "./ClaudeModelCatalog.ts";
import { claudeThreadAutoCompactCapability, makePendingClaudeProvider } from "./ClaudeProvider.ts";

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
