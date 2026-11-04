import { describe, expect, it } from "vitest";
import type { ClosedLot } from "../../src/broker/lots.js";
import { type PlanHolding, planTrades, washSaleWindow, withdrawalSells } from "../../src/portfolio/planner.js";
import type { Target } from "../../src/portfolio/targets.js";

const drift = { relativePct: "20", minTradeUsd: "5" };
const t = (symbol: string, dollars: string, sleeve: "conviction" | "systematic" = "systematic"): Target => ({
  symbol,
  sleeve,
  dollars,
  reason: sleeve === "conviction" ? `thesis ${symbol.toLowerCase()}` : `${symbol}: rank 1`,
});
const h = (symbol: string, qty: string, marketValue: string, currentPrice: string): PlanHolding => ({ symbol, qty, marketValue, currentPrice });
const plan = (targets: Target[], holdings: PlanHolding[], extra: Partial<Parameters<typeof planTrades>[0]> = {}) =>
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

describe("raising cash for a withdrawal", () => {
  it("sells a position over target even inside the drift band", () => {
    // $980 target vs $1000 held: $20 over, under the $196 band. A $20 withdrawal needs it sold.
    const holdings = [h("VTI", "3.333333333", "1000", "300")];
    expect(plan([t("VTI", "980")], holdings)).toEqual({ phase: "none", trades: [] });
    const p = plan([t("VTI", "980")], holdings, { raiseCash: "20" });
    expect(p.phase).toBe("sell");
    expect(p.trades[0]?.proposal).toMatchObject({ symbol: "VTI", side: "sell", qty: "0.066666667" });
  });

  it("sells only what the withdrawal needs: the largest gaps first, the last sized to the remainder", () => {
    // Every name drifted a little over target, $40 in all, each inside its band. $50 is needed, so all three go.
    const targets = [t("VTI", "490"), t("XLE", "290"), t("XLB", "190")];
    const drifted = [h("VTI", "1.7", "510", "300"), h("XLE", "3", "300", "100"), h("XLB", "4", "200", "50")];
    const p = plan(targets, drifted, { raiseCash: "50" });
    expect(p.trades.map((x) => [x.proposal.symbol, x.proposal.side === "sell" ? x.proposal.qty : null])).toEqual([
      ["VTI", "0.066666667"], // its $20 gap, the largest
      ["XLE", "0.1"], // $10
      ["XLB", "0.2"], // $10: $40 so far
    ]);
    // Less needed: stop once covered, the last trimmed to the remainder.
    expect(plan(targets, drifted, { raiseCash: "25" }).trades.map((x) => [x.proposal.symbol, x.proposal.side === "sell" ? x.proposal.qty : null])).toEqual([
      ["VTI", "0.066666667"],
      ["XLE", "0.049999999"], // the first sell's round-up already covered a fraction of a cent
    ]);
  });

  it("counts sells the drift band already wants toward the amount", () => {
    // VTI is $300 over (outside its band) and sells anyway; that covers the $50.
    const p = plan([t("VTI", "700"), t("XLE", "290")], [h("VTI", "3.333333333", "1000", "300"), h("XLE", "3", "300", "100")], { raiseCash: "50" });
    expect(p.trades.map((x) => x.proposal.symbol)).toEqual(["VTI"]);
  });

  it("still leaves buys under target to the band, and skips sells under $1", () => {
    const p = plan([t("VTI", "999.50"), t("AAPL", "300")], [h("VTI", "3.333333333", "1000", "300"), h("AAPL", "1", "290", "290")], { raiseCash: "20" });
    expect(p).toEqual({ phase: "none", trades: [] });
  });
});

describe("planTrades: funding conviction buys in a fully invested account", () => {
  // $1000, all invested. A new 5% thesis moves $50 out of the others, each
  // only $15–20 over target: inside its band, so without funding it never sells.
  const targets = [t("BA", "50", "conviction"), t("VTI", "480"), t("XLF", "285"), t("XLK", "185")];
  const holdings = [h("VTI", "1", "500", "500"), h("XLF", "3", "300", "100"), h("XLK", "2", "200", "100")];
  const sold = (p: ReturnType<typeof planTrades>) => p.trades.map((x) => [x.proposal.symbol, x.proposal.side === "sell" ? x.proposal.qty : null]);

  it("sells what's over target, largest gap first, to cover what cash can't", () => {
    const p = plan(targets, holdings, { spendableCash: "0.05" });
    expect(p.phase).toBe("sell");
    // Needs $49.95: VTI's $20, XLF's $15, then $14.95 of XLK.
    expect(sold(p)).toEqual([["VTI", "0.04"], ["XLF", "0.15"], ["XLK", "0.1495"]]);
    expect(p.trades[0]?.reason).toBe("VTI is $20 over its $480 target; selling $20 of it to raise cash for the conviction buys");
  });

  it("buys straight away when the spare cash covers it", () => {
    expect(plan(targets, holdings, { spendableCash: "60" })).toMatchObject({ phase: "buy", trades: [{ proposal: { symbol: "BA", notional: "50" } }] });
  });

  it("keeps the old behaviour without spendableCash (no funding sells)", () => {
    expect(plan(targets, holdings).phase).toBe("buy");
  });
});

describe("planTrades: same-day round-trip guard", () => {
  it("skips a funding source bought today and moves on to the next", () => {
    const targets = [t("BA", "50", "conviction"), t("VTI", "480"), t("XLF", "285"), t("XLK", "185")];
    const holdings = [h("VTI", "1", "500", "500"), h("XLF", "3", "300", "100"), h("XLK", "2", "200", "100")];
    const p = plan(targets, holdings, { spendableCash: "0", blocked: { sell: new Set(["VTI"]), buy: new Set() } });
    expect(p.trades.map((x) => x.proposal.symbol)).toEqual(["XLF", "XLK"]);
  });

  it("holds an exit of something bought today until tomorrow, with a note, and plans the rest", () => {
    const p = plan([t("VTI", "300")], [h("VTI", "1", "300", "300"), h("TTMI", "1", "50", "50")], {
      exitReasons: { TTMI: "thesis ttmi-x stopped out" },
      blocked: { sell: new Set(["TTMI"]), buy: new Set() },
    });
    expect(p).toEqual({ phase: "none", trades: [], deferred: ["TTMI: sell waits until tomorrow (it was bought today, and same-day round trips are off)"] });
  });

  it("holds a buy back of something sold today", () => {
    const p = plan([t("XLE", "100")], [], { blocked: { sell: new Set(), buy: new Set(["XLE"]) } });
    expect(p).toMatchObject({ phase: "none", deferred: ["XLE: buy waits until tomorrow (it was sold today, and same-day round trips are off)"] });
  });
});

describe("withdrawalSells (halted: only what the withdrawal needs)", () => {
  const holdings = [h("VTI", "3", "900", "300"), h("AAPL", "2", "400", "200")];
  const sells = plan([t("VTI", "500")], holdings).trades;

  it("takes sells in plan order until they cover the amount, sizing the last to the remainder", () => {
    // The plan sells all of AAPL ($400) and $400 of VTI; $300 is needed.
    const chosen = withdrawalSells(sells, holdings, "300");
    expect(chosen.map((x) => [x.proposal.symbol, x.proposal.side === "sell" ? x.proposal.qty : null, x.proposal.purpose])).toEqual([["AAPL", "1.5", "withdrawal"]]);
    const more = withdrawalSells(sells, holdings, "500");
    expect(more.map((x) => [x.proposal.symbol, x.proposal.side === "sell" ? x.proposal.qty : null])).toEqual([["AAPL", "2"], ["VTI", "0.333333334"]]);
  });

  it("ignores buys and returns nothing when nothing is owed", () => {
    expect(withdrawalSells(plan([t("VTI", "990")], []).trades, [], "300")).toEqual([]);
    expect(withdrawalSells(sells, holdings, "0")).toEqual([]);
  });
});

describe("investing idle cash (a deposit, a cancelled withdrawal)", () => {
  // $1000 of VTI and a $100 deposit: the VTI target is $1100, $100 under, inside the $220 band.
  const holdings = [h("VTI", "3.333333333", "1000", "300")];

  it("buys a position under target even inside the drift band", () => {
    expect(plan([t("VTI", "1100")], holdings)).toEqual({ phase: "none", trades: [] });
    expect(plan([t("VTI", "1100")], holdings, { deployCash: true }).trades.map((x) => x.proposal)).toMatchObject([{ symbol: "VTI", side: "buy", notional: "100" }]);
  });

  it("still leaves sells to the band, and skips buys under $1", () => {
    const p = plan([t("VTI", "1000.50"), t("AAPL", "250")], [...holdings, h("AAPL", "1", "290", "290")], { deployCash: true });
    expect(p).toEqual({ phase: "none", trades: [] });
  });
});
