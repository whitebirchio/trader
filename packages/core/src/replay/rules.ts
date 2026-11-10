import type { Asset } from "../broker/port.js";
import { SYMBOL } from "../portfolio/strategy.js";
import { marketTimeToUtc } from "../time.js";
import type { TimelineVersion } from "./driver.js";
import type { SimMarket } from "./sim-broker.js";

/**
 * A rule-based timeline (#57 T8, mode 2): a strategy written by a fixed rule
 * from the insider-buy data (#29) instead of by Claude, so a rule can be
 * replayed over years Trader never traded.
 *
 * Each week's first session, at 08:15 ET (when the routine runs), the rule
 * writes a version: new clusters of the live pattern (2+ officers or
 * directors buying after a 20%+ drop over the prior 60 sessions) become
 * theses at a fixed weight, stop and review horizon, at most `maxTheses` at a
 * time, most buyers first; the rest sits in VTI. A thesis stays in the
 * document until its review date has passed (the live code unwinds it the
 * day after), so a stopped thesis holds its slot, in VTI, until then.
 * Versions are replayed as stored (raw), as recorded ones are: the live
 * submit check refuses a stopped thesis id, which a rule that can't see
 * stops would keep listing; today's code reads it as stopped either way. No
 * lookahead: a signal is used only once its entry session has closed before
 * the week's session, and it carries no field from after that (the
 * backtest's forward returns are dropped when signals are read).
 */

/** What the rule may know about an insider event: nothing after its entry close. */
export interface InsiderSignal {
  ticker: string;
  /** When the event's last buy became public. */
  lastFiled: string;
  /** The first session after lastFiled: the event and its prior drop are known at its close. */
  entryDate: string;
  /** The stock's return over the 60 sessions before entry; null without the history. */
  prior60: number | null;
  buyers: number;
  /** An officer or director bought (not only 10% owners). */
  insider: boolean;
  dollars: number;
}

export interface InsiderRule {
  weightPct: string;
  stopLossPct: string;
  reviewDays: number;
  maxTheses: number;
  minBuyers: number;
  /** A prior drop this large or worse (−0.2 = 20%). */
  dip: number;
}

export const INSIDER_RULE: InsiderRule = { weightPct: "5", stopLossPct: "15", reviewDays: 90, maxTheses: 8, minBuyers: 2, dip: -0.2 };

/** VTI-only systematic sleeve and drift bands, as production runs today. */
const SYSTEMATIC = { universe: ["VTI"], lookbackDays: 126, skipRecentDays: 21, topN: 1, trendFilterDays: null, weighting: "equal", volatilityDays: 63, defensive: null };
const DRIFT = { relativePct: "20", minTradeUsd: "10" };
const DAY_MS = 86_400_000;

/** Signals from the backtest's scored outcomes (.cache/insider-outcomes.json), keeping only what was known at entry. */
export function insiderSignals(outcomes: unknown[]): InsiderSignal[] {
  return (outcomes as { event: { ticker: string; lastFiled: string; buyers: number; insider: boolean; dollars: number }; entryDate: string; prior60: number | null }[])
    .map((o) => ({ ticker: o.event.ticker, lastFiled: o.event.lastFiled, entryDate: o.entryDate, prior60: o.prior60, buyers: o.event.buyers, insider: o.event.insider, dollars: o.event.dollars }))
    .filter((s) => SYMBOL.test(s.ticker));
}

export function matchesRule(s: InsiderSignal, rule: InsiderRule): boolean {
  return s.insider && s.buyers >= rule.minBuyers && s.prior60 !== null && s.prior60 <= rule.dip;
}

/** The first session of each week (Monday, or the next session in a short week). */
export function weekStarts(sessions: string[]): string[] {
  const week = (d: string) => {
    const t = Date.parse(`${d}T12:00:00Z`);
    return Math.floor((t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS) / DAY_MS);
  };
  return sessions.filter((d, i) => i === 0 || week(d) !== week(sessions[i - 1]!));
}

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const slug = (s: InsiderSignal) => `${s.ticker.toLowerCase().replace(/[^a-z0-9]/g, "-")}-insiders-${s.lastFiled}`;
const usd = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);

interface Held {
  signal: InsiderSignal;
  id: string;
  reviewBy: string;
}

/** One version per week, from the signals whose entry session closed before that week's session. */
export function insiderTimeline(signals: InsiderSignal[], weeks: string[], rule: InsiderRule = INSIDER_RULE): TimelineVersion[] {
  const pattern = signals.filter((s) => matchesRule(s, rule)).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const book = new Map<string, Held>();
  const versions: TimelineVersion[] = [];
  let since = weeks[0] ? plus(weeks[0], -7) : "";
  for (const week of weeks) {
    for (const [ticker, h] of book) if (h.reviewBy < week) book.delete(ticker);
    const fresh = pattern
      .filter((s) => s.entryDate >= since && s.entryDate < week && !book.has(s.ticker))
      .sort((a, b) => b.buyers - a.buyers || b.dollars - a.dollars || a.ticker.localeCompare(b.ticker));
    const added: string[] = [];
    for (const s of fresh) {
      if (book.size >= rule.maxTheses) break;
      if (book.has(s.ticker)) continue; // two events in one ticker the same week: the first
      book.set(s.ticker, { signal: s, id: slug(s), reviewBy: plus(week, rule.reviewDays) });
      added.push(s.ticker);
    }
    since = week;

    const conviction = [...book.values()]
      .sort((a, b) => a.signal.ticker.localeCompare(b.signal.ticker))
      .map((h) => ({
        id: h.id,
        symbol: h.signal.ticker,
        targetWeightPct: rule.weightPct,
        thesis: `Rule: ${h.signal.buyers} officers or directors bought after a ${Math.round(-h.signal.prior60! * 100)}% drop over 60 sessions.`,
        evidence: [{ kind: "insider", summary: `${h.signal.buyers} insiders bought ${usd(h.signal.dollars)}, last filed ${h.signal.lastFiled}`, asOf: h.signal.lastFiled }],
        stopLossPct: rule.stopLossPct,
        reviewBy: h.reviewBy,
      }));
    versions.push({
      at: marketTimeToUtc(week, "08:15"),
      authoredBy: "system",
      raw: true,
      document: {
        summary: `Insider rule, week of ${week}: ${conviction.length} theses${added.length ? `; new: ${added.join(", ")}` : ""}.`,
        conviction,
        systematic: SYSTEMATIC,
        drift: DRIFT,
      },
    });
  }
  return versions;
}

/**
 * Asset records for symbols with bars but no asset, or one Alpaca now lists
 * as inactive or untradable (delisted, renamed or merged since): assumed
 * active, tradable and fractionable, as they were when they traded. Today's
 * record would otherwise refuse every buy for all the years it did trade. A
 * replay of years past needs them; the report says so.
 */
export function assumeListed(market: SimMarket): { market: SimMarket; assumed: string[] } {
  const gone = (a: Asset | undefined) => !a || a.status !== "active" || !a.tradable;
  const assumed = Object.keys(market.bars).filter((s) => gone(market.assets[s]) && (market.bars[s]?.length ?? 0) > 0);
  const assets: Record<string, Asset> = { ...market.assets };
  for (const s of assumed) assets[s] = { symbol: s, name: market.assets[s]?.name ?? s, status: "active", tradable: true, fractionable: true, marginRequirementLong: null };
  return { market: { ...market, assets }, assumed };
}
