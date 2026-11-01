import type { OpenLot } from "../broker/lots.js";
import { add, compare, div, mul, sub } from "../money.js";
import type { Strategy, Thesis } from "./strategy.js";

/** A thesis not reaffirmed in this long unwinds into the systematic sleeve (SPEC-portfolio). */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

export type ThesisState =
  | { state: "active"; thesis: Thesis }
  /** Hit its stop-loss. Sold, and stays stopped: re-entry needs a new thesis id. */
  | { state: "stopped"; thesis: Thesis; reason: string; newlyStopped: boolean; price?: string; averageCost?: string }
  /** Not reaffirmed for 30 days (the research loop may be down). Sold into systematic. */
  | { state: "stale"; thesis: Thesis; reason: string };

export interface ThesisInputs {
  /** The active strategy and when its version was created. Listing a thesis in a version reaffirms it. */
  active: { strategy: Strategy; createdAt: Date };
  /** Thesis ids already recorded as stopped (thesis_events). */
  stoppedIds: ReadonlySet<string>;
  /** Open FIFO lots (broker). */
  lots: OpenLot[];
  /** Latest daily close per symbol (decimal strings). */
  lastClose: Record<string, string>;
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

/**
 * Each active-strategy thesis's state. Precedence: already stopped >
 * stale > stop-loss hit now > active. Staleness comes first because a stale
 * thesis unwinds whatever its price. A stop is only checked on held
 * positions with a known price.
 */
export function thesisStates(input: ThesisInputs): ThesisState[] {
  const age = input.now.getTime() - input.active.createdAt.getTime();
  const stale = age >= STALE_AFTER_MS;
  const days = Math.floor(age / 86_400_000);

  return input.active.strategy.conviction.map((thesis): ThesisState => {
    if (input.stoppedIds.has(thesis.id)) {
      return { state: "stopped", thesis, reason: "stopped out earlier; re-entry needs a new thesis", newlyStopped: false };
    }
    if (stale) {
      return { state: "stale", thesis, reason: `not reaffirmed for ${days} days (limit 30)` };
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
          price,
          averageCost: cost,
          reason: `${thesis.symbol} closed at $${price}, at or below its ${thesis.stopLossPct}% stop ($${stopAt} vs $${cost} average cost)`,
        };
      }
    }
    return { state: "active", thesis };
  });
}
