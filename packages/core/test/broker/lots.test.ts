import { describe, expect, it } from "vitest";
import { buildLots } from "../../src/broker/lots.js";
import { add } from "../../src/money.js";
import type { Activity } from "../../src/broker/port.js";

let seq = 0;
function fill(symbol: string, side: "buy" | "sell", qty: string, price: string, at: string): Activity {
  seq++;
  return {
    id: `fill-${String(seq).padStart(3, "0")}`,
    type: "FILL",
    at: new Date(at),
    symbol,
    side,
    qty,
    price,
    netAmount: null,
    orderId: `order-${seq}`,
    raw: {},
  };
}

describe("buildLots (FIFO)", () => {
  it("treats each fill, including partial fills, as its own lot", () => {
    const { open, closed, issues } = buildLots([
      fill("VTI", "buy", "0.01", "300", "2026-11-02T14:35:00Z"),
      fill("VTI", "buy", "0.006339869", "300.02", "2026-11-02T14:35:01Z"),
    ]);
    expect(issues).toEqual([]);
    expect(closed).toEqual([]);
    expect(open.map((l) => [l.qty, l.costBasis])).toEqual([
      ["0.01", "3"],
      ["0.006339869", "1.90208749738"],
    ]);
    expect(open[0]?.openedAt.toISOString()).toBe("2026-11-02T14:35:00.000Z");
  });

  it("sells the oldest shares first and splits a lot exactly", () => {
    const { open, closed } = buildLots([
      fill("VTI", "buy", "2", "100", "2026-01-05T15:00:00Z"),
      fill("VTI", "buy", "1", "110", "2026-02-05T15:00:00Z"),
      fill("VTI", "sell", "2.5", "120", "2026-03-05T15:00:00Z"),
    ]);
    expect(closed).toEqual([
      expect.objectContaining({ qty: "2", costBasis: "200", proceeds: "240", gain: "40" }),
      expect.objectContaining({ qty: "0.5", costBasis: "55", proceeds: "60", gain: "5" }),
    ]);
    expect(closed[1]?.openedAt.toISOString()).toBe("2026-02-05T15:00:00.000Z");
    expect(closed[1]?.closedAt.toISOString()).toBe("2026-03-05T15:00:00.000Z");
    expect(open).toEqual([expect.objectContaining({ symbol: "VTI", qty: "0.5", costBasis: "55" })]);
  });

  it("keeps cost basis exact across uneven partial sells", () => {
    const { open, closed } = buildLots([
      fill("XYZ", "buy", "3", "10", "2026-01-05T15:00:00Z"), // $30 basis, $10/share
      fill("XYZ", "sell", "1", "11", "2026-01-06T15:00:00Z"),
      fill("XYZ", "sell", "1", "11", "2026-01-07T15:00:00Z"),
      fill("XYZ", "sell", "1", "11", "2026-01-08T15:00:00Z"),
    ]);
    expect(open).toEqual([]);
    expect(closed.reduce((sum, c) => add(sum, c.costBasis), "0")).toBe("30");
  });

  it("closes a position completely", () => {
    const { open, closed } = buildLots([
      fill("VTI", "buy", "0.5", "300", "2026-01-05T15:00:00Z"),
      fill("VTI", "sell", "0.5", "290", "2026-01-20T15:00:00Z"),
    ]);
    expect(open).toEqual([]);
    expect(closed).toEqual([expect.objectContaining({ qty: "0.5", gain: "-5" })]);
  });

  it("keeps both the loss and the rebuy, with dates, for wash-sale checks (ADR-010)", () => {
    const { open, closed } = buildLots([
      fill("QQQ", "buy", "1", "500", "2026-01-05T15:00:00Z"),
      fill("QQQ", "sell", "1", "450", "2026-02-02T15:00:00Z"),
      fill("QQQ", "buy", "1", "460", "2026-02-20T15:00:00Z"), // 18 days later
    ]);
    expect(closed).toEqual([
      expect.objectContaining({ symbol: "QQQ", gain: "-50", closedAt: new Date("2026-02-02T15:00:00Z") }),
    ]);
    expect(open).toEqual([
      expect.objectContaining({ symbol: "QQQ", qty: "1", openedAt: new Date("2026-02-20T15:00:00Z") }),
    ]);
  });

  it("orders fills by time even when given out of order", () => {
    const sell = fill("VTI", "sell", "1", "120", "2026-03-05T15:00:00Z");
    const buy = fill("VTI", "buy", "1", "100", "2026-01-05T15:00:00Z");
    expect(buildLots([sell, buy]).issues).toEqual([]);
  });

  it("flags a sell with no shares to cover it instead of inventing a short", () => {
    const { issues, closed } = buildLots([fill("VTI", "sell", "1", "100", "2026-01-05T15:00:00Z")]);
    expect(closed).toEqual([]);
    expect(issues).toEqual([{ symbol: "VTI", reason: "sell exceeds known lots by 1 shares" }]);
  });

  it("flags corporate actions it cannot model (e.g. a stock split) rather than guessing", () => {
    const split: Activity = {
      id: "ssp-1",
      type: "SSP",
      at: new Date("2026-03-01T00:00:00Z"),
      symbol: "VTI",
      side: null,
      qty: "1",
      price: null,
      netAmount: null,
      orderId: null,
      raw: {},
    };
    const { issues } = buildLots([fill("VTI", "buy", "1", "100", "2026-01-05T15:00:00Z"), split]);
    expect(issues).toEqual([{ symbol: "VTI", reason: "unsupported share-affecting activity SSP" }]);
  });

  it("ignores cash-only activities", () => {
    const div: Activity = {
      id: "div-1",
      type: "DIV",
      at: new Date("2026-03-01T00:00:00Z"),
      symbol: "VTI",
      side: null,
      qty: null,
      price: "0.9",
      netAmount: "0.45",
      orderId: null,
      raw: {},
    };
    expect(buildLots([div])).toEqual({ open: [], closed: [], issues: [] });
  });
});

describe("openQtyBySymbol", () => {
  it("sums open lots per symbol exactly", async () => {
    const { openQtyBySymbol } = await import("../../src/broker/lots.js");
    const { open } = buildLots([
      fill("VTI", "buy", "0.1", "300", "2026-01-05T15:00:00Z"),
      fill("VTI", "buy", "0.2", "300", "2026-01-06T15:00:00Z"),
      fill("SPY", "buy", "1", "700", "2026-01-06T15:00:00Z"),
    ]);
    expect(Object.fromEntries(openQtyBySymbol(open))).toEqual({ VTI: "0.3", SPY: "1" });
  });
});
