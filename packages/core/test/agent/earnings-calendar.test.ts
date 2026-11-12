import { beforeEach, describe, expect, it } from "vitest";
import { AlphaVantageCalendar, type EarningsCalendarPort, type EarningsDate, nextEarnings, parseEarningsCsv, refreshEarningsCalendar } from "../../src/agent/earnings-calendar.js";
import type { Db } from "../../src/db/client.js";
import { earningsCalendar, jobRuns } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";

const CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AAPL,Apple Inc,2027-01-28,2026-12-31,2.35,USD,post-market
LKQ,"LKQ Corp, Inc",2026-11-20,2026-09-30,0.88,USD,pre-market
NEWCO,New Co,2026-12-01,,None,USD,
BAD,Bad Row,not-a-date,2026-09-30,1,USD,
`;

describe("parseEarningsCsv (#30)", () => {
  it("reads rows by header name, keeps quoted commas, and turns None and blanks into null", () => {
    expect(parseEarningsCsv(CSV)).toEqual([
      { symbol: "AAPL", reportDate: "2027-01-28", fiscalDateEnding: "2026-12-31", estimate: "2.35", currency: "USD", timeOfDay: "post-market" },
      { symbol: "LKQ", reportDate: "2026-11-20", fiscalDateEnding: "2026-09-30", estimate: "0.88", currency: "USD", timeOfDay: "pre-market" },
      { symbol: "NEWCO", reportDate: "2026-12-01", fiscalDateEnding: null, estimate: null, currency: "USD", timeOfDay: null },
    ]);
  });

  it("copes with reordered columns and no time-of-day column", () => {
    expect(parseEarningsCsv("reportDate,symbol,estimate\n2026-12-03,XYZ,1.5\n")).toEqual([{ symbol: "XYZ", reportDate: "2026-12-03", fiscalDateEnding: null, estimate: "1.5", currency: null, timeOfDay: null }]);
  });

  it("throws on Alpha Vantage's JSON notices and on a body without the columns", () => {
    expect(() => parseEarningsCsv('{"Information": "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day."}')).toThrow(/rate limit is 25 requests per day/);
    expect(() => parseEarningsCsv("foo,bar\n1,2\n")).toThrow(/no symbol or reportDate column/);
  });
});

describe("AlphaVantageCalendar", () => {
  it("asks for three months of the calendar with the key, and fails on an HTTP error", async () => {
    const urls: string[] = [];
    const ok = new AlphaVantageCalendar("TESTKEY123", (async (u: URL) => {
      urls.push(u.toString());
      return new Response(CSV, { status: 200 });
    }) as typeof fetch);
    expect(await ok.upcoming()).toHaveLength(3);
    expect(urls).toEqual(["https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=TESTKEY123"]);
    const down = new AlphaVantageCalendar("TESTKEY123", (async () => new Response("", { status: 503 })) as typeof fetch);
    await expect(down.upcoming()).rejects.toThrow("Alpha Vantage's calendar failed: HTTP 503");
  });
});

let db: Db;
const NOW = new Date("2026-11-11T14:00:00Z"); // market date 2026-11-11
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const port = (rows: EarningsDate[]): EarningsCalendarPort & { calls: number } => {
  const p = { calls: 0, upcoming: async () => (p.calls++, rows) };
  return p;
};
const row = (symbol: string, reportDate: string): EarningsDate => ({ symbol, reportDate, fiscalDateEnding: null, estimate: null, currency: "USD", timeOfDay: null });

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("refreshEarningsCalendar and nextEarnings", () => {
  it("stores a snapshot once a day, and reads each symbol's soonest report from the latest one", async () => {
    const p = port([row("LKQ", "2026-11-20"), row("LKQ", "2027-02-19"), row("AAPL", "2027-01-28"), row("AAPL", "2027-01-28")]);
    expect(await refreshEarningsCalendar(db, p, NOW)).toEqual({ status: "refreshed", fetchedOn: "2026-11-11", rows: 3, pruned: 0 });
    expect(await refreshEarningsCalendar(db, p, at(0.1))).toEqual({ status: "skipped", reason: "already fetched for 2026-11-11" });
    expect(p.calls).toBe(1);

    const view = await nextEarnings(db, ["LKQ", "AAPL", "MSFT"], NOW);
    expect(view.asOf).toBe("2026-11-11");
    expect(view.stale).toBe(false);
    expect(view.next.get("LKQ")).toMatchObject({ date: "2026-11-20", inDays: 9 });
    expect(view.next.get("AAPL")).toMatchObject({ date: "2027-01-28" });
    expect(view.next.has("MSFT")).toBe(false);

    // The day after LKQ reports, its next is the following quarter.
    expect((await nextEarnings(db, ["LKQ"], at(10))).next.get("LKQ")).toMatchObject({ date: "2027-02-19" });
  });

  it("reads the newest snapshot only, prunes ones over a week old, and reports staleness", async () => {
    await refreshEarningsCalendar(db, port([row("LKQ", "2026-11-25")]), NOW);
    await refreshEarningsCalendar(db, port([row("LKQ", "2026-11-26")]), at(1)); // the date moved
    expect((await nextEarnings(db, ["LKQ"], at(1))).next.get("LKQ")?.date).toBe("2026-11-26");
    expect((await nextEarnings(db, ["LKQ"], at(5))).stale).toBe(true);
    const r = await refreshEarningsCalendar(db, port([row("LKQ", "2026-11-26")]), at(8)); // 2026-11-19: keeps from 2026-11-12
    expect(r).toMatchObject({ status: "refreshed", pruned: 1 }); // 2026-11-11's snapshot
    expect(new Set((await db.select().from(earningsCalendar)).map((x) => x.fetchedOn))).toEqual(new Set(["2026-11-12", "2026-11-19"]));
  });

  it("has nothing to say before the first snapshot, and refuses an empty calendar", async () => {
    expect(await nextEarnings(db, ["LKQ"], NOW)).toEqual({ asOf: null, stale: true, next: new Map() });
    await expect(refreshEarningsCalendar(db, port([]), NOW)).rejects.toThrow("Alpha Vantage's calendar was empty");
  });
});

describe("the earnings-calendar job", () => {
  const deps = (earnings?: EarningsCalendarPort) => ({ db, env: "production" as const, broker: new FakeBroker(), mailer: new FakeMailer(), now: () => NOW, earnings });

  it("skips without a key, refreshes with one, and waits two hours after a failure", async () => {
    expect(await runJob(deps(), "earnings-calendar", NOW)).toEqual({ status: "skipped", reason: "no ALPHAVANTAGE_API_KEY" });
    const failing = { upcoming: async () => Promise.reject(new Error("rate limited")) };
    expect(await runJob(deps(failing), "earnings-calendar", at(0.01))).toMatchObject({ status: "failed", error: "rate limited" });
    const p = port([row("LKQ", "2026-11-20")]);
    expect(await runJob({ ...deps(p), now: () => at(0.05) }, "earnings-calendar", at(0.05))).toMatchObject({ status: "skipped", reason: expect.stringContaining("retrying after 2 hours") });
    expect(p.calls).toBe(0);
    expect(await runJob({ ...deps(p), now: () => at(0.1) }, "earnings-calendar", at(0.1))).toMatchObject({ status: "succeeded", detail: { rows: 1 } });
    expect((await db.select().from(jobRuns)).filter((r) => r.job === "earnings-calendar")).toHaveLength(4);
  });

  it("spends no request in staging, which fetches on demand", async () => {
    const p = port([row("LKQ", "2026-11-20")]);
    expect(await runJob({ ...deps(p), env: "staging" }, "earnings-calendar", NOW)).toEqual({ status: "skipped", reason: "no scheduled calendar in staging: run earnings:refresh when a test needs one" });
    expect(p.calls).toBe(0);
  });
});
