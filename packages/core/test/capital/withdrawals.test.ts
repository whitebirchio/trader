import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CalendarDay } from "../../src/broker/port.js";
import {
  type AccountView,
  ROUTINE_CRON_UTC,
  type Withdrawal,
  advance,
  fundingDeadline,
  matchOutflows,
  outstanding,
  parseAmount,
  settlesAt,
  unsettledProceeds,
} from "../../src/capital/withdrawals.js";
import { marketTimeToUtc } from "../../src/time.js";

const day = (date: string): CalendarDay => ({ date, open: marketTimeToUtc(date, "09:30"), close: marketTimeToUtc(date, "16:00") });
// 2026-11-02 is a Monday. Thanksgiving is Thursday 2026-11-26.
const NOV = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-25", "2026-11-27", "2026-11-30"].map(day);

describe("fundingDeadline", () => {
  it("is the next routine run plus an hour", () => {
    // Monday 07:00 ET → the 8:00 ET (13:00 UTC) run → 9:00 ET.
    expect(fundingDeadline(marketTimeToUtc("2026-11-02", "07:00"), NOV)).toEqual(marketTimeToUtc("2026-11-02", "09:00"));
    // Monday 10:00 ET → the 12:00 ET run → 13:00 ET.
    expect(fundingDeadline(marketTimeToUtc("2026-11-02", "10:00"), NOV)).toEqual(marketTimeToUtc("2026-11-02", "13:00"));
    // Monday 12:00 ET exactly: that run has started without it → Tuesday's first.
    expect(fundingDeadline(marketTimeToUtc("2026-11-02", "12:00"), NOV)).toEqual(marketTimeToUtc("2026-11-03", "09:00"));
  });

  it("skips the weekend and market holidays", () => {
    expect(fundingDeadline(marketTimeToUtc("2026-11-06", "15:00"), NOV)).toEqual(marketTimeToUtc("2026-11-09", "09:00")); // Fri → Mon
    expect(fundingDeadline(marketTimeToUtc("2026-11-25", "14:00"), NOV)).toEqual(marketTimeToUtc("2026-11-27", "09:00")); // Wed → Fri, past Thanksgiving
  });

  it("falls back to a day later without a calendar", () => {
    const at = marketTimeToUtc("2026-11-02", "07:00");
    expect(fundingDeadline(at, [])).toEqual(new Date(at.getTime() + 86_400_000));
  });

  it("matches the routine cron in SPEC-agent", () => {
    const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../SPEC-agent.md"), "utf8");
    expect(spec).toContain(`cron \`0 ${ROUTINE_CRON_UTC.hours.join(",")} * * 1-5\` UTC`);
  });
});

describe("parseAmount", () => {
  it("accepts dollars and cents, and all", () => {
    expect(parseAmount("500")).toEqual({ ok: true, amount: "500" });
    expect(parseAmount(" 500.25 ")).toEqual({ ok: true, amount: "500.25" });
    expect(parseAmount("ALL")).toEqual({ ok: true, amount: null });
  });

  it("rejects anything else rather than guessing", () => {
    for (const bad of [null, "", "-5", "1e3", "$500", "500.255", "0.50", "five"]) expect(parseAmount(bad).ok).toBe(false);
  });
});

describe("outstanding", () => {
  it("is the amount less what has gone, floored at zero, or the whole account for all", () => {
    expect(outstanding({ amount: "500", withdrawn: "200" }, "1000")).toBe("300");
    expect(outstanding({ amount: "500", withdrawn: "600" }, "1000")).toBe("0");
    expect(outstanding({ amount: null, withdrawn: "0" }, "1000.50")).toBe("1000.50");
  });
});

describe("settlement", () => {
  it("settles at the next trading day's close", () => {
    expect(settlesAt(marketTimeToUtc("2026-11-06", "10:00"), NOV)).toEqual(marketTimeToUtc("2026-11-09", "16:00"));
    expect(settlesAt(marketTimeToUtc("2026-11-30", "10:00"), NOV)).toBeNull();
  });

  it("counts proceeds until they settle", () => {
    const sells = [
      { at: marketTimeToUtc("2026-11-02", "10:00"), qty: "1", price: "300" },
      { at: marketTimeToUtc("2026-11-03", "10:00"), qty: "0.5", price: "300.015" },
    ];
    expect(unsettledProceeds(sells, NOV, marketTimeToUtc("2026-11-03", "12:00"))).toEqual({ amount: "450.01", settledBy: marketTimeToUtc("2026-11-04", "16:00") });
    expect(unsettledProceeds(sells, NOV, marketTimeToUtc("2026-11-03", "16:00"))).toEqual({ amount: "150.01", settledBy: marketTimeToUtc("2026-11-04", "16:00") });
    expect(unsettledProceeds(sells, NOV, marketTimeToUtc("2026-11-04", "16:00"))).toEqual({ amount: "0", settledBy: null });
  });
});

const REQUESTED = marketTimeToUtc("2026-11-02", "10:00");
const request = (over: Partial<Withdrawal> = {}): Withdrawal => ({
  id: "w1",
  status: "planning",
  amount: "500",
  withdrawn: "0",
  flowIds: [],
  commandId: "c1",
  requestedAt: REQUESTED,
  deadline: marketTimeToUtc("2026-11-02", "13:00"),
  fundingVersion: null,
  fundedBy: null,
  updatedAt: REQUESTED,
  closedAt: null,
  ...over,
});
const account = (over: Partial<AccountView> = {}): AccountView => ({
  equity: "1000",
  cash: "0",
  unsettled: { amount: "0", settledBy: null },
  longMarketValue: "1000",
  openOrders: 0,
  plan: null,
  ...over,
});
const at = (time: string) => marketTimeToUtc("2026-11-02", time);

describe("matchOutflows", () => {
  const flow = (id: string, amount: string, time = "14:00") => ({ activityId: id, at: at(time), amount });

  it("completes on a transfer covering the amount", () => {
    expect(matchOutflows(request(), [flow("f1", "-500")], "500")).toMatchObject({ status: "complete", withdrawn: "500", flowIds: ["f1"] });
  });

  it("leaves the rest open after a smaller one, and adds the next", () => {
    const first = matchOutflows(request(), [flow("f1", "-200")], "800");
    expect(first).toMatchObject({ status: "partial", withdrawn: "200", flowIds: ["f1"] });
    const w = request({ withdrawn: "200", flowIds: ["f1"] });
    expect(matchOutflows(w, [flow("f1", "-200"), flow("f2", "-300")], "500")).toMatchObject({ status: "complete", withdrawn: "500", flowIds: ["f1", "f2"] });
  });

  it("ignores transfers from before the request, and inflows", () => {
    expect(matchOutflows(request(), [flow("old", "-500", "09:59"), flow("in", "500")], "1000")).toEqual({ status: "none" });
  });

  it("completes all once the account is empty", () => {
    expect(matchOutflows(request({ amount: null }), [flow("f1", "-999.80")], "0.20")).toMatchObject({ status: "complete" });
    expect(matchOutflows(request({ amount: null }), [flow("f1", "-500")], "499.80")).toMatchObject({ status: "partial" });
  });
});

describe("advance", () => {
  it("waits for Claude's plan until the deadline, then asks for the fallback", () => {
    expect(advance(request(), account(), at("12:00"))).toMatchObject({ status: "unchanged", reason: expect.stringContaining("waiting for Claude's plan") });
    expect(advance(request(), account(), at("13:00"))).toMatchObject({ status: "fallback_due" });
  });

  it("moves to funding on the first strategy since the request", () => {
    expect(advance(request(), account({ plan: { version: 7, authoredBy: "claude" } }), at("12:00"))).toEqual({
      status: "advanced",
      to: "funding",
      reason: "strategy v7 (claude) plans the sells",
      fundingVersion: 7,
      fundedBy: "claude",
    });
  });

  it("skips straight to ready when settled cash already covers it", () => {
    expect(advance(request(), account({ cash: "600", longMarketValue: "400" }), at("12:00"))).toMatchObject({ status: "advanced", to: "ready" });
  });

  it("funds, then settles, then is ready", () => {
    const funding = request({ status: "funding" });
    expect(advance(funding, account({ cash: "312.40" }), at("12:00"))).toEqual({ status: "unchanged", reason: "cash $312.40 of $500.00" });
    const settledBy = marketTimeToUtc("2026-11-03", "16:00");
    const selling = account({ cash: "510", longMarketValue: "490", unsettled: { amount: "510", settledBy } });
    expect(advance(funding, selling, at("12:00"))).toMatchObject({ status: "advanced", to: "settling" });
    expect(advance(request({ status: "settling" }), selling, at("12:00"))).toMatchObject({ status: "unchanged", reason: expect.stringContaining("should settle by Tue, Nov 3") });
    const settled = account({ cash: "510", longMarketValue: "490" });
    expect(advance(request({ status: "settling" }), settled, at("12:00"))).toMatchObject({ status: "advanced", to: "ready" });
  });

  it("measures what's left after a partial withdrawal", () => {
    const w = request({ status: "funding", withdrawn: "200" });
    expect(advance(w, account({ cash: "300", longMarketValue: "500" }), at("12:00"))).toMatchObject({ status: "advanced", to: "ready" });
  });

  it("stays ready until the money leaves", () => {
    expect(advance(request({ status: "ready" }), account({ cash: "500" }), at("12:00"))).toEqual({
      status: "unchanged",
      reason: "waiting for you to withdraw $500.00 in Alpaca",
    });
  });

  it("sells everything for all, without waiting for a plan", () => {
    const all = request({ amount: null });
    expect(advance(all, account(), at("10:05"))).toMatchObject({ status: "advanced", to: "funding", fundedBy: "system" });
    const funding = request({ amount: null, status: "funding" });
    expect(advance(funding, account({ cash: "600", longMarketValue: "400" }), at("12:00"))).toMatchObject({ status: "unchanged", reason: "$400.00 still to sell" });
    expect(advance(funding, account({ cash: "1000", longMarketValue: "0", openOrders: 1 }), at("12:00"))).toMatchObject({ status: "unchanged" });
    const sold = account({ cash: "1000", longMarketValue: "0", unsettled: { amount: "400", settledBy: marketTimeToUtc("2026-11-03", "16:00") } });
    expect(advance(funding, sold, at("12:00"))).toMatchObject({ status: "advanced", to: "settling" });
    expect(advance(request({ amount: null, status: "settling" }), account({ cash: "1000", longMarketValue: "0" }), at("12:00"))).toMatchObject({ status: "advanced", to: "ready" });
  });

  it("does nothing with a closed request", () => {
    expect(advance(request({ status: "cancelled" }), account(), at("12:00"))).toMatchObject({ status: "unchanged" });
  });
});
