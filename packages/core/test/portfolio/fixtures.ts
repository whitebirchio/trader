import type { Strategy, Thesis } from "../../src/portfolio/strategy.js";

export function thesis(overrides: Partial<Thesis> = {}): Thesis {
  return {
    id: "aapl-services",
    symbol: "AAPL",
    targetWeightPct: "10",
    thesis: "Services revenue keeps compounding while the market prices it like hardware.",
    evidence: [{ kind: "fundamental", summary: "Services gross margin above 70% for 8 quarters" }],
    stopLossPct: "15",
    bearCase: "Hardware is still most of the revenue, so a weak iPhone cycle could swamp services; but services keep growing through weak cycles.",
    // The default evidence's kind; a test that swaps the evidence picks its own (or none).
    ...(overrides.evidence ? {} : { leadSignal: "fundamental" as const }),
    // Defaults to the review date when one is set; otherwise a far horizon.
    forecast: { beatVtiPct: 55, expectedExcessPct: "4", ...(overrides.reviewBy ? {} : { horizon: "2030-06-28" }) },
    ...overrides,
  };
}

export function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    summary: "Test strategy",
    conviction: [thesis()],
    systematic: {
      universe: ["VTI", "QQQ", "MSFT", "NVDA"],
      lookbackDays: 252,
      skipRecentDays: 21,
      topN: 2,
      trendFilterDays: 200,
      weighting: "inverse_volatility",
      volatilityDays: 63,
      defensive: "SGOV",
    },
    drift: { relativePct: "20", minTradeUsd: "5" },
    ...overrides,
  };
}
