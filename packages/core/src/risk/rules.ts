import { add, compare, decimalString, div, mul, round, sub } from "../money.js";
import { ineligibleReasons } from "./eligibility.js";
import type { Limits } from "./limits.js";
import type { Decision, Proposal, RiskSnapshot } from "./types.js";

/**
 * The guardrail engine (SPEC-risk). Pure: the same snapshot, proposals and
 * limits always give the same decisions, so any decision can be replayed from
 * the stored snapshot.
 *
 * Proposals are evaluated in the order given, each consuming cash and cap
 * room, so `portfolio` decides which buys get priority. Account-wide stops
 * (kill switch, halt, broker verdict, stale data) reject everything,
 * sells included (Option A, SPEC-risk resolved question 1). Eligibility and
 * caps apply to buys only, so exits are never blocked by them.
 */
export function evaluateOrders(snapshot: RiskSnapshot, proposals: Proposal[], limits: Limits): Decision[] {
  const stop = accountStop(snapshot, limits);
  if (stop) return proposals.map((proposal) => ({ proposal, verdict: "rejected", reasons: [stop] }));

  const buffer = maxOf(limits.cashBufferMin, pctOf(snapshot.equity, limits.cashBufferPct));
  const state = {
    orders: snapshot.today.orderCount,
    plannedBuys: "0",
    marketValue: new Map(snapshot.holdings.map((h) => [h.symbol, h.marketValue])),
    heldQty: new Map(snapshot.holdings.map((h) => [h.symbol, h.qty])),
    satellite: snapshot.holdings.filter((h) => h.sleeve === "satellite").reduce((sum, h) => add(sum, h.marketValue), "0"),
  };

  return proposals.map((proposal): Decision => {
    if (state.orders >= limits.maxOrdersPerDay) {
      return reject(proposal, `The daily limit of ${limits.maxOrdersPerDay} orders has been reached.`);
    }
    return proposal.side === "sell" ? evaluateSell(proposal) : evaluateBuy(proposal);
  });

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

    const broad = (limits.broadEtfs as readonly string[]).includes(symbol);
    if (!broad) {
      const cap = pctOf(snapshot.equity, limits.positionCapPct);
      const room = sub(cap, state.marketValue.get(symbol) ?? "0");
      const stopped = limitTo(
        room,
        `Reduced to keep ${symbol} within ${limits.positionCapPct}% of equity ($${cap}).`,
        `${symbol} is already at its ${limits.positionCapPct}% position limit ($${cap}).`,
      );
      if (stopped) return reject(proposal, stopped);
    }

    if (proposal.sleeve === "satellite") {
      const cap = pctOf(snapshot.equity, limits.satelliteCapPct);
      const stopped = limitTo(
        sub(cap, state.satellite),
        `Reduced to keep the satellite sleeve within ${limits.satelliteCapPct}% of equity ($${cap}).`,
        `The satellite sleeve is already at its ${limits.satelliteCapPct}% limit ($${cap}).`,
      );
      if (stopped) return reject(proposal, stopped);
    }

    const cashRoom = sub(sub(snapshot.cash, buffer), state.plannedBuys);
    const cashStop = limitTo(
      cashRoom,
      `Reduced to the cash available ($${round(maxOf(cashRoom, "0"), 2, "down")}, keeping a $${buffer} buffer).`,
      `Not enough cash: $${round(maxOf(cashRoom, "0"), 2, "down")} available after the $${buffer} buffer.`,
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
    if (proposal.sleeve === "satellite") state.satellite = add(state.satellite, notional);
    state.orders++;
    return { proposal, verdict: reasons.length ? "clipped" : "approved", notional, reasons };
  }
}

/** Account-wide stops, in precedence order. Each blocks every order, sells included. */
function accountStop(s: RiskSnapshot, limits: Limits): string | null {
  if (s.state.killSwitch) {
    return `The kill switch is on${s.state.killReason ? ` (${s.state.killReason})` : ""}. Only the owner can turn it off (risk:resume).`;
  }
  if (s.state.halted) {
    return `Trading is halted: ${s.state.haltReason ?? "drawdown limit reached"}. Only the owner can resume it (risk:resume).`;
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
