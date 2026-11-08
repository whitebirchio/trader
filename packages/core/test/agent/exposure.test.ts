import { describe, expect, it } from "vitest";
import { BROAD_MARKET, UNCLASSIFIED, correlation, dailyReturns, exposureReport, sicSector } from "../../src/agent/exposure.js";
import type { Bar } from "../../src/broker/port.js";

const START = Date.parse("2026-07-01T20:00:00Z");
/** Daily bars whose returns follow `r(i)`. */
const series = (r: (i: number) => number, days = 80): Bar[] => {
  let c = 100;
  return Array.from({ length: days }, (_, i) => {
    if (i > 0) c *= 1 + r(i);
    return { t: new Date(START + i * 86_400_000), o: String(c), h: String(c), l: String(c), c: String(c), v: "1000" };
  });
};
const wave = (i: number) => 0.01 * Math.sin(i * 1.7);
const other = (i: number) => 0.01 * Math.cos(i * 0.9 + 1);

describe("sicSector", () => {
  it("maps SIC codes to approximate sectors, most specific range first", () => {
    expect(sicSector("3674")).toBe("Information Technology"); // semiconductors (Intel)
    expect(sicSector("3721")).toBe("Industrials"); // aircraft (Boeing)
    expect(sicSector("3711")).toBe("Consumer Discretionary"); // motor vehicles
    expect(sicSector("2834")).toBe("Health Care"); // pharmaceuticals (Lilly)
    expect(sicSector("2821")).toBe("Materials"); // plastics
    expect(sicSector("1311")).toBe("Energy"); // crude petroleum
    expect(sicSector("5500")).toBe("Consumer Discretionary"); // auto dealers (AutoNation)
    expect(sicSector("6798")).toBe("Real Estate"); // REITs
    expect(sicSector("7370")).toBe("Information Technology"); // computer services (Alphabet; GICS says Communication Services)
    expect(sicSector("9995")).toBe(UNCLASSIFIED);
    expect(sicSector(null)).toBe(UNCLASSIFIED);
  });
});

describe("correlation", () => {
  it("is 1 for names that move together, −1 for opposites, null with too few common sessions or no movement", () => {
    const a = dailyReturns(series(wave));
    expect(a.size).toBe(60);
    expect(correlation(a, dailyReturns(series((i) => 2 * wave(i))))).toBe(1);
    expect(correlation(a, dailyReturns(series((i) => -wave(i))))).toBe(-1);
    expect(correlation(a, dailyReturns(series(wave, 30)))).toBeNull();
    expect(correlation(a, dailyReturns(series(() => 0)))).toBeNull();
  });
});

describe("exposureReport", () => {
  it("weighs holdings and sectors, flags names that move as one bet, and notes the gaps", () => {
    const r = exposureReport({
      equity: "1000",
      holdings: [
        { symbol: "VTI", marketValue: "500", thesisId: null },
        { symbol: "INTC", marketValue: "200", thesisId: "intc-a" },
        { symbol: "TTMI", marketValue: "200", thesisId: "ttmi-a" },
        { symbol: "BA", marketValue: "50", thesisId: "ba-a" },
        { symbol: "XLI", marketValue: "50", thesisId: null },
      ],
      candidates: [{ symbol: "NEW", thesisId: null }],
      industries: new Map([
        ["INTC", { sic: "3674", description: "SEMICONDUCTORS & RELATED DEVICES" }],
        ["TTMI", { sic: "3672", description: "PRINTED CIRCUIT BOARDS" }],
        ["BA", { sic: "3721", description: "AIRCRAFT" }],
        ["NEW", null],
      ]),
      bars: { VTI: series(wave), INTC: series(wave), TTMI: series((i) => 1.5 * wave(i) + 0.2 * other(i)), BA: series(other), NEW: series(wave, 20) },
    });
    expect(r.holdings.map((h) => [h.symbol, h.weightPct, h.sector])).toEqual([
      ["VTI", "50", BROAD_MARKET],
      ["INTC", "20", "Information Technology"],
      ["TTMI", "20", "Information Technology"],
      ["BA", "5", "Industrials"],
      ["XLI", "5", "Industrials"],
    ]);
    expect(r.sectors).toEqual([
      { sector: BROAD_MARKET, weightPct: "50", symbols: ["VTI"] },
      { sector: "Information Technology", weightPct: "40", symbols: ["INTC", "TTMI"] },
      { sector: "Industrials", weightPct: "10", symbols: ["BA", "XLI"] },
    ]);
    expect(r.candidates).toEqual([{ symbol: "NEW", thesisId: null, sector: UNCLASSIFIED, industry: null, sic: null }]);
    expect(r.correlation.pairs).toEqual([{ a: "INTC", b: "TTMI", correlation: expect.any(Number), oneBet: true }]);
    expect(r.correlation.pairs[0]!.correlation).toBeGreaterThanOrEqual(0.7);
    expect(r.correlation.pairsMeasured).toBe(3); // INTC, TTMI and BA with each other; XLI and NEW have too little history
    expect(r.correlation.vsMarket.find((v) => v.symbol === "INTC")?.correlation).toBe(1);
    expect(r.notes).toEqual(["Couldn't read SEC for NEW: sector unknown.", "Under 40 sessions of prices, so no correlations: XLI, NEW."]);
  });
});
