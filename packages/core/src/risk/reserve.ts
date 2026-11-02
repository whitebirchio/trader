import { and, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { capitalFlows, withdrawals } from "../db/schema.js";
import { compare, sub } from "../money.js";

/**
 * Cash held back for an open withdrawal request (SPEC-capital). It lives in
 * risk, below portfolio and capital, because both the targets and the buy
 * rule subtract it; capital owns the request itself.
 */
export interface WithdrawalReserve {
  /** Dollars still to come out: the investable equity excludes them. */
  outstanding: string;
  /** What the cash doesn't cover yet: what sells still have to raise. */
  unfunded: string;
}

export const NO_RESERVE: WithdrawalReserve = { outstanding: "0", unfunded: "0" };

/** A request reserves cash from planning until it closes. */
export const OPEN_WITHDRAWAL_STATUSES = ["planning", "funding", "settling", "ready"] as const;
const positive = (v: string) => (compare(v, "0") > 0 ? v : "0");

/** Outstanding for a request: the amount less what has been withdrawn, or the whole account (`amount` null = all). */
export function outstandingAmount(amount: string | null, withdrawn: string, equity: string): string {
  return positive(amount === null ? equity : sub(amount, withdrawn));
}

/** Past these, the cash has been raised: a later fall in cash is most likely the transfer itself, not yet posted. */
const RAISED = new Set(["settling", "ready"]);

/**
 * Once the cash has been raised (settling, ready), nothing more is sold for
 * the request: if Alpaca lowers cash when Scott starts the ACH, before the
 * transfer activity posts, re-raising would sell the amount twice. Buys stay
 * blocked by `outstanding` until the transfer is matched.
 */
export function reserveFor(request: { status: string; amount: string | null; withdrawn: string } | null, equity: string, cash: string): WithdrawalReserve {
  if (!request) return NO_RESERVE;
  const outstanding = outstandingAmount(request.amount, request.withdrawn, equity);
  return { outstanding, unfunded: RAISED.has(request.status) ? "0" : positive(sub(outstanding, cash)) };
}

/** The open request's reserve, from the database. */
export async function loadReserve(db: Db, equity: string, cash: string): Promise<WithdrawalReserve> {
  const [open] = await db
    .select({ status: withdrawals.status, amount: withdrawals.amount, withdrawn: withdrawals.withdrawn })
    .from(withdrawals)
    .where(inArray(withdrawals.status, OPEN_WITHDRAWAL_STATUSES))
    .limit(1);
  return reserveFor(open ?? null, equity, cash);
}

/**
 * Reserved cash that has left the account without a posted transfer: the
 * owner's ACH in flight (SPEC-capital). Counted as money out by the drawdown
 * and daily-loss measures, so a withdrawal can't latch a false halt if Alpaca
 * lowers cash before the CSW activity appears.
 *
 * Bounded so it can't hide a loss: only once the sells have raised the cash
 * (settling, ready), never more than what's outstanding, and less any
 * outgoing transfer already posted but not yet matched. Reserved cash isn't
 * invested and risk keeps buys out of it, so a fall in it is a transfer, a
 * fee, or an order placed by hand in Alpaca (which emails on its own).
 */
export async function pendingTransferOut(db: Db, cash: string): Promise<string> {
  const [w] = await db.select().from(withdrawals).where(inArray(withdrawals.status, ["settling", "ready"])).limit(1);
  if (!w) return "0";
  // The cash that should still be there: the amount left, or for "all" what was raised less what's gone.
  const expected = w.amount === null ? (w.raisedCash ? positive(sub(w.raisedCash, w.withdrawn)) : "0") : positive(sub(w.amount, w.withdrawn));
  const posted = await db
    .select({ id: capitalFlows.activityId, amount: capitalFlows.amount })
    .from(capitalFlows)
    .where(and(lt(capitalFlows.amount, "0"), gte(capitalFlows.at, w.requestedAt), or(isNull(capitalFlows.status), ne(capitalFlows.status, "canceled"))));
  const matched = new Set(w.flowIds);
  const unmatched = posted.filter((f) => !matched.has(f.id)).reduce((sum, f) => sub(sum, f.amount), "0");
  const missing = positive(sub(sub(expected, cash), unmatched));
  return compare(missing, expected) > 0 ? expected : missing;
}
