import { beforeEach, describe, expect, it } from "vitest";
import {
  checkEligibility,
  getActivity,
  getHoldings,
  getOverview,
  getPrices,
  getRules,
  getStrategy,
  previewStrategy,
  submitStrategyTool,
  type ToolDeps,
} from "../../src/agent/tools.js";
import type { Bar } from "../../src/broker/port.js";
import { syncBroker } from "../../src/broker/sync.js";
import { auditEvents, capitalCommands, orders, rebalancePlans, thesisEvents, withdrawals } from "../../src/db/schema.js";
import { WINDOW_CLOSE, WINDOW_OPEN } from "../../src/portfolio/rebalance.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const NOW = new Date("2026-11-02T15:35:00Z");
let deps: ToolDeps;
let broker: FakeBroker;

const bars = (price: string, days = 300): Bar[] =>
  Array.from({ length: days }, (_, i) => ({ t: new Date(NOW.getTime() - (days - i) * 86_400_000), o: price, h: price, l: price, c: price, v: "1000000" }));

beforeEach(async () => {
  const { db } = await createTestDb();
  broker = new FakeBroker();
  broker.now = NOW;
  broker.assets.push(
    { symbol: "AAPL", name: "Apple Inc. Common Stock", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" },
    { symbol: "TQQQ", name: "ProShares UltraPro QQQ", status: "active", tradable: true, fractionable: true, marginRequirementLong: "75" },
  );
  broker.bars = { VTI: bars("300"), AAPL: bars("200"), TQQQ: bars("80") };
  await syncBroker(db, broker, "staging", NOW);
  deps = { db, broker, env: "staging", now: NOW };
});

describe("read tools", () => {
  it("get_overview: account, guardrails, market, strategy v0", async () => {
    const o = await getOverview(deps);
    expect(o).toMatchObject({
      environment: "staging",
      market: { tradingDay: true, rebalanceWindowEt: `${WINDOW_OPEN}–${WINDOW_CLOSE}` },
      account: { equity: "1000", cash: "1000", todayPct: "0", drawdownFromPeakPct: "0" },
      guardrails: { killSwitch: false, halted: false, buysPausedToday: false, brokerTradingAllowed: true },
      strategy: { version: 0, authoredBy: "system" },
      holdings: [],
      vsBenchmark: null,
      capital: null, // no transfers recorded yet
    });
  });

  it("get_strategy: the active document with live thesis states", async () => {
    await submitStrategyTool(deps, strategy());
    const s = await getStrategy(deps);
    expect(s).toMatchObject({ version: 1, authoredBy: "claude", daysSinceReaffirmed: 0, staleAfterDays: 30, theses: [{ id: "aapl-services", symbol: "AAPL", state: "active" }] });
  });

  it("get_holdings: wash-sale windows and stopped ids", async () => {
    broker.fill("o1", "AAPL", "buy", "1", "200", new Date("2026-10-20T15:00:00Z"));
    broker.fill("o2", "AAPL", "sell", "1", "180", new Date("2026-10-25T15:00:00Z"));
    await syncBroker(deps.db, broker, "staging", NOW);
    await deps.db.insert(thesisEvents).values({ thesisId: "old-idea", symbol: "XYZ", kind: "stopped", strategyVersion: 1, reason: "stop" });
    const h = await getHoldings(deps);
    expect(h.washSaleWindows).toEqual([{ symbol: "AAPL", loss: "-20", soldAt: "2026-10-25T15:00:00.000Z", windowEnds: "2026-11-24" }]);
    expect(h.stoppedThesisIds).toEqual(["old-idea"]);
  });

  it("get_activity: recent events, orders and rebalance steps", async () => {
    await submitStrategyTool(deps, strategy());
    const a = await getActivity(deps, 7);
    expect(a.events.map((e) => e.kind)).toContain("strategy.activated");
    expect(a).toMatchObject({ rebalanceSteps: [], orders: [] });
  });

  it("get_prices: bars per symbol, symbols cleaned and capped", async () => {
    const p = (await getPrices(deps, ["vti", " AAPL "], 30)) as Record<string, { close: string }[]>;
    expect(Object.keys(p)).toEqual(["VTI", "AAPL"]);
    expect(p.VTI?.at(-1)?.close).toBe("300");
    expect(await getPrices(deps, Array.from({ length: 26 }, (_, i) => `S${i}`))).toEqual({ error: "At most 25 symbols per call." });
    expect(await getPrices(deps, ["???"])).toEqual({ error: "Give at least one ticker, like AAPL or VTI." });
  });

  it("check_eligibility: risk's verdict, so drafts avoid rejected names", async () => {
    const e = await checkEligibility(deps, ["AAPL", "TQQQ", "VTI", "NOPE"]);
    if (!Array.isArray(e)) throw new Error(e.error);
    expect(e.map((x) => [x.symbol, x.eligible, x.capExempt])).toEqual([
      ["AAPL", true, false],
      ["TQQQ", false, false],
      ["VTI", true, true],
      ["NOPE", false, false],
    ]);
  });

  it("get_rules: the contract, with the real limits", () => {
    const r = getRules();
    expect(r.risk.positionCapPct).toBe("20");
    expect(r.risk.capExempt.cashEquivalents).toContain("SGOV");
    expect(r.allocation.join(" ")).toContain("never cash");
  });
});

describe("a withdrawal in Claude's view (SPEC-capital)", () => {
  beforeEach(async () => {
    // $1000 of VTI bought in June 2025 at $250: a long-term gain at $300.
    broker.account = { ...broker.account, cash: "0", equity: "1000", longMarketValue: "1000" };
    broker.positions = [{ symbol: "VTI", qty: "3.333333333", avgEntryPrice: "250", marketValue: "1000", costBasis: "833.33", currentPrice: "300" }];
    broker.fill("o-1", "VTI", "buy", "3.333333333", "250", new Date("2025-06-02T15:00:00Z"));
    await syncBroker(deps.db, broker, "staging", NOW);
    const [command] = await deps.db.insert(capitalCommands).values({ kind: "request", amount: "500", requestedBy: "cli" }).returning();
    await deps.db.insert(withdrawals).values({ status: "planning", amount: "500", commandId: command!.id, requestedAt: NOW, deadline: new Date("2026-11-02T18:00:00Z"), updatedAt: NOW });
  });

  it("get_overview shows the open request and Claude's window", async () => {
    const o = await getOverview(deps);
    expect(o.capital).toMatchObject({
      summary: null,
      withdrawal: { status: "planning", amount: "500", outstanding: "500", unfunded: "500", investableEquity: "500", planBy: "2026-11-02T18:00:00.000Z" },
      sinceLastStrategy: { net: "0", transfers: [] },
    });
  });

  it("preview_strategy plans for the smaller account and prices each sell's taxes", async () => {
    const draft = strategy({ conviction: [], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } });
    const p = (await previewStrategy(deps, draft)) as { nextStep: { phase: string; trades: Record<string, unknown>[]; notes: string[] } };
    expect(p.nextStep.phase).toBe("sell");
    expect(p.nextStep.notes).toContain("$500 held for a withdrawal ($500 still to raise)");
    expect(p.nextStep.trades).toMatchObject([
      { side: "sell", symbol: "VTI", size: "1.666666667 shares", tax: { realizedGain: "83.33", longTermGain: "83.33", shortTermGain: "0", washSale: null } },
    ]);
  });
});

describe("preview_strategy", () => {
  it("shows what the next step would do, through risk, recording nothing", async () => {
    const draft = strategy({ conviction: [thesis({ targetWeightPct: "20" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } });
    const p = await previewStrategy(deps, draft);
    expect(p).toMatchObject({ valid: true, nextStep: { phase: "buy" } });
    const trades = (p as { nextStep: { trades: { symbol: string; size: string; risk: string }[] } }).nextStep.trades;
    expect(trades.map((t) => [t.symbol, t.size, t.risk])).toEqual([
      ["AAPL", "$200", "approved"],
      ["VTI", "$800", "approved"],
    ]);
    expect(await deps.db.select().from(orders)).toEqual([]);
    expect(await deps.db.select().from(rebalancePlans)).toEqual([]);
    expect((await deps.db.select().from(auditEvents)).filter((e) => e.kind.startsWith("strategy."))).toEqual([]);
  });

  it("judges stale broker data (pre-market, weekends) on its merits, and says the real step re-checks", async () => {
    const draft = strategy({ conviction: [thesis({ targetWeightPct: "20" })], systematic: { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null } });
    const later = { ...deps, now: new Date(NOW.getTime() + 3 * 3_600_000) }; // 3h after the last sync
    const p = (await previewStrategy(later, draft)) as { nextStep: { trades: { risk: string }[]; dataNote?: string } };
    expect(p.nextStep.trades.map((t) => t.risk)).toEqual(["approved", "approved"]);
    expect(p.nextStep.dataNote).toMatch(/180 minutes old.*fresh data/);
    expect(((await previewStrategy(deps, draft)) as { nextStep: { dataNote?: string } }).nextStep.dataNote).toBeUndefined();
  });

  it("reports validation errors and stopped ids without planning", async () => {
    expect(await previewStrategy(deps, strategy({ conviction: [thesis({ stopLossPct: "60" })] }))).toEqual({
      valid: false,
      errors: ["conviction[0].stopLossPct: must be at least 5 and at most 50"],
    });
    await deps.db.insert(thesisEvents).values({ thesisId: "aapl-services", symbol: "AAPL", kind: "stopped", strategyVersion: 1, reason: "stop" });
    expect(await previewStrategy(deps, strategy())).toMatchObject({ valid: false, errors: [expect.stringContaining("was stopped out")] });
  });
});

describe("submit_strategy", () => {
  it("stores the draft as Claude's next version", async () => {
    expect(await submitStrategyTool(deps, strategy())).toEqual({ status: "activated", version: 1 });
    const [event] = (await deps.db.select().from(auditEvents)).filter((e) => e.kind === "strategy.activated");
    expect(event?.actor).toBe("claude");
  });
});
