import { describe, expect, it } from "vitest";
import type { Activity } from "../../src/broker/port.js";
import { buildIndex, flowsByDate, liveIndex } from "../../src/risk/equity-index.js";

function flow(type: string, date: string, amount: string): Activity {
  return { id: `${type}-${date}`, type, at: new Date(`${date}T15:00:00Z`), symbol: null, side: null, qty: null, price: null, netAmount: amount, orderId: null, raw: {} };
}

describe("flowsByDate", () => {
  it("nets deposits and withdrawals per market date and ignores everything else", () => {
    const flows = flowsByDate([
      flow("CSD", "2026-11-03", "500"),
      flow("CSW", "2026-11-03", "-100"),
      flow("DIV", "2026-11-03", "2"), // a dividend is a return, not a flow
      flow("JNLC", "2026-11-04", "50"),
    ]);
    expect(Object.fromEntries(flows)).toEqual({ "2026-11-03": "400", "2026-11-04": "50" });
  });
});

describe("buildIndex", () => {
  it("is unmoved by a deposit between snapshots", () => {
    const flows = flowsByDate([flow("CSD", "2026-11-03", "1000")]);
    const state = buildIndex(
      [
        { tradingDate: "2026-11-02", equity: "1000" },
        { tradingDate: "2026-11-03", equity: "2000" }, // flat market + $1000 deposit
      ],
      flows,
    );
    expect(state.points.map((p) => p.index)).toEqual(["1", "1"]);
  });

  it("is unmoved by a withdrawal", () => {
    const flows = flowsByDate([flow("CSW", "2026-11-03", "-400")]);
    const state = buildIndex(
      [
        { tradingDate: "2026-11-02", equity: "1000" },
        { tradingDate: "2026-11-03", equity: "660" }, // +10% then −$400
      ],
      flows,
    );
    expect(state.points[1]?.index).toBe("1.06");
  });

  it("tracks returns and the running peak", () => {
    const state = buildIndex(
      [
        { tradingDate: "2026-11-04", equity: "900" },
        { tradingDate: "2026-11-02", equity: "1000" },
        { tradingDate: "2026-11-03", equity: "1200" },
      ],
      new Map(),
    );
    expect(state.points.map((p) => p.index)).toEqual(["1", "1.2", "0.9"]);
    expect(state.peak).toBe("1.2");
  });
});

describe("liveIndex", () => {
  const history = buildIndex(
    [
      { tradingDate: "2026-11-02", equity: "1000" },
      { tradingDate: "2026-11-03", equity: "1250" },
    ],
    new Map(),
  );

  it("measures a fall from the peak as drawdown", () => {
    // Peak index 1.25 (equity 1250). Today 1000 → index 1.0 → 20% below peak.
    expect(liveIndex(history, "1000", new Map(), "1250", "2026-11-04")).toEqual({
      drawdownPct: "20",
      dailyChangePct: "-20",
    });
  });

  it("ignores today's deposit in both measures", () => {
    const flows = flowsByDate([flow("CSD", "2026-11-04", "500")]);
    expect(liveIndex(history, "1750", flows, "1250", "2026-11-04")).toEqual({ drawdownPct: "0", dailyChangePct: "0" });
  });

  it("uses Alpaca's prior-close equity before any snapshot, with zero drawdown", () => {
    const empty = buildIndex([], new Map());
    expect(liveIndex(empty, "950", new Map(), "1000", "2026-11-02")).toEqual({ drawdownPct: "0", dailyChangePct: "-5" });
  });

  it("reports a new high as zero drawdown", () => {
    expect(liveIndex(history, "1300", new Map(), "1250", "2026-11-04").drawdownPct).toBe("0");
  });

  it("does not divide by an empty prior close", () => {
    const empty = buildIndex([], new Map());
    expect(liveIndex(empty, "1000", new Map(), "0", "2026-11-02").dailyChangePct).toBe("0");
  });
});
