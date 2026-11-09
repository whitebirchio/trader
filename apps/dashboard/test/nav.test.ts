import { describe, expect, it } from "vitest";
import { activeHref } from "../src/components/nav";

describe("activeHref", () => {
  it("marks the page's own entry, its sub-pages, and puts thesis pages under the track record", () => {
    expect(activeHref("/")).toBe("/");
    expect(activeHref("/holdings")).toBe("/holdings");
    expect(activeHref("/strategy/3")).toBe("/strategy");
    expect(activeHref("/money/confirm")).toBe("/money");
    expect(activeHref("/theses/aapl-services")).toBe("/track-record");
    expect(activeHref("/login")).toBe("");
  });
});
