import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const writes = vi.hoisted(() => ({
  patches: [] as Array<ReadonlyArray<string>>,
  releases: [] as Array<() => void>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => undefined,
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    request: { input: { patch: { hiddenMcpAppServers: ReadonlyArray<string> } } },
  ) =>
    new Promise((resolve) => {
      const list = request.input.patch.hiddenMcpAppServers;
      writes.patches.push(list);
      writes.releases.push(() =>
        resolve({ _tag: "Success", value: { hiddenMcpAppServers: list } }),
      );
    }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => "settings", updateSettings: "update" },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { setMcpAppServerHidden } from "./hiddenMcpAppServers";

describe("setMcpAppServerHidden", () => {
  it("builds each write from the previous write's result", async () => {
    const environmentId = "env-1" as EnvironmentId;
    const first = setMcpAppServerHidden(environmentId, "a", true);
    const second = setMcpAppServerHidden(environmentId, "b", true);
    await vi.waitFor(() => expect(writes.patches).toHaveLength(1));
    writes.releases[0]!();
    await first;
    await vi.waitFor(() => expect(writes.patches).toHaveLength(2));
    expect(writes.patches[1]).toEqual(["a", "b"]);
    writes.releases[1]!();
    await second;
  });
});
