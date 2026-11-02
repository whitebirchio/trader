import { and, asc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { type AuditKind, recordEvent } from "../audit.js";
import { OPEN_ORDER_LOOKBACK_MS, OPEN_ORDER_STATES } from "../broker/orders.js";
import type { BrokerAdapter, CalendarDay } from "../broker/port.js";
import type { Db } from "../db/client.js";
import {
  brokerAccount,
  brokerActivities,
  capitalCommandResults,
  capitalCommands,
  capitalFlows,
  orders,
  strategies,
  withdrawals,
} from "../db/schema.js";
import { compare } from "../money.js";
import { formatMarketTime, marketDate } from "../time.js";
import {
  type AccountView,
  OPEN_STATUSES,
  type Withdrawal,
  type WithdrawalStatus,
  type WithdrawalTransition,
  advance,
  fundingDeadline,
  matchOutflows,
  outstanding,
  parseAmount,
  unsettledProceeds,
} from "./withdrawals.js";

/**
 * Owner commands and the open request, processed by the `process-capital`
 * tick job (SPEC-capital). Commands carry the owner's intent; everything the
 * engine does with them is audited as `system`, except the command events
 * themselves (`owner`, with the command id).
 */

export type Command = typeof capitalCommands.$inferSelect;
export type CommandKind = Command["kind"];

export type CommandOutcome =
  | { status: "accepted"; withdrawalId: string }
  | { status: "rejected"; reason: string };

/** Sale proceeds this recent can still be unsettled (T+1, plus weekends and holidays). */
const SETTLEMENT_LOOKBACK_MS = 10 * 86_400_000;
/** How many transitions one tick may apply: planning → funding → settling → ready, with room. */
const MAX_STEPS = 5;

/** Queue a command, as the dashboard and the capital:* CLI do. The engine processes it on its next tick. */
export async function queueCommand(db: Db, input: { kind: CommandKind; amount?: string | null; requestedBy: string }, now: Date): Promise<Command> {
  const [row] = await db
    .insert(capitalCommands)
    .values({ kind: input.kind, amount: input.amount ?? null, requestedBy: input.requestedBy, at: now })
    .returning();
  if (!row) throw new Error("capital_commands insert returned no row");
  return row;
}

/** The open withdrawal request, if any (at most one). */
export async function openWithdrawal(db: Db): Promise<Withdrawal | null> {
  const [row] = await db.select().from(withdrawals).where(inArray(withdrawals.status, OPEN_STATUSES)).limit(1);
  return row ?? null;
}

/** Process every command not yet processed, oldest first. Each is applied, recorded and audited in one transaction. */
export async function processCommands(db: Db, now: Date, calendar: CalendarDay[]): Promise<{ command: Command; outcome: CommandOutcome }[]> {
  const pending = await db
    .select({ command: capitalCommands })
    .from(capitalCommands)
    .leftJoin(capitalCommandResults, eq(capitalCommandResults.commandId, capitalCommands.id))
    .where(isNull(capitalCommandResults.commandId))
    .orderBy(asc(capitalCommands.at), asc(capitalCommands.id));

  const results: { command: Command; outcome: CommandOutcome }[] = [];
  for (const { command } of pending) {
    const outcome = await db
      .transaction(async (txn) => {
        const tx = txn as unknown as Db;
        const outcome = await applyCommand(tx, command, now, calendar);
        const recorded = await tx
          .insert(capitalCommandResults)
          .values({
            commandId: command.id,
            outcome: outcome.status,
            reason: outcome.status === "rejected" ? outcome.reason : null,
            withdrawalId: outcome.status === "accepted" ? outcome.withdrawalId : null,
            processedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: capitalCommandResults.commandId });
        // Another processor (the CLI and a tick at once) got there first: undo this one.
        if (recorded.length === 0) throw new AlreadyProcessed();
        if (outcome.status === "rejected") {
          // A bad command is never silent: it emails, like an accepted one.
          await recordEvent(tx, {
            actor: "system",
            kind: "capital.command_rejected",
            subject: command.id,
            payload: { commandId: command.id, kind: command.kind, amount: command.amount, requestedBy: command.requestedBy, reason: outcome.reason },
          });
        }
        return outcome;
      })
      .catch((e: unknown) => {
        if (e instanceof AlreadyProcessed) return null;
        throw e;
      });
    if (outcome) results.push({ command, outcome });
  }
  return results;
}

class AlreadyProcessed extends Error {}

async function applyCommand(tx: Db, command: Command, now: Date, calendar: CalendarDay[]): Promise<CommandOutcome> {
  const open = await openWithdrawal(tx);
  const event = (kind: AuditKind, w: Pick<Withdrawal, "id">, payload: Record<string, unknown>) =>
    recordEvent(tx, { actor: "owner", kind, subject: w.id, payload: { commandId: command.id, requestedBy: command.requestedBy, ...payload } });
  const done = (w: Pick<Withdrawal, "id">): CommandOutcome => ({ status: "accepted", withdrawalId: w.id });

  switch (command.kind) {
    case "request": {
      if (open) return { status: "rejected", reason: `a withdrawal is already open (${describeAmount(open.amount)}, ${open.status}); cancel it first` };
      const parsed = parseAmount(command.amount);
      if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
      const account = (await tx.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
      if (!account) return { status: "rejected", reason: "the broker has never been synced" };
      if (parsed.amount !== null && compare(parsed.amount, account.equity) > 0) {
        return { status: "rejected", reason: `$${parsed.amount} is more than the account's $${account.equity}` };
      }
      const deadline = fundingDeadline(now, calendar);
      const [w] = await tx
        .insert(withdrawals)
        .values({ status: "planning", amount: parsed.amount, commandId: command.id, requestedAt: command.at, deadline, updatedAt: now })
        .returning();
      if (!w) throw new Error("withdrawals insert returned no row");
      await event("capital.withdrawal_requested", w, { amount: parsed.amount ?? "all", equity: account.equity, deadline: deadline.toISOString() });
      return done(w);
    }
    case "cancel": {
      if (!open) return { status: "rejected", reason: "there's no open withdrawal to cancel" };
      await tx.update(withdrawals).set({ status: "cancelled", closedAt: now, updatedAt: now }).where(eq(withdrawals.id, open.id));
      await event("capital.withdrawal_cancelled", open, { amount: open.amount ?? "all", withdrawn: open.withdrawn, was: open.status });
      return done(open);
    }
    case "fund_now": {
      if (!open) return { status: "rejected", reason: "there's no open withdrawal to fund" };
      if (open.status !== "planning") return { status: "rejected", reason: `the withdrawal is already past planning (${open.status})` };
      await tx.update(withdrawals).set({ deadline: now, updatedAt: now }).where(eq(withdrawals.id, open.id));
      await event("capital.fund_now", open, { amount: open.amount ?? "all", deadline: open.deadline.toISOString() });
      return done(open);
    }
  }
}

const describeAmount = (amount: string | null) => (amount === null ? "everything" : `$${amount}`);

/** What `advance` sees: the synced account, open orders, unsettled sale proceeds, and any strategy since the request. */
export async function accountView(db: Db, w: Pick<Withdrawal, "requestedAt">, now: Date, calendar: CalendarDay[]): Promise<AccountView | null> {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  if (!account) return null;
  const open = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.status, OPEN_ORDER_STATES), gte(orders.createdAt, new Date(now.getTime() - OPEN_ORDER_LOOKBACK_MS))));
  const sells = await db
    .select({ at: brokerActivities.at, qty: brokerActivities.qty, price: brokerActivities.price })
    .from(brokerActivities)
    .where(and(eq(brokerActivities.type, "FILL"), eq(brokerActivities.side, "sell"), gte(brokerActivities.at, new Date(now.getTime() - SETTLEMENT_LOOKBACK_MS))));
  const [plan] = await db
    .select({ version: strategies.version, authoredBy: strategies.authoredBy })
    .from(strategies)
    .where(gte(strategies.createdAt, w.requestedAt))
    .orderBy(asc(strategies.version))
    .limit(1);
  return {
    equity: account.equity,
    cash: account.cash,
    longMarketValue: account.longMarketValue,
    openOrders: open.length,
    unsettled: unsettledProceeds(
      sells.flatMap((s) => (s.qty && s.price ? [{ at: s.at, qty: s.qty, price: s.price }] : [])),
      calendar,
      now,
    ),
    plan: plan ?? null,
  };
}

const TRANSITION_EVENTS: Partial<Record<WithdrawalStatus, AuditKind>> = {
  funding: "capital.funding_planned",
  settling: "capital.withdrawal_settling",
  ready: "capital.withdrawal_ready",
};

export type ProcessWithdrawalResult =
  | { status: "none" }
  | { status: "closed"; id: string; withdrawn: string }
  | { status: "open"; id: string; state: WithdrawalStatus; last: WithdrawalTransition; steps: WithdrawalStatus[] };

/**
 * Move the open request along: match outgoing transfers first (they can close
 * it in any state), then advance until nothing changes. `fallback_due` is
 * returned for the caller to fund (C7).
 */
export async function processWithdrawal(db: Db, now: Date, calendar: CalendarDay[]): Promise<ProcessWithdrawalResult> {
  let w = await openWithdrawal(db);
  if (!w) return { status: "none" };

  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  const outflows = await db
    .select({ activityId: capitalFlows.activityId, at: capitalFlows.at, amount: capitalFlows.amount })
    .from(capitalFlows)
    .where(
      and(
        lt(capitalFlows.amount, "0"),
        gte(capitalFlows.at, w.requestedAt),
        or(isNull(capitalFlows.status), ne(capitalFlows.status, "canceled")),
      ),
    )
    .orderBy(asc(capitalFlows.at));
  const match = matchOutflows(w, outflows, account?.equity ?? "0");
  if (match.status !== "none") {
    const closing = match.status === "complete";
    const updated = await db.transaction(async (txn) => {
      const tx = txn as unknown as Db;
      const [row] = await tx
        .update(withdrawals)
        .set({ withdrawn: match.withdrawn, flowIds: match.flowIds, updatedAt: now, ...(closing ? { status: "withdrawn" as const, closedAt: now } : {}) })
        .where(and(eq(withdrawals.id, w!.id), eq(withdrawals.status, w!.status)))
        .returning();
      if (!row) return null;
      await recordEvent(tx, {
        actor: "system",
        kind: closing ? "capital.withdrawal_completed" : "capital.withdrawal_partial",
        subject: row.id,
        payload: {
          amount: row.amount ?? "all",
          withdrawn: row.withdrawn,
          remaining: closing ? "0" : outstanding(row, account?.equity ?? "0"),
          transfers: match.matched.map((f) => ({ activityId: f.activityId, amount: f.amount, at: f.at.toISOString() })),
        },
      });
      return row;
    });
    if (!updated) return { status: "open", id: w.id, state: w.status, last: { status: "unchanged", reason: "changed by another run" }, steps: [] };
    if (closing) return { status: "closed", id: updated.id, withdrawn: updated.withdrawn };
    w = updated;
  }

  const steps: WithdrawalStatus[] = [];
  let last: WithdrawalTransition = { status: "unchanged", reason: "" };
  for (let i = 0; i < MAX_STEPS; i++) {
    const view = await accountView(db, w, now, calendar);
    if (!view) return { status: "open", id: w.id, state: w.status, last: { status: "unchanged", reason: "the broker has never been synced" }, steps };
    last = advance(w, view, now);
    if (last.status !== "advanced") break;
    const t = last;
    const next = await db.transaction(async (txn) => {
      const tx = txn as unknown as Db;
      const [row] = await tx
        .update(withdrawals)
        .set({ status: t.to, updatedAt: now, ...(t.fundingVersion !== undefined ? { fundingVersion: t.fundingVersion } : {}), ...(t.fundedBy ? { fundedBy: t.fundedBy } : {}) })
        .where(and(eq(withdrawals.id, w!.id), eq(withdrawals.status, w!.status)))
        .returning();
      if (!row) return null;
      const kind = TRANSITION_EVENTS[t.to];
      if (kind) {
        await recordEvent(tx, {
          actor: "system",
          kind,
          subject: row.id,
          payload: {
            amount: row.amount ?? "all",
            outstanding: outstanding(row, view.equity),
            cash: view.cash,
            from: w!.status,
            reason: t.reason,
            ...(t.fundingVersion !== undefined ? { version: t.fundingVersion } : {}),
            ...(t.fundedBy ? { fundedBy: t.fundedBy } : {}),
            ...(t.to === "settling" && view.unsettled.settledBy ? { settledBy: view.unsettled.settledBy.toISOString() } : {}),
          },
        });
      }
      return row;
    });
    if (!next) break;
    steps.push(next.status);
    w = next;
  }
  return { status: "open", id: w.id, state: w.status, last, steps };
}

/** Human summary of the open request for status output. */
export function describeWithdrawal(w: Withdrawal, equity: string): string {
  const what = w.amount === null ? "everything" : `$${outstanding(w, equity)} of $${w.amount}`;
  return `${what}, ${w.status}${w.status === "planning" ? ` (Claude's window closes ${formatMarketTime(w.deadline)})` : ""}`;
}

export type ProcessCapitalResult =
  | { status: "idle" }
  | { status: "processed"; commands: { id: string; kind: CommandKind; outcome: CommandOutcome }[]; withdrawal: ProcessWithdrawalResult };

/**
 * The `process-capital` tick job's work: commands first, then the open
 * request. Runs after sync-broker, so it sees this tick's fills and
 * transfers. Doesn't call the broker when there's nothing to do.
 */
export async function processCapital(db: Db, broker: Pick<BrokerAdapter, "getCalendar">, now: Date): Promise<ProcessCapitalResult> {
  const [pending] = await db
    .select({ id: capitalCommands.id })
    .from(capitalCommands)
    .leftJoin(capitalCommandResults, eq(capitalCommandResults.commandId, capitalCommands.id))
    .where(isNull(capitalCommandResults.commandId))
    .limit(1);
  if (!pending && !(await openWithdrawal(db))) return { status: "idle" };

  const calendar = await broker.getCalendar(marketDate(new Date(now.getTime() - SETTLEMENT_LOOKBACK_MS)), marketDate(new Date(now.getTime() + 21 * 86_400_000)));
  const commands = await processCommands(db, now, calendar);
  const withdrawal = await processWithdrawal(db, now, calendar);
  return { status: "processed", commands: commands.map((c) => ({ id: c.command.id, kind: c.command.kind, outcome: c.outcome })), withdrawal };
}
