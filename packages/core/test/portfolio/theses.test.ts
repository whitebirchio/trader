import { describe, expect, it } from "vitest";
import type { OpenLot } from "../../src/broker/lots.js";
import { averageCost, thesisStates } from "../../src/portfolio/theses.js";
import { strategy, thesis } from "./fixtures.js";

const created = new Date("2026-11-02T15:00:00Z");
const day = 86_400_000;
const lot = (symbol: string, qty: string, costBasis: string): OpenLot => ({ symbol, qty, costBasis, openedAt: created, activityId: "a" });

const run = (o: { lots?: OpenLot[]; close?: string; stopped?: string[]; now?: Date; stop?: string } = {}) =>
  thesisStates({
    active: { strategy: strategy({ conviction: [thesis({ stopLossPct: o.stop ?? "15" })] }), createdAt: created },
    stoppedIds: new Set(o.stopped ?? []),
    lots: o.lots ?? [lot("AAPL", "1", "200")],
    lastClose: o.close ? { AAPL: o.close } : {},
    now: o.now ?? new Date(created.getTime() + day),
  })[0];

describe("staleness", () => {
  it("counts from when the theses were last reaffirmed, not from a system version", () => {
    const states = thesisStates({
      active: { strategy: strategy(), createdAt: new Date(created.getTime() + 29 * day), reaffirmedAt: created },
      stoppedIds: new Set(),
      lots: [],
      lastClose: {},
      now: new Date(created.getTime() + 30 * day),
    });
    expect(states[0]).toMatchObject({ state: "stale", reason: "not reaffirmed for 30 days (limit 30)" });
  });
});

describe("averageCost", () => {
  it("is the basis-weighted cost of the open lots", () => {
    expect(averageCost([lot("AAPL", "1", "200"), lot("AAPL", "3", "660"), lot("MSFT", "1", "400")], "AAPL")).toBe("215");
    expect(averageCost([], "AAPL")).toBeNull();
  });
});

describe("thesisStates", () => {
  it("is active while the price is above the stop", () => {
    expect(run({ close: "171" })).toMatchObject({ state: "active" });
  });

  it("stops out at exactly the threshold", () => {
    // $200 cost, 15% stop → $170.
    expect(run({ close: "170" })).toMatchObject({
      state: "stopped",
      newlyStopped: true,
      reason: "AAPL closed at $170.00, at or below its 15% stop ($170.00 vs $200.00 average cost)",
    });
  });

  it("doesn't check the stop for a thesis not yet held, or without a price", () => {
    expect(run({ lots: [], close: "1" })).toMatchObject({ state: "active" });
    expect(run({})).toMatchObject({ state: "active" });
  });

  it("stays stopped once stopped, whatever the price does", () => {
    expect(run({ stopped: ["aapl-services"], close: "999" })).toMatchObject({ state: "stopped", newlyStopped: false });
  });

  it("goes stale at day 30, not 29, and staleness beats the stop", () => {
    expect(run({ now: new Date(created.getTime() + 29 * day + day - 1) })).toMatchObject({ state: "active" });
    expect(run({ now: new Date(created.getTime() + 30 * day), close: "1" })).toMatchObject({
      state: "stale",
      reason: "not reaffirmed for 30 days (limit 30)",
    });
  });

  it("resets staleness when a newer version reaffirms the thesis", () => {
    const later = new Date(created.getTime() + 40 * day);
    const states = thesisStates({
      active: { strategy: strategy(), createdAt: new Date(later.getTime() - 2 * day) },
      stoppedIds: new Set(),
      lots: [],
      lastClose: {},
      now: later,
    });
    expect(states[0]?.state).toBe("active");
  });
});

describe("review dates", () => {
  const withReview = (reviewBy: string, o: { now: Date; close?: string; stopped?: string[]; createdAt?: Date }) =>
    thesisStates({
      active: { strategy: strategy({ conviction: [thesis({ reviewBy })] }), createdAt: o.createdAt ?? created },
      stoppedIds: new Set(o.stopped ?? []),
      lots: [lot("AAPL", "1", "200")],
      lastClose: o.close ? { AAPL: o.close } : {},
      now: o.now,
    })[0];

  it("stands through its review date (New York time) and is overdue the day after", () => {
    // 11 PM ET on the review date is still that date in New York, though it's the next day in UTC.
    expect(withReview("2026-11-03", { now: new Date("2026-11-04T04:00:00Z") })).toMatchObject({ state: "active" });
    expect(withReview("2026-11-03", { now: new Date("2026-11-04T14:00:00Z") })).toMatchObject({
      state: "overdue",
      reason: "past its review date (2026-11-03) without a later one",
    });
  });

  it("is overdue whatever the price, but staleness and a stop-out come first", () => {
    const after = new Date("2026-11-10T15:00:00Z");
    expect(withReview("2026-11-03", { now: after, close: "1" })).toMatchObject({ state: "overdue" });
    expect(withReview("2026-11-03", { now: after, stopped: ["aapl-services"] })).toMatchObject({ state: "stopped" });
    expect(withReview("2026-11-03", { now: new Date(created.getTime() + 30 * day) })).toMatchObject({ state: "stale" });
  });

  it("reaffirming doesn't clear an overdue thesis; only a later review date does", () => {
    const now = new Date("2026-11-10T15:00:00Z");
    expect(withReview("2026-11-03", { now, createdAt: new Date("2026-11-09T15:00:00Z") })).toMatchObject({ state: "overdue" });
    expect(withReview("2026-12-01", { now, createdAt: new Date("2026-11-09T15:00:00Z") })).toMatchObject({ state: "active" });
  });
});

