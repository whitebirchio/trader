import { beforeEach, describe, expect, it } from "vitest";
import { recordEvent } from "../../src/audit.js";
import type { Db } from "../../src/db/client.js";
import { notificationItems, notifications } from "../../src/db/schema.js";
import { BACKOFF_MINUTES, deliver, enqueue, foldEvents } from "../../src/notifications/outbox.js";
import { FakeMailer } from "./fake-mailer.js";
import { createTestDb } from "../helpers.js";

let db: Db;
let mailer: FakeMailer;
const now = new Date("2026-11-02T15:00:00Z");
const email = { subject: "Trader: Kill switch ON", text: "t", html: "<p>t</p>" };
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

beforeEach(async () => {
  ({ db } = await createTestDb());
  mailer = new FakeMailer();
});

async function event() {
  return (await recordEvent(db, { actor: "owner", kind: "risk.kill_switch_on", payload: { reason: "x" } })).id;
}

describe("enqueue", () => {
  it("queues once per event and type", async () => {
    const id = await event();
    expect((await enqueue(db, "production", { type: "urgent", email, eventIds: [id] }, now)).status).toBe("queued");
    expect(await enqueue(db, "production", { type: "urgent", email, eventIds: [id] }, now)).toEqual({ status: "duplicate" });
    expect(await db.select().from(notifications)).toHaveLength(1);
    // The same event may still appear in a digest.
    expect((await enqueue(db, "production", { type: "digest", email, eventIds: [id], digestDate: "2026-11-02" }, now)).status).toBe("queued");
  });

  it("queues one digest per date", async () => {
    await enqueue(db, "production", { type: "digest", email, eventIds: [], digestDate: "2026-11-02" }, now);
    expect(await enqueue(db, "production", { type: "digest", email, eventIds: [], digestDate: "2026-11-02" }, now)).toEqual({ status: "duplicate" });
  });

  it("backs out entirely when another run covered some of the events", async () => {
    const [a, b] = [await event(), await event()];
    await enqueue(db, "production", { type: "urgent", email, eventIds: [a] }, now);
    expect(await enqueue(db, "production", { type: "urgent", email, eventIds: [a, b] }, now)).toEqual({ status: "duplicate" });
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect((await db.select().from(notificationItems)).map((i) => i.auditEventId)).toEqual([a]);
  });

  it("suppresses everything but test emails on staging", async () => {
    const urgent = await enqueue(db, "staging", { type: "urgent", email, eventIds: [await event()] }, now);
    const test = await enqueue(db, "staging", { type: "test", email, eventIds: [] }, now);
    expect(urgent.status === "queued" && urgent.notification.status).toBe("suppressed");
    expect(test.status === "queued" && test.notification.status).toBe("pending");
    await deliver(db, mailer, now);
    expect(mailer.sent.map((m) => m.subject)).toEqual([email.subject]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("folds events without an email", async () => {
    const id = await event();
    await foldEvents(db, "urgent", [id], now);
    expect(await enqueue(db, "production", { type: "urgent", email, eventIds: [id] }, now)).toEqual({ status: "duplicate" });
  });
});

describe("deliver", () => {
  it("sends due emails and records the message id", async () => {
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    expect(await deliver(db, mailer, now)).toEqual({ sent: 1, retrying: 0, failed: 0 });
    const [row] = await db.select().from(notifications);
    expect(row).toMatchObject({ status: "sent", messageId: "msg-1", attempts: 0 });
    expect(await deliver(db, mailer, minutes(1))).toEqual({ sent: 0, retrying: 0, failed: 0 });
  });

  it("retries with backoff and gives up after 5 attempts", async () => {
    mailer.failNext = 99;
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    const schedule = [0, 1, 1 + 5, 1 + 5 + 15, 1 + 5 + 15 + 60];
    const results = [];
    for (const m of schedule) results.push(await deliver(db, mailer, minutes(m)));
    expect(results.map((r) => (r.failed ? "failed" : r.retrying ? "retry" : "-"))).toEqual(["retry", "retry", "retry", "retry", "failed"]);
    const [row] = await db.select().from(notifications);
    expect(row).toMatchObject({ status: "failed", attempts: 5, lastError: "smtp down" });
  });

  it("doesn't retry before the backoff elapses", async () => {
    mailer.failNext = 1;
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    await deliver(db, mailer, now);
    expect((await deliver(db, mailer, new Date(now.getTime() + 30_000))).sent).toBe(0);
    expect((await deliver(db, mailer, minutes(1))).sent).toBe(1);
  });

  it("sends once when two deliveries overlap", async () => {
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    await Promise.all([deliver(db, mailer, now), deliver(db, mailer, now)]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("retries a send whose run died mid-flight, once stale", async () => {
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    await db.update(notifications).set({ status: "sending", claimedAt: now });
    expect((await deliver(db, mailer, minutes(5))).sent).toBe(0);
    expect((await deliver(db, mailer, minutes(11))).sent).toBe(1);
  });

  it("counts an interrupted send as an attempt", async () => {
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    await db.update(notifications).set({ status: "sending", claimedAt: now });
    expect((await deliver(db, mailer, minutes(11))).sent).toBe(1);
    expect((await db.select().from(notifications))[0]).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("gives up on an email whose sends keep being interrupted, instead of resending forever", async () => {
    await enqueue(db, "production", { type: "urgent", email, eventIds: [await event()] }, now);
    // Interrupted on its last allowed attempt: the row is left `sending` with every retry used.
    await db.update(notifications).set({ status: "sending", claimedAt: now, attempts: BACKOFF_MINUTES.length });
    expect(await deliver(db, mailer, minutes(11))).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect(mailer.sent).toHaveLength(0);
    expect((await db.select().from(notifications))[0]).toMatchObject({ status: "failed", lastError: "interrupted mid-send too many times" });
  });
});
