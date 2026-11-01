import { add, compare, div, mul, round, sub } from "../money.js";
import type { Sleeve } from "../risk/types.js";
import type { SystematicAllocation } from "./systematic.js";
import type { ThesisState } from "./theses.js";

export interface Target {
  symbol: string;
  sleeve: Sleeve;
  /** Dollars to hold, cents, rounded down. */
  dollars: string;
  /** Why: the thesis id or the systematic rank note. */
  reason: string;
}

export interface TargetSet {
  targets: Target[];
  /** Equity minus risk's cash buffer: what targets may add up to. */
  investable: string;
  /** Dollars deliberately left in cash (trend-filtered slots with no defensive symbol), on top of the buffer. */
  heldAsCash: string;
}

/**
 * Turn a ranking's share-of-sleeve weights (JS numbers) into a decimal
 * string, at a precision far finer than a cent of any real account. This is
 * the only place statistics become money (ADR-009, SPEC-portfolio assumption 1).
 */
export function weightToDecimal(w: number): string {
  if (!Number.isFinite(w) || w < 0) throw new RangeError(`bad weight ${w}`);
  return w.toFixed(10);
}

/**
 * Conviction first, systematic gets the remainder (SPEC-portfolio).
 * Only *active* theses get a target; stopped and stale ones get none, so the
 * planner sells them. Dollar amounts are rounded down to cents, so the sum
 * never exceeds `investable`.
 */
export function buildTargets(states: ThesisState[], systematic: SystematicAllocation, equity: string, cashBuffer: string): TargetSet {
  const investable = compare(equity, cashBuffer) > 0 ? sub(equity, cashBuffer) : "0";
  const targets: Target[] = [];

  let conviction = "0";
  for (const s of states) {
    if (s.state !== "active") continue;
    const dollars = round(div(mul(investable, s.thesis.targetWeightPct), "100", 6, "down"), 2, "down");
    conviction = add(conviction, dollars);
    targets.push({ symbol: s.thesis.symbol, sleeve: "conviction", dollars, reason: `thesis ${s.thesis.id}` });
  }

  const remainder = compare(conviction, investable) >= 0 ? "0" : sub(investable, conviction);
  const notes = new Map<string, string>();
  for (const n of systematic.notes) {
    const sym = n.split(/[ :]/)[0] ?? "";
    if (!notes.has(sym)) notes.set(sym, n);
  }
  for (const [symbol, w] of systematic.weights) {
    const dollars = round(mul(remainder, weightToDecimal(w)), 2, "down");
    if (compare(dollars, "0") <= 0) continue;
    targets.push({ symbol, sleeve: "systematic", dollars, reason: notes.get(symbol) ?? "systematic defensive holding" });
  }

  return { targets, investable, heldAsCash: round(mul(remainder, weightToDecimal(systematic.cash)), 2, "down") };
}
