/**
 * The dashboard charts' time ranges (#59). A range's base is the last data
 * point on or before its start date, so "4 weeks" runs from the close four
 * weeks ago; a range the history doesn't reach is unavailable, not truncated.
 * Pure.
 */

export const OVERVIEW_RANGES = ["4w", "3m", "6m", "ytd", "1y", "all"] as const;
export const THESIS_RANGES = ["4w", "3m", "6m", "1y", "held"] as const;
export type ChartRange = (typeof OVERVIEW_RANGES)[number] | (typeof THESIS_RANGES)[number];

export const RANGE_LABELS: Record<ChartRange, string> = {
  "4w": "4 weeks",
  "3m": "3 months",
  "6m": "6 months",
  ytd: "YTD",
  "1y": "1 year",
  all: "Since start",
  held: "Since first held",
};

/** `value` if it's one of `allowed`, else `fallback` (a bad or missing ?range= falls back quietly). */
export function parseRange<R extends ChartRange>(value: unknown, allowed: readonly R[], fallback: R): R {
  return allowed.includes(value as R) ? (value as R) : fallback;
}

/** `date` (YYYY-MM-DD) minus whole months, clamped to the month's last day. */
function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The calendar date a range starts from, counted back from `end`; `held`
 * starts at `heldFrom`, `all` at the beginning (null).
 */
export function rangeFrom(range: ChartRange, end: string, heldFrom: string | null = null): string | null {
  switch (range) {
    case "4w":
      return new Date(Date.parse(`${end}T00:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10);
    case "3m":
      return monthsBefore(end, 3);
    case "6m":
      return monthsBefore(end, 6);
    case "1y":
      return monthsBefore(end, 12);
    case "ytd":
      return `${Number(end.slice(0, 4)) - 1}-12-31`;
    case "held":
      return heldFrom;
    case "all":
      return null;
  }
}

/**
 * The index of a window's base in ascending `dates`: the last date on or
 * before `from` (0 for no start). null when the history starts after `from`.
 */
export function windowBase(dates: string[], from: string | null): number | null {
  if (dates.length === 0) return null;
  if (from === null) return 0;
  let base: number | null = null;
  for (let i = 0; i < dates.length && dates[i]! <= from; i++) base = i;
  return base;
}

export interface RangeOption {
  range: ChartRange;
  label: string;
  available: boolean;
  /** Why it's unavailable. */
  reason?: string;
}

/** Each range's availability over `dates`. `held` and `all` are always available when there's data. */
export function rangeOptions(ranges: readonly ChartRange[], dates: string[], end: string, heldFrom: string | null = null): RangeOption[] {
  return ranges.map((range) => {
    const always = range === "all" || range === "held";
    const available = dates.length > 0 && (always || windowBase(dates, rangeFrom(range, end, heldFrom)) !== null);
    return {
      range,
      label: RANGE_LABELS[range],
      available,
      ...(available ? {} : { reason: dates.length ? `history starts ${dates[0]}` : "no history yet" }),
    };
  });
}
