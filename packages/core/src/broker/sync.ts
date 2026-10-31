import { and, asc, eq, inArray, max } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { AuditKind } from "../audit.js";
import type { Db } from "../db/client.js";
import { brokerAccount, brokerActivities, equitySnapshots, orders, positions } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { compare } from "../money.js";
import { marketDate } from "../time.js";
import { buildLots, openQtyBySymbol } from "./lots.js";
import { isOurClientOrderId } from "./orders.js";
import type { Account, AccountConfig, Activity, BrokerAdapter, BrokerOrder } from "./port.js";

/** Keep syncing this long after the close, so the closing equity snapshot gets written. */
export const AFTER_CLOSE_WINDOW_MS = 30 * 60_000;
/** Re-read this much activity history each sync; late-posting dividends and corrections land here. */
export const ACTIVITY_OVERLAP_MS = 3 * 24 * 60 * 60_000;
/** Orders are day orders, so a week of history covers every order that can still change. */
export const ORDER_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** An intent the broker still doesn't know about after this long never reached it. */
export const UNRESOLVED_ORDER_GRACE_MS = 10 * 60_000;

export type SyncPhase = "open" | "after_close" | "forced";

export type SyncResult =
  | { status: "skipped"; reason: string }
  | {
      status: "synced";
      detail: {
        phase: SyncPhase;
        activitiesAdded: number;
        ordersChanged: number;
        positions: number;
        snapshot: boolean;
        tradingAllowed: boolean;
        blockedReasons: string[];
      };
    };

/**
 * Mirror the Alpaca account into Postgres and decide `tradingAllowed`.
 * Read-only towards the broker: this never places, changes or cancels orders.
 */
export async function syncBroker(
  db: Db,
  broker: BrokerAdapter,
  env: TradingEnv,
  now: Date,
  opts: { ignoreSession?: boolean } = {},
): Promise<SyncResult> {
  // ignoreSession is for operators (scripts/broker-sync.ts), e.g. to confirm a
  // config change on a weekend. A forced sync never writes an equity snapshot.
  const phase = opts.ignoreSession ? "forced" : await sessionPhase(broker, now);
  if (!phase) return { status: "skipped", reason: "market closed" };

  const [account, config] = await Promise.all([broker.getAccount(), broker.getAccountConfig()]);
  const prior = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];

  const ordersChanged = await syncOrders(db, broker, now);

  // A fill can land between reading activities and reading positions, which
  // looks like a mismatch for one sync. Re-read once before calling it real.
  let activitiesAdded = 0;
  let reconcile: Reconciliation = { reasons: [], detail: {} };
  let positionCount = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    activitiesAdded += await syncActivities(db, broker);
    positionCount = await replacePositions(db, broker, now);
    reconcile = await reconcileLots(db);
    if (reconcile.reasons.length === 0) break;
  }

  const snapshot = phase === "after_close" ? await writeSnapshot(db, account, now) : false;

  const accountChanged = prior !== undefined && prior.accountNumber !== account.accountNumber;
  const reasons = [
    ...(accountChanged ? [`account number changed`] : []),
    ...accountReasons(account, config),
    ...reconcile.reasons,
  ];

  await db
    .insert(brokerAccount)
    .values({ id: 1, ...accountRow(account, config, now), tradingAllowed: reasons.length === 0, blockedReasons: reasons })
    .onConflictDoUpdate({
      target: brokerAccount.id,
      // The pinned account number is never overwritten: a different account is
      // a stop condition, not an update.
      set: {
        ...accountRow(account, config, now),
        accountNumber: prior?.accountNumber ?? account.accountNumber,
        tradingAllowed: reasons.length === 0,
        blockedReasons: reasons,
      },
    });

  await auditVerdict(db, prior?.blockedReasons ?? null, reasons, {
    accountNumberSeen: accountChanged ? "changed" : undefined,
    reconcile: reconcile.detail,
    env,
  });

  return {
    status: "synced",
    detail: {
      phase,
      activitiesAdded,
      ordersChanged,
      positions: positionCount,
      snapshot,
      tradingAllowed: reasons.length === 0,
      blockedReasons: reasons,
    },
  };
}

/** "open" during the session, "after_close" for 30 minutes after it, otherwise null. */
async function sessionPhase(broker: BrokerAdapter, now: Date): Promise<SyncPhase | null> {
  const clock = await broker.getClock();
  if (clock.isOpen) return "open";
  const today = marketDate(now);
  const session = (await broker.getCalendar(today, today)).find((d) => d.date === today);
  if (!session) return null;
  const sinceClose = now.getTime() - session.close.getTime();
  return sinceClose >= 0 && sinceClose <= AFTER_CLOSE_WINDOW_MS ? "after_close" : null;
}

function accountReasons(account: Account, config: AccountConfig): string[] {
  const reasons: string[] = [];
  if (account.status !== "ACTIVE") reasons.push(`account status ${account.status}`);
  if (account.tradingBlocked) reasons.push("trading blocked by broker");
  if (account.accountBlocked) reasons.push("account blocked by broker");
  if (account.tradeSuspendedByUser || config.suspendTrade) reasons.push("trading suspended on the account");
  if (config.maxMarginMultiplier !== "1") reasons.push(`margin multiplier ${config.maxMarginMultiplier} (must be 1)`);
  if (!config.noShorting) reasons.push("shorting enabled (must be off)");
  if (!config.fractionalTrading) reasons.push("fractional trading disabled (must be on)");
  return reasons;
}

function accountRow(account: Account, config: AccountConfig, now: Date) {
  return {
    accountNumber: account.accountNumber,
    status: account.status,
    cash: account.cash,
    equity: account.equity,
    lastEquity: account.lastEquity,
    longMarketValue: account.longMarketValue,
    buyingPower: account.buyingPower,
    multiplier: account.multiplier,
    tradingBlocked: account.tradingBlocked,
    accountBlocked: account.accountBlocked,
    config: { ...config },
    syncedAt: now,
  };
}

async function syncActivities(db: Db, broker: BrokerAdapter): Promise<number> {
  const [latest] = await db.select({ at: max(brokerActivities.at) }).from(brokerActivities);
  const after = latest?.at ? new Date(latest.at.getTime() - ACTIVITY_OVERLAP_MS) : undefined;
  const activities = await broker.getActivities(after);
  if (activities.length === 0) return 0;
  const inserted = await db
    .insert(brokerActivities)
    .values(
      activities.map((a) => ({
        id: a.id,
        type: a.type,
        at: a.at,
        symbol: a.symbol,
        side: a.side,
        qty: a.qty,
        price: a.price,
        netAmount: a.netAmount,
        orderId: a.orderId,
        raw: a.raw,
      })),
    )
    .onConflictDoNothing({ target: brokerActivities.id })
    .returning({ id: brokerActivities.id });
  return inserted.length;
}

async function replacePositions(db: Db, broker: BrokerAdapter, now: Date): Promise<number> {
  const current = await broker.getPositions();
  await db.transaction(async (tx) => {
    await tx.delete(positions);
    if (current.length > 0) {
      await tx.insert(positions).values(current.map((p) => ({ ...p, syncedAt: now })));
    }
  });
  return current.length;
}

interface Reconciliation {
  reasons: string[];
  detail: Record<string, unknown>;
}

/**
 * Open FIFO lots must account for exactly the shares Alpaca holds. Reasons
 * are stable strings (symbol, not quantities) so a persisting mismatch is
 * audited once; the quantities go in the event payload.
 */
async function reconcileLots(db: Db): Promise<Reconciliation> {
  const rows = await db.select().from(brokerActivities).orderBy(asc(brokerActivities.at), asc(brokerActivities.id));
  const lots = buildLots(rows.map(toActivity));
  const held = await db.select({ symbol: positions.symbol, qty: positions.qty }).from(positions);

  const lotQty = openQtyBySymbol(lots.open);
  const positionQty = new Map(held.map((p) => [p.symbol, p.qty]));
  const symbols = [...new Set([...lotQty.keys(), ...positionQty.keys()])].sort();

  const reasons: string[] = [];
  const detail: Record<string, unknown> = {};
  for (const symbol of symbols) {
    const fromLots = lotQty.get(symbol) ?? "0";
    const fromBroker = positionQty.get(symbol) ?? "0";
    if (compare(fromLots, fromBroker) !== 0) {
      reasons.push(`lots do not match position: ${symbol}`);
      detail[symbol] = { lots: fromLots, position: fromBroker };
    }
  }
  for (const issue of lots.issues) {
    reasons.push(`lot history unsupported: ${issue.symbol}`);
    detail[issue.symbol] = { ...(detail[issue.symbol] as object), issue: issue.reason };
  }
  return { reasons: [...new Set(reasons)], detail };
}

function toActivity(row: typeof brokerActivities.$inferSelect): Activity {
  return {
    id: row.id,
    type: row.type,
    at: row.at,
    symbol: row.symbol,
    side: row.side === "buy" || row.side === "sell" ? row.side : null,
    qty: row.qty,
    price: row.price,
    netAmount: row.netAmount,
    orderId: row.orderId,
    raw: row.raw,
  };
}

async function writeSnapshot(db: Db, account: Account, now: Date): Promise<boolean> {
  const inserted = await db
    .insert(equitySnapshots)
    .values({
      tradingDate: marketDate(now),
      equity: account.equity,
      cash: account.cash,
      longMarketValue: account.longMarketValue,
    })
    .onConflictDoNothing({ target: equitySnapshots.tradingDate })
    .returning({ tradingDate: equitySnapshots.tradingDate });
  return inserted.length > 0;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const TRANSITION_KIND: Record<string, AuditKind> = {
  partially_filled: "order.partially_filled",
  filled: "order.filled",
  canceled: "order.canceled",
  expired: "order.canceled",
  done_for_day: "order.canceled",
  rejected: "order.rejected",
};

function orderFields(o: BrokerOrder, now: Date) {
  return {
    brokerOrderId: o.id,
    status: o.status,
    filledQty: o.filledQty,
    filledAvgPrice: o.filledAvgPrice,
    submittedAt: o.submittedAt,
    updatedAt: now,
    raw: o.raw,
  };
}

/** Upsert recent broker orders, resolve our ambiguous intents, audit every status change. */
async function syncOrders(db: Db, broker: BrokerAdapter, now: Date): Promise<number> {
  const recent = await broker.getOrders(new Date(now.getTime() - ORDER_LOOKBACK_MS));
  const seen = new Set(recent.map((o) => o.clientOrderId));

  // Our intents the listing didn't include: look each up by its client id.
  const pending = await db.select().from(orders).where(inArray(orders.status, ["intent", "unknown"]));
  for (const row of pending) {
    if (seen.has(row.clientOrderId)) continue;
    const found = await broker.getOrderByClientId(row.clientOrderId);
    if (found) recent.push(found);
    else if (now.getTime() - row.createdAt.getTime() > UNRESOLVED_ORDER_GRACE_MS) {
      // Conditional on the status we read, so a concurrent sync can't audit it twice.
      const claimed = await db
        .update(orders)
        .set({ status: "not_found", rejectReason: "never reached the broker", updatedAt: now })
        .where(and(eq(orders.id, row.id), eq(orders.status, row.status)))
        .returning({ id: orders.id });
      if (claimed.length === 0) continue;
      await recordEvent(db, {
        actor: "system",
        kind: "order.rejected",
        subject: row.symbol,
        payload: { clientOrderId: row.clientOrderId, reason: "never reached the broker" },
      });
    }
  }

  let changed = 0;
  for (const o of recent) {
    const existing = (await db.select().from(orders).where(eq(orders.clientOrderId, o.clientOrderId)))[0];
    if (!existing) {
      const ours = isOurClientOrderId(o.clientOrderId);
      const inserted = await db
        .insert(orders)
        .values({
        clientOrderId: o.clientOrderId,
        symbol: o.symbol,
        side: o.side,
        notional: o.notional,
        qty: o.qty,
        ...orderFields(o, now),
        })
        .onConflictDoNothing({ target: orders.clientOrderId })
        .returning({ id: orders.id });
      if (inserted.length === 0) continue;
      changed++;
      // Ours but unknown to the DB would mean lost state; theirs means a human traded.
      await recordEvent(db, {
        actor: "system",
        kind: ours ? "order.unknown" : "order.external",
        subject: o.symbol,
        payload: { clientOrderId: o.clientOrderId, side: o.side, status: o.status, notional: o.notional, qty: o.qty },
      });
      continue;
    }
    if (existing.status === o.status && existing.filledQty === o.filledQty) continue;
    // Only the sync whose update wins audits the transition (the cron and a
    // manual sync script can overlap).
    const won = await db
      .update(orders)
      .set(orderFields(o, now))
      .where(and(eq(orders.id, existing.id), eq(orders.status, existing.status)))
      .returning({ id: orders.id });
    if (won.length === 0) continue;
    changed++;
    const kind = TRANSITION_KIND[o.status];
    if (kind && existing.status !== o.status) {
      await recordEvent(db, {
        actor: "system",
        kind,
        subject: o.symbol,
        payload: {
          clientOrderId: o.clientOrderId,
          side: o.side,
          filledQty: o.filledQty,
          filledAvgPrice: o.filledAvgPrice,
          from: existing.status,
          to: o.status,
        },
      });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Verdict auditing: on transitions only, so a stuck condition is one event.
// ---------------------------------------------------------------------------

function kindFor(reason: string): AuditKind {
  if (reason === "account number changed") return "broker.account_changed";
  if (reason.startsWith("lots ") || reason.startsWith("lot history")) return "broker.reconcile_mismatch";
  return "broker.config_unsafe";
}

async function auditVerdict(
  db: Db,
  previous: string[] | null,
  current: string[],
  context: Record<string, unknown>,
): Promise<void> {
  const before = new Set(previous ?? []);
  const added = current.filter((r) => !before.has(r));
  const byKind = new Map<AuditKind, string[]>();
  for (const reason of added) byKind.set(kindFor(reason), [...(byKind.get(kindFor(reason)) ?? []), reason]);
  for (const [kind, reasons] of byKind) {
    await recordEvent(db, { actor: "system", kind, payload: { reasons, ...context } });
  }
  if (previous && previous.length > 0 && current.length === 0) {
    await recordEvent(db, { actor: "system", kind: "broker.trading_allowed", payload: { cleared: previous } });
  }
}
