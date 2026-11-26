import { beforeEach, describe, expect, it } from "vitest";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, thesisCloses } from "../../src/db/schema.js";
import type { HeldFlag } from "../../src/agent/held.js";
import { FLAG_TEXT, exitsFor, positionsView } from "../../src/dashboard/positions.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

describe("exitsFor", () => {
  const now = new Date("2026-11-25T18:00:00Z");
  const base = { averageCost: "200", price: "180", reaffirmedAt: new Date("2026-10-27T13:00:00Z"), flags: [] as HeldFlag[], now };

  it("gives the stop as a price and its distance, the review date and the stale date in days", () => {
    const e = exitsFor({ ...base, thesis: { stopLossPct: "15", reviewBy: "2026-11-25", exitIf: ["Services growth falls below 10% for two quarters"] } });
    expect(e.stop).toEqual({ price: "170", belowPct: "5.56" });
    expect(e.review).toEqual({ date: "2026-11-25", daysLeft: 0 }); // due today
    expect(e.stale).toEqual({ date: "2026-11-26", daysLeft: 1 }); // stale tomorrow
    expect(e.exitIf).toEqual(["Services growth falls below 10% for two quarters"]);
  });

  it("is at the stop when the price is, and says each flag in plain words", () => {
    const e = exitsFor({ ...base, price: "170", flags: ["near_stop", "insider_selling"], thesis: { stopLossPct: "15" } });
    expect(e.stop.belowPct).toBe("0");
    expect(e.review).toBeNull();
    expect(e.exitIf).toEqual([]);
    expect(e.flags).toEqual([
      { flag: "near_stop", text: FLAG_TEXT.near_stop },
      { flag: "insider_selling", text: FLAG_TEXT.insider_selling },
    ]);
  });
});

describe("positionsView", () => {
  const NOW = new Date("2026-11-02T15:35:00Z");
  let db: Db;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const broker = new FakeBroker();
    broker.now = NOW;
    // $1000: $200 of AAPL bought at 200 (now 175), $700 of VTI at 300, $100 cash.
    broker.fill("o1", "AAPL", "buy", "1", "200", new Date("2026-10-28T15:00:00Z"));
    broker.fill("o2", "VTI", "buy", "2.333333333", "300", new Date("2026-10-28T15:00:00Z"));
    broker.positions = [
      { symbol: "VTI", qty: "2.333333333", avgEntryPrice: "300", marketValue: "700", costBasis: "700", currentPrice: "300" },
      { symbol: "AAPL", qty: "1", avgEntryPrice: "200", marketValue: "175", costBasis: "200", currentPrice: "175" },
    ];
    broker.account = { ...broker.account, equity: "975", cash: "100" };
    await syncBroker(db, broker, "staging", NOW);
    await submitStrategy(db, strategy({ conviction: [thesis({ targetWeightPct: "20", stopLossPct: "15", reviewBy: "2026-12-15", headline: "Buying Apple because services keep compounding" })] }), "claude", new Date("2026-10-28T12:00:00Z"));
    await db.insert(thesisCloses).values([
      { symbol: "AAPL", tradingDate: "2026-10-28", close: "200" },
      { symbol: "AAPL", tradingDate: "2026-10-30", close: "175" },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-10-28", close: "300" },
      { symbol: "VTI", tradingDate: "2026-10-30", close: "300" },
    ]);
  });

  it("puts theses first with their headline, figures and exits, then the idle money in VTI", async () => {
    const v = await positionsView(db, NOW);
    expect(v.cards.map((c) => c.symbol)).toEqual(["AAPL", "VTI"]);
    const aapl = v.cards[0]!;
    expect(aapl).toMatchObject({ value: "175", weightPct: "17.95", targetPct: "20", thesisId: "aapl-services", headline: { text: "Buying Apple because services keep compounding", fallback: false } });
    expect(aapl.exits).toMatchObject({ stop: { price: "170", belowPct: "2.86" }, review: { date: "2026-12-15" } });
    // The fixture's forecast has no horizon of its own when a review date is set: it runs to the review date.
    expect(aapl.forecast).toEqual({ beatVtiPct: 55, expectedExcessPct: "4", horizon: "2026-12-15" });
    // 2.86% above the stop, and 12.5 points behind VTI since entry.
    expect(aapl.exits!.flags.map((f) => f.flag)).toEqual(expect.arrayContaining(["near_stop", "lagging_vti"]));
    expect(v.cards[1]).toMatchObject({ symbol: "VTI", thesisId: null, headline: null, exits: null, pnl: "0", vsVti: null });
  });
});
