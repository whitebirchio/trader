import { describe, expect, it } from "vitest";
import { type DailyEquity, type IndexFlow, buildIndex, liveIndex } from "../../src/risk/equity-index.js";
import { marketTimeToUtc } from "../../src/time.js";

/** An equity snapshot as sync-broker writes it: 15 minutes after the close. */
const snap = (tradingDate: string, equity: string): DailyEquity => ({ tradingDate, equity, recordedAt: marketTimeToUtc(tradingDate, "16:15") });
const flowAt = (date: string, time: string, amount: string): IndexFlow => ({ at: marketTimeToUtc(date, time), amount });

// 2026-11-02 is a Monday; 2026-10-30 the Friday before.

describe("buildIndex", () => {
  it("is unmoved by a deposit during the session (counted in that day's step)", () => {
    const state = buildIndex([snap("2026-11-02", "1000"), snap("2026-11-03", "2000")], [flowAt("2026-11-03", "10:00", "1000")]);
    expect(state.points.map((p) => p.index)).toEqual(["1", "1"]);
  });

  it("is unmoved by a deposit after a snapshot was recorded (overnight, counted the next day)", () => {
    // The paper-journal shape: lands at 04:21 ET, after the 16:15 snapshot of the day before.
    const state = buildIndex(
      [snap("2026-11-02", "1000"), snap("2026-11-03", "1000"), snap("2026-11-04", "2000")],
      [flowAt("2026-11-04", "04:21", "1000")],
    );
    expect(state.points.map((p) => p.index)).toEqual(["1", "1", "1"]);
  });

  it("is unmoved by a weekend deposit booked for Monday (the live April shape)", () => {
    // Created Sunday 15:54 ET, booked Monday: belongs between Friday's and Monday's snapshots.
    const state = buildIndex([snap("2026-10-30", "1000"), snap("2026-11-02", "2000")], [flowAt("2026-11-01", "15:54", "1000")]);
    expect(state.points.map((p) => p.index)).toEqual(["1", "1"]);
    expect(state.peak).toBe("1");
  });

  it("is unmoved by a 40% withdrawal", () => {
    const state = buildIndex([snap("2026-11-02", "1000"), snap("2026-11-03", "660")], [flowAt("2026-11-03", "11:00", "-400")]);
    // +6% on the $1000, then $400 out: index × (660 + 400) / 1000.
    expect(state.points.map((p) => p.index)).toEqual(["1", "1.06"]);
  });

  it("tracks returns and the running peak, in any input order", () => {
    const state = buildIndex([snap("2026-11-04", "900"), snap("2026-11-02", "1000"), snap("2026-11-03", "1200")], []);
    expect(state.points.map((p) => p.index)).toEqual(["1", "1.2", "0.9"]);
    expect(state.peak).toBe("1.2");
  });

  it("carries the index through an empty account (before the first deposit settles)", () => {
    const state = buildIndex([snap("2026-11-02", "0"), snap("2026-11-03", "1000")], [flowAt("2026-11-03", "10:00", "1000")]);
    expect(state.points.map((p) => p.index)).toEqual(["1", "1"]);
  });
});

describe("liveIndex", () => {
  const history = buildIndex([snap("2026-10-30", "1000"), snap("2026-11-02", "1250")], []);
  const tuesday = (time: string) => marketTimeToUtc("2026-11-03", time);

  it("measures a fall from the peak as drawdown and against the prior close as daily change", () => {
    expect(liveIndex(history, { equity: "1000", asOf: tuesday("11:00"), flows: [], fallbackPriorClose: "1250" })).toEqual({
      drawdownPct: "20",
      dailyChangePct: "-20",
    });
  });

  it("ignores a deposit as large as the account in both measures", () => {
    const flows = [flowAt("2026-11-03", "10:00", "1250")];
    expect(liveIndex(history, { equity: "2500", asOf: tuesday("11:00"), flows, fallbackPriorClose: "1250" })).toEqual({ drawdownPct: "0", dailyChangePct: "0" });
  });

  it("ignores a 40% withdrawal in both measures", () => {
    const flows = [flowAt("2026-11-03", "10:00", "-500")];
    expect(liveIndex(history, { equity: "750", asOf: tuesday("11:00"), flows, fallbackPriorClose: "1250" })).toEqual({ drawdownPct: "0", dailyChangePct: "0" });
  });

  it("counts an overnight deposit (after the last snapshot) in today's measures", () => {
    const flows = [flowAt("2026-11-03", "04:21", "1250")];
    expect(liveIndex(history, { equity: "2500", asOf: tuesday("11:00"), flows, fallbackPriorClose: "1250" })).toEqual({ drawdownPct: "0", dailyChangePct: "0" });
  });

  it("leaves out a flow recorded after the equity it's compared with was read", () => {
    // Equity was read at 10:00; a deposit at 10:05 isn't in it yet.
    const flows = [flowAt("2026-11-03", "10:05", "1250")];
    expect(liveIndex(history, { equity: "1250", asOf: tuesday("10:00"), flows, fallbackPriorClose: "1250" })).toEqual({ drawdownPct: "0", dailyChangePct: "0" });
  });

  it("after today's snapshot, reports today's index and measures the day against the previous snapshot", () => {
    const withToday = buildIndex([snap("2026-10-30", "1000"), snap("2026-11-02", "1250"), snap("2026-11-03", "1000")], []);
    expect(liveIndex(withToday, { equity: "1000", asOf: tuesday("16:20"), flows: [], fallbackPriorClose: "1250" })).toEqual({
      drawdownPct: "20",
      dailyChangePct: "-20",
    });
  });

  it("before any snapshot, uses Alpaca's prior-close equity with zero drawdown", () => {
    const empty = buildIndex([], []);
    expect(liveIndex(empty, { equity: "950", asOf: tuesday("11:00"), flows: [], fallbackPriorClose: "1000" })).toEqual({ drawdownPct: "0", dailyChangePct: "-5" });
    // A deposit earlier today still doesn't count as a gain.
    expect(liveIndex(empty, { equity: "1950", asOf: tuesday("11:00"), flows: [flowAt("2026-11-03", "09:00", "1000")], fallbackPriorClose: "1000" }).dailyChangePct).toBe("-5");
  });

  it("reports a new high as zero drawdown", () => {
    expect(liveIndex(history, { equity: "1300", asOf: tuesday("11:00"), flows: [], fallbackPriorClose: "1250" }).drawdownPct).toBe("0");
  });

  it("does not divide by an empty prior close", () => {
    const empty = buildIndex([], []);
    expect(liveIndex(empty, { equity: "1000", asOf: tuesday("11:00"), flows: [], fallbackPriorClose: "0" }).dailyChangePct).toBe("0");
  });
});
