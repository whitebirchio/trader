import { add, compare, decimalString, div, mul, round, sub } from "../money.js";
import { ineligibleReasons } from "./eligibility.js";
import { type Limits, capExempt } from "./limits.js";
import type { Decision, Proposal, RiskSnapshot } from "./types.js";

/**
 * The guardrail engine (SPEC-risk). Pure: the same snapshot, proposals and
 * limits always give the same decisions, so any decision can be replayed from
 * the stored snapshot.
 *
 * Proposals are evaluated in the order given, each consuming cash and cap
 * room, so `portfolio` decides which buys get priority. Account-wide stops
 * (kill switch, halt, broker verdict, stale data) reject everything,
 * sells included (Option A, SPEC-risk resolved question 1), with one owner
 * exception: the halt lets withdrawal sells through up to the unfunded
 * amount (ADR-015). Eligibility and caps apply to buys only, so exits are
 * never blocked by them.
 */
export function evaluateOrders(snapshot: RiskSnapshot, proposals: Proposal[], limits: Limits): Decision[] {
  const stop = accountStop(snapshot, limits);
  if (stop) return proposals.map((proposal) => ({ proposal, verdict: "rejected", reasons: [stop] }));
  // The drawdown halt's one exception: the owner's withdrawal, bounded by what it still needs.
  const halted = snapshot.state.halted ? haltMessage(snapshot) : null;
  let withdrawalSold = "0";

  const buffer = maxOf(limits.cashBufferMin, pctOf(snapshot.equity, limits.cashBufferPct));
  const state = {
    orders: snapshot.today.orderCount,
    plannedBuys: "0",
    marketValue: new Map(snapshot.holdings.map((h) => [h.symbol, h.marketValue])),
    heldQty: new Map(snapshot.holdings.map((h) => [h.symbol, h.qty])),
    conviction: snapshot.holdings.filter((h) => h.sleeve === "conviction").reduce((sum, h) => add(sum, h.marketValue), "0"),
  };

  return proposals.map((proposal): Decision => {
    if (state.orders >= limits.maxOrdersPerDay) {
      return reject(proposal, `The daily limit of ${limits.maxOrdersPerDay} orders has been reached.`);
    }
    if (halted) {
      if (proposal.side !== "sell" || proposal.purpose !== "withdrawal") return reject(proposal, halted);
      const roundTrip = sameDayRoundTrip(proposal);
      return roundTrip ? reject(proposal, roundTrip) : evaluateWithdrawalSell(proposal, halted);
    }
    const roundTrip = sameDayRoundTrip(proposal);
    if (roundTrip) return reject(proposal, roundTrip);
    return proposal.side === "sell" ? evaluateSell(proposal) : evaluateBuy(proposal);
  });

  /** No day trades (limits.sameDayRoundTrips): a symbol bought today isn't sold today, nor one sold today bought back. */
  function sameDayRoundTrip(proposal: Proposal): string | null {
    if (limits.sameDayRoundTrips) return null;
    if (proposal.side === "sell" && snapshot.today.bought.includes(proposal.symbol)) {
      return `${proposal.symbol} was bought today; selling it today would be a day trade, so it waits until tomorrow.`;
    }
    if (proposal.side === "buy" && snapshot.today.sold.includes(proposal.symbol)) {
      return `${proposal.symbol} was sold today; buying it back today would be a day trade, so it waits until tomorrow.`;
    }
    return null;
  }

  /**
   * While halted: a withdrawal sell is allowed while the sells so far don't
   * cover the unfunded amount, and is clipped to it (plus $1, so the last
   * sell's quantity can round up). The halt can't be bypassed by the tag:
   * the amount comes from the database, not the proposal.
   */
  function evaluateWithdrawalSell(proposal: Extract<Proposal, { side: "sell" }>, halted: string): Decision {
    const needed = snapshot.withdrawal.unfunded;
    if (compare(needed, "0") <= 0) return reject(proposal, `${halted} No withdrawal needs cash.`);
    if (compare(withdrawalSold, needed) >= 0) return reject(proposal, `Earlier sells already cover the $${needed} your withdrawal needs. ${halted}`);
    const holding = snapshot.holdings.find((h) => h.symbol === proposal.symbol);
    if (!holding || compare(holding.qty, "0") <= 0 || !isPositive(proposal.qty)) return evaluateSell(proposal);
    const price = div(holding.marketValue, holding.qty, 6, "half-even");
    const room = sub(add(needed, limits.minOrderNotional), withdrawalSold);
    let { qty } = proposal;
    const reasons: string[] = [];
    if (compare(mul(qty, price), room) > 0) {
      qty = round(div(room, price, 12, "down"), 9, "down");
      reasons.push(`Reduced to the $${sub(needed, withdrawalSold)} your withdrawal still needs (trading is otherwise halted).`);
    }
    const decision = evaluateSell({ ...proposal, qty });
    if (decision.verdict === "rejected") return decision;
    withdrawalSold = add(withdrawalSold, mul(decision.qty ?? qty, price));
    const all = [...reasons, ...decision.reasons];
    return { ...decision, verdict: all.length ? "clipped" : "approved", reasons: all };
  }

  function evaluateSell(proposal: Extract<Proposal, { side: "sell" }>): Decision {
    if (!isPositive(proposal.qty)) return reject(proposal, `Invalid sell quantity "${proposal.qty}".`);
    const held = state.heldQty.get(proposal.symbol) ?? "0";
    if (compare(held, "0") <= 0) return reject(proposal, `No ${proposal.symbol} shares are held to sell.`);
    let qty = proposal.qty;
    const reasons: string[] = [];
    if (compare(qty, held) > 0) {
      qty = held;
      reasons.push(`Sell reduced to the ${held} ${proposal.symbol} shares held (no shorting).`);
    }
    state.heldQty.set(proposal.symbol, sub(held, qty));
    state.orders++;
    return { proposal, verdict: reasons.length ? "clipped" : "approved", qty, reasons };
  }

  function evaluateBuy(proposal: Extract<Proposal, { side: "buy" }>): Decision {
    const { symbol } = proposal;
    if (!isPositive(proposal.notional)) return reject(proposal, `Invalid buy amount "${proposal.notional}".`);

    const loss = negate(snapshot.index.dailyChangePct);
    if (compare(loss, limits.dailyLossPausePct) >= 0) {
      return reject(proposal, `Buys are paused for today: the account is down ${loss}% since yesterday's close (limit ${limits.dailyLossPausePct}%).`);
    }

    const ineligible = ineligibleReasons(symbol, snapshot.assets[symbol], limits);
    if (ineligible.length > 0) return { proposal, verdict: "rejected", reasons: ineligible };

    let notional = round(proposal.notional, 2, "down");
    const reasons: string[] = [];
    const limitTo = (room: string, clipped: string, exhausted: string): string | null => {
      if (compare(room, limits.minOrderNotional) < 0) return exhausted;
      if (compare(notional, room) > 0) {
        notional = round(room, 2, "down");
        reasons.push(clipped);
      }
      return null;
    };

    if (!capExempt(symbol, limits)) {
      const cap = pctOf(snapshot.equity, limits.positionCapPct);
      const room = sub(cap, state.marketValue.get(symbol) ?? "0");
      const stopped = limitTo(
        room,
        `Reduced to keep ${symbol} within ${limits.positionCapPct}% of equity ($${cap}).`,
        `${symbol} is already at its ${limits.positionCapPct}% position limit ($${cap}).`,
      );
      if (stopped) return reject(proposal, stopped);
    }

    if (proposal.sleeve === "conviction") {
      const cap = pctOf(snapshot.equity, limits.convictionCapPct);
      const stopped = limitTo(
        sub(cap, state.conviction),
        `Reduced to keep the conviction sleeve within ${limits.convictionCapPct}% of equity ($${cap}).`,
        `The conviction sleeve is already at its ${limits.convictionCapPct}% limit ($${cap}).`,
      );
      if (stopped) return reject(proposal, stopped);
    }

    // Cash held for a withdrawal is as untouchable as the buffer (SPEC-capital).
    const reserved = snapshot.withdrawal.outstanding;
    const cashRoom = sub(sub(sub(snapshot.cash, buffer), reserved), state.plannedBuys);
    const available = round(maxOf(cashRoom, "0"), 2, "down");
    const kept = [
      ...(compare(buffer, "0") > 0 ? [{ keeping: `a $${buffer} buffer`, after: `the $${buffer} buffer` }] : []),
      ...(compare(reserved, "0") > 0 ? [{ keeping: `$${reserved} for your withdrawal`, after: `the $${reserved} held for your withdrawal` }] : []),
    ];
    const cashStop = limitTo(
      cashRoom,
      kept.length ? `Reduced to the cash available ($${available}, keeping ${kept.map((k) => k.keeping).join(" and ")}).` : `Reduced to the cash available ($${available}).`,
      kept.length ? `Not enough cash: $${available} available after ${kept.map((k) => k.after).join(" and ")}.` : `Not enough cash: $${available} available.`,
    );
    if (cashStop) return reject(proposal, cashStop);

    const dailyCap = pctOf(snapshot.equity, limits.maxDailyBuyPctOfEquity);
    const dailyStop = limitTo(
      sub(dailyCap, add(snapshot.today.buyNotional, state.plannedBuys)),
      `Reduced to stay within today's buy limit (${limits.maxDailyBuyPctOfEquity}% of equity, $${dailyCap}).`,
      `Today's buy limit (${limits.maxDailyBuyPctOfEquity}% of equity, $${dailyCap}) has been reached.`,
    );
    if (dailyStop) return reject(proposal, dailyStop);

    state.plannedBuys = add(state.plannedBuys, notional);
    state.marketValue.set(symbol, add(state.marketValue.get(symbol) ?? "0", notional));
    if (proposal.sleeve === "conviction") state.conviction = add(state.conviction, notional);
    state.orders++;
    return { proposal, verdict: reasons.length ? "clipped" : "approved", notional, reasons };
  }
}

function haltMessage(s: RiskSnapshot): string {
  return `Trading is halted: ${s.state.haltReason ?? "drawdown limit reached"}. Only the owner can resume it (risk:resume).`;
}

/**
 * Account-wide stops, in precedence order. Each blocks every order, sells
 * included. The drawdown halt is applied by the caller, after these, since
 * it lets a bounded withdrawal through and these don't.
 */
function accountStop(s: RiskSnapshot, limits: Limits): string | null {
  if (s.state.killSwitch) {
    return `The kill switch is on${s.state.killReason ? ` (${s.state.killReason})` : ""}. Only the owner can turn it off (risk:resume).`;
  }
  if (!s.broker.tradingAllowed) {
    const why = s.broker.blockedReasons.length ? s.broker.blockedReasons.join("; ") : "no verdict recorded";
    return `The broker safety check failed: ${why}.`;
  }
  if (!s.broker.syncedAt) return "Broker data has never been synced.";
  const ageMin = Math.floor((s.now.getTime() - s.broker.syncedAt.getTime()) / 60_000);
  if (ageMin > limits.maxDataAgeMinutes) {
    return `Broker data is ${ageMin} minutes old (limit ${limits.maxDataAgeMinutes}).`;
  }
  return null;
}

function reject(proposal: Proposal, reason: string): Decision {
  return { proposal, verdict: "rejected", reasons: [reason] };
}

function pctOf(value: string, pct: string): string {
  return div(mul(value, pct), "100", 2, "down");
}

function maxOf(a: string, b: string): string {
  return compare(a, b) >= 0 ? a : b;
}

function negate(v: string): string {
  return sub("0", v);
}

function isPositive(v: string): boolean {
  return decimalString.safeParse(v).success && compare(v, "0") > 0;
}
