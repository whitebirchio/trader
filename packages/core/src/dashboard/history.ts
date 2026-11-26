/**
 * The History page (SPEC-dashboard Amendment 3): every thesis ever held, with
 * its headline from the last version that listed it, the totals by lead
 * signal, and the signal-to-outcome diagram. Database only.
 */
import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { strategies } from "../db/schema.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { validateStrategy } from "../portfolio/strategy.js";
import { type Headline, headlineOf } from "./headlines.js";
import { outcomeOf } from "./ideas.js";
import { type SankeyData, signalSankey } from "./sankey.js";
import { trackRecordView } from "./views.js";

/** Each thesis id's headline, from the last stored version that listed it. */
export async function thesisHeadlines(db: Db): Promise<Record<string, Headline>> {
  const out: Record<string, Headline> = {};
  for (const v of await db.select({ document: strategies.document }).from(strategies).orderBy(asc(strategies.version))) {
    const parsed = validateStrategy(v.document);
    if (!parsed.ok) continue;
    for (const t of parsed.strategy.conviction) out[t.id] = headlineOf(t);
  }
  return out;
}

export async function historyView(db: Db, now: Date): Promise<{ track: Awaited<ReturnType<typeof trackRecordView>>; headlines: Record<string, Headline>; signal: SankeyData }> {
  const [track, headlines, card] = await Promise.all([trackRecordView(db, now), thesisHeadlines(db), loadScorecard(db, now)]);
  const signal = signalSankey(
    card.theses.map((r) => ({ leadSignal: r.primaryKind ?? "unknown", outcome: outcomeOf(r), pnl: r.money?.pnl ?? "0" })),
  );
  return { track, headlines, signal };
}
