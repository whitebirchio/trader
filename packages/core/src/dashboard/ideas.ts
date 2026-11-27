/**
 * The Ideas page (SPEC-dashboard Amendment 3): what the routine is watching,
 * what would make each a buy and when it looks again, and how ideas have
 * turned into results. Database only.
 */
import { asc } from "drizzle-orm";
import { readWatchlist } from "../agent/watchlist.js";
import { filingsSince } from "../agent/filings.js";
import type { Db } from "../db/client.js";
import { watchlistNotes } from "../db/schema.js";
import { compare } from "../money.js";
import { type ScorecardRow, loadScorecard } from "../portfolio/scorecard.js";
import { marketDate } from "../time.js";
import { type Headline, firstSentence } from "./headlines.js";
import { type Outcome, type SankeyData, ideaFunnelSankey } from "./sankey.js";

export interface IdeaCard {
  symbol: string;
  headline: Headline;
  /** What would make it a thesis. */
  trigger: string;
  /** Why it's interesting (the fuller note). */
  why: string;
  revisitBy: string;
  daysToRevisit: number;
  due: boolean;
  watchedSince: string;
  /** The routine's forecast for the stock it's passing on: the chance it beats VTI by the horizon. */
  forecast: { beatVtiPct: number; expectedExcessPct: string; horizon: string } | null;
  /** SEC filings since it went on the list. */
  filings: { form: string; filedOn: string; summary: string; url: string }[];
}

/** Within this many points of the same dollars in VTI, an open thesis counts as even: cents of noise don't swing it. */
export const EVEN_WITH_VTI_PTS = "0.5";

/** A scorecard row's result: closed ones by how they ended, open ones by where they stand against VTI now. */
export function outcomeOf(row: Pick<ScorecardRow, "ending" | "money">): Outcome {
  if (row.ending === "open") {
    if (!row.money) return "open";
    const excess = row.money.excessPct;
    if (compare(excess, EVEN_WITH_VTI_PTS) > 0) return "open_ahead";
    if (compare(excess, `-${EVEN_WITH_VTI_PTS}`) < 0) return "open_behind";
    return "open_even";
  }
  if (row.ending === "stopped" || row.ending === "trailing_stopped") return "stopped";
  return row.money && compare(row.money.excess, "0") >= 0 ? "beat" : "lagged";
}

export async function ideasView(db: Db, now: Date): Promise<{ open: IdeaCard[]; funnel: SankeyData }> {
  const { open } = await readWatchlist(db, now);
  const filings = await filingsSince(db, new Map(open.map((e) => [e.symbol, marketDate(new Date(e.watchedSince))])));
  const cards: IdeaCard[] = open.map((e) => ({
    symbol: e.symbol,
    headline: e.headline ? { text: e.headline, fallback: false } : { text: firstSentence(e.why), fallback: true },
    trigger: e.trigger,
    why: e.why,
    revisitBy: e.revisitBy,
    daysToRevisit: e.daysToRevisit,
    due: e.due,
    watchedSince: e.watchedSince,
    forecast: e.forecast,
    filings: (filings.get(e.symbol) ?? []).map((f) => ({ form: f.form, filedOn: f.filedOn, summary: f.summary, url: f.url })),
  }));

  // The funnel, one idea per symbol: every name ever watched, and every thesis that was never on the list.
  const notes = await db.select({ symbol: watchlistNotes.symbol, action: watchlistNotes.action, at: watchlistNotes.at }).from(watchlistNotes).orderBy(asc(watchlistNotes.at));
  const lastNote = new Map(notes.map((n) => [n.symbol, n.action]));
  const card = await loadScorecard(db, now);
  const latestRow = new Map<string, ScorecardRow>();
  for (const r of card.theses) {
    const seen = latestRow.get(r.symbol);
    if (!seen || r.openedAt > seen.openedAt) latestRow.set(r.symbol, r);
  }
  const symbols = new Set([...lastNote.keys(), ...latestRow.keys()]);
  const ideas = [...symbols].map((s) => {
    const row = latestRow.get(s);
    const watched = lastNote.has(s);
    if (row) return { watched, state: "bought" as const, outcome: outcomeOf(row) };
    return { watched, state: lastNote.get(s) === "drop" ? ("dropped" as const) : ("watching" as const) };
  });
  return { open: cards, funnel: ideaFunnelSankey(ideas) };
}
