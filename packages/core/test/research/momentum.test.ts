import { describe, expect, it } from "vitest";
import type { DailyBar } from "../../src/research/backtest.js";
import {
  type FormationRow,
  aboveAverage,
  assignDeciles,
  formationRows,
  momentumSignal,
  monthEnds,
  monthlyDecileMeans,
  period,
  seriesStats,
  topMinusBottom,
} from "../../src/research/momentum.js";

// One bar per calendar day from 2020-01-01, so index arithmetic is easy to check.
const START = Date.parse("2020-01-01T00:00:00Z");
const dateAt = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);
const series = (closes: number[], volume = 2_000_000): DailyBar[] => closes.map((close, i) => ({ date: dateAt(i), close, volume }));
const TRADABLE = { minPrice: 5, minAvgDollarVolume: 10_000_000, avgDollarVolumeDays: 20 };
const SPEC = { name: "test", lookback: 10, skip: 2, trendFilter: false };

describe("monthEnds", () => {
  it("is each month's last session within the range", () => {
    const sessions = ["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01", "2024-03-28"];
    expect(monthEnds(sessions, "2024-01-01", "2024-12-31")).toEqual(["2024-01-31", "2024-02-29", "2024-03-28"]);
    expect(monthEnds(sessions, "2024-02-01", "2024-02-29")).toEqual(["2024-02-29"]);
  });
});

describe("signals", () => {
  const bars = series(Array.from({ length: 30 }, (_, i) => 10 + i)); // 10, 11, …, 39

  it("measures the return from lookback to skip bars back", () => {
    // At i = 20: from bar 10 (close 20) to bar 18 (close 28).
    expect(momentumSignal(bars, 20, 10, 2)).toBeCloseTo(28 / 20 - 1, 12);
    expect(momentumSignal(bars, 5, 10, 2)).toBeNull();
  });

  it("knows whether a close is above its trailing average", () => {
    expect(aboveAverage(bars, 29, 10)).toBe(true);
    expect(aboveAverage(series(Array.from({ length: 30 }, (_, i) => 40 - i)), 29, 10)).toBe(false);
    expect(aboveAverage(bars, 5, 10)).toBeNull();
  });
});

describe("formationRows", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 10 + i * 0.1);
  const vti = series(Array.from({ length: 120 }, () => 100));

  it("scores each formation date with the signal and the excess from the next close", () => {
    const [row] = formationRows("XYZ", series(closes), vti, [dateAt(40)], SPEC, TRADABLE);
    expect(row!.signal).toBeCloseTo(closes[38]! / closes[30]! - 1, 12);
    // Entry at bar 41, exit 20 bars later; VTI is flat.
    expect(row!.excess[20]).toBeCloseTo(closes[61]! / closes[41]! - 1, 12);
  });

  it("skips a stale stock, a short history, the untradable, and (with the filter) stocks below trend", () => {
    expect(formationRows("XYZ", series(closes).slice(0, 30), vti, [dateAt(40)], SPEC, TRADABLE)).toEqual([]); // last bar 10 days before
    expect(formationRows("XYZ", series(closes), vti, [dateAt(5)], SPEC, TRADABLE)).toEqual([]); // no lookback yet
    expect(formationRows("XYZ", series(closes, 100_000), vti, [dateAt(40)], SPEC, TRADABLE)).toEqual([]); // illiquid
    const falling = series(Array.from({ length: 300 }, (_, i) => 100 - i * 0.1));
    const vti300 = series(Array.from({ length: 300 }, () => 100));
    expect(formationRows("XYZ", falling, vti300, [dateAt(250)], { ...SPEC, trendFilter: true }, TRADABLE)).toEqual([]);
    expect(formationRows("XYZ", falling, vti300, [dateAt(250)], SPEC, TRADABLE)).toHaveLength(1);
  });
});

const row = (symbol: string, date: string, signal: number, x20: number | null): FormationRow => ({ symbol, date, signal, excess: { 20: x20, 60: null, 120: null } });

describe("deciles and monthly means", () => {
  it("ranks within each formation date, 1 lowest to 10 highest", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`S${i}`, "2024-01-31", i, 0));
    const d = assignDeciles(rows);
    expect(rows.map((r) => d.get(r))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]);
    const few = [row("A", "2024-02-29", 3, 0), row("B", "2024-02-29", 1, 0), row("C", "2024-02-29", 2, 0)];
    const d2 = assignDeciles(few);
    expect(few.map((r) => d2.get(r))).toEqual([7, 1, 4]);
  });

  it("averages each decile per month, and takes top minus bottom", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(`L${i}`, "2024-01-31", i, i === 0 ? -0.04 : i === 9 ? 0.06 : 0)),
      ...Array.from({ length: 10 }, (_, i) => row(`M${i}`, "2024-02-29", i, i === 0 ? 0.01 : i === 9 ? null : 0)),
    ];
    const means = monthlyDecileMeans(rows, assignDeciles(rows));
    expect(means.filter((m) => m.decile === 10).map((m) => [m.date, m.mean[20]])).toEqual([["2024-01-31", 0.06], ["2024-02-29", null]]);
    const spread = topMinusBottom(means);
    expect(spread.map((m) => [m.date, m.mean[20]])).toEqual([["2024-01-31", expect.closeTo(0.1, 12)], ["2024-02-29", null]]);
  });
});

describe("seriesStats and period", () => {
  it("summarises a monthly series, skipping months without a value", () => {
    const s = seriesStats([0.02, -0.01, 0.05, null]);
    expect(s.months).toBe(3);
    expect(s.mean).toBeCloseTo(0.02, 12);
    expect(s.positiveShare).toBeCloseTo(2 / 3, 12);
    expect(s.stdError).toBeCloseTo(Math.sqrt(((0) ** 2 + 0.03 ** 2 + 0.03 ** 2) / 2) / Math.sqrt(3), 12);
    expect(seriesStats([])).toEqual({ months: 0, mean: null, stdError: null, positiveShare: null });
  });

  it("splits in-sample from held out at 2024", () => {
    expect([period("2023-12-29"), period("2024-01-31")]).toEqual(["in-sample", "held-out"]);
  });
});
