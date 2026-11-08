import { describe, expect, it } from "vitest";
import { isLastSessionOfWeek, marketDate, marketTimeToUtc, weekMonday } from "../src/time.js";

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

describe("formatMarketTime", () => {
  it("shows instants in New York time", async () => {
    const { formatMarketTime } = await import("../src/time.js");
    expect(formatMarketTime(new Date("2026-11-03T15:15:00Z"))).toBe("Tue, Nov 3, 10:15 AM ET");
  });
});

describe("weeks", () => {
  it("finds the Monday of a date's week", () => {
    expect(weekMonday("2026-11-13")).toBe("2026-11-09"); // Friday
    expect(weekMonday("2026-11-09")).toBe("2026-11-09"); // Monday
    expect(weekMonday("2026-11-15")).toBe("2026-11-09"); // Sunday
  });

  it("knows the last trading session of a week, including a Friday holiday", () => {
    const normal = ["2026-11-12", "2026-11-13", "2026-11-16"];
    expect(isLastSessionOfWeek("2026-11-13", normal)).toBe(true);
    expect(isLastSessionOfWeek("2026-11-12", normal)).toBe(false);
    // Good Friday 2027 (Apr 2) is a market holiday: Thursday is the week's last session.
    const holiday = ["2027-03-31", "2027-04-01", "2027-04-05"];
    expect(isLastSessionOfWeek("2027-04-01", holiday)).toBe(true);
    expect(isLastSessionOfWeek("2027-04-02", holiday)).toBe(false); // not a session
    expect(isLastSessionOfWeek("2026-11-13", ["2026-11-13"])).toBe(true); // nothing later in the calendar given
  });
});

