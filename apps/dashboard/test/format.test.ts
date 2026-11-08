import { describe, expect, it } from "vitest";
import { formatDays, formatSignedUsd } from "@/lib/format";

describe("formatSignedUsd", () => {
  it("signs gains and losses, not zero", () => {
    expect(formatSignedUsd("12.5")).toBe("+$12.50");
    expect(formatSignedUsd("-3.4")).toBe("−$3.40");
    expect(formatSignedUsd("0")).toBe("$0.00");
    expect(formatSignedUsd("0.004")).toBe("$0.00");
    expect(formatSignedUsd("1234.5")).toBe("+$1,234.50");
  });
});

describe("formatDays", () => {
  it("is singular only for one day", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(0)).toBe("0 days");
    expect(formatDays(2.5)).toBe("2.5 days");
  });
});
