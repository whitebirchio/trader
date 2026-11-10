import { and, asc, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { strategies, thesisCloses } from "../db/schema.js";
import { compare } from "../money.js";
import { marketDate } from "../time.js";
import type { BrokerAdapter } from "./port.js";

/** How far before a symbol's first thesis its closes are kept: the thesis chart's longest range is a year (#59). */
export const CLOSES_LEAD_DAYS = 380;
const DAY_MS = 86_400_000;
/** Rows per insert, well inside Postgres's bind-parameter limit. */
const CHUNK = 1000;

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
 * new or changed. One bars request; re-reading the whole window keeps each
 * symbol's closes on one adjustment basis (a split or dividend re-adjusts its
 * past closes, and those are rewritten). Writing only what changed keeps a run
 * from re-inserting the whole history every day (#89). Returns the number of
 * closes written.
 */
export async function recordThesisCloses(db: Db, broker: BrokerAdapter, now: Date): Promise<number> {
  const symbols = thesisSymbols(await db.select({ createdAt: strategies.createdAt, document: strategies.document }).from(strategies).orderBy(asc(strategies.version)));
  if (symbols.size === 0) return 0;
  const earliest = Math.min(...[...symbols.values()].map((d) => d.getTime()));
  const bars = await broker.getDailyBars([...symbols.keys()], new Date(earliest - CLOSES_LEAD_DAYS * DAY_MS), now);
  const from = marketDate(new Date(earliest - CLOSES_LEAD_DAYS * DAY_MS));
  const stored = await db
    .select({ symbol: thesisCloses.symbol, tradingDate: thesisCloses.tradingDate, close: thesisCloses.close })
    .from(thesisCloses)
    .where(and(inArray(thesisCloses.symbol, [...symbols.keys()]), gte(thesisCloses.tradingDate, from)));
  const have = new Map(stored.map((r) => [`${r.symbol}|${r.tradingDate}`, r.close]));
  const rows = Object.entries(bars)
    .flatMap(([symbol, list]) => list.map((b) => ({ symbol, tradingDate: marketDate(b.t), close: b.c, recordedAt: now })))
    .filter((r) => {
      const close = have.get(`${r.symbol}|${r.tradingDate}`);
      return close === undefined || compare(close, r.close) !== 0;
    });
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(thesisCloses)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [thesisCloses.symbol, thesisCloses.tradingDate],
        set: { close: sql`excluded.close`, recordedAt: sql`excluded.recorded_at` },
      });
  }
  return rows.length;
}
