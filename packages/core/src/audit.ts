import type { Db } from "./db/client.js";
import { auditEvents } from "./db/schema.js";

/**
 * Every kind of state-changing action the system records (ADR-008). Later
 * modules extend this union (`order.submitted`, `strategy.activated`, …);
 * `notifications` decides which kinds email Scott.
 */
export type AuditKind =
  | "job.failed"
  // Orders (SPEC-broker). `order.external` = an order placed outside Trader, e.g. in the Alpaca app.
  | "order.intent"
  | "order.submitted"
  | "order.unknown"
  | "order.partially_filled"
  | "order.filled"
  | "order.canceled"
  | "order.rejected"
  | "order.external"
  // Broker safety verdict transitions (tradingAllowed).
  | "broker.account_changed"
  | "broker.config_unsafe"
  | "broker.reconcile_mismatch"
  | "broker.trading_allowed";

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
