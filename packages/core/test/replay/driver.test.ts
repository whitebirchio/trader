import { gte } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { brokerActivities, equitySnapshots, orders, rebalancePlans, riskDecisions, riskGateRuns, thesisEvents } from "../../src/db/schema.js";
import { replay } from "../../src/replay/driver.js";
import { marketDate, marketTimeToUtc } from "../../src/time.js";
import { strategy } from "../portfolio/fixtures.js";
import { DAYS, HISTORY, REPLAY, REPLAY_TIMEOUT, base, day, doc, market } from "./fixtures.js";

describe("replay", () => {
  it("runs the real jobs over a simulated clock: buys the thesis, stops it out on a later day's gap, idles the rest in VTI, in replay time", async () => {
    const r = await replay(base(market({ aapl: { [day(5)]: 85 } })));
    expect(r.sessions).toBe(10);
    expect(r.rejectedVersions).toEqual([]);
    expect(r.halts).toEqual([]);

    const fills = (await r.db.select().from(brokerActivities)).filter((a) => a.type === "FILL").map((a) => [marketDate(a.at), a.symbol, a.side]);
    expect(fills).toContainEqual([day(1), "AAPL", "buy"]);
    expect(fills).toContainEqual([day(1), "VTI", "buy"]);
    expect(fills).toContainEqual([day(5), "AAPL", "sell"]);
    // Never a day trade: nothing bought and sold on the same date.
    for (const [date, symbol] of fills) {
      const sides = new Set(fills.filter((f) => f[0] === date && f[1] === symbol).map((f) => f[2]));
      expect(sides.size, `${symbol} on ${date}`).toBe(1);
    }
    expect((await r.db.select().from(thesisEvents)).map((e) => [e.kind, e.symbol, marketDate(e.at)])).toEqual([["stopped", "AAPL", day(5)]]);
    const positions = await r.broker.getPositions();
    expect(positions.map((p) => p.symbol)).toEqual(["VTI"]);

    // Replay time, not the wall clock: every decision-path timestamp is in 2024, including the
    // snapshots' recorded_at (the equity index splits deposits between snapshots by it).
    // audit_events.at and job_runs.started_at stay on the database clock: bookkeeping, read by no decision.
    const leaks = [
      ...(await r.db.select({ at: equitySnapshots.recordedAt }).from(equitySnapshots).where(gte(equitySnapshots.recordedAt, new Date("2025-01-01")))),
      ...(await r.db.select({ at: rebalancePlans.createdAt }).from(rebalancePlans).where(gte(rebalancePlans.createdAt, new Date("2025-01-01")))),
      ...(await r.db.select({ at: riskGateRuns.ranAt }).from(riskGateRuns).where(gte(riskGateRuns.ranAt, new Date("2025-01-01")))),
      ...(await r.db.select({ at: riskDecisions.decidedAt }).from(riskDecisions).where(gte(riskDecisions.decidedAt, new Date("2025-01-01")))),
      ...(await r.db.select({ at: orders.createdAt }).from(orders).where(gte(orders.createdAt, new Date("2025-01-01")))),
      ...(await r.db.select({ at: brokerActivities.at }).from(brokerActivities).where(gte(brokerActivities.at, new Date("2025-01-01")))),
      ...(await r.db.select({ at: thesisEvents.at }).from(thesisEvents).where(gte(thesisEvents.at, new Date("2025-01-01")))),
    ];
    expect(leaks).toEqual([]);
    // One snapshot per session, after a base row at the prior close (production's first-snapshot seed, migration 0018).
    expect((await r.db.select({ d: equitySnapshots.tradingDate }).from(equitySnapshots).orderBy(equitySnapshots.tradingDate)).map((s) => s.d)).toEqual([DAYS[HISTORY - 1], ...REPLAY]);
    expect(r.msPerSession).toBeGreaterThan(0);
  }, REPLAY_TIMEOUT);

  it("replays a recorded history as stored: a version today's schema rejects is reported (and read as version 0, like live), an oversized withdrawal's shortfall is reported", async () => {
    const r = await replay({
      ...base(market()),
      versions: [
        { at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude", document: doc, version: 1, raw: true },
        { at: new Date(`${day(3)}T13:00:00Z`), authoredBy: "claude", document: { summary: "an old shape" }, version: 2, raw: true },
      ],
      transfers: [
        { at: new Date(`${day(1)}T13:30:00Z`), amount: "10000" },
        { at: new Date(`${day(4)}T13:30:00Z`), amount: "-20000" },
      ],
    });
    expect(r.rejectedVersions).toEqual([{ at: new Date(`${day(3)}T13:00:00Z`), version: 2, errors: expect.arrayContaining([expect.stringMatching(/^conviction/)]) }]);
    expect(r.transferShortfalls).toHaveLength(1);
    expect(r.transferShortfalls[0]).toMatchObject({ amount: "-20000" });
    // With version 2 unreadable, live falls back to version 0 (everything in VTI), so the AAPL thesis is sold.
    const fills = (await r.db.select().from(brokerActivities)).filter((a) => a.type === "FILL").map((a) => [marketDate(a.at), a.symbol, a.side]);
    expect(fills).toContainEqual([day(3), "AAPL", "sell"]);
  }, REPLAY_TIMEOUT);

  it("trades a midday version the same session, as live's 15-minute steps would", async () => {
    const vtiOnly = strategy({ ...doc, summary: "Replay test: the AAPL thesis dropped at midday.", conviction: [] });
    const r = await replay({
      ...base(market()),
      versions: [
        { at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude", document: doc },
        { at: marketTimeToUtc(day(3), "12:15"), authoredBy: "claude", document: vtiOnly },
      ],
    });
    const fills = (await r.db.select().from(brokerActivities)).filter((a) => a.type === "FILL").map((a) => [marketDate(a.at), a.symbol, a.side]);
    expect(fills).toContainEqual([day(3), "AAPL", "sell"]);
    expect(fills).toContainEqual([day(3), "VTI", "buy"]);
  }, REPLAY_TIMEOUT);

  it("freezes on a drawdown halt like live trading; autoResume resumes it, and production's check re-latches it while still 30% down", async () => {
    const crash = { [day(6)]: 55 };
    const frozen = await replay(base(market({ aapl: { [day(6)]: 55 }, vti: { [day(6)]: 165 } })));
    expect(frozen.halts).toEqual([{ date: day(6), reason: expect.any(String), resumed: false }]);
    const after = (await frozen.db.select().from(orders)).filter((o) => marketDate(o.createdAt) > day(6));
    expect(after).toEqual([]);

    // resume doesn't re-base the drawdown peak, so the next sync halts again while the account is still 30%+ down:
    // the replay shows what production would do (a finding for the owner, not something the replay papers over).
    const resumed = await replay(base(market({ aapl: crash, vti: { [day(6)]: 165 } }), true));
    expect(resumed.halts[0]).toEqual({ date: day(6), reason: expect.any(String), resumed: true });
    expect(resumed.halts.map((h) => h.date)).toEqual([day(6), day(7), day(8), day(9), day(10)]);
  }, REPLAY_TIMEOUT);
});
