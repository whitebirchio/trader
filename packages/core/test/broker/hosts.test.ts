import { describe, expect, it } from "vitest";
import { alpacaHosts } from "../../src/broker/hosts.js";

describe("alpacaHosts (ADR-005)", () => {
  it("sends staging to the paper host", () => {
    expect(alpacaHosts("staging").trading).toBe("https://paper-api.alpaca.markets");
  });
  it("sends production to the live host", () => {
    expect(alpacaHosts("production").trading).toBe("https://api.alpaca.markets");
  });
  it("uses one market-data host for both", () => {
    expect(alpacaHosts("staging").data).toBe(alpacaHosts("production").data);
  });
});
