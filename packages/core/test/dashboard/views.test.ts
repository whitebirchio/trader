import { beforeEach, describe, expect, it } from "vitest";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, equitySnapshots, thesisCloses, thesisEvents } from "../../src/db/schema.js";
import { activityView, holdingsView, moneyView, overviewView, performanceSeries, strategyHistory, strategyVersion, strategyView, thesisChanges, thesisView, trackRecordView } from "../../src/dashboard/views.js";
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
    expect(await performanceSeries(db)).toMatchObject({ points: [], totals: null, range: "all", rangeTotals: null });
    await db.insert(equitySnapshots).values({ tradingDate: "2026-10-28", equity: "1000", cash: "0", longMarketValue: "1000" });
    expect(await performanceSeries(db)).toMatchObject({ points: [{ date: "2026-10-28", portfolio: "100", benchmark: null }], totals: null });
  });

  it("shows a range rebased to 100 at its first point, with its own totals; a range the history doesn't reach falls back to all", async () => {
    await db.insert(equitySnapshots).values([
      { tradingDate: "2026-09-01", equity: "1000", cash: "0", longMarketValue: "1000" },
      { tradingDate: "2026-10-01", equity: "1100", cash: "0", longMarketValue: "1100" },
      { tradingDate: "2026-10-30", equity: "1210", cash: "0", longMarketValue: "1210" },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-09-01", close: "300" },
      { symbol: "VTI", tradingDate: "2026-10-01", close: "300" },
      { symbol: "VTI", tradingDate: "2026-10-30", close: "330" },
    ]);
    const s = await performanceSeries(db, "4w"); // from Oct 2: the base is the Oct 1 close
    expect(s.range).toBe("4w");
    expect(s.points).toEqual([
      { date: "2026-10-01", portfolio: "100", benchmark: "100" },
      { date: "2026-10-30", portfolio: "110", benchmark: "110" },
    ]);
    expect(s.rangeTotals).toMatchObject({ since: "2026-10-01", portfolioPct: "10", benchmarkPct: "10" });
    expect(s.totals).toMatchObject({ since: "2026-09-01", portfolioPct: "21", benchmarkPct: "10" });
    expect(s.ranges.filter((r) => r.available).map((r) => r.range)).toEqual(["4w", "all"]);
    const fallback = await performanceSeries(db, "6m");
    expect(fallback.range).toBe("all");
    expect(fallback.points).toHaveLength(3);
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

describe("trackRecordView", () => {
  it("scores each thesis against the same dollars in VTI", async () => {
    expect((await trackRecordView(db, NOW)).theses).toEqual([]);
    await seedHoldings();
    await db.insert(benchmarkCloses).values({ symbol: "VTI", tradingDate: "2026-10-28", close: "300" });
    const t = await trackRecordView(db, NOW);
    // $200 of AAPL, now $180; the same $200 in VTI at $300, still $300.
    expect(t.theses).toEqual([expect.objectContaining({ ids: ["aapl-services"], ending: "open", pnl: "-20", vtiPnl: "0", excess: "-20", excessPct: "-10" })]);
    expect(t.overall).toMatchObject({ theses: 1, beatVtiPct: "0" });
  });
});

describe("thesisView", () => {
  const closes = (symbol: string, rows: [string, string][]) => db.insert(thesisCloses).values(rows.map(([tradingDate, close]) => ({ symbol, tradingDate, close })));

  it("shows an open thesis: its row, closes around it, fills, cost, stop, evidence dates and versions", async () => {
    await seedHoldings();
    await db.insert(benchmarkCloses).values({ symbol: "VTI", tradingDate: "2026-10-28", close: "300" });
    await closes("AAPL", [["2026-09-01", "150"], ["2026-10-27", "198"], ["2026-10-28", "200"], ["2026-10-30", "180"]]);
    await closes("MSFT", [["2026-10-28", "400"]]);
    const evidence = [{ kind: "insider" as const, summary: "CFO bought $2M on the open market", asOf: "2026-10-29" }];
    await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "10", stopLossPct: "15", reviewBy: "2026-12-01", evidence })] }), "claude", new Date("2026-10-30T12:00:00Z"));

    const v = (await thesisView(db, "aapl-services", NOW))!;
    expect(v).toMatchObject({ symbol: "AAPL", ids: ["aapl-services"], latestVersion: 2, thesis: { targetWeightPct: "10" } });
    expect(v.score).toMatchObject({ ending: "open", closedAt: null, money: { excessPct: "-10" } });
    expect(v.history.map((h) => [h.version, h.changes])).toEqual([
      [2, ["weight 20% → 10%", "review by 2026-12-01", "evidence updated"]],
      [1, ["added at 20%"]],
    ]);
    // Since first held by default, through now; another symbol's closes stay out.
    expect(v.chart.range).toBe("held");
    expect(v.chart.closes).toEqual([
      { date: "2026-10-28", close: "200" },
      { date: "2026-10-30", close: "180" },
    ]);
    // 4 weeks back from now (Oct 5) starts at the last close before it; a year back is before the history, so it falls back.
    expect((await thesisView(db, "aapl-services", NOW, "4w"))!.chart.closes.map((c) => c.date)).toEqual(["2026-09-01", "2026-10-27", "2026-10-28", "2026-10-30"]);
    const year = (await thesisView(db, "aapl-services", NOW, "1y"))!.chart;
    expect(year.range).toBe("held");
    expect(year.ranges.find((r) => r.range === "1y")).toMatchObject({ available: false, reason: "history starts 2026-09-01" });
    expect(v.chart.fills).toEqual([{ at: "2026-10-28T15:00:00.000Z", date: "2026-10-28", side: "buy", qty: "1", price: "200" }]);
    expect(v.chart).toMatchObject({ cost: "200", stopPrice: "170", evidence: [{ date: "2026-10-29", kind: "insider", summary: "CFO bought $2M on the open market" }] });
  });

  it("shows a removed, sold thesis: the version that dropped it, its average buy, no stop, and its events", async () => {
    await seedHoldings();
    await submitStrategy(db, strategy({ conviction: [] }), "claude", new Date("2026-10-30T12:00:00Z"));
    broker.fill("o3", "AAPL", "sell", "1", "210", new Date("2026-10-30T15:00:00Z"));
    broker.positions = broker.positions.filter((p) => p.symbol !== "AAPL");
    await syncBroker(db, broker, "staging", NOW);
    await db.insert(thesisEvents).values({ thesisId: "aapl-services", symbol: "AAPL", kind: "stale", strategyVersion: 1, reason: "not reaffirmed in 30 days", at: new Date("2026-10-29T15:00:00Z") });

    const v = (await thesisView(db, "aapl-services", NOW))!;
    expect(v.score).toMatchObject({ closedAt: "2026-10-30T15:00:00.000Z" });
    expect(v.history.map((h) => [h.version, h.thesis?.id ?? null, h.changes])).toEqual([
      [2, null, ["removed"]],
      [1, "aapl-services", ["added at 20%"]],
    ]);
    expect(v.chart.fills.map((f) => f.side)).toEqual(["buy", "sell"]);
    expect(v.chart).toMatchObject({ cost: "200", stopPrice: null });
    expect(v.events).toEqual([{ kind: "stale", thesisId: "aapl-services", reason: "not reaffirmed in 30 days", at: "2026-10-29T15:00:00.000Z" }]);
  });

  it("shows a thesis not bought yet from its versions alone, and null for an id no version lists", async () => {
    await submitStrategy(db, strategy({ conviction: [thesis({ id: "msft-ai", symbol: "MSFT" })] }), "claude", new Date("2026-10-30T12:00:00Z"));
    const v = (await thesisView(db, "msft-ai", NOW))!;
    expect(v).toMatchObject({ symbol: "MSFT", ids: ["msft-ai"], score: null, chart: { fills: [], cost: null, stopPrice: null } });
    expect(await thesisView(db, "nope", NOW)).toBeNull();
  });
});

describe("thesisChanges", () => {
  it("names each change, or calls an unchanged listing a reaffirmation", () => {
    const t = thesis({ reviewBy: "2026-12-01" });
    expect(thesisChanges(t, t)).toEqual(["reaffirmed"]);
    expect(thesisChanges(t, { ...t, id: "aapl-b", stopLossPct: "20", reviewBy: undefined, thesis: `${t.thesis} More.` })).toEqual([
      "renamed aapl-services → aapl-b",
      "stop 15% → 20%",
      "review date dropped",
      "reasoning updated",
    ]);
    expect(thesisChanges(t, { ...t, plainSummary: "Apple sells iPhones and the services on them." })).toEqual(["plain summary added"]);
    expect(thesisChanges(t, { ...t, bearCase: `${t.bearCase} And services growth is slowing.` })).toEqual(["bear case updated"]);
    expect(thesisChanges({ ...t, bearCase: undefined }, t)).toEqual(["bear case added"]);
    expect(thesisChanges(null, t)).toEqual(["added at 10%"]);
    expect(thesisChanges(t, null)).toEqual(["removed"]);
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
