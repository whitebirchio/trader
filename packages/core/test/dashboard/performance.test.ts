import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, capitalFlows, equitySnapshots } from "../../src/db/schema.js";
import { capitalSummary } from "../../src/capital/shadow.js";
import { moneyWindow, performanceView } from "../../src/dashboard/performance.js";
import { rangeFrom } from "../../src/dashboard/ranges.js";
import { createTestDb } from "../helpers.js";

const at = (date: string) => new Date(`${date}T21:00:00Z`);
let db: Db;

beforeEach(async () => {
  ({ db } = await createTestDb());
  // $1,000 in on Oct 29; $100 more on Nov 18. VTI rises 1% a step.
  await db.insert(brokerActivities).values([
    { id: "a", type: "CSD", at: new Date("2026-10-29T15:00:00Z"), netAmount: "1000", raw: {} },
    { id: "b", type: "CSD", at: new Date("2026-11-18T15:00:00Z"), netAmount: "100", raw: {} },
  ]);
  await db.insert(capitalFlows).values([
    { activityId: "a", at: new Date("2026-10-29T15:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" },
    { activityId: "b", at: new Date("2026-11-18T15:00:00Z"), amount: "100", kind: "deposit", timedBy: "created_at", status: "executed" },
  ]);
  const days: [string, string][] = [
    ["2026-10-29", "1000"],
    ["2026-11-02", "1010"],
    ["2026-11-16", "1030"],
    ["2026-11-20", "1140"],
    ["2026-11-24", "1150"],
    ["2026-11-25", "1145"],
  ];
  await db.insert(equitySnapshots).values(days.map(([tradingDate, equity]) => ({ tradingDate, equity, cash: "0", longMarketValue: equity, recordedAt: at(tradingDate) })));
  await db.insert(benchmarkCloses).values(days.map(([tradingDate], i) => ({ symbol: "VTI", tradingDate, close: String(300 + 3 * i) })));
});

describe("rangeFrom (the Performance ranges)", () => {
  it("counts calendar days back from the last close; 1d is the session before", () => {
    expect(rangeFrom("1d", "2026-11-30")).toBe("2026-11-29"); // a Monday's base is Friday's close
    expect(rangeFrom("7d", "2026-11-25")).toBe("2026-11-18");
    expect(rangeFrom("90d", "2026-11-25")).toBe("2026-08-27");
  });
});

describe("moneyWindow", () => {
  it("is the value change less what was added, against the same flows in VTI", () => {
    const start = { tradingDate: "2026-11-16", equity: "1030", recordedAt: at("2026-11-16") };
    const end = { tradingDate: "2026-11-25", equity: "1145", recordedAt: at("2026-11-25") };
    const closes = [
      { tradingDate: "2026-11-16", close: "300" },
      { tradingDate: "2026-11-18", close: "300" },
      { tradingDate: "2026-11-25", close: "330" },
    ];
    expect(moneyWindow(start, end, [{ at: new Date("2026-11-18T15:00:00Z"), amount: "100" }], closes)).toEqual({
      since: "2026-11-16",
      through: "2026-11-25",
      startValue: "1030",
      addedSince: "100",
      value: "1145",
      pnl: "15",
      sameFlowsInVti: "1243",
      vtiPnl: "113",
      gapUsd: "-98",
    });
  });
});

describe("performanceView", () => {
  it("gives every range's dollars, return and VTI at once; since start matches the capital summary", async () => {
    const v = await performanceView(db);
    const all = v.ranges.find((r) => r.range === "all")!;
    const summary = (await capitalSummary(db))!;
    expect(all).toMatchObject({ available: true, since: summary.since, through: summary.through, startValue: summary.startValue, value: summary.value, addedSince: summary.addedSince, sameFlowsInVti: summary.sameFlowsInVti });
    expect(all.pnl).toBe("45"); // 1145 − 1000 − 100
    const last = v.ranges.find((r) => r.range === "1d")!;
    expect(last).toMatchObject({ since: "2026-11-24", through: "2026-11-25", pnl: "-5" });
    // 7 days back from Nov 25 is Nov 18: the base is the last close on or before it (Nov 16), so the deposit counts.
    expect(v.ranges.find((r) => r.range === "7d")).toMatchObject({ since: "2026-11-16", addedSince: "100", pnl: "15" });
    expect(v.ranges.find((r) => r.range === "90d")).toMatchObject({ available: false, reason: "history starts 2026-10-29" });
    expect(v.ranges.map((r) => r.range)).toEqual(["1d", "7d", "30d", "60d", "90d", "ytd", "1y", "all"]);
  });

  it("reports nothing to compare before the first two sessions", async () => {
    ({ db } = await createTestDb());
    expect((await performanceView(db)).ranges.every((r) => !r.available)).toBe(true);
  });
});
