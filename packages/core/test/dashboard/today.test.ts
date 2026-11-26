import Big from "big.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { auditEvents, benchmarkCloses, brokerAccount, brokerActivities, equitySnapshots, extendedPrices, positionSnapshots, positions, thesisCloses } from "../../src/db/schema.js";
import { extendedView, todayView } from "../../src/dashboard/today.js";
import { createTestDb } from "../helpers.js";

const fill = (id: string, at: string, symbol: string, side: "buy" | "sell", qty: string, price: string) => ({ id, type: "FILL", at: new Date(at), symbol, side, qty, price, raw: {} });
const account = (syncedAt: string, equity: string, lastEquity: string) => ({
  id: 1, accountNumber: "LA1", status: "ACTIVE", cash: "0", equity, lastEquity, longMarketValue: equity, buyingPower: "0", multiplier: "1",
  tradingBlocked: false, accountBlocked: false, config: {}, tradingAllowed: true, syncedAt: new Date(syncedAt),
});
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  // Tuesday Nov 24's close: 1.5 VTI at 350 and 1 ICE at 170 (Alpaca's mark 695.20).
  await db.insert(equitySnapshots).values({ tradingDate: "2026-11-24", equity: "695.20", cash: "0", longMarketValue: "695.20", recordedAt: new Date("2026-11-24T21:00:00Z") });
  await db.insert(positionSnapshots).values([
    { tradingDate: "2026-11-24", symbol: "VTI", qty: "1.5", close: "350", marketValue: "525.00" },
    { tradingDate: "2026-11-24", symbol: "ICE", qty: "1", close: "170", marketValue: "170.00" },
  ]);
  // Wednesday: sells 0.5 VTI at 352, buys 0.1 META at 580 with it (118 in, 58 out, 60 to cash).
  await db.insert(brokerActivities).values([fill("s1", "2026-11-25T15:00:00Z", "VTI", "sell", "0.5", "352"), fill("b1", "2026-11-25T15:15:00Z", "META", "buy", "0.1", "580")]);
  await db.insert(positions).values([
    { symbol: "VTI", qty: "1", avgEntryPrice: "340", marketValue: "353.00", costBasis: "340", currentPrice: "353", syncedAt: new Date("2026-11-25T20:45:00Z") },
    { symbol: "ICE", qty: "1", avgEntryPrice: "170", marketValue: "177.00", costBasis: "170", currentPrice: "177", syncedAt: new Date("2026-11-25T20:45:00Z") },
    { symbol: "META", qty: "0.1", avgEntryPrice: "580", marketValue: "61.00", costBasis: "58", currentPrice: "610", syncedAt: new Date("2026-11-25T20:45:00Z") },
  ]);
});

describe("todayView", () => {
  it("measures each position from the previous close, a sale to its price and a buy from its fill; the parts add up", async () => {
    await db.insert(brokerAccount).values(account("2026-11-25T20:45:00Z", "650.95", "695.20"));
    const t = (await todayView(db))!;
    expect(t).toMatchObject({ session: "2026-11-25", previousSession: "2026-11-24", equity: "650.95" });
    expect(t.positions).toEqual([
      // ICE: 170 → 177: +7. VTI: 525 → 353 + 176 sold: +4. META: bought 58, worth 61: +3.
      { symbol: "ICE", qty: "1", price: "177", previousClose: "170", move: "7.00", movePct: "4.12" },
      { symbol: "VTI", qty: "1", price: "353", previousClose: "350", move: "4.00", movePct: "0.76" },
      { symbol: "META", qty: "0.1", price: "610", previousClose: null, move: "3.00", movePct: "5.17" },
    ]);
    // Alpaca: 650.95 − 695.20 = −44.25 (the 60 of sale proceeds left out of equity here are cash the test leaves at 0).
    expect(new Big(t.move!).minus(t.positions.reduce((s, p) => s.plus(p.move), new Big(0))).toFixed(2)).toBe(t.other);
  });

  it("on a closed day, is the last session, dated, with what happened in it", async () => {
    await db.insert(brokerAccount).values(account("2026-11-25T21:30:00Z", "710.95", "695.20"));
    await db.insert(auditEvents).values([
      { actor: "system", kind: "order.filled", subject: "META", payload: { side: "buy" }, at: new Date("2026-11-25T15:30:00Z") },
      // Not a kind Today shows, and a fill from the session before.
      { actor: "system", kind: "rebalance.planned", payload: {}, at: new Date("2026-11-25T15:00:00Z") },
      { actor: "system", kind: "order.filled", subject: "TTMI", payload: {}, at: new Date("2026-11-24T15:00:00Z") },
    ]);
    const t = (await todayView(db))!;
    expect(t.session).toBe("2026-11-25");
    expect(t.move).toBe("15.75");
    expect(t.events.map((e) => [e.kind, e.symbol])).toEqual([["order.filled", "META"]]);
  });

  it("is empty before the first sync", async () => {
    expect(await todayView(db)).toBeNull();
  });
});

describe("extendedView", () => {
  const rows = (tradingDate: string, session: "pre" | "post", list: [string, string, string][]) =>
    db.insert(extendedPrices).values(list.map(([symbol, price, barAt]) => ({ tradingDate, symbol, session, price, barAt: new Date(barAt) })));

  beforeEach(async () => {
    await db.insert(thesisCloses).values([
      { symbol: "ICE", tradingDate: "2026-11-24", close: "170" },
      { symbol: "ICE", tradingDate: "2026-11-25", close: "177" },
      { symbol: "META", tradingDate: "2026-11-25", close: "610" },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-11-24", close: "350" },
      { symbol: "VTI", tradingDate: "2026-11-25", close: "353" },
    ]);
  });

  it("measures after hours from the session's close, marking a thin trader's old bar", async () => {
    await db.insert(brokerAccount).values(account("2026-11-25T21:30:00Z", "651", "695.20"));
    await rows("2026-11-25", "post", [
      ["ICE", "178.77", "2026-11-25T23:40:00Z"],
      ["VTI", "352.65", "2026-11-25T23:45:00Z"],
      ["META", "615", "2026-11-25T21:10:00Z"],
    ]);
    const x = (await extendedView(db))!;
    expect(x).toMatchObject({ tradingDate: "2026-11-25", session: "post", asOf: "2026-11-25T23:45:00.000Z" });
    expect(x.positions).toEqual([
      { symbol: "ICE", price: "178.77", baseline: "177", move: "1.77", movePct: "1.00", barAt: "2026-11-25T23:40:00.000Z", stale: false },
      { symbol: "META", price: "615", baseline: "610", move: "0.50", movePct: "0.82", barAt: "2026-11-25T21:10:00.000Z", stale: true },
      { symbol: "VTI", price: "352.65", baseline: "353", move: "-0.35", movePct: "-0.10", barAt: "2026-11-25T23:45:00.000Z", stale: false },
    ]);
    expect(x.move).toBe("1.92");
  });

  it("measures pre-market from the close before, and steps aside once the session has synced", async () => {
    await rows("2026-11-25", "pre", [["ICE", "171.70", "2026-11-25T13:00:00Z"]]);
    await db.insert(brokerAccount).values(account("2026-11-25T13:05:00Z", "651", "695.20"));
    expect((await extendedView(db))!.positions[0]).toMatchObject({ symbol: "ICE", baseline: "170", movePct: "1.00" });
    await db.update(brokerAccount).set({ syncedAt: new Date("2026-11-25T14:45:00Z") });
    expect(await extendedView(db)).toBeNull();
  });
});
