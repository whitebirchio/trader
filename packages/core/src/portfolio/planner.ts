import type { ClosedLot } from "../broker/lots.js";
import { compare, div, mul, round, sub } from "../money.js";
import type { Proposal, Sleeve } from "../risk/types.js";
import type { Target } from "./targets.js";

/** IRS wash-sale window: a loss sale and a repurchase within 30 days (ADR-010). */
export const WASH_SALE_DAYS = 30;

/**
 * Symbols with a realized loss in the last 30 days. Systematic selection
 * skips these (the next rank substitutes); conviction buys don't, since that's
 * Claude's informed call (SPEC-portfolio, ADR-010).
 */
export function washSaleWindow(closed: ClosedLot[], now: Date): Set<string> {
  const since = now.getTime() - WASH_SALE_DAYS * 86_400_000;
  return new Set(closed.filter((c) => compare(c.gain, "0") < 0 && c.closedAt.getTime() >= since).map((c) => c.symbol));
}

export interface PlanHolding {
  symbol: string;
  qty: string;
  marketValue: string;
  currentPrice: string;
}

export interface PlannedTrade {
  proposal: Proposal;
  reason: string;
}

export interface Plan {
  /** `sell` if any sells are due (buys wait for a later step), else `buy`, else `none`. */
  phase: "sell" | "buy" | "none";
  trades: PlannedTrade[];
}

export interface PlanInput {
  planId: string;
  targets: Target[];
  holdings: PlanHolding[];
  drift: { relativePct: string; minTradeUsd: string };
  /** Why a held symbol has no target (e.g. a stopped thesis), for the trade's reason. */
  exitReasons?: Record<string, string>;
  /** Sleeve of a holding with no target, for risk attribution of the exit. */
  sleeveOf?: (symbol: string) => Sleeve | undefined;
  /**
   * A withdrawal still needs cash (SPEC-capital): sell anything over its
   * target back to it, however small the drift (down to $1), or a small
   * withdrawal could wait forever inside the drift band.
   */
  raiseCash?: boolean;
  /**
   * Cash is sitting idle beyond any withdrawal reserve (a deposit, a
   * cancelled withdrawal): buy anything under its target back to it, however
   * small the drift (down to $1). A deposit spreads over every target, so
   * each gap is inside its band and the cash would never be invested
   * (ADR-013: no idle money).
   */
  deployCash?: boolean;
}

/** Alpaca's smallest order: below it, a trade isn't worth placing to raise or invest cash. */
const MIN_TRADE_USD = "1";

const QTY_DP = 9;

/**
 * Targets vs holdings → the next step's trades (SPEC-portfolio).
 * - Holdings with no target are sold in full.
 * - A target drifted by more than max(relativePct × target, minTradeUsd) is traded back to target
 *   (while raising cash for a withdrawal, any position over target by $1 or more is sold back to it;
 *   while investing idle cash, any position under target by $1 or more is bought back to it).
 * - Sells first: if anything is to be sold, this step proposes only sells; buys
 *   are planned on a later step from the cash the fills actually produced.
 * - Buys are ordered conviction first, then largest first, since risk consumes
 *   cash in proposal order.
 */
export function planTrades(input: PlanInput): Plan {
  const key = (symbol: string, side: "buy" | "sell") => `${input.planId}:${symbol}:${side}`;
  const held = new Map(input.holdings.filter((h) => compare(h.qty, "0") > 0).map((h) => [h.symbol, h]));
  const targeted = new Map(input.targets.map((t) => [t.symbol, t]));
  const sells: PlannedTrade[] = [];
  const buys: (PlannedTrade & { sleeve: Sleeve; dollars: string })[] = [];

  for (const h of held.values()) {
    if (targeted.has(h.symbol)) continue;
    sells.push({
      proposal: { key: key(h.symbol, "sell"), symbol: h.symbol, side: "sell", sleeve: input.sleeveOf?.(h.symbol) ?? "systematic", qty: h.qty },
      reason: input.exitReasons?.[h.symbol] ?? `${h.symbol} is no longer a target`,
    });
  }

  for (const t of input.targets) {
    const h = held.get(t.symbol);
    const current = h?.marketValue ?? "0";
    const diff = sub(t.dollars, current);
    const relative = div(mul(t.dollars, input.drift.relativePct), "100", 2, "down");
    const threshold = compare(relative, input.drift.minTradeUsd) > 0 ? relative : input.drift.minTradeUsd;
    const gap = compare(diff, "0") < 0 ? sub("0", diff) : diff;
    const raising = input.raiseCash === true && compare(diff, "0") < 0;
    const deploying = input.deployCash === true && compare(diff, "0") > 0;
    if (compare(gap, raising || deploying ? MIN_TRADE_USD : threshold) < 0) continue;

    if (compare(diff, "0") > 0) {
      const dollars = round(diff, 2, "down");
      buys.push({
        sleeve: t.sleeve,
        dollars,
        proposal: { key: key(t.symbol, "buy"), symbol: t.symbol, side: "buy", sleeve: t.sleeve, notional: dollars },
        reason: h ? `${t.symbol} is $${dollars} under its $${t.dollars} target (${t.reason})` : `new position: ${t.reason}`,
      });
    } else if (h && compare(h.currentPrice, "0") > 0) {
      // Raising cash rounds up, so the proceeds cover the gap rather than fall a fraction short.
      const mode = raising ? "up" : "down";
      const qtyRaw = round(div(gap, h.currentPrice, QTY_DP + 2, mode), QTY_DP, mode);
      const qty = compare(qtyRaw, h.qty) > 0 ? h.qty : qtyRaw;
      if (compare(qty, "0") <= 0) continue;
      sells.push({
        proposal: { key: key(t.symbol, "sell"), symbol: t.symbol, side: "sell", sleeve: t.sleeve, qty },
        reason: `${t.symbol} is $${round(gap, 2, "down")} over its $${t.dollars} target (${t.reason})`,
      });
    }
  }

  if (sells.length > 0) return { phase: "sell", trades: sells };
  if (buys.length === 0) return { phase: "none", trades: [] };
  buys.sort((a, b) => (a.sleeve === b.sleeve ? compare(b.dollars, a.dollars) : a.sleeve === "conviction" ? -1 : 1));
  return { phase: "buy", trades: buys.map(({ proposal, reason }) => ({ proposal, reason })) };
}

/**
 * While trading is halted (SPEC-capital decision 2): only the plan's sells,
 * in plan order, tagged `withdrawal`, until they cover what the withdrawal
 * still needs. The last is sized to the remainder, its quantity rounded up;
 * risk checks the total against the database's figure, not this one.
 */
export function withdrawalSells(trades: PlannedTrade[], holdings: PlanHolding[], unfunded: string): PlannedTrade[] {
  const price = new Map(holdings.map((h) => [h.symbol, h.currentPrice]));
  const out: PlannedTrade[] = [];
  let needed = unfunded;
  for (const trade of trades) {
    const p = trade.proposal;
    if (compare(needed, "0") <= 0) break;
    if (p.side !== "sell") continue;
    const px = price.get(p.symbol);
    if (!px || compare(px, "0") <= 0) continue;
    const value = mul(p.qty, px);
    const qty = compare(value, needed) > 0 ? round(div(needed, px, QTY_DP + 3, "up"), QTY_DP, "up") : p.qty;
    out.push({ proposal: { ...p, qty, purpose: "withdrawal" }, reason: `${trade.reason}; raising cash for your withdrawal while trading is halted` });
    needed = sub(needed, mul(qty, px));
  }
  return out;
}
