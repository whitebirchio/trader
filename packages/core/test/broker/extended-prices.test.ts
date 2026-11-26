import { beforeEach, describe, expect, it } from "vitest";
import { extendedSession, recordExtendedPrices } from "../../src/broker/extended-prices.js";
import type { Bar, CalendarDay } from "../../src/broker/port.js";
import type { Db } from "../../src/db/client.js";
import { equitySnapshots, extendedPrices, orders, positions, riskState } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";
import { FakeBroker } from "./fake-broker.js";

const et = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`); // November: ET is UTC−5
const day = (date: string, close = "16:00", sessionClose = "20:00"): CalendarDay => ({
  date,
  open: et(date, "09:30"),
  close: et(date, close),
  sessionOpen: et(date, "04:00"),
  sessionClose: et(date, sessionClose),
});
const bar = (t: Date, c: string): Bar => ({ t, o: c, h: c, l: c, c, v: "10" });
let db: Db;
let broker: FakeBroker;

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  broker.calendar = [day("2026-11-25"), day("2026-11-27", "13:00", "17:00")];
  await db.insert(positions).values([
    { symbol: "ICE", qty: "1", avgEntryPrice: "170", marketValue: "177", costBasis: "170", currentPrice: "177", syncedAt: et("2026-11-25", "16:15") },
    { symbol: "LSTR", qty: "1", avgEntryPrice: "150", marketValue: "152", costBasis: "150", currentPrice: "152", syncedAt: et("2026-11-25", "16:15") },
  ]);
});

describe("extendedSession", () => {
  it("is pre-market before the open and after hours from the close, as the delayed data sees it", () => {
    const d = day("2026-11-25");
    expect(extendedSession(d, et("2026-11-25", "04:10"))).toBeNull(); // the data is still before 4:00
    expect(extendedSession(d, et("2026-11-25", "08:00"))).toMatchObject({ session: "pre" });
    expect(extendedSession(d, et("2026-11-25", "09:40"))).toMatchObject({ session: "pre" }); // data at 9:24
    expect(extendedSession(d, et("2026-11-25", "12:00"))).toBeNull();
    expect(extendedSession(d, et("2026-11-25", "18:00"))).toMatchObject({ session: "post" });
    expect(extendedSession(d, et("2026-11-25", "20:15"))).toMatchObject({ session: "post" }); // the last bars, delayed
    expect(extendedSession(d, et("2026-11-25", "20:30"))).toBeNull();
  });

  it("follows a half day's earlier close and session end", () => {
    const half = day("2026-11-27", "13:00", "17:00");
    expect(extendedSession(half, et("2026-11-27", "14:00"))).toMatchObject({ session: "post" });
    expect(extendedSession(half, et("2026-11-27", "18:00"))).toBeNull();
  });
});

describe("recordExtendedPrices", () => {
  it("keeps each symbol's latest bar in the session, updating it as the session moves on", async () => {
    broker.now = et("2026-11-25", "18:00");
    broker.minuteBars = {
      ICE: [bar(et("2026-11-25", "15:59"), "177"), bar(et("2026-11-25", "16:05"), "177.40"), bar(et("2026-11-25", "17:30"), "177.90")],
      VTI: [bar(et("2026-11-25", "16:01"), "353.30")],
      // LSTR didn't trade after hours: no row, not zero.
    };
    expect(await recordExtendedPrices(db, broker, et("2026-11-25", "18:00"))).toEqual({ status: "recorded", session: "post", symbols: 3, written: 2 });
    broker.minuteBars.ICE!.push(bar(et("2026-11-25", "19:00"), "178.10"));
    await recordExtendedPrices(db, broker, et("2026-11-25", "19:20"));
    const rows = await db.select().from(extendedPrices);
    expect(rows.map((r) => [r.symbol, r.session, r.price, r.barAt.toISOString()]).sort()).toEqual([
      ["ICE", "post", "178.10", et("2026-11-25", "19:00").toISOString()],
      ["VTI", "post", "353.30", et("2026-11-25", "16:01").toISOString()],
    ]);
  });

  it("skips outside the extended sessions and on closed days, and touches nothing that trades", async () => {
    expect(await recordExtendedPrices(db, broker, et("2026-11-25", "12:00"))).toMatchObject({ status: "skipped" });
    expect(await recordExtendedPrices(db, broker, et("2026-11-26", "18:00"))).toEqual({ status: "skipped", reason: "not a trading day" });
    broker.minuteBars = { ICE: [bar(et("2026-11-25", "08:00"), "176")] };
    await recordExtendedPrices(db, broker, et("2026-11-25", "08:30"));
    expect(broker.calls.submitOrder ?? 0).toBe(0);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(equitySnapshots)).toEqual([]);
    expect((await db.select().from(riskState))[0]).toMatchObject({ halted: false, killSwitch: false });
  });
});
