import { add, compare, div, mul, round, sub } from "../money.js";
import type { Limits } from "../risk/limits.js";
import type { Sleeve } from "../risk/types.js";
import type { SystematicParams } from "./strategy.js";
import { IDLE_SYMBOL, type Ranking, selectSystematic } from "./systematic.js";
import type { ThesisState } from "./theses.js";

export interface Target {
  symbol: string;
  sleeve: Sleeve;
  /** Dollars to hold, cents, rounded down. */
  dollars: string;
  /** Why: the thesis id, the rank note, or the overflow that put it there. */
  reason: string;
}

export interface TargetSet {
  targets: Target[];
  /** Equity minus risk's cash buffer: what targets add up to (to the cent, rounding aside). */
  investable: string;
  /** How the sleeve was built: rank notes, caps hit, overflow moved. */
  notes: string[];
}

export interface TargetInputs {
  states: ThesisState[];
  ranking: Ranking;
  params: SystematicParams;
  /** Symbols in an open wash-sale window (planner.washSaleWindow). */
  skip: ReadonlySet<string>;
  equity: string;
  limits: Limits;
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

const cents = (v: string) => round(v, 2, "down");
const pctOf = (v: string, pct: string) => round(div(mul(v, pct), "100", 6, "down"), 2, "down");

/**
 * Conviction first, systematic gets the remainder (SPEC-portfolio), and no
 * dollar is left idle (Scott, 2026-11-01):
 *
 * 1. Active theses get their weight of investable equity. Stopped and stale
 *    theses get nothing, so the planner sells them.
 * 2. The remainder follows the systematic weights (top N, trend filter, defensive).
 * 3. A systematic name above risk's per-name cap is held at the cap, and the
 *    excess flows (option 1b): first to the chosen picks still under the
 *    cap, in rank order; then further down the ranking (names above their
 *    trend, outside any wash-sale window), each filled to the cap; then to
 *    IDLE_SYMBOL (VTI), which broad-ETF status exempts from the cap.
 *
 * Dollar amounts are cents, rounded down, so the total never exceeds investable.
 */
export function buildTargets(input: TargetInputs): TargetSet {
  const { limits } = input;
  const buffer = compare(limits.cashBufferMin, pctOf(input.equity, limits.cashBufferPct)) >= 0 ? limits.cashBufferMin : pctOf(input.equity, limits.cashBufferPct);
  const investable = compare(input.equity, buffer) > 0 ? sub(input.equity, buffer) : "0";
  const cap = pctOf(input.equity, limits.positionCapPct);
  const capped = (symbol: string) => !(limits.broadEtfs as readonly string[]).includes(symbol);
  const notes: string[] = [];

  const out = new Map<string, Target>();
  const put = (symbol: string, sleeve: Sleeve, dollars: string, reason: string) => {
    if (compare(dollars, "0") <= 0) return;
    const prev = out.get(symbol);
    out.set(symbol, prev ? { ...prev, dollars: add(prev.dollars, dollars) } : { symbol, sleeve, dollars, reason });
  };

  let conviction = "0";
  for (const s of input.states) {
    if (s.state !== "active") continue;
    const dollars = cents(div(mul(investable, s.thesis.targetWeightPct), "100", 6, "down"));
    conviction = add(conviction, dollars);
    put(s.thesis.symbol, "conviction", dollars, `thesis ${s.thesis.id}`);
  }
  const remainder = compare(conviction, investable) >= 0 ? "0" : sub(investable, conviction);
  if (compare(remainder, "0") <= 0) return { targets: [...out.values()], investable, notes };

  const alloc = selectSystematic(input.ranking, input.params, input.skip);
  notes.push(...alloc.notes);
  const rankNote = new Map(alloc.notes.map((n) => [n.split(/[ :]/)[0] ?? "", n]));

  // 2. Sleeve weights → dollars (cents, down). The rounding remainder joins the overflow.
  const sys = new Map<string, string>();
  for (const [symbol, w] of alloc.weights) sys.set(symbol, cents(mul(remainder, weightToDecimal(w))));
  let overflow = sub(remainder, [...sys.values()].reduce((a, b) => add(a, b), "0"));

  // 3a. Hold capped names at the cap.
  for (const [symbol, dollars] of sys) {
    if (capped(symbol) && compare(dollars, cap) > 0) {
      overflow = add(overflow, sub(dollars, cap));
      sys.set(symbol, cap);
      notes.push(`${symbol} held at $${cap} (the ${limits.positionCapPct}% position limit)`);
    }
  }
  const room = (symbol: string) => (capped(symbol) ? sub(cap, sys.get(symbol) ?? "0") : null); // null = no limit
  const give = (symbol: string, why: string): void => {
    if (compare(overflow, "0") <= 0) return;
    const r = room(symbol);
    const amount = r === null ? overflow : compare(r, overflow) < 0 ? r : overflow;
    if (compare(amount, "0") <= 0) return;
    sys.set(symbol, add(sys.get(symbol) ?? "0", amount));
    overflow = sub(overflow, amount);
    notes.push(`${symbol} +$${cents(amount)} ${why}`);
  };

  // 3b. Top up the chosen picks still under the cap, in rank order.
  for (const p of alloc.picks) give(p.symbol, "from the overflow of capped picks");
  // 3c. Further down the ranking: names above trend, outside wash-sale windows.
  const chosen = new Set(alloc.picks.map((p) => p.symbol));
  for (const r of input.ranking.ranked) {
    if (compare(overflow, "0") <= 0) break;
    if (chosen.has(r.symbol) || !r.aboveTrend || input.skip.has(r.symbol)) continue;
    if (!sys.has(r.symbol)) rankNote.set(r.symbol, `${r.symbol}: rank ${r.rank}, added because higher-ranked picks hit the ${limits.positionCapPct}% position limit`);
    give(r.symbol, `(rank ${r.rank}) from the overflow of capped picks`);
  }
  // 3d. Whatever is left sits in VTI.
  if (compare(overflow, "0") > 0) {
    if (!sys.has(IDLE_SYMBOL)) rankNote.set(IDLE_SYMBOL, `${IDLE_SYMBOL}: holds what no ranked pick could take`);
    give(IDLE_SYMBOL, "(idle money sits in VTI)");
  }

  for (const [symbol, dollars] of sys) put(symbol, "systematic", cents(dollars), rankNote.get(symbol) ?? `${symbol}: systematic holding`);
  return { targets: [...out.values()], investable, notes };
}
