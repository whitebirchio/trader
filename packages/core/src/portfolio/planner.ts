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
}

const QTY_DP = 9;

/**
 * Targets vs holdings → the next step's trades (SPEC-portfolio).
 * - Holdings with no target are sold in full.
 * - A target drifted by more than max(relativePct × target, minTradeUsd) is traded back to target.
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
    if (compare(gap, threshold) < 0) continue;

    if (compare(diff, "0") > 0) {
      const dollars = round(diff, 2, "down");
      buys.push({
        sleeve: t.sleeve,
        dollars,
        proposal: { key: key(t.symbol, "buy"), symbol: t.symbol, side: "buy", sleeve: t.sleeve, notional: dollars },
        reason: h ? `${t.symbol} is $${dollars} under its $${t.dollars} target (${t.reason})` : `new position: ${t.reason}`,
      });
    } else if (h && compare(h.currentPrice, "0") > 0) {
      const qtyRaw = round(div(gap, h.currentPrice, QTY_DP + 2, "down"), QTY_DP, "down");
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
