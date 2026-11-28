import { describe, expect, it } from "vitest";
import {
  type SignalEvent,
  activeSignals,
  buildTimeline,
  countSlope,
  firstAnchors,
  freshCrash,
  latestOnOrBefore,
  pairEntries,
  qualityPercentile,
  screened,
} from "../../src/research/combos.js";

const ev = (symbol: string, kind: SignalEvent["kind"], date: string): SignalEvent => ({ symbol, kind, date });
const timeline = (events: SignalEvent[], momentumTop: Record<string, string[]> = {}, quality: Record<string, Record<string, number>> = {}) =>
  buildTimeline(
    events,
    { dates: Object.keys(momentumTop), top: new Map(Object.entries(momentumTop).map(([d, s]) => [d, new Set(s)])) },
    { dates: Object.keys(quality), pct: new Map(Object.entries(quality).map(([d, m]) => [d, new Map(Object.entries(m))])) },
  );

describe("activeSignals", () => {
  it("counts an event up to 90 days back, not 91, and never a later one", () => {
    const t = timeline([ev("ICE", "thirteenF", "2026-01-01"), ev("ICE", "earnings", "2026-04-02")]);
    expect(activeSignals(t, "ICE", "2026-04-01", "insider")).toEqual(["thirteenF"]); // 90 days after Jan 1
    expect(activeSignals(t, "ICE", "2026-04-02", "insider")).toEqual(["earnings"]); // 91 days: the 13F has lapsed
    expect(activeSignals(t, "ICE", "2025-12-31", "insider")).toEqual([]); // not public yet
  });

  it("leaves out the anchor's own kind", () => {
    const t = timeline([ev("ICE", "insider", "2026-03-01"), ev("ICE", "thirteenF", "2026-03-10")]);
    expect(activeSignals(t, "ICE", "2026-03-10", "thirteenF")).toEqual(["insider"]);
  });

  it("counts a state only while it holds: momentum by its latest month-end, quality by its latest April at the top decile", () => {
    const t = timeline([], { "2026-01-30": ["ICE"], "2026-02-27": ["DAL"] }, { "2025-04-30": { ICE: 0.95, DAL: 0.89 } });
    expect(activeSignals(t, "ICE", "2026-02-15")).toEqual(["momentum", "quality"]);
    expect(activeSignals(t, "ICE", "2026-03-02")).toEqual(["quality"]); // dropped out of the top decile at Feb's month-end
    expect(activeSignals(t, "DAL", "2026-03-02")).toEqual(["momentum"]); // 0.89 isn't the top decile
    expect(activeSignals(t, "ICE", "2025-01-15")).toEqual([]); // before any formation
    expect(qualityPercentile(t, "DAL", "2026-01-01")).toBe(0.89);
  });
});

describe("firstAnchors", () => {
  it("keeps the first anchor per stock in each 90 days", () => {
    const kept = firstAnchors([
      ev("ICE", "insider", "2026-01-01"),
      ev("ICE", "thirteenF", "2026-02-15"), // within 90 days of Jan 1: dropped
      ev("ICE", "earnings", "2026-04-02"), // 91 days on: kept
      ev("DAL", "insider", "2026-01-20"),
    ]);
    expect(kept.map((a) => `${a.symbol} ${a.date}`)).toEqual(["ICE 2026-01-01", "DAL 2026-01-20", "ICE 2026-04-02"]);
  });
});

describe("pairEntries", () => {
  it("enters a pair on the later signal's date, once per stock per 90 days, and not past 90 days apart", () => {
    const t = timeline([
      ev("ICE", "insider", "2026-01-10"),
      ev("ICE", "thirteenF", "2026-02-14"),
      ev("ICE", "insider", "2026-02-20"), // a second pairing inside the same window: dropped
      ev("DAL", "insider", "2026-01-01"),
      ev("DAL", "thirteenF", "2026-04-02"), // 91 days apart: no pair
    ]);
    const pairs = pairEntries(t, "insider", "thirteenF");
    expect(pairs.map((p) => [p.symbol, p.first.kind, p.second.kind, p.date])).toEqual([["ICE", "insider", "thirteenF", "2026-02-14"]]);
  });
});

describe("the warning screens", () => {
  const sessions = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-16", "2026-03-17"];

  it("flags a crash within the 10 sessions up to the date, not the 11th back", () => {
    expect(freshCrash(["2026-03-03"], sessions, "2026-03-16")).toBe(true); // the 10th session back, counting the date
    expect(freshCrash(["2026-03-02"], sessions, "2026-03-16")).toBe(false); // the 11th
    expect(freshCrash(["2026-03-17"], sessions, "2026-03-16")).toBe(false); // after the date
    expect(freshCrash(["2026-03-13"], sessions, "2026-03-15")).toBe(true); // a weekend date uses the session before
  });

  it("drops exactly the flagged anchors", () => {
    const anchors = [ev("ICE", "insider", "2026-03-10"), ev("DAL", "insider", "2026-03-10")];
    expect(screened(anchors, (a) => a.symbol === "DAL")).toEqual([anchors[0]]);
  });
});

describe("countSlope", () => {
  it("averages each month's slope of group means against the count, with a standard error across months", () => {
    const rows = [
      // Month 1: means 0.00, 0.01, 0.02 at counts 0, 1, 2: slope 0.01 (two rows at count 1 average to 0.01).
      { month: "2026-01", count: 0, value: 0 },
      { month: "2026-01", count: 1, value: 0.005 },
      { month: "2026-01", count: 1, value: 0.015 },
      { month: "2026-01", count: 2, value: 0.02 },
      // Month 2: slope 0.03 between counts 0 and 1.
      { month: "2026-02", count: 0, value: -0.01 },
      { month: "2026-02", count: 1, value: 0.02 },
      // Month 3: one group only, so no slope.
      { month: "2026-03", count: 0, value: 0.04 },
    ];
    const s = countSlope(rows);
    expect(s.months).toBe(2);
    expect(s.slope).toBeCloseTo(0.02, 10);
    expect(s.stdError).toBeCloseTo(0.01, 10); // sd of (0.01, 0.03) is 0.01414…, over √2
  });

  it("caps the count at 3 (3+), and has no slope without two groups in a month", () => {
    expect(countSlope([{ month: "2026-01", count: 0, value: 0 }, { month: "2026-01", count: 5, value: 0.03 }]).slope).toBeCloseTo(0.01, 10);
    expect(countSlope([{ month: "2026-01", count: 1, value: 0.02 }])).toEqual({ slope: null, stdError: null, months: 0 });
  });
});

describe("latestOnOrBefore", () => {
  it("finds the latest formation on or before a date", () => {
    expect(latestOnOrBefore(["2025-04-30", "2026-04-30"], "2026-04-30")).toBe("2026-04-30");
    expect(latestOnOrBefore(["2025-04-30", "2026-04-30"], "2026-04-29")).toBe("2025-04-30");
    expect(latestOnOrBefore(["2025-04-30"], "2024-12-31")).toBeNull();
  });
});
