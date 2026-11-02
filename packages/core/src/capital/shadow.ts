import { asc, eq } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses } from "../db/schema.js";
import { add, div, mul, round } from "../money.js";
import { type IndexFlow } from "../risk/equity-index.js";
import { loadIndexInputs } from "../risk/gate.js";
import { marketDate } from "../time.js";

/**
 * The money-weighted view (SPEC-capital): what you put in, what it's worth,
 * and what the same deposits and withdrawals would be worth held in VTI. The
 * time-weighted index stays the risk measure; this is the answer to "would I
 * have more money if I'd just bought VTI?".
 */

const SHARE_DP = 12;

export interface DailyBenchmarkClose {
  tradingDate: string;
  close: string;
}

/**
 * Each flow buys (or sells) VTI at the last close on or before its market
 * date: the price a deposit could have bought at. A flow older than every
 * recorded close uses the first one after it. `closes` must be ascending.
 */
export function sameFlowsInBenchmark(flows: IndexFlow[], closes: DailyBenchmarkClose[]): { contributed: string; sameFlowsInVti: string | null } {
  const contributed = flows.reduce((sum, f) => add(sum, f.amount), "0");
  if (closes.length === 0) return { contributed, sameFlowsInVti: flows.length === 0 ? "0" : null };

  let shares = "0";
  for (const f of flows) {
    const date = marketDate(f.at);
    const close = [...closes].reverse().find((c) => c.tradingDate <= date) ?? closes[0]!;
    shares = add(shares, div(f.amount, close.close, SHARE_DP, "half-even"));
  }
  return { contributed, sameFlowsInVti: round(mul(shares, closes.at(-1)!.close), 2, "half-even") };
}

export interface CapitalSummary {
  /** Net deposits (deposits − withdrawals). */
  contributed: string;
  /** Equity now. */
  value: string;
  /** The same flows held in VTI, valued at the latest recorded close; null without closes. */
  sameFlowsInVti: string | null;
}

/** The money-weighted summary from the ledger and recorded closes (database only: the dashboard can read it). Null before any transfer. */
export async function capitalSummary(db: Db, equity: string): Promise<CapitalSummary | null> {
  const { flows } = await loadIndexInputs(db);
  if (flows.length === 0) return null;
  const closes = await db
    .select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close })
    .from(benchmarkCloses)
    .where(eq(benchmarkCloses.symbol, BENCHMARK))
    .orderBy(asc(benchmarkCloses.tradingDate));
  return { ...sameFlowsInBenchmark(flows, closes), value: equity };
}
