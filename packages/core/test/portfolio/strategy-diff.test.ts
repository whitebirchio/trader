import { describe, expect, it } from "vitest";
import { VERSION_0 } from "../../src/portfolio/strategy.js";
import { sameExceptSummary, strategyChanges } from "../../src/portfolio/strategy-diff.js";
import { strategy, thesis } from "./fixtures.js";

const aapl = thesis();
const msft = thesis({ id: "msft-cloud", symbol: "MSFT", targetWeightPct: "5" });

describe("sameExceptSummary", () => {
  it("ignores the summary and the order keys were stored in", () => {
    const a = strategy({ summary: "first" });
    const reordered = JSON.parse(JSON.stringify({ drift: a.drift, systematic: a.systematic, conviction: a.conviction, summary: "second" }));
    expect(sameExceptSummary(a, reordered)).toBe(true);
    expect(sameExceptSummary(a, strategy({ conviction: [thesis({ targetWeightPct: "9" })] }))).toBe(false);
  });
});

describe("strategyChanges", () => {
  it("is empty for a reaffirmation", () => {
    expect(strategyChanges(strategy(), strategy({ summary: "again" }))).toEqual({ added: [], removed: [], resized: [], moved: [], edited: [] });
  });

  it("finds theses added, exited and resized", () => {
    const c = strategyChanges(strategy({ conviction: [aapl] }), strategy({ conviction: [{ ...aapl, targetWeightPct: "12" }, msft] }));
    expect(c.added).toEqual([{ thesisId: "msft-cloud", symbol: "MSFT", weightPct: "5" }]);
    expect(c.resized).toEqual([{ thesisId: "aapl-services", symbol: "AAPL", from: "10", to: "12" }]);
    expect(strategyChanges(strategy({ conviction: [aapl, msft] }), strategy({ conviction: [aapl] })).removed).toEqual([{ thesisId: "msft-cloud", symbol: "MSFT", weightPct: "5" }]);
  });

  it("treats the same weight written differently as unchanged", () => {
    expect(strategyChanges(strategy({ conviction: [aapl] }), strategy({ conviction: [{ ...aapl, targetWeightPct: "10.0" }] })).resized).toEqual([]);
  });

  it("finds a moved stop, review date and forecast, and other edits by name", () => {
    const before = strategy({ conviction: [thesis({ reviewBy: "2026-12-01" })] });
    const after = strategy({
      conviction: [thesis({ reviewBy: "2027-01-05", stopLossPct: "20", forecast: { beatVtiPct: 60, expectedExcessPct: "4" }, plainSummary: "Apple sells iPhones and the services people pay for." })],
      drift: { relativePct: "25", minTradeUsd: "5" },
    });
    const c = strategyChanges(before, after);
    expect(c.moved).toEqual([
      { thesisId: "aapl-services", symbol: "AAPL", field: "stop", from: "15", to: "20" },
      { thesisId: "aapl-services", symbol: "AAPL", field: "review", from: "2026-12-01", to: "2027-01-05" },
      { thesisId: "aapl-services", symbol: "AAPL", field: "forecast", from: "55%", to: "60%" },
    ]);
    expect(c.edited).toEqual(["AAPL's case", "the drift band"]);
  });

  it("counts every thesis as added against version 0", () => {
    expect(strategyChanges(VERSION_0, strategy()).added).toEqual([{ thesisId: "aapl-services", symbol: "AAPL", weightPct: "10" }]);
  });
});
