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
  /**
   * After the owner's last resume of a halt (ADR-017): the peak before it, and
   * the base the halt measures from since: the index at the last snapshot
   * before the resume, or any higher one after. Null without a resume, or
   * without a snapshot before it.
   */
  rebase: { since: Date; prePeak: string; base: string } | null;
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

/** Daily index from post-close snapshots (any order) and the ledger's flows; `resumedAt`, the owner's last resume of a halt. */
export function buildIndex(snapshots: DailyEquity[], flows: IndexFlow[], resumedAt: Date | null = null): IndexState {
  const sorted = [...snapshots].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const points: IndexPoint[] = [];
  let peak = "1";
  let last: IndexedSnapshot | null = null;
  let previous: IndexedSnapshot | null = null;
  let prePeak: string | null = null;
  let base: string | null = null;
  for (const s of sorted) {
    const index: string = last ? step(last.index, last.equity, s.equity, flowsBetween(flows, last.recordedAt, s.recordedAt)) : "1";
    points.push({ tradingDate: s.tradingDate, index });
    if (compare(index, peak) > 0) peak = index;
    if (resumedAt && s.recordedAt <= resumedAt) {
      prePeak = peak;
      base = index;
    } else if (base !== null && compare(index, base) > 0) base = index;
    previous = last;
    last = { ...s, index };
  }
  const rebase = resumedAt && prePeak !== null && base !== null ? { since: resumedAt, prePeak, base } : null;
  return { points, peak, rebase, last, previous };
}

export interface LiveIndex {
  /** % below the peak, ≥ 0 ("12.5" = 12.5% down); after a resume, below the rebased level (see `rebased`). */
  drawdownPct: string;
  /** % change vs the prior close, flow-adjusted ("-5.2" = down 5.2%). */
  dailyChangePct: string;
  /**
   * Set while the drawdown is measured from the owner's last resume (ADR-017):
   * until the index regains the peak from before it, the halt trips at
   * limits.reHaltPct below the base instead of drawdownHaltPct below the peak.
   */
  rebased?: { resumedAt: Date; prePeakDrawdownPct: string };
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
  const r = state.rebase;
  if (r) {
    const base = compare(current, r.base) > 0 ? current : r.base;
    // Until the old peak is regained, measure from the base; after that, the all-time peak again.
    if (compare(base, r.prePeak) < 0) {
      return { drawdownPct: pct(sub("1", div(current, base, INDEX_DP, "half-even"))), dailyChangePct, rebased: { resumedAt: r.since, prePeakDrawdownPct: drawdownPct } };
    }
  }
  return { drawdownPct, dailyChangePct };
}

const pct = (fraction: string) => div(mul(fraction, "100"), "1", PCT_DP, "half-even");

/** The drawdown from the all-time peak, whatever the halt measures from (ADR-017). */
export function drawdownFromPeak(index: Pick<LiveIndex, "drawdownPct" | "rebased">): string {
  return index.rebased?.prePeakDrawdownPct ?? index.drawdownPct;
}

/** The halt rule in force, in words: from the peak, or from the owner's last resume until the old peak is regained. */
export function haltRule(index: Pick<LiveIndex, "rebased">, limits: { drawdownHaltPct: string; reHaltPct: string }): string {
  return index.rebased
    ? `halts ${limits.reHaltPct}% below its level when trading resumed on ${marketDate(index.rebased.resumedAt)}, until it regains its old peak; then ${limits.drawdownHaltPct}% below the peak again`
    : `halts ${limits.drawdownHaltPct}% below its peak`;
}
