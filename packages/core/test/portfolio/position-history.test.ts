import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { brokerActivities, equitySnapshots, positionSnapshots } from "../../src/db/schema.js";
import { CLOSE_FINAL_AFTER_MS, dayValues, holdingsAt, missingDays, recordPositionHistory } from "../../src/portfolio/position-history.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";

const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: "1000" });
const close = (date: string) => new Date(`${date}T21:00:00Z`); // 4:00 PM ET in November
const fill = (id: string, at: string, symbol: string, side: "buy" | "sell", qty: string, price: string) => ({ id, type: "FILL", at: new Date(at), symbol, side, qty, price, raw: {} });

let db: Db;
let broker: FakeBroker;

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  await db.insert(brokerActivities).values([
    { id: "dep", type: "CSD", at: new Date("2026-11-02T14:00:00Z"), netAmount: "1000", raw: {} },
    fill("f1", "2026-11-02T15:00:00Z", "VTI", "buy", "2", "300"),
    fill("f2", "2026-11-02T15:05:00Z", "ICE", "buy", "1.5", "170"),
    // A partial sale the next day, and a full sale of ICE the day after.
    fill("f3", "2026-11-03T15:00:00Z", "VTI", "sell", "0.5", "302"),
    fill("f4", "2026-11-04T15:00:00Z", "ICE", "sell", "1.5", "175"),
  ]);
  await db.insert(equitySnapshots).values([
    { tradingDate: "2026-11-02", equity: "1003.20", cash: "145.00", longMarketValue: "858.20", recordedAt: close("2026-11-02") },
    { tradingDate: "2026-11-03", equity: "1011.10", cash: "296.00", longMarketValue: "715.10", recordedAt: close("2026-11-03") },
    { tradingDate: "2026-11-04", equity: "1018.50", cash: "558.50", longMarketValue: "460.00", recordedAt: close("2026-11-04") },
  ]);
  // Raw closes (as traded) differ from the adjusted ones: the adjusted must never be used.
  broker.bars = { VTI: [bar("2026-11-02", "1"), bar("2026-11-03", "1"), bar("2026-11-04", "1")], ICE: [bar("2026-11-02", "1"), bar("2026-11-03", "1")] };
  broker.rawBars = {
    VTI: [bar("2026-11-02", "301.10"), bar("2026-11-03", "303.40"), bar("2026-11-04", "306.00")],
    ICE: [bar("2026-11-02", "170.80"), bar("2026-11-03", "172.00"), bar("2026-11-04", "176.00")],
  };
});

describe("holdingsAt", () => {
  it("sums buys and sells up to the cutoff, leaving closed positions out", () => {
    const fills = [
      { symbol: "VTI", side: "buy", qty: "2", at: new Date("2026-11-02T15:00:00Z") },
      { symbol: "VTI", side: "sell", qty: "0.5", at: new Date("2026-11-03T15:00:00Z") },
      { symbol: "ICE", side: "buy", qty: "1.5", at: new Date("2026-11-02T15:00:00Z") },
      { symbol: "ICE", side: "sell", qty: "1.5", at: new Date("2026-11-04T15:00:00Z") },
    ];
    expect(holdingsAt(fills, close("2026-11-02"))).toEqual(new Map([["VTI", "2"], ["ICE", "1.5"]]));
    expect(holdingsAt(fills, close("2026-11-04"))).toEqual(new Map([["VTI", "1.5"]]));
  });
});

describe("recordPositionHistory", () => {
  it("backfills every completed session at the raw close on its first run, then writes nothing", async () => {
    const now = new Date("2026-11-05T14:00:00Z");
    expect(await recordPositionHistory(db, broker, now)).toEqual({ days: 3, rows: 5, waiting: [], gaps: [] });
    const rows = await db.select().from(positionSnapshots);
    expect(rows.map((r) => [r.tradingDate, r.symbol, r.qty, r.close, r.marketValue]).sort()).toEqual([
      ["2026-11-02", "ICE", "1.5", "170.80", "256.20"],
      ["2026-11-02", "VTI", "2", "301.10", "602.20"],
      ["2026-11-03", "ICE", "1.5", "172.00", "258.00"],
      ["2026-11-03", "VTI", "1.5", "303.40", "455.10"],
      ["2026-11-04", "VTI", "1.5", "306.00", "459.00"],
    ]);
    expect(await recordPositionHistory(db, broker, now)).toEqual({ days: 0, rows: 0, waiting: [], gaps: [] });
  });

  it("waits until a session's close is final", async () => {
    const soon = new Date(close("2026-11-04").getTime() + CLOSE_FINAL_AFTER_MS - 60_000);
    expect((await missingDays(db, soon)).map((d) => d.tradingDate)).toEqual(["2026-11-02", "2026-11-03"]);
  });

  it("retries a day whose bar is missing, then writes it as a gap once it's old", async () => {
    broker.rawBars = { ...broker.rawBars!, ICE: [bar("2026-11-02", "170.80")] };
    expect(await recordPositionHistory(db, broker, new Date("2026-11-05T14:00:00Z"))).toMatchObject({ days: 2, waiting: ["2026-11-03"], gaps: [] });
    expect(await recordPositionHistory(db, broker, new Date("2026-11-09T14:00:00Z"))).toMatchObject({ days: 1, waiting: [], gaps: ["2026-11-03 ICE"] });
    const gap = (await db.select().from(positionSnapshots)).find((r) => r.tradingDate === "2026-11-03" && r.symbol === "ICE");
    expect(gap).toMatchObject({ qty: "1.5", close: null, marketValue: null });
  });
});

describe("dayValues", () => {
  it("splits each day's equity into cash, positions at the close, and the after-close pricing that reconciles them", async () => {
    await recordPositionHistory(db, broker, new Date("2026-11-05T14:00:00Z"));
    expect(await dayValues(db)).toEqual([
      // Alpaca's mark (858.20) against the official close (858.40): -0.20 after the close.
      { tradingDate: "2026-11-02", equity: "1003.20", cash: "145.00", positions: "858.40", afterClosePricing: "-0.20" },
      { tradingDate: "2026-11-03", equity: "1011.10", cash: "296.00", positions: "713.10", afterClosePricing: "2.00" },
      { tradingDate: "2026-11-04", equity: "1018.50", cash: "558.50", positions: "459.00", afterClosePricing: "1.00" },
    ]);
  });

  it("leaves positions unknown for a day not written yet, or with a gap", async () => {
    expect((await dayValues(db, ["2026-11-02"]))[0]).toMatchObject({ positions: null, afterClosePricing: null });
  });
});
