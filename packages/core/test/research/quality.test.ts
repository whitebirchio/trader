import { describe, expect, it } from "vitest";
import {
  type FrameRow,
  type YearFrames,
  aprilFormation,
  frameRows,
  fundamentalsAt,
  knownBy,
  percentileRanks,
  qualityMetrics,
  rawCloseNear,
} from "../../src/research/quality.js";

// Rows as SEC's frames API returns them. AAR's "CY2022" gross profit is its fiscal year to
// 2023-05-31, from a 2025 filing: real, and exactly the look-ahead the rules must catch.
const AAR_GP: FrameRow = { accn: "0001410578-25-001475", cik: 1750, start: "2022-06-01", end: "2023-05-31", val: 370_100_000 };
const row = (cik: number, end: string, val: number, accn = "0000000000-23-000001"): FrameRow => ({ cik, accn, end, val });
const FORMATION = "2023-04-28";

describe("frames", () => {
  it("reads a frames document's rows, skipping malformed ones", () => {
    expect(frameRows({ data: [AAR_GP, { cik: "x" }] })).toEqual([AAR_GP]);
    expect(frameRows({})).toEqual([]);
    expect(frameRows(null)).toEqual([]);
  });

  it("counts a figure only if its period ended 75+ days before formation", () => {
    expect(knownBy(row(1, "2022-12-31", 1), FORMATION)).toBe(true);
    expect(knownBy(row(1, "2023-02-28", 1), FORMATION)).toBe(false); // 59 days before
    expect(knownBy(AAR_GP, FORMATION)).toBe(false); // the fiscal year ends after formation
    // A later 10-K's comparative column (the usual source of a frames value) still counts.
    expect(knownBy(row(1, "2022-12-31", 1, "0000000000-25-000001"), FORMATION)).toBe(true);
  });
});

describe("fundamentalsAt", () => {
  const frames: YearFrames = {
    grossProfit: [row(1, "2022-12-31", 400), AAR_GP],
    revenues: [[row(2, "2022-12-31", 1000)], [row(3, "2022-12-31", 500)]],
    costOfRevenue: [[row(2, "2022-12-31", 700)], [row(3, "2022-12-31", 100)]],
    netIncome: [row(1, "2022-12-31", 50), row(2, "2022-12-31", -20)],
    assets: [row(1, "2022-12-31", 2000), row(2, "2022-12-31", 1500), row(1750, "2022-11-30", 1_646_900_000, "0001104659-22-128706")],
    equity: [row(1, "2022-12-31", 800)],
    shares: [[row(1, "2022-12-31", 10)], [row(2, "2023-01-31", 7)]],
  };
  const f = fundamentalsAt(frames, FORMATION);

  it("uses gross profit, or revenue minus cost of revenue, and the first share count that's known", () => {
    expect(f.get(1)).toEqual({ cik: 1, grossProfit: 400, netIncome: 50, assets: 2000, equity: 800, shares: 10 });
    // Cik 2's shares come from the fallback concept, dated 2023-01-31: 87 days before formation, so known.
    expect(f.get(2)).toEqual({ cik: 2, grossProfit: 300, netIncome: -20, assets: 1500, equity: null, shares: 7 });
  });

  it("leaves out what wasn't known at formation", () => {
    expect(f.get(1750)?.grossProfit).toBeNull(); // AAR's FY ending May 2023
    expect(f.has(3)).toBe(false); // only revenue and cost: not enough to list
  });
});

describe("metrics", () => {
  it("computes gross profitability, earnings yield and book-to-market from an unadjusted price", () => {
    const m = qualityMetrics({ cik: 1, grossProfit: 400, netIncome: 50, assets: 2000, equity: 800, shares: 10 }, 20);
    expect(m.grossProfitability).toBeCloseTo(0.2, 12);
    expect(m.earningsYield).toBeCloseTo(50 / 200, 12);
    expect(m.bookToMarket).toBeCloseTo(800 / 200, 12);
    expect(qualityMetrics({ cik: 1, grossProfit: 400, netIncome: 50, assets: 0, equity: 800, shares: null }, 20)).toEqual({
      grossProfitability: null, earningsYield: null, bookToMarket: null,
    });
  });

  it("ranks values into percentiles", () => {
    expect(percentileRanks([30, 10, 20])).toEqual([1, 0, 0.5]);
    expect(percentileRanks([5])).toEqual([0.5]);
  });
});

describe("dates and prices", () => {
  it("finds the last session of April and a recent unadjusted close", () => {
    expect(aprilFormation(["2023-04-27", "2023-04-28", "2023-05-01"], 2023)).toBe("2023-04-28");
    expect(aprilFormation(["2023-05-01"], 2023)).toBeNull();
    const bars = [{ date: "2023-04-20", close: 9, volume: 1 }, { date: "2023-04-27", close: 10, volume: 1 }];
    expect(rawCloseNear(bars, "2023-04-28")).toBe(10);
    expect(rawCloseNear(bars, "2023-05-10")).toBeNull(); // nothing within the week before
  });
});
