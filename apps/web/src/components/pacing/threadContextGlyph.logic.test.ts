import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { formatThreadContextTooltip } from "@t3tools/shared/usagePacing";
import { describe, expect, it } from "vite-plus/test";
import {
  arcDashArray,
  composerGlyphUsage,
  dotFillClass,
  formatGlyphTooltip,
  glyphCacheClause,
  glyphGeometry,
  resolveThreadContextGlyph,
  type ThreadContextUsage,
} from "./threadContextGlyph.logic";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const HOUR = 3_600_000;

const selection = (
  model: string,
  options?: ReadonlyArray<{ id: string; value: string | boolean }>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
  ...(options ? { options } : {}),
});

describe("resolveThreadContextGlyph", () => {
  it("returns null without usage", () => {
    expect(resolveThreadContextGlyph(null, null, NOW)).toBeNull();
    expect(resolveThreadContextGlyph(undefined, selection("m"), NOW)).toBeNull();
  });

  it("reports an unknown cache without a TTL", () => {
    const model = resolveThreadContextGlyph(
      { usedTokens: 40_000, maxTokens: 200_000, updatedAt: ago(60) },
      null,
      NOW,
    );
    expect(model).toMatchObject({
      tier: 0,
      tierColor: "muted",
      fraction: 0.2,
      cacheState: "unknown",
      expiresAtMs: null,
    });
  });

  it("colours by the percentage tier and reports a warm cache", () => {
    const updatedAt = ago(60);
    const model = resolveThreadContextGlyph(
      { usedTokens: 120_000, maxTokens: 200_000, updatedAt, promptCacheTtlMs: HOUR },
      null,
      NOW,
    );
    expect(model).toMatchObject({
      tier: 1,
      tierColor: "yellow",
      fraction: 0.6,
      cacheState: "warm",
      expiresAtMs: Date.parse(updatedAt) + HOUR,
    });
  });

  it("lets the token tier beat a low percentage", () => {
    const model = resolveThreadContextGlyph(
      {
        usedTokens: 380_000,
        maxTokens: 1_000_000,
        updatedAt: ago(60),
        promptCacheTtlMs: HOUR,
      },
      null,
      NOW,
    );
    expect(model).toMatchObject({
      tier: 2,
      tierColor: "orange",
      fraction: 0.38,
      cacheState: "warm",
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
  ])("draws no arc when maxTokens is %s but keeps the token tier", (_name, maxTokens) => {
    const model = resolveThreadContextGlyph(
      { usedTokens: 250_000, maxTokens, updatedAt: ago(60) },
      null,
      NOW,
    );
    expect(model).toMatchObject({ tier: 1, fraction: null, maxTokens: maxTokens ?? null });
    if (model) expect(Number.isNaN(model.fraction)).toBe(false);
  });

  it("clamps usage above the window to a full ring", () => {
    const model = resolveThreadContextGlyph(
      { usedTokens: 1_200_000, maxTokens: 1_000_000, updatedAt: ago(60) },
      null,
      NOW,
    );
    expect(model).toMatchObject({ tier: 3, fraction: 1 });
  });

  it("expires warm to expiring to cold purely from the clock", () => {
    const expiringUsage = {
      usedTokens: 100_000,
      maxTokens: 200_000,
      promptCacheTtlMs: 300_000,
    };
    expect(
      resolveThreadContextGlyph({ ...expiringUsage, updatedAt: ago(240) }, null, NOW)?.cacheState,
    ).toBe("expiring");
    expect(
      resolveThreadContextGlyph({ ...expiringUsage, updatedAt: ago(400) }, null, NOW)?.cacheState,
    ).toBe("cold");

    const usage: ThreadContextUsage = {
      usedTokens: 120_000,
      maxTokens: 200_000,
      updatedAt: ago(60),
      promptCacheTtlMs: HOUR,
    };
    expect(resolveThreadContextGlyph(usage, null, NOW)?.cacheState).toBe("warm");
    expect(resolveThreadContextGlyph(usage, null, NOW + 58 * 60_000)?.cacheState).toBe("expiring");
    expect(resolveThreadContextGlyph(usage, null, NOW + 60 * 60_000)?.cacheState).toBe("cold");
  });

  describe("request identity", () => {
    const usage: ThreadContextUsage = {
      usedTokens: 100_000,
      maxTokens: 200_000,
      updatedAt: ago(60),
      promptCacheTtlMs: HOUR,
      requestIdentity: { model: "claude-opus-4-7", effort: "high" },
    };

    it("goes cold on an effort mismatch and warm again when switched back", () => {
      expect(
        resolveThreadContextGlyph(
          usage,
          selection("claude-opus-4-7", [{ id: "effort", value: "low" }]),
          NOW,
        )?.cacheState,
      ).toBe("cold");
      expect(
        resolveThreadContextGlyph(
          usage,
          selection("claude-opus-4-7", [{ id: "effort", value: "high" }]),
          NOW,
        )?.cacheState,
      ).toBe("warm");
    });

    it("skips fields absent from the next selection", () => {
      expect(resolveThreadContextGlyph(usage, selection("claude-opus-4-7"), NOW)?.cacheState).toBe(
        "warm",
      );
    });
  });

  it("reads an unparseable updatedAt as unknown without throwing", () => {
    const model = resolveThreadContextGlyph(
      { usedTokens: 1, maxTokens: 10, updatedAt: "not a date", promptCacheTtlMs: HOUR },
      null,
      NOW,
    );
    expect(model).toMatchObject({ cacheState: "unknown", expiresAtMs: null });
  });

  it("still yields a model for zero usage", () => {
    expect(
      resolveThreadContextGlyph(
        { usedTokens: 0, maxTokens: 200_000, updatedAt: ago(1) },
        null,
        NOW,
      ),
    ).toMatchObject({ tier: 0, fraction: 0 });
  });
});

describe("composerGlyphUsage", () => {
  const snapshot = {
    usedTokens: 380_000,
    maxTokens: 1_000_000,
    updatedAt: "2026-10-11T12:00:00.000Z",
  };

  it("copies cache inputs from the live report", () => {
    expect(
      composerGlyphUsage(snapshot, {
        promptCacheTtlMs: HOUR,
        requestIdentity: { model: "m" },
      }),
    ).toStrictEqual({ ...snapshot, promptCacheTtlMs: HOUR, requestIdentity: { model: "m" } });
  });

  it("omits cache keys without a live report", () => {
    expect(
      composerGlyphUsage(
        { usedTokens: 50_000, maxTokens: null, updatedAt: snapshot.updatedAt },
        null,
      ),
    ).toStrictEqual({ usedTokens: 50_000, maxTokens: null, updatedAt: snapshot.updatedAt });
  });

  it("keeps the ring for a compaction-style report with no cache data", () => {
    expect(
      composerGlyphUsage(
        { usedTokens: 50_000, maxTokens: 200_000, updatedAt: snapshot.updatedAt },
        {},
      ),
    ).toStrictEqual({ usedTokens: 50_000, maxTokens: 200_000, updatedAt: snapshot.updatedAt });
  });
});

describe("glyphGeometry", () => {
  it.each([
    [14, 1.6, 6.2, 7, 2.1],
    [18, 2, 8, 9, 2.7],
  ] as const)("size %s", (size, strokeWidth, radius, center, dotRadius) => {
    const g = glyphGeometry(size);
    expect(g.strokeWidth).toBeCloseTo(strokeWidth);
    expect(g.radius).toBeCloseTo(radius);
    expect(g.center).toBeCloseTo(center);
    expect(g.dotRadius).toBeCloseTo(dotRadius);
    expect(g.circumference).toBeCloseTo(2 * Math.PI * radius);
  });
});

describe("arcDashArray", () => {
  it.each([
    [null, null],
    [0, null],
    [-0.1, null],
    [Number.NaN, null],
    [0.25, "10 40"],
    [1, "40 40"],
    [1.7, "40 40"],
  ])("fraction %s", (fraction, expected) => {
    expect(arcDashArray(fraction, 40)).toBe(expected);
  });
});

describe("dotFillClass", () => {
  it("maps cache states to dot classes", () => {
    expect(dotFillClass("warm")).toBe("fill-muted-foreground");
    const expiring = dotFillClass("expiring");
    expect(expiring).toContain("var(--color-warning)");
    expect(expiring).toContain("_45%");
    expect(expiring).toContain("var(--color-muted-foreground)");
    expect(dotFillClass("cold")).toBeNull();
    expect(dotFillClass("unknown")).toBeNull();
  });
});

describe("formatGlyphTooltip / glyphCacheClause", () => {
  const base = { usedTokens: 380_000, maxTokens: 1_000_000, updatedAt: ago(60) };
  const resolve = (usage: ThreadContextUsage, now = NOW) => {
    const model = resolveThreadContextGlyph(usage, null, now);
    if (!model) throw new Error("expected a model");
    return model;
  };

  it("warm: matches the shared formatter and exposes the clause", () => {
    const model = resolve({ ...base, promptCacheTtlMs: HOUR });
    const tooltip = formatGlyphTooltip(model, "24-hour");
    expect(tooltip.startsWith("Context 380k / 1M (38%) · Cache warm, expires ")).toBe(true);
    expect(tooltip).toBe(
      formatThreadContextTooltip({
        usedTokens: 380_000,
        maxTokens: 1_000_000,
        warmth: "warm",
        expiresAtMs: model.expiresAtMs,
        timestampFormat: "24-hour",
      }),
    );
    expect(glyphCacheClause(model, "24-hour")?.startsWith("Cache warm, expires ")).toBe(true);
  });

  it("expiring", () => {
    const model = resolve({ ...base, promptCacheTtlMs: HOUR }, NOW + 58 * 60_000);
    expect(formatGlyphTooltip(model, "24-hour")).toContain("· Cache expiring ");
    expect(glyphCacheClause(model, "24-hour")?.startsWith("Cache expiring ")).toBe(true);
  });

  it("cold", () => {
    const model = resolve({ ...base, promptCacheTtlMs: HOUR }, NOW + 2 * HOUR);
    expect(formatGlyphTooltip(model, "24-hour")).toBe("Context 380k / 1M (38%) · Cache cold");
    expect(glyphCacheClause(model, "24-hour")).toBe("Cache cold");
  });

  it("unknown", () => {
    const model = resolve(base);
    expect(formatGlyphTooltip(model, "24-hour")).toBe("Context 380k / 1M (38%)");
    expect(glyphCacheClause(model, "24-hour")).toBeNull();
  });

  it("without a window size", () => {
    const model = resolve({ usedTokens: 250_000, maxTokens: null, updatedAt: ago(60) });
    expect(formatGlyphTooltip(model, "24-hour")).toBe("Context 250k");
    expect(glyphCacheClause(model, "24-hour")).toBeNull();
  });
});
