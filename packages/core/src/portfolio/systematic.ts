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

/**
 * Where money that has nowhere better to go sits (Scott, 2026-11-01): VTI, the
 * benchmark, never idle cash. This is risk capital, and VTI is "idle".
 */
export const IDLE_SYMBOL = "VTI";

export interface SystematicAllocation {
  /** Symbol → share of the systematic sleeve (0–1), summing to 1. May include the defensive symbol and IDLE_SYMBOL. */
  weights: Map<string, number>;
  /** The picks in rank order (what overflow tops up first). */
  picks: Ranked[];
  /** Why each slot holds what it holds, for the plan record and emails. */
  notes: string[];
}

/**
 * Pick the top N (skipping `skip`, e.g. open wash-sale windows, but never
 * IDLE_SYMBOL: idle money goes back into it whatever the ranking says, so
 * skipping it only sells more of it, #81) and weight them. A slot whose pick is below its trend line goes to `defensive`, or to
 * IDLE_SYMBOL if there is none, keeping that pick's weight. Weights sum to 1.
 * Nothing ranked means all IDLE_SYMBOL.
 */
export function selectSystematic(ranking: Ranking, p: SystematicParams, skip: ReadonlySet<string> = new Set()): SystematicAllocation {
  const notes: string[] = [];
  const eligible: Ranked[] = [];
  for (const r of ranking.ranked) {
    if (eligible.length >= p.topN) break;
    if (skip.has(r.symbol) && r.symbol !== IDLE_SYMBOL) {
      notes.push(`${r.symbol} (rank ${r.rank}) skipped: sold at a loss in the last 30 days (wash-sale window)`);
      continue;
    }
    eligible.push(r);
  }
  const weights = new Map<string, number>();
  if (eligible.length === 0) {
    notes.push(`Nothing ranked: the systematic sleeve sits in ${IDLE_SYMBOL}`);
    return { weights: new Map([[IDLE_SYMBOL, 1]]), picks: [], notes };
  }

  const raw = eligible.map((r) => (p.weighting === "equal" || r.volatility <= 0 ? 1 : 1 / r.volatility));
  const total = raw.reduce((a, b) => a + b, 0);
  const add = (symbol: string, w: number) => weights.set(symbol, (weights.get(symbol) ?? 0) + w);
  eligible.forEach((r, i) => {
    const w = raw[i]! / total;
    if (r.aboveTrend) {
      add(r.symbol, w);
      notes.push(`${r.symbol}: rank ${r.rank}, ${(r.momentum * 100).toFixed(1)}% momentum`);
    } else {
      const to = p.defensive ?? IDLE_SYMBOL;
      add(to, w);
      notes.push(`${r.symbol} (rank ${r.rank}) is below its ${p.trendFilterDays}-day average, so its slot goes to ${to}`);
    }
  });
  return { weights, picks: eligible.filter((r) => r.aboveTrend), notes };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function dailyVolatility(closes: number[]): number {
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const m = mean(returns);
  return Math.sqrt(returns.reduce((a, r) => a + (r - m) ** 2, 0) / Math.max(returns.length - 1, 1));
}
