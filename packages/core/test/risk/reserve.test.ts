import { describe, expect, it } from "vitest";
import { reserveFor } from "../../src/risk/reserve.js";

describe("reserveFor", () => {
  it("holds back what's outstanding, and asks sells to raise what the cash doesn't cover", () => {
    expect(reserveFor(null, "1000", "0")).toEqual({ outstanding: "0", unfunded: "0" });
    expect(reserveFor({ status: "funding", amount: "500", withdrawn: "0" }, "1000", "200")).toEqual({ outstanding: "500", unfunded: "300" });
    expect(reserveFor({ status: "planning", amount: null, withdrawn: "0" }, "1000", "200")).toEqual({ outstanding: "1000", unfunded: "800" });
  });

  it("sells nothing more once the cash was raised, even if cash falls (the ACH in flight before Alpaca posts it)", () => {
    expect(reserveFor({ status: "ready", amount: "500", withdrawn: "0" }, "500", "0")).toEqual({ outstanding: "500", unfunded: "0" });
    expect(reserveFor({ status: "settling", amount: "500", withdrawn: "0" }, "1000", "100")).toEqual({ outstanding: "500", unfunded: "0" });
  });
});
