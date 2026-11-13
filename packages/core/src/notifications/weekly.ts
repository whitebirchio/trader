import { asc, desc, eq, gte, lt } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { benchmarkCloses, strategies, thesisEvents } from "../db/schema.js";
import { compareToBenchmark } from "../portfolio/benchmark.js";
import { loadForecastReport } from "../portfolio/forecasts.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { activeStrategy } from "../portfolio/store.js";
import type { DailyClose } from "../portfolio/systematic.js";
import { buildIndex } from "../risk/equity-index.js";
import { loadIndexInputs, loadSnapshot } from "../risk/gate.js";
import { LIMITS } from "../risk/limits.js";
import { marketDate, weekMonday } from "../time.js";
import type { WeeklyData } from "./compose.js";

/**
 * The Friday letter's data (#38), from existing readers: equity snapshots and
 * VTI's recorded closes for the week, the scorecard, the forecast ledger, the week's strategy
 * versions and thesis events, and the active strategy's review dates. A
 * version whose document (apart from its summary) matches the one before it
 * is a reaffirmation: counted, not listed.
 * Skips until today's after-close snapshot exists, so the week is complete.
 */

const DAY_MS = 86_400_000;
const REVIEW_HORIZON_DAYS = 14;

const withoutSummary = (document: Record<string, unknown>) => JSON.stringify({ ...document, summary: undefined });

/** The first line of a strategy summary (where Claude says what changed and why), trimmed. */
export function headline(summary: string, max = 240): string {
  const line = summary.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export async function weeklyData(db: Db, broker: BrokerAdapter, today: string, at: Date): Promise<WeeklyData | { skip: string }> {
  const weekOf = weekMonday(today);
  const { snapshots, flows } = await loadIndexInputs(db);
  const todays = snapshots.find((s) => s.tradingDate === today);
  if (!todays) return { skip: "waiting for today's after-close equity snapshot" };

  const points = buildIndex(snapshots, flows).points;
  const closes: DailyClose[] = (
    await db.select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close }).from(benchmarkCloses).where(eq(benchmarkCloses.symbol, BENCHMARK)).orderBy(asc(benchmarkCloses.tradingDate))
  ).map((c) => ({ t: new Date(`${c.tradingDate}T12:00:00Z`), c: c.close }));
  const start = [...points].reverse().find((p) => p.tradingDate < weekOf);
  const end = points.find((p) => p.tradingDate === today);
  const week = start && end ? compareToBenchmark([start, end], closes, marketDate) : null;
  const sinceStart = compareToBenchmark(points, closes, marketDate);

  const card = await loadScorecard(db, at);
  const ledger = await loadForecastReport(db, at);
  const resolvedThisWeek = ledger.resolved.filter((r) => r.endDate >= weekOf && r.endDate <= today);
  // Each thesis id's plain summary in the latest version that lists it (#60).
  const plain = new Map<string, string>();
  for (const v of await db.select({ document: strategies.document }).from(strategies).orderBy(asc(strategies.version))) {
    const conviction = (v.document as { conviction?: { id?: unknown; plainSummary?: unknown }[] }).conviction;
    for (const t of Array.isArray(conviction) ? conviction : []) {
      if (typeof t?.id === "string") {
        if (typeof t.plainSummary === "string") plain.set(t.id, t.plainSummary);
        else plain.delete(t.id);
      }
    }
  }
  const inWeek = (d: Date | null) => !!d && marketDate(d) >= weekOf && marketDate(d) <= today;
  const versions = await db.select().from(strategies).where(gte(strategies.createdAt, new Date(Date.parse(`${weekOf}T00:00:00Z`) - DAY_MS)));
  const events = await db.select().from(thesisEvents).where(gte(thesisEvents.at, new Date(Date.parse(`${weekOf}T00:00:00Z`) - DAY_MS)));
  const weekVersions = versions.filter((v) => inWeek(v.createdAt)).sort((a, b) => a.version - b.version);
  const [before] = weekVersions.length
    ? await db.select().from(strategies).where(lt(strategies.version, weekVersions[0]!.version)).orderBy(desc(strategies.version)).limit(1)
    : [];
  const changed = weekVersions.filter((v, i) => {
    const previous = i === 0 ? before : weekVersions[i - 1];
    return !previous || withoutSummary(v.document) !== withoutSummary(previous.document);
  });
  const active = await activeStrategy(db, at);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + REVIEW_HORIZON_DAYS * DAY_MS).toISOString().slice(0, 10);
  const snapshot = await loadSnapshot(db, broker, [], at, LIMITS);

  return {
    weekOf,
    through: today,
    equity: todays.equity,
    week: week ? { portfolioPct: week.portfolioPct, benchmarkPct: week.benchmarkPct } : null,
    sinceStart,
    trackRecord: {
      overall: { theses: card.overall.theses, scored: card.overall.scored, excess: card.overall.excess, excessPct: card.overall.excessPct, beatVtiPct: card.overall.beatVtiPct },
      byKind: card.byKind.map((k) => ({ kind: k.kind, theses: k.theses, excessPct: k.excessPct })),
    },
    forecasts: {
      resolvedThisWeek: resolvedThisWeek.filter((r) => !r.backfilled).length,
      beatThisWeek: resolvedThisWeek.filter((r) => !r.backfilled && r.beat).length,
      backfilledThisWeek: resolvedThisWeek.filter((r) => r.backfilled).length,
      resolved: ledger.overall.resolved,
      skill: ledger.overall.skill,
      tooFewToJudge: ledger.overall.tooFewToJudge,
      baseRatePct: ledger.baseRatePct,
    },
    opened: card.theses
      .filter((r) => inWeek(r.openedAt))
      .map((r) => {
        const id = r.ids.at(-1)!;
        return { symbol: r.symbol, thesisId: id, primaryKind: r.primaryKind, ...(plain.has(id) ? { plainSummary: plain.get(id)! } : {}) };
      }),
    closed: card.theses
      .filter((r) => inWeek(r.closedAt))
      .map((r) => ({ symbol: r.symbol, thesisId: r.ids.at(-1)!, ending: r.ending, excessPct: r.money?.excessPct ?? null, daysHeld: r.daysHeld })),
    strategies: changed.map((v) => ({ version: v.version, authoredBy: v.authoredBy, headline: headline(v.summary) })),
    reaffirmed: weekVersions.length - changed.length,
    exits: events
      .filter((e) => inWeek(e.at))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((e) => ({ kind: e.kind, symbol: e.symbol, thesisId: e.thesisId, reason: e.reason })),
    reviews: active.strategy.conviction
      .filter((t) => t.reviewBy && t.reviewBy > today && t.reviewBy <= horizon)
      .sort((a, b) => a.reviewBy!.localeCompare(b.reviewBy!))
      .map((t) => ({ symbol: t.symbol, thesisId: t.id, reviewBy: t.reviewBy! })),
    state: { killSwitch: snapshot.state.killSwitch, halted: snapshot.state.halted, haltReason: snapshot.state.haltReason, drawdownPct: snapshot.index.drawdownPct },
  };
}
