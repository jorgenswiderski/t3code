import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection ticketTrackerUpdated", () => {
  const payload = () => ({
    ticketPriorityScale: [
      { id: "1", name: "Highest" },
      { id: "2", name: "High" },
    ],
    jiraStatus: {
      state: "connected" as const,
      siteUrl: "https://acme.atlassian.net",
      accountName: "Ada Lovelace",
      error: null,
    },
  });
  const apply = (config: ServerConfig) =>
    applyServerConfigProjection(
      Option.some({ config, latestEvent: {} as ServerConfigStreamEvent, source: "live" as const }),
      { version: 1, type: "ticketTrackerUpdated", payload: payload() } as ServerConfigStreamEvent,
    ).pipe(Option.getOrThrow);

  it("writes the scale and status", () => {
    const next = apply({} as ServerConfig);
    expect(next.config.ticketPriorityScale).toEqual(payload().ticketPriorityScale);
    expect(next.config.jiraStatus).toEqual(payload().jiraStatus);
    expect(next.source).toBe("live");
  });

  it("keeps both objects when an update repeats them", () => {
    const first = apply({} as ServerConfig).config;
    const second = apply(first).config;
    expect(second.ticketPriorityScale).toBe(first.ticketPriorityScale);
    expect(second.jiraStatus).toBe(first.jiraStatus);
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });

  it("keeps the settings object when an update repeats the current settings", () => {
    const wire = encodeSettings(DEFAULT_SERVER_SETTINGS);
    const decode = () => decodeSettings(structuredClone(wire));
    const settings = decode();
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: { settings: decode() },
    } as ServerConfigStreamEvent);
    expect(Option.getOrThrow(next).config).toBe(Option.getOrThrow(current).config);
  });
});
