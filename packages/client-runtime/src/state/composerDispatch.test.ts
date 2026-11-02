import { describe, expect, it } from "vite-plus/test";

import { composerDispatchModeForMessage } from "./composerDispatch.ts";

describe("composerDispatchModeForMessage", () => {
  const compact = { text: " /Compact ", attachmentCount: 0 };

  it("queues a /compact that would otherwise steer or restart the running turn", () => {
    expect(composerDispatchModeForMessage("steer", compact)).toBe("queue");
    expect(composerDispatchModeForMessage("restart", compact)).toBe("queue");
    expect(composerDispatchModeForMessage("queue", compact)).toBe("queue");
  });

  it("leaves idle sends, prompts, and /compact with attachments alone", () => {
    expect(composerDispatchModeForMessage("auto", compact)).toBe("auto");
    expect(
      composerDispatchModeForMessage("steer", { text: "/compact now", attachmentCount: 0 }),
    ).toBe("steer");
    expect(composerDispatchModeForMessage("steer", { text: "/compact", attachmentCount: 1 })).toBe(
      "steer",
    );
  });
});
