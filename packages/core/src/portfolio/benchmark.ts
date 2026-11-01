import { asc, inArray } from "drizzle-orm";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { brokerActivities, equitySnapshots } from "../db/schema.js";
import { div, mul, sub } from "../money.js";
import { FLOW_TYPES, type IndexPoint, buildIndex, flowsByDate } from "../risk/equity-index.js";
import { marketDate } from "../time.js";
import type { DailyClose } from "./systematic.js";

/** The benchmark is VTI's total return (adjusted closes), the ETF twin of VTSAX. */
export const BENCHMARK = "VTI";

export interface BenchmarkComparison {
  since: string;
  through: string;
  /** Flow-adjusted portfolio return, e.g. "1.24" = +1.24%. */
  portfolioPct: string;
  benchmarkPct: string;
}

const pct = (end: string, start: string) => div(mul(sub(div(end, start, 12, "half-even"), "1"), "100"), "1", 2, "half-even");

/**
 * Portfolio (the flow-adjusted index, so deposits don't count as returns) vs
 * VTI over the same days, from the first equity snapshot. Null until there are
 * two snapshots and VTI prices to match them.
 */
export function compareToBenchmark(points: IndexPoint[], benchmark: DailyClose[], closeOn: (t: Date) => string): BenchmarkComparison | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || first === last) return null;
  const priceOn = (date: string) => [...benchmark].reverse().find((b) => closeOn(b.t) <= date)?.c;
  const start = priceOn(first.tradingDate);
  const end = priceOn(last.tradingDate);
  if (!start || !end) return null;
  return { since: first.tradingDate, through: last.tradingDate, portfolioPct: pct(last.index, first.index), benchmarkPct: pct(end, start) };
}

/** Portfolio vs VTI since the first snapshot, loaded from the DB and the broker. Best effort: null on any failure. */
export async function benchmarkSince(db: Db, broker: BrokerAdapter, at: Date): Promise<BenchmarkComparison | null> {
  try {
    const snaps = await db
      .select({ tradingDate: equitySnapshots.tradingDate, equity: equitySnapshots.equity })
      .from(equitySnapshots)
      .orderBy(asc(equitySnapshots.tradingDate));
    if (snaps.length < 2) return null;
    const flowRows = await db.select().from(brokerActivities).where(inArray(brokerActivities.type, [...FLOW_TYPES]));
    const index = buildIndex(snaps, flowsByDate(flowRows.map((r) => ({ ...r, side: null }))));
    const since = new Date(`${snaps[0]!.tradingDate}T00:00:00Z`);
    const bars = await broker.getDailyBars([BENCHMARK], new Date(since.getTime() - 7 * 86_400_000), at);
    return compareToBenchmark(index.points, bars[BENCHMARK] ?? [], marketDate);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "benchmark comparison skipped", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}
