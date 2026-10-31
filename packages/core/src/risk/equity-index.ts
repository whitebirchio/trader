import { add, compare, div, mul, sub } from "../money.js";
import type { Activity } from "../broker/port.js";
import { marketDate } from "../time.js";

/**
 * A flow-adjusted (time-weighted) equity index (SPEC-risk assumption 6).
 * Each day: index × (close equity − that day's net deposits) ÷ previous close
 * equity. Adding or withdrawing money moves equity but not the index, so
 * drawdown and daily change measure performance only. `portfolio` reuses it
 * against VTI.
 */

/** Cash movements in or out of the account, as opposed to trading results. */
export const FLOW_TYPES = new Set(["CSD", "CSW", "JNLC", "JNLS"]);

const INDEX_DP = 12;
const PCT_DP = 4;

export interface DailyEquity {
  tradingDate: string;
  equity: string;
}

export interface IndexPoint {
  tradingDate: string;
  index: string;
}

export interface IndexState {
  points: IndexPoint[];
  /** Highest index value so far (≥ 1 once any point exists). */
  peak: string;
  last: { tradingDate: string; equity: string; index: string } | null;
}

/** Net external cash flow per market date (deposits positive, withdrawals negative). */
export function flowsByDate(activities: Activity[]): Map<string, string> {
  const flows = new Map<string, string>();
  for (const a of activities) {
    if (!FLOW_TYPES.has(a.type) || a.netAmount === null) continue;
    const date = marketDate(a.at);
    flows.set(date, add(flows.get(date) ?? "0", a.netAmount));
  }
  return flows;
}

function flowsBetween(flows: Map<string, string>, after: string | null, through: string): string {
  let total = "0";
  for (const [date, amount] of flows) {
    if ((after === null || date > after) && date <= through) total = add(total, amount);
  }
  return total;
}

function step(index: string, prevEquity: string, equity: string, flow: string): string {
  // An empty account (e.g. before the first deposit settles) has no return to
  // measure; carry the index forward.
  if (compare(prevEquity, "0") <= 0) return index;
  return div(mul(index, sub(equity, flow)), prevEquity, INDEX_DP, "half-even");
}

/** Daily index from post-close equity snapshots (any order) and the account's flows. */
export function buildIndex(snapshots: DailyEquity[], flows: Map<string, string>): IndexState {
  const sorted = [...snapshots].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const points: IndexPoint[] = [];
  let peak = "1";
  let last: IndexState["last"] = null;
  for (const s of sorted) {
    const index: string = last ? step(last.index, last.equity, s.equity, flowsBetween(flows, last.tradingDate, s.tradingDate)) : "1";
    points.push({ tradingDate: s.tradingDate, index });
    if (compare(index, peak) > 0) peak = index;
    last = { tradingDate: s.tradingDate, equity: s.equity, index };
  }
  return { points, peak, last };
}

export interface LiveIndex {
  /** % below the peak, ≥ 0 ("12.5" = 12.5% down). */
  drawdownPct: string;
  /** % change vs the prior close, flow-adjusted ("-5.2" = down 5.2%). */
  dailyChangePct: string;
}

/**
 * Today's position on the index. `lastEquity` is Alpaca's prior-close equity,
 * so the daily change works even before the first snapshot exists; drawdown is
 * 0 until there is a snapshot to measure from.
 */
export function liveIndex(
  state: IndexState,
  equityNow: string,
  flows: Map<string, string>,
  lastEquity: string,
  today: string,
): LiveIndex {
  const flowsToday = flows.get(today) ?? "0";
  const dailyChangePct =
    compare(lastEquity, "0") > 0
      ? div(mul(sub(div(sub(equityNow, flowsToday), lastEquity, INDEX_DP, "half-even"), "1"), "100"), "1", PCT_DP, "half-even")
      : "0";

  if (!state.last) return { drawdownPct: "0", dailyChangePct };
  const sinceLast = flowsBetween(flows, state.last.tradingDate, today);
  const current = state.last.tradingDate === today ? state.last.index : step(state.last.index, state.last.equity, equityNow, sinceLast);
  const peak = compare(current, state.peak) > 0 ? current : state.peak;
  const drawdownPct = div(mul(sub("1", div(current, peak, INDEX_DP, "half-even")), "100"), "1", PCT_DP, "half-even");
  return { drawdownPct, dailyChangePct };
}
