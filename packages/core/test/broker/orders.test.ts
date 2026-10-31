import { beforeEach, describe, expect, it } from "vitest";
import { clientOrderId, isOurClientOrderId, submitOrder } from "../../src/broker/orders.js";
import type { OrderIntent } from "../../src/broker/orders.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, orders } from "../../src/db/schema.js";
import { createTestDb } from "../helpers.js";
import { FakeBroker } from "./fake-broker.js";

let db: Db;
let broker: FakeBroker;
const intent: OrderIntent = { key: "plan-1:VTI:buy", symbol: "VTI", side: "buy", notional: "5" };

beforeEach(async () => {
  ({ db } = await createTestDb());
  broker = new FakeBroker();
});

const submit = (i: OrderIntent = intent) => submitOrder(db, broker, "staging", i, broker.now);
const kinds = async () => (await db.select().from(auditEvents)).map((e) => e.kind);

describe("clientOrderId", () => {
  it("is deterministic, env-prefixed and within Alpaca's 48 characters", async () => {
    const a = await clientOrderId("staging", "plan-1:VTI:buy");
    expect(a).toBe(await clientOrderId("staging", "plan-1:VTI:buy"));
    expect(a).toMatch(/^stg-[0-9a-f]{40}$/);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(await clientOrderId("production", "plan-1:VTI:buy")).toMatch(/^prd-/);
    expect(await clientOrderId("staging", "plan-1:VTI:sell")).not.toBe(a);
  });

  it("tells our ids from ones placed elsewhere", async () => {
    expect(isOurClientOrderId(await clientOrderId("production", "x"))).toBe(true);
    expect(isOurClientOrderId("app-placed-123")).toBe(false);
  });
});

describe("submitOrder", () => {
  it("records the intent before calling the broker, then the submission", async () => {
    const order = broker.submitOrder.bind(broker);
    let intentRowsAtCall = -1;
    broker.submitOrder = async (req) => {
      intentRowsAtCall = (await db.select().from(orders)).filter((o) => o.status === "intent").length;
      return order(req);
    };
    const result = await submit();
    expect(intentRowsAtCall).toBe(1);
    expect(result).toMatchObject({ status: "submitted", order: { status: "accepted", brokerOrderId: "order-1", notional: "5" } });
    expect(await kinds()).toEqual(["order.intent", "order.submitted"]);
  });

  it("never sends the same intent twice", async () => {
    await submit();
    const again = await submit();
    expect(again.status).toBe("already_submitted");
    expect(broker.calls.submitOrder).toBe(1);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("records a broker rejection", async () => {
    broker.nextSubmit = { kind: "reject", status: 403, message: "insufficient buying power" };
    const result = await submit();
    expect(result).toMatchObject({ status: "rejected", order: { status: "rejected" } });
    expect(result.status === "rejected" && result.reason).toContain("insufficient buying power");
    expect(await kinds()).toEqual(["order.intent", "order.rejected"]);
  });

  it("leaves a timed-out submission unknown, then finds it instead of re-sending", async () => {
    broker.nextSubmit = { kind: "accept_then_timeout" };
    expect((await submit()).status).toBe("unknown");
    broker.nextSubmit = { kind: "accept" };
    const retry = await submit();
    expect(retry).toMatchObject({ status: "already_submitted", order: { brokerOrderId: "order-1" } });
    expect(broker.calls.submitOrder).toBe(1);
    expect(broker.orders).toHaveLength(1);
  });

  it("re-sends a timed-out submission the broker never received, under the same id", async () => {
    broker.nextSubmit = { kind: "timeout" };
    const first = await submit();
    expect(first.status).toBe("unknown");
    broker.nextSubmit = { kind: "accept" };
    const retry = await submit();
    expect(retry.status).toBe("submitted");
    expect(broker.orders[0]?.clientOrderId).toBe(first.status === "unknown" ? first.order.clientOrderId : "");
  });

  it("treats Alpaca's duplicate-id error as already submitted", async () => {
    // The broker has the order but our row was lost mid-flight (status still intent).
    const cid = await clientOrderId("staging", intent.key);
    await db.insert(orders).values({ clientOrderId: cid, intentKey: intent.key, symbol: "VTI", side: "buy", notional: "5", status: "intent" });
    const original = broker.getOrderByClientId.bind(broker);
    let lookups = 0;
    broker.getOrderByClientId = async (id) => (++lookups === 1 ? null : original(id)); // first lookup races
    broker.orders.push({
      id: "order-7",
      clientOrderId: cid,
      symbol: "VTI",
      side: "buy",
      notional: "5",
      qty: null,
      filledQty: "0",
      filledAvgPrice: null,
      status: "accepted",
      createdAt: broker.now,
      updatedAt: broker.now,
      submittedAt: broker.now,
      raw: {},
    });
    expect(await submit()).toMatchObject({ status: "already_submitted", order: { brokerOrderId: "order-7" } });
  });

  it.each([
    [{ notional: "0.5" }, "notional is below the $1 minimum"],
    [{ notional: "5.001" }, "notional has more than 2 decimal places"],
    [{ notional: "abc" }, "notional is not a decimal"],
    [{ qty: "0" }, "qty must be positive"],
    [{ qty: "0.0000000001" }, "qty has more than 9 decimal places"],
  ])("refuses invalid sizing %o without touching the broker", async (sizing, reason) => {
    const result = await submit({ key: "k", symbol: "VTI", side: "buy", ...sizing } as OrderIntent);
    expect(result).toEqual({ status: "invalid", reason });
    expect(broker.calls.submitOrder).toBeUndefined();
    expect(await db.select().from(orders)).toEqual([]);
  });

  it("refuses a malformed symbol", async () => {
    expect(await submit({ ...intent, symbol: "vti; drop" })).toMatchObject({ status: "invalid" });
  });
});
