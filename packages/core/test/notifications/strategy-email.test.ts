import { describe, expect, it } from "vitest";
import { composeUrgent } from "../../src/notifications/compose.js";
import { V21_SUMMARY, v21AsRecorded, v21Reaffirmed, v22Changed } from "../../src/notifications/samples.js";
import { changeSummary, splitSummary } from "../../src/notifications/strategy-email.js";

const none = { added: [], removed: [], resized: [], moved: [], edited: [] };

describe("the strategy email's subject", () => {
  it("says a reaffirmation changed nothing", () => {
    expect(composeUrgent([v21Reaffirmed()], "production").subject).toBe("Trader: Strategy v21 reaffirmed, no changes");
  });

  it("names up to three changes", () => {
    expect(composeUrgent([v22Changed()], "production").subject).toBe("Trader: Strategy v22: SMPL 6% added, BA exited, TTMI 8% → 10%");
    const many = { ...none, removed: ["A", "B", "C", "D", "E"].map((s) => ({ thesisId: s, symbol: s, weightPct: "5" })) };
    expect(changeSummary(many)).toBe("A exited, B exited, C exited +2 more");
  });

  it("says when only stops, review dates, forecasts or a case moved", () => {
    expect(changeSummary({ ...none, moved: [{ thesisId: "a", symbol: "A", field: "review", from: "2026-12-01", to: "2027-01-02" }] })).toBe("stops or review dates moved");
    expect(changeSummary({ ...none, moved: [{ thesisId: "a", symbol: "A", field: "forecast", from: "50%", to: "55%" }] })).toBe("forecasts updated");
    expect(changeSummary({ ...none, edited: ["AAPL's case"] })).toBe("AAPL's case updated");
  });

  it("keeps the old subject for an activation recorded before 2026-11-15", () => {
    expect(composeUrgent([v21AsRecorded()], "production").subject).toBe("Trader: New strategy v21 by claude");
  });
});

describe("the strategy email's body", () => {
  it("leads with what changed, the allocation and Claude's first line, before the theses", () => {
    const { text } = composeUrgent([v21Reaffirmed()], "production");
    const order = ["WHAT CHANGED", "No changes: same 5 theses, weights, stops and review dates.", "In theses: 33%", "In VTI: 67%", "CLAUDE'S TAKE", "Reaffirmed: no material change since v20", "THESES"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("by Claude · Fri, Nov 13, 12:31 PM ET");
  });

  it("puts each thesis's line from this run on its card, with its stop, review date, signal and forecast", () => {
    const { text, html } = composeUrgent([v21Reaffirmed()], "production");
    expect(text).toContain("BA · 7%\n  Boeing is generating cash again");
    expect(text).toContain("  This run: held at 7%. The insider sale and falling estimates");
    expect(text).toContain("  Stop 15% below cost · Review by Wed Dec 16 · Led by insider buying · 46% chance to beat VTI");
    expect(html).toContain('href="https://trader.whitebirch.io/theses/ba-director-buys-2026q4"');
    expect(text).toContain("Book: 33% in theses, all led by insider buying.");
    expect(text).toContain("CLAUDE'S NOTES\n\nShared failure");
  });

  it("orders cards by weight, and tags new and resized theses", () => {
    const { text } = composeUrgent([v22Changed()], "production");
    expect(text.indexOf("TTMI · 10% · was 8%")).toBeLessThan(text.indexOf("SMPL · 6% · New"));
    expect(text).toContain("- Exited BA (was 7%)");
    expect(text).toContain("- LSTR review date: Wed Dec 16 → Fri Jan 8");
    expect(text).toContain("It takes effect at the next rebalance step.");
  });

  it("links nothing on paper, which has no dashboard", () => {
    expect(composeUrgent([v21Reaffirmed()], "staging").html).not.toContain("trader.whitebirch.io");
  });

  it("still renders an activation recorded before cards existed, one card per plain summary", () => {
    const { text } = composeUrgent([v21AsRecorded()], "production");
    expect(text).not.toContain("WHAT CHANGED");
    expect(text).toContain("TTMI · 8%\n  TTM makes circuit boards");
    expect(text).not.toContain("In plain terms");
  });
});

describe("splitSummary", () => {
  const symbols = new Set(["TTMI", "BA"]);

  it("reads the routine's line format: headline, SYMBOL lines, Book, notes", () => {
    const s = splitSummary("- **Exited LKQ** on the insider sale.\nTTMI (8%): held.\nBA — trimmed to 7%.\nBook: 33% in theses.\nWatchlist unchanged.\nXYZ: not a thesis.", symbols);
    expect(s.lead).toBe("Exited LKQ on the insider sale.");
    expect(Object.fromEntries(s.perThesis)).toEqual({ TTMI: "held.", BA: "trimmed to 7%." });
    expect(s.book).toBe("33% in theses.");
    expect(s.notes).toEqual(["Watchlist unchanged.", "XYZ: not a thesis."]);
  });

  it("splits a long first paragraph into its first sentence and notes", () => {
    const s = splitSummary(V21_SUMMARY, symbols);
    expect(s.lead).toBe("Version 21: Keep (12:00 ET retry, Fri Nov 13).");
    expect(s.notes[0]).toMatch(/^Reaffirmed: no material change since v20/);
    expect(s.book).toMatch(/^conviction 33%, all insider-led/);
  });
});
