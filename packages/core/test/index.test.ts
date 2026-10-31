import { describe, expect, it } from "vitest";
import { TRADING_ENVS } from "../src/index.js";

describe("@trader/core", () => {
  it("knows exactly two environments", () => {
    expect(TRADING_ENVS).toEqual(["staging", "production"]);
  });
});
