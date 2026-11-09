import { gte } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Bar, CalendarDay } from "../../src/broker/port.js";
import { brokerActivities, equitySnapshots, orders, rebalancePlans, riskDecisions, riskGateRuns, thesisEvents } from "../../src/db/schema.js";
import { replay } from "../../src/replay/driver.js";
import type { SimMarket } from "../../src/replay/sim-broker.js";
import { marketDate, marketTimeToUtc } from "../../src/time.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

// Synthetic weekday sessions in 2024: far from the real clock (2026), so any
// timestamp taken from the wall clock instead of the replay's stands out.
function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); out.length < count; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const HISTORY = 160; // sessions of flat history before the replay starts (eligibility needs 90+ days listed)
const DAYS = weekdays("2023-09-01", HISTORY + 10);
const REPLAY = DAYS.slice(HISTORY);
const day = (n: number) => REPLAY[n - 1]!; // day(1) is the replay's first session

/** Daily bars: flat at `base`, except where `opens` sets a session's open (and close) from then on. */
function series(base: number, shocks: Record<string, number> = {}): Bar[] {
  let level = base;
  return DAYS.map((date) => {
    if (shocks[date] !== undefined) level = shocks[date]!;
    const p = level.toFixed(2);
    return { t: new Date(`${date}T05:00:00Z`), o: p, h: p, l: p, c: p, v: "1000000" };
  });
}

function market(shocks: { aapl?: Record<string, number>; vti?: Record<string, number> } = {}): SimMarket {
  // 09:30–16:00 Eastern, so daylight time is right (April is EDT, the replay steps are in ET).
  const calendar: CalendarDay[] = DAYS.map((date) => ({ date, open: marketTimeToUtc(date, "09:30"), close: marketTimeToUtc(date, "16:00") }));
  const asset = (symbol: string) => ({ symbol, name: symbol, status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" });
  return { bars: { AAPL: series(100, shocks.aapl), VTI: series(300, shocks.vti) }, calendar, assets: { AAPL: asset("AAPL"), VTI: asset("VTI") } };
}

const doc = strategy({
  summary: "Replay test: one AAPL thesis, the rest in VTI.",
  conviction: [thesis({ id: "aapl-replay", symbol: "AAPL", targetWeightPct: "20", stopLossPct: "10" })],
  systematic: { universe: ["VTI"], lookbackDays: 21, skipRecentDays: 0, topN: 1, trendFilterDays: null, weighting: "equal", volatilityDays: 20, defensive: null },
  drift: { relativePct: "20", minTradeUsd: "5" },
});

const base = (m: SimMarket, autoResume = false) => ({
  market: m,
  versions: [{ at: new Date(`${day(1)}T13:00:00Z`), authoredBy: "claude" as const, document: doc }],
  transfers: [{ at: new Date(`${day(1)}T13:30:00Z`), amount: "10000" }],
  from: day(1),
  to: day(10),
  autoResume,
});

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
  });

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
  });
});
