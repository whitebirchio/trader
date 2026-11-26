import { describe, expect, it } from "vitest";
import { firstSentence, headlineOf } from "../../src/dashboard/headlines.js";

describe("headlineOf", () => {
  it("uses the routine's headline, or the plain summary's first sentence marked as a fallback", () => {
    expect(headlineOf({ headline: "Buying ICE because volumes keep climbing", plainSummary: "ICE owns the NYSE. More.", thesis: "x".repeat(30) })).toEqual({ text: "Buying ICE because volumes keep climbing", fallback: false });
    expect(headlineOf({ plainSummary: "ICE owns the New York Stock Exchange. It grew 18% last quarter.", thesis: "x".repeat(30) })).toEqual({ text: "ICE owns the New York Stock Exchange.", fallback: true });
    expect(headlineOf({ thesis: "Intel's foundry wins are underpriced! The rest follows." })).toEqual({ text: "Intel's foundry wins are underpriced!", fallback: true });
  });

  it("keeps a decimal point inside the sentence, and cuts a long one at a word", () => {
    expect(firstSentence("EPS rose to $2.02 on 15% growth. Next.")).toBe("EPS rose to $2.02 on 15% growth.");
    const long = firstSentence(`${"word ".repeat(60)}end`);
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
  });
});
