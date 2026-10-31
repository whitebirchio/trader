import { describe, expect, it } from "vitest";
import { marketDate, marketTimeToUtc } from "../src/time.js";

describe("market time", () => {
  it("converts New York session times to UTC across DST", () => {
    // EDT (UTC-4) on Friday 2026-10-30; EST (UTC-5) after the 2026-11-01 change.
    expect(marketTimeToUtc("2026-10-30", "16:00").toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(marketTimeToUtc("2026-11-02", "09:30").toISOString()).toBe("2026-11-02T14:30:00.000Z");
    expect(marketTimeToUtc("2026-11-02", "1600").toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("gives the New York date of an instant", () => {
    expect(marketDate(new Date("2026-11-03T03:00:00Z"))).toBe("2026-11-02"); // 22:00 EST
    expect(marketDate(new Date("2026-11-03T05:00:00Z"))).toBe("2026-11-03");
  });

  it("rejects malformed input", () => {
    expect(() => marketTimeToUtc("2026-13-40", "16:00")).toThrow();
  });
});
