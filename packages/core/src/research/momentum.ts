import { type DailyBar, HORIZONS, type Horizon, type Tradability, outcomeAt } from "./backtest.js";

/**
 * The momentum backtest (#49, tasks/momentum-quality-plan.md): at each
 * month-end, rank the tradable stocks by their past return and measure each
 * decile against VTI over the next 20 and 60 trading days. Pure: the script
 * loads bars and writes the report.
 *
 * Stocks in the same month move together, so a decile's result is averaged
 * per month first and the statistics run over that monthly series
 * (seriesStats), not over pooled stock-months.
 */

/** Results from this date on are held out: computed, but read only to confirm an in-sample choice. */
export const HELD_OUT_FROM = "2024-01-01";

/** A momentum signal: the return from `lookback` sessions ago to `skip` sessions ago (12-1 = 252/21). */
export interface MomentumSpec {
  name: string;
  lookback: number;
  skip: number;
  /** Only stocks above their 200-session average take part. */
  trendFilter: boolean;
}

export const SPECS: MomentumSpec[] = [
  { name: "12-1 month", lookback: 252, skip: 21, trendFilter: false },
  { name: "12-1 month, above the 200-day average", lookback: 252, skip: 21, trendFilter: true },
  { name: "6-1 month", lookback: 126, skip: 21, trendFilter: false },
];

/** The last session of each calendar month in `sessions` (ascending dates), from `from` through `to`. */
export function monthEnds(sessions: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const d = sessions[i]!;
    const next = sessions[i + 1];
    if (d >= from && d <= to && (!next || next.slice(0, 7) !== d.slice(0, 7))) out.push(d);
  }
  return out;
}

/** The return from `lookback` bars before `i` to `skip` bars before it; null without the history. */
export function momentumSignal(bars: DailyBar[], i: number, lookback: number, skip: number): number | null {
  const from = bars[i - lookback];
  const to = bars[i - skip];
  return from && to && from.close > 0 ? to.close / from.close - 1 : null;
}

/** Whether bar `i` closes above the average of the `days` closes ending at it; null without the history. */
export function aboveAverage(bars: DailyBar[], i: number, days = 200): boolean | null {
  if (i + 1 < days) return null;
  let sum = 0;
  for (let k = i - days + 1; k <= i; k++) sum += bars[k]!.close;
  return bars[i]!.close > sum / days;
}

export interface FormationRow {
  symbol: string;
  date: string;
  signal: number;
  /** Excess return vs VTI from the first close after `date`; null if the window isn't complete. */
  excess: Record<Horizon, number | null>;
}

const DAY_MS = 86_400_000;

/**
 * One symbol's rows for a spec at each formation date: the stock must have a
 * bar within a week before the date (not halted or delisted), the history
 * for the signal (and the trend filter), and pass risk's filters at entry.
 */
export function formationRows(symbol: string, bars: DailyBar[], vti: DailyBar[], dates: string[], spec: MomentumSpec, t: Tradability): FormationRow[] {
  const rows: FormationRow[] = [];
  let i = -1;
  for (const date of dates) {
    while (i + 1 < bars.length && bars[i + 1]!.date <= date) i++;
    if (i < 0 || Date.parse(`${date}T00:00:00Z`) - Date.parse(`${bars[i]!.date}T00:00:00Z`) > 7 * DAY_MS) continue;
    const signal = momentumSignal(bars, i, spec.lookback, spec.skip);
    if (signal === null) continue;
    if (spec.trendFilter && aboveAverage(bars, i) !== true) continue;
    const o = outcomeAt(null, bars, i + 1, vti, t);
    if ("skip" in o) continue;
    rows.push({ symbol, date, signal, excess: o.excess });
  }
  return rows;
}

/** Decile per row (1 = lowest signal, 10 = highest), ranked within each formation date. */
export function assignDeciles(rows: FormationRow[]): Map<FormationRow, number> {
  const byDate = new Map<string, FormationRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const out = new Map<FormationRow, number>();
  for (const list of byDate.values()) {
    list.sort((a, b) => a.signal - b.signal || a.symbol.localeCompare(b.symbol));
    list.forEach((r, rank) => out.set(r, Math.floor((rank * 10) / list.length) + 1));
  }
  return out;
}

export interface MonthlyMean {
  date: string;
  decile: number;
  /** Stocks in the decile that month. */
  n: number;
  /** Mean excess over the stocks whose window is complete; null if none are. */
  mean: Record<Horizon, number | null>;
}

/** Each month's mean excess per decile. */
export function monthlyDecileMeans(rows: FormationRow[], deciles: Map<FormationRow, number>): MonthlyMean[] {
  const groups = new Map<string, FormationRow[]>();
  for (const r of rows) {
    const key = `${r.date}|${deciles.get(r)}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: MonthlyMean[] = [];
  for (const [key, list] of groups) {
    const [date, decile] = key.split("|");
    const mean = {} as Record<Horizon, number | null>;
    for (const h of HORIZONS) {
      const xs = list.map((r) => r.excess[h]).filter((x): x is number => x !== null);
      mean[h] = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    }
    out.push({ date: date!, decile: Number(decile), n: list.length, mean });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.decile - b.decile);
}

/** Top decile minus bottom decile, per month. */
export function topMinusBottom(means: MonthlyMean[]): MonthlyMean[] {
  const byDate = new Map<string, MonthlyMean[]>();
  for (const m of means) {
    const list = byDate.get(m.date) ?? [];
    list.push(m);
    byDate.set(m.date, list);
  }
  const out: MonthlyMean[] = [];
  for (const [date, list] of byDate) {
    const top = list.find((m) => m.decile === 10);
    const bottom = list.find((m) => m.decile === 1);
    if (!top || !bottom) continue;
    const mean = {} as Record<Horizon, number | null>;
    for (const h of HORIZONS) mean[h] = top.mean[h] !== null && bottom.mean[h] !== null ? top.mean[h]! - bottom.mean[h]! : null;
    out.push({ date, decile: 0, n: top.n + bottom.n, mean });
  }
  return out;
}

export interface SeriesStats {
  /** Months with a value. */
  months: number;
  mean: number | null;
  /** Standard error over months. */
  stdError: number | null;
  /** Share of months above zero. */
  positiveShare: number | null;
}

/** Statistics of a monthly series (nulls skipped). */
export function seriesStats(values: (number | null)[]): SeriesStats {
  const xs = values.filter((x): x is number => x !== null);
  const n = xs.length;
  if (n === 0) return { months: 0, mean: null, stdError: null, positiveShare: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { months: n, mean, stdError: Math.sqrt(variance / n), positiveShare: xs.filter((x) => x > 0).length / n };
}

/** In-sample (before HELD_OUT_FROM) or held out. */
export const period = (date: string) => (date < HELD_OUT_FROM ? "in-sample" : "held-out");
