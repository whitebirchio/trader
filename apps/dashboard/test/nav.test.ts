import { describe, expect, it } from "vitest";
import { activeHref, isStale } from "../src/components/nav";

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

describe("isStale", () => {
  it("reloads only when the app comes back more than a minute after its last load", () => {
    const loaded = 1_000_000;
    expect(isStale(loaded, loaded + 59_000)).toBe(false);
    expect(isStale(loaded, loaded + 60_000)).toBe(false);
    expect(isStale(loaded, loaded + 60_001)).toBe(true);
  });
});
