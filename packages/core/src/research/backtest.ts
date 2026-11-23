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
/** For signals from long-horizon investors (#138): a year as well. */
export const LONG_HORIZONS = [20, 60, 120, 250] as const;
export type LongHorizon = (typeof LONG_HORIZONS)[number];

/** An event's outcome. `E` is the event (an insider buy, an earnings release, …); `H` its horizons. */
export interface EventOutcome<E, H extends number = Horizon> {
  event: E;
  entryDate: string;
  entryClose: number;
  /** The stock's return over the 60 trading days before entry; null without the history. */
  prior60: number | null;
  /** Return minus VTI's over the same days, per horizon; null if the window isn't complete. */
  excess: Record<H, number | null>;
  ret: Record<H, number | null>;
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
export function outcomeAfter<E, H extends number = Horizon>(
  event: E,
  after: string,
  bars: DailyBar[],
  vti: DailyBar[],
  t: Tradability,
  horizons: readonly H[] = HORIZONS as unknown as readonly H[],
): EventOutcome<E, H> | OutcomeSkip<E> {
  if (bars.length === 0) return { skip: "no bars", event };
  const entry = bars.findIndex((b) => b.date > after);
  if (entry < 0) return { skip: "no entry", event };
  return outcomeAt(event, bars, entry, vti, t, horizons);
}

/** outcomeAfter with the entry bar's index already known (for callers scoring many dates per symbol). */
export function outcomeAt<E, H extends number = Horizon>(
  event: E,
  bars: DailyBar[],
  entry: number,
  vti: DailyBar[],
  t: Tradability,
  horizons: readonly H[] = HORIZONS as unknown as readonly H[],
): EventOutcome<E, H> | OutcomeSkip<E> {
  const e = bars[entry];
  if (!e) return { skip: "no entry", event };

  const window = bars.slice(Math.max(0, entry - t.avgDollarVolumeDays), entry);
  const adv = window.length > 0 ? window.reduce((s, b) => s + b.close * b.volume, 0) / window.length : 0;
  if (e.close < t.minPrice || window.length < t.avgDollarVolumeDays || adv < t.minAvgDollarVolume) {
    return { skip: "untradable", event, detail: `close ${e.close.toFixed(2)}, ${window.length}-day ADV ${Math.round(adv)}` };
  }

  const vtiOn = (date: string) => closeOnOrBefore(vti, date);
  const vtiEntry = vtiOn(e.date);
  if (vtiEntry === undefined) return { skip: "no VTI", event };

  const ret = {} as Record<H, number | null>;
  const excess = {} as Record<H, number | null>;
  for (const h of horizons) {
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
export function bucketStats<H extends number = Horizon>(rows: { excess: Record<H, number | null> }[], horizon: H): BucketStats {
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

export interface CohortStats {
  /** Cohorts with at least one complete window. */
  cohorts: number;
  events: number;
  /** Mean of the cohorts' mean excess returns, and its standard error across cohorts; null with no cohorts. */
  mean: number | null;
  stdError: number | null;
  /** Share of cohorts whose mean beat VTI. */
  beatShare: number | null;
}

/**
 * Excess return at one horizon with the cohort (a filing period, a month) as
 * the unit: events that land together aren't independent, so each cohort's
 * mean counts once.
 */
export function cohortStats<R extends { excess: Record<H, number | null> }, H extends number>(rows: R[], cohortOf: (r: R) => string, horizon: H): CohortStats {
  const sums = new Map<string, { sum: number; n: number }>();
  let events = 0;
  for (const r of rows) {
    const x = r.excess[horizon];
    if (x === null) continue;
    events++;
    const c = sums.get(cohortOf(r)) ?? { sum: 0, n: 0 };
    c.sum += x;
    c.n++;
    sums.set(cohortOf(r), c);
  }
  const means = [...sums.values()].map((c) => c.sum / c.n);
  const n = means.length;
  if (n === 0) return { cohorts: 0, events, mean: null, stdError: null, beatShare: null };
  const mean = means.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? means.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { cohorts: n, events, mean, stdError: Math.sqrt(variance / n), beatShare: means.filter((x) => x > 0).length / n };
}

/** The promotion rule for #138, fixed before any results. */
export const PROMOTION = { roundTrip: 0.002, minStdErrors: 2 } as const;

export interface PromotionInput {
  /** Cohort statistics at 60 trading days, in-sample and held out, and at 120 in-sample. */
  inSample60: CohortStats;
  heldOut60: CohortStats;
  inSample120: CohortStats;
}

export type PromotionTest = "in-sample 60d" | "held-out 60d" | "in-sample 2 SE" | "120d reverses";

/**
 * A bucket passes if, after a round trip's cost, its 60-day mean beats VTI
 * in-sample and held out, the in-sample mean is at least 2 standard errors
 * above zero, and the 120-day in-sample mean doesn't reverse it.
 */
export function promotion(x: PromotionInput): { pass: boolean; failed: PromotionTest[] } {
  const net = (s: CohortStats) => (s.mean === null ? null : s.mean - PROMOTION.roundTrip);
  const failed: PromotionTest[] = [];
  const in60 = net(x.inSample60);
  const out60 = net(x.heldOut60);
  const in120 = net(x.inSample120);
  if (in60 === null || in60 <= 0) failed.push("in-sample 60d");
  if (out60 === null || out60 <= 0) failed.push("held-out 60d");
  if (in60 === null || x.inSample60.stdError === null || x.inSample60.cohorts < 2 || in60 < PROMOTION.minStdErrors * x.inSample60.stdError) failed.push("in-sample 2 SE");
  if (in120 === null || in120 <= 0) failed.push("120d reverses");
  return { pass: failed.length === 0, failed };
}
