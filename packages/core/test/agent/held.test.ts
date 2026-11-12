import { describe, expect, it } from "vitest";
import { heldThesis } from "../../src/agent/held.js";
import type { Bar } from "../../src/broker/port.js";
import { thesis } from "../portfolio/fixtures.js";

// Weekday sessions ending Fri 2026-11-06; bar times at 05:00 UTC (the session's New York date).
function sessions(n: number): Date[] {
  const out: Date[] = [];
  for (let t = Date.parse("2026-11-06T05:00:00Z"); out.length < n; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d);
  }
  return out;
}
const bars = (closes: string[]): Bar[] => sessions(closes.length).map((t, i) => ({ t, o: closes[i]!, h: closes[i]!, l: closes[i]!, c: closes[i]!, v: "1000000" }));
const flat = (n: number, c = "100") => Array.from({ length: n }, () => c);
const N = 300;
const NOW = new Date("2026-11-06T20:00:00Z");
/** The session `k` from the end (0 = the last). */
const at = (k: number) => sessions(N)[N - 1 - k]!;

const input = (closes: string[], over: Partial<Parameters<typeof heldThesis>[0]> = {}) => ({
  thesis: thesis({ symbol: "AAPL", stopLossPct: "15" }),
  firstLotAt: new Date(at(20).getTime() + 10 * 3_600_000), // bought during the session 20 from the end
  averageCost: "100",
  price: closes.at(-1)!,
  bars: bars(closes),
  vti: bars(flat(N)),
  releases: [],
  now: NOW,
  ...over,
});

describe("heldThesis", () => {
  it("measures since the first lot's session: return vs VTI, the high since and the stop", () => {
    const closes = flat(N);
    closes[N - 1 - 10] = "120"; // the high, after entry
    closes[N - 1 - 30] = "150"; // higher, but before entry: not counted
    closes[N - 1] = "108";
    const h = heldThesis(input(closes));
    expect(h).toMatchObject({
      symbol: "AAPL",
      firstBought: at(20).toISOString().slice(0, 10),
      sinceEntry: { returnPct: "8", vtiPct: "0", excessPct: "8" },
      highSinceEntry: { close: "120", date: at(10).toISOString().slice(0, 10), belowPct: "10" },
      stop: { price: "85", abovePct: "27.06" },
      earningsSinceEntry: null,
      flags: [],
    });
    expect(h.daysHeld).toBe(Math.floor((NOW.getTime() - at(20).getTime() - 10 * 3_600_000) / 86_400_000));
  });

  it("flags near its stop (within 5%) and lagging VTI by 10 points or more", () => {
    const closes = flat(N);
    closes[N - 1] = "89"; // 4.71% above an $85 stop; −11% while VTI is flat
    expect(heldThesis(input(closes)).flags).toEqual(["near_stop", "lagging_vti"]);
    closes[N - 1] = "90.01"; // −9.99%, 5.89% above the stop
    expect(heldThesis(input(closes)).flags).toEqual([]);
  });

  it("flags an earnings crash since entry, not one from before it", () => {
    // Released after the close on the session k from the end: the stock drops from 110 to 97 (−11.8%
    // against a flat VTI) the next session, then recovers to 108, so only the crash is flagged.
    const crash = (k: number) => {
      const closes = flat(N, "110");
      closes[N - k] = "97";
      for (let i = N - k + 1; i < N; i++) closes[i] = "108";
      const day = at(k).toISOString().slice(0, 10);
      return heldThesis(input(closes, { releases: [{ accession: "x", filedOn: day, acceptedAt: `${day}T21:00:00Z` }] }));
    };
    const after = crash(5);
    expect(after.flags).toEqual(["earnings_crash_since_entry"]);
    expect(after.earningsSinceEntry).toMatchObject({ reactionVsVtiPct: "-11.8", sessionsSince: 4 });
    const before = crash(25);
    expect(before.flags).toEqual([]);
    expect(before.earningsSinceEntry).toBeNull();
    expect(before.signals.lastEarnings).toMatchObject({ reactionVsVtiPct: "-11.8" }); // still reported, as for a candidate
  });

  it("flags a recent big loser, and reports the candidate screens", () => {
    const closes = flat(N);
    closes[N - 1 - 252] = "200"; // −50% from 12 months back to 1 month back
    const h = heldThesis(input(closes));
    expect(h.flags).toEqual(["recent_big_loser"]);
    expect(h.signals).toMatchObject({ momentum12to1Pct: "-50", recentBigLoser: true });
  });

  it("flags a report within 7 days as earnings_soon, which isn't a sell signal, and carries the date (#30)", () => {
    const soon = { date: "2026-11-12", inDays: 6, timeOfDay: "post-market", estimate: "1.20", fiscalDateEnding: "2026-09-30" };
    expect(heldThesis(input(flat(N), { nextEarnings: soon }))).toMatchObject({ nextEarnings: soon, flags: ["earnings_soon"] });
    expect(heldThesis(input(flat(N), { nextEarnings: { ...soon, inDays: 8 } })).flags).toEqual([]);
    expect(heldThesis(input(flat(N))).nextEarnings).toBeNull();
  });

  it("carries the filings since entry, and flags an unplanned insider sale and a departure as sell signals (#105)", () => {
    const sale = { filedOn: "2026-11-05", form: "4", kind: "insider_sale" as const, summary: "Form 4: a director sold.", url: "https://www.sec.gov/x", sellSignal: "insider_sale" as const };
    const leaving = { filedOn: "2026-11-04", form: "8-K", kind: "officer_change" as const, summary: "8-K: the CFO resigned.", url: "https://www.sec.gov/y", sellSignal: "executive_departure" as const };
    const results = { filedOn: "2026-11-03", form: "8-K", kind: "results" as const, summary: "8-K: results of operations.", url: "https://www.sec.gov/z" };
    expect(heldThesis(input(flat(N), { filings: [sale, leaving, results] }))).toMatchObject({ filings: [sale, leaving, results], flags: ["insider_selling", "executive_departure"] });
    expect(heldThesis(input(flat(N), { filings: [results] })).flags).toEqual([]);
    expect(heldThesis(input(flat(N))).filings).toEqual([]);
  });

  it("carries analysts' estimates, and flags a falling consensus as estimates_falling (#105)", () => {
    const trend = { period: "2026-12-31", eps: "1.90", change30dPct: "-5", change90dPct: "-9.5", raised30d: 2, cut30d: 5, analysts: 23 };
    const falling = { asOf: "2026-11-12", nextQuarter: trend, fiscalYear: null, falling: true };
    expect(heldThesis(input(flat(N), { estimates: falling }))).toMatchObject({ estimates: falling, flags: ["estimates_falling"] });
    expect(heldThesis(input(flat(N), { estimates: { ...falling, falling: false } })).flags).toEqual([]);
    expect(heldThesis(input(flat(N))).estimates).toBeNull();
  });

  it("leaves out what the bars can't give, without failing", () => {
    const h = heldThesis(input(["100"], { bars: [], vti: [], releases: null, price: "100" }));
    expect(h).toMatchObject({ sinceEntry: null, highSinceEntry: null, stop: { price: "85", abovePct: "17.65" }, flags: [] });
    expect(h.signals.freshEarningsCrash).toBeNull();
  });
});
