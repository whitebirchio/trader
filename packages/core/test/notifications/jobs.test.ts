import { beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../../src/audit.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, notifications } from "../../src/db/schema.js";
import type { TradingEnv } from "../../src/env.js";
import type { JobDeps } from "../../src/jobs.js";
import { notifyDigest, notifyUrgent } from "../../src/notifications/jobs.js";
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
