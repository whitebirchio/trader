/**
 * Event-study machinery shared by Trader's signal backtests (#29 insider buys,
 * the earnings-reaction backtest): enter after an event if risk would allow
 * the buy, measure the return against VTI over the same trading days, and
 * summarise by bucket.
 *
 * Research only: nothing here places orders or touches the account, so
 * returns and statistics are plain JS numbers (ADR-009 governs the account's
 * money, not ratios in a report).
 */

/** A daily bar for research: adjusted close and volume as numbers. */
export interface DailyBar {
  date: string;
  close: number;
  volume: number;
}

export const HORIZONS = [20, 60, 120] as const;
export type Horizon = (typeof HORIZONS)[number];

/** An event's outcome. `E` is the event (an insider buy, an earnings release, …). */
export interface EventOutcome<E> {
  event: E;
  entryDate: string;
  entryClose: number;
  /** The stock's return over the 60 trading days before entry; null without the history. */
  prior60: number | null;
  /** Return minus VTI's over the same days, per horizon; null if the window isn't complete. */
  excess: Record<Horizon, number | null>;
  ret: Record<Horizon, number | null>;
}

export type OutcomeSkip<E> = { skip: "no bars" | "no entry" | "untradable" | "no VTI"; event: E; detail?: string };

export interface Tradability {
  minPrice: number;
  minAvgDollarVolume: number;
  avgDollarVolumeDays: number;
}

/** The close on `date`, or the last one before it (binary search; `bars` ascending). */
export function closeOnOrBefore(bars: DailyBar[], date: string): number | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      found = bars[mid]!.close;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Enter at the first close after `after` (a date: when the news became public,
 * or a later day the strategy could act on), if the stock passes risk's price
 * and liquidity filters on the bars before entry; then measure the return
 * against VTI's over the same trading days. `bars` and `vti` are ascending.
 */
export function outcomeAfter<E>(event: E, after: string, bars: DailyBar[], vti: DailyBar[], t: Tradability): EventOutcome<E> | OutcomeSkip<E> {
  if (bars.length === 0) return { skip: "no bars", event };
  const entry = bars.findIndex((b) => b.date > after);
  if (entry < 0) return { skip: "no entry", event };
  const e = bars[entry]!;

  const window = bars.slice(Math.max(0, entry - t.avgDollarVolumeDays), entry);
  const adv = window.length > 0 ? window.reduce((s, b) => s + b.close * b.volume, 0) / window.length : 0;
  if (e.close < t.minPrice || window.length < t.avgDollarVolumeDays || adv < t.minAvgDollarVolume) {
    return { skip: "untradable", event, detail: `close ${e.close.toFixed(2)}, ${window.length}-day ADV ${Math.round(adv)}` };
  }

  const vtiOn = (date: string) => closeOnOrBefore(vti, date);
  const vtiEntry = vtiOn(e.date);
  if (vtiEntry === undefined) return { skip: "no VTI", event };

  const ret = {} as Record<Horizon, number | null>;
  const excess = {} as Record<Horizon, number | null>;
  for (const h of HORIZONS) {
    const exit = bars[entry + h];
    const vtiExit = exit && vtiOn(exit.date);
    ret[h] = exit ? exit.close / e.close - 1 : null;
    excess[h] = exit && vtiExit !== undefined ? exit.close / e.close - vtiExit / vtiEntry : null;
  }
  const before = bars[entry - 61];
  const prior = bars[entry - 1];
  return { event, entryDate: e.date, entryClose: e.close, prior60: before && prior ? prior.close / before.close - 1 : null, excess, ret };
}

export interface BucketStats {
  n: number;
  /** Mean, median and standard error of excess return; null with no rows. */
  mean: number | null;
  median: number | null;
  stdError: number | null;
  /** Share of rows that beat VTI. */
  beatShare: number | null;
}

/** Statistics of excess return at one horizon over rows whose window is complete. */
export function bucketStats(rows: { excess: Record<Horizon, number | null> }[], horizon: Horizon): BucketStats {
  const xs = rows.map((r) => r.excess[horizon]).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n, mean: null, median: null, stdError: null, beatShare: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, median, stdError: Math.sqrt(variance / n), beatShare: xs.filter((x) => x > 0).length / n };
}

/** Group outcomes by a breakdown's labels, in label order. */
export function breakdown<R>(rows: R[], label: (o: R) => string | null): Map<string, R[]> {
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    const key = label(r);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}
