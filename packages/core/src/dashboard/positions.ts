/**
 * The Positions page (SPEC-dashboard Amendment 3): each holding with its
 * headline, profit or loss since bought, how it compares with VTI, and every
 * way it can end. Database only: the flags come from the same pure check the
 * routine's get_holdings uses (agent/held.ts), fed stored closes, filings,
 * estimates and the earnings calendar. The earnings-day crash flag needs SEC's
 * earnings releases at read time, so it's the routine's, not shown here.
 */
import { asc, desc, eq } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { loadLedger } from "../broker/activities.js";
import type { Bar } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses, brokerAccount, positions, thesisCloses } from "../db/schema.js";
import { compare, div, mul, round, sub } from "../money.js";
import { nextEarnings } from "../agent/earnings-calendar.js";
import { estimatesFor } from "../agent/estimates.js";
import { filingsSince } from "../agent/filings.js";
import { type HeldFlag, heldThesis } from "../agent/held.js";
import { getHoldings } from "../agent/tools.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { activeStrategy } from "../portfolio/store.js";
import type { Thesis } from "../portfolio/strategy.js";
import { STALE_AFTER_MS, averageCost } from "../portfolio/theses.js";
import { marketDate } from "../time.js";
import { type Headline, headlineOf } from "./headlines.js";

const DAY_MS = 86_400_000;

/** Each sell-side flag in plain words (the same flags get_holdings gives the routine). */
export const FLAG_TEXT: Record<HeldFlag, string> = {
  earnings_crash_since_entry: "Fell 10% or more on an earnings day since we bought",
  recent_big_loser: "Down 30% or more over the past year: such stocks kept lagging",
  near_stop: "Close to its stop",
  lagging_vti: "Trailing VTI since we bought",
  insider_selling: "Insiders selling on the open market",
  executive_departure: "A key executive is leaving",
  earnings_soon: "Reports earnings within a week (not a sell signal: a decision to hold through it or not)",
  estimates_falling: "Analysts are cutting their earnings estimates",
};

export interface Exits {
  /** Sold automatically if it closes at or below this. */
  stop: { price: string; belowPct: string };
  /** Re-judged, and sold unless renewed, after this market date. */
  review: { date: string; daysLeft: number } | null;
  /** Unwinds if the strategy isn't resubmitted by then. */
  stale: { date: string; daysLeft: number };
  /** What would make the routine sell before the stop (the thesis's exitIf). */
  exitIf: string[];
  /** Sell-side flags on it now, in plain words. */
  flags: { flag: HeldFlag; text: string }[];
}

const daysUntil = (date: string, now: Date) => Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${marketDate(now)}T00:00:00Z`)) / DAY_MS);

/** Every way a held thesis can end, as figures and plain words. Pure. */
export function exitsFor(input: { thesis: Pick<Thesis, "stopLossPct" | "reviewBy" | "exitIf">; averageCost: string; price: string; reaffirmedAt: Date; flags: HeldFlag[]; now: Date }): Exits {
  const stopPrice = round(mul(input.averageCost, sub("1", div(input.thesis.stopLossPct, "100", 12, "half-even"))), 2, "half-even");
  const belowPct = compare(input.price, "0") > 0 ? round(mul(sub("1", div(stopPrice, input.price, 12, "half-even")), "100"), 2, "half-even") : "0";
  const staleDate = marketDate(new Date(input.reaffirmedAt.getTime() + STALE_AFTER_MS));
  return {
    stop: { price: stopPrice, belowPct },
    review: input.thesis.reviewBy ? { date: input.thesis.reviewBy, daysLeft: daysUntil(input.thesis.reviewBy, input.now) } : null,
    stale: { date: staleDate, daysLeft: daysUntil(staleDate, input.now) },
    exitIf: input.thesis.exitIf ?? [],
    flags: input.flags.map((flag) => ({ flag, text: FLAG_TEXT[flag] })),
  };
}

export interface PositionCard {
  symbol: string;
  value: string;
  weightPct: string;
  /** The thesis's target weight; null for VTI (the idle money). */
  targetPct: string | null;
  thesisId: string | null;
  headline: Headline | null;
  /** Since bought, on the dollars put in (the scorecard's figures for a thesis; the unrealized gain for VTI). */
  pnl: string;
  returnPct: string | null;
  /** The same dollars in VTI over the same days; null for VTI itself. */
  vsVti: { pnl: string; excess: string; excessPct: string } | null;
  exits: Exits | null;
  /** The routine's forecast for the thesis: the chance it beats VTI by the horizon (its review date by default). */
  forecast: { beatVtiPct: number; expectedExcessPct: string; horizon: string | null } | null;
}

const closesAsBars = (rows: { tradingDate: string; close: string }[]): Bar[] => rows.map((r) => ({ t: new Date(`${r.tradingDate}T17:00:00Z`), o: r.close, h: r.close, l: r.close, c: r.close, v: "0" }));

/** Every holding, theses first (by value), then the idle money in VTI. */
export async function positionsView(db: Db, now: Date): Promise<{ equity: string; cards: PositionCard[]; washSaleWindows: Awaited<ReturnType<typeof getHoldings>>["washSaleWindows"] }> {
  const [account] = await db.select({ equity: brokerAccount.equity }).from(brokerAccount).where(eq(brokerAccount.id, 1));
  const equity = account?.equity ?? "0";
  const held = await db.select().from(positions).orderBy(desc(positions.marketValue));
  const active = await activeStrategy(db, now);
  const lots = (await loadLedger(db)).lots.open;
  const card = await loadScorecard(db, now);
  const theses = new Map(active.strategy.conviction.map((t) => [t.symbol, t]));
  const owned = held.filter((p) => theses.has(p.symbol) && lots.some((l) => l.symbol === p.symbol));

  const firstLot = new Map(owned.map((p) => [p.symbol, lots.filter((l) => l.symbol === p.symbol).reduce((a, b) => (b.openedAt < a.openedAt ? b : a))]));
  const [filings, estimates, calendar, vti] = await Promise.all([
    filingsSince(db, new Map([...firstLot].map(([s, l]) => [s, marketDate(l.openedAt)]))),
    estimatesFor(db, owned.map((p) => p.symbol)),
    nextEarnings(db, owned.map((p) => p.symbol), now),
    db.select().from(benchmarkCloses).where(eq(benchmarkCloses.symbol, BENCHMARK)).orderBy(asc(benchmarkCloses.tradingDate)),
  ]);

  const cards: PositionCard[] = [];
  for (const p of held) {
    const weightPct = compare(equity, "0") > 0 ? round(div(mul(p.marketValue, "100"), equity, 12, "half-even"), 2, "half-even") : "0";
    const thesis = theses.get(p.symbol);
    const first = firstLot.get(p.symbol);
    if (thesis && first) {
      const closes = await db.select().from(thesisCloses).where(eq(thesisCloses.symbol, p.symbol)).orderBy(asc(thesisCloses.tradingDate));
      const cost = averageCost(lots, p.symbol) ?? p.avgEntryPrice;
      const held = heldThesis({
        thesis,
        firstLotAt: first.openedAt,
        averageCost: cost,
        price: p.currentPrice,
        bars: closesAsBars(closes),
        vti: closesAsBars(vti),
        releases: null,
        nextEarnings: calendar.next.get(p.symbol) ?? null,
        filings: filings.get(p.symbol) ?? [],
        estimates: estimates.get(p.symbol) ?? null,
        now,
      });
      const row = card.theses.find((r) => r.symbol === p.symbol && r.ending === "open" && r.money);
      cards.push({
        symbol: p.symbol,
        value: p.marketValue,
        weightPct,
        targetPct: thesis.targetWeightPct,
        thesisId: thesis.id,
        headline: headlineOf(thesis),
        pnl: row?.money?.pnl ?? sub(p.marketValue, p.costBasis),
        returnPct: row?.money?.returnPct ?? null,
        vsVti: row?.money ? { pnl: row.money.vtiPnl, excess: row.money.excess, excessPct: row.money.excessPct } : null,
        exits: exitsFor({ thesis, averageCost: cost, price: p.currentPrice, reaffirmedAt: active.reaffirmedAt, flags: held.flags, now }),
        forecast: thesis.forecast ? { beatVtiPct: thesis.forecast.beatVtiPct, expectedExcessPct: thesis.forecast.expectedExcessPct, horizon: thesis.forecast.horizon ?? thesis.reviewBy ?? null } : null,
      });
    } else {
      const gain = sub(p.marketValue, p.costBasis);
      cards.push({
        symbol: p.symbol,
        value: p.marketValue,
        weightPct,
        targetPct: null,
        thesisId: null,
        headline: null,
        pnl: gain,
        returnPct: compare(p.costBasis, "0") > 0 ? round(mul(div(gain, p.costBasis, 12, "half-even"), "100"), 2, "half-even") : null,
        vsVti: null,
        exits: null,
        forecast: null,
      });
    }
  }
  cards.sort((a, b) => (a.thesisId === null ? 1 : 0) - (b.thesisId === null ? 1 : 0) || compare(b.value, a.value));
  const { washSaleWindows } = await getHoldings({ db, now });
  return { equity, cards, washSaleWindows };
}
