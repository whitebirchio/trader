import { beforeEach, describe, expect, it } from "vitest";
import { capitalSummary, sameFlowsInBenchmark } from "../../src/capital/shadow.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, capitalFlows } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

const at = (iso: string) => new Date(iso);
const closes = [
  { tradingDate: "2026-04-20", close: "250" },
  { tradingDate: "2026-06-01", close: "275" },
  { tradingDate: "2026-11-02", close: "300" },
];

describe("sameFlowsInBenchmark", () => {
  it("buys VTI with each deposit at that market date's close and values it at the latest", () => {
    // $1000 at $250 = 4 sh; $550 at $275 = 2 sh; 6 sh × $300 = $1800.
    const flows = [
      { at: at("2026-04-20T15:00:00Z"), amount: "1000" },
      { at: at("2026-06-01T15:00:00Z"), amount: "550" },
    ];
    expect(sameFlowsInBenchmark(flows, closes)).toEqual({ contributed: "1550", sameFlowsInVti: "1800" });
  });

  it("sells VTI for a withdrawal", () => {
    const flows = [
      { at: at("2026-04-20T15:00:00Z"), amount: "1000" },
      { at: at("2026-06-01T15:00:00Z"), amount: "-275" },
    ];
    // 4 sh − 1 sh = 3 sh × $300.
    expect(sameFlowsInBenchmark(flows, closes)).toEqual({ contributed: "725", sameFlowsInVti: "900" });
  });

  it("uses the last close on or before the flow's market date (a weekend deposit buys at Friday's)", () => {
    const flows = [{ at: at("2026-06-07T19:00:00Z"), amount: "550" }]; // Sunday → the 06-01 close here
    expect(sameFlowsInBenchmark(flows, closes)).toEqual({ contributed: "550", sameFlowsInVti: "600" });
  });

  it("uses the first close after a flow older than every recorded close", () => {
    const flows = [{ at: at("2026-01-05T15:00:00Z"), amount: "500" }];
    expect(sameFlowsInBenchmark(flows, closes)).toEqual({ contributed: "500", sameFlowsInVti: "600" });
  });

  it("has no VTI figure without closes, and zeros without flows", () => {
    expect(sameFlowsInBenchmark([{ at: at("2026-04-20T15:00:00Z"), amount: "1000" }], [])).toEqual({ contributed: "1000", sameFlowsInVti: null });
    expect(sameFlowsInBenchmark([], closes)).toEqual({ contributed: "0", sameFlowsInVti: "0" });
  });
});

describe("capitalSummary", () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it("reads the ledger and recorded closes, leaving canceled transfers out", async () => {
    await db.insert(brokerActivities).values([
      { id: "a", type: "CSD", at: at("2026-04-20T15:00:00Z"), netAmount: "1000", raw: {} },
      { id: "b", type: "CSD", at: at("2026-06-01T15:00:00Z"), netAmount: "999", raw: {} },
    ]);
    await db.insert(capitalFlows).values([
      { activityId: "a", at: at("2026-04-20T15:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" },
      { activityId: "b", at: at("2026-06-01T15:00:00Z"), amount: "999", kind: "deposit", timedBy: "created_at", status: "canceled" },
    ]);
    await db.insert(benchmarkCloses).values(closes.map((c) => ({ symbol: "VTI", ...c })));
    expect(await capitalSummary(db, "1250.50")).toEqual({ contributed: "1000", value: "1250.50", sameFlowsInVti: "1200" });
  });

  it("is null before any transfer is recorded", async () => {
    expect(await capitalSummary(db, "0")).toBeNull();
  });
});
