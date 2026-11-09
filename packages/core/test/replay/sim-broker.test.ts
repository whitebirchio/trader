import { describe, expect, it } from "vitest";
import type { Bar, CalendarDay } from "../../src/broker/port.js";
import { SimBroker, type SimMarket } from "../../src/replay/sim-broker.js";

const session = (date: string): CalendarDay => ({ date, open: new Date(`${date}T14:30:00Z`), close: new Date(`${date}T21:00:00Z`) });
const bar = (date: string, o: string, c: string, v = "1000"): Bar => ({ t: new Date(`${date}T05:00:00Z`), o, h: c, l: o, c, v });
const at = (iso: string) => new Date(iso);

const market = (): SimMarket => ({
  bars: { VTI: [bar("2026-11-02", "100", "101"), bar("2026-11-03", "102", "103"), bar("2026-11-04", "104", "105")] },
  calendar: [session("2026-11-02"), session("2026-11-03"), session("2026-11-04")],
  assets: { VTI: { symbol: "VTI", name: "Vanguard Total Stock Market ETF", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" } },
});

const sim = (now: string, cash = "10000") => new SimBroker(market(), { cash, now: at(now) });

describe("SimBroker: no lookahead", () => {
  it("shows yesterday's close before the open, today's open as a partial bar during the session, and the full bar after the close", async () => {
    const b = sim("2026-11-03T13:00:00Z");
    expect((await b.getDailyBars(["VTI"], at("2026-11-01T00:00:00Z"), b.now)).VTI!.map((x) => x.c)).toEqual(["101"]);
    expect(b.priceNow("VTI")).toBe("101");

    b.setNow(at("2026-11-03T15:00:00Z"));
    const during = (await b.getDailyBars(["VTI"], at("2026-11-01T00:00:00Z"), b.now)).VTI!;
    expect(during.map((x) => [x.o, x.h, x.l, x.c, x.v])).toEqual([["100", "101", "100", "101", "1000"], ["102", "102", "102", "102", "0"]]);
    expect(b.priceNow("VTI")).toBe("102");

    b.setNow(at("2026-11-03T21:30:00Z"));
    expect((await b.getDailyBars(["VTI"], at("2026-11-01T00:00:00Z"), b.now)).VTI!.map((x) => x.c)).toEqual(["101", "103"]);
    expect(b.priceNow("VTI")).toBe("103");
  });

  it("never returns a bar after now, whatever end is asked for", async () => {
    const b = sim("2026-11-03T15:00:00Z");
    const bars = (await b.getDailyBars(["VTI"], at("2026-11-01T00:00:00Z"), at("2030-01-01T00:00:00Z"))).VTI!;
    expect(bars.map((x) => x.t.toISOString().slice(0, 10))).toEqual(["2026-11-02", "2026-11-03"]);
  });
});

describe("SimBroker: orders", () => {
  it("fills a buy during the session at the open plus slippage, and marks the account to the price", async () => {
    const b = sim("2026-11-03T15:00:00Z");
    const order = await b.submitOrder({ symbol: "VTI", side: "buy", clientOrderId: "c1", notional: "1000" });
    expect(order).toMatchObject({ status: "filled", filledAvgPrice: "102.102" }); // 102 × (1 + 0.0010)
    const [position] = await b.getPositions();
    expect(position).toMatchObject({ symbol: "VTI", qty: "9.794127441", currentPrice: "102", costBasis: "1000" });
    expect(await b.getAccount()).toMatchObject({ cash: "9000", equity: "9999", lastEquity: "9989.21" });
    const [fill] = await b.getActivities();
    expect(fill).toMatchObject({ type: "FILL", side: "buy", qty: "9.794127441", price: "102.102", at: at("2026-11-03T15:00:00Z") });
  });

  it("fills an order placed after the close at the next session's open, once the clock gets there", async () => {
    const b = sim("2026-11-03T15:00:00Z");
    await b.submitOrder({ symbol: "VTI", side: "buy", clientOrderId: "c1", notional: "1000" });
    b.setNow(at("2026-11-03T21:30:00Z"));
    const sell = await b.submitOrder({ symbol: "VTI", side: "sell", clientOrderId: "c2", qty: "5" });
    expect(sell.status).toBe("accepted");
    b.setNow(at("2026-11-04T14:45:00Z"));
    expect(await b.getOrderByClientId("c2")).toMatchObject({ status: "filled", filledAvgPrice: "103.896", updatedAt: at("2026-11-04T14:30:00Z") }); // 104 × (1 − 0.0010)
    expect((await b.getAccount()).cash).toBe("9519.48"); // 9000 + 5 × 103.896, rounded down to the cent
  });

  it("refuses what Alpaca would: selling more than held, buying with more than the cash, a reused client id", async () => {
    const b = sim("2026-11-03T15:00:00Z", "500");
    expect(await b.submitOrder({ symbol: "VTI", side: "buy", clientOrderId: "c1", notional: "600" })).toMatchObject({ status: "rejected" });
    expect(await b.submitOrder({ symbol: "VTI", side: "sell", clientOrderId: "c2", qty: "1" })).toMatchObject({ status: "rejected" });
    await expect(b.submitOrder({ symbol: "VTI", side: "sell", clientOrderId: "c2", qty: "1" })).rejects.toThrow(/client_order_id must be unique/);
    expect(await b.getPositions()).toEqual([]);
    expect((await b.getAccount()).cash).toBe("500");
  });
});

describe("SimBroker: account", () => {
  it("records a deposit as a CSD activity the ledger can book", async () => {
    const b = sim("2026-11-03T15:00:00Z", "0");
    b.deposit("1000");
    expect((await b.getAccount()).cash).toBe("1000");
    expect(await b.getActivities()).toMatchObject([{ type: "CSD", netAmount: "1000", raw: { status: "executed", created_at: "2026-11-03T15:00:00.000Z" } }]);
  });

  it("reports the clock from the calendar", async () => {
    const b = sim("2026-11-03T15:00:00Z");
    expect(await b.getClock()).toMatchObject({ isOpen: true, nextClose: at("2026-11-03T21:00:00Z"), nextOpen: at("2026-11-04T14:30:00Z") });
    b.setNow(at("2026-11-03T22:00:00Z"));
    expect(await b.getClock()).toMatchObject({ isOpen: false, nextOpen: at("2026-11-04T14:30:00Z") });
  });
});
