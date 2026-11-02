import { add, compare, div, mul, sub } from "../money.js";
import { marketDate, marketTimeToUtc } from "../time.js";

/**
 * A flow-adjusted (time-weighted) equity index (SPEC-risk assumption 6,
 * SPEC-capital). Each step: index × (equity − flows since the previous
 * snapshot) ÷ previous equity. Adding or withdrawing money moves equity but
 * not the index, so drawdown and daily change measure performance only.
 * `portfolio` reuses it against VTI.
 *
 * Flows are placed by **instant**, not by date: a flow belongs to the first
 * snapshot recorded after it. Alpaca's booking dates fall a day either side
 * of the real transfer, and matching by date could latch a false halt.
 */

const INDEX_DP = 12;
const PCT_DP = 4;

/** A transfer from the capital ledger: signed, positive into the account. */
export interface IndexFlow {
  at: Date;
  amount: string;
}

/** A post-close equity snapshot and the instant its equity was read. */
export interface DailyEquity {
  tradingDate: string;
  equity: string;
  recordedAt: Date;
}

export interface IndexPoint {
  tradingDate: string;
  index: string;
}

interface IndexedSnapshot extends DailyEquity {
  index: string;
}

export interface IndexState {
  points: IndexPoint[];
  /** Highest index value so far (≥ 1 once any point exists). */
  peak: string;
  /** The latest snapshot, and the one before it (today's change after today's snapshot). */
  last: IndexedSnapshot | null;
  previous: IndexedSnapshot | null;
}

/** Net flow with after < at ≤ through (either bound open when null). */
function flowsBetween(flows: IndexFlow[], after: Date | null, through: Date): string {
  let total = "0";
  for (const f of flows) {
    if ((after === null || f.at > after) && f.at <= through) total = add(total, f.amount);
  }
  return total;
}

function step(index: string, prevEquity: string, equity: string, flow: string): string {
  // An empty account (e.g. before the first deposit settles) has no return to
  // measure; carry the index forward.
  if (compare(prevEquity, "0") <= 0) return index;
  return div(mul(index, sub(equity, flow)), prevEquity, INDEX_DP, "half-even");
}

/** Daily index from post-close snapshots (any order) and the ledger's flows. */
export function buildIndex(snapshots: DailyEquity[], flows: IndexFlow[]): IndexState {
  const sorted = [...snapshots].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const points: IndexPoint[] = [];
  let peak = "1";
  let last: IndexedSnapshot | null = null;
  let previous: IndexedSnapshot | null = null;
  for (const s of sorted) {
    const index: string = last ? step(last.index, last.equity, s.equity, flowsBetween(flows, last.recordedAt, s.recordedAt)) : "1";
    points.push({ tradingDate: s.tradingDate, index });
    if (compare(index, peak) > 0) peak = index;
    previous = last;
    last = { ...s, index };
  }
  return { points, peak, last, previous };
}

export interface LiveIndex {
  /** % below the peak, ≥ 0 ("12.5" = 12.5% down). */
  drawdownPct: string;
  /** % change vs the prior close, flow-adjusted ("-5.2" = down 5.2%). */
  dailyChangePct: string;
}

export interface LiveEquity {
  equity: string;
  /** When `equity` was read from the broker. Later flows aren't in it yet. */
  asOf: Date;
  flows: IndexFlow[];
  /** Alpaca's prior-close equity: the daily-change base until a snapshot exists. */
  fallbackPriorClose: string;
}

/**
 * Today's position on the index. Daily change is measured against the latest
 * snapshot from before today (falling back to Alpaca's `last_equity`, with
 * today's flows); drawdown is 0 until there is a snapshot to measure from.
 */
export function liveIndex(state: IndexState, live: LiveEquity): LiveIndex {
  const today = marketDate(live.asOf);
  const base = state.last && state.last.tradingDate < today ? state.last : state.previous;
  const baseEquity = base?.equity ?? live.fallbackPriorClose;
  const since = base?.recordedAt ?? marketTimeToUtc(today, "00:00");
  const dailyChangePct =
    compare(baseEquity, "0") > 0
      ? pct(sub(div(sub(live.equity, flowsBetween(live.flows, since, live.asOf)), baseEquity, INDEX_DP, "half-even"), "1"))
      : "0";

  if (!state.last) return { drawdownPct: "0", dailyChangePct };
  const current =
    state.last.tradingDate === today
      ? state.last.index
      : step(state.last.index, state.last.equity, live.equity, flowsBetween(live.flows, state.last.recordedAt, live.asOf));
  const peak = compare(current, state.peak) > 0 ? current : state.peak;
  const drawdownPct = pct(sub("1", div(current, peak, INDEX_DP, "half-even")));
  return { drawdownPct, dailyChangePct };
}

const pct = (fraction: string) => div(mul(fraction, "100"), "1", PCT_DP, "half-even");
