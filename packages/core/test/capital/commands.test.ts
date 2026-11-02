import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { CalendarDay } from "../../src/broker/port.js";
import { processCapital, processCommands, processWithdrawal, queueCommand } from "../../src/capital/commands.js";
import { recordCapitalFlows } from "../../src/capital/ledger.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, brokerAccount, brokerActivities, capitalCommandResults, orders, strategies, withdrawals } from "../../src/db/schema.js";
import { runJob } from "../../src/jobs.js";
import { marketTimeToUtc } from "../../src/time.js";
import { FakeBroker } from "../broker/fake-broker.js";
import { createTestDb, deps } from "../helpers.js";

const day = (date: string): CalendarDay => ({ date, open: marketTimeToUtc(date, "09:30"), close: marketTimeToUtc(date, "16:00") });
const CALENDAR = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map(day);
const at = (date: string, time: string) => marketTimeToUtc(date, time);
const MON_10 = at("2026-11-02", "10:00");
/** Commands a second apart: they're processed in the order they arrived. */
const sec = (n: number) => new Date(MON_10.getTime() + n * 1000);

let db: Db;

async function setAccount(over: Partial<typeof brokerAccount.$inferInsert> = {}) {
  const row = {
    id: 1,
    accountNumber: "PA1",
    status: "ACTIVE",
    cash: "0",
    equity: "1000",
    lastEquity: "1000",
    longMarketValue: "1000",
    buyingPower: "0",
    multiplier: "1",
    tradingBlocked: false,
    accountBlocked: false,
    config: {},
    tradingAllowed: true,
    syncedAt: MON_10,
    ...over,
  };
  await db.insert(brokerAccount).values(row).onConflictDoUpdate({ target: brokerAccount.id, set: row });
}

const events = async () => (await db.select().from(auditEvents)).map((e) => ({ kind: e.kind, actor: e.actor, payload: e.payload }));
const kinds = async () => (await events()).map((e) => e.kind);
const theWithdrawal = async () => (await db.select().from(withdrawals))[0]!;

beforeEach(async () => {
  ({ db } = await createTestDb());
  await setAccount();
});

describe("processCommands", () => {
  it("opens a request in planning with Claude's deadline, and emails it as the owner's", async () => {
    const command = await queueCommand(db, { kind: "request", amount: "500", requestedBy: "cli" }, MON_10);
    const [result] = await processCommands(db, MON_10, CALENDAR);
    expect(result?.outcome).toMatchObject({ status: "accepted" });

    const w = await theWithdrawal();
    expect(w).toMatchObject({ status: "planning", amount: "500", withdrawn: "0", commandId: command.id, requestedAt: MON_10 });
    expect(w.deadline).toEqual(at("2026-11-02", "13:00")); // the 12:00 ET run + 60 min
    expect(await events()).toEqual([
      { kind: "capital.withdrawal_requested", actor: "owner", payload: expect.objectContaining({ commandId: command.id, amount: "500", requestedBy: "cli" }) },
    ]);
    expect(await db.select().from(capitalCommandResults)).toMatchObject([{ commandId: command.id, outcome: "accepted", withdrawalId: w.id }]);
  });

  it("processes each command once", async () => {
    await queueCommand(db, { kind: "request", amount: "500", requestedBy: "cli" }, MON_10);
    await processCommands(db, MON_10, CALENDAR);
    expect(await processCommands(db, MON_10, CALENDAR)).toEqual([]);
    expect(await db.select().from(withdrawals)).toHaveLength(1);
  });

  it("rejects, records and emails a bad command instead of guessing", async () => {
    await queueCommand(db, { kind: "request", amount: "five hundred", requestedBy: "dashboard:scott" }, sec(1));
    await queueCommand(db, { kind: "request", amount: "1000.01", requestedBy: "cli" }, sec(2));
    await queueCommand(db, { kind: "cancel", requestedBy: "cli" }, sec(3));
    await queueCommand(db, { kind: "fund_now", requestedBy: "cli" }, sec(4));
    const results = await processCommands(db, sec(10), CALENDAR);
    expect(results.map((r) => r.outcome)).toEqual([
      { status: "rejected", reason: expect.stringContaining(`"five hundred" isn't a dollar amount`) },
      { status: "rejected", reason: "$1000.01 is more than the account's $1000" },
      { status: "rejected", reason: "there's no open withdrawal to cancel" },
      { status: "rejected", reason: "there's no open withdrawal to fund" },
    ]);
    expect(await kinds()).toEqual(Array(4).fill("capital.command_rejected"));
    expect(await db.select().from(withdrawals)).toHaveLength(0);
    expect((await db.select().from(capitalCommandResults)).map((r) => r.outcome)).toEqual(Array(4).fill("rejected"));
  });

  it("allows one open request at a time", async () => {
    await queueCommand(db, { kind: "request", amount: "100", requestedBy: "cli" }, sec(1));
    await queueCommand(db, { kind: "request", amount: "all", requestedBy: "cli" }, sec(2));
    const results = await processCommands(db, sec(10), CALENDAR);
    expect(results[1]?.outcome).toEqual({ status: "rejected", reason: "a withdrawal is already open ($100, planning); cancel it first" });
  });

  it("cancels the open request, and then allows a new one", async () => {
    await queueCommand(db, { kind: "request", amount: "100", requestedBy: "cli" }, sec(1));
    await queueCommand(db, { kind: "cancel", requestedBy: "cli" }, sec(2));
    await queueCommand(db, { kind: "request", amount: "all", requestedBy: "cli" }, sec(3));
    await processCommands(db, sec(10), CALENDAR);
    const rows = await db.select().from(withdrawals);
    expect(rows.map((r) => [r.amount, r.status])).toEqual([
      ["100", "cancelled"],
      [null, "planning"],
    ]);
    expect(await kinds()).toEqual(["capital.withdrawal_requested", "capital.withdrawal_cancelled", "capital.withdrawal_requested"]);
  });

  it("fund_now closes Claude's window now, and only while planning", async () => {
    await queueCommand(db, { kind: "request", amount: "100", requestedBy: "cli" }, MON_10);
    await queueCommand(db, { kind: "fund_now", requestedBy: "cli" }, at("2026-11-02", "10:05"));
    await processCommands(db, at("2026-11-02", "10:05"), CALENDAR);
    expect((await theWithdrawal()).deadline).toEqual(at("2026-11-02", "10:05"));
    expect(await kinds()).toContain("capital.fund_now");

    await db.update(withdrawals).set({ status: "funding" });
    await queueCommand(db, { kind: "fund_now", requestedBy: "cli" }, at("2026-11-02", "10:10"));
    const [result] = await processCommands(db, at("2026-11-02", "10:10"), CALENDAR);
    expect(result?.outcome).toEqual({ status: "rejected", reason: "the withdrawal is already past planning (funding)" });
  });
});

describe("processWithdrawal", () => {
  async function request(amount: string, now = MON_10) {
    await queueCommand(db, { kind: "request", amount, requestedBy: "cli" }, now);
    await processCommands(db, now, CALENDAR);
  }
  async function sellFill(id: string, qty: string, price: string, when: Date) {
    await db.insert(brokerActivities).values({ id, type: "FILL", at: when, symbol: "VTI", side: "sell", qty, price, raw: {} });
  }
  async function transferOut(id: string, amount: string, when: Date) {
    await db.insert(brokerActivities).values({ id, type: "CSW", at: when, netAmount: amount, raw: { created_at: when.toISOString(), status: "executed" } });
    await recordCapitalFlows(db, when);
  }

  it("does nothing without an open request", async () => {
    expect(await processWithdrawal(db, MON_10, CALENDAR)).toEqual({ status: "none" });
  });

  it("runs the whole lifecycle: plan → sells → settled → withdrawn in Alpaca", async () => {
    await request("500");
    expect(await processWithdrawal(db, at("2026-11-02", "10:15"), CALENDAR)).toMatchObject({ status: "open", state: "planning", steps: [] });

    // Claude's strategy after the request is the funding plan.
    await db.insert(strategies).values({ authoredBy: "claude", summary: "s", document: {}, createdAt: at("2026-11-02", "12:10") });
    expect(await processWithdrawal(db, at("2026-11-02", "12:15"), CALENDAR)).toMatchObject({ state: "funding", steps: ["funding"] });
    expect((await theWithdrawal()).fundedBy).toBe("claude");

    // The sells fill: $510 of cash, all of it unsettled until Tuesday's close.
    await sellFill("s1", "1.7", "300", at("2026-11-02", "13:00"));
    await setAccount({ cash: "510", longMarketValue: "490", syncedAt: at("2026-11-02", "13:15") });
    expect(await processWithdrawal(db, at("2026-11-02", "13:15"), CALENDAR)).toMatchObject({ state: "settling", steps: ["settling"] });

    expect(await processWithdrawal(db, at("2026-11-03", "15:45"), CALENDAR)).toMatchObject({ state: "settling" });
    expect(await processWithdrawal(db, at("2026-11-03", "16:15"), CALENDAR)).toMatchObject({ state: "ready", steps: ["ready"] });

    // Scott withdraws in Alpaca; the ledger stays quiet and the request closes.
    await transferOut("csw", "-500", at("2026-11-04", "09:00"));
    await setAccount({ cash: "10", equity: "500", longMarketValue: "490" });
    expect(await processWithdrawal(db, at("2026-11-04", "09:15"), CALENDAR)).toEqual({ status: "closed", id: (await theWithdrawal()).id, withdrawn: "500" });
    expect(await theWithdrawal()).toMatchObject({ status: "withdrawn", withdrawn: "500", flowIds: ["csw"] });

    expect(await kinds()).toEqual([
      "capital.withdrawal_requested",
      "capital.funding_planned",
      "capital.withdrawal_settling",
      "capital.withdrawal_ready",
      "capital.withdrawal_completed",
    ]);
    const ready = (await events()).find((e) => e.kind === "capital.withdrawal_ready");
    expect(ready?.payload).toMatchObject({ amount: "500", outstanding: "500", reason: "$510.00 of settled cash covers $500.00" });
  });

  it("waits for open orders before treating everything as sold", async () => {
    await request("all");
    await db.insert(orders).values({ clientOrderId: "c1", symbol: "VTI", side: "sell", qty: "1", status: "accepted", createdAt: MON_10 });
    await setAccount({ cash: "1000", longMarketValue: "0" });
    expect(await processWithdrawal(db, at("2026-11-02", "10:15"), CALENDAR)).toMatchObject({ state: "funding", steps: ["funding"] });
  });

  it("keeps the rest open after a smaller transfer", async () => {
    await request("500");
    await db.update(withdrawals).set({ status: "ready" });
    await transferOut("csw1", "-200", at("2026-11-02", "11:00"));
    await setAccount({ cash: "300", equity: "800", longMarketValue: "500" });
    expect(await processWithdrawal(db, at("2026-11-02", "11:15"), CALENDAR)).toMatchObject({ status: "open", state: "ready" });
    expect(await theWithdrawal()).toMatchObject({ withdrawn: "200", flowIds: ["csw1"] });
    expect((await events()).at(-1)).toMatchObject({ kind: "capital.withdrawal_partial", payload: { withdrawn: "200", remaining: "300" } });
  });

  it("reports when Claude's window has closed, for the fallback to fund it", async () => {
    await request("500");
    expect(await processWithdrawal(db, at("2026-11-02", "13:00"), CALENDAR)).toMatchObject({ state: "planning", last: { status: "fallback_due" } });
  });
});

describe("process-capital job", () => {
  it("skips without calling the broker when there's nothing to do", async () => {
    const broker = new FakeBroker();
    const outcome = await runJob(deps(db, "staging", broker), "process-capital", MON_10);
    expect(outcome).toEqual({ status: "skipped", reason: "no commands or open withdrawal" });
    expect(broker.calls.getCalendar).toBeUndefined();
  });

  it("processes a queued command and steps the request", async () => {
    const broker = new FakeBroker();
    broker.calendar = CALENDAR;
    await setAccount({ cash: "600", longMarketValue: "400" });
    await queueCommand(db, { kind: "request", amount: "500", requestedBy: "cli" }, MON_10);
    const result = await processCapital(db, broker, MON_10);
    expect(result).toMatchObject({ status: "processed", commands: [{ kind: "request", outcome: { status: "accepted" } }], withdrawal: { state: "ready" } });
    expect((await db.select().from(withdrawals).where(eq(withdrawals.status, "ready")))).toHaveLength(1);
  });
});
