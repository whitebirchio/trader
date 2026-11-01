import { div, mul, sub } from "../money.js";
import type { IndexPoint } from "../risk/equity-index.js";
import type { DailyClose } from "./systematic.js";

/** The benchmark is VTI's total return (adjusted closes), the ETF twin of VTSAX. */
export const BENCHMARK = "VTI";

export interface BenchmarkComparison {
  since: string;
  through: string;
  /** Flow-adjusted portfolio return, e.g. "1.24" = +1.24%. */
  portfolioPct: string;
  benchmarkPct: string;
}

const pct = (end: string, start: string) => div(mul(sub(div(end, start, 12, "half-even"), "1"), "100"), "1", 2, "half-even");

/**
 * Portfolio (the flow-adjusted index, so deposits don't count as returns) vs
 * VTI over the same days, from the first equity snapshot. Null until there are
 * two snapshots and VTI prices to match them.
 */
export function compareToBenchmark(points: IndexPoint[], benchmark: DailyClose[], closeOn: (t: Date) => string): BenchmarkComparison | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || first === last) return null;
  const priceOn = (date: string) => [...benchmark].reverse().find((b) => closeOn(b.t) <= date)?.c;
  const start = priceOn(first.tradingDate);
  const end = priceOn(last.tradingDate);
  if (!start || !end) return null;
  return { since: first.tradingDate, through: last.tradingDate, portfolioPct: pct(last.index, first.index), benchmarkPct: pct(end, start) };
}
