import { describe, expect, it } from "vitest";
import type { TimelineVersion } from "../../src/replay/driver.js";
import { replay } from "../../src/replay/driver.js";
import { diffReports, formatDiff, replayReport } from "../../src/replay/report.js";
import { combineVariants, parseVariant } from "../../src/replay/variants.js";
import { strategy, thesis } from "../portfolio/fixtures.js";
import { REPLAY_TIMEOUT, base, day, doc, market } from "./fixtures.js";

const version = (document: unknown): TimelineVersion => ({ at: new Date("2026-11-02T13:15:00Z"), authoredBy: "claude", document, version: 3, raw: true });
const two = strategy({
  conviction: [
    thesis({ id: "a", symbol: "AAPL", targetWeightPct: "15", stopLossPct: "12" }),
    thesis({ id: "m", symbol: "MSFT", targetWeightPct: "8", stopLossPct: "30", reviewBy: "2026-12-01" }),
  ],
});
type Doc = { conviction: Record<string, unknown>[] } & Record<string, unknown>;

/** Every field of the document and its theses, except the ones named. */
function without(d: unknown, fields: string[]) {
  const { conviction, ...rest } = d as Doc;
  return { ...rest, conviction: conviction.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !fields.includes(k)))) };
}

describe("parseVariant", () => {
  it("stop=N sets every thesis's stop-loss and changes nothing else", () => {
    const after = parseVariant("stop=20").apply(version(two));
    expect((after.document as Doc).conviction.map((t) => t.stopLossPct)).toEqual(["20", "20"]);
    expect(without(after.document, ["stopLossPct"])).toEqual(without(two, ["stopLossPct"]));
    expect({ ...after, document: null }).toEqual({ ...version(two), document: null });
  });

  it("cap=N lowers only the weights above N", () => {
    const after = parseVariant("cap=10").apply(version(two));
    expect((after.document as Doc).conviction.map((t) => t.targetWeightPct)).toEqual(["10", "8"]);
    expect(without(after.document, ["targetWeightPct"])).toEqual(without(two, ["targetWeightPct"]));
  });

  it("review-days=N reviews every thesis N days after its version", () => {
    const after = parseVariant("review-days=60").apply(version(two));
    expect((after.document as Doc).conviction.map((t) => t.reviewBy)).toEqual(["2027-01-01", "2027-01-01"]);
    expect(without(after.document, ["reviewBy"])).toEqual(without(two, ["reviewBy"]));
  });

  it("refuses an unknown variant or a value the schema wouldn't take, rather than running the baseline", () => {
    expect(() => parseVariant("trail=15")).toThrow(/unknown variant "trail=15"; expected one of: stop=N/);
    expect(() => parseVariant("stop")).toThrow(/unknown variant/);
    expect(() => parseVariant("stop=20=1")).toThrow(/unknown variant/);
    expect(() => parseVariant("stop=4")).toThrow(/stop must be a percentage from 5 to 50/);
    expect(() => parseVariant("cap=25")).toThrow(/cap must be a percentage from 0.01 to 20/);
    expect(() => parseVariant("review-days=0")).toThrow(/whole number of days/);
  });

  it("passes a document without a conviction list through unchanged, and combines variants in order", () => {
    const old = version({ summary: "an old shape" });
    expect(parseVariant("stop=20").apply(old)).toBe(old);
    const both = combineVariants([parseVariant("stop=20"), parseVariant("cap=10")]);
    expect(both.name).toBe("stop=20 + cap=10");
    expect((both.apply(version(two)).document as Doc).conviction.map((t) => [t.stopLossPct, t.targetWeightPct])).toEqual([["20", "10"], ["20", "8"]]);
  });
});

describe("diffReports", () => {
  it("runs a baseline and a variant on the same inputs and shows both sides, the difference, and the theses whose outcome changed", async () => {
    // AAPL gaps 15% on day 5: through the baseline's 10% stop, inside the variant's 20%.
    const input = base(market({ aapl: { [day(5)]: 85 } }));
    const variant = parseVariant("stop=20");
    const opts = { from: day(1), to: day(10), slippageBps: 10 };
    const baseline = await replayReport(await replay(input), opts);
    const varied = await replayReport(await replay({ ...input, versions: input.versions.map(variant.apply) }), opts);
    const d = diffReports(baseline, varied, variant.name);

    expect(d.rows.find((r) => r.label === "Stops fired")).toEqual({ label: "Stops fired", baseline: "1", variant: "0", difference: "-1" });
    expect(d.rows.find((r) => r.label === "VTI %")!.difference).toBe("0"); // identical market
    expect(d.theses).toEqual([{ ids: ["aapl-replay"], symbol: "AAPL", baseline: { ending: "stopped", returnPct: expect.any(String) }, variant: { ending: "open", returnPct: expect.any(String) } }]);

    const text = formatDiff(d);
    expect(text).toContain("Baseline vs stop=20");
    expect(text).toMatch(/Stops fired\s+1\s+0\s+-1/);
    expect(text).toContain("Theses whose outcome changed (1)");
    expect(doc.conviction[0]!.stopLossPct).toBe("10"); // the fixture itself is untouched
  }, REPLAY_TIMEOUT);
});
