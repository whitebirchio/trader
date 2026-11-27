import Big from "big.js";
import { describe, expect, it } from "vitest";
import { type SankeyData, groupSmallest, ideaFunnelSankey, isBalanced, moneySankey, pnlSankey, signalSankey } from "../../src/dashboard/sankey.js";

const into = (d: SankeyData, name: string) => d.links.filter((l) => d.nodes[l.target]!.name === name).reduce((s, l) => s.plus(l.value), new Big(0)).toString();
const outOf = (d: SankeyData, name: string) => d.links.filter((l) => d.nodes[l.source]!.name === name).reduce((s, l) => s.plus(l.value), new Big(0)).toString();

describe("moneySankey", () => {
  const book = {
    deposited: "1000",
    parts: [
      { name: "ICE", value: "7.80" },
      { name: "LSTR", value: "4.10" },
      { name: "INTC", value: "-9.40" },
      { name: "Dividends, fees and rounding", value: "0.37" },
    ],
    holdings: [
      { name: "ICE", value: "130.00" },
      { name: "LSTR", value: "80.00" },
      { name: "INTC", value: "50.00" },
      { name: "VTI", value: "740.85" },
    ],
    cash: "2.02",
  };

  it("puts deposits and gains in, holdings and cash out, and losses as their own flow; it adds up to the account's value", () => {
    const d = moneySankey(book);
    expect(d.total).toBe("1002.87");
    expect(into(d, "Your account")).toBe("1012.27"); // 1000 + 12.27 gained
    expect(outOf(d, "Your account")).toBe("1012.27");
    expect(into(d, "Losses")).toBe("9.4");
    expect(isBalanced(d)).toBe(true);
  });

  it("groups the smallest holdings for a phone without changing the total", () => {
    const d = moneySankey({ ...book, cap: 2 });
    expect(d.nodes.map((n) => n.name)).toContain("Other holdings");
    expect(into(d, "Other holdings")).toBe("260");
    expect(d.total).toBe("1002.87");
  });

  it("refuses inputs that don't add up, and draws a single holding", () => {
    expect(() => moneySankey({ ...book, cash: "3" })).toThrow("holdings + cash");
    expect(moneySankey({ deposited: "1000", parts: [], holdings: [{ name: "VTI", value: "1000" }], cash: "0" }).links).toEqual([
      { source: 0, target: 1, value: "1000" },
      { source: 1, target: 2, value: "1000" },
    ]);
  });
});

describe("pnlSankey", () => {
  it("routes each gain into the middle and out to each loss and the net profit", () => {
    const d = pnlSankey({ parts: [{ name: "ICE", value: "7.80" }, { name: "INTC", value: "-9.40" }, { name: "LSTR", value: "4.10" }] });
    expect(d.total).toBe("2.5");
    expect(into(d, "Net profit")).toBe("2.5");
    expect(into(d, "INTC (loss)")).toBe("9.4");
    expect(isBalanced(d)).toBe(true);
  });

  it("brings a net loss in on the left", () => {
    const d = pnlSankey({ parts: [{ name: "ICE", value: "2" }, { name: "INTC", value: "-9" }] });
    expect(d.total).toBe("-7");
    expect(outOf(d, "Net loss")).toBe("7");
    expect(d.nodes.map((n) => n.name)).toContain("Lost");
    expect(isBalanced(d)).toBe(true);
  });
});

describe("ideaFunnelSankey and signalSankey", () => {
  it("counts every idea once, from the watchlist or found directly, through to its outcome", () => {
    const d = ideaFunnelSankey([
      { watched: true, state: "bought", outcome: "beat" },
      { watched: true, state: "bought", outcome: "open_ahead" },
      { watched: true, state: "dropped" },
      { watched: true, state: "watching" },
      { watched: false, state: "bought", outcome: "stopped" },
    ]);
    expect(d.total).toBe("5");
    expect(into(d, "Bought")).toBe("3");
    expect(outOf(d, "Bought")).toBe("3");
    expect(into(d, "Stopped out")).toBe("1");
    expect(isBalanced(d)).toBe(true);
    expect(ideaFunnelSankey([]).links).toEqual([]);
    expect(() => ideaFunnelSankey([{ watched: true, state: "bought" }])).toThrow("no outcome");
  });

  it("links each lead signal to its outcomes by count, carrying the dollars", () => {
    const d = signalSankey([
      { leadSignal: "insider", outcome: "lagged", pnl: "-12.40" },
      { leadSignal: "insider", outcome: "lagged", pnl: "-3.10" },
      { leadSignal: "13f", outcome: "open_ahead", pnl: "5.00" },
    ]);
    expect(d.total).toBe("3");
    expect(d.links.find((l) => d.nodes[l.source]!.name === "insider")).toMatchObject({ value: "2", usd: "-15.50" });
  });
});

describe("groupSmallest", () => {
  it("keeps the largest and sums the rest, so the total is unchanged", () => {
    const items = ["5", "1", "3", "2"].map((value, i) => ({ name: `n${i}`, value }));
    expect(groupSmallest(items, 3, "Other")).toEqual([{ name: "n0", value: "5" }, { name: "n2", value: "3" }, { name: "Other", value: "3" }]);
    expect(groupSmallest(items, undefined, "Other")).toHaveLength(4);
  });
});
