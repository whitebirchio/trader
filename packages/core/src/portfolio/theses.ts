import type { OpenLot } from "../broker/lots.js";
import { add, compare, div, mul, round, sub } from "../money.js";
import { marketDate } from "../time.js";
import type { Strategy, Thesis } from "./strategy.js";

/** A thesis not reaffirmed in this long unwinds into the systematic sleeve (SPEC-portfolio). */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

/** Which price rule closed a thesis; also the thesis_events kind recorded for it. */
export type StopTrigger = "stopped" | "trailing_stopped" | "took_profit";
/** Every thesis_events kind that closes a thesis id for good. */
export const CLOSING_KINDS: StopTrigger[] = ["stopped", "trailing_stopped", "took_profit"];

export type ThesisState =
  | { state: "active"; thesis: Thesis }
  /**
   * Closed by a price rule: its stop-loss, or (#35) its trailing stop or
   * profit target. Sold, and stays closed: re-entry needs a new thesis id.
   */
  | { state: "stopped"; thesis: Thesis; reason: string; newlyStopped: boolean; trigger?: StopTrigger; price?: string; averageCost?: string }
  /** Not reaffirmed for 30 days (the research loop may be down). Sold into systematic. */
  | { state: "stale"; thesis: Thesis; reason: string }
  /** Past its review date without a later one. Sold into systematic until a version moves the date on. */
  | { state: "overdue"; thesis: Thesis; reason: string };

export interface ThesisInputs {
  /**
   * The active strategy and when its version was created. Listing a thesis in
   * a version reaffirms it, except in a system version: `reaffirmedAt`, when
   * given, is when Claude or the owner last did.
   */
  active: { strategy: Strategy; createdAt: Date; reaffirmedAt?: Date };
  /** Thesis ids already recorded as stopped (thesis_events). */
  stoppedIds: ReadonlySet<string>;
  /** Open FIFO lots (broker). */
  lots: OpenLot[];
  /** Latest daily close per symbol (decimal strings). */
  lastClose: Record<string, string>;
  /**
   * Daily closes per symbol, ascending, back to each thesis's first open lot:
   * what a trailing stop measures its high from. Without them (the read
   * tools), a trailing stop isn't checked; the rebalance always passes them.
   */
  closes?: Record<string, { t: Date; c: string }[]>;
  now: Date;
}

/** Average cost per share of the open lots of `symbol`, or null if none are held. */
export function averageCost(lots: OpenLot[], symbol: string): string | null {
  let qty = "0";
  let basis = "0";
  for (const l of lots) {
    if (l.symbol !== symbol) continue;
    qty = add(qty, l.qty);
    basis = add(basis, l.costBasis);
  }
  return compare(qty, "0") > 0 ? div(basis, qty, 6, "half-even") : null;
}

/** The highest close of `symbol` since its earliest open lot's session; null without lots or closes. */
export function highSinceEntry(lots: OpenLot[], symbol: string, closes: { t: Date; c: string }[] | undefined): string | null {
  const first = lots.filter((l) => l.symbol === symbol).reduce<Date | null>((min, l) => (!min || l.openedAt < min ? l.openedAt : min), null);
  if (!first || !closes) return null;
  const from = marketDate(first);
  let high: string | null = null;
  for (const b of closes) if (marketDate(b.t) >= from && (high === null || compare(b.c, high) > 0)) high = b.c;
  return high;
}

/**
 * Each active-strategy thesis's state. Precedence: already closed > stale >
 * overdue > stop-loss > trailing stop > profit target > active. Staleness and
 * the review date come first because either unwinds a thesis whatever its
 * price. The price rules are only checked on held positions with a known
 * price.
 */
export function thesisStates(input: ThesisInputs): ThesisState[] {
  const age = input.now.getTime() - (input.active.reaffirmedAt ?? input.active.createdAt).getTime();
  const stale = age >= STALE_AFTER_MS;
  const days = Math.floor(age / 86_400_000);
  const today = marketDate(input.now);

  return input.active.strategy.conviction.map((thesis): ThesisState => {
    if (input.stoppedIds.has(thesis.id)) {
      return { state: "stopped", thesis, reason: "closed earlier by a stop or profit target; re-entry needs a new thesis", newlyStopped: false };
    }
    if (stale) {
      return { state: "stale", thesis, reason: `not reaffirmed for ${days} days (limit 30)` };
    }
    if (thesis.reviewBy && today > thesis.reviewBy) {
      return { state: "overdue", thesis, reason: `past its review date (${thesis.reviewBy}) without a later one` };
    }
    const cost = averageCost(input.lots, thesis.symbol);
    const price = input.lastClose[thesis.symbol];
    if (cost && price) {
      const stopAt = mul(cost, sub("1", div(thesis.stopLossPct, "100", 6, "half-even")));
      if (compare(price, stopAt) <= 0) {
        return {
          state: "stopped",
          thesis,
          newlyStopped: true,
          trigger: "stopped",
          price,
          averageCost: cost,
          reason: `${thesis.symbol} closed at $${cents(price)}, at or below its ${thesis.stopLossPct}% stop ($${cents(stopAt)} vs $${cents(cost)} average cost)`,
        };
      }
      const high = thesis.trailingStopPct ? highSinceEntry(input.lots, thesis.symbol, input.closes?.[thesis.symbol]) : null;
      if (thesis.trailingStopPct && high) {
        const trailAt = mul(high, sub("1", div(thesis.trailingStopPct, "100", 6, "half-even")));
        if (compare(price, trailAt) <= 0) {
          return {
            state: "stopped",
            thesis,
            newlyStopped: true,
            trigger: "trailing_stopped",
            price,
            averageCost: cost,
            reason: `${thesis.symbol} closed at $${cents(price)}, at or below its ${thesis.trailingStopPct}% trailing stop ($${cents(trailAt)}, from a high close of $${cents(high)} since it was bought)`,
          };
        }
      }
      if (thesis.takeProfitPct) {
        const targetAt = mul(cost, add("1", div(thesis.takeProfitPct, "100", 6, "half-even")));
        if (compare(price, targetAt) >= 0) {
          return {
            state: "stopped",
            thesis,
            newlyStopped: true,
            trigger: "took_profit",
            price,
            averageCost: cost,
            reason: `${thesis.symbol} closed at $${cents(price)}, at or above its ${thesis.takeProfitPct}% profit target ($${cents(targetAt)} vs $${cents(cost)} average cost)`,
          };
        }
      }
    }
    return { state: "active", thesis };
  });
}

/**
 * The review-date rules a submission must meet (SPEC-portfolio), against the
 * active version and today's market date:
 * 1. a new or changed review date must be after today;
 * 2. a thesis that had a review date keeps one;
 * 3. moving it later needs evidence dated after everything the thesis cited
 *    before (the part of "re-justify" code can check).
 * An unchanged date passes even once it has passed: that thesis just stays
 * overdue, and the rest of the strategy can still be reaffirmed.
 */
export function reviewDateErrors(next: Strategy, active: Strategy, today: string): string[] {
  const before = new Map(active.conviction.map((t) => [t.id, t]));
  const latest = (t: Thesis) => t.evidence.reduce<string | null>((max, e) => (e.asOf && (!max || e.asOf > max) ? e.asOf : max), null);
  const errors: string[] = [];
  next.conviction.forEach((t, i) => {
    const prev = before.get(t.id);
    const at = `conviction[${i}].reviewBy`;
    if (prev?.reviewBy && !t.reviewBy) {
      errors.push(`${at}: thesis "${t.id}" had a review date (${prev.reviewBy}); keep one, and move it later only with fresh evidence`);
      return;
    }
    if (!t.reviewBy || t.reviewBy === prev?.reviewBy) return;
    if (t.reviewBy <= today) errors.push(`${at}: ${t.reviewBy} must be after today (${today})`);
    else if (prev?.reviewBy && t.reviewBy > prev.reviewBy) {
      const was = latest(prev);
      const now = latest(t);
      if (!now || (was && now <= was)) {
        errors.push(`${at}: moving it from ${prev.reviewBy} to ${t.reviewBy} needs new evidence dated after ${was ?? "the thesis's current evidence"} (add a dated source)`);
      }
    }
  });
  return errors;
}

/** Prices in email text: always two decimals ("$49.60", not "$49.6"). Display only. */
function cents(v: string): string {
  const r = round(v, 2, "half-even");
  const [whole, frac = ""] = r.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}
