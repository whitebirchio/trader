import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DailyBar, type EventOutcome, closeOnOrBefore } from "../../src/research/backtest.js";
import {
  EARNINGS_BREAKDOWNS,
  type EarningsEvent,
  type FilingColumns,
  earningsReleases,
  insiderBought,
  reactionBucket,
  reactionEvent,
} from "../../src/research/earnings-backtest.js";
import type { InsiderEvent } from "../../src/research/insider-backtest.js";

// SEC submissions JSON for LKQ (reports before the open) and Landstar (after the close), trimmed.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const recent = (name: string) => (JSON.parse(readFileSync(join(fixtures, name), "utf8")) as { filings: { recent: FilingColumns } }).filings.recent;

describe("earningsReleases", () => {
  it("keeps original 8-Ks with item 2.02, oldest first", () => {
    expect(earningsReleases(recent("submissions-lkq.json"))).toEqual([
      { accession: "0001065696-26-000047", filedOn: "2026-10-23", acceptedAt: "2026-10-23T12:06:44.000Z" },
      { accession: "0001065696-26-000050", filedOn: "2026-10-29", acceptedAt: "2026-10-29T11:30:20.000Z" },
    ]);
    // Landstar's 8-K without 2.02 (8.01 only), its 10-Qs and Forms 3/4 are left out.
    expect(earningsReleases(recent("submissions-lstr.json")).map((r) => r.filedOn)).toEqual(["2026-07-28", "2026-10-27"]);
  });

  it("leaves out amendments", () => {
    const amended: FilingColumns = { accessionNumber: ["a"], filingDate: ["2026-10-30"], acceptanceDateTime: ["2026-10-30T12:00:00.000Z"], form: ["8-K/A"], items: ["2.02,9.01"] };
    expect(earningsReleases(amended)).toEqual([]);
  });
});

// Weekday sessions from 2026-10-19 to 2026-11-13; DST ends on 2026-11-01.
const sessions = (() => {
  const out: string[] = [];
  for (let t = Date.parse("2026-10-19T00:00:00Z"); t <= Date.parse("2026-11-13T00:00:00Z"); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
})();
const flat = (close: number): DailyBar[] => sessions.map((date) => ({ date, close, volume: 1_000_000 }));
const release = (acceptedAt: string) => ({ accession: "x", filedOn: acceptedAt.slice(0, 10), acceptedAt });
const reactionDay = (acceptedAt: string) => reactionEvent("1", "XYZ", release(acceptedAt), flat(100), flat(300))?.reactionDate;

describe("reactionEvent", () => {
  it("reacts the same day to a release before the open, and the next session to one after the close", () => {
    expect(reactionDay("2026-10-29T11:30:20.000Z")).toBe("2026-10-29"); // LKQ, 7:30 ET
    expect(reactionDay("2026-10-27T20:22:48.000Z")).toBe("2026-10-28"); // Landstar, 4:22 PM ET
  });

  it("uses New York time across the DST change, and skips weekends", () => {
    expect(reactionDay("2026-11-03T14:00:00.000Z")).toBe("2026-11-03"); // 9:00 EST: before the open
    expect(reactionDay("2026-11-03T14:45:00.000Z")).toBe("2026-11-04"); // 9:45 EST: after it
    expect(reactionDay("2026-10-31T14:00:00.000Z")).toBe("2026-11-02"); // a Saturday
    expect(reactionDay("2026-10-30T21:00:00.000Z")).toBe("2026-11-02"); // Friday after the close
  });

  it("measures the reaction day against VTI's", () => {
    const stock = flat(100);
    const vti = flat(300);
    const i = sessions.indexOf("2026-10-28");
    for (let k = i; k < stock.length; k++) stock[k]!.close = 90;
    for (let k = i; k < vti.length; k++) vti[k]!.close = 303;
    // −10% against VTI's +1%.
    expect(reactionEvent("853816", "LSTR", release("2026-10-27T20:22:48.000Z"), stock, vti)?.reaction).toBeCloseTo(-0.11, 10);
  });

  it("is null without a session before the reaction day, or without VTI's closes", () => {
    expect(reactionDay("2026-10-16T20:00:00.000Z")).toBeUndefined(); // the reaction day is the first bar
    expect(reactionEvent("1", "XYZ", release("2026-10-27T20:22:48.000Z"), flat(100), [])).toBeNull();
  });
});

describe("insiderBought", () => {
  const insider = (lastFiled: string, over: Partial<InsiderEvent> = {}): InsiderEvent => ({
    issuerCik: "1", ticker: "XYZ", firstFiled: lastFiled, lastFiled, buyers: 1, ceoOrCfo: false, insider: true, opportunistic: true, dollars: 100_000, purchases: [], ...over,
  });

  it("looks for an officer or director buy filed in the 90 days up to the date", () => {
    expect(insiderBought("XYZ", "2026-10-28", [insider("2026-08-01")])).toBe(true); // 88 days before
    expect(insiderBought("XYZ", "2026-10-28", [insider("2026-07-29")])).toBe(false); // 91 days before
    expect(insiderBought("XYZ", "2026-10-28", [insider("2026-10-29")])).toBe(false); // after
    expect(insiderBought("XYZ", "2026-10-28", [insider("2026-10-01", { insider: false })])).toBe(false); // 10% owner only
    expect(insiderBought("XYZ", "2026-10-28", [insider("2026-10-01", { ticker: "ABC" })])).toBe(false);
  });
});

describe("buckets", () => {
  it("puts each reaction in one fixed bucket", () => {
    expect([-0.1, -0.05, -0.0001, 0, 0.0499, 0.05, 0.1].map(reactionBucket)).toEqual([
      "a. Down 10%+", "b. Down 5–10%", "c. Down 0–5%", "d. Up 0–5%", "d. Up 0–5%", "e. Up 5–10%", "f. Up 10%+",
    ]);
  });

  it("labels outcomes for the report", () => {
    const o = (reaction: number, insiderBefore: boolean): EventOutcome<EarningsEvent> => ({
      event: { cik: "1", ticker: "XYZ", release: release("2026-10-27T20:00:00.000Z"), reactionDate: "2026-10-28", reaction, insiderBefore },
      entryDate: "2026-10-29", entryClose: 10, prior60: null, ret: { 20: 0, 60: 0, 120: 0 }, excess: { 20: 0, 60: 0, 120: 0 },
    });
    const up = EARNINGS_BREAKDOWNS["Up 5%+ on earnings, by prior insider buying"]!;
    expect([up(o(0.08, true)), up(o(0.08, false)), up(o(0.01, true))]).toEqual(["Up 5%+, insider bought before", "Up 5%+, no insider buy", null]);
    expect(EARNINGS_BREAKDOWNS["Year of entry"]!(o(0, false))).toBe("2026");
  });
});

describe("closeOnOrBefore", () => {
  it("finds the close on a date, or the last one before it", () => {
    const bars = flat(1).map((b, i) => ({ ...b, close: i }));
    expect(closeOnOrBefore(bars, "2026-10-20")).toBe(1);
    expect(closeOnOrBefore(bars, "2026-10-25")).toBe(4); // a Sunday: Friday's close
    expect(closeOnOrBefore(bars, "2026-10-18")).toBeUndefined();
    expect(closeOnOrBefore(bars, "2027-01-01")).toBe(bars.length - 1);
  });
});
