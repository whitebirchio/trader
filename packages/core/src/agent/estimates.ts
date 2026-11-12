import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { earningsEstimates } from "../db/schema.js";
import { compare, div, mul, round, sub, toBig } from "../money.js";
import { marketDate } from "../time.js";
import { type Refusal, readReply } from "./alphavantage.js";

/**
 * Analysts' EPS estimates for held and watched names (#105): whether the
 * consensus for the next quarter and the fiscal year is being raised or cut.
 * The source is Alpha Vantage's free EARNINGS_ESTIMATES, one request per
 * company, giving today's consensus and its value 7–90 days ago. The
 * earnings-estimates job refreshes each name about weekly, before the
 * backfill spends the day's requests. Untested here as a signal: the source
 * has no history, so the stored snapshots are the only way one will build up.
 */

/** One period's estimate, as decimal strings and counts; null where the source has nothing. */
export interface EstimatePoint {
  /** The period's end date, as the source labels it. */
  period: string;
  eps: string | null;
  eps7dAgo: string | null;
  eps30dAgo: string | null;
  eps60dAgo: string | null;
  eps90dAgo: string | null;
  raised7d: number | null;
  cut7d: number | null;
  raised30d: number | null;
  cut30d: number | null;
  analysts: number | null;
  revenue: string | null;
}

export type EstimatesReply = { status: "ok"; quarter: EstimatePoint | null; fiscalYear: EstimatePoint | null } | { status: "none" } | Refusal;

export interface EstimatesPort {
  /** A company's estimates for the next quarter and fiscal year after `now`. Throws if Alpha Vantage can't be reached. */
  estimates(symbol: string, now: Date): Promise<EstimatesReply>;
}

export const ESTIMATES = {
  /** A name's estimates are fetched again once its latest snapshot is this old. */
  refreshDays: 7,
  /** Requests a day, taken before the backfill's: with the calendar's one and the backfill's 20, the free key's 25 hold. */
  perDay: 3,
  /** Requests a tick. */
  perTick: 1,
  /** A 30-day fall in either consensus this large (%) flags a held thesis estimates_falling. */
  fallingPct: "-3",
} as const;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const decimal = /^-?\d+(\.\d+)?$/;
const num = (v: unknown) => (typeof v === "string" && decimal.test(v.trim()) ? v.trim() : null);
const count = (v: unknown) => {
  const n = num(v);
  return n === null ? null : Math.round(Number(n));
};

function point(e: Record<string, unknown>): EstimatePoint {
  return {
    period: String(e.date),
    eps: num(e.eps_estimate_average),
    eps7dAgo: num(e.eps_estimate_average_7_days_ago),
    eps30dAgo: num(e.eps_estimate_average_30_days_ago),
    eps60dAgo: num(e.eps_estimate_average_60_days_ago),
    eps90dAgo: num(e.eps_estimate_average_90_days_ago),
    raised7d: count(e.eps_estimate_revision_up_trailing_7_days),
    cut7d: count(e.eps_estimate_revision_down_trailing_7_days),
    raised30d: count(e.eps_estimate_revision_up_trailing_30_days),
    cut30d: count(e.eps_estimate_revision_down_trailing_30_days),
    analysts: count(e.eps_estimate_analyst_count),
    revenue: num(e.revenue_estimate_average),
  };
}

/**
 * Alpha Vantage's EARNINGS_ESTIMATES reply: the first fiscal quarter and the
 * first fiscal year dated after `today`. The list runs years back and its
 * past periods can be mislabeled, so only a future period is trusted.
 */
export function parseEstimatesJson(body: string, today: string): EstimatesReply {
  const reply = readReply(body, "estimates");
  if ("refused" in reply) return reply.refused;
  const rows = Array.isArray(reply.json.estimates) ? (reply.json.estimates as Record<string, unknown>[]) : [];
  const next = (horizon: string) =>
    rows
      .filter((e) => e.horizon === horizon && typeof e.date === "string" && isoDate.test(e.date) && e.date > today && num(e.eps_estimate_average) !== null)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  const q = next("fiscal quarter");
  const y = next("fiscal year");
  if (!q && !y) return { status: "none" };
  return { status: "ok", quarter: q ? point(q) : null, fiscalYear: y ? point(y) : null };
}

export type EstimatesRefreshResult =
  | { status: "fetched"; fetched: { symbol: string; status: "ok" | "none" | "error" }[]; limited: boolean; throttled: boolean; due: number }
  | { status: "skipped"; reason: string };

const DAY_MS = 86_400_000;

/**
 * Fetch the estimates of the names most overdue for a refresh: in the given
 * order (theses, then the watchlist), any whose latest snapshot is
 * refreshDays old or more, or that have none. Up to perTick a run and perDay
 * a market date, counting every fetch whatever came back. Stops at Alpha
 * Vantage's first refusal, which isn't counted.
 */
export async function refreshEstimates(db: Db, port: EstimatesPort, symbols: string[], now: Date): Promise<EstimatesRefreshResult> {
  if (symbols.length === 0) return { status: "skipped", reason: "no theses or watchlist names" };
  const today = marketDate(now);
  const usedToday = (await db.select({ s: earningsEstimates.symbol }).from(earningsEstimates).where(eq(earningsEstimates.fetchedOn, today))).length;
  const budget = Math.min(ESTIMATES.perTick, ESTIMATES.perDay - usedToday);
  const latest = await latestFetches(db, symbols);
  const cutoff = marketDate(new Date(now.getTime() - ESTIMATES.refreshDays * DAY_MS));
  // A failed fetch is retried the next day; anything else waits for the refresh.
  const isDue = (s: string) => {
    const l = latest.get(s);
    return !l || l.on <= cutoff || (l.status === "error" && l.on < today);
  };
  const due = [...new Set(symbols)].filter(isDue);
  if (due.length === 0) return { status: "skipped", reason: `every name was fetched within ${ESTIMATES.refreshDays} days` };
  if (budget <= 0) return { status: "skipped", reason: `today's ${ESTIMATES.perDay} requests are spent (${due.length} due)` };

  const fetched: { symbol: string; status: "ok" | "none" | "error" }[] = [];
  let limited = false;
  let throttled = false;
  for (const symbol of due.slice(0, budget)) {
    let reply: EstimatesReply;
    let error: string | null = null;
    try {
      reply = await port.estimates(symbol, now);
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      reply = { status: "none" };
    }
    if (reply.status === "limited") {
      if (reply.perSecond) throttled = true;
      else limited = true;
      break;
    }
    const status = error ? "error" : reply.status;
    const row = {
      fetchedAt: new Date(now),
      status,
      quarter: reply.status === "ok" ? (reply.quarter as unknown as Record<string, unknown> | null) : null,
      fiscalYear: reply.status === "ok" ? (reply.fiscalYear as unknown as Record<string, unknown> | null) : null,
      error,
    } as const;
    await db.insert(earningsEstimates).values({ symbol, fetchedOn: today, ...row }).onConflictDoUpdate({ target: [earningsEstimates.symbol, earningsEstimates.fetchedOn], set: row });
    fetched.push({ symbol, status });
  }
  if (fetched.length > 0 && fetched.every((f) => f.status === "error")) throw new Error(`Alpha Vantage's estimates failed for ${fetched.map((f) => f.symbol).join(", ")}`);
  return { status: "fetched", fetched, limited, throttled, due: due.length - fetched.length };
}

/** Each symbol's latest fetch, whatever it found. */
async function latestFetches(db: Db, symbols: string[]): Promise<Map<string, { on: string; status: string }>> {
  const rows = await db
    .select({ symbol: earningsEstimates.symbol, on: earningsEstimates.fetchedOn, status: earningsEstimates.status })
    .from(earningsEstimates)
    .where(inArray(earningsEstimates.symbol, symbols))
    .orderBy(desc(earningsEstimates.fetchedOn));
  const out = new Map<string, { on: string; status: string }>();
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, { on: r.on, status: r.status });
  return out;
}

/** One period's estimate as the tools show it: the consensus and how it has moved. */
export interface EstimateTrend {
  period: string;
  eps: string;
  /** The change in the consensus over 30 and 90 days (%, 1 dp); null when the older value is missing or too near zero to divide by. */
  change30dPct: string | null;
  change90dPct: string | null;
  /** Analysts who raised and cut their estimate in the last 30 days. */
  raised30d: number | null;
  cut30d: number | null;
  analysts: number | null;
}

export interface EstimatesView {
  /** The snapshot's market date. */
  asOf: string;
  nextQuarter: EstimateTrend | null;
  fiscalYear: EstimateTrend | null;
  /** Either consensus down ESTIMATES.fallingPct or more over 30 days. */
  falling: boolean;
}

/** The change from `then` to `now` as a % of |then|, 1 dp; null if `then` is missing or within a cent of zero. */
function changePct(now: string, then: string | null): string | null {
  if (then === null) return null;
  const size = toBig(then).abs().toString();
  if (compare(size, "0.01") < 0) return null;
  return round(mul(div(sub(now, then), size, 12, "half-even"), "100"), 1, "half-even");
}

function trend(p: EstimatePoint | null): EstimateTrend | null {
  if (!p?.eps) return null;
  return { period: p.period, eps: p.eps, change30dPct: changePct(p.eps, p.eps30dAgo), change90dPct: changePct(p.eps, p.eps90dAgo), raised30d: p.raised30d, cut30d: p.cut30d, analysts: p.analysts };
}

/** Each symbol's latest snapshot with estimates in it, as trends. A symbol with none yet is absent. */
export async function estimatesFor(db: Db, symbols: string[]): Promise<Map<string, EstimatesView>> {
  const out = new Map<string, EstimatesView>();
  if (symbols.length === 0) return out;
  const rows = await db
    .select()
    .from(earningsEstimates)
    .where(and(inArray(earningsEstimates.symbol, symbols), eq(earningsEstimates.status, "ok")))
    .orderBy(desc(earningsEstimates.fetchedOn));
  for (const r of rows) {
    if (out.has(r.symbol)) continue;
    const nextQuarter = trend(r.quarter as unknown as EstimatePoint | null);
    const fiscalYear = trend(r.fiscalYear as unknown as EstimatePoint | null);
    const falling = [nextQuarter, fiscalYear].some((t) => t?.change30dPct != null && compare(t.change30dPct, ESTIMATES.fallingPct) <= 0);
    out.set(r.symbol, { asOf: r.fetchedOn, nextQuarter, fiscalYear, falling });
  }
  return out;
}
