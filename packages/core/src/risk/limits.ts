/**
 * The owner-set risk limits (SPEC-risk, ADR-003). Code, not data: changing a
 * number is a reviewed PR that runs on paper before it reaches the live account.
 * Claude has no path to these. Ask Scott before changing any of them.
 *
 * Percentages and money are decimal strings (ADR-009).
 */
export const LIMITS = {
  /**
   * Flow-adjusted equity this far below its peak latches a full halt (owner
   * resumes). 30 and 8 (from 20 and 5) by the owner's choice, 2026-11-04: a
   * concentrated book of 5+ names swings more than an index.
   */
  drawdownHaltPct: "30",
  /** Flow-adjusted equity this far below the prior close pauses buys for the day. */
  dailyLossPausePct: "8",
  /** Reject everything if the last successful broker sync is older than this. */
  maxDataAgeMinutes: 20,

  /**
   * Same-day round trips: selling a symbol bought today, or buying back one
   * sold today. Off by the owner's choice (Scott, 2026-11-04): Trader swings,
   * a few trades a week, and never makes a day trade, so the day-trading rules
   * (PDT, or FINRA's intraday margin rule) can't bite. A future day-trading
   * mode turns this on deliberately, with those rules designed in.
   */
  sameDayRoundTrips: false as boolean,

  /** Max position, after the trade, for anything not in BROAD_ETFS. */
  positionCapPct: "20",
  /** Max conviction sleeve exposure after the trade. */
  convictionCapPct: "100",

  /** Buy eligibility. */
  minPrice: "5",
  minAvgDollarVolume: "10000000",
  avgDollarVolumeDays: 20,
  minHistoryDays: 90,
  /**
   * Fund sponsors that specialise in leveraged, inverse and volatility
   * products: a name containing one is blocked whatever the fund is called.
   * Owner-maintained; it blocks some plain funds too (e.g. a ProShares
   * spot-bitcoin ETF), which is the accepted side (SPEC-risk). Replaced
   * Alpaca's margin requirement as the second layer on 2026-11-07 (#33): that
   * number moves with Alpaca's volatility adjustments, and it blocked plain
   * stocks (UPBD, HGV at 50; BRK.B at 75) while passing VXX (30).
   */
  leveragedFundSponsors: [
    "ProShares", "Direxion", "GraniteShares", "Leverage Shares", "Tradr",
    "Defiance", "T-Rex", "REX Shares", "MicroSectors", "Volatility Shares",
  ],

  /**
   * Cash kept back from buys: the larger of a floor and a share of equity.
   * Zero by the owner's choice (2026-11-01): this is risk capital, and idle
   * money sits in VTI, not cash. Notional market buys can't overspend, and
   * Alpaca's fees come out of sell proceeds.
   */
  cashBufferMin: "0",
  cashBufferPct: "0",

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

  /**
   * Treasury-bill funds that behave like cash, also exempt from the position cap,
   * so a defensive (risk-off) move can go all the way (Scott, 2026-11-01). An
   * owner list, not "whatever the strategy calls defensive", or any symbol could
   * escape the cap by being labelled defensive.
   */
  cashEquivalentEtfs: ["SGOV", "BIL", "SHV"],
} as const;

/** Whether `symbol` is exempt from the per-name position cap. */
export function capExempt(symbol: string, limits: Limits): boolean {
  return limits.broadEtfs.includes(symbol) || limits.cashEquivalentEtfs.includes(symbol);
}

type Widen<T> = T extends string ? string : T extends number ? number : T extends readonly (infer U)[] ? readonly Widen<U>[] : T;

/** The shape of a limits object: LIMITS itself, or a variant in tests. */
export type Limits = { readonly [K in keyof typeof LIMITS]: Widen<(typeof LIMITS)[K]> };

/** Short, stable fingerprint of the limits, stored with every decision. */
export async function limitsVersion(limits: Limits = LIMITS): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(limits)));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
