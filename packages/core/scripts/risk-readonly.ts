/** The drawdown/daily-change numbers without the side effects of checkDrawdown (no latch, no audit). */
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { brokerAccount } from "../src/db/schema.js";
import type { LiveIndex } from "../src/risk/equity-index.js";
import { loadSnapshot } from "../src/risk/gate.js";
import { LIMITS } from "../src/risk/limits.js";
import type { BrokerAdapter } from "../src/broker/port.js";

const noBroker = {} as BrokerAdapter; // loadSnapshot only calls the broker for buy proposals

export async function checkDrawdownReadOnly(db: Db, now: Date): Promise<LiveIndex> {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  if (!account) return { drawdownPct: "0", dailyChangePct: "0" };
  return (await loadSnapshot(db, noBroker, [], now, LIMITS)).index;
}
