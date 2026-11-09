import { describe, expect, it } from "vitest";
import { replay } from "../../src/replay/driver.js";
import { formatReport, replayReport } from "../../src/replay/report.js";
import { marketDate } from "../../src/time.js";
import { strategy, thesis } from "../portfolio/fixtures.js";
import { REPLAY_TIMEOUT, base, day, doc, market } from "./fixtures.js";

describe("replayReport", () => {
  it("reports a replay from the live readers: performance, the scorecard, trades, realized gains, wash sales, exits, risk, assumptions and small-sample warnings", async () => {
    // AAPL gaps through its 10% stop on day 5; a new AAPL thesis on day 7 buys it back inside the wash-sale window.
    const again = strategy({ ...doc, summary: "Replay test: AAPL again, under a new thesis.", conviction: [thesis({ id: "aapl-again", symbol: "AAPL", targetWeightPct: "20", stopLossPct: "10" })] });
    const r = await replay({
      ...base(market({ aapl: { [day(5)]: 85 }, vti: { [day(8)]: 306 } })),
      versions: [
        { at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude", document: doc },
        { at: new Date(`${day(7)}T13:00:00Z`), authoredBy: "claude", document: again },
      ],
    });
    const report = await replayReport(r, { from: day(1), to: day(10), slippageBps: 10 });

    expect(report.window).toEqual({ from: day(1), to: day(10), sessions: 10 });
    expect(report.performance).toMatchObject({ through: day(10) });
    expect(Number(report.performance!.benchmarkPct)).toBeCloseTo(2, 1); // VTI 300 → 306

    // The scorecard's own rows: the stopped thesis lost about 15% (with slippage both ways), while VTI was flat over its window.
    const stopped = report.scorecard.theses.find((t) => t.ids.includes("aapl-replay"))!;
    expect(stopped.ending).toBe("stopped");
    expect(Number(stopped.returnPct)).toBeCloseTo(-15.2, 1);
    expect(report.scorecard.overall.theses).toBe(2);

    expect(report.trades.buys).toBeGreaterThanOrEqual(3); // AAPL, VTI, AAPL again
    expect(report.trades.sells).toBeGreaterThanOrEqual(1);
    expect(Number(report.trades.turnoverPct)).toBeGreaterThan(0);
    expect(Number(report.realized.shortTerm)).toBeLessThan(0);
    expect(report.realized.longTerm).toBe("0.00");

    expect(report.washSales.map((w) => [w.symbol, marketDate(w.soldAt), marketDate(w.rebuyAt)])).toEqual([["AAPL", day(5), day(7)]]);
    expect(report.thesisExits.map((e) => [e.kind, e.thesisId, marketDate(e.at)])).toEqual([["stopped", "aapl-replay", day(5)]]);
    expect(report.risk.decisions.approved).toBeGreaterThan(0);
    expect(report.halts).toEqual([]);

    expect(report.assumptions.join(" ")).toMatch(/open.*10 bps/);
    expect(report.warnings).toEqual([expect.stringMatching(/^Only 10 sessions/), expect.stringMatching(/^Only 2 scored theses/)]);

    const text = formatReport(report);
    for (const heading of ["Performance (flow-adjusted)", "Theses vs the same dollars in VTI", "Trading", "Thesis exits", "Risk", "Assumptions", "Read with care"]) expect(text).toContain(heading);
    expect(text).toContain(`AAPL sold at a $${report.washSales[0]!.loss.slice(1)} loss on ${day(5)}, bought back ${day(7)}`);
  }, REPLAY_TIMEOUT);

  it("groups risk reasons by rule, with their figures masked, and lists history the replay couldn't follow", async () => {
    const r = await replay({
      ...base(market()),
      versions: [{ at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude", document: { summary: "an old shape" }, version: 1, raw: true }],
      transfers: [
        { at: new Date(`${day(1)}T13:30:00Z`), amount: "10000" },
        { at: new Date(`${day(2)}T13:30:00Z`), amount: "-20000" },
      ],
    });
    const report = await replayReport(r, { from: day(1), to: day(10), slippageBps: 10 });
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^1 version/), expect.stringMatching(/^1 withdrawal/)]));
    const text = formatReport(report);
    expect(text).toContain("History the replay couldn't follow");
    expect(text).toMatch(/v1 \(.*\) read as version 0/);
    expect(text).toContain("withdrawal of $20000.00 short by");
    for (const reason of report.risk.reasons) expect(reason.reason).not.toMatch(/\d/);
  }, REPLAY_TIMEOUT);
});
