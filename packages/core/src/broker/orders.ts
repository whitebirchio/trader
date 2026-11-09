import { eq } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { Db } from "../db/client.js";
import { orders } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { compare, decimalString, round } from "../money.js";
import { type BrokerAdapter, BrokerHttpError, type BrokerOrder, type OrderSide } from "./port.js";

export type OrderRow = typeof orders.$inferSelect;

/** Order states still in flight (ours and Alpaca's): the rebalance waits for them, and a withdrawal isn't funded until they're done. */
export const OPEN_ORDER_STATES = ["intent", "unknown", "new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding", "held"];

/** Open orders are looked for this far back; anything older is stale data, not in flight. */
export const OPEN_ORDER_LOOKBACK_MS = 2 * 86_400_000;

/**
 * What a caller (eventually `portfolio`, through `risk`) wants traded.
 * `key` identifies the intent, e.g. `<plan-id>:<symbol>:<side>`: the same key
 * always maps to the same client_order_id, so it can never trade twice.
 */
export type OrderIntent = {
  key: string;
  symbol: string;
  side: OrderSide;
  strategyRef?: string;
} & ({ notional: string; qty?: never } | { qty: string; notional?: never });

export type SubmitResult =
  | { status: "submitted"; order: OrderRow }
  | { status: "already_submitted"; order: OrderRow }
  | { status: "rejected"; order: OrderRow; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "unknown"; order: OrderRow };

const PREFIX: Record<TradingEnv, string> = { staging: "stg", production: "prd" };
const OUR_ID = /^(stg|prd)-[0-9a-f]{40}$/;

/** Deterministic, env-prefixed, 44 characters (Alpaca allows 48). */
export async function clientOrderId(env: TradingEnv, key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${PREFIX[env]}-${hex.slice(0, 40)}`;
}

/** True for ids Trader generated; anything else came from outside (e.g. the Alpaca app). */
export function isOurClientOrderId(id: string): boolean {
  return OUR_ID.test(id);
}

function validate(intent: OrderIntent): string | null {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(intent.symbol)) return `invalid symbol ${intent.symbol}`;
  if (intent.notional !== undefined) {
    if (!decimalString.safeParse(intent.notional).success) return "notional is not a decimal";
    if (round(intent.notional, 2, "down") !== intent.notional) return "notional has more than 2 decimal places";
    if (compare(intent.notional, "1") < 0) return "notional is below the $1 minimum";
    return null;
  }
  if (intent.qty === undefined || !decimalString.safeParse(intent.qty).success) return "qty is not a decimal";
  if (round(intent.qty, 9, "down") !== intent.qty) return "qty has more than 9 decimal places";
  if (compare(intent.qty, "0") <= 0) return "qty must be positive";
  return null;
}

// Alpaca's answer when a client_order_id was already used: the order exists.
const DUPLICATE_ID = /client_order_id must be unique/i;

/**
 * Submit a market day order at most once. The intent is recorded (and
 * audited) before Alpaca is called. Every retry reuses the same
 * client_order_id, which Alpaca enforces as unique, so an ambiguous failure
 * can be retried safely and is never re-sent under a new id.
 *
 * Its one caller is the rebalance, after riskGate approves the order (SPEC-portfolio).
 */
export async function submitOrder(
  db: Db,
  broker: BrokerAdapter,
  env: TradingEnv,
  intent: OrderIntent,
  now: Date = new Date(),
): Promise<SubmitResult> {
  const invalid = validate(intent);
  if (invalid) return { status: "invalid", reason: invalid };

  const cid = await clientOrderId(env, intent.key);
  let row = (await db.select().from(orders).where(eq(orders.clientOrderId, cid)))[0];

  if (row && !["intent", "unknown"].includes(row.status)) return { status: "already_submitted", order: row };
  if (row) {
    // A previous attempt was ambiguous: ask the broker before sending again.
    const found = await broker.getOrderByClientId(cid);
    if (found) return { status: "already_submitted", order: await applyBrokerOrder(db, row.id, found, now) };
  } else {
    row = (
      await db
        .insert(orders)
        .values({
          clientOrderId: cid,
          intentKey: intent.key,
          strategyRef: intent.strategyRef ?? null,
          symbol: intent.symbol,
          side: intent.side,
          notional: intent.notional ?? null,
          qty: intent.qty ?? null,
          status: "intent",
          // The caller's clock, not the database's: risk counts today's orders by it.
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0];
    if (!row) throw new Error("orders insert returned no row");
    await recordEvent(db, {
      actor: "system",
      kind: "order.intent",
      subject: intent.symbol,
      payload: { clientOrderId: cid, key: intent.key, side: intent.side, notional: intent.notional, qty: intent.qty },
    });
  }

  try {
    const placed = await broker.submitOrder({
      symbol: intent.symbol,
      side: intent.side,
      clientOrderId: cid,
      ...(intent.notional !== undefined ? { notional: intent.notional } : { qty: intent.qty }),
    });
    const order = await applyBrokerOrder(db, row.id, placed, now);
    await recordEvent(db, {
      actor: "system",
      kind: "order.submitted",
      subject: intent.symbol,
      payload: { clientOrderId: cid, brokerOrderId: placed.id, status: placed.status },
    });
    return { status: "submitted", order };
  } catch (e) {
    if (e instanceof BrokerHttpError && e.status === 422 && DUPLICATE_ID.test(e.message)) {
      const found = await broker.getOrderByClientId(cid);
      if (found) return { status: "already_submitted", order: await applyBrokerOrder(db, row.id, found, now) };
    }
    if (e instanceof BrokerHttpError && e.status >= 400 && e.status < 500) {
      const reason = e.message;
      const [order] = await db
        .update(orders)
        .set({ status: "rejected", rejectReason: reason, updatedAt: now })
        .where(eq(orders.id, row.id))
        .returning();
      await recordEvent(db, {
        actor: "system",
        kind: "order.rejected",
        subject: intent.symbol,
        payload: { clientOrderId: cid, status: e.status, code: e.code, reason },
      });
      return { status: "rejected", order: order ?? row, reason };
    }
    // Timeout, network failure or 5xx: the broker may or may not have the
    // order. Leave it `unknown` for syncBroker to resolve by client id.
    const [order] = await db
      .update(orders)
      .set({ status: "unknown", updatedAt: now })
      .where(eq(orders.id, row.id))
      .returning();
    await recordEvent(db, {
      actor: "system",
      kind: "order.unknown",
      subject: intent.symbol,
      payload: { clientOrderId: cid, error: e instanceof Error ? e.message : String(e) },
    });
    return { status: "unknown", order: order ?? row };
  }
}

async function applyBrokerOrder(db: Db, id: string, o: BrokerOrder, now: Date): Promise<OrderRow> {
  const [row] = await db
    .update(orders)
    .set({
      brokerOrderId: o.id,
      status: o.status,
      filledQty: o.filledQty,
      filledAvgPrice: o.filledAvgPrice,
      submittedAt: o.submittedAt,
      updatedAt: now,
      raw: o.raw,
    })
    .where(eq(orders.id, id))
    .returning();
  if (!row) throw new Error(`order ${id} vanished`);
  return row;
}
