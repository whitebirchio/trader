import { and, count, gte, inArray, max, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { benchmarkCloses, thesisCloses } from "../db/schema.js";
import { add, compare } from "../money.js";
import { marketDate } from "../time.js";
import type { Bar } from "./port.js";

/** Rows per insert, well inside Postgres's bind-parameter limit. */
const CHUNK = 1000;

/**
 * Store the adjusted closes in `bars` that are new or changed (#89). Callers
 * re-read a whole window so every close stays on one adjustment basis, but
 * rewriting the window every day made each run cost more than the last. Per
 * symbol, the stored closes from the first fetched session on are summarised
 * (count, last date, sum). If the fetched closes up to that last date match
 * the summary, nothing stored changed, and only later sessions are written.
 * Otherwise a split or dividend re-adjusted the history, and all of the
 * symbol's fetched closes are rewritten. Returns the number of closes written.
 */
export async function writeChangedCloses(db: Db, table: typeof thesisCloses | typeof benchmarkCloses, bars: Record<string, Bar[]>, now: Date): Promise<number> {
  const fetched = Object.entries(bars)
    .map(([symbol, list]) => ({ symbol, rows: list.map((b) => ({ symbol, tradingDate: marketDate(b.t), close: b.c, recordedAt: now })) }))
    .filter((s) => s.rows.length > 0);
  if (fetched.length === 0) return 0;
  const from = fetched.reduce((min, s) => (s.rows[0]!.tradingDate < min ? s.rows[0]!.tradingDate : min), fetched[0]!.rows[0]!.tradingDate);
  const t = table as typeof thesisCloses;
  const summaries = await db
    .select({ symbol: t.symbol, n: count(), last: max(t.tradingDate), sum: sql<string>`sum(${t.close})::text` })
    .from(t)
    .where(and(inArray(t.symbol, fetched.map((s) => s.symbol)), gte(t.tradingDate, from)))
    .groupBy(t.symbol);
  const stored = new Map(summaries.map((s) => [s.symbol, s]));

  const rows = fetched.flatMap(({ symbol, rows: all }) => {
    const s = stored.get(symbol);
    if (!s || !s.last) return all;
    const known = all.filter((r) => r.tradingDate <= s.last!);
    const sum = known.reduce((total, r) => add(total, r.close), "0");
    const unchanged = known.length === s.n && compare(sum, s.sum) === 0;
    return unchanged ? all.filter((r) => r.tradingDate > s.last!) : all;
  });
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(t)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({ target: [t.symbol, t.tradingDate], set: { close: sql`excluded.close`, recordedAt: sql`excluded.recorded_at` } });
  }
  return rows.length;
}
