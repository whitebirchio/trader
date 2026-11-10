import type { AuditKind } from "../audit.js";

export type Route = "urgent" | "digest" | "ignore";

/**
 * Where each audit kind is emailed (SPEC-notifications). A `Record` over every
 * AuditKind, so adding a kind without deciding its route fails to typecheck.
 */
const ROUTES: Record<AuditKind, Route> = {
  "job.failed": "urgent", // throttled per job in the outbox

  "order.intent": "ignore", // always followed by submitted or rejected
  "order.submitted": "digest",
  "order.partially_filled": "digest",
  "order.filled": "digest",
  "order.canceled": "digest",
  "order.rejected": "digest",
  "order.unknown": "urgent",
  "order.external": "urgent",

  "broker.config_unsafe": "urgent",
  "broker.account_changed": "urgent",
  "broker.reconcile_mismatch": "urgent",
  "broker.trading_allowed": "urgent",

  "risk.order_clipped": "digest",
  "risk.order_rejected": "digest",
  "risk.buys_paused": "urgent",
  "risk.buys_resumed": "digest",
  "risk.halted": "urgent",
  "risk.kill_switch_on": "urgent",
  "risk.resumed": "urgent",

  "strategy.activated": "urgent", // the strategy changed: meaningful, autonomous
  "strategy.rejected": "urgent", // Claude submitted something invalid: the old version stays
  "thesis.stopped_out": "urgent",
  "thesis.stale": "urgent", // the research loop may be down
  "thesis.review_overdue": "urgent", // an automatic sale: the review date passed
  "rebalance.planned": "digest",
  "rebalance.buys_funded": "digest", // the planner trimmed holdings to pay for a systematic buy (#82)

  "capital.deposit_received": "digest", // your own action; invested at the next rebalance step
  "capital.transfer_reversed": "urgent", // e.g. a returned instant ACH: money taken back
  "capital.transfer_canceled": "urgent", // left out of the index on the assumption it never moved money
  "capital.unplanned_outflow": "urgent", // money left with no withdrawal request
  // Every owner command emails at once: an out-of-band notice of each write (SPEC-capital).
  "capital.withdrawal_requested": "urgent",
  "capital.fund_now": "urgent",
  "capital.withdrawal_cancelled": "urgent",
  "capital.command_rejected": "urgent",
  "capital.funding_planned": "urgent", // what will be sold, and why
  "capital.withdrawal_settling": "digest",
  "capital.withdrawal_ready": "urgent", // your turn: withdraw it in Alpaca
  "capital.withdrawal_partial": "digest",
  "capital.withdrawal_completed": "digest",
};

export function routeFor(kind: string): Route {
  return (ROUTES as Record<string, Route>)[kind] ?? "urgent"; // an unknown kind is loud, not lost
}

export const URGENT_KINDS = (Object.keys(ROUTES) as AuditKind[]).filter((k) => ROUTES[k] === "urgent");
export const DIGEST_KINDS = (Object.keys(ROUTES) as AuditKind[]).filter((k) => ROUTES[k] === "digest");

/** Most severe first, for ordering several urgent events in one email. */
export const SEVERITY: Partial<Record<AuditKind, number>> = {
  "risk.halted": 0,
  "risk.kill_switch_on": 1,
  "broker.account_changed": 2,
  "broker.config_unsafe": 3,
  "broker.reconcile_mismatch": 4,
  "order.external": 5,
  "capital.unplanned_outflow": 5.2, // money left that nobody asked for
  "capital.transfer_reversed": 5.4,
  "capital.command_rejected": 5.6,
  "order.unknown": 6,
  "risk.buys_paused": 7,
  "job.failed": 8,
  "thesis.stopped_out": 7.5,
  "thesis.stale": 7.6,
  "thesis.review_overdue": 7.65,
  "strategy.rejected": 7.7,
  "capital.withdrawal_ready": 7.8, // your turn: withdraw it in Alpaca
  "risk.resumed": 9,
  "strategy.activated": 9.5,
  "broker.trading_allowed": 10,
};
