/**
 * End-to-end check against the PAPER account (SPEC-broker SC-3): submit a $5
 * VTI buy through submitOrder, sync until it fills, then check the lot, the
 * position, the audit trail and idempotency.
 *
 *   npm run broker:smoke -w @trader/core -- --env paper
 *
 * Refuses anything but paper, and refuses while the market is closed. Writes
 * to the paper rehearsal's local database (ADR-018), never to Neon.
 */
import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { buildLots, openQtyBySymbol } from "../src/broker/lots.js";
import { submitOrder } from "../src/broker/orders.js";
import { syncBroker } from "../src/broker/sync.js";
import { auditEvents, brokerAccount, brokerActivities, orders, positions } from "../src/db/schema.js";
import { compare } from "../src/money.js";
import { marketDate } from "../src/time.js";
import { withOps } from "./ops.js";

const { values } = parseArgs({ options: { env: { type: "string" } } });
if (values.env !== "paper") throw new Error("broker:smoke only runs with --env paper");

await withOps(values.env, async ({ db, broker }) => {
  if (!(await broker.getClock()).isOpen) throw new Error("market is closed; run during the regular session");
  const fail = (msg: string): never => {
    throw new Error(`✗ ${msg}`);
  };

  const key = `smoke:${marketDate(new Date())}:VTI:buy`;
  const intent = { key, symbol: "VTI", side: "buy" as const, notional: "5", strategyRef: "broker-smoke" };

  const first = await submitOrder(db, broker, "staging", intent);
  console.log(`submit → ${first.status}`);
  if (first.status === "invalid" || first.status === "rejected") fail(`submission ${first.status}: ${first.reason}`);
  if (first.status === "already_submitted") console.log("  (today's smoke order already exists; verifying it)");
  const cid = "order" in first ? first.order.clientOrderId : fail("no order row");

  let status = "";
  for (let i = 0; i < 12 && status !== "filled"; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    await syncBroker(db, broker, "staging", new Date());
    status = (await db.select().from(orders).where(eq(orders.clientOrderId, cid)))[0]?.status ?? "";
    console.log(`sync ${i + 1} → order ${status}`);
  }
  if (status !== "filled") fail(`order not filled within 2 minutes (status ${status})`);

  const acts = await db.select().from(brokerActivities).where(eq(brokerActivities.symbol, "VTI"));
  const lots = buildLots(
    acts.map((a) => ({ ...a, side: a.side as "buy" | "sell" | null })),
  );
  const lotQty = openQtyBySymbol(lots.open).get("VTI") ?? "0";
  const position = (await db.select().from(positions).where(eq(positions.symbol, "VTI")))[0];
  if (!position || compare(position.qty, lotQty) !== 0) fail(`lots ${lotQty} ≠ position ${position?.qty}`);
  console.log(`✓ open lots ${lotQty} VTI = Alpaca position`);

  const account = (await db.select().from(brokerAccount))[0];
  if (!account?.tradingAllowed) fail(`tradingAllowed is false: ${JSON.stringify(account?.blockedReasons)}`);
  console.log("✓ tradingAllowed");

  const trail = await db
    .select({ kind: auditEvents.kind })
    .from(auditEvents)
    .where(and(inArray(auditEvents.kind, ["order.intent", "order.submitted", "order.filled"]), eq(auditEvents.subject, "VTI")));
  const kinds = new Set(trail.map((t) => t.kind));
  for (const k of ["order.intent", "order.submitted", "order.filled"]) if (!kinds.has(k)) fail(`missing audit event ${k}`);
  console.log("✓ audit trail: order.intent → order.submitted → order.filled");

  const again = await submitOrder(db, broker, "staging", intent);
  if (again.status !== "already_submitted") fail(`re-submit returned ${again.status}`);
  console.log("✓ re-submitting the same intent → already_submitted (no second order)");
});
