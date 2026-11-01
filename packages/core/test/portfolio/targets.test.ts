import { describe, expect, it } from "vitest";
import { add, compare } from "../../src/money.js";
import type { SystematicAllocation } from "../../src/portfolio/systematic.js";
import { buildTargets, weightToDecimal } from "../../src/portfolio/targets.js";
import type { ThesisState } from "../../src/portfolio/theses.js";
import { thesis } from "./fixtures.js";

const active = (id: string, symbol: string, w: string): ThesisState => ({ state: "active", thesis: thesis({ id, symbol, targetWeightPct: w }) });
const alloc = (weights: Record<string, number>, cash = 0): SystematicAllocation => ({
  weights: new Map(Object.entries(weights)),
  cash,
  notes: Object.keys(weights).map((s, i) => `${s}: rank ${i + 1}, 10.0% momentum`),
});
const sum = (xs: { dollars: string }[]) => xs.reduce((s, t) => add(s, t.dollars), "0");

describe("buildTargets", () => {
  it("allocates conviction first and gives systematic the remainder", () => {
    // $1000 equity, $10 buffer → $990 investable. 20% AAPL = $198; $792 to systematic.
    const { targets, investable } = buildTargets([active("a", "AAPL", "20")], alloc({ VTI: 0.75, QQQ: 0.25 }), "1000", "10");
    expect(investable).toBe("990");
    expect(targets).toEqual([
      { symbol: "AAPL", sleeve: "conviction", dollars: "198", reason: "thesis a" },
      { symbol: "VTI", sleeve: "systematic", dollars: "594", reason: "VTI: rank 1, 10.0% momentum" },
      { symbol: "QQQ", sleeve: "systematic", dollars: "198", reason: "QQQ: rank 2, 10.0% momentum" },
    ]);
  });

  it("is all systematic with no theses, and all conviction at 100%", () => {
    expect(buildTargets([], alloc({ VTI: 1 }), "1000", "10").targets).toEqual([
      expect.objectContaining({ symbol: "VTI", sleeve: "systematic", dollars: "990" }),
    ]);
    const five = ["A", "B", "C", "D", "E"].map((s) => active(s.toLowerCase(), s, "20"));
    const { targets } = buildTargets(five, alloc({ VTI: 1 }), "1000", "10");
    expect(targets.every((t) => t.sleeve === "conviction")).toBe(true);
    expect(sum(targets)).toBe("990");
  });

  it("gives stopped and stale theses no target, so their share flows to systematic", () => {
    const states: ThesisState[] = [
      { state: "stopped", thesis: thesis({ id: "s", symbol: "XYZ" }), reason: "x", newlyStopped: true },
      { state: "stale", thesis: thesis({ id: "t", symbol: "OLD" }), reason: "y" },
    ];
    const { targets } = buildTargets(states, alloc({ VTI: 1 }), "1000", "10");
    expect(targets.map((t) => t.symbol)).toEqual(["VTI"]);
    expect(targets[0]?.dollars).toBe("990");
  });

  it("never allocates more than investable, even with awkward weights", () => {
    const thirds = alloc({ AAA: 1 / 3, BBB: 1 / 3, CCC: 1 / 3 });
    const { targets, investable } = buildTargets([active("a", "AAPL", "7.77")], thirds, "1003.37", "10.03");
    expect(compare(sum(targets), investable)).toBeLessThanOrEqual(0);
    expect(targets.every((t) => /^\d+(\.\d{1,2})?$/.test(t.dollars))).toBe(true);
  });

  it("reports the cash share of trend-filtered slots", () => {
    const { heldAsCash, targets } = buildTargets([], alloc({ VTI: 0.5 }, 0.5), "1000", "10");
    expect(heldAsCash).toBe("495");
    expect(targets[0]?.dollars).toBe("495");
  });

  it("handles an account smaller than its buffer", () => {
    expect(buildTargets([], alloc({ VTI: 1 }), "4", "5")).toEqual({ targets: [], investable: "0", heldAsCash: "0" });
  });
});

describe("weightToDecimal", () => {
  it("is plain decimal text and refuses nonsense", () => {
    expect(weightToDecimal(1 / 3)).toBe("0.3333333333");
    expect(() => weightToDecimal(Number.NaN)).toThrow();
    expect(() => weightToDecimal(-0.1)).toThrow();
  });
});
