import type { Db } from "./db/client.js";
import { auditEvents } from "./db/schema.js";

/**
 * Every kind of state-changing action the system records (ADR-008). Later
 * modules add to this list (`strategy.activated`, …), and each new kind must
 * also be routed in notifications/routing.ts (a test enforces it).
 */
export const AUDIT_KINDS = [
  "job.failed",
  // Orders (SPEC-broker). `order.external` = an order placed outside Trader, e.g. in the Alpaca app.
  "order.intent",
  "order.submitted",
  "order.unknown",
  "order.partially_filled",
  "order.filled",
  "order.canceled",
  "order.rejected",
  "order.external",
  // Broker safety verdict transitions (tradingAllowed).
  "broker.account_changed",
  "broker.config_unsafe",
  "broker.reconcile_mismatch",
  "broker.trading_allowed",
  // Guardrails (SPEC-risk).
  "risk.order_clipped",
  "risk.order_rejected",
  "risk.buys_paused",
  "risk.buys_resumed",
  "risk.halted",
  "risk.kill_switch_on",
  "risk.resumed",
  // Strategy and theses (SPEC-portfolio).
  "strategy.activated",
  "strategy.rejected",
  "thesis.stopped_out",
  "thesis.took_profit",
  "watchlist.updated",
  "lessons.recorded",
  // SEC filings on held and watched names (#105).
  "filing.sell_signal",
  "filings.noticed",
  "thesis.stale",
  "thesis.review_overdue",
  "rebalance.planned",
  "rebalance.buys_funded",
  // Money in and out (SPEC-capital).
  "capital.deposit_received",
  "capital.transfer_reversed",
  "capital.transfer_canceled",
  "capital.unplanned_outflow",
  // Withdrawal requests: the owner's commands, then the engine's transitions.
  "capital.withdrawal_requested",
  "capital.fund_now",
  "capital.withdrawal_cancelled",
  "capital.command_rejected",
  "capital.funding_planned",
  "capital.withdrawal_settling",
  "capital.withdrawal_ready",
  "capital.withdrawal_partial",
  "capital.withdrawal_completed",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditActor = (typeof auditEvents.actor.enumValues)[number];
export type AuditEvent = typeof auditEvents.$inferSelect;

export interface RecordEventInput {
  actor: AuditActor;
  kind: AuditKind;
  /** What the event is about: a job name, ticker, order id, strategy version. */
  subject?: string;
  payload?: Record<string, unknown>;
  jobRunId?: string;
}

/** Append an audit event. There is no update or delete counterpart, by design. */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<AuditEvent> {
  const rows = await db
    .insert(auditEvents)
    .values({
      actor: input.actor,
      kind: input.kind,
      subject: input.subject ?? null,
      payload: input.payload ?? {},
      jobRunId: input.jobRunId ?? null,
    })
    .returning();
  const event = rows[0];
  if (!event) throw new Error("audit_events insert returned no row");
  return event;
}
