import { and, eq, inArray, isNull } from "drizzle-orm";
import { type AuditKind, recordEvent } from "../audit.js";
import type { Activity } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { brokerActivities, capitalFlows } from "../db/schema.js";
import { compare } from "../money.js";

/**
 * The capital ledger (SPEC-capital): every external transfer, timed by the
 * instant the money moved. Everything that needs flows (the risk index, the
 * VTI comparison, the dashboard, notifications) reads `capital_flows`, never
 * broker activities directly.
 */

/** Alpaca's cash movements into the account: ACH/wire deposits and journals in. */
const INFLOW_TYPES = new Set(["CSD", "JNLC"]);
/** Cash movements out: ACH/wire withdrawals and journals out. */
const OUTFLOW_TYPES = new Set(["CSW", "JNLS"]);
export const FLOW_ACTIVITY_TYPES = [...INFLOW_TYPES, ...OUTFLOW_TYPES];

export type FlowKind = "deposit" | "withdrawal" | "reversal";

export interface CapitalFlow {
  activityId: string;
  at: Date;
  /** Signed decimal string: positive into the account, negative out. */
  amount: string;
  kind: FlowKind;
  /** `booking_date`: Alpaca gave no created_at, so `at` is noon ET on the booking date. */
  timedBy: "created_at" | "booking_date";
  status: string | null;
}

/**
 * The ledger row for an activity, or null if it isn't an external transfer.
 * The amount keeps Alpaca's sign, because that is the direction cash moved.
 * Money moving against its type (a deposit with a negative amount, e.g. a
 * returned instant ACH) is labelled a reversal.
 */
export function toCapitalFlow(a: Activity): CapitalFlow | null {
  const inflow = INFLOW_TYPES.has(a.type);
  if ((!inflow && !OUTFLOW_TYPES.has(a.type)) || a.netAmount === null) return null;
  const sign = compare(a.netAmount, "0");
  if (sign === 0) return null;
  const kind: FlowKind = inflow ? (sign > 0 ? "deposit" : "reversal") : sign < 0 ? "withdrawal" : "reversal";
  return {
    activityId: a.id,
    at: a.at,
    amount: a.netAmount,
    kind,
    timedBy: typeof a.raw.created_at === "string" ? "created_at" : "booking_date",
    status: typeof a.raw.status === "string" ? a.raw.status : null,
  };
}

export interface RecordFlowsResult {
  added: number;
  /** New flows without a created_at. Worth noticing: their timing is approximate. */
  timedByBookingDate: number;
}

/** Older flows are recorded silently: the first run backfills history without a burst of emails. */
export const ANNOUNCE_WITHIN_MS = 7 * 86_400_000;

/** The audit event for a newly recorded flow (SPEC-capital). */
export function flowEventKind(f: Pick<CapitalFlow, "kind" | "status">): AuditKind {
  if (f.status === "canceled") return "capital.transfer_canceled";
  switch (f.kind) {
    case "deposit":
      return "capital.deposit_received";
    case "reversal":
      return "capital.transfer_reversed";
    case "withdrawal":
      // Until withdrawal requests exist (C5), every outflow is unplanned.
      return "capital.unplanned_outflow";
  }
}

/**
 * Copy transfer activities that aren't in the ledger yet, and announce the
 * recent ones. Idempotent: it runs after every broker sync, and the first
 * run backfills the whole history.
 */
export async function recordCapitalFlows(db: Db, now: Date): Promise<RecordFlowsResult> {
  const pending = await db
    .select({ activity: brokerActivities })
    .from(brokerActivities)
    .leftJoin(capitalFlows, eq(capitalFlows.activityId, brokerActivities.id))
    .where(and(inArray(brokerActivities.type, FLOW_ACTIVITY_TYPES), isNull(capitalFlows.activityId)));

  const flows = pending
    .map(({ activity: r }) => ({
      flow: toCapitalFlow({ ...r, side: r.side === "buy" || r.side === "sell" ? r.side : null }),
      type: r.type,
    }))
    .filter((x): x is { flow: CapitalFlow; type: string } => x.flow !== null);
  if (flows.length === 0) return { added: 0, timedByBookingDate: 0 };

  // The row and its announcement land together, or not at all.
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(capitalFlows)
      .values(flows.map((x) => x.flow))
      .onConflictDoNothing({ target: capitalFlows.activityId })
      .returning({ activityId: capitalFlows.activityId, timedBy: capitalFlows.timedBy });
    const insertedIds = new Set(inserted.map((r) => r.activityId));
    for (const { flow, type } of flows) {
      if (!insertedIds.has(flow.activityId) || now.getTime() - flow.at.getTime() > ANNOUNCE_WITHIN_MS) continue;
      await recordEvent(tx as unknown as Db, {
        actor: "system",
        kind: flowEventKind(flow),
        subject: flow.activityId,
        payload: { amount: flow.amount, type, at: flow.at.toISOString(), timedBy: flow.timedBy, status: flow.status },
      });
    }
    return { added: inserted.length, timedByBookingDate: inserted.filter((r) => r.timedBy === "booking_date").length };
  });
}
