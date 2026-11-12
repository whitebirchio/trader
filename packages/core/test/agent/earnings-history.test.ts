import { beforeEach, describe, expect, it } from "vitest";
import { AlphaVantageEarnings, BACKFILL, type EarningsHistoryPort, type HistoryReply, backfillEarningsHistory, backfillProgress, parseEarningsJson } from "../../src/agent/earnings-history.js";
import { EARNINGS_UNIVERSE } from "../../src/agent/earnings-universe.js";
import type { Db } from "../../src/db/client.js";
import { earningsHistory, earningsHistoryFetches } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";

const quarter = (fiscalDateEnding: string, reportedDate: string, extra: Record<string, string> = {}) => ({
  fiscalDateEnding,
  reportedDate,
  reportedEPS: "1.10",
  estimatedEPS: "1.00",
  surprise: "0.10",
  surprisePercentage: "10",
  reportTime: "post-market",
  ...extra,
});

describe("parseEarningsJson (#105)", () => {
  it("reads quarters, turns None into null, and skips quarters without real dates", () => {
    const body = JSON.stringify({
      symbol: "AAA",
      annualEarnings: [{ fiscalDateEnding: "2026-09-30", reportedEPS: "4.2" }],
      quarterlyEarnings: [
        quarter("2026-09-30", "2026-11-02"),
        quarter("2026-06-30", "2026-07-30", { estimatedEPS: "None", surprise: "None", surprisePercentage: "None", reportTime: "" }),
        quarter("2026-03-31", "None"),
      ],
    });
    expect(parseEarningsJson(body)).toEqual({
      status: "ok",
      quarters: [
        { fiscalDateEnding: "2026-09-30", reportedDate: "2026-11-02", reportTime: "post-market", reportedEps: "1.10", estimatedEps: "1.00", surprise: "0.10", surprisePct: "10" },
        { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportTime: null, reportedEps: "1.10", estimatedEps: null, surprise: null, surprisePct: null },
      ],
    });
  });

  it("treats a notice as a refusal, and an empty reply or an error message as nothing for the symbol", () => {
    expect(parseEarningsJson('{"Information": "Our standard API rate limit is 25 requests per day."}')).toEqual({ status: "limited", perSecond: false, note: "Our standard API rate limit is 25 requests per day." });
    const burst = "Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to lift the free key rate limit (25 requests per day).";
    expect(parseEarningsJson(JSON.stringify({ Information: burst }))).toEqual({ status: "limited", perSecond: true, note: burst });
    expect(parseEarningsJson('{"Note": "slow down"}')).toEqual({ status: "limited", perSecond: false, note: "slow down" });
    expect(parseEarningsJson("{}")).toEqual({ status: "none" });
    expect(parseEarningsJson('{"Error Message": "Invalid API call."}')).toEqual({ status: "none" });
    expect(parseEarningsJson('{"symbol": "AAA", "quarterlyEarnings": []}')).toEqual({ status: "none" });
    expect(() => parseEarningsJson("<html>")).toThrow("unreadable earnings");
  });
});

describe("AlphaVantageEarnings", () => {
  it("asks for one symbol in Alpha Vantage's form, spaces its requests, and fails on an HTTP error", async () => {
    const calls: { url: string; at: number }[] = [];
    const av = new AlphaVantageEarnings(
      "TESTKEY123",
      (async (u: URL) => {
        calls.push({ url: u.toString(), at: Date.now() });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      40,
    );
    expect(await av.history("BRK.B")).toEqual({ status: "none" });
    await av.history("AAA");
    expect(calls.map((c) => c.url)).toEqual(["https://www.alphavantage.co/query?function=EARNINGS&symbol=BRK-B&apikey=TESTKEY123", "https://www.alphavantage.co/query?function=EARNINGS&symbol=AAA&apikey=TESTKEY123"]);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(35);
    const down = new AlphaVantageEarnings("TESTKEY123", (async () => new Response("", { status: 503 })) as typeof fetch, 0);
    await expect(down.history("AAA")).rejects.toThrow("Alpha Vantage's earnings failed: HTTP 503");
  });
});

let db: Db;
const NOW = new Date("2026-11-11T14:00:00Z"); // market date 2026-11-11
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const UNIVERSE = ["U1", "U2", "U3", "U4", "U5", "U6"];

/** Replies by symbol (ok with one 2026 and one 2016 quarter by default), recording what was asked. */
function fakePort(replies: Record<string, HistoryReply | Error> = {}): EarningsHistoryPort & { asked: string[] } {
  const p = {
    asked: [] as string[],
    history: async (symbol: string): Promise<HistoryReply> => {
      p.asked.push(symbol);
      const r = replies[symbol];
      if (r instanceof Error) throw r;
      return r ?? parseEarningsJson(JSON.stringify({ quarterlyEarnings: [quarter("2026-09-30", "2026-11-02"), quarter("2016-09-30", "2016-11-01")] }));
    },
  };
  return p;
}

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("backfillEarningsHistory", () => {
  it("asks for priority names first, then the universe in order, a few a tick, storing quarters from 2017 on", async () => {
    const port = fakePort({ U1: { status: "none" } });
    const result = await backfillEarningsHistory(db, port, { env: "production", priority: ["P1", "U2"], now: NOW, universe: UNIVERSE });
    expect(port.asked).toEqual(["P1", "U2", "U1"]);
    expect(result).toEqual({
      status: "fetched",
      fetched: [
        { symbol: "P1", status: "ok", quarters: 1 },
        { symbol: "U2", status: "ok", quarters: 1 },
        { symbol: "U1", status: "none", quarters: 0 },
      ],
      limited: false,
      throttled: false,
      left: 4,
    });
    expect(await db.select().from(earningsHistory).orderBy(earningsHistory.symbol)).toMatchObject([
      { symbol: "P1", fiscalDateEnding: "2026-09-30", reportedDate: "2026-11-02", reportedEps: "1.10", estimatedEps: "1.00", surprisePct: "10", reportTime: "post-market" },
      { symbol: "U2", fiscalDateEnding: "2026-09-30" },
    ]);
    expect(await backfillProgress(db)).toEqual({ ok: 2, none: 1, error: 0, quarters: 2 });

    // The next tick moves on; nothing already asked for is asked again.
    await backfillEarningsHistory(db, port, { env: "production", priority: ["P1", "U2"], now: NOW, universe: UNIVERSE });
    expect(port.asked.slice(3)).toEqual(["U3", "U4", "U5"]);
  });

  it("stops at production's daily budget and starts again the next market date, and spends nothing in staging", async () => {
    const port = fakePort();
    const opts = { env: "production" as const, priority: [], universe: UNIVERSE };
    // Earlier ticks today asked for all but one of the day's budget.
    const earlier = Array.from({ length: BACKFILL.perDay.production - 1 }, (_, n) => ({ symbol: `E${n}`, fetchedOn: "2026-11-11", fetchedAt: NOW, status: "ok" as const, quarters: 1 }));
    await db.insert(earningsHistoryFetches).values(earlier);
    expect(await backfillEarningsHistory(db, port, { ...opts, now: NOW })).toMatchObject({ fetched: [{ symbol: "U1" }] });
    expect(await backfillEarningsHistory(db, port, { ...opts, now: at(0.1) })).toEqual({ status: "skipped", reason: "today's 20 requests are spent" });
    expect(await backfillEarningsHistory(db, port, { ...opts, now: at(1) })).toMatchObject({ fetched: [{ symbol: "U2" }, { symbol: "U3" }, { symbol: "U4" }] });

    expect(await backfillEarningsHistory(db, port, { ...opts, env: "staging", now: at(2) })).toEqual({ status: "skipped", reason: "no backfill in staging: the free key's requests go to production" });
    expect(port.asked).toEqual(["U1", "U2", "U3", "U4"]);
  });

  it("records a failed company against today's budget and retries it on a later day, overwriting what it stored", async () => {
    const port = fakePort({ U1: new Error("socket hang up") });
    const opts = { env: "production" as const, priority: [], universe: ["U1", "U2"] };
    expect(await backfillEarningsHistory(db, port, { ...opts, now: NOW })).toMatchObject({ fetched: [{ symbol: "U1", status: "error" }, { symbol: "U2", status: "ok" }], left: 1 });
    expect(await db.select().from(earningsHistoryFetches).orderBy(earningsHistoryFetches.symbol)).toMatchObject([{ symbol: "U1", status: "error", error: "socket hang up" }, { symbol: "U2", status: "ok" }]);
    expect(await backfillEarningsHistory(db, port, { ...opts, now: at(0.1) })).toEqual({ status: "skipped", reason: "every company has been fetched" });

    const retry = fakePort();
    expect(await backfillEarningsHistory(db, retry, { ...opts, now: at(1) })).toMatchObject({ fetched: [{ symbol: "U1", status: "ok" }], left: 0 });
    expect(await db.select().from(earningsHistoryFetches).orderBy(earningsHistoryFetches.symbol)).toMatchObject([{ symbol: "U1", status: "ok", error: null, fetchedOn: "2026-11-12" }, { symbol: "U2" }]);
  });

  it("throws when every company asked for failed", async () => {
    const port = fakePort({ U1: new Error("down"), U2: new Error("down") });
    await expect(backfillEarningsHistory(db, port, { env: "production", priority: [], now: NOW, universe: ["U1", "U2"] })).rejects.toThrow("Alpha Vantage's earnings failed for U1, U2");
  });

  it("stops at Alpha Vantage's first refusal without counting it", async () => {
    const port = fakePort({ U2: { status: "limited", perSecond: false, note: "25 requests per day" } });
    expect(await backfillEarningsHistory(db, port, { env: "production", priority: [], now: NOW, universe: UNIVERSE })).toMatchObject({ fetched: [{ symbol: "U1" }], limited: true });
    expect(port.asked).toEqual(["U1", "U2"]);
    expect((await db.select().from(earningsHistoryFetches)).map((r) => r.symbol)).toEqual(["U1"]);
  });

  it("stops the run, but not the day, when refused for going faster than one a second", async () => {
    const port = fakePort({ U1: { status: "limited", perSecond: true, note: "1 request per second" } });
    expect(await backfillEarningsHistory(db, port, { env: "production", priority: [], now: NOW, universe: UNIVERSE })).toMatchObject({ fetched: [], limited: false, throttled: true, left: 6 });
  });
});

describe("the earnings-backfill job", () => {
  const deps = (earningsHistory?: EarningsHistoryPort) => ({ db, env: "production" as const, broker: new FakeBroker(), mailer: new FakeMailer(), now: () => NOW, earningsHistory });

  it("skips without a key, fetches the universe in order, and waits for the next market date after a refusal", async () => {
    expect(await runJob(deps(), "earnings-backfill", NOW)).toEqual({ status: "skipped", reason: "no ALPHAVANTAGE_API_KEY" });
    const port = fakePort({ [EARNINGS_UNIVERSE[1]!]: { status: "limited", perSecond: false, note: "25 requests per day" } });
    expect(await runJob(deps(port), "earnings-backfill", at(0.01))).toMatchObject({
      status: "succeeded",
      detail: { fetched: [{ symbol: EARNINGS_UNIVERSE[0], status: "ok" }], limited: true, progress: { ok: 1, quarters: 1 } },
    });
    expect(await runJob({ ...deps(port), now: () => at(0.02) }, "earnings-backfill", at(0.02))).toMatchObject({ status: "skipped", reason: expect.stringContaining("resumes tomorrow") });
    const tomorrow = fakePort();
    expect(await runJob({ ...deps(tomorrow), now: () => at(1) }, "earnings-backfill", at(1))).toMatchObject({ status: "succeeded", detail: { limited: false } });
    expect(tomorrow.asked).toEqual(EARNINGS_UNIVERSE.slice(1, 1 + BACKFILL.perTick));
  });
});

describe("EARNINGS_UNIVERSE", () => {
  it("holds unique tickers in Alpaca's form", () => {
    expect(EARNINGS_UNIVERSE.length).toBeGreaterThan(2000);
    expect(new Set(EARNINGS_UNIVERSE).size).toBe(EARNINGS_UNIVERSE.length);
    expect(EARNINGS_UNIVERSE.every((t) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(t))).toBe(true);
  });
});
