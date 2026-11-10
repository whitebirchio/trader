import type { ClosedLot } from "../broker/lots.js";
import { add, compare, div, mul, round, sub } from "../money.js";
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
  /** Trades held back by the same-day round-trip guard, and buys nothing can fund, as notes. */
  deferred?: string[];
  /**
   * Buys the spare cash couldn't cover, and what's still short after every
   * position over target was counted (`uncovered`, "0" if nothing). Present
   * whenever funding sells were needed.
   */
  funding?: { buys: { symbol: string; sleeve: Sleeve; dollars: string }[]; shortfall: string; uncovered: string };
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
   * Dollars a withdrawal still needs (SPEC-capital). Sells the drift band
   * wants anyway count toward it; for the rest, positions over target inside
   * their band are sold back toward it, largest gap first and the last sized
   * to the remainder, so a small withdrawal can't wait forever inside the
   * band and doesn't trim every drifted name either.
   */
  raiseCash?: string;
  /**
   * Cash is sitting idle beyond any withdrawal reserve (a deposit, a
   * cancelled withdrawal): buy anything under its target back to it, however
   * small the drift (down to $1). A deposit spreads over every target, so
   * each gap is inside its band and the cash would never be invested
   * (ADR-013: no idle money).
   */
  deployCash?: boolean;
  /**
   * Cash free to spend (beyond any withdrawal reserve and buffer). When the
   * buys need more than this, positions over target inside their band are
   * sold back toward it to fund them, largest gap first, the same way as for
   * a withdrawal. Without it, a new thesis smaller than the band could never
   * be bought in a fully invested account, and an underweight systematic
   * holding would be proposed (and rejected for cash) every step (#82).
   * Omitted: no funding sells.
   */
  spendableCash?: string;
  /**
   * Symbols that must not trade this step on one side (risk's same-day
   * round-trip guard): left out of the plan with a note, rather than proposed
   * and rejected every 15 minutes.
   */
  blocked?: { sell: ReadonlySet<string>; buy: ReadonlySet<string> };
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
  const raise = input.raiseCash && compare(input.raiseCash, "0") > 0 ? input.raiseCash : null;
  const raiseCandidates: { target: Target; holding: PlanHolding; gap: string }[] = [];
  /** Proceeds of the sells planned so far, at the last price. */
  let selling = "0";
  const buys: (PlannedTrade & { sleeve: Sleeve; dollars: string })[] = [];

  for (const h of held.values()) {
    if (targeted.has(h.symbol)) continue;
    sells.push({
      proposal: { key: key(h.symbol, "sell"), symbol: h.symbol, side: "sell", sleeve: input.sleeveOf?.(h.symbol) ?? "systematic", qty: h.qty },
      reason: input.exitReasons?.[h.symbol] ?? `${h.symbol} is no longer a target`,
    });
    selling = add(selling, h.marketValue);
  }

  for (const t of input.targets) {
    const h = held.get(t.symbol);
    const current = h?.marketValue ?? "0";
    const diff = sub(t.dollars, current);
    const relative = div(mul(t.dollars, input.drift.relativePct), "100", 2, "down");
    const threshold = compare(relative, input.drift.minTradeUsd) > 0 ? relative : input.drift.minTradeUsd;
    const gap = compare(diff, "0") < 0 ? sub("0", diff) : diff;
    const deploying = input.deployCash === true && compare(diff, "0") > 0;
    if (compare(gap, deploying ? MIN_TRADE_USD : threshold) < 0) {
      // Inside the band but over target: a candidate if a withdrawal still needs cash.
      if (h && compare(diff, "0") < 0 && compare(gap, MIN_TRADE_USD) >= 0 && compare(h.currentPrice, "0") > 0) raiseCandidates.push({ target: t, holding: h, gap });
      continue;
    }

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
      const mode = raise ? "up" : "down";
      const qtyRaw = round(div(gap, h.currentPrice, QTY_DP + 2, mode), QTY_DP, mode);
      const qty = compare(qtyRaw, h.qty) > 0 ? h.qty : qtyRaw;
      if (compare(qty, "0") <= 0) continue;
      sells.push({
        proposal: { key: key(t.symbol, "sell"), symbol: t.symbol, side: "sell", sleeve: t.sleeve, qty },
        reason: `${t.symbol} is $${round(gap, 2, "down")} over its $${t.dollars} target (${t.reason})`,
      });
      selling = add(selling, mul(qty, h.currentPrice));
    }
  }

  // Buys the spare cash can't cover are funded like a withdrawal: from
  // positions over target, however small the gap (the band would otherwise
  // keep a fully invested account from ever buying a new thesis, or an
  // underweight systematic holding waiting until prices crossed a band, #82).
  const total = (sleeve?: Sleeve) => buys.filter((b) => !sleeve || b.sleeve === sleeve).reduce((sum, b) => add(sum, b.dollars), "0");
  const shortfall = input.spendableCash === undefined ? "0" : sub(total(), input.spendableCash);
  const funding = compare(shortfall, MIN_TRADE_USD) >= 0 ? shortfall : null;
  // Conviction buys go first, so the systematic ones are short only once the conviction ones have the cash.
  const convictionShort = input.spendableCash !== undefined && compare(total("conviction"), input.spendableCash) > 0;
  const systematicShort = compare(total("systematic"), "0") > 0;
  const buysFunded = convictionShort && systematicShort ? "the conviction and systematic buys" : convictionShort ? "the conviction buys" : "the systematic buys";
  const purpose = raise && funding ? `your withdrawal and ${buysFunded}` : raise ? "your withdrawal" : buysFunded;
  /** Funding sources the same-day guard held back. */
  const fundingBlocked: string[] = [];
  let uncovered = "0";
  if (raise || funding) {
    let needed = sub(add(raise ?? "0", funding ?? "0"), selling);
    // VTI and the systematic sleeve first, theses last (their own buys would
    // just top them back up); within each, the largest gap first.
    const tier = (c: (typeof raiseCandidates)[number]) => (c.target.sleeve === "conviction" ? 1 : 0);
    raiseCandidates.sort((a, b) => tier(a) - tier(b) || compare(b.gap, a.gap));
    for (const { target: t, holding: h, gap } of raiseCandidates) {
      if (compare(needed, MIN_TRADE_USD) < 0) break;
      if (input.blocked?.sell.has(t.symbol)) {
        fundingBlocked.push(t.symbol);
        continue;
      }
      const take = compare(gap, needed) > 0 ? needed : gap;
      const qtyRaw = round(div(take, h.currentPrice, QTY_DP + 2, "up"), QTY_DP, "up");
      const qty = compare(qtyRaw, h.qty) > 0 ? h.qty : qtyRaw;
      sells.push({
        proposal: { key: key(t.symbol, "sell"), symbol: t.symbol, side: "sell", sleeve: t.sleeve, qty },
        reason: `${t.symbol} is $${round(gap, 2, "down")} over its $${t.dollars} target; selling $${round(take, 2, "up")} of it to raise cash for ${purpose}`,
      });
      needed = sub(needed, mul(qty, h.currentPrice));
    }
    // What's left is the buys' share at most (the rest is a withdrawal's, which has its own notes).
    const left = funding && compare(needed, funding) > 0 ? funding : needed;
    if (funding) uncovered = compare(left, MIN_TRADE_USD) >= 0 ? round(left, 2, "up") : "0";
  }

  const deferred: string[] = [];
  if (compare(uncovered, "0") > 0) deferred.push(`$${uncovered} of ${buysFunded} can't be funded: nothing else is over its target`);

  // Risk's same-day round-trip guard: what can't trade today waits for tomorrow.
  const defer = (symbol: string, side: "buy" | "sell") =>
    deferred.push(`${symbol}: ${side} waits until tomorrow (it was ${side === "sell" ? "bought" : "sold"} today, and same-day round trips are off)`);
  const allowed = (side: "buy" | "sell") => (t: PlannedTrade) => {
    if (!input.blocked?.[side].has(t.proposal.symbol)) return true;
    defer(t.proposal.symbol, side);
    return false;
  };
  const fundingNote = funding ? { funding: { buys: buys.map((b) => ({ symbol: b.proposal.symbol, sleeve: b.sleeve, dollars: b.dollars })), shortfall: round(funding, 2, "up"), uncovered } } : {};
  const plan = (phase: Plan["phase"], trades: PlannedTrade[]): Plan => ({ phase, trades, ...(deferred.length > 0 ? { deferred } : {}), ...fundingNote });

  const sellsNow = sells.filter(allowed("sell"));
  if (sellsNow.length > 0) return plan("sell", sellsNow);
  for (const symbol of fundingBlocked) defer(symbol, "sell");
  if (funding && (fundingBlocked.length > 0 || sells.length > 0)) {
    // The sells that would fund the buys wait for tomorrow, so the buys do too.
    deferred.push(`${buysFunded} wait for the sells that fund them ($${round(funding, 2, "up")} short in cash)`);
    return plan("none", []);
  }
  const buysNow = buys.filter(allowed("buy"));
  if (buysNow.length === 0) return plan("none", []);
  buysNow.sort((a, b) => (a.sleeve === b.sleeve ? compare(b.dollars, a.dollars) : a.sleeve === "conviction" ? -1 : 1));
  return plan("buy", buysNow.map(({ proposal, reason }) => ({ proposal, reason })));
}

/**
 * While trading is halted (ADR-017): the plan's whole exits of `exitable`
 * symbols (a thesis that closed, or one no longer in the strategy), tagged
 * `exit`. Nothing is bought or resized, and the proceeds wait in cash until
 * the owner resumes.
 */
export function haltExits(trades: PlannedTrade[], holdings: PlanHolding[], exitable: ReadonlySet<string>): PlannedTrade[] {
  const qty = new Map(holdings.map((h) => [h.symbol, h.qty]));
  return trades
    .filter((t) => t.proposal.side === "sell" && exitable.has(t.proposal.symbol) && t.proposal.qty === qty.get(t.proposal.symbol))
    .map((t) => ({ proposal: { ...t.proposal, purpose: "exit" as const }, reason: `${t.reason}; sold while trading is halted, since a halt still lets a closed thesis out` }));
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
