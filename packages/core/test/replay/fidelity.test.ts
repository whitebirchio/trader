import { describe, expect, it } from "vitest";
import { compareFidelity, formatFidelity } from "../../src/replay/fidelity.js";
import type { AccountHistory } from "../../src/replay/timeline.js";

const SESSIONS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
const at = (date: string, time = "15:00") => new Date(`${date}T${time}:00Z`);
const fill = (date: string, symbol: string, side: string, qty: string, price: string, time?: string) => ({ at: at(date, time), symbol, side, qty, price });
const snapshots = (equities: string[]) => [
  { tradingDate: "2026-10-30", equity: "1000", recordedAt: at("2026-10-30", "21:15") },
  ...SESSIONS.map((d, i) => ({ tradingDate: d, equity: equities[i]!, recordedAt: at(d, "21:15") })),
];

const live: AccountHistory = {
  fills: [
    fill("2026-10-29", "VTI", "buy", "1", "300"), // before the window
    fill("2026-11-02", "AAPL", "buy", "1", "100"),
    fill("2026-11-02", "AAPL", "buy", "1", "102", "17:00"), // two fills, one trade-day: average 101
    fill("2026-11-03", "MSFT", "buy", "1", "400"),
    fill("2026-11-04", "NVDA", "buy", "2", "200"),
    fill("2026-11-05", "VTI", "sell", "0.01", "300"), // $3: a drift trim
    fill("2026-11-06", "LLY", "buy", "1", "700"),
  ],
  snapshots: snapshots(["1000", "1010", "1020", "1030", "1040"]),
  thesisEvents: [{ at: at("2026-11-04"), thesisId: "nvda-1", symbol: "NVDA", kind: "stopped" }],
};
const replay: AccountHistory = {
  fills: [
    fill("2026-11-02", "AAPL", "buy", "2", "101.5"), // matched, +0.5%
    fill("2026-11-04", "MSFT", "buy", "1", "404"), // a session late
    fill("2026-11-04", "NVDA", "buy", "2", "220"), // matched, but 10% off
    fill("2026-11-05", "XLP", "buy", "6", "80"), // $480, replay only
  ],
  snapshots: snapshots(["1000", "1005", "1015", "1020", "1030"]),
  thesisEvents: [{ at: at("2026-11-05"), thesisId: "aapl-1", symbol: "AAPL", kind: "stale" }],
};

describe("compareFidelity", () => {
  const f = compareFidelity({ live, replay, flows: [{ at: at("2026-10-01"), amount: "1000" }], sessions: SESSIONS });
  const bySymbol = (s: string) => f.fills.find((x) => x.symbol === s)!;

  it("matches trade-days, then shifts within two sessions, then sorts the rest by size", () => {
    expect(bySymbol("AAPL")).toMatchObject({ kind: "matched", priceGapPct: "0.5", notionalGapPct: "0.5", sessionsLate: 0 });
    expect(bySymbol("AAPL").live).toMatchObject({ qty: "2", notional: "202", price: "101" });
    expect(bySymbol("MSFT")).toMatchObject({ kind: "shifted", sessionsLate: 1, priceGapPct: "1" });
    expect(bySymbol("NVDA")).toMatchObject({ kind: "unexplained", priceGapPct: "10" });
    expect(bySymbol("VTI")).toMatchObject({ kind: "small", replay: null });
    expect(bySymbol("XLP")).toMatchObject({ kind: "unexplained", live: null });
    expect(bySymbol("LLY")).toMatchObject({ kind: "unexplained", replay: null });
    expect(f.smallUsd).toBe("20.4"); // 2% of the average live equity, 1020
  });

  it("explains a one-sided stop by the price model, but not another one-sided thesis event", () => {
    expect(f.thesisEvents).toEqual([
      { kind: "stopped", thesisId: "nvda-1", symbol: "NVDA", live: "2026-11-04", replay: null, explained: true, explanation: expect.stringMatching(/through the stop/) },
      { kind: "stale", thesisId: "aapl-1", symbol: "AAPL", live: null, replay: "2026-11-05", explained: false, explanation: "only the replay recorded it" },
    ]);
    expect(f.unexplained).toBe(4); // NVDA's price, XLP, LLY, the stale event
  });

  it("compares the equity path and the flow-adjusted return over the window, and notes trading before it", () => {
    expect(f.equity[0]).toEqual({ date: "2026-11-02", live: "1000", replay: "1000", gapPct: "0" });
    expect(f.equity.at(-1)).toEqual({ date: "2026-11-06", live: "1040", replay: "1030", gapPct: "-0.96" });
    expect(f.returns).toEqual({ live: "4", replay: "3" });
    expect(f.notes).toEqual([expect.stringMatching(/traded before 2026-11-02/)]);
  });

  it("formats a write-up that leads with what needs looking into", () => {
    const text = formatFidelity(f);
    expect(text).toContain("6 trade-days compared: 1 matched, 1 shifted, 1 small, 3 unexplained; 4 gap(s) to look into");
    expect(text.indexOf("Trades: unexplained")).toBeLessThan(text.indexOf("Trades: matched"));
    expect(text).toContain("1 session(s) later in the replay: step timing");
    expect(text).toContain("! only the replay recorded it");
  });
});
