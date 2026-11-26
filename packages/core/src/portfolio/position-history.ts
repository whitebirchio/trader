/**
 * Each completed session's holdings (SPEC-dashboard Amendment 3 § Position
 * history): the quantity of every symbol at the session's close, rebuilt
 * from the fills, valued at the official close as traded. The dashboard
 * reads it for profit and loss by position over any range. Risk and
 * rebalance never do.
 *
 * Equity snapshots record Alpaca's own mark at the after-close sync, which
 * can include after-hours trades; positions here are at the official close.
 * The difference is reported, never hidden: equity = cash + positions +
 * afterClosePricing, to the cent (the T3 spike, 2026-11-26).
 */
import Big from "big.js";
import { asc, eq, inArray } from "drizzle-orm";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { brokerActivities, equitySnapshots, positionSnapshots } from "../db/schema.js";
import { marketDate } from "../time.js";

/** A session's close is final this long after the after-close snapshot (SIP bars run about 16 minutes behind). */
export const CLOSE_FINAL_AFTER_MS = 45 * 60_000;
/** A missing bar this many days old is written as a gap (null close) instead of retried. */
export const GAP_AFTER_DAYS = 5;
const DAY_MS = 86_400_000;

export interface Fill {
  symbol: string;
  side: string;
  qty: string;
  at: Date;
}

/** Each symbol's quantity after every fill at or before `cutoff` (zero positions left out). */
export function holdingsAt(fills: Fill[], cutoff: Date): Map<string, string> {
  const qty = new Map<string, Big>();
  for (const f of fills) {
    if (f.at.getTime() > cutoff.getTime()) continue;
    const q = new Big(f.qty);
    qty.set(f.symbol, (qty.get(f.symbol) ?? new Big(0)).plus(f.side === "sell" ? q.neg() : q));
  }
  return new Map([...qty].filter(([, q]) => !q.eq(0)).map(([s, q]) => [s, q.toString()]));
}

async function loadFills(db: Db): Promise<Fill[]> {
  const rows = await db
    .select({ symbol: brokerActivities.symbol, side: brokerActivities.side, qty: brokerActivities.qty, at: brokerActivities.at })
    .from(brokerActivities)
    .where(eq(brokerActivities.type, "FILL"))
    .orderBy(asc(brokerActivities.at));
  return rows.filter((r): r is Fill => r.symbol !== null && r.side !== null && r.qty !== null);
}

export interface DayPlan {
  tradingDate: string;
  holdings: Map<string, string>;
}

/** Completed sessions with holdings and no rows yet, oldest first. */
export async function missingDays(db: Db, now: Date): Promise<DayPlan[]> {
  const snaps = await db.select({ tradingDate: equitySnapshots.tradingDate, recordedAt: equitySnapshots.recordedAt }).from(equitySnapshots).orderBy(asc(equitySnapshots.tradingDate));
  const done = new Set((await db.selectDistinct({ tradingDate: positionSnapshots.tradingDate }).from(positionSnapshots)).map((r) => r.tradingDate));
  const fills = await loadFills(db);
  return snaps
    .filter((s) => !done.has(s.tradingDate) && now.getTime() - s.recordedAt.getTime() >= CLOSE_FINAL_AFTER_MS)
    .map((s) => ({ tradingDate: s.tradingDate, holdings: holdingsAt(fills, s.recordedAt) }))
    .filter((d) => d.holdings.size > 0);
}

export interface PositionRow {
  tradingDate: string;
  symbol: string;
  qty: string;
  close: string | null;
  marketValue: string | null;
}

/**
 * The rows for `days`, valued at raw closes in one bars request. A day whose
 * bar is missing is left for a later run, unless it's GAP_AFTER_DAYS old:
 * then its rows are written with a null close and reported.
 */
export async function buildRows(broker: BrokerAdapter, days: DayPlan[], now: Date): Promise<{ rows: PositionRow[]; waiting: string[]; gaps: string[] }> {
  if (days.length === 0) return { rows: [], waiting: [], gaps: [] };
  const symbols = [...new Set(days.flatMap((d) => [...d.holdings.keys()]))];
  const first = new Date(`${days[0]!.tradingDate}T00:00:00Z`);
  const bars = await broker.getDailyBars(symbols, new Date(first.getTime() - DAY_MS), now, { adjustment: "raw" });
  const closes = new Map<string, string>();
  for (const [symbol, list] of Object.entries(bars)) for (const b of list) closes.set(`${symbol}|${marketDate(b.t)}`, b.c);
  const rows: PositionRow[] = [];
  const waiting: string[] = [];
  const gaps: string[] = [];
  for (const d of days) {
    const missing = [...d.holdings.keys()].filter((s) => !closes.has(`${s}|${d.tradingDate}`));
    const old = now.getTime() - Date.parse(`${d.tradingDate}T00:00:00Z`) >= GAP_AFTER_DAYS * DAY_MS;
    if (missing.length && !old) {
      waiting.push(d.tradingDate);
      continue;
    }
    for (const s of missing) gaps.push(`${d.tradingDate} ${s}`);
    for (const [symbol, qty] of d.holdings) {
      const close = closes.get(`${symbol}|${d.tradingDate}`) ?? null;
      rows.push({ tradingDate: d.tradingDate, symbol, qty, close, marketValue: close === null ? null : new Big(qty).times(close).toFixed(2) });
    }
  }
  return { rows, waiting, gaps };
}

/** The position-history job: write every completed session that's missing (the first run backfills from the first fill). Idempotent per day. */
export async function recordPositionHistory(db: Db, broker: BrokerAdapter, now: Date): Promise<{ days: number; rows: number; waiting: string[]; gaps: string[] }> {
  const days = await missingDays(db, now);
  const { rows, waiting, gaps } = await buildRows(broker, days, now);
  if (rows.length) await db.insert(positionSnapshots).values(rows.map((r) => ({ ...r, recordedAt: now }))).onConflictDoNothing();
  return { days: new Set(rows.map((r) => r.tradingDate)).size, rows: rows.length, waiting, gaps };
}

export interface DayValue {
  tradingDate: string;
  equity: string;
  cash: string | null;
  /** The positions at the official close; null if any close is missing, or the day isn't written yet. */
  positions: string | null;
  /** equity − cash − positions: Alpaca's after-close mark against the official close. */
  afterClosePricing: string | null;
}

/** Each recorded session's equity split into cash, positions at the close, and the after-close pricing that reconciles them. */
export async function dayValues(db: Db, dates?: string[]): Promise<DayValue[]> {
  const snaps = await db.select().from(equitySnapshots).where(dates ? inArray(equitySnapshots.tradingDate, dates) : undefined).orderBy(asc(equitySnapshots.tradingDate));
  const rows = await db.select().from(positionSnapshots).where(dates ? inArray(positionSnapshots.tradingDate, dates) : undefined);
  const byDay = new Map<string, PositionRow[]>();
  for (const r of rows) byDay.set(r.tradingDate, [...(byDay.get(r.tradingDate) ?? []), r]);
  return snaps.map((s) => {
    const list = byDay.get(s.tradingDate);
    const empty = !list && s.longMarketValue !== null && new Big(s.longMarketValue).eq(0);
    const positions = empty ? "0.00" : list && list.every((r) => r.marketValue !== null) ? list.reduce((sum, r) => sum.plus(r.marketValue!), new Big(0)).toFixed(2) : null;
    const afterClosePricing = positions !== null && s.cash !== null ? new Big(s.equity).minus(s.cash).minus(positions).toFixed(2) : null;
    return { tradingDate: s.tradingDate, equity: s.equity, cash: s.cash, positions, afterClosePricing };
  });
}
