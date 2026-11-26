import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerAccount, brokerActivities, capitalFlows, equitySnapshots, positions } from "../../src/db/schema.js";
import { isBalanced } from "../../src/dashboard/sankey.js";
import { todayPage } from "../../src/dashboard/today-page.js";
import { recordPositionHistory } from "../../src/portfolio/position-history.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1000" });
const close = (date: string) => new Date(`${date}T21:00:00Z`);
const fill = (id: string, at: string, symbol: string, side: "buy" | "sell", qty: string, price: string) => ({ id, type: "FILL", at: new Date(at), symbol, side, qty, price, raw: {} });
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  await db.insert(brokerActivities).values([
    { id: "dep1", type: "CSD", at: new Date("2026-11-02T14:00:00Z"), netAmount: "1000", raw: {} },
    fill("f1", "2026-11-02T15:00:00Z", "VTI", "buy", "2", "300"),
    fill("f2", "2026-11-02T15:05:00Z", "ICE", "buy", "1.5", "170"),
    fill("f3", "2026-11-03T15:00:00Z", "ICE", "sell", "1.5", "175"),
  ]);
  await db.insert(capitalFlows).values({ activityId: "dep1", at: new Date("2026-11-02T14:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" });
  // The first recorded day already holds positions (its after-close pricing isn't zero).
  await db.insert(equitySnapshots).values([
    { tradingDate: "2026-11-02", equity: "1003.20", cash: "145", longMarketValue: "858.20", recordedAt: close("2026-11-02") },
    { tradingDate: "2026-11-03", equity: "1014.30", cash: "407.50", longMarketValue: "606.80", recordedAt: close("2026-11-03") },
  ]);
  await db.insert(benchmarkCloses).values([{ symbol: "VTI", tradingDate: "2026-11-02", close: "301.10" }, { symbol: "VTI", tradingDate: "2026-11-03", close: "303.40" }]);
  const broker = new FakeBroker();
  broker.rawBars = { VTI: [bar("2026-11-02", "301.10"), bar("2026-11-03", "303.40")], ICE: [bar("2026-11-02", "170.80"), bar("2026-11-03", "176")] };
  await recordPositionHistory(db, broker, new Date("2026-11-04T14:00:00Z"));
  await db.insert(brokerAccount).values({ id: 1, accountNumber: "LA1", status: "ACTIVE", cash: "407.50", equity: "1014.30", lastEquity: "1003.20", longMarketValue: "606.80", buyingPower: "0", multiplier: "1", tradingBlocked: false, accountBlocked: false, config: {}, tradingAllowed: true, syncedAt: new Date("2026-11-03T21:15:00Z") });
  await db.insert(positions).values({ symbol: "VTI", qty: "2", avgEntryPrice: "300", marketValue: "606.80", costBasis: "600", currentPrice: "303.40", syncedAt: new Date("2026-11-03T21:15:00Z") });
  await submitStrategy(db, strategy({ conviction: [thesis({ id: "vti-core", symbol: "VTI", headline: "Holding VTI while the market's broad rally lasts" })] }), "owner", new Date("2026-11-02T12:00:00Z"));
});

describe("todayPage", () => {
  it("brings the session, since start, headlines and a reconciled money diagram together", async () => {
    const p = await todayPage(db, "production", new Date("2026-11-03T22:00:00Z"));
    expect(p.today).toMatchObject({ session: "2026-11-03", move: "11.10" });
    expect(p.sinceStart).toMatchObject({ since: "2026-11-02", through: "2026-11-03", pnl: "11.1" });
    expect(p.headlines.VTI).toEqual({ text: "Holding VTI while the market's broad rally lasts", fallback: false, thesisId: "vti-core" });
    expect(p.money).not.toBeNull();
    // Holdings at the close (VTI 606.80) plus cash (407.50).
    expect(p.money!.total).toBe("1014.3");
    expect(isBalanced(p.money!)).toBe(true);
  });
});
