import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, capitalCommands, orders, rebalancePlans, thesisEvents, withdrawals } from "../../src/db/schema.js";
import { add, compare, div, mul, sub } from "../../src/money.js";
import { runRebalance } from "../../src/portfolio/rebalance.js";
import { submitStrategy } from "../../src/portfolio/store.js";
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

const step = (opts = {}) => runRebalance(db, broker, "staging", clock, opts);
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
      expect(await step()).toEqual({ status: "skipped", reason: "on target" });
      expect(broker.orders).toHaveLength(2);
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

  it("dry-run plans through risk without recording or ordering anything", async () => {
    const plan = await step({ dryRun: true });
    expect(plan).toMatchObject({ status: "planned", phase: "buy", planId: null });
    expect(plan.status === "planned" && plan.trades[0]?.decision?.verdict).toBe("approved");
    expect(broker.orders).toEqual([]);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(rebalancePlans)).toEqual([]);
  });
});
