import { describe, expect, it } from "vitest";
import { type CohortStats, type DailyBar, LONG_HORIZONS, cohortStats, outcomeAfter, promotion } from "../../src/research/backtest.js";

const t = { minPrice: 5, minAvgDollarVolume: 1_000_000, avgDollarVolumeDays: 20 };
const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (n: number, close: (i: number) => number): DailyBar[] => Array.from({ length: n }, (_, i) => ({ date: day(i), close: close(i), volume: 1_000_000 }));

describe("outcomeAfter with long horizons", () => {
  it("measures a year as well, and leaves an incomplete window null", () => {
    const bars = series(300, (i) => 10 + i * 0.01);
    const vti = series(300, () => 100);
    const o = outcomeAfter("e", day(29), bars, vti, t, LONG_HORIZONS);
    expect("skip" in o).toBe(false);
    if ("skip" in o) return;
    expect(o.entryDate).toBe(day(30));
    expect(o.excess[250]).toBeCloseTo((10 + 280 * 0.01) / (10 + 30 * 0.01) - 1);
    expect(Object.keys(o.excess)).toEqual(["20", "60", "120", "250"]);
    const late = outcomeAfter("e", day(100), bars, vti, t, LONG_HORIZONS);
    expect("skip" in late ? null : late.excess[250]).toBeNull();
  });

  it("keeps the default horizons for the earlier studies", () => {
    const o = outcomeAfter("e", day(29), series(300, () => 10), series(300, () => 100), t);
    expect("skip" in o ? [] : Object.keys(o.excess)).toEqual(["20", "60", "120"]);
  });
});

describe("cohortStats", () => {
  const row = (cohort: string, x: number | null) => ({ cohort, excess: { 20: x, 60: x, 120: x } });

  it("weights each cohort once, however many events it holds", () => {
    const rows = [row("2020Q1", 0.1), row("2020Q1", 0.1), row("2020Q1", 0.1), row("2020Q2", -0.02), row("2020Q3", null)];
    const s = cohortStats(rows, (r) => r.cohort, 60);
    expect(s.cohorts).toBe(2);
    expect(s.events).toBe(4);
    expect(s.mean).toBeCloseTo(0.04);
    expect(s.stdError).toBeCloseTo(Math.sqrt(((0.06 ** 2) * 2) / 1 / 2));
    expect(s.beatShare).toBe(0.5);
  });

  it("is empty without complete windows", () => {
    expect(cohortStats([row("2020Q1", null)], (r) => r.cohort, 60)).toEqual({ cohorts: 0, events: 0, mean: null, stdError: null, beatShare: null });
  });
});

describe("promotion", () => {
  const s = (mean: number | null, stdError: number | null = 0.001, cohorts = 20): CohortStats => ({ cohorts, events: cohorts * 10, mean, stdError, beatShare: null });
  const pass = { inSample60: s(0.02), heldOut60: s(0.01), inSample120: s(0.03) };

  it("passes a bucket that clears every test after costs", () => {
    expect(promotion(pass)).toEqual({ pass: true, failed: [] });
  });

  it("names each test a bucket fails", () => {
    expect(promotion({ ...pass, inSample60: s(0.0015) }).failed).toEqual(["in-sample 60d", "in-sample 2 SE"]);
    expect(promotion({ ...pass, heldOut60: s(0.002) }).failed).toEqual(["held-out 60d"]);
    expect(promotion({ ...pass, inSample60: s(0.01, 0.005) }).failed).toEqual(["in-sample 2 SE"]); // 0.008 net < 2 × 0.005
    expect(promotion({ ...pass, inSample120: s(-0.01) }).failed).toEqual(["120d reverses"]);
    expect(promotion({ ...pass, heldOut60: s(null) }).failed).toEqual(["held-out 60d"]);
    expect(promotion({ ...pass, inSample60: s(0.02, 0, 1) }).failed).toEqual(["in-sample 2 SE"]); // one cohort can't show significance
  });

  it("takes a stricter bar when a study fixed one (#140: 3 SE), naming it, and defaults to 2 as before", () => {
    // After the 0.2% round trip: 0.010 net is 2.5 SE of 0.004; 0.0124 net is 3.1 SE.
    expect(promotion({ ...pass, inSample60: s(0.012, 0.004) }, { minStdErrors: 3 }).failed).toEqual(["in-sample 3 SE"]);
    expect(promotion({ ...pass, inSample60: s(0.0144, 0.004) }, { minStdErrors: 3 })).toEqual({ pass: true, failed: [] });
    expect(promotion({ ...pass, inSample60: s(0.012, 0.004) })).toEqual({ pass: true, failed: [] }); // 2.5 SE clears the default 2
    expect(promotion({ ...pass, inSample60: s(0.0015) }).failed).toContain("in-sample 2 SE"); // the default keeps the old wording, so earlier reports read the same
  });
});
