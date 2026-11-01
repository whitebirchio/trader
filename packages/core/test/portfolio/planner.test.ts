import { describe, expect, it } from "vitest";
import type { ClosedLot } from "../../src/broker/lots.js";
import { type Holding, planTrades, washSaleWindow } from "../../src/portfolio/planner.js";
import type { Target } from "../../src/portfolio/targets.js";

const drift = { relativePct: "20", minTradeUsd: "5" };
const t = (symbol: string, dollars: string, sleeve: "conviction" | "systematic" = "systematic"): Target => ({
  symbol,
  sleeve,
  dollars,
  reason: sleeve === "conviction" ? `thesis ${symbol.toLowerCase()}` : `${symbol}: rank 1`,
});
const h = (symbol: string, qty: string, marketValue: string, currentPrice: string): Holding => ({ symbol, qty, marketValue, currentPrice });
const plan = (targets: Target[], holdings: Holding[], extra: Partial<Parameters<typeof planTrades>[0]> = {}) =>
  planTrades({ planId: "p1", targets, holdings, drift, ...extra });

describe("planTrades", () => {
  it("does nothing when holdings are within the drift threshold", () => {
    // $990 target, $850 held: $140 under, but the threshold is max(20% × 990, $5) = $198.
    expect(plan([t("VTI", "990")], [h("VTI", "2.8", "850", "303.57")])).toEqual({ phase: "none", trades: [] });
  });

  it("buys a new position from cash (version 0 from $1000)", () => {
    const p = plan([t("VTI", "990")], []);
    expect(p.phase).toBe("buy");
    expect(p.trades).toEqual([
      {
        proposal: { key: "p1:VTI:buy", symbol: "VTI", side: "buy", sleeve: "systematic", notional: "990" },
        reason: "new position: VTI: rank 1",
      },
    ]);
  });

  it("tops up a drifted position by the gap", () => {
    const p = plan([t("VTI", "990")], [h("VTI", "2", "600", "300")]);
    expect(p.trades[0]?.proposal).toMatchObject({ side: "buy", notional: "390" });
    expect(p.trades[0]?.reason).toBe("VTI is $390 under its $990 target (VTI: rank 1)");
  });

  it("sells first: exits and trims go out alone, and buys wait for a later step", () => {
    const p = plan(
      [t("AAPL", "200", "conviction"), t("VTI", "300")],
      [h("VTI", "3", "900", "300"), h("XYZ", "1.5", "45", "30")],
      { exitReasons: { XYZ: "thesis xyz-turnaround stopped out" } },
    );
    expect(p.phase).toBe("sell");
    expect(p.trades.map((x) => [x.proposal.symbol, x.proposal.side, "qty" in x.proposal ? x.proposal.qty : null, x.reason])).toEqual([
      ["XYZ", "sell", "1.5", "thesis xyz-turnaround stopped out"],
      ["VTI", "sell", "2", "VTI is $600 over its $300 target (VTI: rank 1)"],
    ]);
  });

  it("then buys, conviction first and largest first, once the sells are done", () => {
    const p = plan([t("VTI", "500"), t("QQQ", "150"), t("AAPL", "100", "conviction"), t("MSFT", "200", "conviction")], []);
    expect(p.phase).toBe("buy");
    expect(p.trades.map((x) => x.proposal.symbol)).toEqual(["MSFT", "AAPL", "VTI", "QQQ"]);
  });

  it("never sells more than is held, and skips dust", () => {
    const over = plan([t("VTI", "10")], [h("VTI", "0.5", "150", "300")], { drift: { relativePct: "1", minTradeUsd: "1" } });
    expect(over.trades[0]?.proposal).toMatchObject({ side: "sell", qty: "0.466666666" });
    const tiny = plan([t("VTI", "100")], [h("VTI", "0.34", "103", "303")]);
    expect(tiny.phase).toBe("none");
  });

  it("uses the minimum trade size for small targets", () => {
    // $20 target, $16 held: $4 gap < $5 minimum → no trade, even though 20% × $20 = $4.
    expect(plan([t("SGOV", "20")], [h("SGOV", "0.16", "16", "100")]).phase).toBe("none");
  });

  it("attributes exits to their sleeve", () => {
    const p = plan([], [h("AAPL", "1", "230", "230")], { sleeveOf: () => "conviction" });
    expect(p.trades[0]?.proposal).toMatchObject({ sleeve: "conviction", qty: "1" });
  });
});

describe("washSaleWindow", () => {
  const now = new Date("2026-11-30T15:00:00Z");
  const closed = (symbol: string, gain: string, daysAgo: number): ClosedLot => ({
    symbol,
    qty: "1",
    costBasis: "100",
    proceeds: "90",
    gain,
    openedAt: new Date("2026-01-01T00:00:00Z"),
    closedAt: new Date(now.getTime() - daysAgo * 86_400_000),
  });

  it("holds symbols sold at a loss within 30 days, not gains or older losses", () => {
    expect(washSaleWindow([closed("AAA", "-10", 5), closed("BBB", "12", 5), closed("CCC", "-3", 31), closed("DDD", "-1", 30)], now)).toEqual(
      new Set(["AAA", "DDD"]),
    );
  });
});
