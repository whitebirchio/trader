import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clientOrderId } from "../../src/broker/orders.js";
import { syncBroker } from "../../src/broker/sync.js";
import type { Db } from "../../src/db/client.js";
import {
  auditEvents,
  brokerAccount,
  brokerActivities,
  equitySnapshots,
  orders,
  positions,
} from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";
import { FakeBroker } from "./fake-broker.js";

let db: Db;
let broker: FakeBroker;
const OPEN = new Date("2026-11-02T15:00:00Z"); // Monday 10:00 EST
const AFTER_CLOSE = new Date("2026-11-02T21:15:00Z"); // 16:15 EST

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
});

const sync = (now = OPEN) => syncBroker(db, broker, "staging", now);
const events = async (kind?: string) =>
  (await db.select().from(auditEvents)).filter((e) => !kind || e.kind === kind);

function holdVti(qty = "0.016339869", price = "306.01") {
  broker.fill("order-1", "VTI", "buy", qty, price, new Date("2026-11-02T14:35:01Z"));
  broker.positions = [
    { symbol: "VTI", qty, avgEntryPrice: price, marketValue: "5.01", costBasis: "5", currentPrice: "306.6" },
  ];
}

describe("session gate", () => {
  it("skips outside the session and its after-close window", async () => {
    broker.clock.isOpen = false;
    expect(await sync(new Date("2026-11-02T13:00:00Z"))).toEqual({ status: "skipped", reason: "market closed" });
    expect(await sync(new Date("2026-11-02T21:45:00Z"))).toEqual({ status: "skipped", reason: "market closed" });
    expect(broker.calls.getAccount).toBeUndefined();
  });

  it("skips non-trading days", async () => {
    broker.clock.isOpen = false;
    expect((await sync(new Date("2026-11-01T17:00:00Z"))).status).toBe("skipped"); // Sunday
  });

  it("syncs during the session and for 30 minutes after the close", async () => {
    expect((await sync(OPEN)).status).toBe("synced");
    broker.clock.isOpen = false;
    const after = await sync(AFTER_CLOSE);
    expect(after).toMatchObject({ status: "synced", detail: { phase: "after_close" } });
  });
});

describe("mirroring", () => {
  it("records the account, activities and positions and allows trading when all is well", async () => {
    holdVti();
    const result = await sync();
    expect(result).toMatchObject({
      status: "synced",
      detail: { phase: "open", activitiesAdded: 1, positions: 1, tradingAllowed: true, blockedReasons: [] },
    });
    const [account] = await db.select().from(brokerAccount);
    expect(account).toMatchObject({ accountNumber: "PA0000TEST", cash: "1000", tradingAllowed: true });
    expect((await db.select().from(positions))[0]).toMatchObject({ symbol: "VTI", qty: "0.016339869" });
    expect(await events()).toEqual([]);
  });

  it("inserts each activity once across overlapping sync windows", async () => {
    holdVti();
    await sync();
    broker.activities.push({
      id: "div-1",
      type: "DIV",
      at: new Date("2026-11-02T14:50:00Z"),
      symbol: "VTI",
      side: null,
      qty: null,
      price: "0.9",
      netAmount: "0.01",
      orderId: null,
      raw: {},
    });
    const second = await sync();
    expect(second).toMatchObject({ detail: { activitiesAdded: 1 } });
    expect(await db.select().from(brokerActivities)).toHaveLength(2);
  });

  it("replaces positions rather than accumulating them", async () => {
    holdVti();
    await sync();
    broker.fill("order-2", "VTI", "sell", "0.016339869", "307", new Date("2026-11-02T15:30:00Z"));
    broker.positions = [];
    await sync();
    expect(await db.select().from(positions)).toEqual([]);
  });

  it("writes one equity snapshot per trading day, after the close only", async () => {
    await sync(OPEN);
    expect(await db.select().from(equitySnapshots)).toEqual([]);
    broker.clock.isOpen = false;
    await sync(AFTER_CLOSE);
    await sync(new Date(AFTER_CLOSE.getTime() + 15 * 60_000));
    expect(await db.select().from(equitySnapshots)).toEqual([
      expect.objectContaining({ tradingDate: "2026-11-02", equity: "1000", cash: "1000" }),
    ]);
  });
});

describe("tradingAllowed", () => {
  it("blocks on unsafe configuration, audits once, and audits the recovery", async () => {
    broker.config.maxMarginMultiplier = "4";
    broker.config.noShorting = false;
    const first = await sync();
    expect(first).toMatchObject({
      detail: {
        tradingAllowed: false,
        blockedReasons: ["margin multiplier 4 (must be 1)", "shorting enabled (must be off)"],
      },
    });
    await sync();
    expect(await events("broker.config_unsafe")).toHaveLength(1);

    broker.config.maxMarginMultiplier = "1";
    broker.config.noShorting = true;
    expect(await sync()).toMatchObject({ detail: { tradingAllowed: true } });
    const [restored] = await events("broker.trading_allowed");
    expect(restored?.payload).toEqual({
      cleared: ["margin multiplier 4 (must be 1)", "shorting enabled (must be off)"],
    });
  });

  it("blocks when the broker blocks the account", async () => {
    broker.account.tradingBlocked = true;
    broker.account.status = "ACCOUNT_CLOSED";
    const result = await sync();
    expect(result).toMatchObject({
      detail: { tradingAllowed: false, blockedReasons: ["account status ACCOUNT_CLOSED", "trading blocked by broker"] },
    });
  });

  it("pins the first account number and blocks if a different account appears", async () => {
    await sync();
    broker.account.accountNumber = "PA9999OTHER";
    const result = await sync();
    expect(result).toMatchObject({ detail: { tradingAllowed: false, blockedReasons: ["account number changed"] } });
    expect((await db.select().from(brokerAccount))[0]?.accountNumber).toBe("PA0000TEST");
    expect(await events("broker.account_changed")).toHaveLength(1);
  });

  it("blocks when lots and positions disagree, after re-reading once", async () => {
    holdVti("0.5", "300");
    broker.positions = [{ ...broker.positions[0]!, qty: "0.6" }];
    const result = await sync();
    expect(result).toMatchObject({
      detail: { tradingAllowed: false, blockedReasons: ["lots do not match position: VTI"] },
    });
    expect(broker.calls.getPositions).toBe(2);
    const [event] = await events("broker.reconcile_mismatch");
    expect(event?.payload).toMatchObject({ reconcile: { VTI: { lots: "0.5", position: "0.6" } } });
  });

  it("recovers from a mismatch that was only a fill landing mid-sync", async () => {
    // First read sees the position but not yet the fill; the re-read sees both.
    broker.positions = [
      { symbol: "VTI", qty: "1", avgEntryPrice: "300", marketValue: "300", costBasis: "300", currentPrice: "300" },
    ];
    const original = broker.getActivities.bind(broker);
    let reads = 0;
    broker.getActivities = async (after) => {
      if (++reads === 2) broker.fill("order-9", "VTI", "buy", "1", "300", new Date("2026-11-02T14:59:00Z"));
      return original(after);
    };
    expect(await sync()).toMatchObject({ detail: { tradingAllowed: true } });
    expect(await events("broker.reconcile_mismatch")).toEqual([]);
  });

  it("blocks a symbol whose history includes a corporate action it can't model", async () => {
    holdVti("1", "300");
    broker.activities.push({
      id: "ssp-1",
      type: "SSP",
      at: new Date("2026-11-02T14:40:00Z"),
      symbol: "VTI",
      side: null,
      qty: "1",
      price: null,
      netAmount: null,
      orderId: null,
      raw: {},
    });
    expect(await sync()).toMatchObject({
      detail: { tradingAllowed: false, blockedReasons: ["lot history unsupported: VTI"] },
    });
  });
});

describe("orders", () => {
  it("records orders placed outside Trader and flags them", async () => {
    broker.orders.push({
      id: "order-ext",
      clientOrderId: "app-placed-123",
      symbol: "AAPL",
      side: "buy",
      notional: null,
      qty: "1",
      filledQty: "1",
      filledAvgPrice: "230",
      status: "filled",
      createdAt: new Date("2026-11-02T14:40:00Z"),
      updatedAt: new Date("2026-11-02T14:40:00Z"),
      submittedAt: new Date("2026-11-02T14:40:00Z"),
      raw: {},
    });
    await sync();
    const [row] = await db.select().from(orders);
    expect(row).toMatchObject({ clientOrderId: "app-placed-123", intentKey: null, status: "filled" });
    expect(await events("order.external")).toHaveLength(1);
  });

  it("audits each status transition once", async () => {
    const cid = await clientOrderId("staging", "plan-1:VTI:buy");
    await db.insert(orders).values({ clientOrderId: cid, intentKey: "plan-1:VTI:buy", symbol: "VTI", side: "buy", notional: "5", status: "accepted" });
    const order = {
      id: "order-1",
      clientOrderId: cid,
      symbol: "VTI",
      side: "buy" as const,
      notional: "5",
      qty: null,
      filledQty: "0.016339869",
      filledAvgPrice: "306.01",
      status: "filled",
      createdAt: new Date("2026-11-02T14:35:00Z"),
      updatedAt: new Date("2026-11-02T14:35:01Z"),
      submittedAt: new Date("2026-11-02T14:35:00Z"),
      raw: {},
    };
    broker.orders.push(order);
    holdVti();
    await sync();
    await sync();
    const filled = await events("order.filled");
    expect(filled).toHaveLength(1);
    expect(filled[0]?.payload).toMatchObject({ from: "accepted", to: "filled", filledQty: "0.016339869" });
  });

  it("resolves an ambiguous intent by client id", async () => {
    const cid = await clientOrderId("staging", "plan-1:VTI:buy");
    await db.insert(orders).values({ clientOrderId: cid, intentKey: "plan-1:VTI:buy", symbol: "VTI", side: "buy", notional: "5", status: "unknown", createdAt: new Date("2026-11-01T14:35:00Z") });
    // Older than the 7-day listing window, so only the by-client-id lookup can find it.
    broker.orders.push({
      id: "order-1",
      clientOrderId: cid,
      symbol: "VTI",
      side: "buy",
      notional: "5",
      qty: null,
      filledQty: "0",
      filledAvgPrice: null,
      status: "accepted",
      createdAt: new Date("2026-10-20T14:35:00Z"),
      updatedAt: new Date("2026-10-20T14:35:00Z"),
      submittedAt: new Date("2026-10-20T14:35:00Z"),
      raw: {},
    });
    await sync();
    expect((await db.select().from(orders).where(eq(orders.clientOrderId, cid)))[0]).toMatchObject({
      status: "accepted",
      brokerOrderId: "order-1",
    });
    expect(broker.calls.getOrderByClientId).toBe(1);
  });

  it("marks an intent the broker never received as not_found after the grace period", async () => {
    const cid = await clientOrderId("staging", "plan-2:VTI:buy");
    await db.insert(orders).values({ clientOrderId: cid, intentKey: "plan-2:VTI:buy", symbol: "VTI", side: "buy", notional: "5", status: "unknown", createdAt: new Date(OPEN.getTime() - 5 * 60_000) });
    await sync();
    expect((await db.select().from(orders))[0]?.status).toBe("unknown"); // still within grace
    await sync(new Date(OPEN.getTime() + 10 * 60_000));
    expect((await db.select().from(orders))[0]).toMatchObject({ status: "not_found", rejectReason: "never reached the broker" });
    expect(await events("order.rejected")).toHaveLength(1);
  });
});

describe("concurrent syncs", () => {
  it("audit an order transition once even when two syncs overlap", async () => {
    const cid = await clientOrderId("staging", "plan-1:VTI:buy");
    await db.insert(orders).values({ clientOrderId: cid, intentKey: "plan-1:VTI:buy", symbol: "VTI", side: "buy", notional: "5", status: "accepted" });
    broker.orders.push({
      id: "order-1",
      clientOrderId: cid,
      symbol: "VTI",
      side: "buy",
      notional: "5",
      qty: null,
      filledQty: "0.016339869",
      filledAvgPrice: "306.01",
      status: "filled",
      createdAt: new Date("2026-11-02T14:35:00Z"),
      updatedAt: new Date("2026-11-02T14:35:01Z"),
      submittedAt: new Date("2026-11-02T14:35:00Z"),
      raw: {},
    });
    holdVti();
    await Promise.all([sync(), sync()]);
    expect(await events("order.filled")).toHaveLength(1);
  });
});

describe("forced sync", () => {
  it("runs outside the session for operators but never writes a snapshot", async () => {
    broker.clock.isOpen = false;
    const result = await syncBroker(db, broker, "staging", new Date("2026-11-01T17:00:00Z"), { ignoreSession: true });
    expect(result).toMatchObject({ status: "synced", detail: { phase: "forced", snapshot: false } });
    expect(await db.select().from(equitySnapshots)).toEqual([]);
  });
});
