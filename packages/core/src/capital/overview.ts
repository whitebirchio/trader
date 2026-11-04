import { asc, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { capitalFlows, withdrawals } from "../db/schema.js";
import { add, sub } from "../money.js";
import { reserveFor } from "../risk/reserve.js";
import { type CapitalSummary, capitalSummary } from "./shadow.js";
import { OPEN_STATUSES } from "./withdrawals.js";

/**
 * Money in and out, for Claude's get_overview and the dashboard (SPEC-capital).
 * Database only: the dashboard has no broker keys.
 */
export interface CapitalOverview {
  /** Money-weighted: net deposits, value now, the same flows in VTI. Null before any transfer. */
  summary: CapitalSummary | null;
  /** Transfers since the theses were last reaffirmed: what the active weights don't know about yet. */
  sinceLastStrategy: { since: string; net: string; transfers: { at: string; amount: string; kind: string }[] };
  /** The open withdrawal request, if any. */
  withdrawal: null | {
    status: string;
    /** Dollars, or "all". */
    amount: string;
    withdrawn: string;
    /** Still to come out: held back from every target. */
    outstanding: string;
    /** What the cash doesn't cover yet: what the sells still have to raise. */
    unfunded: string;
    /** Equity the targets are built on while it's open. */
    investableEquity: string;
    requestedAt: string;
    /** Claude's window: plan the funding by then, or the fallback does. Only while planning. */
    planBy: string | null;
    fundingVersion: number | null;
    fundedBy: string | null;
  };
}

export async function capitalOverview(db: Db, account: { equity: string; cash: string }, since: Date): Promise<CapitalOverview | null> {
  const summary = await capitalSummary(db);
  const [w] = await db.select().from(withdrawals).where(inArray(withdrawals.status, OPEN_STATUSES)).limit(1);
  if (!summary && !w) return null;

  const recent = await db.select().from(capitalFlows).where(gte(capitalFlows.at, since)).orderBy(asc(capitalFlows.at));
  const counted = recent.filter((f) => f.status !== "canceled");
  const reserve = reserveFor(w ?? null, account.equity, account.cash);
  return {
    summary,
    sinceLastStrategy: {
      since: since.toISOString(),
      net: counted.reduce((sum, f) => add(sum, f.amount), "0"),
      transfers: counted.map((f) => ({ at: f.at.toISOString(), amount: f.amount, kind: f.kind })),
    },
    withdrawal: w
      ? {
          status: w.status,
          amount: w.amount ?? "all",
          withdrawn: w.withdrawn,
          outstanding: reserve.outstanding,
          unfunded: reserve.unfunded,
          investableEquity: sub(account.equity, reserve.outstanding),
          requestedAt: w.requestedAt.toISOString(),
          planBy: w.status === "planning" ? w.deadline.toISOString() : null,
          fundingVersion: w.fundingVersion,
          fundedBy: w.fundedBy,
        }
      : null,
  };
}
