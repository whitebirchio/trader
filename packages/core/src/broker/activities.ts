import { asc, count, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brokerActivities } from "../db/schema.js";
import { type Lots, buildLots } from "./lots.js";
import type { Activity } from "./port.js";

/** An activity without Alpaca's raw payload: everything lot-building and the scorecard read. */
export type LedgerActivity = Omit<Activity, "raw">;

/**
 * Every recorded activity, oldest first, without the raw JSON. Lots are
 * rebuilt from the whole history (memoized by loadLedger, below), so this
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

const ledgers = new WeakMap<Db, { key: string; activities: LedgerActivity[]; lots: Lots }>();

/**
 * Every activity and the FIFO lots built from them, rebuilt only when
 * broker_activities has changed since the last call on this database (#89).
 * The table is insert-only (sync never updates or deletes a row), so its row
 * count and latest time identify its contents. A sync or rebalance step reads
 * lots several times, and a replay thousands of times, so most calls are one
 * small aggregate query. The result is frozen and shared: don't modify it.
 */
export async function loadLedger(db: Db): Promise<{ activities: readonly LedgerActivity[]; lots: Lots }> {
  const [row] = await db.select({ n: count(), at: max(brokerActivities.at) }).from(brokerActivities);
  const key = `${row?.n ?? 0}|${row?.at?.toISOString() ?? ""}`;
  const hit = ledgers.get(db);
  if (hit?.key === key) return hit;
  const activities = Object.freeze(await loadActivities(db)) as LedgerActivity[];
  const built = buildLots(activities);
  const lots = Object.freeze({ open: Object.freeze(built.open), closed: Object.freeze(built.closed), issues: Object.freeze(built.issues) }) as unknown as Lots;
  const entry = { key, activities, lots };
  ledgers.set(db, entry);
  return entry;
}
