import { describe, expect, it } from "vitest";
import { REDIRECTS } from "../src/lib/redirects";
import config from "../next.config";

describe("redirects", () => {
  it("sends every retired page to its new home, permanently", async () => {
    expect(await config.redirects?.()).toEqual(REDIRECTS);
    const to = (source: string) => REDIRECTS.find((r) => r.source === source)?.destination;
    expect(to("/holdings")).toBe("/positions");
    expect(to("/track-record")).toBe("/history");
    expect(to("/activity")).toBe("/history/activity");
    expect(to("/strategy/:version")).toBe("/history/strategy/:version");
    expect(REDIRECTS.every((r) => r.permanent)).toBe(true);
  });
});
