import { describe, expect, it } from "vitest";
import { add, compare } from "../../src/money.js";
import { LIMITS } from "../../src/risk/limits.js";
import type { SystematicParams } from "../../src/portfolio/strategy.js";
import type { Ranked, Ranking } from "../../src/portfolio/systematic.js";
import { buildTargets, weightToDecimal } from "../../src/portfolio/targets.js";
import type { ThesisState } from "../../src/portfolio/theses.js";
import { thesis } from "./fixtures.js";

const active = (id: string, symbol: string, w: string): ThesisState => ({ state: "active", thesis: thesis({ id, symbol, targetWeightPct: w }) });
const ranked = (symbols: string[], below: string[] = []): Ranking => ({
  ranked: symbols.map((symbol, i): Ranked => ({ symbol, rank: i + 1, momentum: 0.5 - i * 0.05, aboveTrend: !below.includes(symbol), volatility: 0.02 })),
  excluded: [],
});
const params = (o: Partial<SystematicParams> = {}): SystematicParams => ({
  universe: ["NVDA", "MSFT", "META", "QQQ", "AMZN", "XOM"],
  lookbackDays: 252,
  skipRecentDays: 21,
  topN: 2,
  trendFilterDays: 200,
  weighting: "equal",
  volatilityDays: 63,
  defensive: null,
  ...o,
});
const RANKING = ranked(["NVDA", "MSFT", "META", "QQQ", "AMZN", "XOM"]);
const build = (o: Partial<Parameters<typeof buildTargets>[0]> = {}) =>
  buildTargets({ states: [], ranking: RANKING, params: params(), skip: new Set(), equity: "1000", limits: LIMITS, ...o });
const table = (r: ReturnType<typeof build>) => Object.fromEntries(r.targets.map((t) => [t.symbol, t.dollars]));
const sum = (r: ReturnType<typeof build>) => r.targets.reduce((s, t) => add(s, t.dollars), "0");

describe("buildTargets", () => {
  it("the walkthrough: top-2 picks capped at $200 each, the overflow goes down the ranking (option 1b)", () => {
    const r = build();
    expect(table(r)).toEqual({ NVDA: "200", MSFT: "200", META: "200", QQQ: "200", AMZN: "200" });
    expect(r.investable).toBe("1000"); // no cash buffer (Scott, 2026-11-01)
    expect(r.targets.find((t) => t.symbol === "META")?.reason).toBe("META: rank 3, added because higher-ranked picks hit the 20% position limit");
    expect(r.notes).toContain("NVDA held at $200 (the 20% position limit)");
  });

  it("puts whatever the ranking can't take into VTI", () => {
    const r = build({ ranking: ranked(["NVDA", "MSFT", "META"]) });
    expect(table(r)).toEqual({ NVDA: "200", MSFT: "200", META: "200", VTI: "400" });
    expect(r.targets.find((t) => t.symbol === "VTI")?.reason).toBe("VTI: holds what no ranked pick could take");
  });

  it("skips names below trend and in wash-sale windows when going down the ranking", () => {
    const r = build({ ranking: ranked(["NVDA", "MSFT", "META", "QQQ", "AMZN"], ["META"]), skip: new Set(["QQQ"]) });
    expect(table(r)).toEqual({ NVDA: "200", MSFT: "200", AMZN: "200", VTI: "400" });
  });

  it("lets broad ETFs absorb overflow without a cap", () => {
    const r = build({ ranking: ranked(["NVDA", "VTI", "MSFT"]), params: params({ universe: ["NVDA", "VTI", "MSFT"] }) });
    expect(table(r)).toEqual({ NVDA: "200", VTI: "800" });
  });

  it("allocates conviction first and gives systematic the remainder", () => {
    // 20% AAPL ($200), then $800 systematic over NVDA/MSFT: $400 each → capped → overflow down the ranking.
    const r = build({ states: [active("a", "AAPL", "20")] });
    expect(table(r)).toEqual({ AAPL: "200", NVDA: "200", MSFT: "200", META: "200", QQQ: "200" });
    expect(r.targets[0]).toMatchObject({ symbol: "AAPL", sleeve: "conviction", reason: "thesis a" });
  });

  it("is all conviction at 100%, and gives stopped or stale theses nothing", () => {
    const five = ["A", "B", "C", "D", "E"].map((s) => active(s.toLowerCase(), s, "20"));
    expect(build({ states: five }).targets.every((t) => t.sleeve === "conviction")).toBe(true);
    const states: ThesisState[] = [
      { state: "stopped", thesis: thesis({ id: "s", symbol: "XYZ" }), reason: "x", newlyStopped: true },
      { state: "stale", thesis: thesis({ id: "t", symbol: "OLD" }), reason: "y" },
    ];
    expect(table(build({ states, params: params({ universe: ["VTI"], topN: 1 }), ranking: ranked(["VTI"]) }))).toEqual({ VTI: "1000" });
  });

  it("sends trend-filtered slots to the defensive holding, or to VTI", () => {
    const r = build({ ranking: ranked(["NVDA", "MSFT"], ["MSFT"]) });
    expect(table(r)).toEqual({ NVDA: "200", VTI: "800" });
    // SGOV is a cash-equivalent (exempt from the cap), so the defensive slot (MSFT's $500) goes in whole.
    // NVDA's $300 over the cap is risk-on money: it goes down the ranking, then to VTI, not to the defensive slot.
    const d = build({ ranking: ranked(["NVDA", "MSFT"], ["MSFT"]), params: params({ defensive: "SGOV" }) });
    expect(table(d)).toEqual({ NVDA: "200", SGOV: "500", VTI: "300" });
    // A defensive symbol that isn't on the owner's list stays capped: labelling something defensive is no exemption.
    const gold = build({ ranking: ranked(["NVDA", "MSFT"], ["MSFT"]), params: params({ defensive: "GLD" }) });
    expect(table(gold)).toEqual({ NVDA: "200", GLD: "200", VTI: "600" });
  });

  it("version 0: everything in VTI", () => {
    expect(table(build({ params: params({ universe: ["VTI"], topN: 1, trendFilterDays: null }), ranking: ranked(["VTI"]) }))).toEqual({ VTI: "1000" });
  });

  it("never allocates more than investable, in cents, even with awkward numbers", () => {
    const r = build({ states: [active("a", "AAPL", "7.77")], equity: "1003.37", params: params({ topN: 3 }) });
    expect(compare(sum(r), r.investable)).toBeLessThanOrEqual(0);
    expect(compare(sum(r), "1003.36")).toBeGreaterThanOrEqual(0); // at most a cent of rounding left over
    expect(r.targets.every((t) => /^\d+(\.\d{1,2})?$/.test(t.dollars))).toBe(true);
  });

  it("respects a configured cash buffer", () => {
    const r = build({ limits: { ...LIMITS, cashBufferMin: "5", cashBufferPct: "1" }, params: params({ universe: ["VTI"], topN: 1 }), ranking: ranked(["VTI"]) });
    expect(r.investable).toBe("990");
  });

  it("handles an empty account", () => {
    expect(build({ equity: "0" }).targets).toEqual([]);
  });
});

describe("weightToDecimal", () => {
  it("is plain decimal text and refuses nonsense", () => {
    expect(weightToDecimal(1 / 3)).toBe("0.3333333333");
    expect(() => weightToDecimal(Number.NaN)).toThrow();
    expect(() => weightToDecimal(-0.1)).toThrow();
  });
});
