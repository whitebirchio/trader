import { describe, expect, it } from "vitest";
import {
  NOTIONAL_DP,
  QTY_DP,
  add,
  compare,
  decimalString,
  div,
  mul,
  round,
  sub,
  toBig,
} from "../src/money.js";

describe("money", () => {
  it("adds without float drift", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(sub("1000", "999.99")).toBe("0.01");
  });

  it("keeps fractional-share math exact to 9 dp", () => {
    // $137.52 notional at a $412.17 price → quantity rounded down to Alpaca's 9 dp.
    const qty = div("137.52", "412.17", QTY_DP, "down");
    expect(qty).toBe("0.333648737");
    expect(round(mul(qty, "412.17"), NOTIONAL_DP, "half-even")).toBe("137.52");
  });

  it("never renders exponent notation", () => {
    expect(mul("0.0000001", "0.01")).toBe("0.000000001");
    expect(mul("1000000000000000000000", "1000")).toBe("1000000000000000000000000");
  });

  it("rounds with an explicit mode", () => {
    expect(round("2.345", 2, "half-up")).toBe("2.35");
    expect(round("2.345", 2, "half-even")).toBe("2.34");
    expect(round("2.349", 2, "down")).toBe("2.34");
    expect(round("2.341", 2, "up")).toBe("2.35");
    expect(round("-2.349", 2, "down")).toBe("-2.34");
  });

  it("compares", () => {
    expect(compare("1.10", "1.1")).toBe(0);
    expect(compare("0.99", "1")).toBe(-1);
    expect(compare("-0", "0")).toBe(0);
  });

  it("rejects JS numbers and non-decimal strings", () => {
    // @ts-expect-error — numbers are not allowed anywhere money flows (ADR-009)
    expect(() => toBig(0.1)).toThrow();
    for (const bad of ["", "abc", "NaN", "Infinity", "1,000", " 1"]) {
      expect(() => toBig(bad), bad).toThrow();
    }
  });

  it("validates external decimal input with a zod schema", () => {
    expect(decimalString.safeParse("12.50").success).toBe(true);
    expect(decimalString.safeParse("-0.000000001").success).toBe(true);
    expect(decimalString.safeParse("1e5").success).toBe(false);
    expect(decimalString.safeParse(12.5).success).toBe(false);
  });

  it("refuses to divide by zero", () => {
    expect(() => div("1", "0", 2, "down")).toThrow();
  });
});
