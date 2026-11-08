import { describe, expect, it } from "vitest";
import { OVERVIEW_RANGES, THESIS_RANGES, parseRange, rangeFrom, rangeOptions, windowBase } from "../../src/dashboard/ranges.js";

describe("rangeFrom", () => {
  it("counts back from the end date, clamping months to their last day", () => {
    expect(rangeFrom("4w", "2026-11-06")).toBe("2026-10-09");
    expect(rangeFrom("3m", "2026-11-06")).toBe("2026-08-06");
    expect(rangeFrom("6m", "2026-08-31")).toBe("2026-02-28");
    expect(rangeFrom("1y", "2028-02-29")).toBe("2027-02-28");
    expect(rangeFrom("ytd", "2026-11-06")).toBe("2025-12-31");
    expect(rangeFrom("held", "2026-11-06", "2026-11-02")).toBe("2026-11-02");
    expect(rangeFrom("all", "2026-11-06")).toBeNull();
  });
});

describe("windowBase", () => {
  const dates = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"];
  it("starts at the last date on or before the range's start, or null if the history starts later", () => {
    expect(windowBase(dates, null)).toBe(0);
    expect(windowBase(dates, "2026-10-31")).toBe(2); // a weekend start uses Friday's close
    expect(windowBase(dates, "2026-10-28")).toBe(0);
    expect(windowBase(dates, "2026-10-27")).toBeNull();
    expect(windowBase([], null)).toBeNull();
  });
});

describe("rangeOptions", () => {
  it("marks ranges the history doesn't reach unavailable, with the reason; all and held always available with data", () => {
    const dates = ["2026-10-01", "2026-11-06"];
    expect(rangeOptions(OVERVIEW_RANGES, dates, "2026-11-06").map((o) => [o.range, o.available, o.reason ?? null])).toEqual([
      ["4w", true, null],
      ["3m", false, "history starts 2026-10-01"],
      ["6m", false, "history starts 2026-10-01"],
      ["ytd", false, "history starts 2026-10-01"],
      ["1y", false, "history starts 2026-10-01"],
      ["all", true, null],
    ]);
    expect(rangeOptions(THESIS_RANGES, [], "2026-11-06").every((o) => !o.available && o.reason === "no history yet")).toBe(true);
    expect(rangeOptions(THESIS_RANGES, dates, "2026-11-06", "2026-11-02").find((o) => o.range === "held")).toMatchObject({ available: true, label: "Since first held" });
  });
});

describe("parseRange", () => {
  it("accepts an allowed range and falls back otherwise", () => {
    expect(parseRange("6m", OVERVIEW_RANGES, "all")).toBe("6m");
    expect(parseRange("held", OVERVIEW_RANGES, "all")).toBe("all");
    expect(parseRange(undefined, THESIS_RANGES, "held")).toBe("held");
  });
});
