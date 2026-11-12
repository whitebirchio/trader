import { beforeEach, describe, expect, it } from "vitest";
import { AlphaVantageEarnings } from "../../src/agent/earnings-history.js";
import { ESTIMATES, type EstimatesPort, type EstimatesReply, estimatesFor, parseEstimatesJson, refreshEstimates } from "../../src/agent/estimates.js";
import type { Db } from "../../src/db/client.js";
import { earningsEstimates, jobRuns } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { FakeMailer } from "../notifications/fake-mailer.js";
import { createTestDb } from "../helpers.js";
import { strategy, thesis } from "../portfolio/fixtures.js";

const TODAY = "2026-11-12";
const NOW = new Date("2026-11-12T15:00:00Z"); // market date 2026-11-12
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const row = (date: string, horizon: string, avg: string, extra: Record<string, string | null> = {}) => ({
  date,
  horizon,
  eps_estimate_average: avg,
  eps_estimate_average_7_days_ago: avg,
  eps_estimate_average_30_days_ago: "2.0000",
  eps_estimate_average_60_days_ago: "2.0000",
  eps_estimate_average_90_days_ago: "2.1000",
  eps_estimate_revision_up_trailing_7_days: "1.0000",
  eps_estimate_revision_down_trailing_7_days: null,
  eps_estimate_revision_up_trailing_30_days: "2.0000",
  eps_estimate_revision_down_trailing_30_days: "5.0000",
  eps_estimate_analyst_count: "23.0000",
  revenue_estimate_average: "124000404410.00",
  ...extra,
});

const reply = JSON.stringify({
  symbol: "AAA",
  estimates: [
    row("2028-09-30", "fiscal year", "10.8"),
    row("2027-09-30", "fiscal year", "9.4"),
    row("2027-03-31", "fiscal quarter", "2.15"),
    row("2026-12-31", "fiscal quarter", "1.90"),
    // Past periods, one mislabeled with a future-looking estimate: ignored.
    row("2026-09-30", "fiscal quarter", "2.92"),
    row("2026-06-30", "fiscal quarter", "1.89"),
  ],
});

describe("parseEstimatesJson (#105)", () => {
  it("takes the first quarter and fiscal year dated after today, and turns blanks into null", () => {
    expect(parseEstimatesJson(reply, TODAY)).toEqual({
      status: "ok",
      quarter: {
        period: "2026-12-31",
        eps: "1.90",
        eps7dAgo: "1.90",
        eps30dAgo: "2.0000",
        eps60dAgo: "2.0000",
        eps90dAgo: "2.1000",
        raised7d: 1,
        cut7d: null,
        raised30d: 2,
        cut30d: 5,
        analysts: 23,
        revenue: "124000404410.00",
      },
      fiscalYear: expect.objectContaining({ period: "2027-09-30", eps: "9.4" }),
    });
  });

  it("treats a notice as a refusal, and no future period as nothing", () => {
    expect(parseEstimatesJson('{"Information": "Our standard API rate limit is 25 requests per day."}', TODAY)).toMatchObject({ status: "limited", perSecond: false });
    expect(parseEstimatesJson('{"Information": "spread out your free API requests more sparingly (1 request per second)"}', TODAY)).toMatchObject({ status: "limited", perSecond: true });
    expect(parseEstimatesJson("{}", TODAY)).toEqual({ status: "none" });
    expect(parseEstimatesJson(JSON.stringify({ estimates: [row("2026-06-30", "fiscal quarter", "1.89")] }), TODAY)).toEqual({ status: "none" });
    expect(() => parseEstimatesJson("<html>", TODAY)).toThrow("unreadable estimates");
  });
});

describe("AlphaVantageEarnings.estimates", () => {
  it("asks for EARNINGS_ESTIMATES in Alpha Vantage's symbol form, and fails on an HTTP error", async () => {
    const urls: string[] = [];
    const av = new AlphaVantageEarnings("TESTKEY123", (async (u: URL) => (urls.push(u.toString()), new Response(reply, { status: 200 }))) as typeof fetch, 0);
    expect(await av.estimates("BRK.B", NOW)).toMatchObject({ status: "ok", quarter: { period: "2026-12-31" } });
    expect(urls).toEqual(["https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=BRK-B&apikey=TESTKEY123"]);
    const down = new AlphaVantageEarnings("TESTKEY123", (async () => new Response("", { status: 503 })) as typeof fetch, 0);
    await expect(down.estimates("AAA", NOW)).rejects.toThrow("Alpha Vantage's estimates failed: HTTP 503");
  });
});

let db: Db;

/** Replies by symbol (this file's reply by default), recording what was asked. */
function fakePort(replies: Record<string, EstimatesReply | Error> = {}): EstimatesPort & { asked: string[] } {
  const p = {
    asked: [] as string[],
    estimates: async (symbol: string, now: Date): Promise<EstimatesReply> => {
      p.asked.push(symbol);
      const r = replies[symbol];
      if (r instanceof Error) throw r;
      return r ?? parseEstimatesJson(reply, now.toISOString().slice(0, 10));
    },
  };
  return p;
}

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("refreshEstimates", () => {
  it("fetches names in order, one a tick and three a day, then waits a week for each", async () => {
    const port = fakePort({ BBB: { status: "none" } });
    const names = ["AAA", "BBB", "CCC", "DDD"];
    expect(await refreshEstimates(db, port, names, NOW)).toEqual({ status: "fetched", fetched: [{ symbol: "AAA", status: "ok" }], limited: false, throttled: false, due: 3 });
    await refreshEstimates(db, port, names, at(0.01));
    await refreshEstimates(db, port, names, at(0.02));
    expect(await refreshEstimates(db, port, names, at(0.03))).toEqual({ status: "skipped", reason: `today's ${ESTIMATES.perDay} requests are spent (1 due)` });
    expect(port.asked).toEqual(["AAA", "BBB", "CCC"]);
    await refreshEstimates(db, port, names, at(1));
    expect(await refreshEstimates(db, port, names, at(1.01))).toEqual({ status: "skipped", reason: "every name was fetched within 7 days" });
    // A week on, the first names are due again.
    expect(await refreshEstimates(db, port, names, at(7))).toMatchObject({ fetched: [{ symbol: "AAA" }] });
  });

  it("retries a failed fetch the next day, and stops at a refusal without counting it", async () => {
    const port = fakePort({ AAA: new Error("socket hang up"), BBB: { status: "limited", perSecond: false, note: "25 a day" } });
    await expect(refreshEstimates(db, port, ["AAA"], NOW)).rejects.toThrow("Alpha Vantage's estimates failed for AAA");
    expect(await db.select().from(earningsEstimates)).toMatchObject([{ symbol: "AAA", status: "error", error: "socket hang up" }]);
    expect(await refreshEstimates(db, port, ["BBB"], at(0.01))).toEqual({ status: "fetched", fetched: [], limited: true, throttled: false, due: 1 });
    expect((await db.select().from(earningsEstimates)).map((r) => r.symbol)).toEqual(["AAA"]);
    expect(await refreshEstimates(db, fakePort(), ["AAA"], at(1))).toMatchObject({ fetched: [{ symbol: "AAA", status: "ok" }] });
  });
});

describe("estimatesFor", () => {
  it("gives each name's latest snapshot with estimates as trends, flagging a 3% fall over 30 days", async () => {
    await refreshEstimates(db, fakePort(), ["AAA"], NOW);
    expect((await estimatesFor(db, ["AAA", "ZZZ"])).get("AAA")).toEqual({
      asOf: TODAY,
      // 1.90 against 2.00 30 days ago is −5%; against 2.10 90 days ago, −9.5%.
      nextQuarter: { period: "2026-12-31", eps: "1.90", change30dPct: "-5", change90dPct: "-9.5", raised30d: 2, cut30d: 5, analysts: 23 },
      fiscalYear: { period: "2027-09-30", eps: "9.4", change30dPct: "370", change90dPct: "347.6", raised30d: 2, cut30d: 5, analysts: 23 },
      falling: true,
    });
    expect((await estimatesFor(db, ["ZZZ"])).size).toBe(0);
  });

  it("doesn't flag a small move, and skips a change from an estimate too near zero to divide by", async () => {
    const steady = JSON.stringify({ estimates: [row("2026-12-31", "fiscal quarter", "1.97"), row("2027-09-30", "fiscal year", "0.10", { eps_estimate_average_30_days_ago: "0.005" })] });
    await refreshEstimates(db, fakePort({ AAA: parseEstimatesJson(steady, TODAY) }), ["AAA"], NOW);
    const view = (await estimatesFor(db, ["AAA"])).get("AAA")!;
    expect([view.nextQuarter?.change30dPct, view.fiscalYear?.change30dPct, view.falling]).toEqual(["-1.5", null, false]);
  });
});

describe("the earnings-estimates job", () => {
  const deps = (estimates?: EstimatesPort) => ({ db, env: "production" as const, broker: new FakeBroker(), mailer: new FakeMailer(), now: () => NOW, estimates });

  it("skips without a key, fetches theses first, and stops for the day after either Alpha Vantage job is refused", async () => {
    expect(await runJob(deps(), "earnings-estimates", NOW)).toEqual({ status: "skipped", reason: "no ALPHAVANTAGE_API_KEY" });
    await submitStrategy(db, strategy({ conviction: [thesis({ id: "aaa-idea", symbol: "AAA" })] }), "owner", NOW);
    const port = fakePort();
    expect(await runJob(deps(port), "earnings-estimates", at(0.01))).toMatchObject({ status: "succeeded", detail: { fetched: [{ symbol: "AAA", status: "ok" }] } });
    // The backfill was refused for the day's limit: estimates wait too.
    await db.insert(jobRuns).values({ job: "earnings-backfill", scheduledFor: at(0.02), status: "succeeded", detail: { limited: true } });
    expect(await runJob({ ...deps(port), now: () => at(0.03) }, "earnings-estimates", at(0.03))).toMatchObject({ status: "skipped", reason: expect.stringContaining("resumes tomorrow") });
  });
});
