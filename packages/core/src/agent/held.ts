import type { Bar } from "../broker/port.js";
import { compare, div, mul, round, sub } from "../money.js";
import type { Thesis } from "../portfolio/strategy.js";
import type { EarningsRelease } from "../research/earnings-backtest.js";
import { marketDate } from "../time.js";
import { type CandidateSignals, EARNINGS_CRASH, type LastEarnings, candidateSignals, lastEarnings } from "./candidate.js";
import { EARNINGS_SOON_DAYS, type NextEarnings } from "./earnings-calendar.js";
import type { FilingNote } from "./filings.js";

/**
 * Sell-side signals for each held thesis (exits plan T2), reported by
 * get_holdings so the routine re-judges every position on every run (the
 * owner's direction, 2026-11-10). Informational: code doesn't sell on them.
 * Its exits stay the stop-loss, the review date and staleness.
 */

/** Within this % above its stop, a thesis is flagged near_stop. */
export const NEAR_STOP_PCT = "5";
/** This many points or more behind VTI since entry, a thesis is flagged lagging_vti. */
export const LAGGING_VTI_POINTS = "-10";

/**
 * `earnings_soon` (#30) isn't a sell signal: it marks a report within
 * EARNINGS_SOON_DAYS, to hold, trim or wait through on purpose.
 * `insider_selling` and `executive_departure` (#105) come from SEC filings
 * since the first buy.
 */
export type HeldFlag = "earnings_crash_since_entry" | "recent_big_loser" | "near_stop" | "lagging_vti" | "insider_selling" | "executive_departure" | "earnings_soon";

export interface HeldThesis {
  id: string;
  symbol: string;
  /** The session of the earliest open lot. */
  firstBought: string;
  daysHeld: number;
  /** Close to latest close from the first lot's session, against VTI over the same sessions (%, 2 dp); null without the bars. */
  sinceEntry: { returnPct: string; vtiPct: string; excessPct: string } | null;
  /** The highest close since the first lot's session, and how far the latest close is below it (%, 2 dp). */
  highSinceEntry: { close: string; date: string; belowPct: string } | null;
  /** The stop-loss price from average cost, and how far the price is above it (%, 2 dp). */
  stop: { price: string; abovePct: string };
  /** An earnings reaction whose trading day is on or after the first lot's session. */
  earningsSinceEntry: LastEarnings | null;
  /** The next announced report, from the earnings calendar (#30); null if none is announced yet or the calendar is unavailable. */
  nextEarnings: NextEarnings | null;
  /** SEC filings since the first lot's session, newest first, from the hourly filings check (#105). */
  filings: FilingNote[];
  signals: CandidateSignals;
  flags: HeldFlag[];
}

export interface HeldInput {
  thesis: Thesis;
  firstLotAt: Date;
  averageCost: string;
  price: string;
  /** Over a year of daily bars, for the 12-1 month return. */
  bars: Bar[];
  vti: Bar[];
  /** Null when the filings couldn't be read. */
  releases: EarningsRelease[] | null;
  nextEarnings?: NextEarnings | null;
  /** This symbol's stored filings since the first lot's session (#105). */
  filings?: FilingNote[];
  now: Date;
}

const pct = (a: string, b: string) => round(mul(sub(div(a, b, 12, "half-even"), "1"), "100"), 2, "half-even");

/** The close on `date`, or the first after it; null if none. */
function closeFrom(bars: Bar[], date: string): Bar | null {
  return bars.find((b) => marketDate(b.t) >= date) ?? null;
}

export function heldThesis(input: HeldInput): HeldThesis {
  const { thesis, bars, vti } = input;
  const firstBought = marketDate(input.firstLotAt);
  const since = bars.filter((b) => marketDate(b.t) >= firstBought);
  const last = bars.at(-1);
  const entry = closeFrom(bars, firstBought);
  const vtiEntry = closeFrom(vti, firstBought);
  const vtiLast = vti.at(-1);

  let sinceEntry: HeldThesis["sinceEntry"] = null;
  if (entry && last && vtiEntry && vtiLast && compare(entry.c, "0") > 0 && compare(vtiEntry.c, "0") > 0) {
    const returnPct = pct(last.c, entry.c);
    const vtiPct = pct(vtiLast.c, vtiEntry.c);
    sinceEntry = { returnPct, vtiPct, excessPct: sub(returnPct, vtiPct) };
  }

  let highSinceEntry: HeldThesis["highSinceEntry"] = null;
  if (last && since.length) {
    const high = since.reduce((a, b) => (compare(b.c, a.c) > 0 ? b : a));
    highSinceEntry = { close: high.c, date: marketDate(high.t), belowPct: round(mul(sub("1", div(last.c, high.c, 12, "half-even")), "100"), 2, "half-even") };
  }

  const stopPrice = round(mul(input.averageCost, sub("1", div(thesis.stopLossPct, "100", 6, "half-even"))), 2, "half-even");
  const stop = { price: stopPrice, abovePct: pct(input.price, stopPrice) };

  const signals = candidateSignals(bars, vti, input.releases);
  const latest = input.releases ? lastEarnings(input.releases, bars, vti) : null;
  const earningsSinceEntry = latest && latest.info.reactionDate >= firstBought ? latest.info : null;

  const flags: HeldFlag[] = [];
  if (latest && earningsSinceEntry && latest.reaction <= EARNINGS_CRASH) flags.push("earnings_crash_since_entry");
  if (signals.recentBigLoser) flags.push("recent_big_loser");
  if (compare(stop.abovePct, NEAR_STOP_PCT) <= 0) flags.push("near_stop");
  if (sinceEntry && compare(sinceEntry.excessPct, LAGGING_VTI_POINTS) <= 0) flags.push("lagging_vti");
  const filings = input.filings ?? [];
  if (filings.some((f) => f.sellSignal === "insider_sale")) flags.push("insider_selling");
  if (filings.some((f) => f.sellSignal === "executive_departure")) flags.push("executive_departure");
  const next = input.nextEarnings ?? null;
  if (next && next.inDays <= EARNINGS_SOON_DAYS) flags.push("earnings_soon");

  return {
    id: thesis.id,
    symbol: thesis.symbol,
    firstBought,
    daysHeld: Math.floor((input.now.getTime() - input.firstLotAt.getTime()) / 86_400_000),
    sinceEntry,
    highSinceEntry,
    stop,
    earningsSinceEntry,
    nextEarnings: next,
    filings,
    signals,
    flags,
  };
}
