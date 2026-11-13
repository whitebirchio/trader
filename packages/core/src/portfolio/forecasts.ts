import { and, asc, eq } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses, strategies, thesisCloses, watchlistNotes } from "../db/schema.js";
import { div, mul, round, sub } from "../money.js";
import { marketDate, marketTimeToUtc } from "../time.js";

/**
 * The forecast ledger (SPEC-portfolio § Forecast ledger): every tested signal
 * failed to beat VTI on its own, so the bet is Claude's judgment, and P&L
 * can't measure that for years. Each thesis and each name Claude passes on
 * carries a forecast (the chance the stock beats VTI by a horizon, and by
 * how much); this scores them against the recorded closes, computed on read
 * like the scorecard. A forecast is about the stock, not the position:
 * selling early doesn't void it.
 */

/** About the share of tradable stocks that beat VTI over 60 trading days in the backtests (docs/research). */
export const FORECAST_BASE_RATE_PCT = 45;
/** Below this many resolved forecasts, every figure is labelled too few to judge. */
export const MIN_RESOLVED_TO_JUDGE = 30;
/** The expected-vs-realized correlation needs at least this many. */
export const MIN_FOR_CORRELATION = 20;
/** Probability buckets for the reliability table, whole percent, inclusive. */
export const FORECAST_BUCKETS: readonly (readonly [number, number])[] = [
  [5, 34],
  [35, 49],
  [50, 64],
  [65, 95],
];
/** Fixed yardsticks for bought vs passed, in trading days. */
export const YARDSTICK_DAYS = [20, 60] as const;

export type ForecastSource = "thesis" | "watchlist";

export interface StatedForecast {
  source: ForecastSource;
  /** The thesis id, or the symbol for a watchlist name. */
  id: string;
  symbol: string;
  /** Theses only. */
  leadSignal: string | null;
  beatVtiPct: number;
  expectedExcessPct: string;
  horizon: string;
  statedAt: Date;
  /** Stated after the thesis was first listed (the one-time backfill): part of the outcome was known. */
  backfilled: boolean;
}

export interface ForecastOutcome extends StatedForecast {
  /** The first close after the forecast was stated, and the close on (or the first after) the horizon. */
  startDate: string | null;
  endDate: string | null;
  resolved: boolean;
  beat: boolean | null;
  /** Stock return minus VTI's over the window, percentage points (2 dp). */
  excessPct: string | null;
}

export interface Calibration {
  forecasts: number;
  resolved: number;
  /** Mean of (p − outcome)², p in 0–1; lower is better. Null with nothing resolved. */
  brier: number | null;
  /** 1 − brier / brier(always FORECAST_BASE_RATE_PCT): above 0 beats the base rate. */
  skill: number | null;
  buckets: { range: string; count: number; meanForecastPct: number | null; beatPct: number | null }[];
  meanExpectedExcessPct: number | null;
  meanRealizedExcessPct: number | null;
  /** Correlation of expected with realized excess, from MIN_FOR_CORRELATION resolved. */
  excessCorrelation: number | null;
  tooFewToJudge: boolean;
}

export interface YardstickGroup {
  count: number;
  meanExcessPct: number | null;
  medianExcessPct: number | null;
  beatPct: number | null;
  /** Standard error of the mean. */
  stdErr: number | null;
}

export interface ForecastReport {
  /** Theses and watchlist names, not backfilled: the headline. */
  overall: Calibration;
  bySource: { thesis: Calibration; watchlist: Calibration; backfilled: Calibration };
  byLeadSignal: ({ leadSignal: string } & Calibration)[];
  /** Does Claude pick better than the names it looks at and passes on? Excess vs VTI after N trading days. */
  boughtVsPassed: { days: number; bought: YardstickGroup; passed: YardstickGroup; differencePct: number | null; stdErr: number | null }[];
  /** Not yet resolved, soonest horizon first. */
  open: { source: ForecastSource; id: string; symbol: string; beatVtiPct: number; horizon: string; daysToHorizon: number; backfilled: boolean }[];
  /** Resolved, latest first: `endDate` is the close it resolved on. */
  resolved: { source: ForecastSource; id: string; symbol: string; beatVtiPct: number; endDate: string; beat: boolean; excessPct: string; backfilled: boolean }[];
  baseRatePct: number;
}

type Closes = Map<string, { dates: string[]; close: Map<string, string> }>;

// ── Collecting forecasts ───────────────────────────────────────────────────

interface ListedThesis {
  id?: unknown;
  symbol?: unknown;
  leadSignal?: unknown;
  reviewBy?: unknown;
  forecast?: { beatVtiPct?: unknown; expectedExcessPct?: unknown; horizon?: unknown } | null;
}

/** Each thesis id's first stated forecast, and each id's first listing (to tell a backfill). Old documents are read leniently. */
export function thesisForecasts(versions: { createdAt: Date; document: unknown }[]): { forecasts: StatedForecast[]; firstListed: Map<string, { symbol: string; at: Date }> } {
  const firstListed = new Map<string, { symbol: string; at: Date }>();
  const forecasts = new Map<string, StatedForecast>();
  for (const v of [...versions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const conviction = (v.document as { conviction?: unknown } | null)?.conviction;
    if (!Array.isArray(conviction)) continue;
    for (const t of conviction as ListedThesis[]) {
      if (typeof t?.id !== "string" || typeof t.symbol !== "string") continue;
      if (!firstListed.has(t.id)) firstListed.set(t.id, { symbol: t.symbol, at: v.createdAt });
      const f = t.forecast;
      if (forecasts.has(t.id) || !f || typeof f.beatVtiPct !== "number" || typeof f.expectedExcessPct !== "string") continue;
      const horizon = typeof f.horizon === "string" ? f.horizon : typeof t.reviewBy === "string" ? t.reviewBy : null;
      if (!horizon) continue;
      forecasts.set(t.id, {
        source: "thesis",
        id: t.id,
        symbol: t.symbol,
        leadSignal: typeof t.leadSignal === "string" ? t.leadSignal : null,
        beatVtiPct: f.beatVtiPct,
        expectedExcessPct: f.expectedExcessPct,
        horizon,
        statedAt: v.createdAt,
        backfilled: firstListed.get(t.id)!.at.getTime() < v.createdAt.getTime(),
      });
    }
  }
  return { forecasts: [...forecasts.values()], firstListed };
}

type NoteRow = { symbol: string; action: string; at: Date; beatVtiPct: number | null; expectedExcessPct: string | null; horizon: string | null };

/** Each stay on the watchlist (watch rows until a drop): its first forecast, and when the stay began. */
export function watchlistForecasts(rows: NoteRow[]): { forecasts: StatedForecast[]; stays: { symbol: string; since: Date }[] } {
  const forecasts: StatedForecast[] = [];
  const stays: { symbol: string; since: Date }[] = [];
  const bySymbol = new Map<string, NoteRow[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  for (const [symbol, list] of bySymbol) {
    let stay: { since: Date; stated: boolean } | null = null;
    for (const r of list.sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (r.action === "drop") {
        stay = null;
        continue;
      }
      if (!stay) {
        stay = { since: r.at, stated: false };
        stays.push({ symbol, since: r.at });
      }
      if (!stay.stated && r.beatVtiPct !== null && r.expectedExcessPct !== null && r.horizon) {
        stay.stated = true;
        forecasts.push({ source: "watchlist", id: symbol, symbol, leadSignal: null, beatVtiPct: r.beatVtiPct, expectedExcessPct: r.expectedExcessPct, horizon: r.horizon, statedAt: r.at, backfilled: false });
      }
    }
  }
  return { forecasts, stays };
}

// ── Resolving against closes ───────────────────────────────────────────────

/** The first trading date whose close (16:00 ET) comes after `at`. */
function firstCloseAfter(dates: string[], at: Date): string | null {
  return dates.find((d) => marketTimeToUtc(d, "16:00").getTime() > at.getTime()) ?? null;
}

/** Percentage points of a minus b, from two start/end close pairs. */
function excessBetween(stock: [string, string], vti: [string, string]): string {
  const ret = (from: string, to: string) => mul(sub(div(to, from, 12, "half-even"), "1"), "100");
  return round(sub(ret(stock[0], stock[1]), ret(vti[0], vti[1])), 2, "half-even");
}

/** Score one forecast from the recorded closes: resolved once both the stock and VTI have a close on or after the horizon. */
export function resolveForecast(f: StatedForecast, closes: Closes): ForecastOutcome {
  const stock = closes.get(f.symbol);
  const vti = closes.get(BENCHMARK);
  const none = { ...f, startDate: null, endDate: null, resolved: false, beat: null, excessPct: null };
  if (!stock || !vti) return none;
  const startDate = firstCloseAfter(stock.dates, f.statedAt);
  const endDate = stock.dates.find((d) => d >= f.horizon) ?? null;
  if (!startDate || !endDate || endDate <= startDate) return { ...none, startDate };
  const v0 = vti.close.get(startDate);
  const v1 = vti.close.get(endDate);
  if (!v0 || !v1) return { ...none, startDate };
  const excessPct = excessBetween([stock.close.get(startDate)!, stock.close.get(endDate)!], [v0, v1]);
  return { ...f, startDate, endDate, resolved: true, beat: Number(excessPct) > 0, excessPct };
}

// ── Statistics (probabilities and percentages, not money: plain numbers) ──

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stdErr(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < MIN_FOR_CORRELATION) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Brier, skill against the base rate, reliability buckets and excess error, over `outcomes`. */
export function calibrate(outcomes: ForecastOutcome[]): Calibration {
  const done = outcomes.filter((o) => o.resolved);
  const p = (o: ForecastOutcome) => o.beatVtiPct / 100;
  const y = (o: ForecastOutcome) => (o.beat ? 1 : 0);
  const brier = mean(done.map((o) => (p(o) - y(o)) ** 2));
  const base = FORECAST_BASE_RATE_PCT / 100;
  const brierBase = mean(done.map((o) => (base - y(o)) ** 2));
  const skill = brier !== null && brierBase ? 1 - brier / brierBase : null;
  const expected = done.map((o) => Number(o.expectedExcessPct));
  const realized = done.map((o) => Number(o.excessPct));
  return {
    forecasts: outcomes.length,
    resolved: done.length,
    brier: r4(brier),
    skill: r4(skill),
    buckets: FORECAST_BUCKETS.map(([lo, hi]) => {
      const inBucket = done.filter((o) => o.beatVtiPct >= lo && o.beatVtiPct <= hi);
      return { range: `${lo}–${hi}%`, count: inBucket.length, meanForecastPct: r2(mean(inBucket.map((o) => o.beatVtiPct))), beatPct: r2(inBucket.length ? (100 * inBucket.filter((o) => o.beat).length) / inBucket.length : null) };
    }),
    meanExpectedExcessPct: r2(mean(expected)),
    meanRealizedExcessPct: r2(mean(realized)),
    excessCorrelation: r4(correlation(expected, realized)),
    tooFewToJudge: done.length < MIN_RESOLVED_TO_JUDGE,
  };
}

function yardstick(excesses: number[]): YardstickGroup {
  return {
    count: excesses.length,
    meanExcessPct: r2(mean(excesses)),
    medianExcessPct: r2(median(excesses)),
    beatPct: r2(excesses.length ? (100 * excesses.filter((x) => x > 0).length) / excesses.length : null),
    stdErr: r2(stdErr(excesses)),
  };
}

/** The stock's excess over VTI `days` trading days after `from`, or null until then. */
function excessAfter(symbol: string, from: Date, days: number, closes: Closes): number | null {
  const stock = closes.get(symbol);
  const vti = closes.get(BENCHMARK);
  if (!stock || !vti) return null;
  const start = firstCloseAfter(stock.dates, from);
  if (!start) return null;
  const end = stock.dates[stock.dates.indexOf(start) + days];
  if (!end) return null;
  const [v0, v1] = [vti.close.get(start), vti.close.get(end)];
  if (!v0 || !v1) return null;
  return Number(excessBetween([stock.close.get(start)!, stock.close.get(end)!], [v0, v1]));
}

// ── The report ─────────────────────────────────────────────────────────────

export interface ForecastInputs {
  versions: { createdAt: Date; document: unknown }[];
  notes: NoteRow[];
  closes: Closes;
  now: Date;
}

export function forecastReport(input: ForecastInputs): ForecastReport {
  const { forecasts: theses, firstListed } = thesisForecasts(input.versions);
  const { forecasts: watched, stays } = watchlistForecasts(input.notes);
  const outcomes = [...theses, ...watched].map((f) => resolveForecast(f, input.closes));
  const headline = outcomes.filter((o) => !o.backfilled);
  const leadSignals = [...new Set(outcomes.filter((o) => o.source === "thesis" && !o.backfilled && o.leadSignal).map((o) => o.leadSignal!))].sort();

  // Bought: every thesis from its first listing. Passed: every stay on the watchlist whose name wasn't bought after it began.
  const boughtAt = [...firstListed.values()];
  const passed = stays.filter((s) => !boughtAt.some((b) => b.symbol === s.symbol && b.at.getTime() >= s.since.getTime()));
  const today = marketDate(input.now);
  return {
    overall: calibrate(headline),
    bySource: {
      thesis: calibrate(headline.filter((o) => o.source === "thesis")),
      watchlist: calibrate(headline.filter((o) => o.source === "watchlist")),
      backfilled: calibrate(outcomes.filter((o) => o.backfilled)),
    },
    byLeadSignal: leadSignals.map((leadSignal) => ({ leadSignal, ...calibrate(headline.filter((o) => o.leadSignal === leadSignal)) })),
    boughtVsPassed: YARDSTICK_DAYS.map((days) => {
      const b = boughtAt.map((t) => excessAfter(t.symbol, t.at, days, input.closes)).filter((x): x is number => x !== null);
      const p = passed.map((s) => excessAfter(s.symbol, s.since, days, input.closes)).filter((x): x is number => x !== null);
      const bought = yardstick(b);
      const pass = yardstick(p);
      const se = stdErr(b) !== null && stdErr(p) !== null ? Math.sqrt(stdErr(b)! ** 2 + stdErr(p)! ** 2) : null;
      return { days, bought, passed: pass, differencePct: r2(bought.meanExcessPct !== null && pass.meanExcessPct !== null ? bought.meanExcessPct - pass.meanExcessPct : null), stdErr: r2(se) };
    }),
    open: outcomes
      .filter((o) => !o.resolved)
      .map((o) => ({ source: o.source, id: o.id, symbol: o.symbol, beatVtiPct: o.beatVtiPct, horizon: o.horizon, daysToHorizon: Math.round((Date.parse(`${o.horizon}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000), backfilled: o.backfilled }))
      .sort((a, b) => a.horizon.localeCompare(b.horizon) || a.id.localeCompare(b.id)),
    resolved: outcomes
      .filter((o) => o.resolved)
      .map((o) => ({ source: o.source, id: o.id, symbol: o.symbol, beatVtiPct: o.beatVtiPct, endDate: o.endDate!, beat: o.beat!, excessPct: o.excessPct!, backfilled: o.backfilled }))
      .sort((a, b) => b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id)),
    baseRatePct: FORECAST_BASE_RATE_PCT,
  };
}

/** Read everything the report needs from the database alone (no broker keys), so the dashboard's SELECT-only role can serve it. */
export async function loadForecastReport(db: Db, now: Date): Promise<ForecastReport> {
  const [versions, notes, symbolCloses, vtiCloses] = await Promise.all([
    db.select({ createdAt: strategies.createdAt, document: strategies.document }).from(strategies).orderBy(asc(strategies.version)),
    db
      .select({ symbol: watchlistNotes.symbol, action: watchlistNotes.action, at: watchlistNotes.at, beatVtiPct: watchlistNotes.beatVtiPct, expectedExcessPct: watchlistNotes.expectedExcessPct, horizon: watchlistNotes.horizon })
      .from(watchlistNotes),
    db.select({ symbol: thesisCloses.symbol, tradingDate: thesisCloses.tradingDate, close: thesisCloses.close }).from(thesisCloses).orderBy(asc(thesisCloses.tradingDate)),
    db
      .select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close })
      .from(benchmarkCloses)
      .where(and(eq(benchmarkCloses.symbol, BENCHMARK)))
      .orderBy(asc(benchmarkCloses.tradingDate)),
  ]);
  const closes: Closes = new Map();
  const put = (symbol: string, tradingDate: string, close: string) => {
    const c = closes.get(symbol) ?? { dates: [], close: new Map<string, string>() };
    if (!c.close.has(tradingDate)) c.dates.push(tradingDate);
    c.close.set(tradingDate, close);
    closes.set(symbol, c);
  };
  for (const r of symbolCloses) put(r.symbol, r.tradingDate, r.close);
  for (const r of vtiCloses) put(BENCHMARK, r.tradingDate, r.close);
  for (const c of closes.values()) c.dates.sort();
  return forecastReport({ versions, notes, closes, now });
}
