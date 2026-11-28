/**
 * The signal-combination study (#140, tasks/signal-combos-spec.md): a
 * point-in-time timeline of six signals per stock, and the pieces the five
 * tests are built from. Pure: the script loads the caches and scores.
 *
 * Event signals fire on the day they became public; state signals hold as of
 * their latest formation (a month-end for momentum, an April for quality).
 * Dates are YYYY-MM-DD; windows are calendar days.
 */

export type EventKind = "insider" | "thirteenF" | "earnings" | "stake";
export type StateKind = "momentum" | "quality";
export type SignalKind = EventKind | StateKind;
export const EVENT_KINDS: readonly EventKind[] = ["insider", "thirteenF", "earnings", "stake"];

/** The window an event stays active for, and the one-row-per-stock spacing: 90 days (the spec). */
export const WINDOW_DAYS = 90;
/** Top-decile cut for the quality state signal; test 4 uses the top 30%. */
export const QUALITY_TOP = 0.9;

export interface SignalEvent {
  symbol: string;
  kind: EventKind;
  /** The day it became public: the anchor's date, and what an entry follows. */
  date: string;
}

export interface SignalTimeline {
  /** Each symbol's public dates by event kind, ascending. */
  events: Map<string, Map<EventKind, string[]>>;
  /** Month-ends ascending, and the top-decile momentum symbols at each. */
  momentum: { dates: string[]; top: Map<string, Set<string>> };
  /** April formations ascending, and each symbol's gross-profitability percentile (0–1) at each. */
  quality: { dates: string[]; pct: Map<string, Map<string, number>> };
}

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export function buildTimeline(events: SignalEvent[], momentum: SignalTimeline["momentum"], quality: SignalTimeline["quality"]): SignalTimeline {
  const bySymbol = new Map<string, Map<EventKind, string[]>>();
  for (const e of events) {
    const kinds = bySymbol.get(e.symbol) ?? new Map<EventKind, string[]>();
    kinds.set(e.kind, [...(kinds.get(e.kind) ?? []), e.date]);
    bySymbol.set(e.symbol, kinds);
  }
  for (const kinds of bySymbol.values()) for (const [k, dates] of kinds) kinds.set(k, [...new Set(dates)].sort());
  return { events: bySymbol, momentum: { dates: [...momentum.dates].sort(), top: momentum.top }, quality: { dates: [...quality.dates].sort(), pct: quality.pct } };
}

/** The last of ascending `dates` on or before `date`; null if none. */
export function latestOnOrBefore(dates: string[], date: string): string | null {
  let found: string | null = null;
  for (const d of dates) {
    if (d > date) break;
    found = d;
  }
  return found;
}

export function momentumTop(t: SignalTimeline, symbol: string, date: string): boolean {
  const asOf = latestOnOrBefore(t.momentum.dates, date);
  return asOf !== null && (t.momentum.top.get(asOf)?.has(symbol) ?? false);
}

/** The symbol's gross-profitability percentile as of `date`'s latest formation; null without data. */
export function qualityPercentile(t: SignalTimeline, symbol: string, date: string): number | null {
  const asOf = latestOnOrBefore(t.quality.dates, date);
  return asOf === null ? null : (t.quality.pct.get(asOf)?.get(symbol) ?? null);
}

/** Whether an event of `kind` on `symbol` became public within the WINDOW_DAYS up to and including `date`. */
export function eventActive(t: SignalTimeline, symbol: string, kind: EventKind, date: string, windowDays = WINDOW_DAYS): boolean {
  return (t.events.get(symbol)?.get(kind) ?? []).some((d) => d <= date && daysBetween(d, date) <= windowDays);
}

/** The signals active on `symbol` at `date`, leaving out `except` (the anchor's own kind). */
export function activeSignals(t: SignalTimeline, symbol: string, date: string, except?: SignalKind): SignalKind[] {
  const out: SignalKind[] = EVENT_KINDS.filter((k) => k !== except && eventActive(t, symbol, k, date));
  if (except !== "momentum" && momentumTop(t, symbol, date)) out.push("momentum");
  if (except !== "quality") {
    const q = qualityPercentile(t, symbol, date);
    if (q !== null && q >= QUALITY_TOP) out.push("quality");
  }
  return out;
}

/** The first anchor per stock in each WINDOW_DAYS, so one stock with several signals counts once. Sorted by date. */
export function firstAnchors<A extends { symbol: string; date: string }>(anchors: A[], windowDays = WINDOW_DAYS): A[] {
  const kept: A[] = [];
  const last = new Map<string, string>();
  for (const a of [...anchors].sort((x, y) => x.date.localeCompare(y.date) || x.symbol.localeCompare(y.symbol))) {
    const prev = last.get(a.symbol);
    if (prev !== undefined && daysBetween(prev, a.date) <= windowDays) continue;
    kept.push(a);
    last.set(a.symbol, a.date);
  }
  return kept;
}

export interface PairEntry {
  symbol: string;
  first: SignalEvent;
  second: SignalEvent;
  /** When the pair became public: the later signal's date. */
  date: string;
}

/** Two signals of the given kinds on one stock within WINDOW_DAYS, entered on the later one; one pair per stock per window. */
export function pairEntries(t: SignalTimeline, a: EventKind, b: EventKind, windowDays = WINDOW_DAYS): PairEntry[] {
  const pairs: PairEntry[] = [];
  for (const [symbol, kinds] of t.events) {
    for (const da of kinds.get(a) ?? []) {
      for (const db of kinds.get(b) ?? []) {
        if (Math.abs(daysBetween(da, db)) > windowDays) continue;
        const [first, second] = da <= db ? [{ symbol, kind: a, date: da }, { symbol, kind: b, date: db }] : [{ symbol, kind: b, date: db }, { symbol, kind: a, date: da }];
        pairs.push({ symbol, first, second, date: second.date });
      }
    }
  }
  return firstAnchors(pairs, windowDays);
}

/** Whether a fresh earnings crash (a reaction date in `crashDates`) falls within the `n` sessions up to and including `date`. */
export function freshCrash(crashDates: string[], sessions: string[], date: string, n = 10): boolean {
  const at = sessions.findIndex((s) => s >= date);
  const i = at === -1 ? sessions.length - 1 : sessions[at] === date ? at : at - 1;
  if (i < 0) return false;
  const from = sessions[Math.max(0, i - n + 1)]!;
  return crashDates.some((d) => d >= from && d <= sessions[i]!);
}

/** The anchors with no warning flag: no recent big loser, no fresh earnings crash. */
export function screened<A>(anchors: A[], flagged: (a: A) => boolean): A[] {
  return anchors.filter((a) => !flagged(a));
}

export interface SlopeRow {
  /** The cohort: the entry's month (YYYY-MM). */
  month: string;
  /** Other signals active at the anchor, capped at 3 (3 means 3+). */
  count: number;
  /** The excess return over the horizon, after costs if the caller applies them. */
  value: number;
}

export interface CountSlope {
  /** The mean of the monthly slopes: excess return per additional agreeing signal. */
  slope: number | null;
  /** Its standard error across months. */
  stdError: number | null;
  /** Months with at least two count groups, the only ones that give a slope. */
  months: number;
}

/**
 * The dose-response test: each month's least-squares slope of its group means
 * (by signal count) against the count, then the mean of those slopes, with a
 * standard error across months. Every month weighs the same, as the cohort
 * statistics do; a month with one count group says nothing about a slope.
 */
export function countSlope(rows: SlopeRow[]): CountSlope {
  const byMonth = new Map<string, Map<number, number[]>>();
  for (const r of rows) {
    const groups = byMonth.get(r.month) ?? new Map<number, number[]>();
    const c = Math.min(r.count, 3);
    groups.set(c, [...(groups.get(c) ?? []), r.value]);
    byMonth.set(r.month, groups);
  }
  const slopes: number[] = [];
  for (const groups of byMonth.values()) {
    if (groups.size < 2) continue;
    const points = [...groups].map(([x, vs]) => ({ x, y: vs.reduce((a, b) => a + b, 0) / vs.length }));
    const mx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const my = points.reduce((a, p) => a + p.y, 0) / points.length;
    const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    slopes.push(points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx);
  }
  if (slopes.length === 0) return { slope: null, stdError: null, months: 0 };
  const mean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  if (slopes.length < 2) return { slope: mean, stdError: null, months: 1 };
  const sd = Math.sqrt(slopes.reduce((a, s) => a + (s - mean) ** 2, 0) / (slopes.length - 1));
  return { slope: mean, stdError: sd / Math.sqrt(slopes.length), months: slopes.length };
}
