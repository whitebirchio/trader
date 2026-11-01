import type { SystematicParams } from "./strategy.js";

/**
 * The systematic sleeve's rules (SPEC-portfolio): momentum over a lookback
 * window that skips the most recent days, an optional trend filter, top-N,
 * equal or inverse-volatility weights.
 *
 * These are statistics, not money, so they use JS numbers (SPEC-portfolio
 * assumption 1). Weights only become dollars in targets.ts, as decimal strings.
 */

export interface DailyClose {
  t: Date;
  /** Split- and dividend-adjusted close (decimal string from the broker). */
  c: string;
}

export interface Ranked {
  symbol: string;
  rank: number;
  /** Total return over the window, e.g. 0.18 = +18%. */
  momentum: number;
  aboveTrend: boolean;
  /** Daily log-return standard deviation over volatilityDays. */
  volatility: number;
}

export interface Excluded {
  symbol: string;
  reason: string;
}

export interface Ranking {
  ranked: Ranked[];
  excluded: Excluded[];
}

/** Bars needed for a symbol to be ranked under these params. */
export function requiredHistory(p: SystematicParams): number {
  return Math.max(p.lookbackDays + 1, p.trendFilterDays ?? 0, p.volatilityDays + 1);
}

/**
 * Rank the universe (minus `exclude`, i.e. conviction symbols) by momentum,
 * best first, ties broken alphabetically. Symbols without enough clean history
 * are excluded rather than ranked on partial data.
 */
export function rankUniverse(bars: Record<string, DailyClose[]>, p: SystematicParams, exclude: ReadonlySet<string> = new Set()): Ranking {
  const need = requiredHistory(p);
  const excluded: Excluded[] = [];
  const scored: Omit<Ranked, "rank">[] = [];

  for (const symbol of p.universe) {
    if (exclude.has(symbol)) {
      excluded.push({ symbol, reason: "held as a conviction thesis" });
      continue;
    }
    const closes = (bars[symbol] ?? []).map((b) => Number(b.c));
    if (closes.length < need) {
      excluded.push({ symbol, reason: `only ${closes.length} days of history (needs ${need})` });
      continue;
    }
    if (closes.some((c) => !Number.isFinite(c) || c <= 0)) {
      excluded.push({ symbol, reason: "bad price data" });
      continue;
    }
    const last = closes.length - 1;
    const momentum = closes[last - p.skipRecentDays]! / closes[last - p.lookbackDays]! - 1;
    const aboveTrend = p.trendFilterDays === null || closes[last]! > mean(closes.slice(-p.trendFilterDays));
    scored.push({ symbol, momentum, aboveTrend, volatility: dailyVolatility(closes.slice(-(p.volatilityDays + 1))) });
  }

  scored.sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  return { ranked: scored.map((s, i) => ({ ...s, rank: i + 1 })), excluded };
}

export interface SystematicAllocation {
  /** Symbol → share of the systematic sleeve (0–1). Includes the defensive symbol if used. */
  weights: Map<string, number>;
  /** Share left as cash (trend-filtered slots when `defensive` is null). */
  cash: number;
  /** Why each slot holds what it holds, for the plan record and emails. */
  notes: string[];
}

/**
 * Pick the top N (skipping `skip`, e.g. open wash-sale windows) and weight
 * them. A slot whose pick is below its trend line goes to `defensive` (or
 * cash), keeping that pick's weight. Weights + cash sum to 1. Nothing ranked
 * means all cash.
 */
export function selectSystematic(ranking: Ranking, p: SystematicParams, skip: ReadonlySet<string> = new Set()): SystematicAllocation {
  const notes: string[] = [];
  const eligible: Ranked[] = [];
  for (const r of ranking.ranked) {
    if (eligible.length >= p.topN) break;
    if (skip.has(r.symbol)) {
      notes.push(`${r.symbol} (rank ${r.rank}) skipped: sold at a loss in the last 30 days (wash-sale window)`);
      continue;
    }
    eligible.push(r);
  }
  const weights = new Map<string, number>();
  if (eligible.length === 0) {
    notes.push("Nothing ranked: the systematic sleeve is held as cash");
    return { weights, cash: 1, notes };
  }

  const raw = eligible.map((r) => (p.weighting === "equal" || r.volatility <= 0 ? 1 : 1 / r.volatility));
  const total = raw.reduce((a, b) => a + b, 0);
  let cash = 0;
  eligible.forEach((r, i) => {
    const w = raw[i]! / total;
    if (r.aboveTrend) {
      weights.set(r.symbol, (weights.get(r.symbol) ?? 0) + w);
      notes.push(`${r.symbol}: rank ${r.rank}, ${(r.momentum * 100).toFixed(1)}% momentum`);
    } else if (p.defensive) {
      weights.set(p.defensive, (weights.get(p.defensive) ?? 0) + w);
      notes.push(`${r.symbol} (rank ${r.rank}) is below its ${p.trendFilterDays}-day average, so its slot goes to ${p.defensive}`);
    } else {
      cash += w;
      notes.push(`${r.symbol} (rank ${r.rank}) is below its ${p.trendFilterDays}-day average, so its slot is held as cash`);
    }
  });
  return { weights, cash, notes };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function dailyVolatility(closes: number[]): number {
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const m = mean(returns);
  return Math.sqrt(returns.reduce((a, r) => a + (r - m) ** 2, 0) / Math.max(returns.length - 1, 1));
}
