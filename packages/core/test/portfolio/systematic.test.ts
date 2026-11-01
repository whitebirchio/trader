import { describe, expect, it } from "vitest";
import type { SystematicParams } from "../../src/portfolio/strategy.js";
import { type DailyClose, rankUniverse, requiredHistory, selectSystematic } from "../../src/portfolio/systematic.js";

const START = Date.parse("2025-01-01T00:00:00Z");
/** n daily closes from a price function of the day index. */
function series(n: number, price: (i: number) => number): DailyClose[] {
  return Array.from({ length: n }, (_, i) => ({ t: new Date(START + i * 86_400_000), c: String(price(i)) }));
}

const params = (o: Partial<SystematicParams> = {}): SystematicParams => ({
  universe: ["AAA", "BBB", "CCC"],
  lookbackDays: 20,
  skipRecentDays: 5,
  topN: 2,
  trendFilterDays: null,
  weighting: "equal",
  volatilityDays: 10,
  defensive: null,
  ...o,
});

describe("rankUniverse", () => {
  it("measures momentum over the lookback, skipping the most recent days", () => {
    // 30 bars. last=29, window ends at 29-5=24, starts at 29-20=9.
    const bars = {
      AAA: series(30, (i) => (i <= 9 ? 100 : i <= 24 ? 150 : 50)), // +50% in-window, then crashes in the skipped days
      BBB: series(30, (i) => (i <= 9 ? 100 : 120)), // +20%
      CCC: series(30, () => 100), // flat
    };
    const { ranked } = rankUniverse(bars, params());
    expect(ranked.map((r) => [r.symbol, r.rank, Number(r.momentum.toFixed(4))])).toEqual([
      ["AAA", 1, 0.5],
      ["BBB", 2, 0.2],
      ["CCC", 3, 0],
    ]);
  });

  it("breaks ties alphabetically", () => {
    const flat = series(30, () => 100);
    expect(rankUniverse({ CCC: flat, AAA: flat, BBB: flat }, params()).ranked.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("excludes conviction symbols, short histories and bad data instead of ranking them", () => {
    const { ranked, excluded } = rankUniverse(
      { AAA: series(30, () => 100), BBB: series(10, () => 100), CCC: series(30, (i) => (i === 3 ? 0 : 100)) },
      params(),
      new Set(["AAA"]),
    );
    expect(ranked).toEqual([]);
    expect(excluded).toEqual([
      { symbol: "AAA", reason: "held as a conviction thesis" },
      { symbol: "BBB", reason: "only 10 days of history (needs 21)" },
      { symbol: "CCC", reason: "bad price data" },
    ]);
  });

  it("flags symbols below their trend average", () => {
    const p = params({ trendFilterDays: 10 });
    const { ranked } = rankUniverse(
      { AAA: series(30, (i) => 100 + i), BBB: series(30, (i) => 200 - i), CCC: series(30, () => 100) },
      p,
    );
    const by = Object.fromEntries(ranked.map((r) => [r.symbol, r.aboveTrend]));
    expect(by).toEqual({ AAA: true, BBB: false, CCC: false }); // flat is not above its own average
  });

  it("knows how much history it needs", () => {
    expect(requiredHistory(params({ lookbackDays: 252, trendFilterDays: 200, volatilityDays: 63 }))).toBe(253);
    expect(requiredHistory(params({ lookbackDays: 63, trendFilterDays: 200, volatilityDays: 63 }))).toBe(200);
  });
});

describe("selectSystematic", () => {
  const bars = {
    AAA: series(30, (i) => (i <= 9 ? 100 : 150 + (i % 2) * 6)), // strong, more volatile
    BBB: series(30, (i) => (i <= 9 ? 100 : 120 + (i % 2) * 1)), // decent, calm
    CCC: series(30, () => 100),
  };

  it("holds the top N with equal weights", () => {
    const a = selectSystematic(rankUniverse(bars, params()), params());
    expect(Object.fromEntries(a.weights)).toEqual({ AAA: 0.5, BBB: 0.5 });
    expect(a.cash).toBe(0);
  });

  it("weights by inverse volatility, summing to 1", () => {
    const p = params({ weighting: "inverse_volatility" });
    const a = selectSystematic(rankUniverse(bars, p), p);
    const w = Object.fromEntries(a.weights);
    expect(w.BBB!).toBeGreaterThan(w.AAA!); // the calmer one gets more
    expect(w.AAA! + w.BBB!).toBeCloseTo(1, 12);
  });

  it("sends a slot below trend to the defensive holding, or to cash", () => {
    const p = params({ trendFilterDays: 10, topN: 2 });
    const down = { ...bars, BBB: series(30, (i) => (i <= 9 ? 100 : 140 - i)) };
    const withDefensive = selectSystematic(rankUniverse(down, p), { ...p, defensive: "SGOV" });
    expect(Object.fromEntries(withDefensive.weights)).toEqual({ AAA: 0.5, SGOV: 0.5 });
    expect(withDefensive.notes).toContain("BBB (rank 2) is below its 10-day average, so its slot goes to SGOV");
    const toCash = selectSystematic(rankUniverse(down, p), p);
    expect(Object.fromEntries(toCash.weights)).toEqual({ AAA: 0.5 });
    expect(toCash.cash).toBe(0.5);
  });

  it("skips wash-sale symbols and substitutes the next rank", () => {
    const a = selectSystematic(rankUniverse(bars, params()), params(), new Set(["AAA"]));
    expect(Object.fromEntries(a.weights)).toEqual({ BBB: 0.5, CCC: 0.5 });
    expect(a.notes[0]).toBe("AAA (rank 1) skipped: sold at a loss in the last 30 days (wash-sale window)");
  });

  it("holds cash when nothing can be ranked", () => {
    const a = selectSystematic({ ranked: [], excluded: [] }, params());
    expect(a).toEqual({ weights: new Map(), cash: 1, notes: ["Nothing ranked: the systematic sleeve is held as cash"] });
  });

  it("version 0 shape: one symbol, topN 1 → 100% of it", () => {
    const p = params({ universe: ["VTI"], topN: 1, lookbackDays: 21, skipRecentDays: 0 });
    const a = selectSystematic(rankUniverse({ VTI: series(30, (i) => 300 + i) }, p), p);
    expect(Object.fromEntries(a.weights)).toEqual({ VTI: 1 });
  });
});
