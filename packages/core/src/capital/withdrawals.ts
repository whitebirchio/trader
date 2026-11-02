import type { AuditActor } from "../audit.js";
import type { CalendarDay } from "../broker/port.js";
import type { withdrawals } from "../db/schema.js";
import { add, compare, mul, round, sub } from "../money.js";
import { OPEN_WITHDRAWAL_STATUSES, outstandingAmount } from "../risk/reserve.js";
import { formatMarketTime, marketDate } from "../time.js";

/**
 * Withdrawal requests (SPEC-capital): the pure lifecycle. Persistence and the
 * tick job live in commands.ts. `requested` is a command the engine hasn't
 * processed yet, so a stored request starts in `planning`.
 *
 *   planning ─▶ funding ─▶ settling ─▶ ready ─▶ withdrawn
 *        └──────────┴───────────┴─────────┴──▶ cancelled
 */

export type Withdrawal = typeof withdrawals.$inferSelect;
export type WithdrawalStatus = Withdrawal["status"];

export const OPEN_STATUSES = OPEN_WITHDRAWAL_STATUSES satisfies readonly WithdrawalStatus[];

export function isOpen(status: WithdrawalStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * The Claude Code routine's schedule, as its cron (SPEC-agent): minute 0 of
 * these UTC hours, Monday to Friday. A test pins it to SPEC-agent.
 */
export const ROUTINE_CRON_UTC = { hours: [13, 17], weekdays: [1, 2, 3, 4, 5] } as const;
/** Claude's run gets this long after it fires to plan a withdrawal (Scott, 2026-11-01). */
export const PLAN_WINDOW_MS = 60 * 60_000;

/**
 * When Claude's window to plan a withdrawal's funding closes: the next
 * routine run on a trading day, plus an hour. After it, the fallback funds
 * the request. Without a calendar entry in the next two weeks (the broker
 * didn't answer), a day from now.
 */
export function fundingDeadline(requestedAt: Date, calendar: CalendarDay[]): Date {
  const trading = new Set(calendar.map((d) => d.date));
  const start = Date.UTC(requestedAt.getUTCFullYear(), requestedAt.getUTCMonth(), requestedAt.getUTCDate());
  for (let day = 0; day < 15; day++) {
    for (const hour of ROUTINE_CRON_UTC.hours) {
      const fire = new Date(start + day * 86_400_000 + hour * 3_600_000);
      if (fire <= requestedAt) continue;
      if (!(ROUTINE_CRON_UTC.weekdays as readonly number[]).includes(fire.getUTCDay())) continue;
      if (trading.has(marketDate(fire))) return new Date(fire.getTime() + PLAN_WINDOW_MS);
    }
  }
  return new Date(requestedAt.getTime() + 86_400_000);
}

/**
 * Within this much, a request counts as funded, settled or withdrawn: sells
 * can't raise less than Alpaca's $1 minimum, and prices move between a plan
 * and its fill, so cash can land a few cents short for good.
 */
export const CASH_TOLERANCE = "1";

const coversWithin = (have: string, need: string) => compare(add(have, CASH_TOLERANCE), need) > 0;

export type ParsedAmount = { ok: true; amount: string | null } | { ok: false; reason: string };

/** A request's amount: whole cents of at least $1, or "all" (null). Anything else is rejected, never guessed. */
export function parseAmount(raw: string | null): ParsedAmount {
  const value = raw?.trim() ?? "";
  if (value.toLowerCase() === "all") return { ok: true, amount: null };
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return { ok: false, reason: `"${raw ?? ""}" isn't a dollar amount (like 500 or 500.25) or "all"` };
  if (compare(value, "1") < 0) return { ok: false, reason: `$${value} is below the $1 minimum` };
  return { ok: true, amount: round(value, 2, "down") };
}

/** Dollars still to come out: the requested amount less what has been withdrawn, or the whole account for "all". */
export function outstanding(w: Pick<Withdrawal, "amount" | "withdrawn">, equity: string): string {
  return outstandingAmount(w.amount, w.withdrawn, equity);
}

export interface SellFill {
  at: Date;
  qty: string;
  price: string;
}

/**
 * When a sale's proceeds can be withdrawn: T+1, taken as the close of the
 * next trading day after the fill's market date. Bank holidays the market
 * trades through can push real settlement a day later, so emails say
 * "should be withdrawable". Null if the calendar doesn't reach that far.
 */
export function settlesAt(fillAt: Date, calendar: CalendarDay[]): Date | null {
  const tradeDate = marketDate(fillAt);
  const next = [...calendar].sort((a, b) => a.date.localeCompare(b.date)).find((d) => d.date > tradeDate);
  return next?.close ?? null;
}

/** Sale proceeds not yet settled at `now`, and when the last of them settles. */
export function unsettledProceeds(sells: SellFill[], calendar: CalendarDay[], now: Date): { amount: string; settledBy: Date | null } {
  let amount = "0";
  let settledBy: Date | null = null;
  for (const s of sells) {
    const at = settlesAt(s.at, calendar);
    if (at && at <= now) continue;
    amount = add(amount, mul(s.qty, s.price));
    if (at && (!settledBy || at > settledBy)) settledBy = at;
  }
  return { amount: round(amount, 2, "up"), settledBy };
}

export interface Outflow {
  activityId: string;
  at: Date;
  /** Negative: money out. */
  amount: string;
}

export type OutflowMatch =
  | { status: "none" }
  | { status: "partial" | "complete"; withdrawn: string; flowIds: string[]; matched: Outflow[] };

/**
 * Match outgoing transfers to the open request: those since it was made and
 * not matched yet. One that covers what's outstanding completes it; a smaller
 * one leaves the rest open (within CASH_TOLERANCE either way). "All"
 * completes once the account is empty (equity under $1 after the transfer).
 */
export function matchOutflows(w: Pick<Withdrawal, "amount" | "withdrawn" | "flowIds" | "requestedAt">, flows: Outflow[], equityAfter: string): OutflowMatch {
  const seen = new Set(w.flowIds);
  const matched = flows.filter((f) => !seen.has(f.activityId) && f.at >= w.requestedAt && compare(f.amount, "0") < 0);
  if (matched.length === 0) return { status: "none" };
  const withdrawn = matched.reduce((sum, f) => sub(sum, f.amount), w.withdrawn);
  const done = w.amount === null ? compare(equityAfter, CASH_TOLERANCE) < 0 : coversWithin(withdrawn, w.amount);
  return { status: done ? "complete" : "partial", withdrawn, flowIds: [...w.flowIds, ...matched.map((f) => f.activityId)], matched };
}

/** What `advance` needs to know about the account. */
export interface AccountView {
  equity: string;
  cash: string;
  /** Sale proceeds not yet settled, and when the last of them settles. */
  unsettled: { amount: string; settledBy: Date | null };
  longMarketValue: string;
  openOrders: number;
  /** The first strategy version stored since the request was made: the plan that funds it. */
  plan: { version: number; authoredBy: AuditActor } | null;
}

/** What Scott can take out now: what's outstanding, or the settled cash when that's a few cents short (or for "all"). */
export function withdrawable(w: Pick<Withdrawal, "amount" | "withdrawn">, account: Pick<AccountView, "equity" | "cash" | "unsettled">): string {
  const out = outstanding(w, account.equity);
  const settled = round(sub(account.cash, account.unsettled.amount), 2, "down");
  if (w.amount !== null && compare(settled, out) >= 0) return out;
  return compare(settled, "0") > 0 ? settled : "0";
}

export type WithdrawalTransition =
  | { status: "advanced"; to: WithdrawalStatus; reason: string; fundingVersion?: number; fundedBy?: AuditActor }
  /** Claude's window has closed (or Scott asked to fund now): the fallback should plan it. */
  | { status: "fallback_due"; reason: string }
  | { status: "unchanged"; reason: string };

const usd = (v: string) => {
  const [whole, frac = ""] = round(v, 2, "half-even").split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

/**
 * One step of an open request, given the latest account state. Pure; the
 * caller applies it, audits it, and calls again until it's unchanged, so a
 * request can move through several states in one tick.
 */
export function advance(w: Withdrawal, account: AccountView, now: Date): WithdrawalTransition {
  const out = outstanding(w, account.equity);
  const settled = sub(account.cash, account.unsettled.amount);
  const all = w.amount === null;
  const sold = compare(account.longMarketValue, "0") <= 0 && account.openOrders === 0;
  const isSettled = all ? sold && compare(account.unsettled.amount, "0") <= 0 : coversWithin(settled, out);
  const isFunded = all ? sold : coversWithin(account.cash, out);
  const settling = account.unsettled.settledBy ? `should settle by ${formatMarketTime(account.unsettled.settledBy)}` : "settling";

  switch (w.status) {
    case "planning":
      // Selling everything needs no plan: whatever the strategy, nothing is investable.
      if (all) return { status: "advanced", to: "funding", reason: "selling everything", fundedBy: "system" };
      if (isSettled) return { status: "advanced", to: "ready", reason: `${usd(settled)} of settled cash already covers it` };
      if (account.plan) {
        return {
          status: "advanced",
          to: "funding",
          reason: `strategy v${account.plan.version} (${account.plan.authoredBy}) plans the sells`,
          fundingVersion: account.plan.version,
          fundedBy: account.plan.authoredBy,
        };
      }
      if (now >= w.deadline) return { status: "fallback_due", reason: `Claude didn't plan it by ${formatMarketTime(w.deadline)}` };
      return { status: "unchanged", reason: `waiting for Claude's plan until ${formatMarketTime(w.deadline)}` };
    case "funding":
      if (isSettled) return { status: "advanced", to: "ready", reason: all ? "everything is sold and settled" : `${usd(settled)} of settled cash covers ${usd(out)}` };
      if (isFunded) return { status: "advanced", to: "settling", reason: all ? `everything is sold; ${settling}` : `${usd(account.cash)} of cash covers ${usd(out)}; ${settling}` };
      return {
        status: "unchanged",
        reason: all ? `${usd(account.longMarketValue)} still to sell` : `cash ${usd(account.cash)} of ${usd(out)}`,
      };
    case "settling":
      if (isSettled) return { status: "advanced", to: "ready", reason: all ? "the proceeds have settled" : `${usd(settled)} of settled cash covers ${usd(out)}` };
      return { status: "unchanged", reason: settling };
    case "ready":
      return { status: "unchanged", reason: `waiting for you to withdraw ${usd(withdrawable(w, account))} in Alpaca` };
    case "withdrawn":
    case "cancelled":
      return { status: "unchanged", reason: `the request is ${w.status}` };
  }
}
