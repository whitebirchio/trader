/**
 * The Today page's figures (SPEC-dashboard Amendment 3): the last session's
 * move, for the portfolio and each position, and what happened in it. "Today"
 * is the session of the last sync, measured from the session before's close;
 * on a closed day that's the last session, dated. Database only.
 *
 * A position's move is its value now, less its value at the previous close,
 * less what was bought today (sales count back), so shares bought today are
 * measured from their fill and shares sold today to their sale. The portfolio's
 * move is Alpaca's: equity less its prior-close equity, less today's deposits.
 * `other` is the difference (cash items, and the prior close's after-close
 * pricing), so the parts add up to the portfolio.
 */
import Big from "big.js";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, brokerAccount, brokerActivities, equitySnapshots, positionSnapshots, positions } from "../db/schema.js";
import { loadIndexInputs } from "../risk/gate.js";
import { marketDate, marketTimeToUtc } from "../time.js";

export interface TodayMove {
  symbol: string;
  qty: string;
  price: string;
  /** The previous session's official close; null if not held then. */
  previousClose: string | null;
  move: string;
  /** move against the dollars at stake (the value at the previous close, or what was bought today); null if neither. */
  movePct: string | null;
}

export interface TodayEvent {
  at: string;
  kind: string;
  symbol: string | null;
  payload: Record<string, unknown>;
}

export interface TodayView {
  /** The session the figures are for (the last sync's market date), and when the data was synced. */
  session: string;
  asOf: string;
  previousSession: string | null;
  equity: string;
  /** Today's profit or loss in dollars, and %, net of today's deposits. */
  move: string | null;
  movePct: string | null;
  /** Biggest move first, by size. */
  positions: TodayMove[];
  /** move − the positions' moves. */
  other: string | null;
  /** What happened in the session, oldest first. */
  events: TodayEvent[];
}

/** The kinds the "what changed today" list shows. */
export const TODAY_KINDS = [
  "order.filled",
  "strategy.activated",
  "thesis.stopped_out",
  "thesis.took_profit",
  "thesis.review_overdue",
  "thesis.stale",
  "routine.event_run_result",
  "events.tripped",
  "filing.sell_signal",
  "risk.halted",
  "risk.kill_switch_on",
  "risk.resumed",
  "risk.buys_paused",
  "capital.deposit_received",
  "capital.withdrawal_completed",
] as const;

const pctOf = (move: Big, base: Big) => (base.gt(0) ? move.div(base).times(100).toFixed(2) : null);

export async function todayView(db: Db): Promise<TodayView | null> {
  const [account] = await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1));
  if (!account) return null;
  const session = marketDate(account.syncedAt);
  const [previous] = await db.select().from(equitySnapshots).where(lt(equitySnapshots.tradingDate, session)).orderBy(desc(equitySnapshots.tradingDate)).limit(1);
  const since = previous?.recordedAt ?? new Date(0);

  const prevRows = previous ? await db.select().from(positionSnapshots).where(eq(positionSnapshots.tradingDate, previous.tradingDate)) : [];
  const held = await db.select().from(positions);
  const fills = await db
    .select()
    .from(brokerActivities)
    .where(and(eq(brokerActivities.type, "FILL"), gt(brokerActivities.at, since), lte(brokerActivities.at, account.syncedAt)))
    .orderBy(asc(brokerActivities.at));

  const symbols = new Set([...held.map((p) => p.symbol), ...prevRows.map((r) => r.symbol), ...fills.map((f) => f.symbol!)]);
  const moves = [...symbols].map((symbol): TodayMove => {
    const now = held.find((p) => p.symbol === symbol);
    const before = prevRows.find((r) => r.symbol === symbol);
    const valueNow = new Big(now?.marketValue ?? "0");
    const valueBefore = new Big(before?.marketValue ?? "0");
    const bought = fills.filter((f) => f.symbol === symbol).reduce((s, f) => s.plus(new Big(f.qty!).times(f.price!).times(f.side === "sell" ? -1 : 1)), new Big(0));
    const move = valueNow.minus(valueBefore).minus(bought);
    const atStake = valueBefore.gt(0) ? valueBefore : bought.gt(0) ? bought : new Big(0);
    return { symbol, qty: now?.qty ?? "0", price: now?.currentPrice ?? "0", previousClose: before?.close ?? null, move: move.toFixed(2), movePct: pctOf(move, atStake) };
  });
  moves.sort((a, b) => new Big(b.move).abs().cmp(new Big(a.move).abs()));

  let move: string | null = null;
  let movePct: string | null = null;
  if (account.lastEquity !== null) {
    const { flows } = await loadIndexInputs(db);
    const added = flows.filter((f) => f.at > since && f.at <= account.syncedAt).reduce((s, f) => s.plus(f.amount), new Big(0));
    const m = new Big(account.equity).minus(account.lastEquity).minus(added);
    move = m.toFixed(2);
    movePct = pctOf(m, new Big(account.lastEquity).plus(added.gt(0) ? added : 0));
  }
  const other = move === null ? null : new Big(move).minus(moves.reduce((s, p) => s.plus(p.move), new Big(0))).toFixed(2);

  const events = await db
    .select()
    .from(auditEvents)
    .where(and(gte(auditEvents.at, marketTimeToUtc(session, "00:00")), inArray(auditEvents.kind, [...TODAY_KINDS])))
    .orderBy(asc(auditEvents.at));
  return {
    session,
    asOf: account.syncedAt.toISOString(),
    previousSession: previous?.tradingDate ?? null,
    equity: account.equity,
    move,
    movePct,
    positions: moves,
    other,
    events: events.map((e) => ({ at: e.at.toISOString(), kind: e.kind, symbol: e.subject, payload: e.payload })),
  };
}
