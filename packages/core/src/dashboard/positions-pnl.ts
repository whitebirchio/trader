/**
 * Profit and loss by position over a range (SPEC-dashboard Amendment 3 §
 * Position history): each symbol's value at the range's last close, less its
 * value at the base close, less what was bought in between (sales count
 * back). Two more lines make the parts add up to the portfolio's dollar P&L
 * for the range, to the cent:
 * - afterClosePricing: the change in Alpaca's after-close mark against the
 *   official close (position-history.ts);
 * - cashAndOther: dividends, fees, interest and fill rounding, which move
 *   cash without belonging to a position's price.
 */
import Big from "big.js";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brokerActivities, equitySnapshots, positionSnapshots } from "../db/schema.js";
import { dayValues } from "../portfolio/position-history.js";
import { loadIndexInputs } from "../risk/gate.js";

export interface PositionPnl {
  symbol: string;
  /** Value at the base close (0 if not held). */
  valueStart: string;
  /** Value at the last close (0 if sold). */
  valueEnd: string;
  /** Bought less sold in between, at the fill prices. */
  netBought: string;
  pnl: string;
}

export type PositionsPnl =
  | {
      status: "ok";
      since: string;
      through: string;
      /** Biggest gain first. */
      positions: PositionPnl[];
      afterClosePricing: string;
      cashAndOther: string;
      /** The portfolio's P&L for the range: the sum of everything above. */
      total: string;
    }
  | { status: "unavailable"; reason: string };

const money = (b: Big) => b.toFixed(2);

/** P&L by position between two recorded sessions (`since` is the base close; `through` the last). */
export async function positionsPnl(db: Db, since: string, through: string): Promise<PositionsPnl> {
  const [start, end] = await Promise.all([since, through].map(async (d) => (await db.select().from(equitySnapshots).where(eq(equitySnapshots.tradingDate, d)))[0]));
  if (!start || !end) return { status: "unavailable", reason: "no recorded session on one of the range's dates" };
  const values = await dayValues(db, [since, through]);
  const [vStart, vEnd] = [values.find((v) => v.tradingDate === since), values.find((v) => v.tradingDate === through)];
  if (vStart?.afterClosePricing == null || vEnd?.afterClosePricing == null) return { status: "unavailable", reason: "the position history isn't recorded for this range yet" };

  const rows = await db.select().from(positionSnapshots).where(inArray(positionSnapshots.tradingDate, [since, through]));
  const fills = await db
    .select()
    .from(brokerActivities)
    .where(and(eq(brokerActivities.type, "FILL"), gt(brokerActivities.at, start.recordedAt), lte(brokerActivities.at, end.recordedAt)))
    .orderBy(asc(brokerActivities.at));
  const symbols = new Set([...rows.map((r) => r.symbol), ...fills.map((f) => f.symbol!)]);
  const valueOn = (symbol: string, date: string) => new Big(rows.find((r) => r.symbol === symbol && r.tradingDate === date)?.marketValue ?? "0");
  const positions = [...symbols].map((symbol): PositionPnl => {
    const bought = fills
      .filter((f) => f.symbol === symbol)
      .reduce((sum, f) => sum.plus(new Big(f.qty!).times(f.price!).times(f.side === "sell" ? -1 : 1)), new Big(0));
    const a = valueOn(symbol, since);
    const b = valueOn(symbol, through);
    return { symbol, valueStart: money(a), valueEnd: money(b), netBought: money(bought), pnl: money(b.minus(a).minus(bought)) };
  });
  positions.sort((x, y) => new Big(y.pnl).cmp(x.pnl));

  // The same flows, and the same window rule, as the index and performanceView.
  const { flows } = await loadIndexInputs(db);
  const added = flows.filter((f) => f.at > start.recordedAt && f.at <= end.recordedAt).reduce((sum, f) => sum.plus(f.amount), new Big(0));
  const total = new Big(end.equity).minus(start.equity).minus(added);
  const afterClosePricing = new Big(vEnd.afterClosePricing).minus(vStart.afterClosePricing);
  const fromPositions = positions.reduce((sum, p) => sum.plus(p.pnl), new Big(0));
  return {
    status: "ok",
    since,
    through,
    positions,
    afterClosePricing: money(afterClosePricing),
    cashAndOther: money(total.minus(fromPositions).minus(afterClosePricing)),
    total: money(total),
  };
}
