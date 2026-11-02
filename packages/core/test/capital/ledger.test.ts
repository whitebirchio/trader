import { beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "../../src/broker/port.js";
import { recordCapitalFlows, toCapitalFlow } from "../../src/capital/ledger.js";
import type { Db } from "../../src/db/client.js";
import { brokerActivities, capitalFlows } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb, deps } from "../helpers.js";

function activity(type: string, netAmount: string | null, raw: Record<string, unknown>, at = new Date("2026-04-19T19:54:49.414Z")): Activity {
  return { id: `${type}-${netAmount}-${at.toISOString()}`, type, at, symbol: null, side: null, qty: null, price: null, netAmount, orderId: null, raw };
}

describe("toCapitalFlow", () => {
  it("records the live deposit shape at its created_at, not its booking date", () => {
    // Production, April 2026: instant ACH created Sunday, booked Monday.
    const flow = toCapitalFlow(
      activity("CSD", "1000", { date: "2026-04-20", created_at: "2026-04-19T19:54:49.414619Z", status: "executed" }),
    );
    expect(flow).toMatchObject({ amount: "1000", kind: "deposit", timedBy: "created_at", status: "executed" });
    expect(flow?.at.toISOString()).toBe("2026-04-19T19:54:49.414Z");
  });

  it("records the paper journal shape (booked the day before created_at)", () => {
    const at = new Date("2026-04-21T08:21:58.208Z");
    const flow = toCapitalFlow(activity("JNLC", "100000", { date: "2026-04-20", created_at: "2026-04-21T08:21:58.208602Z" }, at));
    expect(flow).toMatchObject({ amount: "100000", kind: "deposit", timedBy: "created_at", status: null });
    expect(flow?.at).toEqual(at);
  });

  it("marks a flow without created_at as timed by its booking date", () => {
    const flow = toCapitalFlow(activity("CSW", "-400", { date: "2026-11-03" }, new Date("2026-11-03T17:00:00Z")));
    expect(flow).toMatchObject({ amount: "-400", kind: "withdrawal", timedBy: "booking_date" });
  });

  it("labels money moving against its type as a reversal, keeping the sign", () => {
    expect(toCapitalFlow(activity("CSD", "-1000", { created_at: "x" }))).toMatchObject({ amount: "-1000", kind: "reversal" });
    expect(toCapitalFlow(activity("JNLS", "50", { created_at: "x" }))).toMatchObject({ amount: "50", kind: "reversal" });
  });

  it("ignores trades, dividends and zero or missing amounts", () => {
    expect(toCapitalFlow(activity("DIV", "2", {}))).toBeNull();
    expect(toCapitalFlow(activity("FILL", null, {}))).toBeNull();
    expect(toCapitalFlow(activity("CSD", "0", {}))).toBeNull();
    expect(toCapitalFlow(activity("CSD", null, {}))).toBeNull();
  });
});

describe("recordCapitalFlows", () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  async function insertActivity(id: string, type: string, netAmount: string, raw: Record<string, unknown>, at: Date) {
    await db.insert(brokerActivities).values({ id, type, at, netAmount, raw });
  }

  it("copies flow activities into the ledger once, however often it runs", async () => {
    await insertActivity("dep", "CSD", "1000", { created_at: "2026-04-19T19:54:49Z" }, new Date("2026-04-19T19:54:49Z"));
    await insertActivity("div", "DIV", "1.20", {}, new Date("2026-06-01T16:00:00Z"));
    await insertActivity("out", "CSW", "-200", {}, new Date("2026-11-03T17:00:00Z"));

    expect(await recordCapitalFlows(db)).toEqual({ added: 2, timedByBookingDate: 1 });
    expect(await recordCapitalFlows(db)).toEqual({ added: 0, timedByBookingDate: 0 });

    const rows = await db.select().from(capitalFlows);
    expect(rows.map((r) => [r.activityId, r.amount, r.kind]).sort()).toEqual([
      ["dep", "1000", "deposit"],
      ["out", "-200", "withdrawal"],
    ]);
  });

  it("picks up a flow that arrives after earlier ones were recorded", async () => {
    await insertActivity("dep", "CSD", "1000", { created_at: "2026-04-19T19:54:49Z" }, new Date("2026-04-19T19:54:49Z"));
    await recordCapitalFlows(db);
    await insertActivity("dep2", "CSD", "500", { created_at: "2026-11-02T15:00:00Z" }, new Date("2026-11-02T15:00:00Z"));
    expect(await recordCapitalFlows(db)).toEqual({ added: 1, timedByBookingDate: 0 });
  });
});

describe("sync-broker job", () => {
  it("records new transfers in the ledger before the drawdown check", async () => {
    const { db } = await createTestDb();
    const broker = new FakeBroker();
    broker.activities.push({
      id: "csd-live",
      type: "CSD",
      at: new Date("2026-11-02T14:50:00Z"),
      symbol: null,
      side: null,
      qty: null,
      price: null,
      netAmount: "1000",
      orderId: null,
      raw: { created_at: "2026-11-02T14:50:00Z", status: "executed" },
    });
    const outcome = await runJob({ ...deps(db, "staging", broker), now: () => broker.now }, "sync-broker", broker.now);
    expect(outcome).toMatchObject({ status: "succeeded", detail: { capital: { added: 1, timedByBookingDate: 0 } } });
    expect(await db.select().from(capitalFlows)).toMatchObject([{ activityId: "csd-live", amount: "1000", kind: "deposit" }]);
  });
});
