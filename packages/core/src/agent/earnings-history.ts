import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { earningsHistory, earningsHistoryFetches } from "../db/schema.js";
import { marketDate } from "../time.js";
import { type Refusal, readReply } from "./alphavantage.js";
import { EARNINGS_UNIVERSE } from "./earnings-universe.js";
import { type EstimatesPort, type EstimatesReply, parseEstimatesJson } from "./estimates.js";

/**
 * Each company's quarterly earnings, reported vs estimated EPS (#105), for
 * the earnings-surprise backtest and, later, the routine. The source is
 * Alpha Vantage's EARNINGS endpoint: free, but one request per company, at
 * most one a second, and 25 a day. So the
 * earnings-backfill job fills it slowly, a few companies a tick inside a
 * daily budget: theses and watchlist names first, then EARNINGS_UNIVERSE in
 * its fixed order, so what's stored is always a random sample of it.
 */

export interface EarningsQuarter {
  fiscalDateEnding: string;
  reportedDate: string;
  reportTime: string | null;
  reportedEps: string | null;
  estimatedEps: string | null;
  surprise: string | null;
  surprisePct: string | null;
}

/**
 * "none": Alpha Vantage has no earnings for the symbol. "limited": it refused
 * the request, for the day's limit or, when `perSecond`, for going faster
 * than one a second.
 */
export type HistoryReply = { status: "ok"; quarters: EarningsQuarter[] } | { status: "none" } | Refusal;

export interface EarningsHistoryPort {
  /** A company's quarterly earnings, newest first. Throws if Alpha Vantage can't be reached. */
  history(symbol: string): Promise<HistoryReply>;
}

export const BACKFILL = {
  /** Requests a day: the calendar takes one more, leaving a few of the free key's 25 for on-demand checks. */
  perDay: 20,
  /** Requests a tick, so a day's budget spreads over a few ticks. */
  perTick: 3,
  /** Quarters reported before this aren't stored: the backtests start in 2018. */
  from: "2017-01-01",
} as const;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const decimal = /^-?\d+(\.\d+)?$/;
const num = (v: unknown) => (typeof v === "string" && decimal.test(v.trim()) ? v.trim() : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" && v !== "None" ? v.trim() : null);

/**
 * Alpha Vantage's EARNINGS reply. Its notices ("Information", "Note") are a
 * refusal, an "Error Message" or an empty object means it has nothing for
 * the symbol, and quarters without a real date are skipped.
 */
export function parseEarningsJson(body: string): HistoryReply {
  const reply = readReply(body, "earnings");
  if ("refused" in reply) return reply.refused;
  const j = reply.json;
  if (!Array.isArray(j.quarterlyEarnings)) return { status: "none" };
  const quarters: EarningsQuarter[] = [];
  for (const q of j.quarterlyEarnings as Record<string, unknown>[]) {
    const fiscalDateEnding = text(q.fiscalDateEnding);
    const reportedDate = text(q.reportedDate);
    if (!fiscalDateEnding || !isoDate.test(fiscalDateEnding) || !reportedDate || !isoDate.test(reportedDate)) continue;
    quarters.push({
      fiscalDateEnding,
      reportedDate,
      reportTime: text(q.reportTime),
      reportedEps: num(q.reportedEPS),
      estimatedEps: num(q.estimatedEPS),
      surprise: num(q.surprise),
      surprisePct: num(q.surprisePercentage),
    });
  }
  return quarters.length > 0 ? { status: "ok", quarters } : { status: "none" };
}

/** Alpha Vantage's per-second limit, with a margin. */
const SPACING_MS = 1_200;

/**
 * A company's earnings history and analyst estimates from Alpha Vantage, at
 * most one request every SPACING_MS across both. The key is sent only to
 * Alpha Vantage, and never logged.
 */
export class AlphaVantageEarnings implements EarningsHistoryPort, EstimatesPort {
  private last = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly spacingMs = SPACING_MS,
  ) {}

  async history(symbol: string): Promise<HistoryReply> {
    return parseEarningsJson(await this.query("EARNINGS", symbol, "earnings"));
  }

  async estimates(symbol: string, now: Date): Promise<EstimatesReply> {
    return parseEstimatesJson(await this.query("EARNINGS_ESTIMATES", symbol, "estimates"), marketDate(now));
  }

  private async query(fn: string, symbol: string, what: string): Promise<string> {
    const wait = this.last + this.spacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const url = new URL("https://www.alphavantage.co/query");
    // Alpha Vantage writes share classes with a dash (BRK-B), Alpaca with a dot.
    url.search = new URLSearchParams({ function: fn, symbol: symbol.replace(".", "-"), apikey: this.apiKey }).toString();
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpha Vantage's ${what} failed: HTTP ${res.status}`);
    return res.text();
  }
}

export type BackfillResult =
  | {
      status: "fetched";
      /** Companies asked for this run, and what came back for each. */
      fetched: { symbol: string; status: "ok" | "none" | "error"; quarters: number }[];
      /** True if Alpha Vantage refused a request for the day's limit: the job stops for the day. */
      limited: boolean;
      /** True if it refused one for going faster than one a second: this run stops, and the next tick carries on. */
      throttled: boolean;
      /** Companies still to ask for. */
      left: number;
    }
  | { status: "skipped"; reason: string };

/**
 * Ask for the next few companies' earnings: up to perTick of them, within
 * what's left of today's budget (each company asked for today counts,
 * whatever came back). Priority names come first, then EARNINGS_UNIVERSE in
 * order. A company is asked for once; one that failed is retried on a later
 * day. Stops at Alpha Vantage's first refusal, which isn't counted.
 */
export async function backfillEarningsHistory(
  db: Db,
  port: EarningsHistoryPort,
  opts: { priority: string[]; now: Date; universe?: readonly string[] },
): Promise<BackfillResult> {
  const today = marketDate(opts.now);
  const rows = await db.select({ symbol: earningsHistoryFetches.symbol, status: earningsHistoryFetches.status, fetchedOn: earningsHistoryFetches.fetchedOn }).from(earningsHistoryFetches);
  const usedToday = rows.filter((r) => r.fetchedOn === today).length;
  const budget = Math.min(BACKFILL.perTick, BACKFILL.perDay - usedToday);
  if (budget <= 0) return { status: "skipped", reason: `today's ${BACKFILL.perDay} requests are spent` };
  const settled = new Set(rows.filter((r) => r.status !== "error" || r.fetchedOn === today).map((r) => r.symbol));
  const queue = [...new Set([...opts.priority, ...(opts.universe ?? EARNINGS_UNIVERSE)])].filter((s) => !settled.has(s));
  if (queue.length === 0) return { status: "skipped", reason: "every company has been fetched" };

  const fetched: { symbol: string; status: "ok" | "none" | "error"; quarters: number }[] = [];
  let limited = false;
  let throttled = false;
  for (const symbol of queue.slice(0, budget)) {
    let reply: HistoryReply;
    let error: string | null = null;
    try {
      reply = await port.history(symbol);
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      reply = { status: "none" };
    }
    if (reply.status === "limited") {
      if (reply.perSecond) throttled = true;
      else limited = true;
      break;
    }
    const at = new Date(opts.now);
    const quarters = reply.status === "ok" ? reply.quarters.filter((q) => q.reportedDate >= BACKFILL.from) : [];
    if (quarters.length > 0) {
      await db
        .insert(earningsHistory)
        .values(quarters.map((q) => ({ symbol, ...q, fetchedAt: at })))
        .onConflictDoUpdate({
          target: [earningsHistory.symbol, earningsHistory.fiscalDateEnding],
          set: {
            reportedDate: sql`excluded.reported_date`,
            reportTime: sql`excluded.report_time`,
            reportedEps: sql`excluded.reported_eps`,
            estimatedEps: sql`excluded.estimated_eps`,
            surprise: sql`excluded.surprise`,
            surprisePct: sql`excluded.surprise_pct`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    const status = error ? "error" : quarters.length > 0 ? "ok" : "none";
    const row = { fetchedOn: today, fetchedAt: at, status, quarters: quarters.length, error } as const;
    await db.insert(earningsHistoryFetches).values({ symbol, ...row }).onConflictDoUpdate({ target: earningsHistoryFetches.symbol, set: row });
    fetched.push({ symbol, status, quarters: quarters.length });
  }
  if (fetched.length > 0 && fetched.every((f) => f.status === "error")) throw new Error(`Alpha Vantage's earnings failed for ${fetched.map((f) => f.symbol).join(", ")}`);
  return { status: "fetched", fetched, limited, throttled, left: queue.length - fetched.filter((f) => f.status !== "error").length };
}

/** How far the backfill has got: companies asked for, by outcome, and quarters stored. */
export async function backfillProgress(db: Db): Promise<{ ok: number; none: number; error: number; quarters: number }> {
  const counts = await db.select({ status: earningsHistoryFetches.status, n: sql<number>`count(*)::int` }).from(earningsHistoryFetches).groupBy(earningsHistoryFetches.status);
  const [q] = await db.select({ n: sql<number>`count(*)::int` }).from(earningsHistory);
  const by = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return { ok: by("ok"), none: by("none"), error: by("error"), quarters: q?.n ?? 0 };
}

/** The progress in one line, for a skipped run's reason: the backfill's total, readable from the run alone. */
export function describeProgress(p: { ok: number; none: number; error: number; quarters: number }): string {
  return `so far ${p.ok + p.none + p.error} of ${EARNINGS_UNIVERSE.length} companies asked for (${p.ok} with earnings, ${p.none} without, ${p.error} to retry), ${p.quarters} quarters stored`;
}
