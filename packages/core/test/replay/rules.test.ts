import { describe, expect, it } from "vitest";
import { validateStrategy } from "../../src/portfolio/strategy.js";
import { INSIDER_RULE, type InsiderSignal, assumeListed, insiderSignals, insiderTimeline, matchesRule, weekStarts } from "../../src/replay/rules.js";

const signal = (ticker: string, entryDate: string, over: Partial<InsiderSignal> = {}): InsiderSignal => ({
  ticker,
  lastFiled: entryDate,
  entryDate,
  prior60: -0.3,
  buyers: 2,
  insider: true,
  dollars: 100_000,
  ...over,
});
// Mondays, except a short week starting Tuesday 2024-01-16.
const WEEKS = ["2024-01-08", "2024-01-16", "2024-01-22", "2024-01-29", "2024-04-08", "2024-04-15"];
type Doc = { conviction: { id: string; symbol: string; reviewBy: string }[] };
const symbols = (v: { document: unknown }) => (v.document as Doc).conviction.map((t) => t.symbol);

describe("matchesRule and weekStarts", () => {
  it("matches the live pattern only: 2+ officers or directors after a 20%+ drop", () => {
    expect(matchesRule(signal("A", "2024-01-02"), INSIDER_RULE)).toBe(true);
    expect(matchesRule(signal("A", "2024-01-02", { buyers: 1 }), INSIDER_RULE)).toBe(false);
    expect(matchesRule(signal("A", "2024-01-02", { insider: false }), INSIDER_RULE)).toBe(false);
    expect(matchesRule(signal("A", "2024-01-02", { prior60: -0.19 }), INSIDER_RULE)).toBe(false);
    expect(matchesRule(signal("A", "2024-01-02", { prior60: null }), INSIDER_RULE)).toBe(false);
  });

  it("takes each week's first session, short weeks included", () => {
    expect(weekStarts(["2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-22"])).toEqual(["2024-01-11", "2024-01-16", "2024-01-22"]);
  });
});

describe("insiderTimeline", () => {
  it("adds new clusters as theses at the rule's weight, stop and review date, at most 8, most buyers first; the rest stays in VTI", () => {
    const many = Array.from({ length: 10 }, (_, i) => signal(`S${i}`, "2024-01-04", { buyers: 2 + (i % 3), dollars: 1000 * i }));
    const [first] = insiderTimeline(many, WEEKS);
    const doc = first!.document as Doc & { systematic: { universe: string[] } };
    expect(doc.conviction).toHaveLength(8);
    expect(doc.conviction[0]).toMatchObject({ targetWeightPct: "5", stopLossPct: "15", reviewBy: "2024-04-07" });
    // 4 buyers (S2, S5, S8), then 3 (S1, S4, S7), then 2 by dollars (S9, S6): S3 and S0 miss out.
    expect(symbols(first!).sort()).toEqual(["S1", "S2", "S4", "S5", "S6", "S7", "S8", "S9"]);
    expect(doc.systematic.universe).toEqual(["VTI"]);
    expect(first!.at).toEqual(new Date("2024-01-08T13:15:00Z")); // 08:15 ET
    expect(validateStrategy(first!.document).ok).toBe(true);
  });

  it("keeps a thesis until its review date has passed, then frees the slot; a held ticker isn't added twice", () => {
    const v = insiderTimeline([signal("AAA", "2024-01-04"), signal("AAA", "2024-01-18"), signal("BBB", "2024-04-10")], WEEKS);
    expect(v.map(symbols)).toEqual([["AAA"], ["AAA"], ["AAA"], ["AAA"], [], ["BBB"]]); // AAA's review date is 2024-04-07: gone from the week of 04-08
    expect((v[0]!.document as Doc).conviction[0]!.id).toBe("aaa-insiders-2024-01-04");
  });

  it("uses no signal before its entry session has closed: a week's version is the same whatever comes later", () => {
    const signals = [
      signal("AAA", "2024-01-04"),
      signal("BBB", "2024-01-08"), // entry on the Monday itself: not known at 08:15, so next week
      signal("CCC", "2024-01-19"),
      signal("DDD", "2024-01-26"),
      signal("EEE", "2024-04-09"),
    ];
    const full = insiderTimeline(signals, WEEKS);
    WEEKS.forEach((week, k) => {
      const known = signals.filter((s) => s.entryDate < week);
      expect(insiderTimeline(known, WEEKS.slice(0, k + 1))).toEqual(full.slice(0, k + 1));
    });
    expect(symbols(full[0]!)).toEqual(["AAA"]);
    expect(symbols(full[1]!)).toEqual(["AAA", "BBB"]);
  });

  it("reads signals from the backtest's outcomes without their forward returns, and drops symbols the schema can't hold", () => {
    const outcome = (ticker: string) => ({ event: { ticker, lastFiled: "2024-01-03", buyers: 2, insider: true, dollars: 5, purchases: 2 }, entryDate: "2024-01-04", entryClose: 10, prior60: -0.25, excess: { 60: 0.5 }, ret: { 60: 0.6 } });
    expect(insiderSignals([outcome("AAA"), outcome("bad ticker")])).toEqual([{ ticker: "AAA", lastFiled: "2024-01-03", entryDate: "2024-01-04", prior60: -0.25, buyers: 2, insider: true, dollars: 5 }]);
  });
});

describe("assumeListed", () => {
  it("gives a symbol with bars but no asset record an active, tradable one, and reports it", () => {
    const bar = { t: new Date("2024-01-02T05:00:00Z"), o: "1", h: "1", l: "1", c: "1", v: "1" };
    const listed = { symbol: "VTI", name: "Vanguard", status: "active", tradable: true, fractionable: true, marginRequirementLong: "30" };
    const { market, assumed } = assumeListed({ bars: { VTI: [bar], GONE: [bar], NONE: [] }, calendar: [], assets: { VTI: listed } });
    expect(assumed).toEqual(["GONE"]);
    expect(market.assets.GONE).toMatchObject({ status: "active", tradable: true, fractionable: true });
    expect(market.assets.VTI).toBe(listed);
    expect(market.assets.NONE).toBeUndefined();
  });
});
