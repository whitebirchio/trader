import { beforeEach, describe, expect, it } from "vitest";
import { capitalSummary, sameMoneyInBenchmark } from "../../src/capital/shadow.js";
import type { Db } from "../../src/db/client.js";
import { benchmarkCloses, brokerActivities, capitalFlows, equitySnapshots } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";

const at = (iso: string) => new Date(iso);
const closes = [
  { tradingDate: "2026-04-17", close: "200" },
  { tradingDate: "2026-10-30", close: "250" },
  { tradingDate: "2026-11-02", close: "275" },
  { tradingDate: "2026-11-03", close: "300" },
];
const snap = (tradingDate: string, equity: string, recordedAt: string) => ({ tradingDate, equity, recordedAt: at(recordedAt) });
const BASE = snap("2026-10-30", "1000", "2026-10-30T20:00:00Z");
const END = snap("2026-11-03", "1100", "2026-11-03T21:05:00Z");

describe("sameMoneyInBenchmark", () => {
  it("buys VTI with the start equity at the start close and values it at the end close", () => {
    // $1000 at $250 = 4 sh × $300.
    expect(sameMoneyInBenchmark(BASE, END, [], closes)).toEqual({ addedSince: "0", sameFlowsInVti: "1200" });
  });

  it("ignores transfers before the window: the deposit date isn't the start", () => {
    // An April deposit at $200 would have been 5 sh; the money sat in cash until Oct 30, so it's 4 sh.
    const flows = [{ at: at("2026-04-17T15:00:00Z"), amount: "1000" }];
    expect(sameMoneyInBenchmark(BASE, END, flows, closes)).toEqual({ addedSince: "0", sameFlowsInVti: "1200" });
  });

  it("buys or sells VTI for each transfer inside the window at its market date's close", () => {
    // 4 sh + $550 at $275 (2 sh) − $275 at $275 (1 sh) = 5 sh × $300.
    const flows = [
      { at: at("2026-11-02T15:00:00Z"), amount: "550" },
      { at: at("2026-11-02T16:00:00Z"), amount: "-275" },
    ];
    expect(sameMoneyInBenchmark(BASE, END, flows, closes)).toEqual({ addedSince: "275", sameFlowsInVti: "1500" });
  });

  it("leaves out transfers after the end snapshot (they aren't in its equity either)", () => {
    const flows = [{ at: at("2026-11-04T15:00:00Z"), amount: "500" }];
    expect(sameMoneyInBenchmark(BASE, END, flows, closes)).toEqual({ addedSince: "0", sameFlowsInVti: "1200" });
  });

  it("has no VTI figure without a close on or before the start", () => {
    expect(sameMoneyInBenchmark(BASE, END, [], [])).toEqual({ addedSince: "0", sameFlowsInVti: null });
    expect(sameMoneyInBenchmark(BASE, END, [], closes.slice(2))).toEqual({ addedSince: "0", sameFlowsInVti: null });
  });
});

describe("capitalSummary", () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(brokerActivities).values([
      { id: "a", type: "CSD", at: at("2026-04-17T15:00:00Z"), netAmount: "1000", raw: {} },
      { id: "b", type: "CSD", at: at("2026-11-02T15:00:00Z"), netAmount: "999", raw: {} },
    ]);
    await db.insert(capitalFlows).values([
      { activityId: "a", at: at("2026-04-17T15:00:00Z"), amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" },
      { activityId: "b", at: at("2026-11-02T15:00:00Z"), amount: "999", kind: "deposit", timedBy: "created_at", status: "canceled" },
    ]);
    await db.insert(benchmarkCloses).values(closes.map((c) => ({ symbol: "VTI", ...c })));
  });

  it("compares over the index's window, close to close, leaving canceled transfers out", async () => {
    await db.insert(equitySnapshots).values([
      { ...BASE, cash: null, longMarketValue: null },
      { ...END, cash: "0", longMarketValue: "1100" },
    ]);
    expect(await capitalSummary(db)).toEqual({
      contributed: "1000",
      since: "2026-10-30",
      through: "2026-11-03",
      startValue: "1000",
      addedSince: "0",
      value: "1100",
      sameFlowsInVti: "1200",
    });
  });

  it("has only the all-time total before the first snapshot", async () => {
    expect(await capitalSummary(db)).toEqual({ contributed: "1000", since: null, through: null, startValue: null, addedSince: "0", value: null, sameFlowsInVti: null });
  });

  it("is null before any transfer is recorded", async () => {
    ({ db } = await createTestDb());
    expect(await capitalSummary(db)).toBeNull();
  });
});
