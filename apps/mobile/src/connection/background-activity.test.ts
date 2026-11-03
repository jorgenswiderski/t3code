import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const releasePassive = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace", includeRemote: false },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* releasePassive;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("reports an open thread subscription as a thread scope", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-thread-scope-environment");
      const threadId = ThreadId.make("thread-1");
      const input = { threadId, afterSequence: 4 };
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        input,
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        input,
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "thread", threadId }]);

      yield* releaseFirst;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "thread", threadId }]);

      yield* releaseSecond;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );
});
