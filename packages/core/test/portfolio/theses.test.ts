import { describe, expect, it } from "vitest";
import type { OpenLot } from "../../src/broker/lots.js";
import { averageCost, bearCaseErrors, highSinceEntry, ledgerErrors, reviewDateErrors, thesisStates } from "../../src/portfolio/theses.js";
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

describe("reviewDateErrors", () => {
  const TODAY = "2026-11-08";
  const ev = (asOf?: string) => ({ kind: "fundamental" as const, summary: "Q3 beat and raised", ...(asOf ? { asOf } : {}) });
  const doc = (over: Parameters<typeof thesis>[0]) => strategy({ conviction: [thesis(over)] });
  const errs = (next: Parameters<typeof thesis>[0], before?: Parameters<typeof thesis>[0]) => reviewDateErrors(doc(next), before ? doc(before) : strategy({ conviction: [] }), TODAY);

  it("needs a new or changed date to be after today", () => {
    expect(errs({ reviewBy: "2026-11-09" })).toEqual([]);
    expect(errs({ reviewBy: "2026-11-08" })).toEqual(["conviction[0].reviewBy: 2026-11-08 must be after today (2026-11-08)"]);
    expect(errs({ reviewBy: "2026-11-01" }, { reviewBy: "2026-12-01" })).toEqual(["conviction[0].reviewBy: 2026-11-01 must be after today (2026-11-08)"]);
  });

  it("lets an unchanged date through even once it has passed (that thesis stays overdue)", () => {
    expect(errs({ reviewBy: "2026-11-01" }, { reviewBy: "2026-11-01" })).toEqual([]);
  });

  it("keeps a review date once a thesis has one", () => {
    expect(errs({}, { reviewBy: "2026-12-01" })).toEqual([
      'conviction[0].reviewBy: thesis "aapl-services" had a review date (2026-12-01); keep one, and move it later only with fresh evidence',
    ]);
    expect(errs({ reviewBy: "2026-12-01" }, {})).toEqual([]); // adding one to an existing thesis is fine
  });

  it("moves a date later only with evidence dated after everything the thesis cited before", () => {
    const before = { reviewBy: "2026-12-01", evidence: [ev("2026-10-30"), ev("2026-11-02")] };
    expect(errs({ reviewBy: "2027-01-15", evidence: before.evidence }, before)).toEqual([
      "conviction[0].reviewBy: moving it from 2026-12-01 to 2027-01-15 needs new evidence dated after 2026-11-02 (add a dated source)",
    ]);
    expect(errs({ reviewBy: "2027-01-15", evidence: [...before.evidence, ev("2026-11-02")] }, before)).toHaveLength(1); // the same day isn't newer
    expect(errs({ reviewBy: "2027-01-15", evidence: [...before.evidence, ev()] }, before)).toHaveLength(1); // undated doesn't count
    expect(errs({ reviewBy: "2027-01-15", evidence: [...before.evidence, ev("2026-11-06")] }, before)).toEqual([]);
    expect(errs({ reviewBy: "2027-01-15", evidence: [ev("2026-11-06")] }, { reviewBy: "2026-12-01", evidence: [ev()] })).toEqual([]); // nothing dated before
  });

  it("allows moving a date earlier without new evidence", () => {
    expect(errs({ reviewBy: "2026-11-20" }, { reviewBy: "2026-12-01" })).toEqual([]);
  });
});


describe("trailing stop and profit target (#35)", () => {
  const close = (daysAfter: number, c: string) => ({ t: new Date(created.getTime() + daysAfter * day), c });
  // Bought at 200. A higher close before the buy doesn't count.
  const closes = [close(-3, "300"), close(0, "200"), close(1, "260"), close(2, "250")];
  const run35 = (over: { trailingStopPct?: string; takeProfitPct?: string }, last: string, o: { closes?: typeof closes | null; stop?: string } = {}) =>
    thesisStates({
      active: { strategy: strategy({ conviction: [thesis({ stopLossPct: o.stop ?? "15", ...over })] }), createdAt: created },
      stoppedIds: new Set(),
      lots: [lot("AAPL", "1", "200")],
      lastClose: { AAPL: last },
      ...(o.closes === null ? {} : { closes: { AAPL: [...(o.closes ?? closes), close(3, last)] } }),
      now: new Date(created.getTime() + 3 * day),
    })[0];

  it("finds the highest close since the first lot's session", () => {
    expect(highSinceEntry([lot("AAPL", "1", "200")], "AAPL", closes)).toBe("260");
    expect(highSinceEntry([], "AAPL", closes)).toBeNull();
    expect(highSinceEntry([lot("AAPL", "1", "200")], "AAPL", undefined)).toBeNull();
  });

  it("closes a thesis at its trailing stop below the high since entry, even at a profit", () => {
    expect(run35({ trailingStopPct: "10" }, "234.01")).toMatchObject({ state: "active" });
    expect(run35({ trailingStopPct: "10" }, "234")).toMatchObject({
      state: "stopped",
      newlyStopped: true,
      trigger: "trailing_stopped",
      price: "234",
      averageCost: "200",
      reason: "AAPL closed at $234.00, at or below its 10% trailing stop ($234.00, from a high close of $260.00 since it was bought)",
    });
  });

  it("doesn't check a trailing stop without the closes, and the stop-loss comes first when both are hit", () => {
    expect(run35({ trailingStopPct: "10" }, "220", { closes: null })).toMatchObject({ state: "active" });
    expect(run35({ trailingStopPct: "10" }, "170")).toMatchObject({ state: "stopped", trigger: "stopped" });
  });

  it("closes a thesis at its profit target above average cost", () => {
    expect(run35({ takeProfitPct: "30" }, "259.99", { closes: [close(0, "200")] })).toMatchObject({ state: "active" });
    expect(run35({ takeProfitPct: "30" }, "260", { closes: [close(0, "200")] })).toMatchObject({
      state: "stopped",
      newlyStopped: true,
      trigger: "took_profit",
      reason: "AAPL closed at $260.00, at or above its 30% profit target ($260.00 vs $200.00 average cost)",
    });
  });

  it("leaves a thesis without either field alone", () => {
    expect(run35({}, "400")).toMatchObject({ state: "active" });
  });
});

describe("bearCaseErrors (#106)", () => {
  const doc = (over: Parameters<typeof thesis>[0]) => strategy({ conviction: [thesis(over)] });
  const none = { bearCase: undefined };

  it("needs a bear case on a new thesis and on a raised weight", () => {
    expect(bearCaseErrors(doc(none), strategy({ conviction: [] }))).toEqual(["conviction[0].bearCase: a new thesis (aapl-services) needs a bear case: the strongest case against it right now, and why it doesn't win"]);
    expect(bearCaseErrors(doc({ ...none, targetWeightPct: "15" }), doc({ ...none, targetWeightPct: "10" }))).toEqual([
      "conviction[0].bearCase: raising aapl-services from 10% to 15% needs a bear case: the strongest case against it right now, and why it doesn't win",
    ]);
  });

  it("leaves a held thesis at the same or a lower weight alone, and accepts any thesis that has one", () => {
    expect(bearCaseErrors(doc(none), doc(none))).toEqual([]);
    expect(bearCaseErrors(doc({ ...none, targetWeightPct: "5" }), doc(none))).toEqual([]);
    expect(bearCaseErrors(doc({ targetWeightPct: "20" }), strategy({ conviction: [] }))).toEqual([]);
  });
});


describe("ledgerErrors (forecast ledger)", () => {
  const doc = (over: Parameters<typeof thesis>[0]) => strategy({ conviction: [thesis(over)] });
  const empty = strategy({ conviction: [] });
  const today = "2026-11-13";

  it("needs a lead signal and a forecast on every thesis, new or held", () => {
    expect(ledgerErrors(doc({ leadSignal: undefined, forecast: undefined }), doc({}), today)).toEqual([
      "conviction[0].leadSignal: aapl-services needs a lead signal: the kind of evidence that surfaced the idea and carries the case",
      "conviction[0].forecast: aapl-services needs a forecast: the chance (5–95%) it beats VTI by its horizon, and the expected excess",
    ]);
    expect(ledgerErrors(doc({}), empty, today)).toEqual([]);
  });

  it("wants a new or changed horizon after today, but lets an unchanged one pass after it", () => {
    const past = { beatVtiPct: 60, expectedExcessPct: "5", horizon: "2026-11-13" };
    expect(ledgerErrors(doc({ forecast: past }), empty, today)).toEqual(["conviction[0].forecast.horizon: 2026-11-13 must be after today (2026-11-13)"]);
    expect(ledgerErrors(doc({ forecast: past }), doc({ forecast: past }), today)).toEqual([]);
    expect(ledgerErrors(doc({ forecast: { ...past, beatVtiPct: 65 } }), doc({ forecast: past }), today)).toHaveLength(1);
  });
});
