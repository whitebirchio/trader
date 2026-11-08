import type { Bar } from "../broker/port.js";
import { compare, div, mul, round, sub } from "../money.js";
import type { DailyBar } from "../research/backtest.js";
import { type EarningsRelease, reactionEvent } from "../research/earnings-backtest.js";
import { marketDate } from "../time.js";

/**
 * The per-candidate screens behind the routine's 2026-11-08 rules (#54),
 * reported by check_eligibility so each rule is one tool call. Informational:
 * risk doesn't use them. The thresholds come from the backtests in
 * docs/research/.
 */

/** A 12-1 month return at or below this marks a recent big loser (the backtest's bottom-decile edge, median −31.4%). */
export const RECENT_BIG_LOSER = "-0.30";
/** An earnings-day reaction vs VTI at or below this is a crash (earnings backtest's big-drop bucket). */
export const EARNINGS_CRASH = -0.1;
/** Sessions after an earnings crash in which the routine doesn't buy. */
export const CRASH_WINDOW_SESSIONS = 10;

/** The return from the close 252 sessions back to the close 21 sessions back (a decimal string, 4 dp); null without the history. */
export function momentum12to1(bars: Bar[]): string | null {
  const last = bars.length - 1;
  const from = bars[last - 252];
  const to = bars[last - 21];
  if (!from || !to || compare(from.c, "0") <= 0) return null;
  return round(sub(div(to.c, from.c, 12, "half-even"), "1"), 4, "half-even");
}

export interface LastEarnings {
  filedOn: string;
  /** The first session that could trade on the release. */
  reactionDate: string;
  /** The stock's return minus VTI's that session, % (1 dp). */
  reactionVsVtiPct: string;
  /** Sessions since the reaction day (0 = the latest bar is the reaction day). */
  sessionsSince: number;
}

const daily = (bars: Bar[]): DailyBar[] => bars.map((b) => ({ date: marketDate(b.t), close: Number(b.c), volume: Number(b.v) }));

/** The most recent earnings release with a measurable reaction in the bars, and the raw reaction; null if none. */
export function lastEarnings(releases: EarningsRelease[], bars: Bar[], vti: Bar[]): { info: LastEarnings; reaction: number } | null {
  const stock = daily(bars);
  const benchmark = daily(vti);
  for (const r of [...releases].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))) {
    const e = reactionEvent("", "", r, stock, benchmark);
    if (!e) continue;
    const i = stock.findIndex((b) => b.date === e.reactionDate);
    return { info: { filedOn: r.filedOn, reactionDate: e.reactionDate, reactionVsVtiPct: (e.reaction * 100).toFixed(1), sessionsSince: stock.length - 1 - i }, reaction: e.reaction };
  }
  return null;
}

export interface CandidateSignals {
  momentum12to1Pct: string | null;
  /** 12-1 return at or below −30%: don't buy or add without a dated reason the decline is over. */
  recentBigLoser: boolean | null;
  lastEarnings: LastEarnings | null;
  /** An earnings reaction of −10% or worse within the last 10 sessions: don't buy unless the thesis is that the market got it wrong. */
  freshEarningsCrash: boolean | null;
  notes: string[];
}

/** The screens for one candidate. `releases` is null when the filings couldn't be read. */
export function candidateSignals(bars: Bar[], vti: Bar[], releases: EarningsRelease[] | null): CandidateSignals {
  const m = momentum12to1(bars);
  const notes: string[] = [];
  if (m === null) notes.push("Under a year of price history: no 12-1 month return.");
  let earnings: ReturnType<typeof lastEarnings> = null;
  if (releases === null) notes.push("Couldn't read SEC filings: no earnings reaction (check the latest 8-K item 2.02 yourself).");
  else {
    earnings = lastEarnings(releases, bars, vti);
    if (!earnings) notes.push("No earnings release (8-K item 2.02) found in the price window.");
  }
  return {
    momentum12to1Pct: m === null ? null : round(mul(m, "100"), 1, "half-even"),
    recentBigLoser: m === null ? null : compare(m, RECENT_BIG_LOSER) <= 0,
    lastEarnings: earnings?.info ?? null,
    freshEarningsCrash: earnings ? earnings.reaction <= EARNINGS_CRASH && earnings.info.sessionsSince <= CRASH_WINDOW_SESSIONS : releases === null ? null : false,
    notes,
  };
}
