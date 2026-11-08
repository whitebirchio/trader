import { describe, expect, it } from "vitest";
import { candidateSignals, lastEarnings, momentum12to1 } from "../../src/agent/candidate.js";
import type { Bar } from "../../src/broker/port.js";

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
const release = (acceptedAt: string) => ({ accession: "x", filedOn: acceptedAt.slice(0, 10), acceptedAt });

describe("momentum12to1", () => {
  it("is the return from 252 sessions back to 21 sessions back", () => {
    const closes = flat(300);
    closes[300 - 1 - 252] = "100";
    closes[300 - 1 - 21] = "60";
    expect(momentum12to1(bars(closes))).toBe("-0.4");
    expect(momentum12to1(bars(flat(252)))).toBeNull(); // needs 253 bars
  });

  it("flags a recent big loser at −30% or worse, not at −29.99%", () => {
    const at = (to: string) => {
      const closes = flat(300);
      closes[300 - 1 - 21] = to;
      return candidateSignals(bars(closes), bars(flat(300)), []).recentBigLoser;
    };
    expect([at("70"), at("70.01"), at("50")]).toEqual([true, false, true]);
  });
});

describe("the last earnings reaction", () => {
  // The release lands after the close on the session `k` from the end; the stock drops `drop` the next session.
  const scenario = (sessionsAfter: number, drop: string) => {
    const n = 300;
    const t = sessions(n);
    const reactionIdx = n - 1 - sessionsAfter;
    const closes = flat(n);
    for (let i = reactionIdx; i < n; i++) closes[i] = drop;
    const filed = new Date(t[reactionIdx - 1]!.getTime() + 16 * 3_600_000).toISOString(); // 9 PM UTC: after the close
    return candidateSignals(bars(closes), bars(flat(n)), [release(filed)]);
  };

  it("reports the reaction vs VTI and the sessions since", () => {
    const s = scenario(4, "85");
    expect(s.lastEarnings).toMatchObject({ reactionVsVtiPct: "-15.0", sessionsSince: 4 });
    expect(s.freshEarningsCrash).toBe(true);
  });

  it("is a fresh crash through 10 sessions after the reaction day, not 11", () => {
    expect(scenario(10, "85").freshEarningsCrash).toBe(true);
    expect(scenario(11, "85").freshEarningsCrash).toBe(false);
  });

  it("judges the raw reaction, not the rounded one", () => {
    const s = scenario(2, "90.04"); // −9.96% shows as −10.0
    expect(s.lastEarnings?.reactionVsVtiPct).toBe("-10.0");
    expect(s.freshEarningsCrash).toBe(false);
  });

  it("uses the most recent release with a measurable reaction", () => {
    const n = 300;
    const t = sessions(n);
    const older = new Date(t[100]!.getTime() + 16 * 3_600_000).toISOString();
    const newer = new Date(t[290]!.getTime() + 16 * 3_600_000).toISOString();
    expect(lastEarnings([release(older), release(newer)], bars(flat(n)), bars(flat(n)))?.info.reactionDate).toBe(t[291]!.toISOString().slice(0, 10));
  });

  it("says so when the filings couldn't be read, or there's no release", () => {
    expect(candidateSignals(bars(flat(300)), bars(flat(300)), null)).toMatchObject({ lastEarnings: null, freshEarningsCrash: null, notes: [expect.stringContaining("Couldn't read SEC filings")] });
    expect(candidateSignals(bars(flat(300)), bars(flat(300)), [])).toMatchObject({ freshEarningsCrash: false, notes: [expect.stringContaining("No earnings release")] });
    expect(candidateSignals(bars(flat(100)), bars(flat(100)), []).notes[0]).toContain("Under a year");
  });
});
