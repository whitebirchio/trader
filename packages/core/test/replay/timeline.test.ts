import { describe, expect, it } from "vitest";
import { brokerActivities, capitalFlows, equitySnapshots, thesisEvents } from "../../src/db/schema.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { exportTimeline, parseTimeline, serializeTimeline, timelineStart, timelineSymbols } from "../../src/replay/timeline.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

describe("exportTimeline", () => {
  it("reads every version as stored, every transfer that counted (leaving canceled ones out), and what the account actually did", async () => {
    const { db } = await createTestDb();
    await submitStrategy(db, strategy({ conviction: [thesis()] }), "claude", new Date("2026-11-02T13:00:00Z"));
    await submitStrategy(db, strategy({ conviction: [] }), "owner", new Date("2026-11-03T13:00:00Z"));
    await db.insert(brokerActivities).values([
      { id: "d1", type: "CSD", at: new Date("2026-10-30T15:00:00Z"), netAmount: "1000", raw: {} },
      { id: "d2", type: "CSD", at: new Date("2026-11-04T15:00:00Z"), netAmount: "500", raw: {} },
      { id: "w1", type: "CSW", at: new Date("2026-11-05T15:00:00Z"), netAmount: "-200", raw: {} },
      { id: "f1", type: "FILL", at: new Date("2026-11-02T14:45:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "100.5", raw: {} },
    ]);
    await db.insert(equitySnapshots).values({ tradingDate: "2026-11-02", equity: "1001.25", recordedAt: new Date("2026-11-02T21:15:00Z") });
    await db.insert(thesisEvents).values({ thesisId: "aapl-1", symbol: "AAPL", kind: "stopped", strategyVersion: 1, reason: "test", at: new Date("2026-11-03T14:45:00Z") });
    await db.insert(capitalFlows).values([
      { activityId: "d1", at: new Date("2026-10-30T15:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" },
      { activityId: "d2", at: new Date("2026-11-04T15:00:00Z"), amount: "500", kind: "deposit", timedBy: "created_at", status: "canceled" },
      { activityId: "w1", at: new Date("2026-11-05T15:00:00Z"), amount: "-200", kind: "withdrawal", timedBy: "created_at", status: null },
    ]);

    const t = await exportTimeline(db, "production", new Date("2026-11-09T12:00:00Z"));
    expect(t.versions.map((v) => [v.version, v.authoredBy, v.at.toISOString(), v.raw])).toEqual([
      [1, "claude", "2026-11-02T13:00:00.000Z", true],
      [2, "owner", "2026-11-03T13:00:00.000Z", true],
    ]);
    expect(t.transfers.map((x) => [x.at.toISOString(), x.amount])).toEqual([["2026-10-30T15:00:00.000Z", "1000"], ["2026-11-05T15:00:00.000Z", "-200"]]);

    expect(t.actual).toEqual({
      fills: [{ at: new Date("2026-11-02T14:45:00Z"), symbol: "AAPL", side: "buy", qty: "2", price: "100.5" }],
      snapshots: [{ tradingDate: "2026-11-02", equity: "1001.25", recordedAt: new Date("2026-11-02T21:15:00Z") }],
      thesisEvents: [{ at: new Date("2026-11-03T14:45:00Z"), thesisId: "aapl-1", symbol: "AAPL", kind: "stopped" }],
    });

    expect(timelineSymbols(t)).toEqual(["AAPL", "MSFT", "NVDA", "QQQ", "SGOV", "VTI"]); // the thesis, the fixture's universe and defensive, VTI
    expect(timelineStart(t)).toBe("2026-11-02");

    const back = parseTimeline(serializeTimeline(t));
    expect(back).toEqual(t);
    expect(back.versions[0]!.at).toBeInstanceOf(Date);
    expect(back.actual!.snapshots[0]!.recordedAt).toBeInstanceOf(Date);
  }, 30_000); // a fresh database from every migration, then a dozen inserts: past vitest's 5s default on CI's runners
});
