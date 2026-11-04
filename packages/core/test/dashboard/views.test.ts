import { beforeEach, describe, expect, it } from "vitest";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, equitySnapshots } from "../../src/db/schema.js";
import { activityView, holdingsView, moneyView, overviewView, performanceSeries, strategyHistory, strategyVersion, strategyView } from "../../src/dashboard/views.js";
import { compareToBenchmark } from "../../src/portfolio/benchmark.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { buildIndex } from "../../src/risk/equity-index.js";
import { marketDate } from "../../src/time.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const NOW = new Date("2026-11-02T15:35:00Z");
let db: Db;
let broker: FakeBroker;

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  broker.now = NOW;
});

async function seedHoldings() {
  // $1000: $200 of AAPL bought at 200 (now 180), $700 of VTI at 300 (now 300), $100 cash.
  broker.fill("o1", "AAPL", "buy", "1", "200", new Date("2026-10-28T15:00:00Z"));
  broker.fill("o2", "VTI", "buy", "2.333333333", "300", new Date("2026-10-28T15:00:00Z"));
  broker.positions = [
    { symbol: "VTI", qty: "2.333333333", avgEntryPrice: "300", marketValue: "700", costBasis: "700", currentPrice: "300" },
    { symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "180", costBasis: "200", currentPrice: "180" },
  ];
  broker.account = { ...broker.account, equity: "980", cash: "100" };
  await syncBroker(db, broker, "staging", NOW);
  await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "20", stopLossPct: "15" })] }), "claude", new Date("2026-10-28T12:00:00Z"));
}

describe("performanceSeries", () => {
  it("rebases the flow-adjusted index and VTI to 100, with the same totals as the digest", async () => {
    await db.insert(equitySnapshots).values([
      { tradingDate: "2026-10-28", equity: "1000", cash: "0", longMarketValue: "1000" },
      { tradingDate: "2026-10-29", equity: "1020", cash: "0", longMarketValue: "1020" },
      { tradingDate: "2026-10-30", equity: "1010", cash: "0", longMarketValue: "1010" },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-10-28", close: "300" },
      { symbol: "VTI", tradingDate: "2026-10-29", close: "303" },
      // 10-30 missing: carried from the last close
    ]);
    const s = await performanceSeries(db);
    expect(s.points).toEqual([
      { date: "2026-10-28", portfolio: "100", benchmark: "100" },
      { date: "2026-10-29", portfolio: "102", benchmark: "101" },
      { date: "2026-10-30", portfolio: "101", benchmark: "101" },
    ]);
    const index = buildIndex(
      [
        { tradingDate: "2026-10-28", equity: "1000", recordedAt: new Date("2026-10-28T20:15:00Z") },
        { tradingDate: "2026-10-29", equity: "1020", recordedAt: new Date("2026-10-29T20:15:00Z") },
        { tradingDate: "2026-10-30", equity: "1010", recordedAt: new Date("2026-10-30T20:15:00Z") },
      ],
      [],
    );
    const bars = [
      { t: new Date("2026-10-28T17:00:00Z"), c: "300" },
      { t: new Date("2026-10-29T17:00:00Z"), c: "303" },
    ];
    expect(s.totals).toEqual(compareToBenchmark(index.points, bars, marketDate));
    expect(s.totals).toMatchObject({ portfolioPct: "1", benchmarkPct: "1" });
  });

  it("is empty before the first snapshot, and has no benchmark until closes are recorded", async () => {
    expect(await performanceSeries(db)).toEqual({ points: [], totals: null });
    await db.insert(equitySnapshots).values({ tradingDate: "2026-10-28", equity: "1000", cash: "0", longMarketValue: "1000" });
    expect(await performanceSeries(db)).toEqual({ points: [{ date: "2026-10-28", portfolio: "100", benchmark: null }], totals: null });
  });
});

describe("overviewView", () => {
  it("reads account, guardrails and strategy from the database alone", async () => {
    await seedHoldings();
    const calls = { ...broker.calls };
    const o = await overviewView(db, "staging", NOW);
    expect(o).toMatchObject({
      environment: "staging",
      account: { equity: "980", cash: "100" },
      guardrails: { killSwitch: false, halted: false, brokerTradingAllowed: true },
      strategy: { version: 1, authoredBy: "claude" },
      performance: { points: [] },
      capital: null,
    });
    expect(broker.calls).toEqual(calls); // no broker calls
  });
});

describe("holdingsView", () => {
  it("splits by sleeve, with weights, gains, and the thesis's stop distance", async () => {
    await seedHoldings();
    const h = await holdingsView(db, NOW);
    expect(h.equity).toBe("980");
    expect(h.conviction).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        weightPct: "18.37",
        gainPct: "-10",
        thesis: { id: "aapl-services", state: "active", targetPct: "20", stopLossPct: "15", stopPrice: "170", toStopPct: "5.88", staleInDays: 25 },
      }),
    ]);
    expect(h.systematic).toEqual([expect.objectContaining({ symbol: "VTI", weightPct: "71.43", gainPct: "0", thesis: null })]);
    expect(h.washSaleWindows).toEqual([]);
  });
});

describe("strategy views", () => {
  it("the active strategy with states and days to stale; history newest first with v0 last; any version by number", async () => {
    await seedHoldings();
    await submitStrategy(db, strategy({ summary: "Second" }), "claude", new Date("2026-11-01T12:00:00Z"));
    const v = await strategyView(db, NOW);
    expect(v).toMatchObject({ version: 2, daysSinceReaffirmed: 1, staleInDays: 29, theses: [{ id: "aapl-services", state: "active" }] });
    expect((await strategyHistory(db)).map((h) => [h.version, h.summary])).toEqual([
      [2, "Second"],
      [1, "Test strategy"],
      [0, expect.stringContaining("Version 0")],
    ]);
    expect(await strategyVersion(db, 1)).toMatchObject({ version: 1, document: { summary: "Test strategy" } });
    expect(await strategyVersion(db, 0)).toMatchObject({ version: 0, document: { systematic: { universe: ["VTI"] } } });
    expect(await strategyVersion(db, 99)).toBeNull();
  });
});

describe("activityView", () => {
  it("is the same feed Claude reads", async () => {
    await seedHoldings();
    const a = await activityView(db, NOW, 7);
    expect(a.events.map((e) => e.kind)).toContain("strategy.activated");
  });
});

describe("moneyView", () => {
  it("is empty before any transfer or request", async () => {
    await seedHoldings();
    expect(await moneyView(db, NOW)).toMatchObject({ summary: null, withdrawal: null, ledger: [], timeline: [], commands: [], past: [] });
  });

  it("shows the ledger, the open request with its timeline, and the commands", async () => {
    await seedHoldings();
    const { processCommands, queueCommand } = await import("../../src/capital/commands.js");
    const { recordCapitalFlows } = await import("../../src/capital/ledger.js");
    broker.activities.push({ id: "csd", type: "CSD", at: new Date("2026-10-27T15:00:00Z"), symbol: null, side: null, qty: null, price: null, netAmount: "1000", orderId: null, raw: { created_at: "2026-10-27T15:00:00Z", status: "executed" } });
    await syncBroker(db, broker, "staging", NOW);
    await recordCapitalFlows(db, NOW);
    await queueCommand(db, { kind: "request", amount: "300", requestedBy: "dashboard:scott" }, NOW);
    await queueCommand(db, { kind: "request", amount: "all", requestedBy: "cli" }, new Date(NOW.getTime() + 1000));
    await processCommands(db, new Date(NOW.getTime() + 2000), broker.calendar);

    const m = await moneyView(db, NOW);
    expect(m.equity).toBe("980");
    expect(m.summary).toMatchObject({ contributed: "1000", since: null, value: null }); // no closing snapshot yet
    expect(m.ledger).toEqual([{ at: "2026-10-27T15:00:00.000Z", amount: "1000", kind: "deposit", status: "executed", approximate: false }]);
    expect(m.withdrawal).toMatchObject({ status: "planning", amount: "300", outstanding: "300" });
    expect(m.timeline.map((e) => [e.kind, e.actor])).toEqual([["capital.withdrawal_requested", "owner"]]);
    expect(m.commands.map((c) => [c.kind, c.amount, c.outcome])).toEqual([
      ["request", "all", "rejected"],
      ["request", "300", "accepted"],
    ]);
  });
});
