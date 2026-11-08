import type { Bar } from "../broker/port.js";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { add, compare, div, mul } from "../money.js";
import { marketDate } from "../time.js";

/**
 * get_exposure's report (#31): each holding's industry and sector, the
 * sector weights, and how closely the holdings' daily returns move together,
 * so the routine can see when two theses are largely one bet. Informational:
 * risk doesn't use it. Pure. Correlations are statistics, not money, so they
 * use JS numbers; weights stay decimal strings.
 */

/** Daily returns over this many sessions. */
export const CORRELATION_SESSIONS = 60;
/** Fewer common sessions than this and a pair isn't measured. */
export const MIN_COMMON_SESSIONS = 40;
/** At or above this, two names are largely one bet. */
export const ONE_BET_CORRELATION = 0.7;
/** Pairs below this aren't listed. */
export const REPORT_CORRELATION = 0.5;

export const BROAD_MARKET = `Broad market (${BENCHMARK})`;
export const UNCLASSIFIED = "Unclassified";

/** Sector funds have no SIC code: the Select Sector SPDRs, by the sector each tracks. */
export const SECTOR_FUNDS: Record<string, string> = {
  XLB: "Materials",
  XLC: "Communication Services",
  XLE: "Energy",
  XLF: "Financials",
  XLI: "Industrials",
  XLK: "Information Technology",
  XLP: "Consumer Staples",
  XLRE: "Real Estate",
  XLU: "Utilities",
  XLV: "Health Care",
  XLY: "Consumer Discretionary",
};

// SIC code ranges → an approximate GICS-style sector. SIC predates GICS, so a
// few companies land elsewhere than a data vendor would put them (Alphabet is
// "computer services" here, Communication Services in GICS); the SEC
// industry description is reported beside it. First match wins.
const SIC_SECTORS: [number, number, string][] = [
  [100, 999, "Consumer Staples"],
  [1200, 1399, "Energy"],
  [1000, 1499, "Materials"],
  [1500, 1799, "Industrials"],
  [2000, 2199, "Consumer Staples"],
  [2200, 2399, "Consumer Discretionary"],
  [2500, 2599, "Consumer Discretionary"],
  [2400, 2699, "Materials"],
  [2700, 2799, "Communication Services"],
  [2830, 2836, "Health Care"],
  [2840, 2844, "Consumer Staples"],
  [2800, 2899, "Materials"],
  [2900, 2999, "Energy"],
  [3100, 3199, "Consumer Discretionary"],
  [3000, 3399, "Materials"],
  [3400, 3499, "Industrials"],
  [3570, 3579, "Information Technology"],
  [3500, 3599, "Industrials"],
  [3630, 3639, "Consumer Discretionary"],
  [3650, 3652, "Consumer Discretionary"],
  [3660, 3679, "Information Technology"],
  [3600, 3699, "Industrials"],
  [3710, 3716, "Consumer Discretionary"],
  [3750, 3751, "Consumer Discretionary"],
  [3700, 3799, "Industrials"],
  [3840, 3851, "Health Care"],
  [3800, 3899, "Information Technology"],
  [3900, 3999, "Consumer Discretionary"],
  [4000, 4799, "Industrials"],
  [4800, 4899, "Communication Services"],
  [4900, 4999, "Utilities"],
  [5120, 5122, "Health Care"],
  [5140, 5149, "Consumer Staples"],
  [5000, 5199, "Industrials"],
  [5400, 5499, "Consumer Staples"],
  [5912, 5912, "Consumer Staples"],
  [5200, 5999, "Consumer Discretionary"],
  [6500, 6553, "Real Estate"],
  [6798, 6798, "Real Estate"],
  [6000, 6799, "Financials"],
  [7000, 7299, "Consumer Discretionary"],
  [7310, 7319, "Communication Services"],
  [7370, 7379, "Information Technology"],
  [7300, 7399, "Industrials"],
  [7500, 7599, "Consumer Discretionary"],
  [7800, 7899, "Communication Services"],
  [7900, 7999, "Consumer Discretionary"],
  [8000, 8099, "Health Care"],
  [8200, 8299, "Consumer Discretionary"],
  [8700, 8799, "Industrials"],
];

/** An approximate sector for a SIC code; Unclassified without one. */
export function sicSector(sic: string | null): string {
  const code = sic === null ? NaN : Number(sic);
  if (!Number.isInteger(code)) return UNCLASSIFIED;
  return SIC_SECTORS.find(([lo, hi]) => code >= lo && code <= hi)?.[2] ?? UNCLASSIFIED;
}

/** Daily returns by market date over the last `sessions` sessions. */
export function dailyReturns(bars: Bar[], sessions = CORRELATION_SESSIONS): Map<string, number> {
  const recent = bars.slice(-(sessions + 1));
  const out = new Map<string, number>();
  for (let i = 1; i < recent.length; i++) {
    const prev = Number(recent[i - 1]!.c);
    if (prev > 0) out.set(marketDate(recent[i]!.t), Number(recent[i]!.c) / prev - 1);
  }
  return out;
}

/** Pearson correlation over the dates both series share (2 dp); null with too few or no variance. */
export function correlation(a: Map<string, number>, b: Map<string, number>): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, x] of a) {
    const y = b.get(d);
    if (y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < MIN_COMMON_SESSIONS) return null;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}

export interface ExposureInput {
  equity: string;
  holdings: { symbol: string; marketValue: string; thesisId: string | null }[];
  /** Names to measure that aren't held: the routine's candidates and active theses not bought yet. */
  candidates: { symbol: string; thesisId: string | null }[];
  /** SEC's industry per symbol; null where SEC couldn't be read. */
  industries: Map<string, { sic: string | null; description: string | null } | null>;
  bars: Record<string, Bar[]>;
}

export function exposureReport(input: ExposureInput) {
  const notes: string[] = [];
  const classify = (symbol: string) => {
    if (symbol === BENCHMARK) return { sector: BROAD_MARKET, industry: null, sic: null };
    const fund = SECTOR_FUNDS[symbol];
    if (fund) return { sector: fund, industry: "Sector fund", sic: null };
    const i = input.industries.get(symbol);
    if (i === null) notes.push(`Couldn't read SEC for ${symbol}: sector unknown.`);
    return { sector: sicSector(i?.sic ?? null), industry: i?.description ?? null, sic: i?.sic ?? null };
  };
  const weightOf = (value: string) => (compare(input.equity, "0") > 0 ? div(mul(value, "100"), input.equity, 2, "half-even") : "0");

  const holdings = input.holdings.map((h) => ({ symbol: h.symbol, thesisId: h.thesisId, weightPct: weightOf(h.marketValue), ...classify(h.symbol) }));
  const bySector = new Map<string, { value: string; symbols: string[] }>();
  for (const [i, h] of input.holdings.entries()) {
    const s = bySector.get(holdings[i]!.sector) ?? { value: "0", symbols: [] };
    bySector.set(holdings[i]!.sector, { value: add(s.value, h.marketValue), symbols: [...s.symbols, h.symbol] });
  }
  const sectors = [...bySector.entries()]
    .map(([sector, s]) => ({ sector, weightPct: weightOf(s.value), symbols: s.symbols }))
    .sort((a, b) => compare(b.weightPct, a.weightPct));
  const candidates = input.candidates.map((c) => ({ symbol: c.symbol, thesisId: c.thesisId, ...classify(c.symbol) }));

  // Correlations among single names (VTI is the market, reported separately).
  const names = [...holdings, ...candidates].map((h) => h.symbol).filter((s, i, all) => s !== BENCHMARK && all.indexOf(s) === i);
  const returns = new Map(names.map((s) => [s, dailyReturns(input.bars[s] ?? [])]));
  const vti = dailyReturns(input.bars[BENCHMARK] ?? []);
  const unmeasured = names.filter((s) => (returns.get(s)?.size ?? 0) < MIN_COMMON_SESSIONS);
  if (unmeasured.length) notes.push(`Under ${MIN_COMMON_SESSIONS} sessions of prices, so no correlations: ${unmeasured.join(", ")}.`);
  const pairs: { a: string; b: string; correlation: number; oneBet: boolean }[] = [];
  let measured = 0;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const c = correlation(returns.get(names[i]!)!, returns.get(names[j]!)!);
      if (c === null) continue;
      measured++;
      if (c >= REPORT_CORRELATION) pairs.push({ a: names[i]!, b: names[j]!, correlation: c, oneBet: c >= ONE_BET_CORRELATION });
    }
  }
  pairs.sort((x, y) => y.correlation - x.correlation);

  return {
    holdings,
    sectors,
    candidates,
    correlation: {
      sessions: CORRELATION_SESSIONS,
      oneBetAt: ONE_BET_CORRELATION,
      pairsMeasured: measured,
      /** Pairs at or above REPORT_CORRELATION, highest first. */
      pairs,
      vsMarket: names.map((s) => ({ symbol: s, correlation: correlation(returns.get(s)!, vti) })),
    },
    notes,
  };
}
