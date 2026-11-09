import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brokerActivities } from "../db/schema.js";
import type { Activity } from "./port.js";

/** An activity without Alpaca's raw payload: everything lot-building and the scorecard read. */
export type LedgerActivity = Omit<Activity, "raw">;

/**
 * Every recorded activity, oldest first, without the raw JSON. Lots are
 * rebuilt from the whole history on each sync and rebalance step, so this
 * keeps those reads to the columns they use.
 */
export async function loadActivities(db: Db): Promise<LedgerActivity[]> {
  const rows = await db
    .select({
      id: brokerActivities.id,
      type: brokerActivities.type,
      at: brokerActivities.at,
      symbol: brokerActivities.symbol,
      side: brokerActivities.side,
      qty: brokerActivities.qty,
      price: brokerActivities.price,
      netAmount: brokerActivities.netAmount,
      orderId: brokerActivities.orderId,
    })
    .from(brokerActivities)
    .orderBy(asc(brokerActivities.at), asc(brokerActivities.id));
  return rows.map((r) => ({ ...r, side: r.side === "buy" || r.side === "sell" ? r.side : null }));
}
