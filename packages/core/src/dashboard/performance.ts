/**
 * The Performance page's figures (SPEC-dashboard Amendment 3): for every range
 * at once, the dollars made or lost, the time-weighted return, VTI's return,
 * and the same money held in VTI, so the page can show them in one table.
 * Database only, like the other read models.
 */
import { asc, eq } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { sameMoneyInBenchmark } from "../capital/shadow.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses } from "../db/schema.js";
import { round, sub } from "../money.js";
import { compareToBenchmark } from "../portfolio/benchmark.js";
import { type DailyEquity, type IndexFlow, buildIndex } from "../risk/equity-index.js";
import { loadIndexInputs } from "../risk/gate.js";
import { marketDate } from "../time.js";
import { type ChartRange, PERFORMANCE_RANGES, rangeFrom, rangeOptions, windowBase } from "./ranges.js";
import { type PerformanceSeries, performanceSeries } from "./views.js";

export interface MoneyWindow {
  since: string;
  through: string;
  /** Equity at the `since` close. */
  startValue: string;
  /** Net deposits (+) and withdrawals (−) inside the window. */
  addedSince: string;
  /** Equity at the `through` close. */
  value: string;
  /** Profit or loss: value − startValue − addedSince. */
  pnl: string;
  /** The same money held in VTI, at the `through` close; null without closes. */
  sameFlowsInVti: string | null;
  /** What VTI would have made on the same money. */
  vtiPnl: string | null;
  /** pnl − vtiPnl: dollars ahead of (+) or behind (−) VTI. */
  gapUsd: string | null;
}

/** The money-weighted figures between two snapshots: what the account made, and what the same flows would have made in VTI. Pure. */
export function moneyWindow(start: DailyEquity, end: DailyEquity, flows: IndexFlow[], closes: { tradingDate: string; close: string }[]): MoneyWindow {
  const { addedSince, sameFlowsInVti } = sameMoneyInBenchmark(start, end, flows, closes);
  const pnl = sub(sub(end.equity, start.equity), addedSince);
  const vtiPnl = sameFlowsInVti === null ? null : sub(sub(sameFlowsInVti, start.equity), addedSince);
  return {
    since: start.tradingDate,
    through: end.tradingDate,
    startValue: start.equity,
    addedSince,
    value: end.equity,
    pnl: round(pnl, 2, "half-even"),
    sameFlowsInVti,
    vtiPnl: vtiPnl === null ? null : round(vtiPnl, 2, "half-even"),
    gapUsd: vtiPnl === null ? null : round(sub(pnl, vtiPnl), 2, "half-even"),
  };
}

export interface RangeFigures extends Partial<MoneyWindow> {
  range: ChartRange;
  label: string;
  available: boolean;
  reason?: string;
  /** The flow-adjusted (time-weighted) return over the range, %. */
  returnPct?: string;
  /** VTI's return over the same closes, %. */
  vtiPct?: string;
  /** returnPct − vtiPct, in points. */
  gapPts?: string;
}

export interface PerformanceView {
  range: ChartRange;
  /** Every range's figures, in PERFORMANCE_RANGES order; unavailable ones say why. */
  ranges: RangeFigures[];
  /** The chosen range's chart. */
  series: PerformanceSeries;
}

export async function performanceView(db: Db, requested: ChartRange = "all"): Promise<PerformanceView> {
  const { snapshots: snaps, flows } = await loadIndexInputs(db);
  const series = await performanceSeries(db, requested, PERFORMANCE_RANGES);
  if (snaps.length === 0) return { range: series.range, ranges: rangeOptions(PERFORMANCE_RANGES, [], "").map((o) => ({ ...o })), series };
  const index = buildIndex(snaps, flows);
  const closes = await db
    .select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close })
    .from(benchmarkCloses)
    .where(eq(benchmarkCloses.symbol, BENCHMARK))
    .orderBy(asc(benchmarkCloses.tradingDate));
  // Midday ET keeps marketDate() on the stored trading date.
  const bars = closes.map((c) => ({ t: new Date(`${c.tradingDate}T17:00:00Z`), c: c.close }));
  const dates = snaps.map((s) => s.tradingDate);
  const end = dates.at(-1)!;
  const ranges = rangeOptions(PERFORMANCE_RANGES, dates, end).map((o): RangeFigures => {
    const base = o.available ? windowBase(dates, rangeFrom(o.range, end)) : null;
    if (base === null || base === dates.length - 1) return { ...o, ...(o.available ? { available: false, reason: "needs two sessions" } : {}) };
    const money = moneyWindow(snaps[base]!, snaps.at(-1)!, flows, closes);
    const tw = compareToBenchmark(index.points.slice(base), bars, marketDate);
    return {
      ...o,
      ...money,
      ...(tw ? { returnPct: tw.portfolioPct, vtiPct: tw.benchmarkPct, gapPts: round(sub(tw.portfolioPct, tw.benchmarkPct), 2, "half-even") } : {}),
    };
  });
  return { range: series.range, ranges, series };
}

