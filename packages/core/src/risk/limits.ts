/**
 * The owner-set risk limits (SPEC-risk, ADR-003). Code, not data: changing a
 * number is a reviewed PR that runs on paper before it reaches the live account.
 * Claude has no path to these. Ask Scott before changing any of them.
 *
 * Percentages and money are decimal strings (ADR-009).
 */
export const LIMITS = {
  /** Flow-adjusted equity this far below its peak latches a full halt (owner resumes). */
  drawdownHaltPct: "20",
  /** Flow-adjusted equity this far below the prior close pauses buys for the day. */
  dailyLossPausePct: "5",
  /** Reject everything if the last successful broker sync is older than this. */
  maxDataAgeMinutes: 20,

  /** Max position, after the trade, for anything not in BROAD_ETFS. */
  positionCapPct: "20",
  /** Max conviction sleeve exposure after the trade. */
  convictionCapPct: "100",

  /** Buy eligibility. */
  minPrice: "5",
  minAvgDollarVolume: "10000000",
  avgDollarVolumeDays: 20,
  minHistoryDays: 90,
  /** Alpaca margin requirement at or above this marks a leveraged/volatility product. */
  leveragedMarginPct: "50",

  /** Cash kept back from buys: the larger of a floor and a share of equity. */
  cashBufferMin: "5",
  cashBufferPct: "1",

  /** Runaway guard per trading day. */
  maxOrdersPerDay: 40,
  maxDailyBuyPctOfEquity: "100",

  /** Alpaca's minimum notional order. */
  minOrderNotional: "1",

  /**
   * Broad-market funds exempt from the position cap. Owner-maintained; anything
   * not listed (single stocks, sector/thematic/narrow ETFs) is capped.
   */
  broadEtfs: [
    "VTI", "VOO", "SPY", "IVV", "ITOT", "SCHB", "VT",
    "VXUS", "IXUS", "VEA", "VWO", "IEFA", "IEMG",
    "BND", "AGG", "BNDX", "SCHZ",
  ],
} as const;

type Widen<T> = T extends string ? string : T extends number ? number : T extends readonly (infer U)[] ? readonly Widen<U>[] : T;

/** The shape of a limits object: LIMITS itself, or a variant in tests. */
export type Limits = { readonly [K in keyof typeof LIMITS]: Widen<(typeof LIMITS)[K]> };

/** Short, stable fingerprint of the limits, stored with every decision. */
export async function limitsVersion(limits: Limits = LIMITS): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(limits)));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
