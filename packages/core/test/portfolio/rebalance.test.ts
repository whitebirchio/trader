import { desc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, capitalCommands, orders, rebalancePlans, strategies, thesisEvents, withdrawals } from "../../src/db/schema.js";
import { add, compare, div, mul, sub } from "../../src/money.js";
import { type RebalanceOptions, runRebalance } from "../../src/portfolio/rebalance.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { LIMITS, type Limits } from "../../src/risk/limits.js";
import { latchHalt, setKillSwitch } from "../../src/risk/state.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "./fixtures.js";

let db: Db;
let broker: FakeBroker;
let clock: Date;
const MONDAY_1035_ET = new Date("2026-11-02T15:35:00Z");

function bars(price: string, days = 300): Bar[] {
  return Array.from({ length: days }, (_, i) => ({ t: new Date(MONDAY_1035_ET.getTime() - (days - i) * 86_400_000), o: price, h: price, l: price, c: price, v: "1000000" }));
}

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  clock = MONDAY_1035_ET;
  broker.now = clock;
  broker.assets.push({ symbol: "AAPL", name: "Apple Inc. Common Stock", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });
  broker.bars = { VTI: bars("300"), AAPL: bars("200") };
  await sync();
});

async function sync() {
  broker.now = clock;
  await syncBroker(db, broker, "staging", clock);
}

/** Fill every open order at `prices`, as Alpaca would, and update cash and positions. */
async function fillAll(prices: Record<string, string>) {
  for (const o of broker.orders.filter((x) => x.status === "accepted")) {
    const price = prices[o.symbol]!;
    const qty = o.qty ?? div(o.notional!, price, 9, "down");
    o.status = "filled";
    o.filledQty = qty;
    o.filledAvgPrice = price;
    o.updatedAt = clock;
    broker.fill(o.id, o.symbol, o.side, qty, price, clock);
    const value = mul(qty, price);
    broker.account.cash = o.side === "buy" ? sub(broker.account.cash, value) : add(broker.account.cash, value);
    const pos = broker.positions.find((p) => p.symbol === o.symbol);
    const newQty = pos ? (o.side === "buy" ? add(pos.qty, qty) : sub(pos.qty, qty)) : qty;
    broker.positions = broker.positions.filter((p) => p.symbol !== o.symbol);
    if (compare(newQty, "0") > 0) {
      broker.positions.push({ symbol: o.symbol, qty: newQty, avgEntryPrice: price, marketValue: mul(newQty, price), costBasis: mul(newQty, price), currentPrice: price });
    }
  }
  broker.account.equity = broker.positions.reduce((s, p) => add(s, p.marketValue), broker.account.cash);
  clock = new Date(clock.getTime() + 15 * 60_000);
  await sync();
}

// These scenarios compress several trading days into one simulated day, so they
// allow same-day round trips; the guard has its own test below, on LIMITS.
const COMPRESSED_DAYS: Limits = { ...LIMITS, sameDayRoundTrips: true };
const step = (opts: RebalanceOptions = {}) => runRebalance(db, broker, "staging", clock, { limits: COMPRESSED_DAYS, ...opts });
const kinds = async () => (await db.select().from(auditEvents)).map((e) => e.kind);

describe("rebalance", () => {
  it("version 0: buys VTI with all the cash, waits for the fill, then rests on target", async () => {
    const first = await step();
    expect(first).toMatchObject({ status: "planned", phase: "buy", strategyVersion: 0 });
    expect(broker.orders.map((o) => [o.symbol, o.side, o.notional])).toEqual([["VTI", "buy", "1000"]]);

    expect(await step()).toEqual({ status: "skipped", reason: "waiting for 1 open order(s) to fill" });

    await fillAll({ VTI: "300" });
    expect(await step()).toEqual({ status: "skipped", reason: "on target" });
    expect(await db.select().from(rebalancePlans)).toHaveLength(1);
    expect(await kinds()).toContain("rebalance.planned");
  });

  it("only trades inside the window (9:45–15:30 ET) on trading days", async () => {
    clock = new Date("2026-11-02T14:44:00Z"); // 9:44 ET
    expect(await step()).toEqual({ status: "skipped", reason: "outside the trading window" });
    clock = new Date("2026-11-02T14:45:00Z"); // 9:45 ET: the first step of the day
    await sync();
    expect(await step()).toMatchObject({ status: "planned", phase: "buy" });
    clock = new Date("2026-11-02T20:35:00Z"); // 15:35 ET
    expect(await step()).toEqual({ status: "skipped", reason: "outside the trading window" });
    clock = new Date("2026-11-01T15:35:00Z"); // Sunday
    expect(await step()).toEqual({ status: "skipped", reason: "not a trading day" });
  });

  it("sells to raise a withdrawal's cash and doesn't reinvest it (SPEC-capital)", async () => {
    await step();
    await fillAll({ VTI: "300" });
    const [command] = await db.insert(capitalCommands).values({ kind: "request", amount: "500", requestedBy: "cli" }).returning();
    await db.insert(withdrawals).values({ status: "funding", amount: "500", commandId: command!.id, requestedAt: clock, deadline: clock, updatedAt: clock });

    const sells = await step();
    expect(sells).toMatchObject({ status: "planned", phase: "sell", notes: expect.arrayContaining(["$500 held for a withdrawal ($500 still to raise)"]) });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "VTI", side: "sell", qty: "1.666666667" });
    await fillAll({ VTI: "300" });

    // $500 of cash sits there, held for the withdrawal: nothing to buy.
    expect(await step()).toEqual({ status: "skipped", reason: "on target" });

    // A small withdrawal inside the drift band still gets its cash.
    await db.update(withdrawals).set({ amount: "520" });
    expect(await step()).toMatchObject({ phase: "sell" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "VTI", side: "sell", qty: "0.066666666" });
  });

  it("invests a deposit smaller than the drift band at the next step (no idle money)", async () => {
    await step();
    await fillAll({ VTI: "300" });
    // A $100 deposit: VTI's target rises to $1100, $100 under it, inside the $220 band.
    broker.account = { ...broker.account, cash: add(broker.account.cash, "100"), equity: add(broker.account.equity, "100") };
    await sync();
    expect(await step()).toMatchObject({ status: "planned", phase: "buy" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "VTI", side: "buy", notional: "100" });
  });

  it("funds a new thesis inside the drift band by selling VTI, but never the day VTI was bought", async () => {
    await step();
    await fillAll({ VTI: "300" }); // all $1000 in VTI, bought today
    const idleInVti = { universe: ["VTI"], lookbackDays: 252, skipRecentDays: 21, topN: 1, trendFilterDays: null, weighting: "equal" as const, volatilityDays: 63, defensive: null };
    await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "5" })], systematic: idleInVti }), "claude", clock);

    // $50 for AAPL would come out of VTI ($50 over its $950 target, inside the band), but VTI was bought today.
    const sameDay = await step({ limits: LIMITS });
    expect(sameDay).toEqual({ status: "skipped", reason: "on target" });
    const preview = await step({ limits: LIMITS, dryRun: true });
    expect(preview).toMatchObject({
      phase: "none",
      notes: expect.arrayContaining([
        "VTI: sell waits until tomorrow (it was bought today, and same-day round trips are off)",
        "the conviction buys wait for the sells that fund them ($50 short in cash)",
      ]),
    });

    // The next day: VTI is sold to fund it, then AAPL is bought.
    clock = new Date(clock.getTime() + 86_400_000);
    broker.calendar.push({ date: "2026-11-03", open: new Date("2026-11-03T14:30:00Z"), close: new Date("2026-11-03T21:00:00Z") });
    await sync();
    expect(await step({ limits: LIMITS })).toMatchObject({ status: "planned", phase: "sell" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "VTI", side: "sell" });
    await fillAll({ VTI: "300" });
    expect(await step({ limits: LIMITS })).toMatchObject({ status: "planned", phase: "buy" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "buy" });
  });

  it("funds an underweight systematic holding from the ones over target, and leaves Claude a note (#82)", async () => {
    for (const symbol of ["XLK", "XLF"]) broker.assets.push({ symbol, name: `${symbol} Select Sector SPDR`, status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });
    broker.bars = { ...broker.bars, XLK: bars("100"), XLF: bars("100") };
    const three = { universe: ["VTI", "XLK", "XLF"], lookbackDays: 252, skipRecentDays: 21, topN: 3, trendFilterDays: null, weighting: "equal" as const, volatilityDays: 63, defensive: null };
    await submitStrategy(db, strategy({ conviction: [], systematic: three }), "owner", clock);
    await step();
    await fillAll({ VTI: "300", XLK: "100", XLF: "100" }); // XLK and XLF held at the 20% cap, $200 each; VTI takes the overflow
    // XLK falls 30% (the account 6%): $48 under its $188 target, past its band; VTI ($36) and XLF ($12) are over, inside theirs.
    const xlk = broker.positions.find((p) => p.symbol === "XLK")!;
    Object.assign(xlk, { currentPrice: "70", marketValue: mul(xlk.qty, "70") });
    broker.account.equity = broker.positions.reduce((sum, p) => add(sum, p.marketValue), broker.account.cash);
    clock = new Date(clock.getTime() + 86_400_000);
    broker.calendar.push({ date: "2026-11-03", open: new Date("2026-11-03T14:30:00Z"), close: new Date("2026-11-03T21:00:00Z") });
    broker.bars = { ...broker.bars, XLK: bars("70") };
    await sync();

    expect(await step()).toMatchObject({ status: "planned", phase: "sell" });
    expect(broker.orders.filter((o) => o.status === "accepted").map((o) => [o.symbol, o.side]).sort()).toEqual([["VTI", "sell"], ["XLF", "sell"]]);
    const [note] = (await db.select().from(auditEvents)).filter((e) => e.kind === "rebalance.buys_funded");
    expect(note).toMatchObject({ actor: "system", subject: "XLK", payload: { buys: [{ symbol: "XLK", sleeve: "systematic" }], uncovered: "0" } });
    expect((note!.payload as { sold: string[] }).sold.sort()).toEqual(["VTI", "XLF"]);

    await fillAll({ VTI: "300", XLK: "70", XLF: "100" });
    expect(await step()).toMatchObject({ status: "planned", phase: "buy" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "XLK", side: "buy" });
    expect(await kinds()).not.toContain("risk.order_rejected");
  });

  describe("while halted (SPEC-capital decision 2)", () => {
    async function holdVtiWithWithdrawal(amount: string) {
      await step();
      await fillAll({ VTI: "300" });
      const [command] = await db.insert(capitalCommands).values({ kind: "request", amount, requestedBy: "cli" }).returning();
      await db.insert(withdrawals).values({ status: "funding", amount, commandId: command!.id, requestedAt: clock, deadline: clock, updatedAt: clock });
      await latchHalt(db, "the account is down 21% from its peak (limit 20%)", {}, clock);
    }

    it("sells only what the withdrawal needs, and nothing else trades", async () => {
      await holdVtiWithWithdrawal("300");
      const result = await step();
      expect(result).toMatchObject({ status: "planned", phase: "sell", notes: expect.arrayContaining(["trading is halted: selling only the $300 your withdrawal needs"]) });
      expect(broker.orders.slice(1).map((o) => [o.symbol, o.side, o.qty])).toEqual([["VTI", "sell", "1"]]);

      await fillAll({ VTI: "300" });
      // Covered: the halt stops everything again (the $300 is reserved, so there's nothing to buy either).
      expect(await step()).toEqual({ status: "skipped", reason: "halted; no closed thesis to sell" });
      expect(broker.orders).toHaveLength(2);
    });

    /** A 20% AAPL thesis bought and filled on Monday, then Tuesday's session with the account halted. */
    async function holdThesisThenHalt() {
      await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "20", stopLossPct: "15" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } }), "owner", clock);
      await step();
      await fillAll({ VTI: "300", AAPL: "200" });
      broker.calendar.push({ date: "2026-11-03", open: new Date("2026-11-03T14:30:00Z"), close: new Date("2026-11-03T21:00:00Z") });
      clock = new Date("2026-11-03T15:35:00Z");
      await sync();
      await latchHalt(db, "the account is down 31% from its peak (limit 30%)", {}, clock);
    }

    it("sells a thesis through its stop, whole, and keeps the cash: nothing is bought (ADR-017)", async () => {
      await holdThesisThenHalt();
      expect(await step()).toEqual({ status: "skipped", reason: "halted; no closed thesis to sell" }); // the thesis still stands
      const before = broker.orders.length;

      broker.bars.AAPL = bars("160"); // -20%, through the 15% stop
      broker.positions = broker.positions.map((p) => (p.symbol === "AAPL" ? { ...p, currentPrice: "160", marketValue: mul(p.qty, "160") } : p));
      await sync();
      const held = broker.positions.find((p) => p.symbol === "AAPL")!.qty;
      const result = await step();
      expect(result).toMatchObject({ status: "planned", phase: "sell", notes: expect.arrayContaining([expect.stringContaining("trading is halted: selling only what closed (AAPL)")]) });
      expect(broker.orders.slice(before).map((o) => [o.symbol, o.side, o.qty])).toEqual([["AAPL", "sell", held]]);
      expect((await kinds()).filter((k) => k === "thesis.stopped_out")).toHaveLength(1);

      await fillAll({ AAPL: "160" });
      expect(await step()).toEqual({ status: "skipped", reason: "halted; no closed thesis to sell" }); // the cash waits for the owner
      expect(broker.orders).toHaveLength(before + 1);
    });

    it("sells a thesis Claude removed from the strategy, but not VTI", async () => {
      await holdThesisThenHalt();
      const before = broker.orders.length;
      await submitStrategy(db, strategy({ conviction: [], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } }), "claude", clock);
      const held = broker.positions.find((p) => p.symbol === "AAPL")!.qty;
      expect(await step()).toMatchObject({ status: "planned", phase: "sell" });
      expect(broker.orders.slice(before).map((o) => [o.symbol, o.side, o.qty])).toEqual([["AAPL", "sell", held]]);
      // A removed thesis still sells as conviction, not as the systematic sleeve.
      const [plan] = await db.select().from(rebalancePlans).orderBy(desc(rebalancePlans.createdAt)).limit(1);
      expect((plan!.trades as { proposal: { symbol: string; sleeve: string } }[]).map((t) => [t.proposal.symbol, t.proposal.sleeve])).toEqual([["AAPL", "conviction"]]);
    });

    it("sells nothing with the kill switch on", async () => {
      await holdVtiWithWithdrawal("300");
      await setKillSwitch(db, { actor: "owner", reason: "testing" }, clock);
      const result = await step();
      expect(result).toMatchObject({ status: "planned", phase: "sell" });
      expect(broker.orders).toHaveLength(1);
    });
  });

  it("on a strategy change, sells first and buys on the next step", async () => {
    await step();
    await fillAll({ VTI: "300" });
    // The next trading day: today's $1000 buy already used the daily buy limit (100% of equity).
    broker.calendar.push({ date: "2026-11-03", open: new Date("2026-11-03T14:30:00Z"), close: new Date("2026-11-03T21:00:00Z") });
    clock = new Date("2026-11-03T15:35:00Z");
    await sync();
    await submitStrategy(
      db,
      strategy({ conviction: [thesis({ targetWeightPct: "20" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } }),
      "owner",
      clock,
    );

    const sells = await step();
    expect(sells).toMatchObject({ status: "planned", phase: "sell", strategyVersion: 1 });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "VTI", side: "sell" });
    await fillAll({ VTI: "300" });

    const buys = await step();
    expect(buys).toMatchObject({ phase: "buy" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "buy" });
    expect(Number(broker.orders.at(-1)!.notional)).toBeCloseTo(200, 0);
  });

  it("sells a stopped-out thesis, records it once, and never buys it back", async () => {
    await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "20", stopLossPct: "15" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } }), "owner", clock);
    await step();
    await fillAll({ VTI: "300", AAPL: "200" });

    broker.bars.AAPL = bars("160"); // -20%, through the 15% stop
    broker.positions = broker.positions.map((p) => (p.symbol === "AAPL" ? { ...p, currentPrice: "160", marketValue: mul(p.qty, "160") } : p));
    await sync();

    const sell = await step();
    expect(sell).toMatchObject({ phase: "sell" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "sell" });
    const stopped = await db.select().from(thesisEvents);
    expect(stopped).toEqual([expect.objectContaining({ thesisId: "aapl-services", kind: "stopped", price: "160", averageCost: "200" })]);
    expect((await kinds()).filter((k) => k === "thesis.stopped_out")).toHaveLength(1);

    await fillAll({ VTI: "300", AAPL: "160" });
    await step();
    expect(broker.orders.filter((o) => o.symbol === "AAPL" && o.side === "buy")).toHaveLength(1); // only the original buy
    expect(await db.select().from(thesisEvents)).toHaveLength(1);
  });

  describe("#35's exits, on a stored version that sets them (submission refuses them while they're switched off)", () => {
    /** A 20% AAPL thesis with `exit`, stored directly as a replay stores its versions, bought at 200; then Wednesday at `closes`. */
    async function holdThenWednesday(exit: { trailingStopPct?: string; takeProfitPct?: string }, tuesday: string, wednesday: string) {
      const doc = strategy({ conviction: [thesis({ targetWeightPct: "20", stopLossPct: "15", ...exit })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } });
      await db.insert(strategies).values({ authoredBy: "owner", summary: doc.summary, document: doc as unknown as Record<string, unknown>, createdAt: clock });
      await step();
      await fillAll({ VTI: "300", AAPL: "200" });
      const bar = (date: string, c: string): Bar => ({ t: new Date(`${date}T15:35:00Z`), o: c, h: c, l: c, c, v: "1000000" });
      broker.bars.AAPL = [...bars("200"), bar("2026-11-02", "200"), bar("2026-11-03", tuesday), bar("2026-11-04", wednesday)];
      broker.bars.VTI = [...bars("300"), bar("2026-11-02", "300"), bar("2026-11-03", "300"), bar("2026-11-04", "300")];
      broker.positions = broker.positions.map((p) => (p.symbol === "AAPL" ? { ...p, currentPrice: wednesday, marketValue: mul(p.qty, wednesday) } : p));
      broker.calendar.push({ date: "2026-11-04", open: new Date("2026-11-04T14:30:00Z"), close: new Date("2026-11-04T21:00:00Z") });
      clock = new Date("2026-11-04T15:35:00Z");
      await sync();
    }

    it("sells a thesis at its trailing stop below the high since entry, though it's above cost and its stop-loss", async () => {
      await holdThenWednesday({ trailingStopPct: "10" }, "260", "230"); // 11.5% off the high; +15% on cost
      expect(await step()).toMatchObject({ phase: "sell" });
      expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "sell" });
      expect(await db.select().from(thesisEvents)).toEqual([expect.objectContaining({ thesisId: "aapl-services", kind: "trailing_stopped", price: "230", averageCost: "200" })]);
      const [event] = (await db.select().from(auditEvents)).filter((e) => e.kind === "thesis.stopped_out");
      expect(event?.payload).toMatchObject({ trigger: "trailing_stopped", reason: expect.stringContaining("10% trailing stop ($234.00, from a high close of $260.00") });

      await fillAll({ VTI: "300", AAPL: "230" });
      await step();
      expect(broker.orders.filter((o) => o.symbol === "AAPL" && o.side === "buy")).toHaveLength(1); // closed for good
      expect(await db.select().from(thesisEvents)).toHaveLength(1);
    });

    it("sells a thesis whole at its profit target, with its own event", async () => {
      await holdThenWednesday({ takeProfitPct: "25" }, "240", "250");
      const held = broker.positions.find((p) => p.symbol === "AAPL")!.qty;
      expect(await step()).toMatchObject({ phase: "sell" });
      expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "sell", qty: held });
      expect(await db.select().from(thesisEvents)).toEqual([expect.objectContaining({ kind: "took_profit" })]);
      expect(await kinds()).toContain("thesis.took_profit");
      expect(await kinds()).not.toContain("thesis.stopped_out");
    });

    it("leaves the thesis alone inside both", async () => {
      await holdThenWednesday({ trailingStopPct: "10", takeProfitPct: "25" }, "240", "230");
      expect(await db.select().from(thesisEvents)).toEqual([]);
      await step();
      expect(broker.orders.filter((o) => o.symbol === "AAPL" && o.side === "sell")).toEqual([]);
    });
  });

  it("sells a thesis the day after its review date, records it once, and emails it", async () => {
    await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "20", reviewBy: "2026-11-03" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } }), "owner", clock);
    await step();
    await fillAll({ VTI: "300", AAPL: "200" });
    await step();
    expect(await db.select().from(thesisEvents)).toEqual([]); // the review date hasn't passed

    // Wednesday: the day after the review date.
    clock = new Date("2026-11-04T15:35:00Z");
    broker.calendar.push({ date: "2026-11-04", open: new Date("2026-11-04T14:30:00Z"), close: new Date("2026-11-04T21:00:00Z") });
    await sync();
    expect(await step()).toMatchObject({ phase: "sell" });
    expect(broker.orders.at(-1)).toMatchObject({ symbol: "AAPL", side: "sell" });
    expect(await db.select().from(thesisEvents)).toEqual([expect.objectContaining({ thesisId: "aapl-services", kind: "overdue", reason: "past its review date (2026-11-03) without a later one" })]);

    await fillAll({ VTI: "300", AAPL: "200" });
    await step();
    expect(await db.select().from(thesisEvents)).toHaveLength(1);
    expect((await kinds()).filter((k) => k === "thesis.review_overdue")).toHaveLength(1);
    expect(broker.orders.filter((o) => o.symbol === "AAPL" && o.side === "buy")).toHaveLength(1); // not bought back
  });

  it("dry-run plans through risk without recording or ordering anything", async () => {
    const plan = await step({ dryRun: true });
    expect(plan).toMatchObject({ status: "planned", phase: "buy", planId: null });
    expect(plan.status === "planned" && plan.trades[0]?.decision?.verdict).toBe("approved");
    expect(broker.orders).toEqual([]);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(rebalancePlans)).toEqual([]);
  });
});
