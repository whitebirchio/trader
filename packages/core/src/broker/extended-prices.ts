/**
 * Pre-market and after-hours prices (SPEC-dashboard Amendment 3): during each
 * extended session, every held symbol's latest one-minute bar, for the
 * dashboard's indicative line beside the regular session's figures. Market
 * data only: it places nothing, and risk, the index, rebalance and the
 * scorecard never read what it writes.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { extendedPrices, positions } from "../db/schema.js";
import { marketDate, marketTimeToUtc } from "../time.js";
import { BENCHMARK } from "./benchmark-closes.js";
import type { BrokerAdapter, CalendarDay } from "./port.js";

/** The bars run this far behind (Alpaca's free SIP feed, as for the daily bars). */
export const EXTENDED_DELAY_MS = 16 * 60_000;

export type ExtendedSession = { session: "pre" | "post"; from: Date; to: Date };

/** The extended session the delayed data is in at `now`, if any. Without Alpaca's session times, 4:00 AM and 8:00 PM ET. */
export function extendedSession(day: CalendarDay, now: Date): ExtendedSession | null {
  const seen = new Date(now.getTime() - EXTENDED_DELAY_MS);
  const sessionOpen = day.sessionOpen ?? marketTimeToUtc(day.date, "04:00");
  const sessionClose = day.sessionClose ?? marketTimeToUtc(day.date, "20:00");
  if (seen >= sessionOpen && seen < day.open) return { session: "pre", from: sessionOpen, to: day.open };
  if (seen >= day.close && seen <= sessionClose) return { session: "post", from: day.close, to: sessionClose };
  return null;
}

export type ExtendedResult = { status: "skipped"; reason: string } | { status: "recorded"; session: "pre" | "post"; symbols: number; written: number };

/** Record the latest extended-session bar of each held symbol (and VTI), upserting one row per symbol and session. */
export async function recordExtendedPrices(db: Db, broker: BrokerAdapter, now: Date): Promise<ExtendedResult> {
  const today = marketDate(now);
  const [day] = await broker.getCalendar(today, today);
  if (!day) return { status: "skipped", reason: "not a trading day" };
  const window = extendedSession(day, now);
  if (!window) return { status: "skipped", reason: "outside the pre-market and after-hours sessions" };
  const symbols = [...new Set([...(await db.select({ symbol: positions.symbol }).from(positions)).map((p) => p.symbol), BENCHMARK])];
  // The window's bars only: one before the open is pre-market, one from the close on is after hours.
  const end = new Date(Math.min(window.to.getTime(), now.getTime()) - 1);
  const bars = await broker.getMinuteBars(symbols, window.from, end);
  const rows = Object.entries(bars).flatMap(([symbol, list]) => {
    const last = list.filter((b) => b.t >= window.from && b.t < window.to).at(-1);
    return last ? [{ tradingDate: today, symbol, session: window.session, price: last.c, barAt: last.t, recordedAt: now }] : [];
  });
  if (rows.length)
    await db
      .insert(extendedPrices)
      .values(rows)
      .onConflictDoUpdate({
        target: [extendedPrices.tradingDate, extendedPrices.symbol, extendedPrices.session],
        set: { price: sql`excluded.price`, barAt: sql`excluded.bar_at`, recordedAt: sql`excluded.recorded_at` },
      });
  return { status: "recorded", session: window.session, symbols: symbols.length, written: rows.length };
}
