import Big from "big.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, capitalFlows, equitySnapshots } from "../../src/db/schema.js";
import { performanceView } from "../../src/dashboard/performance.js";
import { positionsPnl } from "../../src/dashboard/positions-pnl.js";
import { recordPositionHistory } from "../../src/portfolio/position-history.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";

const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1000" });
const close = (date: string) => new Date(`${date}T21:00:00Z`);
const fill = (id: string, at: string, symbol: string, side: "buy" | "sell", qty: string, price: string) => ({ id, type: "FILL", at: new Date(at), symbol, side, qty, price, raw: {} });
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  // Nov 2: $1,000 in; buys 2 VTI at 300 and 1.5 ICE at 170 ($145 cash).
  // Nov 3: sells 0.5 VTI at 302; $50 more deposited. Nov 4: sells all ICE at 175, buys 1 DAL at 80; a $0.37 dividend.
  await db.insert(brokerActivities).values([
    { id: "dep1", type: "CSD", at: new Date("2026-11-02T14:00:00Z"), netAmount: "1000", raw: {} },
    fill("f1", "2026-11-02T15:00:00Z", "VTI", "buy", "2", "300"),
    fill("f2", "2026-11-02T15:05:00Z", "ICE", "buy", "1.5", "170"),
    fill("f3", "2026-11-03T15:00:00Z", "VTI", "sell", "0.5", "302"),
    { id: "dep2", type: "CSD", at: new Date("2026-11-03T16:00:00Z"), netAmount: "50", raw: {} },
    fill("f4", "2026-11-04T15:00:00Z", "ICE", "sell", "1.5", "175"),
    fill("f5", "2026-11-04T15:10:00Z", "DAL", "buy", "1", "80"),
    { id: "div", type: "DIV", at: new Date("2026-11-04T17:00:00Z"), symbol: "VTI", netAmount: "0.37", raw: {} },
  ]);
  await db.insert(capitalFlows).values([
    { activityId: "dep1", at: new Date("2026-11-02T14:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" },
    { activityId: "dep2", at: new Date("2026-11-03T16:00:00Z"), amount: "50", kind: "deposit", timedBy: "created_at", status: "executed" },
  ]);
  // Cash: 145 → 145 + 151 + 50 = 346 → 346 + 262.5 − 80 + 0.37 = 528.87. Equity is Alpaca's mark (a little off the official close).
  await db.insert(equitySnapshots).values([
    { tradingDate: "2026-11-02", equity: "1003.20", cash: "145", longMarketValue: "858.20", recordedAt: close("2026-11-02") },
    { tradingDate: "2026-11-03", equity: "1061.30", cash: "346", longMarketValue: "715.30", recordedAt: close("2026-11-03") },
    { tradingDate: "2026-11-04", equity: "1071.17", cash: "528.87", longMarketValue: "542.30", recordedAt: close("2026-11-04") },
  ]);
  await db.insert(benchmarkCloses).values(["2026-11-02", "2026-11-03", "2026-11-04"].map((tradingDate, i) => ({ symbol: "VTI", tradingDate, close: String(301 + i) })));
  const broker = new FakeBroker();
  broker.rawBars = {
    VTI: [bar("2026-11-02", "301.10"), bar("2026-11-03", "303.40"), bar("2026-11-04", "306.00")],
    ICE: [bar("2026-11-02", "170.80"), bar("2026-11-03", "172.00")],
    DAL: [bar("2026-11-04", "83.00")],
  };
  await recordPositionHistory(db, broker, new Date("2026-11-05T14:00:00Z"));
});

describe("positionsPnl", () => {
  it("is each position's value change less what was bought, with a sale, a full exit and a new buy inside the range", async () => {
    const r = await positionsPnl(db, "2026-11-02", "2026-11-04");
    expect(r).toMatchObject({ status: "ok", since: "2026-11-02", through: "2026-11-04" });
    if (r.status !== "ok") throw new Error("unavailable");
    expect(r.positions).toEqual([
      // ICE: 256.20 → 0, sold for 262.50: +6.30. VTI: 602.20 → 459.00, sold 0.5 for 151: +7.80. DAL: bought 80, worth 83: +3.
      { symbol: "VTI", valueStart: "602.20", valueEnd: "459.00", netBought: "-151.00", pnl: "7.80" },
      { symbol: "ICE", valueStart: "256.20", valueEnd: "0.00", netBought: "-262.50", pnl: "6.30" },
      { symbol: "DAL", valueStart: "0.00", valueEnd: "83.00", netBought: "80.00", pnl: "3.00" },
    ]);
    // The dividend lands in cashAndOther; after-close pricing moved from −0.20 to +0.30.
    expect(r).toMatchObject({ afterClosePricing: "0.50", cashAndOther: "0.37", total: "17.97" });
  });

  it("adds up to the Performance page's dollar figure for every range it covers", async () => {
    const v = await performanceView(db);
    for (const range of v.ranges.filter((x) => x.available && x.since)) {
      const r = await positionsPnl(db, range.since!, range.through!);
      if (r.status !== "ok") throw new Error(`${range.range} unavailable`);
      const parts = r.positions.reduce((sum, p) => sum.plus(p.pnl), new Big(0)).plus(r.afterClosePricing).plus(r.cashAndOther);
      expect(parts.toFixed(2)).toBe(r.total);
      expect(new Big(r.total).eq(range.pnl!)).toBe(true);
    }
  });

  it("says so when the position history doesn't cover the range", async () => {
    expect(await positionsPnl(db, "2026-11-01", "2026-11-04")).toMatchObject({ status: "unavailable" });
  });
});
