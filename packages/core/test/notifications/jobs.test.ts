import { beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../../src/audit.js";
import { syncBroker } from "../../src/broker/sync.js";
import { recordCapitalFlows } from "../../src/capital/ledger.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, benchmarkCloses, equitySnapshots, notifications, thesisEvents } from "../../src/db/schema.js";
import type { TradingEnv } from "../../src/env.js";
import type { JobDeps } from "../../src/jobs.js";
import { notifyDigest, notifyUrgent, notifyWeekly } from "../../src/notifications/jobs.js";
import { headline } from "../../src/notifications/weekly.js";
import { submitStrategy } from "../../src/portfolio/store.js";
import { strategy, thesis } from "../portfolio/fixtures.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb } from "../helpers.js";
import { FakeMailer } from "./fake-mailer.js";

let db: Db;
let broker: FakeBroker;
let mailer: FakeMailer;
let clock: Date;
const CLOSE = new Date("2026-11-02T21:00:00Z"); // 16:00 EST

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
  mailer = new FakeMailer();
  clock = new Date("2026-11-02T15:00:00Z");
});

const ctx = (env: TradingEnv = "production"): JobDeps & { runId: string; scheduledFor: Date } => ({
  db,
  env,
  broker,
  mailer,
  now: () => clock,
  runId: "run",
  scheduledFor: clock,
});

describe("notify-urgent", () => {
  it("emails a tick's urgent events together, once", async () => {
    await recordEvent(db, { actor: "owner", kind: "risk.kill_switch_on", payload: { reason: "investigating" } });
    await recordEvent(db, { actor: "system", kind: "broker.config_unsafe", payload: { reasons: ["shorting enabled (must be off)"] } });
    await recordEvent(db, { actor: "system", kind: "order.filled", subject: "VTI", payload: {} }); // digest, not urgent

    expect(await notifyUrgent(ctx())).toMatchObject({ status: "succeeded", detail: { events: 2, sent: 1 } });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toBe("Trader: Kill switch ON (+1 more)");

    expect(await notifyUrgent(ctx())).toMatchObject({ detail: { events: 0, sent: 0 } });
    expect(mailer.sent).toHaveLength(1);
  });

  it("queues but doesn't send on staging", async () => {
    await recordEvent(db, { actor: "owner", kind: "risk.kill_switch_on", payload: { reason: "x" } });
    await notifyUrgent(ctx("staging"));
    expect(mailer.sent).toEqual([]);
    expect((await db.select().from(notifications))[0]).toMatchObject({ status: "suppressed", subject: "[paper] Trader: Kill switch ON" });
  });

  it("throttles repeated failures of one job to one email per 6 hours, then counts the folded ones", async () => {
    const fail = () => recordEvent(db, { actor: "system", kind: "job.failed", subject: "sync-broker", payload: { error: "fetch failed" } });
    await fail();
    await notifyUrgent(ctx());
    for (let i = 0; i < 3; i++) {
      clock = new Date(clock.getTime() + 15 * 60_000);
      await fail();
      await notifyUrgent(ctx());
    }
    expect(mailer.sent).toHaveLength(1);

    clock = new Date(clock.getTime() + 6 * 60 * 60_000);
    await fail();
    await notifyUrgent(ctx());
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]?.text).toContain("3 more failure(s) of this job since the last email.");
  });

  it("doesn't throttle different jobs against each other", async () => {
    await recordEvent(db, { actor: "system", kind: "job.failed", subject: "sync-broker", payload: { error: "a" } });
    await recordEvent(db, { actor: "system", kind: "job.failed", subject: "notify-digest", payload: { error: "b" } });
    await notifyUrgent(ctx());
    expect(mailer.sent[0]?.subject).toBe("Trader: Job failed: sync-broker (+1 more)");
  });

  it("ignores urgent events older than a week", async () => {
    const old = await recordEvent(db, { actor: "owner", kind: "risk.kill_switch_on", payload: { reason: "old" } });
    clock = new Date(old.at.getTime() + 8 * 86_400_000);
    expect(await notifyUrgent(ctx())).toMatchObject({ detail: { events: 0 } });
  });
});

describe("notify-digest", () => {
  async function tradingDay() {
    await syncBroker(db, broker, "production", new Date("2026-11-02T15:00:00Z"));
    // Dated on the simulated trading day (recordEvent stamps the real clock).
    await db.insert(auditEvents).values({
      actor: "system",
      kind: "order.filled",
      subject: "VTI",
      at: new Date("2026-11-02T14:35:01Z"),
      payload: { side: "buy", filledQty: "0.016339869", filledAvgPrice: "306.01" },
    });
  }

  it("waits until 20 minutes after the close", async () => {
    await tradingDay();
    clock = new Date(CLOSE.getTime() + 15 * 60_000);
    expect(await notifyDigest(ctx())).toEqual({ status: "skipped", reason: "before digest time" });
  });

  it("sends one digest per trading day with the day's trades", async () => {
    await tradingDay();
    clock = new Date(CLOSE.getTime() + 30 * 60_000);
    expect(await notifyDigest(ctx())).toMatchObject({ status: "succeeded", detail: { date: "2026-11-02", events: 1, sent: 1 } });
    expect(mailer.sent[0]?.subject).toBe("Trader daily: 0%, 1 trade (Mon Nov 2)");
    expect(mailer.sent[0]?.text).toContain("Bought 0.016339869 VTI @ $306.01");

    clock = new Date(clock.getTime() + 15 * 60_000);
    expect(await notifyDigest(ctx())).toEqual({ status: "skipped", reason: "digest already queued today" });
    expect(mailer.sent).toHaveLength(1);
  });

  it("includes the money-weighted comparison once a transfer is recorded", async () => {
    await tradingDay();
    broker.activities.push({ id: "csd-1", type: "CSD", at: new Date("2026-11-02T15:30:00Z"), symbol: null, side: null, qty: null, price: null, netAmount: "1000", orderId: null, raw: { created_at: "2026-11-02T15:30:00Z" } });
    await syncBroker(db, broker, "staging", new Date("2026-11-02T15:45:00Z"));
    await recordCapitalFlows(db, new Date("2026-11-02T15:45:00Z"));
    broker.clock.isOpen = false;
    await syncBroker(db, broker, "staging", new Date(CLOSE.getTime() + 10 * 60_000)); // the closing snapshot
    clock = new Date(CLOSE.getTime() + 30 * 60_000);
    await notifyDigest(ctx());
    expect(mailer.sent[0]?.text).toContain("Since Mon Nov 2: started with $1000, now $1000"); // no VTI closes in the fake
  });

  it("sends on a quiet day too", async () => {
    await syncBroker(db, broker, "production", new Date("2026-11-02T15:00:00Z"));
    clock = new Date(CLOSE.getTime() + 30 * 60_000);
    await notifyDigest(ctx());
    expect(mailer.sent[0]?.subject).toBe("Trader daily: 0%, 0 trades (Mon Nov 2)");
  });

  it("skips non-trading days", async () => {
    clock = new Date("2026-11-01T22:00:00Z"); // Sunday
    expect(await notifyDigest(ctx())).toEqual({ status: "skipped", reason: "not a trading day" });
  });
});

describe("notify-weekly", () => {
  // The week of Mon 2026-11-02; Friday's close is 21:00 UTC.
  const FRI_CLOSE = new Date("2026-11-06T21:00:00Z");
  const session = (date: string) => ({ date, open: new Date(`${date}T14:30:00Z`), close: new Date(`${date}T21:00:00Z`) });

  async function week() {
    broker.calendar = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"].map(session);
    await syncBroker(db, broker, "production", new Date("2026-11-02T15:00:00Z"));
    await db.insert(equitySnapshots).values([
      { tradingDate: "2026-10-30", equity: "1000", cash: null, longMarketValue: null, recordedAt: new Date("2026-10-30T21:10:00Z") },
      { tradingDate: "2026-11-06", equity: "1050", cash: "0", longMarketValue: "1050", recordedAt: new Date("2026-11-06T21:10:00Z") },
    ]);
    await db.insert(benchmarkCloses).values([
      { symbol: "VTI", tradingDate: "2026-10-30", close: "300" },
      { symbol: "VTI", tradingDate: "2026-11-06", close: "306" },
    ]);
    await submitStrategy(db, strategy({ summary: "Version 1: Change. Adds AAPL on services growth.\n\nMore detail.", conviction: [thesis({ reviewBy: "2026-11-12" })] }), "claude", new Date("2026-11-04T13:00:00Z"));
    await db.insert(thesisEvents).values({ thesisId: "lkq-a", symbol: "LKQ", kind: "overdue", strategyVersion: 1, reason: "past its review date (2026-11-04) without a later one", at: new Date("2026-11-05T15:00:00Z") });
  }

  it("waits for the week's last session, an hour after the close, and today's snapshot", async () => {
    await week();
    clock = new Date("2026-11-05T22:30:00Z"); // Thursday, with a Friday session ahead
    expect(await notifyWeekly(ctx())).toEqual({ status: "skipped", reason: "not the week's last session" });
    clock = new Date(FRI_CLOSE.getTime() + 30 * 60_000);
    expect(await notifyWeekly(ctx())).toEqual({ status: "skipped", reason: "before letter time" });
    await db.delete(equitySnapshots);
    clock = new Date(FRI_CLOSE.getTime() + 61 * 60_000);
    expect(await notifyWeekly(ctx())).toEqual({ status: "skipped", reason: "waiting for today's after-close equity snapshot" });
  });

  it("sends one letter per week: the week vs VTI, the week's decisions, and what's coming up", async () => {
    await week();
    clock = new Date(FRI_CLOSE.getTime() + 61 * 60_000);
    expect(await notifyWeekly(ctx())).toMatchObject({ status: "succeeded", detail: { weekOf: "2026-11-02", queued: true, sent: 1 } });
    const email = mailer.sent[0]!;
    expect(email.subject).toBe("Trader weekly: +5% vs VTI +2% (week of Mon Nov 2)");
    expect(email.text).toContain("v1 (claude): Version 1: Change. Adds AAPL on services growth.");
    expect(email.text).toContain("LKQ (lkq-a), overdue: past its review date (2026-11-04) without a later one");
    expect(email.text).toContain("AAPL (aapl-services): Thu Nov 12");
    expect(email.text).toContain("Normal: drawdown");

    clock = new Date(clock.getTime() + 15 * 60_000);
    expect(await notifyWeekly(ctx())).toEqual({ status: "skipped", reason: "this week's letter already queued" });
    expect(mailer.sent).toHaveLength(1);
  });

  it("counts a resubmission that only reaffirms the strategy rather than listing it", async () => {
    await week();
    await submitStrategy(db, strategy({ summary: "Version 2: Keep. Reaffirmed: no material change.", conviction: [thesis({ reviewBy: "2026-11-12" })] }), "claude", new Date("2026-11-05T13:00:00Z"));
    clock = new Date(FRI_CLOSE.getTime() + 61 * 60_000);
    await notifyWeekly(ctx());
    const text = mailer.sent[0]!.text;
    expect(text).toContain("v1 (claude): Version 1: Change.");
    expect(text).not.toContain("v2 (claude)");
    expect(text).toContain("Reaffirmed unchanged 1 time");
  });

  it("is written but not sent on staging", async () => {
    await week();
    clock = new Date(FRI_CLOSE.getTime() + 61 * 60_000);
    await notifyWeekly(ctx("staging"));
    expect(mailer.sent).toHaveLength(0);
    expect((await db.select().from(notifications)).map((n) => [n.type, n.status, n.weekOf])).toEqual([["weekly", "suppressed", "2026-11-02"]]);
  });

  it("takes a strategy summary's first line as its headline", () => {
    expect(headline("\n  Version 9: Keep.  \nDetails")).toBe("Version 9: Keep.");
    expect(headline("x".repeat(300))).toHaveLength(240);
  });
});

