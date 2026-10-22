import { ProviderInstanceId, type ServerProviderThreadAutoCompact } from "@t3tools/contracts";
import { deriveThreadAutoCompactView } from "@t3tools/client-runtime/thread-auto-compact";
import { describe, expect, it } from "vite-plus/test";

import {
  appliedAutoCompactFromProjection,
  presentAutoCompactControl,
  resolveCreationAutoCompactTokens,
  resolveCustomCommit,
  resolveSegmentAction,
} from "./thread-auto-compact-presentation";

const capability: ServerProviderThreadAutoCompact = { minTokens: 100_000, maxTokens: 1_000_000 };

function present(input: {
  stored?: number | null;
  applied?: { tokens: number | null } | null;
  windowTokens?: number | null;
  customOpen?: boolean;
  canEdit?: boolean;
}) {
  const view = deriveThreadAutoCompactView({
    capability,
    providerDisplayName: "Claude",
    stored: input.stored ?? null,
    applied: input.applied ?? null,
    windowTokens: input.windowTokens === undefined ? 1_000_000 : input.windowTokens,
  });
  if (view === null) throw new Error("expected a view");
  return presentAutoCompactControl({
    view,
    customOpen: input.customOpen ?? false,
    canEdit: input.canEdit ?? true,
  });
}

describe("presentAutoCompactControl", () => {
  it("shows Default selected with five ordered segments and no status when nothing is stored", () => {
    const model = present({});
    expect(model.selected).toBe("default");
    expect(model.options.map((option) => option.label)).toEqual([
      "Default",
      "200k",
      "300k",
      "400k",
      "Custom…",
    ]);
    expect(model.options.every((option) => !option.disabled)).toBe(true);
    expect(model.statusText).toBeNull();
    expect(model.customInput.visible).toBe(false);
  });

  it("selects the stored preset and shows the status line", () => {
    const model = present({ stored: 300_000 });
    expect(model.selected).toBe(300_000);
    expect(model.statusText).toBe("This thread compacts at 300k (default: Claude default).");
  });

  it("selects Custom with the stored value prefilled", () => {
    const model = present({ stored: 250_000 });
    expect(model.selected).toBe("custom");
    expect(model.customInput).toEqual({ visible: true, initialText: "250k" });
  });

  it("opens an empty Custom input when tapped with nothing stored", () => {
    const model = present({ customOpen: true });
    expect(model.selected).toBe("custom");
    expect(model.customInput).toEqual({ visible: true, initialText: "" });
  });

  it("disables presets at or above a smaller model window", () => {
    const model = present({ windowTokens: 200_000 });
    const disabled = Object.fromEntries(model.options.map((o) => [o.label, o.disabled]));
    expect(disabled).toEqual({
      Default: false,
      "200k": true,
      "300k": true,
      "400k": true,
      "Custom…": false,
    });
  });

  it("keeps a stored value at or above the window and explains it", () => {
    const model = present({ stored: 300_000, windowTokens: 200_000 });
    expect(model.selected).toBe(300_000);
    expect(model.statusText).toBe(
      "300k is at or above this model's window, so this thread uses the default (Claude default).",
    );
  });

  it("shows the pending form when the applied value differs", () => {
    const model = present({ stored: 300_000, applied: { tokens: null } });
    expect(model.statusText).toBe(
      "300k · applies after the session restarts. Currently compacts at Claude default.",
    );
  });

  it("disables every segment without the operate scope", () => {
    const model = present({ canEdit: false });
    expect(model.options.every((option) => option.disabled)).toBe(true);
  });
});

describe("resolveSegmentAction", () => {
  it("maps segments to actions", () => {
    expect(resolveSegmentAction("default")).toEqual({ kind: "set", tokens: null });
    expect(resolveSegmentAction(300_000)).toEqual({ kind: "set", tokens: 300_000 });
    expect(resolveSegmentAction("custom")).toEqual({ kind: "open-custom" });
  });
});

describe("resolveCustomCommit", () => {
  const base = { capability, windowTokens: 1_000_000 as number | null, stored: null };

  it("commits a new valid value", () => {
    expect(resolveCustomCommit({ ...base, text: "350k" })).toEqual({
      kind: "set",
      tokens: 350_000,
    });
  });

  it("reports unchanged when the value equals the stored one", () => {
    expect(resolveCustomCommit({ ...base, text: "350k", stored: 350_000 })).toEqual({
      kind: "unchanged",
    });
  });

  it.each(["", "abc", "-5"])("rejects %j as not a number", (text) => {
    expect(resolveCustomCommit({ ...base, text })).toEqual({
      kind: "invalid",
      message: "Enter a number of tokens, like 250k.",
    });
  });

  it.each(["0", "99k", "2M"])("rejects %j as out of range", (text) => {
    expect(resolveCustomCommit({ ...base, text })).toEqual({
      kind: "invalid",
      message: "Enter a value from 100k to 1M.",
    });
  });

  it("rejects a value at or above the model window", () => {
    expect(resolveCustomCommit({ ...base, text: "300k", windowTokens: 200_000 })).toEqual({
      kind: "invalid",
      message: "Must be below this model's 200k window.",
    });
  });
});

describe("appliedAutoCompactFromProjection", () => {
  const projection = (activeId: string | null, providerThreads: ReadonlyArray<unknown>) =>
    ({
      thread: { activeProviderThreadId: activeId },
      providerThreads,
    }) as unknown as Parameters<typeof appliedAutoCompactFromProjection>[0];

  it("returns the active provider thread's report", () => {
    expect(
      appliedAutoCompactFromProjection(
        projection("pt-2", [
          { id: "pt-1", appliedAutoCompact: { tokens: 100_000 } },
          { id: "pt-2", appliedAutoCompact: { tokens: 300_000 } },
        ]),
      ),
    ).toEqual({ tokens: 300_000 });
  });

  it("returns null without a projection, an active thread, or a report", () => {
    expect(appliedAutoCompactFromProjection(null)).toBeNull();
    expect(
      appliedAutoCompactFromProjection(
        projection(null, [{ id: "pt-1", appliedAutoCompact: { tokens: 1 } }]),
      ),
    ).toBeNull();
    expect(appliedAutoCompactFromProjection(projection("pt-1", [{ id: "pt-1" }]))).toBeNull();
  });
});

describe("resolveCreationAutoCompactTokens", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const other = ProviderInstanceId.make("opencode");
  const providers = [
    { instanceId: claude, threadAutoCompact: capability },
    { instanceId: other, threadAutoCompact: undefined },
  ];

  it("passes the draft value for a provider with the capability", () => {
    expect(
      resolveCreationAutoCompactTokens({ draftTokens: 300_000, instanceId: claude, providers }),
    ).toBe(300_000);
  });

  it("drops it for a provider without the capability or not in the list", () => {
    expect(
      resolveCreationAutoCompactTokens({ draftTokens: 300_000, instanceId: other, providers }),
    ).toBeUndefined();
    expect(
      resolveCreationAutoCompactTokens({
        draftTokens: 300_000,
        instanceId: ProviderInstanceId.make("missing"),
        providers,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a null or missing draft value", () => {
    expect(
      resolveCreationAutoCompactTokens({ draftTokens: null, instanceId: claude, providers }),
    ).toBeUndefined();
    expect(
      resolveCreationAutoCompactTokens({ draftTokens: undefined, instanceId: claude, providers }),
    ).toBeUndefined();
  });
});
