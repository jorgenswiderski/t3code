import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });

  describe("unifiedWindows", () => {
    // The pinned SDK typings do not declare `unifiedWindows`.
    const info = (extra: object) => ({ status: "allowed", ...extra }) as SDKRateLimitInfo;
    const byId = (update: ReturnType<typeof claudeRateLimitEventToUpdate>) =>
      [...(update?.windows ?? [])].toSorted((a, b) => a.id.localeCompare(b.id));
    const fiveHour = (usedPercent: number, resetsAt?: string): ServerProviderUsageWindow => ({
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
    const sevenDay = (usedPercent: number, resetsAt?: string): ServerProviderUsageWindow => ({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 10080,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
    const both = {
      five_hour: { utilization: 0.44, resetsAt: 1791744000 },
      seven_day: { utilization: 0.92, resetsAt: 1791828000 },
    };

    it("updates both windows from an event that names one and carries no top-level utilization", () => {
      // verbatim from provider events log, 2026-10-10
      const logged = {
        status: "allowed",
        resetsAt: 1791654000,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.02, resetsAt: 1791654000 },
          seven_day: { utilization: 0.62, resetsAt: 1791828000 },
        },
      };
      expect(byId(claudeRateLimitEventToUpdate(info(logged), noNames))).toEqual([
        fiveHour(2, "2026-10-10T17:40:00.000Z"),
        sevenDay(62, "2026-10-12T18:00:00.000Z"),
      ]);
    });

    it("lists the window the event does not name", () => {
      expect(
        byId(
          claudeRateLimitEventToUpdate(
            info({
              status: "allowed_warning",
              resetsAt: 1791828000,
              rateLimitType: "seven_day",
              utilization: 0.92,
              unifiedWindows: both,
            }),
            noNames,
          ),
        ),
      ).toEqual([
        fiveHour(44, "2026-10-11T18:40:00.000Z"),
        sevenDay(92, "2026-10-12T18:00:00.000Z"),
      ]);
    });

    it("prefers the unified entry over the top-level utilization", () => {
      expect(
        byId(
          claudeRateLimitEventToUpdate(
            info({
              rateLimitType: "seven_day",
              utilization: 0.9,
              unifiedWindows: {
                ...both,
                seven_day: { utilization: 0.93, resetsAt: 1791828000 },
              },
            }),
            noNames,
          ),
        ),
      ).toEqual([
        fiveHour(44, "2026-10-11T18:40:00.000Z"),
        sevenDay(93, "2026-10-12T18:00:00.000Z"),
      ]);
    });

    it("falls back to the top-level window for ids the unified list omits", () => {
      expect(
        byId(
          claudeRateLimitEventToUpdate(
            info({
              rateLimitType: "seven_day",
              utilization: 0.5,
              unifiedWindows: { five_hour: both.five_hour },
            }),
            noNames,
          ),
        ),
      ).toEqual([fiveHour(44, "2026-10-11T18:40:00.000Z"), sevenDay(50)]);
    });

    it("adds the overage-included bucket on top of the unified windows only when named", () => {
      const event = info({
        rateLimitType: "seven_day_overage_included",
        utilization: 0.4,
        unifiedWindows: both,
      });
      expect(
        byId(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).map(
          (window) => window.id,
        ),
      ).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
      expect(
        byId(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).find(
          (window) => window.id === "seven_day_fable",
        )?.usedPercent,
      ).toBe(40);
      expect(byId(claudeRateLimitEventToUpdate(event, noNames)).map((window) => window.id)).toEqual(
        ["five_hour", "seven_day"],
      );
    });

    it("removes float noise from the percentage and omits a missing reset", () => {
      const windows = byId(
        claudeRateLimitEventToUpdate(
          info({
            unifiedWindows: {
              five_hour: { utilization: 0.58 },
              seven_day: { utilization: 0.07, resetsAt: 1791828000 },
            },
          }),
          noNames,
        ),
      );
      expect(windows[0]?.usedPercent).toBe(58);
      expect(windows[0] && "resetsAt" in windows[0]).toBe(false);
      expect(windows[1]?.usedPercent).toBe(7);
    });

    it("does not need rateLimitType", () => {
      expect(
        byId(claudeRateLimitEventToUpdate(info({ unifiedWindows: both }), noNames)),
      ).toHaveLength(2);
    });

    it("ignores malformed entries, unknown ids and non-finite numbers", () => {
      expect(
        claudeRateLimitEventToUpdate(
          info({
            unifiedWindows: {
              five_hour: { utilization: "0.5" },
              seven_day: null,
              seven_day_opus: { utilization: 0.3 },
            },
          }),
          noNames,
        ),
      ).toBeUndefined();
      expect(
        claudeRateLimitEventToUpdate(
          info({
            unifiedWindows: {
              five_hour: { utilization: Number.NaN },
              seven_day: { utilization: Number.POSITIVE_INFINITY },
            },
          }),
          noNames,
        ),
      ).toBeUndefined();
    });

    it.each([["x"], [[]], [null], [7]])(
      "falls back to the top-level window when unifiedWindows is %j",
      (unifiedWindows) => {
        expect(
          byId(
            claudeRateLimitEventToUpdate(
              info({ rateLimitType: "five_hour", utilization: 0.1, unifiedWindows }),
              noNames,
            ),
          ),
        ).toEqual([fiveHour(10)]);
      },
    );

    it("composes with applyUsageLimitsUpdate", () => {
      const update = claudeRateLimitEventToUpdate(
        info({
          rateLimitType: "five_hour",
          unifiedWindows: {
            five_hour: { utilization: 0.02, resetsAt: 1791654000 },
            seven_day: { utilization: 0.62, resetsAt: 1791828000 },
          },
        }),
        noNames,
      );
      expect(update).toBeDefined();
      const previous = {
        checkedAt,
        windows: [fiveHour(10, "2026-10-10T17:40:00.000Z"), sevenDay(20)],
      };
      const next = applyUsageLimitsUpdate({
        previous,
        update: update!,
        checkedAt,
      });
      expect(next?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 2],
        ["seven_day", 62],
      ]);
      expect(next?.checkedAt).toBe(checkedAt);
    });
  });
});
