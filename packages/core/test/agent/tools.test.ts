import { beforeEach, describe, expect, it } from "vitest";
import {
  checkEligibility,
  getActivity,
  getExposure,
  getHoldings,
  getOverview,
  getPrices,
  getRules,
  getStrategy,
  getTrackRecord,
  getWatchlist,
  previewStrategy,
  submitStrategyTool,
  updateWatchlistTool,
  type ToolDeps,
} from "../../src/agent/tools.js";
import type { Bar } from "../../src/broker/port.js";
import { refreshEarningsCalendar } from "../../src/agent/earnings-calendar.js";
import { syncBroker } from "../../src/broker/sync.js";
import { auditEvents, benchmarkCloses, brokerActivities, capitalCommands, earningsEstimates, jobRuns, orders, positions, rebalancePlans, secFilings, thesisEvents, withdrawals } from "../../src/db/schema.js";
import { WINDOW_CLOSE, WINDOW_OPEN } from "../../src/portfolio/rebalance.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { submitStrategy } from "../../src/portfolio/store.js";
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
      guardrails: { killSwitch: false, halted: false, haltRule: "halts 30% below its peak", buysPausedToday: false, brokerTradingAllowed: true },
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

  it("get_strategy: each thesis's review date and the days left until it", async () => {
    await submitStrategyTool(deps, strategy({ conviction: [thesis({ reviewBy: "2026-11-30" })] }));
    expect((await getStrategy(deps)).theses).toEqual([{ id: "aapl-services", symbol: "AAPL", state: "active", reviewBy: "2026-11-30", daysToReview: 28 }]);
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

  it("get_holdings: each held thesis's signals; a thesis not bought yet and VTI aren't listed; no broker, no signals", async () => {
    await submitStrategyTool(deps, strategy({ conviction: [thesis(), thesis({ id: "tqqq-idea", symbol: "TQQQ" })] }));
    broker.fill("o1", "AAPL", "buy", "5", "200", new Date("2026-10-20T15:00:00Z"));
    broker.fill("o2", "VTI", "buy", "1", "300", new Date("2026-10-20T15:00:00Z"));
    broker.positions = [
      { symbol: "AAPL", qty: "5", avgEntryPrice: "200", marketValue: "1000", costBasis: "1000", currentPrice: "200" },
      { symbol: "VTI", qty: "1", avgEntryPrice: "300", marketValue: "300", costBasis: "300", currentPrice: "300" },
    ];
    await syncBroker(deps.db, broker, "staging", NOW);
    const h = await getHoldings(deps);
    expect(h.theses).toEqual([
      expect.objectContaining({
        id: "aapl-services",
        symbol: "AAPL",
        firstBought: "2026-10-20",
        sinceEntry: { returnPct: "0", vtiPct: "0", excessPct: "0" },
        stop: { price: "170", abovePct: "17.65" },
        flags: [],
      }),
    ]);
    // Without filings, the earnings screen says so rather than guessing.
    expect(h.theses![0]!.signals.notes).toContain("Couldn't read SEC filings: no earnings reaction (check the latest 8-K item 2.02 yourself).");
    expect(await getHoldings({ db: deps.db, now: NOW })).not.toHaveProperty("theses");
  });

  it("get_holdings and check_eligibility give the next earnings date from the latest calendar, and say when there's none (#30)", async () => {
    await submitStrategyTool(deps, strategy());
    broker.fill("o1", "AAPL", "buy", "5", "200", new Date("2026-10-20T15:00:00Z"));
    broker.positions = [{ symbol: "AAPL", qty: "5", avgEntryPrice: "200", marketValue: "1000", costBasis: "1000", currentPrice: "200" }];
    await syncBroker(deps.db, broker, "staging", NOW);
    expect((await getHoldings(deps)).earningsCalendar).toMatchObject({ asOf: null, stale: true, note: expect.stringContaining("needs an Alpha Vantage key") });
    const [none] = (await checkEligibility(deps, ["AAPL"])) as { nextEarnings: unknown; calendarNote?: string }[];
    expect(none).toMatchObject({ nextEarnings: null, calendarNote: expect.stringContaining("check report dates yourself") });

    await refreshEarningsCalendar(deps.db, { upcoming: async () => [{ symbol: "AAPL", reportDate: "2026-11-05", fiscalDateEnding: "2026-09-30", estimate: "1.65", currency: "USD", timeOfDay: "post-market" }] }, NOW);
    const h = await getHoldings(deps);
    expect(h.earningsCalendar).toEqual({ asOf: "2026-11-02", stale: false });
    expect(h.theses![0]).toMatchObject({ nextEarnings: { date: "2026-11-05", inDays: 3, timeOfDay: "post-market", estimate: "1.65" }, flags: ["earnings_soon"] });
    const [one] = (await checkEligibility(deps, ["AAPL"])) as { nextEarnings: unknown }[];
    expect(one).toMatchObject({ nextEarnings: { date: "2026-11-05" } });
    expect(one).not.toHaveProperty("calendarNote");
  });

  it("get_holdings and get_watchlist list each name's SEC filings and flag sell signals; filingsCheck says when the last check ran (#105)", async () => {
    await submitStrategyTool(deps, strategy());
    broker.fill("o1", "AAPL", "buy", "5", "200", new Date("2026-10-20T15:00:00Z"));
    broker.positions = [{ symbol: "AAPL", qty: "5", avgEntryPrice: "200", marketValue: "1000", costBasis: "1000", currentPrice: "200" }];
    await syncBroker(deps.db, broker, "staging", NOW);
    await updateWatchlistTool(deps, [{ action: "watch", symbol: "MSFT", why: "MSFT missed the bar this run", trigger: "MSFT confirms the turn in a 10-Q", revisitBy: "2026-11-30" , forecast: { beatVtiPct: 40, expectedExcessPct: "-2" }}]);
    expect((await getHoldings(deps)).filingsCheck).toMatchObject({ checkedAt: null, stale: true });

    const row = (accession: string, symbol: string, filedOn: string, kind: string, sellSignal: string | null = null) => ({ accession, symbol, cik: "1", form: kind === "periodic" ? "10-Q" : "4", filedOn, acceptedAt: new Date(`${filedOn}T21:00:00Z`), items: "", url: `https://www.sec.gov/${accession}`, kind, summary: `${kind} filing`, sellSignal });
    await deps.db.insert(secFilings).values([
      row("a1", "AAPL", "2026-10-30", "insider_sale", "insider_sale"),
      row("a0", "AAPL", "2026-10-15", "periodic"), // before the first buy
      row("m1", "MSFT", "2026-11-02", "periodic"),
      row("m0", "MSFT", "2026-10-25", "periodic"), // before it went on the watchlist
    ]);
    await deps.db.insert(jobRuns).values({ job: "check-filings", scheduledFor: NOW, status: "succeeded", finishedAt: NOW });
    const h = await getHoldings(deps);
    expect(h.filingsCheck).toEqual({ checkedAt: NOW.toISOString(), stale: false });
    expect(h.theses![0]).toMatchObject({ filings: [{ filedOn: "2026-10-30", kind: "insider_sale", sellSignal: "insider_sale", url: "https://www.sec.gov/a1" }], flags: ["insider_selling"] });
    expect(h.theses![0]!.filings).toHaveLength(1);
    const w = await getWatchlist(deps);
    expect(w.open[0]).toMatchObject({ symbol: "MSFT", filings: [{ filedOn: "2026-11-02", kind: "periodic" }] });
    expect(w.open[0]!.filings).toHaveLength(1);
    expect(w.filingsCheck.stale).toBe(false);
  });

  it("get_holdings and get_watchlist give each name's analyst estimates, flagging a falling consensus on a held thesis (#105)", async () => {
    await submitStrategyTool(deps, strategy());
    broker.fill("o1", "AAPL", "buy", "5", "200", new Date("2026-10-20T15:00:00Z"));
    broker.positions = [{ symbol: "AAPL", qty: "5", avgEntryPrice: "200", marketValue: "1000", costBasis: "1000", currentPrice: "200" }];
    await syncBroker(deps.db, broker, "staging", NOW);
    await updateWatchlistTool(deps, [{ action: "watch", symbol: "MSFT", why: "MSFT missed the bar this run", trigger: "MSFT confirms the turn in a 10-Q", revisitBy: "2026-11-30" , forecast: { beatVtiPct: 40, expectedExcessPct: "-2" }}]);
    const point = (eps: string, eps30dAgo: string) => ({ period: "2026-12-31", eps, eps7dAgo: eps, eps30dAgo, eps60dAgo: eps30dAgo, eps90dAgo: eps30dAgo, raised7d: 0, cut7d: 1, raised30d: 1, cut30d: 4, analysts: 20, revenue: null });
    await deps.db.insert(earningsEstimates).values([
      { symbol: "AAPL", fetchedOn: "2026-11-01", fetchedAt: NOW, status: "ok", quarter: point("1.80", "2.00"), fiscalYear: null },
      { symbol: "MSFT", fetchedOn: "2026-11-01", fetchedAt: NOW, status: "ok", quarter: point("3.10", "3.00"), fiscalYear: null },
    ]);
    const h = await getHoldings(deps);
    expect(h.theses![0]).toMatchObject({ estimates: { asOf: "2026-11-01", nextQuarter: { eps: "1.80", change30dPct: "-10", cut30d: 4 }, falling: true }, flags: ["estimates_falling"] });
    const w = await getWatchlist(deps);
    expect(w.open[0]).toMatchObject({ symbol: "MSFT", estimates: { nextQuarter: { change30dPct: "3.3" }, falling: false } });
  });

  it("get_watchlist and update_watchlist: Claude's notes, flagged once a name is a thesis; get_overview counts them (#32)", async () => {
    const note = (symbol: string, revisitBy: string) => ({ action: "watch", symbol, why: `${symbol} missed the bar this run`, trigger: `${symbol} confirms the turn in a 10-Q`, revisitBy, forecast: { beatVtiPct: 40, expectedExcessPct: "-2" } });
    expect(await updateWatchlistTool(deps, [note("AAPL", "2026-11-30"), note("MSFT", "2026-11-20")])).toMatchObject({ status: "updated", open: 2 });
    await submitStrategyTool(deps, strategy()); // the fixture's thesis is AAPL
    const w = await getWatchlist(deps);
    expect(w.open.map((e) => [e.symbol, "nowThesis" in e])).toEqual([["MSFT", false], ["AAPL", true]]);
    expect(w.limits).toMatchObject({ perCall: 25, open: 40 });
    expect((await getOverview({ ...deps, now: new Date("2026-11-25T15:00:00Z") })).watchlist).toEqual({ open: 2, due: ["MSFT"] });
    expect(w.open[0]).toMatchObject({ forecast: { beatVtiPct: 40, expectedExcessPct: "-2", horizon: "2026-11-20" } });
  });

  it("get_track_record: the forecast ledger and each row's kind source (forecast ledger)", async () => {
    await submitStrategyTool(deps, strategy());
    const t = await getTrackRecord(deps);
    expect(t.forecasts).toMatchObject({ baseRatePct: 45, overall: { forecasts: 1, resolved: 0, tooFewToJudge: true }, open: [{ source: "thesis", id: "aapl-services", beatVtiPct: 55 }] });
  });

  it("get_activity: recent events, orders and rebalance steps", async () => {
    await submitStrategyTool(deps, strategy());
    const a = await getActivity(deps, 7);
    expect(a.events.map((e) => e.kind)).toContain("strategy.activated");
    expect(a).toMatchObject({ rebalanceSteps: [], quietSteps: { count: 0, notes: [] }, orders: [] });
  });

  it("get_activity: a busy week stays short for the routine: activations by headline, one line per trade, quiet steps counted (#74)", async () => {
    const long = (n: number) => `Reaffirmed every thesis; nothing new this run.\n${"Long reasoning. ".repeat(n)}`;
    const plain = Array.from({ length: 7 }, (_, i) => ({ symbol: `S${i}`, targetWeightPct: "10", text: "A plain sentence about the bet. ".repeat(6) }));
    await deps.db.insert(auditEvents).values(
      Array.from({ length: 14 }, (_, i) => ({ actor: "claude" as const, kind: "strategy.activated", subject: `v${i + 1}`, at: new Date(NOW.getTime() - i * 43_200_000), payload: { version: i + 1, authoredBy: "claude", summary: long(150), theses: 7, convictionPct: "70", plain } })),
    );
    const trade = (symbol: string, verdict: string) => ({
      proposal: { key: `k-${symbol}`, symbol, sleeve: "conviction", side: "buy", notional: "1000" },
      reason: `${symbol} under target`,
      verdict,
      reasons: ["a risk reason"],
      submitted: "submitted",
    });
    await deps.db.insert(rebalancePlans).values(
      Array.from({ length: 50 }, (_, i) => ({
        id: crypto.randomUUID(),
        tradingDate: "2026-11-02",
        strategyVersion: 14,
        phase: i % 5 === 0 ? "buy" : "none",
        targets: [],
        trades: i % 5 === 0 ? [trade("AAPL", "approved"), trade("MSFT", "clipped")] : [],
        notes: i % 5 === 0 ? [] : ["the conviction buys wait for the sells that fund them"],
        createdAt: new Date(NOW.getTime() - i * 900_000),
      })),
    );
    const a = await getActivity(deps, 7);
    expect(JSON.stringify(a).length).toBeLessThan(20_000);
    expect(a.events[0]!.payload).toEqual({ version: 1, authoredBy: "claude", headline: "Reaffirmed every thesis; nothing new this run.", theses: 7, convictionPct: "70" });
    expect(a.rebalanceSteps).toHaveLength(10);
    expect(a.rebalanceSteps[0]!.trades).toEqual([
      { side: "buy", symbol: "AAPL", sleeve: "conviction", notional: "1000", reason: "AAPL under target", verdict: "approved", submitted: "submitted" },
      { side: "buy", symbol: "MSFT", sleeve: "conviction", notional: "1000", reason: "MSFT under target", verdict: "clipped", reasons: ["a risk reason"], submitted: "submitted" },
    ]);
    expect(a.quietSteps).toEqual({ count: 40, notes: ["the conviction buys wait for the sells that fund them"] });
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

  it("get_exposure: holdings, active theses not bought yet and candidates, with their industries", async () => {
    await submitStrategyTool(deps, strategy({ conviction: [thesis({ id: "msft-a", symbol: "MSFT" })] }));
    await deps.db.delete(positions);
    await deps.db.insert(positions).values([
      { symbol: "VTI", qty: "2", avgEntryPrice: "300", marketValue: "600", costBasis: "600", currentPrice: "300", syncedAt: NOW },
      { symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "200", costBasis: "200", currentPrice: "200", syncedAt: NOW },
    ]);
    const asked: string[] = [];
    const filings = {
      earningsReleases: async () => [],
      industry: async (s: string) => (asked.push(s), s === "AAPL" ? { sic: "3571", description: "ELECTRONIC COMPUTERS" } : { sic: null, description: null }),
    };
    const e = await getExposure({ ...deps, filings }, ["nvda"]);
    if ("error" in e) throw new Error(e.error);
    expect(e.holdings.map((h) => [h.symbol, h.weightPct, h.sector, h.industry])).toEqual([
      ["VTI", "60", "Broad market (VTI)", null],
      ["AAPL", "20", "Information Technology", "ELECTRONIC COMPUTERS"],
    ]);
    expect(e.candidates.map((c) => [c.symbol, c.thesisId])).toEqual([["MSFT", "msft-a"], ["NVDA", null]]);
    expect(asked).toEqual(["AAPL", "MSFT", "NVDA"]); // never VTI
    expect(await getExposure(deps, ["??"])).toEqual({ error: "Give at least one ticker, like AAPL or VTI." });
    expect(await getExposure(deps)).toMatchObject({ notes: expect.arrayContaining(["Couldn't read SEC for AAPL: sector unknown."]) });
  });

  it("get_track_record: each thesis's return vs the same dollars in VTI", async () => {
    expect(await getTrackRecord(deps)).toMatchObject({ overall: { theses: 0, excessPct: null }, byKind: [], theses: [] });

    await submitStrategyTool(deps, strategy({ conviction: [thesis()] }));
    const filledAt = new Date(NOW.getTime() + 60_000);
    await deps.db.insert(brokerActivities).values({ id: "fill-aapl", type: "FILL", at: filledAt, symbol: "AAPL", side: "buy", qty: "1", price: "200", raw: {} });
    await deps.db.delete(positions);
    await deps.db.insert(positions).values([
      { symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "220", costBasis: "200", currentPrice: "220", syncedAt: filledAt },
      { symbol: "VTI", qty: "1", avgEntryPrice: "300", marketValue: "330", costBasis: "300", currentPrice: "330", syncedAt: filledAt },
    ]);
    await deps.db.insert(benchmarkCloses).values({ symbol: "VTI", tradingDate: "2026-11-02", close: "300" }).onConflictDoNothing();

    const record = await getTrackRecord(deps);
    expect(record.overall).toMatchObject({ theses: 1, scored: 1, bought: "200", pnl: "20", vtiPnl: "20", excess: "0" });
    expect(record.theses).toEqual([
      expect.objectContaining({ ids: ["aapl-services"], symbol: "AAPL", primaryKind: "fundamental", ending: "open", openedAt: filledAt.toISOString(), closedAt: null, qty: "1", pnl: "20", excessPct: "0" }),
    ]);
  });

  it("check_eligibility: the routine's screens for each candidate (12-1 return, last earnings reaction)", async () => {
    // AAPL: 300 flat daily bars at $200, then a −40% 12-1 return; a release mid-session 4 bars before the end, and a −15% reaction the next session.
    const daysBack = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    broker.bars.AAPL = bars("200").map((b, i, all) => {
      const fromEnd = all.length - 1 - i;
      const c = fromEnd <= 2 ? "102" : fromEnd <= 21 ? "120" : "200";
      return { ...b, c };
    });
    // The fourth bar from the end is at 11:35 ET: a release then reacts the next session, the drop to $102.
    const filedAt = daysBack(4).toISOString();
    const filings = { earningsReleases: async (s: string) => (s === "AAPL" ? [{ accession: "a", filedOn: filedAt.slice(0, 10), acceptedAt: filedAt }] : s === "VTI" ? [] : null), industry: async () => null };
    const e = await checkEligibility({ ...deps, filings }, ["AAPL", "VTI", "TQQQ"]);
    if (!Array.isArray(e)) throw new Error(e.error);
    expect(e[0]!.signals).toMatchObject({ momentum12to1Pct: "-40", recentBigLoser: true, lastEarnings: { reactionVsVtiPct: "-15.0", sessionsSince: 2 }, freshEarningsCrash: true });
    expect(e[1]!.signals).toMatchObject({ recentBigLoser: false, lastEarnings: null, freshEarningsCrash: false });
    expect(e[2]!.signals).toMatchObject({ freshEarningsCrash: null, notes: [expect.stringContaining("Couldn't read SEC filings")] });
  });

  it("get_rules: the contract, with the real limits", () => {
    const r = getRules();
    expect(r.risk.positionCapPct).toBe("20");
    expect(r.risk.capExempt.cashEquivalents).toContain("SGOV");
    expect(r.allocation.join(" ")).toContain("never cash");    expect(r.lifecycle.join(" ")).toContain("moving it later needs an evidence item dated (asOf) after every evidence date");
    expect(r.strategySchema.conviction).toContain("reviewBy");
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
    expect(p).toMatchObject({ valid: true, warnings: ["No plainSummary on aapl-services: the owner reads it first, so add 2–4 plain sentences to each."], nextStep: { phase: "buy" } });
    const withPlain = strategy({ ...draft, conviction: [thesis({ targetWeightPct: "20", plainSummary: "Apple sells iPhones and the services people pay for on them every month." })] });
    expect(await previewStrategy(deps, withPlain)).toMatchObject({ valid: true, warnings: [] });
    const trades = (p as { nextStep: { trades: { symbol: string; size: string; risk: string }[] } }).nextStep.trades;
    expect(trades.map((t) => [t.symbol, t.size, t.risk])).toEqual([
      ["AAPL", "$200", "approved"],
      ["VTI", "$800", "approved"],
    ]);
    expect(await deps.db.select().from(orders)).toEqual([]);
    expect(await deps.db.select().from(rebalancePlans)).toEqual([]);
    expect((await deps.db.select().from(auditEvents)).filter((e) => e.kind.startsWith("strategy."))).toEqual([]);
  });

  it("refuses a new thesis or a raised weight without a bear case, and warns about a held one without (#106)", async () => {
    const vti = { ...strategy().systematic, universe: ["VTI"], topN: 1, trendFilterDays: null, defensive: null };
    const bare = thesis({ targetWeightPct: "10", bearCase: undefined, plainSummary: "Apple sells iPhones and the services people pay for on them every month." });
    expect(await previewStrategy(deps, strategy({ conviction: [bare], systematic: vti }))).toEqual({
      valid: false,
      errors: ["conviction[0].bearCase: a new thesis (aapl-services) needs a bear case: the strongest case against it right now, and why it doesn't win"],
    });
    await submitStrategy(deps.db, strategy({ conviction: [bare], systematic: vti }), "owner", NOW);
    expect(await previewStrategy(deps, strategy({ conviction: [bare], systematic: vti }))).toMatchObject({
      valid: true,
      warnings: ["No bearCase on aapl-services: write the strongest case against each and why it doesn't win, and drop any you can't answer."],
    });
    expect(await previewStrategy(deps, strategy({ conviction: [{ ...bare, targetWeightPct: "15" }], systematic: vti }))).toMatchObject({ valid: false, errors: [expect.stringContaining("raising aapl-services from 10% to 15%")] });
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

describe("preview_strategy and the review-date rules", () => {
  it("reports what submit would reject, before planning anything", async () => {
    await submitStrategyTool(deps, strategy({ conviction: [thesis({ reviewBy: "2026-12-01" })] }));
    expect(await previewStrategy(deps, strategy())).toEqual({
      valid: false,
      errors: ['conviction[0].reviewBy: thesis "aapl-services" had a review date (2026-12-01); keep one, and move it later only with fresh evidence'],
    });
  });
});

describe("submit_strategy", () => {
  it("stores the draft as Claude's next version", async () => {
    expect(await submitStrategyTool(deps, strategy())).toEqual({ status: "activated", version: 1 });
    const [event] = (await deps.db.select().from(auditEvents)).filter((e) => e.kind === "strategy.activated");
    expect(event?.actor).toBe("claude");
  });

  it("refuses a new thesis without a bear case from Claude, but not from the owner (#106)", async () => {
    const draft = strategy({ conviction: [thesis({ bearCase: undefined })] });
    const refused = await submitStrategyTool(deps, draft);
    expect(refused).toEqual({ status: "rejected", errors: [expect.stringContaining("a new thesis (aapl-services) needs a bear case")] });
    expect((await deps.db.select().from(auditEvents)).map((e) => e.kind)).toContain("strategy.rejected");
    expect(await submitStrategy(deps.db, draft, "owner", NOW)).toEqual({ status: "activated", version: 1 });
    // Held at the same weight, it goes through, and preview_strategy only warns.
    expect(await submitStrategyTool(deps, draft)).toEqual({ status: "activated", version: 2 });
  });

  it("refuses a thesis without a lead signal or a forecast from Claude, but not from the owner (forecast ledger)", async () => {
    const draft = strategy({ conviction: [thesis({ leadSignal: undefined, forecast: undefined })] });
    expect(await previewStrategy(deps, draft)).toMatchObject({ valid: false, errors: [expect.stringContaining("needs a lead signal"), expect.stringContaining("needs a forecast")] });
    expect(await submitStrategyTool(deps, draft)).toMatchObject({ status: "rejected" });
    expect(await submitStrategy(deps.db, draft, "owner", NOW)).toEqual({ status: "activated", version: 1 });
  });
});
