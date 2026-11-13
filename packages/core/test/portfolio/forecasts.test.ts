import { describe, expect, it } from "vitest";
import { benchmarkCloses, strategies, thesisCloses, watchlistNotes } from "../../src/db/schema.js";
import {
  type ForecastOutcome,
  type StatedForecast,
  calibrate,
  forecastReport,
  loadForecastReport,
  resolveForecast,
  thesisForecasts,
  watchlistForecasts,
} from "../../src/portfolio/forecasts.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "./fixtures.js";

const at = (iso: string) => new Date(iso);

/** Trading days from 2026-11-02 (Mon), weekdays only, for `n` sessions. */
function sessions(n: number, from = "2026-11-02"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); out.length < n; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

type Closes = Parameters<typeof resolveForecast>[1];
function closesOf(series: Record<string, Record<string, string>>): Closes {
  const m: Closes = new Map();
  for (const [symbol, byDate] of Object.entries(series)) m.set(symbol, { dates: Object.keys(byDate).sort(), close: new Map(Object.entries(byDate)) });
  return m;
}

const stated = (over: Partial<StatedForecast> = {}): StatedForecast => ({
  source: "thesis",
  id: "aapl-services",
  symbol: "AAPL",
  leadSignal: "fundamental",
  beatVtiPct: 60,
  expectedExcessPct: "5",
  horizon: "2026-11-06",
  statedAt: at("2026-11-02T16:50:00Z"), // 11:50 ET Monday
  backfilled: false,
  ...over,
});

describe("thesisForecasts", () => {
  const f = { beatVtiPct: 60, expectedExcessPct: "5", horizon: "2026-12-01" };
  it("scores each thesis's first forecast, flags a backfill, and defaults the horizon to the review date", () => {
    const v1 = { createdAt: at("2026-11-02T13:00:00Z"), document: strategy({ conviction: [thesis({ forecast: undefined, leadSignal: undefined })] }) };
    const v2 = { createdAt: at("2026-11-03T13:00:00Z"), document: strategy({ conviction: [thesis({ forecast: f }), thesis({ id: "msft-a", symbol: "MSFT", reviewBy: "2026-12-15", forecast: { beatVtiPct: 55, expectedExcessPct: "3" } })] }) };
    const v3 = { createdAt: at("2026-11-04T13:00:00Z"), document: strategy({ conviction: [thesis({ forecast: { ...f, beatVtiPct: 80 } })] }) };
    const { forecasts } = thesisForecasts([v3, v1, v2]);
    expect(forecasts).toEqual([
      expect.objectContaining({ id: "aapl-services", beatVtiPct: 60, statedAt: v2.createdAt, backfilled: true }),
      expect.objectContaining({ id: "msft-a", beatVtiPct: 55, horizon: "2026-12-15", backfilled: false }),
    ]);
  });
});

describe("watchlistForecasts", () => {
  const note = (symbol: string, action: string, iso: string, beatVtiPct: number | null = null) => ({ symbol, action, at: at(iso), beatVtiPct, expectedExcessPct: beatVtiPct === null ? null : "2", horizon: beatVtiPct === null ? null : "2026-12-01" });
  it("takes the first forecast of each stay on the list, and a drop starts a new stay", () => {
    const { forecasts, stays } = watchlistForecasts([
      note("GGG", "watch", "2026-11-02T15:00:00Z"),
      note("GGG", "watch", "2026-11-03T15:00:00Z", 40),
      note("GGG", "watch", "2026-11-04T15:00:00Z", 30),
      note("GGG", "drop", "2026-11-05T15:00:00Z"),
      note("GGG", "watch", "2026-11-06T15:00:00Z", 50),
    ]);
    expect(forecasts.map((f) => [f.beatVtiPct, f.statedAt.toISOString()])).toEqual([
      [40, "2026-11-03T15:00:00.000Z"],
      [50, "2026-11-06T15:00:00.000Z"],
    ]);
    expect(stays.map((s) => s.since.toISOString())).toEqual(["2026-11-02T15:00:00.000Z", "2026-11-06T15:00:00.000Z"]);
  });
});

describe("resolveForecast", () => {
  // AAPL +10% Mon→Fri, VTI +2%: excess +8 points.
  const closes = closesOf({
    AAPL: { "2026-11-02": "100", "2026-11-03": "101", "2026-11-06": "110", "2026-11-09": "90" },
    VTI: { "2026-11-02": "300", "2026-11-03": "301", "2026-11-06": "306", "2026-11-09": "300" },
  });

  it("runs from the first close after it was stated to the close on its horizon", () => {
    expect(resolveForecast(stated(), closes)).toMatchObject({ startDate: "2026-11-02", endDate: "2026-11-06", resolved: true, beat: true, excessPct: "8" });
    // Stated after Monday's close: it starts Tuesday.
    expect(resolveForecast(stated({ statedAt: at("2026-11-02T21:30:00Z") }), closes)).toMatchObject({ startDate: "2026-11-03" });
  });

  it("rolls a horizon with no session to the next close, and misses when the stock trails", () => {
    // Saturday's horizon resolves on Monday 11/9: AAPL −10%, VTI 0%.
    expect(resolveForecast(stated({ horizon: "2026-11-07" }), closes)).toMatchObject({ endDate: "2026-11-09", beat: false, excessPct: "-10" });
  });

  it("stays open until the horizon's close is recorded", () => {
    expect(resolveForecast(stated({ horizon: "2026-11-20" }), closes)).toMatchObject({ resolved: false, beat: null, startDate: "2026-11-02" });
    expect(resolveForecast(stated({ symbol: "NVDA" }), closes)).toMatchObject({ resolved: false });
  });
});

describe("calibrate", () => {
  const outcome = (beatVtiPct: number, beat: boolean, excessPct: string, expectedExcessPct = "5"): ForecastOutcome => ({ ...stated({ beatVtiPct, expectedExcessPct }), startDate: "x", endDate: "y", resolved: true, beat, excessPct });

  it("computes Brier, skill against the 45% base rate, and the buckets", () => {
    // Brier: ((0.6−1)² + (0.7−0)²)/2 = 0.325. Base: ((0.45−1)² + 0.45²)/2 = 0.2525. Skill 1 − 0.325/0.2525.
    const c = calibrate([outcome(60, true, "8"), outcome(70, false, "-3", "10"), { ...outcome(50, true, "1"), resolved: false, beat: null, excessPct: null }]);
    expect(c).toMatchObject({ forecasts: 3, resolved: 2, brier: 0.325, skill: -0.2871, meanExpectedExcessPct: 7.5, meanRealizedExcessPct: 2.5, excessCorrelation: null, tooFewToJudge: true });
    expect(c.buckets).toEqual([
      { range: "5–34%", count: 0, meanForecastPct: null, beatPct: null },
      { range: "35–49%", count: 0, meanForecastPct: null, beatPct: null },
      { range: "50–64%", count: 1, meanForecastPct: 60, beatPct: 100 },
      { range: "65–95%", count: 1, meanForecastPct: 70, beatPct: 0 },
    ]);
  });

  it("has nulls with nothing resolved", () => {
    expect(calibrate([])).toMatchObject({ resolved: 0, brier: null, skill: null, tooFewToJudge: true });
  });
});

describe("forecastReport", () => {
  const days = sessions(25);
  // Bought AAPL rises 1% a session, passed GGG falls 1% a session, VTI is flat: after 20 sessions +20 and −20 points.
  const series = (start: number, step: number) => Object.fromEntries(days.map((d, i) => [d, String(start + step * i)]));
  const closes = closesOf({ AAPL: series(100, 1), GGG: series(100, -1), MSFT: series(100, 0), VTI: series(300, 0) });
  const versions = [
    { createdAt: at("2026-11-02T13:00:00Z"), document: strategy({ conviction: [thesis({ forecast: { beatVtiPct: 70, expectedExcessPct: "10", horizon: "2026-11-06" } })] }) },
    { createdAt: at("2026-11-03T13:00:00Z"), document: strategy({ conviction: [thesis({ forecast: { beatVtiPct: 70, expectedExcessPct: "10", horizon: "2026-11-06" } }), thesis({ id: "msft-a", symbol: "MSFT", forecast: { beatVtiPct: 50, expectedExcessPct: "1", horizon: "2026-11-06" } })] }) },
  ];
  const notes = [{ symbol: "GGG", action: "watch", at: at("2026-11-02T15:00:00Z"), beatVtiPct: 30, expectedExcessPct: "-2", horizon: "2026-11-06" }];

  it("keeps backfills out of the headline, splits by source and lead signal, and lists what's open", () => {
    const backfill = [{ createdAt: at("2026-11-02T13:00:00Z"), document: strategy({ conviction: [thesis({ id: "lkq-a", symbol: "MSFT", forecast: undefined })] }) }, { createdAt: at("2026-11-03T13:00:00Z"), document: strategy({ conviction: [thesis({ id: "lkq-a", symbol: "MSFT", forecast: { beatVtiPct: 90, expectedExcessPct: "1", horizon: "2026-12-30" } })] }) }];
    const r = forecastReport({ versions: [...versions, ...backfill], notes, closes, now: at("2026-11-13T21:00:00Z") });
    expect(r.overall).toMatchObject({ forecasts: 3, resolved: 3 });
    expect(r.bySource.thesis.resolved).toBe(2);
    expect(r.bySource.watchlist).toMatchObject({ resolved: 1, buckets: expect.arrayContaining([{ range: "5–34%", count: 1, meanForecastPct: 30, beatPct: 0 }]) });
    expect(r.bySource.backfilled).toMatchObject({ forecasts: 1, resolved: 0 });
    expect(r.byLeadSignal.map((k) => [k.leadSignal, k.forecasts])).toEqual([["fundamental", 2]]);
    expect(r.open).toEqual([{ source: "thesis", id: "lkq-a", symbol: "MSFT", beatVtiPct: 90, horizon: "2026-12-30", daysToHorizon: 47, backfilled: true }]);
    // All three resolve on 11/6's close: AAPL beat VTI, flat MSFT and falling GGG didn't.
    expect(r.resolved.map((o) => [o.source, o.symbol, o.endDate, o.beat, o.backfilled])).toEqual([
      ["thesis", "AAPL", "2026-11-06", true, false],
      ["watchlist", "GGG", "2026-11-06", false, false],
      ["thesis", "MSFT", "2026-11-06", false, false],
    ]);
  });

  it("compares bought with passed at 20 trading days, once there are 20", () => {
    const r = forecastReport({ versions, notes, closes, now: at("2026-12-07T21:00:00Z") });
    const twenty = r.boughtVsPassed.find((b) => b.days === 20)!;
    // AAPL from 11/2's close: +20 points; MSFT from 11/3: 0; GGG: −20.
    expect(twenty).toMatchObject({ bought: { count: 2, meanExcessPct: 10, beatPct: 50 }, passed: { count: 1, meanExcessPct: -20 }, differencePct: 30 });
    expect(r.boughtVsPassed.find((b) => b.days === 60)).toMatchObject({ bought: { count: 0 }, passed: { count: 0 }, differencePct: null });
  });
});

describe("loadForecastReport", () => {
  it("reads the report from the database alone", async () => {
    const { db } = await createTestDb();
    await db.insert(strategies).values({ authoredBy: "claude", createdAt: at("2026-11-02T13:00:00Z"), summary: "v1", document: strategy({ conviction: [thesis({ forecast: { beatVtiPct: 60, expectedExcessPct: "5", horizon: "2026-11-04" } })] }) as unknown as Record<string, unknown> });
    await db.insert(watchlistNotes).values({ symbol: "GGG", action: "watch", why: "Buyback, but guidance fell", trigger: "Q4 margins recover", revisitBy: "2026-12-01", beatVtiPct: 40, expectedExcessPct: "-1", horizon: "2026-12-01", actor: "claude", at: at("2026-11-02T15:00:00Z") });
    await db.insert(thesisCloses).values([
      { symbol: "AAPL", tradingDate: "2026-11-02", close: "100" },
      { symbol: "AAPL", tradingDate: "2026-11-04", close: "105" },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-11-02", close: "300" },
      { symbol: "VTI", tradingDate: "2026-11-04", close: "303" },
    ]);
    const r = await loadForecastReport(db, at("2026-11-05T12:00:00Z"));
    expect(r.bySource.thesis).toMatchObject({ resolved: 1, meanRealizedExcessPct: 4 });
    expect(r.open).toEqual([expect.objectContaining({ source: "watchlist", symbol: "GGG", beatVtiPct: 40 })]);
  });
});
