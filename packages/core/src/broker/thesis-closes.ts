import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { strategies, thesisCloses } from "../db/schema.js";
import { marketDate } from "../time.js";
import { writeChangedCloses } from "./closes.js";
import type { BrokerAdapter } from "./port.js";

/** How far before a symbol's first thesis its closes are kept: the thesis chart's longest range is a year (#59). */
export const CLOSES_LEAD_DAYS = 380;
const DAY_MS = 86_400_000;

/** Each symbol any stored strategy has held as a thesis, with the time of the first version that did. */
export function thesisSymbols(versions: { createdAt: Date; document: unknown }[]): Map<string, Date> {
  const first = new Map<string, Date>();
  for (const v of versions) {
    const conviction = (v.document as { conviction?: unknown } | null)?.conviction;
    if (!Array.isArray(conviction)) continue;
    for (const t of conviction) {
      const symbol = (t as { symbol?: unknown } | null)?.symbol;
      if (typeof symbol !== "string") continue;
      const seen = first.get(symbol);
      if (!seen || v.createdAt < seen) first.set(symbol, v.createdAt);
    }
  }
  return first;
}

/**
 * Re-read the adjusted daily closes of every thesis symbol, from CLOSES_LEAD_DAYS
 * before the first version that held any of them, and upsert the ones that are
 * new or changed (writeChangedCloses). One bars request; re-reading the whole
 * window keeps each symbol's closes on one adjustment basis. Returns the
 * number of closes written.
 */
export async function recordThesisCloses(db: Db, broker: BrokerAdapter, now: Date): Promise<number> {
  const symbols = thesisSymbols(await db.select({ createdAt: strategies.createdAt, document: strategies.document }).from(strategies).orderBy(asc(strategies.version)));
  if (symbols.size === 0) return 0;
  const earliest = Math.min(...[...symbols.values()].map((d) => d.getTime()));
  const bars = await broker.getDailyBars([...symbols.keys()], new Date(earliest - CLOSES_LEAD_DAYS * DAY_MS), now);
  return writeChangedCloses(db, thesisCloses, bars, now);
}
