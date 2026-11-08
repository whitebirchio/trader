import { describe, expect, it } from "vitest";
import { STRATEGY_JSON_SCHEMA, VERSION_0, validateStrategy } from "../../src/portfolio/strategy.js";
import { strategy, thesis } from "./fixtures.js";

const errorsOf = (doc: unknown) => {
  const r = validateStrategy(doc);
  return r.ok ? [] : r.errors;
};

describe("validateStrategy", () => {
  it("accepts a well-formed strategy, and version 0", () => {
    expect(validateStrategy(strategy()).ok).toBe(true);
    expect(validateStrategy(VERSION_0)).toEqual({ ok: true, strategy: VERSION_0 });
  });

  it.each([
    [{ targetWeightPct: "0" }, "conviction[0].targetWeightPct: must be more than 0 and at most 20"],
    [{ targetWeightPct: "20.01" }, "conviction[0].targetWeightPct: must be more than 0 and at most 20"],
    [{ stopLossPct: "4.9" }, "conviction[0].stopLossPct: must be at least 5 and at most 50"],
    [{ stopLossPct: "51" }, "conviction[0].stopLossPct: must be at least 5 and at most 50"],
    [{ evidence: [] }, "conviction[0].evidence: needs at least one piece of evidence"],
    [{ thesis: "buy it" }, "conviction[0].thesis: needs at least a sentence of reasoning"],
    [{ symbol: "aapl" }, "conviction[0].symbol: must be an uppercase ticker like VTI or BRK.B"],
    [{ id: "Bad Id" }, "conviction[0].id: must be a lowercase slug like aapl-services-2026q4"],
  ])("rejects thesis %o", (override, message) => {
    expect(errorsOf(strategy({ conviction: [thesis(override)] }))).toContain(message);
  });

  it("requires a stop-loss on every thesis", () => {
    const { stopLossPct: _, ...noStop } = thesis();
    expect(errorsOf(strategy({ conviction: [noStop as never] })).join()).toMatch(/conviction\[0\]\.stopLossPct/);
  });

  it("takes an optional review date, which must be a real date", () => {
    expect(validateStrategy(strategy({ conviction: [thesis({ reviewBy: "2027-02-01" })] })).ok).toBe(true);
    for (const bad of ["2027-02-30", "2027-13-01", "02/01/2027", "2027-2-1"]) {
      const r = validateStrategy(strategy({ conviction: [thesis({ reviewBy: bad })] }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^conviction\[0\]\.reviewBy: must be (YYYY-MM-DD|a real date)$/);
    }
  });

  it("caps total conviction at 100% and forbids duplicate ids and symbols", () => {
    const many = Array.from({ length: 6 }, (_, i) => thesis({ id: `t-${i}`, symbol: `S${i}`, targetWeightPct: "20" }));
    expect(errorsOf(strategy({ conviction: many }))).toContain("conviction: target weights add up to 120%, more than 100%");
    expect(errorsOf(strategy({ conviction: [thesis(), thesis({ symbol: "MSFT" })] }))).toContain(
      'conviction[1].id: "aapl-services" is used by more than one thesis',
    );
    expect(errorsOf(strategy({ conviction: [thesis(), thesis({ id: "other" })] }))).toContain(
      "conviction[1].symbol: AAPL has more than one thesis",
    );
  });

  it("allows conviction at exactly 100%", () => {
    const five = Array.from({ length: 5 }, (_, i) => thesis({ id: `t-${i}`, symbol: `S${i}`, targetWeightPct: "20" }));
    expect(validateStrategy(strategy({ conviction: five })).ok).toBe(true);
  });

  it.each([
    [{ universe: [] }, "systematic.universe: needs at least one symbol"],
    [{ universe: Array.from({ length: 101 }, (_, i) => `S${i}`) }, "systematic.universe: can hold at most 100 symbols"],
    [{ universe: ["VTI", "VTI"], topN: 1 }, "systematic.universe: lists a symbol more than once"],
    [{ lookbackDays: 20 }, "systematic.lookbackDays: must be at least 21"],
    [{ lookbackDays: 30, skipRecentDays: 30 }, "systematic.skipRecentDays: must be at most 21"],
    [{ lookbackDays: 21, skipRecentDays: 21 }, "systematic.skipRecentDays: must be shorter than lookbackDays"],
    [{ topN: 5 }, "systematic.topN: asks for the top 5 of only 4 symbols"],
    [{ trendFilterDays: 40 }, "systematic.trendFilterDays: must be at least 50"],
    [{ volatilityDays: 10.5 }, "systematic.volatilityDays: must be a whole number"],
    [{ defensive: "VTI" }, "systematic.defensive: VTI can't be both in the universe and the defensive holding"],
  ])("rejects systematic %o", (override, message) => {
    expect(errorsOf(strategy({ systematic: { ...strategy().systematic, ...override } }))).toContain(message);
  });

  it("bounds the drift rule", () => {
    expect(errorsOf(strategy({ drift: { relativePct: "0.5", minTradeUsd: "5" } }))).toContain(
      "drift.relativePct: must be at least 1 and at most 100",
    );
    expect(errorsOf(strategy({ drift: { relativePct: "20", minTradeUsd: "0.5" } }))).toContain(
      "drift.minTradeUsd: must be at least 1 and at most 1000",
    );
  });

  it("rejects non-objects and money as numbers", () => {
    expect(validateStrategy("nope").ok).toBe(false);
    expect(errorsOf(strategy({ conviction: [thesis({ targetWeightPct: 10 as never })] })).join()).toMatch(/targetWeightPct/);
  });
});

describe("STRATEGY_JSON_SCHEMA", () => {
  it("describes the document for MCP clients, money as decimal strings", () => {
    expect(STRATEGY_JSON_SCHEMA).toMatchObject({ type: "object", required: ["summary", "conviction", "systematic", "drift"] });
    expect(STRATEGY_JSON_SCHEMA).not.toHaveProperty("$schema");
    const thesisProps = (STRATEGY_JSON_SCHEMA as { properties: { conviction: { items: { properties: Record<string, { type: string }> } } } }).properties.conviction.items.properties;
    expect(thesisProps.targetWeightPct?.type).toBe("string");
  });
});
