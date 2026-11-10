import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { benchmarkCloses, equitySnapshots } from "../db/schema.js";
import { writeChangedCloses } from "./closes.js";
import type { BrokerAdapter } from "./port.js";

/** The benchmark is VTI's total return (adjusted closes), the ETF twin of VTSAX. */
export const BENCHMARK = "VTI";
const YEAR_MS = 365 * 86_400_000;

/**
 * Re-read the benchmark's adjusted closes from a year back (or the first
 * equity snapshot, if older) and store the new or changed ones
 * (writeChangedCloses, #89). Re-reading the whole window keeps every stored
 * close on the same adjustment basis after a dividend. Returns the number of
 * closes written.
 */
export async function recordBenchmarkCloses(db: Db, broker: BrokerAdapter, now: Date): Promise<number> {
  const [first] = await db.select({ tradingDate: equitySnapshots.tradingDate }).from(equitySnapshots).orderBy(asc(equitySnapshots.tradingDate)).limit(1);
  const firstSnapshot = first ? new Date(`${first.tradingDate}T00:00:00Z`).getTime() - 7 * 86_400_000 : Infinity;
  const from = new Date(Math.min(firstSnapshot, now.getTime() - YEAR_MS));
  const bars = (await broker.getDailyBars([BENCHMARK], from, now))[BENCHMARK] ?? [];
  return writeChangedCloses(db, benchmarkCloses, { [BENCHMARK]: bars }, now);
}
