import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/lib/today-events";

const ev = (kind: string, symbol: string | null, payload: Record<string, unknown>) => ({ at: "2026-11-25T15:30:00.000Z", kind, symbol, payload });

describe("describeEvent", () => {
  it("says what happened in a plain sentence", () => {
    expect(describeEvent(ev("order.filled", "AAPL", { side: "buy", filledQty: "0.25", filledAvgPrice: "200.5" })).text).toBe("Bought 0.25 AAPL at $200.50");
    expect(describeEvent(ev("strategy.activated", "v41", { version: 41, summary: "Reaffirmed: no material change.\nICE: held." })).text).toBe("Strategy v41: Reaffirmed: no material change.");
    expect(describeEvent(ev("thesis.stopped_out", "INTC", { reason: "closed at its stop" }))).toMatchObject({ text: "Sold INTC: it closed through its stop (closed at its stop)", attention: true });
    expect(describeEvent(ev("events.tripped", "2026-11-25:INTC:move", { symbol: "INTC", trigger: "move", distancePct: "-8.4" }))).toMatchObject({ symbol: "INTC", text: "INTC: moved −8.40% today" });
    expect(describeEvent(ev("events.tripped", "2026-11-25:INTC:near_stop", { symbol: "INTC", trigger: "near_stop", detail: "INTC is 3.1% above its stop" }))).toMatchObject({ text: "INTC is 3.1% above its stop", attention: true });
  });

  it("falls back to the kind for anything it doesn't know", () => {
    expect(describeEvent(ev("something.new", null, {})).text).toBe("something.new");
  });
});
