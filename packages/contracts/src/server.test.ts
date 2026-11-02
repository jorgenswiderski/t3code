import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";
import {
  OtlpEndpointCheckInput,
  resolveEnvironmentMachineKind,
  ServerObservability,
  ServerProvider,
  ServerProviders,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviderUsageWindow = Schema.decodeUnknownSync(ServerProviderUsageWindow);
const encodeServerProviderUsageWindow = Schema.encodeSync(ServerProviderUsageWindow);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("preserves installed-version presence through the provider wire codec", () => {
    const encode = Schema.encodeSync(ServerProvider);
    for (const installation of [{}, { installedVersion: null }, { installedVersion: "1.2.3" }]) {
      const decoded = decodeServerProvider({ ...baseProviderSnapshot, ...installation });
      const wire = JSON.parse(JSON.stringify(encode(decoded)));
      expect(wire).toMatchObject({ version: "1.0.0", ...installation });
      expect(Object.hasOwn(wire, "installedVersion")).toBe(
        Object.hasOwn(installation, "installedVersion"),
      );
      expect(decodeServerProvider(wire)).toEqual(decoded);
    }
  });
});

describe("server config forward compatibility", () => {
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });

  it("decodes a session window with and without usage history", () => {
    const history = [
      { at: "2026-10-11T10:00:00.000Z", usedPercent: 10 },
      { at: "2026-10-11T10:05:00.000Z", usedPercent: 12 },
    ];
    const sessionWindow = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 12,
      history,
    };
    const weeklyWindow = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20 };

    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-10-11T10:05:00.000Z",
        windows: [sessionWindow, weeklyWindow],
      },
    });

    const decodedWindows = parsed.usageLimits?.windows ?? [];
    expect(decodedWindows.find((window) => window.id === "five_hour")?.history).toEqual(history);
    const decodedWeekly = decodedWindows.find((window) => window.id === "seven_day");
    expect(decodedWeekly).toEqual(weeklyWindow);
    expect(decodedWeekly).not.toHaveProperty("history");
    expect(encodeServerProviderUsageWindow(decodeServerProviderUsageWindow(sessionWindow))).toEqual(
      sessionWindow,
    );
  });

  it("drops a session window whose history sample is out of range without dropping its siblings", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-10-11T10:05:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 12,
            history: [{ at: "2026-10-11T10:00:00.000Z", usedPercent: 120 }],
          },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 20 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows.map((window) => window.id)).toEqual(["seven_day"]);
  });
});

describe("ServerObservability", () => {
  const decodeServerObservability = Schema.decodeUnknownSync(ServerObservability);

  it("rejects an unknown endpoint source", () => {
    expect(() =>
      decodeServerObservability({
        logsDirectoryPath: "/tmp/t3/logs",
        localTracingEnabled: true,
        otlpTracesUrl: "https://collector.example.com/v1/traces",
        otlpTracesSource: "cli",
        otlpTracesEnabled: true,
        otlpMetricsEnabled: false,
      }),
    ).toThrow();
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});

describe("OtlpEndpointCheckInput", () => {
  const decode = Schema.decodeUnknownSync(OtlpEndpointCheckInput);

  it("accepts HTTP receivers only", () => {
    expect(decode({ signal: "traces", url: "https://collector.example.com/v1/traces" }).url).toBe(
      "https://collector.example.com/v1/traces",
    );
    for (const url of ["data:text/plain,ok", "file:///etc/hosts", "collector:4318/v1/traces"]) {
      expect(() => decode({ signal: "traces", url })).toThrow();
    }
  });
});

describe("ServerProvider.threadAutoCompact", () => {
  it("a provider without threadAutoCompact decodes (older servers)", () => {
    expect(decodeServerProvider(baseProviderSnapshot).threadAutoCompact).toBeUndefined();
  });

  it("decodes threadAutoCompact with and without defaultTokens", () => {
    const withoutDefault = { minTokens: 100000, maxTokens: 1000000 };
    const withDefault = { ...withoutDefault, defaultTokens: 300000 };
    expect(
      decodeServerProvider({ ...baseProviderSnapshot, threadAutoCompact: withoutDefault })
        .threadAutoCompact,
    ).toEqual(withoutDefault);
    expect(
      decodeServerProvider({ ...baseProviderSnapshot, threadAutoCompact: withDefault })
        .threadAutoCompact,
    ).toEqual(withDefault);
  });

  it("rejects a zero minTokens", () => {
    expect(() =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        threadAutoCompact: { minTokens: 0, maxTokens: 1000000 },
      }),
    ).toThrow();
  });
});
