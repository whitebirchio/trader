import { asc, eq } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses } from "../db/schema.js";
import { add, div, mul, round } from "../money.js";
import type { DailyEquity, IndexFlow } from "../risk/equity-index.js";
import { loadIndexInputs } from "../risk/gate.js";
import { marketDate } from "../time.js";

/**
 * The money-weighted view (SPEC-capital): what the account started with when
 * the index did, what was added or taken out since, what it's worth at the
 * latest close, and what the same money would be worth held in VTI over the
 * same window. The time-weighted index stays the risk measure; this is the
 * answer to "would I have more money if I'd just bought VTI?".
 *
 * The window is the index's, close to close: from its base (the close before
 * the first trading day) through the latest snapshot. Starting at each
 * deposit's own date instead would credit VTI with months the money sat in
 * cash before Trader ran, and valuing live equity against yesterday's VTI
 * close would mix two instants.
 */

const SHARE_DP = 12;

export interface DailyBenchmarkClose {
  tradingDate: string;
  close: string;
}

/**
 * The start equity buys VTI at the start close; each flow in the window (after
 * the start snapshot was read, through the end's) buys or sells VTI at the last
 * close on or before its market date. Valued at the end close. Null without a
 * close on or before the start. `closes` must be ascending.
 */
export function sameMoneyInBenchmark(
  start: DailyEquity,
  end: DailyEquity,
  flows: IndexFlow[],
  closes: DailyBenchmarkClose[],
): { addedSince: string; sameFlowsInVti: string | null } {
  const inWindow = flows.filter((f) => f.at > start.recordedAt && f.at <= end.recordedAt);
  const addedSince = inWindow.reduce((sum, f) => add(sum, f.amount), "0");
  const closeOn = (date: string) => [...closes].reverse().find((c) => c.tradingDate <= date)?.close;
  const startClose = closeOn(start.tradingDate);
  const endClose = closeOn(end.tradingDate);
  if (!startClose || !endClose) return { addedSince, sameFlowsInVti: null };

  let shares = div(start.equity, startClose, SHARE_DP, "half-even");
  for (const f of inWindow) {
    const close = closeOn(marketDate(f.at)) ?? startClose;
    shares = add(shares, div(f.amount, close, SHARE_DP, "half-even"));
  }
  return { addedSince, sameFlowsInVti: round(mul(shares, endClose), 2, "half-even") };
}

export interface CapitalSummary {
  /** Net deposits (deposits − withdrawals), all time. */
  contributed: string;
  /** The comparison window's first close (the index base) and its last; null before the first snapshot. */
  since: string | null;
  through: string | null;
  /** Equity at the `since` close. */
  startValue: string | null;
  /** Net transfers inside the window. */
  addedSince: string;
  /** Equity at the `through` close. */
  value: string | null;
  /** `startValue` and the window's transfers held in VTI, at the `through` close; null without closes. */
  sameFlowsInVti: string | null;
}

/** The money-weighted summary from the ledger, snapshots and recorded closes (database only: the dashboard can read it). Null before any transfer. */
export async function capitalSummary(db: Db): Promise<CapitalSummary | null> {
  const { snapshots, flows } = await loadIndexInputs(db);
  if (flows.length === 0) return null;
  const contributed = flows.reduce((sum, f) => add(sum, f.amount), "0");
  const start = snapshots[0];
  const end = snapshots.at(-1);
  if (!start || !end) return { contributed, since: null, through: null, startValue: null, addedSince: "0", value: null, sameFlowsInVti: null };
  const closes = await db
    .select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close })
    .from(benchmarkCloses)
    .where(eq(benchmarkCloses.symbol, BENCHMARK))
    .orderBy(asc(benchmarkCloses.tradingDate));
  return {
    contributed,
    since: start.tradingDate,
    through: end.tradingDate,
    startValue: start.equity,
    value: end.equity,
    ...sameMoneyInBenchmark(start, end, flows, closes),
  };
}
