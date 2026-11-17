import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { setMcpAppServerHidden } from "./hiddenMcpAppServers.ts";

describe("setMcpAppServerHidden", () => {
  it("builds each write from the previous write's result", async () => {
    const patches: Array<ReadonlyArray<string>> = [];
    const releases: Array<() => void> = [];
    const started: Array<() => void> = [];
    const startedPromises = [0, 1].map(() => new Promise<void>((resolve) => started.push(resolve)));
    const request = (server: string) =>
      setMcpAppServerHidden({
        environmentId: "env-1" as EnvironmentId,
        server,
        hidden: true,
        readCurrent: () => [],
        write: (list) =>
          new Promise((resolve) => {
            patches.push(list);
            releases.push(() => resolve(AsyncResult.success({ hiddenMcpAppServers: list })));
            started[patches.length - 1]!();
          }),
      });
    const first = request("a");
    const second = request("b");
    await startedPromises[0];
    expect(patches).toEqual([["a"]]);
    releases[0]!();
    await startedPromises[1];
    expect(patches[1]).toEqual(["a", "b"]);
    releases[1]!();
    await expect(first).resolves.toEqual({ _tag: "Applied" });
    await expect(second).resolves.toEqual({ _tag: "Applied" });
  });
});
