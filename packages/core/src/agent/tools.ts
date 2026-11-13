import { desc, gte, inArray } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { loadLedger } from "../broker/activities.js";
import { type Lots, estimateSale } from "../broker/lots.js";
import { capitalOverview } from "../capital/overview.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { auditEvents, brokerAccount, orders, positions, rebalancePlans, riskState } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { compare, round, sub } from "../money.js";
import { benchmarkSince } from "../portfolio/benchmark.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { WASH_SALE_DAYS, washSaleWindow } from "../portfolio/planner.js";
import { WINDOW_CLOSE, WINDOW_OPEN, runRebalance } from "../portfolio/rebalance.js";
import { type SubmitStrategyResult, activeStrategy, stoppedThesisIds, submissionErrors, submitStrategy } from "../portfolio/store.js";
import { EVIDENCE_KINDS, EXIT_RULES, FORECAST_LIMITS, validateStrategy } from "../portfolio/strategy.js";
import { IDLE_SYMBOL } from "../portfolio/systematic.js";
import { STALE_AFTER_MS, averageCost, thesisStates } from "../portfolio/theses.js";
import { assetFacts, ineligibleReasons } from "../risk/eligibility.js";
import { drawdownFromPeak, haltRule } from "../risk/equity-index.js";
import { loadSnapshot } from "../risk/gate.js";
import { LIMITS, capExempt } from "../risk/limits.js";
import { headline } from "../notifications/weekly.js";
import { marketDate } from "../time.js";
import { candidateSignals } from "./candidate.js";
import { CORRELATION_SESSIONS, SECTOR_FUNDS, exposureReport } from "./exposure.js";
import { type HeldThesis, heldThesis } from "./held.js";
import { EARNINGS_SOON_DAYS, STALE_AFTER_DAYS, nextEarnings } from "./earnings-calendar.js";
import { type UpdateWatchlistResult, WATCHLIST_LIMITS, readWatchlist, updateWatchlist, watchlistSummary } from "./watchlist.js";
import type { FilingsPort } from "./sec.js";
import { ESTIMATES, estimatesFor } from "./estimates.js";
import { FILINGS_LIMITS, filingsSince, filingsStatus } from "./filings.js";
import { LESSON_LIMITS, type Lesson, type RecordLessonsResult, lastListedVersions, latestLessons, lessonFor, recordLessons, rowsDueLessons } from "./lessons.js";

/**
 * The MCP tools' implementations (SPEC-agent), in core so they're tested
 * against PGlite like everything else. Read tools return current state, never
 * cached numbers. The only write is submitStrategy (actor "claude"): there
 * is no order, cancel or kill-switch tool (ADR-011).
 */

export interface ToolDeps {
  db: Db;
  broker: BrokerAdapter;
  env: TradingEnv;
  now: Date;
  /** SEC filings for check_eligibility's earnings screen and get_exposure's industries; without it, both report the gap. */
  filings?: FilingsPort;
}

/** What the DB-only tools need; the dashboard calls them too, with no broker. */
export type DbDeps = Pick<ToolDeps, "db" | "now">;

const MAX_SYMBOLS = 25;

/** Whole calendar days from today's market date to `date` (negative once past). */
function daysUntil(date: string, now: Date): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${marketDate(now)}T00:00:00Z`)) / 86_400_000);
}
const MAX_PRICE_DAYS = 730;

async function holdingsWithLots(db: Db) {
  const lots = (await loadLedger(db)).lots;
  const held = await db.select().from(positions);
  return { lots, held };
}

/** Account, performance, guardrails, strategy, holdings: the first call of every research run. */
export async function getOverview({ db, broker, env, now }: ToolDeps) {
  const snapshot = await loadSnapshot(db, broker, [], now, LIMITS);
  const [state] = await db.select().from(riskState);
  const active = await activeStrategy(db, now);
  const { lots, held } = await holdingsWithLots(db);
  const states = thesisStates({ active, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose: Object.fromEntries(held.map((p) => [p.symbol, p.currentPrice])), now });
  const thesisBySymbol = new Map(states.map((s) => [s.thesis.symbol, s]));
  const session = (await broker.getCalendar(marketDate(now), marketDate(now))).find((d) => d.date === marketDate(now));
  return {
    environment: env,
    asOf: now.toISOString(),
    market: session ? { tradingDay: true, open: session.open.toISOString(), close: session.close.toISOString(), rebalanceWindowEt: `${WINDOW_OPEN}–${WINDOW_CLOSE}` } : { tradingDay: false },
    account: { equity: snapshot.equity, cash: snapshot.cash, todayPct: snapshot.index.dailyChangePct, drawdownFromPeakPct: drawdownFromPeak(snapshot.index), ...(snapshot.index.rebased ? { drawdownSinceResumePct: snapshot.index.drawdownPct } : {}) },
    vsBenchmark: await benchmarkSince(db, broker, now),
    /**
     * Money in and out (SPEC-capital): the money-weighted comparison, transfers since the theses were
     * last reaffirmed, and any open withdrawal (plan its funding by `planBy`). Null before any transfer.
     */
    capital: await capitalOverview(db, snapshot, active.reaffirmedAt),
    guardrails: {
      killSwitch: snapshot.state.killSwitch,
      halted: snapshot.state.halted,
      haltReason: snapshot.state.haltReason,
      haltRule: haltRule(snapshot.index, LIMITS),
      buysPausedToday: state?.buysPausedOn === marketDate(now),
      brokerTradingAllowed: snapshot.broker.tradingAllowed,
      brokerBlockedReasons: snapshot.broker.blockedReasons,
      lastBrokerSync: snapshot.broker.syncedAt?.toISOString() ?? null,
    },
    strategy: { version: active.version, authoredBy: active.authoredBy, createdAt: active.createdAt.toISOString(), summary: active.strategy.summary },
    /** Claude's research watchlist (#32): open names, and those past their revisit date (get_watchlist has the notes). */
    watchlist: await watchlistSummary(db, now),
    holdings: held.map((p) => {
      const t = thesisBySymbol.get(p.symbol);
      return {
        symbol: p.symbol,
        qty: p.qty,
        marketValue: p.marketValue,
        price: p.currentPrice,
        averageCost: p.avgEntryPrice,
        sleeve: t ? "conviction" : "systematic",
        thesis: t ? { id: t.thesis.id, state: t.state, ...(t.state === "active" ? {} : { reason: t.reason }) } : null,
      };
    }),
  };
}

/** The active strategy (or a stored version) with each thesis's live state. */
export async function getStrategy({ db, now }: DbDeps, version?: number) {
  const active = await activeStrategy(db, now);
  if (version !== undefined && version !== active.version) {
    return { error: `Only the active strategy (v${active.version}) is served; history is in get_activity.` };
  }
  const { lots, held } = await holdingsWithLots(db);
  const states = thesisStates({ active, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose: Object.fromEntries(held.map((p) => [p.symbol, p.currentPrice])), now });
  const daysSince = Math.floor((now.getTime() - active.reaffirmedAt.getTime()) / 86_400_000);
  return {
    version: active.version,
    authoredBy: active.authoredBy,
    createdAt: active.createdAt.toISOString(),
    daysSinceReaffirmed: daysSince,
    staleAfterDays: STALE_AFTER_MS / 86_400_000,
    document: active.strategy,
    theses: states.map((s) => ({
      id: s.thesis.id,
      symbol: s.thesis.symbol,
      state: s.state,
      ...(s.state === "active" ? {} : { reason: s.reason }),
      ...(s.thesis.reviewBy ? { reviewBy: s.thesis.reviewBy, daysToReview: daysUntil(s.thesis.reviewBy, now) } : {}),
    })),
  };
}

/**
 * Each held thesis's sell-side signals (exits plan T2): how it has done since
 * entry against VTI, how far it is off its high and above its stop, the
 * candidate screens, and flags. Theses of the active strategy with open lots.
 */
async function heldTheses(db: Db, broker: BrokerAdapter, filings: FilingsPort | undefined, lots: Lots, held: { symbol: string; currentPrice: string }[], now: Date): Promise<HeldThesis[]> {
  const active = await activeStrategy(db, now);
  const price = new Map(held.map((p) => [p.symbol, p.currentPrice]));
  const owned = active.strategy.conviction.filter((t) => price.has(t.symbol) && lots.open.some((l) => l.symbol === t.symbol));
  if (!owned.length) return [];
  const calendar = await nextEarnings(db, owned.map((t) => t.symbol), now);
  // Over a year of sessions, for the 12-1 month return, as check_eligibility.
  const bars = await broker.getDailyBars([...new Set([...owned.map((t) => t.symbol), BENCHMARK])], new Date(now.getTime() - 400 * 86_400_000), now);
  const firstLot = new Map(owned.map((t) => [t.symbol, lots.open.filter((l) => l.symbol === t.symbol).reduce((a, b) => (b.openedAt < a.openedAt ? b : a))]));
  const recentFilings = await filingsSince(db, new Map([...firstLot].map(([s, l]) => [s, marketDate(l.openedAt)])));
  const estimates = await estimatesFor(db, owned.map((t) => t.symbol));
  const out: HeldThesis[] = [];
  for (const thesis of owned) {
    const first = firstLot.get(thesis.symbol)!;
    out.push(
      heldThesis({
        thesis,
        firstLotAt: first.openedAt,
        averageCost: averageCost(lots.open, thesis.symbol)!,
        price: price.get(thesis.symbol)!,
        bars: bars[thesis.symbol] ?? [],
        vti: bars[BENCHMARK] ?? [],
        // One at a time: SEC asks for at most 10 requests a second.
        releases: filings ? await filings.earningsReleases(thesis.symbol) : null,
        nextEarnings: calendar.next.get(thesis.symbol) ?? null,
        filings: recentFilings.get(thesis.symbol) ?? [],
        estimates: estimates.get(thesis.symbol) ?? null,
        now,
      }),
    );
  }
  return out;
}

/** What a missing or stale earnings calendar means, for the tools that read it. */
function calendarNote(asOf: string | null): string {
  return asOf === null
    ? "No earnings calendar yet (the earnings-calendar job needs an Alpha Vantage key): check report dates yourself."
    : `The earnings calendar is from ${asOf}, more than a few days old: confirm report dates yourself.`;
}

/** The earnings calendar's age, for get_holdings (#30). */
async function calendarStatus(db: Db, now: Date): Promise<{ asOf: string | null; stale: boolean; note?: string }> {
  const { asOf, stale } = await nextEarnings(db, [], now);
  return { asOf, stale, ...(asOf === null || stale ? { note: calendarNote(asOf) } : {}) };
}

/** Positions, lots, wash-sale windows, stopped thesis ids and, given the broker, each held thesis's signals. */
export async function getHoldings({ db, now, broker, filings }: DbDeps & Partial<Pick<ToolDeps, "broker" | "filings">>) {
  const { lots, held } = await holdingsWithLots(db);
  const windowSymbols = washSaleWindow(lots.closed, now);
  const since = now.getTime() - WASH_SALE_DAYS * 86_400_000;
  return {
    positions: held.map((p) => ({ symbol: p.symbol, qty: p.qty, marketValue: p.marketValue, price: p.currentPrice, costBasis: p.costBasis })),
    ...(broker ? { theses: await heldTheses(db, broker, filings, lots, held, now), earningsCalendar: await calendarStatus(db, now), filingsCheck: await filingsStatus(db, now) } : {}),
    lots: lots.open.map((l) => ({ symbol: l.symbol, qty: l.qty, costBasis: l.costBasis, openedAt: l.openedAt.toISOString() })),
    washSaleWindows: lots.closed
      .filter((c) => windowSymbols.has(c.symbol) && compare(c.gain, "0") < 0 && c.closedAt.getTime() >= since)
      .map((c) => ({
        symbol: c.symbol,
        loss: c.gain,
        soldAt: c.closedAt.toISOString(),
        windowEnds: new Date(c.closedAt.getTime() + WASH_SALE_DAYS * 86_400_000).toISOString().slice(0, 10),
      })),
    stoppedThesisIds: [...(await stoppedThesisIds(db))].sort(),
    lotIssues: lots.issues,
  };
}

const ACTIVITY_KINDS = [
  "order.submitted", "order.filled", "order.partially_filled", "order.canceled", "order.rejected", "order.external",
  "risk.order_clipped", "risk.order_rejected", "risk.halted", "risk.kill_switch_on", "risk.resumed", "risk.buys_paused",
  "strategy.activated", "strategy.rejected", "thesis.stopped_out", "thesis.took_profit", "thesis.stale", "thesis.review_overdue",
  "rebalance.buys_funded",
];

type StoredTrade = { proposal?: { side?: string; symbol?: string; sleeve?: string; notional?: string; qty?: string }; reason?: string; verdict?: string; reasons?: string[]; submitted?: string };

export interface ActivityTrade {
  side?: string;
  symbol?: string;
  sleeve?: string;
  notional?: string;
  qty?: string;
  reason?: string;
  verdict?: string;
  reasons?: string[];
  submitted?: string;
}

/** One line's worth of a planned trade; risk's reasons only when it clipped or rejected the trade. */
function tradeLine(t: StoredTrade): ActivityTrade {
  const p = t.proposal ?? {};
  return {
    side: p.side,
    symbol: p.symbol,
    sleeve: p.sleeve,
    ...(p.notional ? { notional: p.notional } : { qty: p.qty }),
    reason: t.reason,
    verdict: t.verdict,
    ...(t.verdict && t.verdict !== "approved" ? { reasons: t.reasons } : {}),
    submitted: t.submitted,
  };
}

/** An activation names the version and the summary's first line: the full document is get_strategy's. */
function eventPayload(kind: string, payload: unknown): unknown {
  if (kind !== "strategy.activated" || !payload || typeof payload !== "object") return payload;
  const { version, authoredBy, summary, theses, convictionPct } = payload as Record<string, unknown>;
  return { version, authoredBy, headline: typeof summary === "string" ? headline(summary) : undefined, theses, convictionPct };
}

/**
 * What happened recently: rebalance steps that traded, fills, risk decisions,
 * strategy submissions. Kept short for the routine's tool-output limit (#74):
 * steps that planned nothing are counted, not listed, with their notes (why
 * buys are waiting, say) once each.
 */
export async function getActivity({ db, now }: DbDeps, days = 14) {
  const since = new Date(now.getTime() - Math.min(Math.max(days, 1), 90) * 86_400_000);
  const events = await db
    .select()
    .from(auditEvents)
    .where(inArray(auditEvents.kind, ACTIVITY_KINDS))
    .orderBy(desc(auditEvents.at))
    .limit(200);
  const plans = await db.select().from(rebalancePlans).where(gte(rebalancePlans.createdAt, since)).orderBy(desc(rebalancePlans.createdAt)).limit(50);
  const recentOrders = await db.select().from(orders).where(gte(orders.createdAt, since)).orderBy(desc(orders.createdAt)).limit(100);
  const traded = plans.filter((p) => p.trades.length > 0);
  return {
    since: since.toISOString(),
    rebalanceSteps: traded.map((p) => ({ at: p.createdAt.toISOString(), strategyVersion: p.strategyVersion, phase: p.phase, trades: (p.trades as StoredTrade[]).map(tradeLine), notes: p.notes })),
    quietSteps: { count: plans.length - traded.length, notes: [...new Set(plans.filter((p) => p.trades.length === 0).flatMap((p) => p.notes))] },
    orders: recentOrders.map((o) => ({ at: o.createdAt.toISOString(), symbol: o.symbol, side: o.side, notional: o.notional, qty: o.qty, status: o.status, filledQty: o.filledQty, filledAvgPrice: o.filledAvgPrice, strategyRef: o.strategyRef, rejectReason: o.rejectReason })),
    events: events.filter((e) => e.at >= since).map((e) => ({ at: e.at.toISOString(), kind: e.kind, actor: e.actor, subject: e.subject, payload: eventPayload(e.kind, e.payload) })),
  };
}

/**
 * Every thesis ever held: its return on the dollars bought vs the same dollars
 * held in VTI, rolled up overall and by primary evidence kind (SPEC-portfolio § Scorecard).
 */
export async function getTrackRecord({ db, now }: DbDeps) {
  const [card, lessons] = await Promise.all([loadScorecard(db, now), latestLessons(db)]);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const due = rowsDueLessons(card.theses, lessons);
  const listedIn = await lastListedVersions(db, due.flatMap((r) => r.ids));
  const lessonView = (l: Lesson | null) => (l ? { thesisId: l.thesisId, expected: l.expected, happened: l.happened, lesson: l.lesson, outcome: l.outcome, at: l.at } : null);
  return {
    markedAt: iso(card.markedAt),
    overall: card.overall,
    byKind: card.byKind,
    /** Closed theses without a post-mortem (#28): write one with record_lesson. `lastVersion` is the last strategy version listing it, for get_strategy. */
    lessonsDue: due.map((r) => ({
      thesisId: r.ids.at(-1)!,
      ids: r.ids,
      symbol: r.symbol,
      primaryKind: r.primaryKind,
      ending: r.ending,
      closedAt: iso(r.closedAt),
      lastVersion: Math.max(0, ...r.ids.map((id) => listedIn.get(id) ?? 0)) || null,
    })),
    theses: card.theses.map((r) => ({
      ids: r.ids,
      symbol: r.symbol,
      primaryKind: r.primaryKind,
      kinds: r.kinds,
      ending: r.ending,
      openedAt: iso(r.openedAt),
      leftAt: iso(r.leftAt),
      closedAt: iso(r.closedAt),
      daysHeld: r.daysHeld,
      qty: r.qty,
      ...(r.money ?? { unscored: r.unscored }),
      ...(r.closedAt ? { lesson: lessonView(lessonFor(r, lessons)) } : {}),
    })),
  };
}

function cleanSymbols(symbols: string[]): { ok: string[]; error?: string } {
  const ok = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter((s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s));
  if (ok.length === 0) return { ok, error: "Give at least one ticker, like AAPL or VTI." };
  if (ok.length > MAX_SYMBOLS) return { ok, error: `At most ${MAX_SYMBOLS} symbols per call.` };
  return { ok };
}

/** Daily adjusted bars for Claude's own analysis. */
export async function getPrices({ broker, now }: ToolDeps, symbols: string[], days = 365) {
  const { ok, error } = cleanSymbols(symbols);
  if (error) return { error };
  const span = Math.min(Math.max(days, 5), MAX_PRICE_DAYS);
  const bars = await broker.getDailyBars(ok, new Date(now.getTime() - span * 86_400_000), now);
  return Object.fromEntries(ok.map((s) => [s, (bars[s] ?? []).map((b) => ({ date: marketDate(b.t), close: b.c, volume: b.v }))]));
}

/** risk's verdict on buying each symbol, so a strategy doesn't propose what will be rejected. */
export async function checkEligibility({ db, broker, now, filings }: ToolDeps, symbols: string[]) {
  const { ok, error } = cleanSymbols(symbols);
  if (error) return { error };
  const [calendar, lessons] = await Promise.all([nextEarnings(db, ok, now), latestLessons(db)]);
  // Over a year of sessions, for the 12-1 month return; VTI for the earnings reaction.
  const bars = await broker.getDailyBars([...new Set([...ok, BENCHMARK])], new Date(now.getTime() - 400 * 86_400_000), now);
  const out = [];
  for (const symbol of ok) {
    const facts = assetFacts(symbol, await broker.getAsset(symbol), bars[symbol] ?? [], now, LIMITS);
    const reasons = ineligibleReasons(symbol, facts, LIMITS);
    const releases = filings ? await filings.earningsReleases(symbol) : null;
    out.push({
      symbol,
      eligible: reasons.length === 0,
      reasons,
      capExempt: capExempt(symbol, LIMITS),
      lastClose: facts?.lastClose ?? null,
      signals: candidateSignals(bars[symbol] ?? [], bars[BENCHMARK] ?? [], releases),
      /** The next announced report (#30); null if none is announced yet, or the calendar is unavailable (see calendarNote). */
      nextEarnings: calendar.next.get(symbol) ?? null,
      ...(calendar.asOf === null || calendar.stale ? { calendarNote: calendarNote(calendar.asOf) } : {}),
      /** Post-mortems on past theses in this symbol (#28), newest first. */
      pastLessons: lessons
        .filter((l) => l.symbol === symbol)
        .slice(0, LESSON_LIMITS.perSymbol)
        .map((l) => ({ thesisId: l.thesisId, ending: l.ending, primaryKind: l.primaryKind, excessPct: l.outcome.excessPct, daysHeld: l.outcome.daysHeld, lesson: l.lesson, at: l.at })),
    });
  }
  return out;
}

/**
 * How concentrated the account is (#31): each holding's industry and sector,
 * the sector weights, and which names move together. Active theses not bought
 * yet and the given candidates are measured alongside, so a draft can be
 * checked before it's submitted.
 */
export async function getExposure({ db, broker, now, filings }: ToolDeps, candidates: string[] = []) {
  const extra: { ok: string[]; error?: string } = candidates.length ? cleanSymbols(candidates) : { ok: [] };
  if (extra.error) return { error: extra.error };
  const [account] = await db.select({ equity: brokerAccount.equity }).from(brokerAccount);
  const held = await db.select().from(positions).orderBy(desc(positions.marketValue));
  const active = await activeStrategy(db, now);
  const thesisOf = new Map(active.strategy.conviction.map((t) => [t.symbol, t.id]));
  const heldSymbols = new Set(held.map((p) => p.symbol));
  const others = [...new Set([...active.strategy.conviction.map((t) => t.symbol), ...extra.ok])].filter((s) => !heldSymbols.has(s));
  const symbols = [...heldSymbols, ...others];

  // Calendar days for CORRELATION_SESSIONS sessions, with room for holidays.
  const bars = await broker.getDailyBars([...new Set([...symbols, BENCHMARK])], new Date(now.getTime() - (CORRELATION_SESSIONS * 1.6 + 10) * 86_400_000), now);
  const industries = new Map<string, { sic: string | null; description: string | null } | null>();
  // One at a time: SEC asks for at most 10 requests a second.
  for (const s of symbols) if (s !== BENCHMARK && !SECTOR_FUNDS[s]) industries.set(s, filings ? await filings.industry(s) : null);

  return {
    asOf: now.toISOString(),
    ...exposureReport({
      equity: account?.equity ?? "0",
      holdings: held.map((p) => ({ symbol: p.symbol, marketValue: p.marketValue, thesisId: thesisOf.get(p.symbol) ?? null })),
      candidates: others.map((s) => ({ symbol: s, thesisId: thesisOf.get(s) ?? null })),
      industries,
      bars,
    }),
  };
}

/** The contract strategies are written against. */
export function getRules() {
  return {
    strategySchema: {
      conviction: `Theses: id (lowercase slug; a stopped id can never be reused), symbol, targetWeightPct (0 < w ≤ ${LIMITS.positionCapPct}, % of equity), thesis (prose), evidence (≥ 1; kinds: ${EVIDENCE_KINDS.join(", ")}), stopLossPct (5–50, required), reviewBy (optional YYYY-MM-DD; see lifecycle), plainSummary (optional, 20–600 characters: the thesis in plain language for the owner; write one for every thesis), bearCase (40–1,200 characters: the strongest case against the thesis right now and why it doesn't win; required on a new thesis or a raised weight, and preview_strategy warns about any thesis without one), leadSignal (required: one of the evidence kinds, the signal that surfaced the idea and carries the case, not the first or most frequent item; it must match an evidence item, and the track record rolls up by it), forecast (required: { beatVtiPct: whole percent ${FORECAST_LIMITS.minBeatVtiPct}–${FORECAST_LIMITS.maxBeatVtiPct}, the chance the stock beats VTI from now to the horizon; expectedExcessPct: ${FORECAST_LIMITS.minExcessPct} to ${FORECAST_LIMITS.maxExcessPct}, the expected return against VTI in points; horizon: optional YYYY-MM-DD, defaulting to reviewBy and no later than it; a new or changed horizon must be after today }. Only each thesis's first forecast is scored, against the stock's price vs VTI's whatever the trades did; later versions restate it). Total ≤ 100%.`,
      systematic: "universe (1–100 symbols), lookbackDays (21–252), skipRecentDays (0–21, < lookback), topN (1–20, ≤ universe), trendFilterDays (50–250 or null), weighting (equal | inverse_volatility), volatilityDays (20–126), defensive (symbol or null).",
      drift: "relativePct (1–100), minTradeUsd (1–1000): a holding is traded back to target only when off by more than max(relativePct × target, minTradeUsd).",
    },
    allocation: [
      "Conviction theses get their weight of equity first; the systematic sleeve gets the rest.",
      `A systematic name over the ${LIMITS.positionCapPct}% per-name cap is held at the cap; the excess goes down the ranking, then to ${IDLE_SYMBOL}. topN means at least N names.`,
      `Idle money sits in ${IDLE_SYMBOL}, never cash (no cash buffer). Trend-filtered slots go to 'defensive', or ${IDLE_SYMBOL}.`,
      "Systematic picks sold at a loss in the last 30 days are skipped (wash sales), except VTI, where idle money sits; conviction buys are not, so weigh them yourself.",
      `Owner's direction (2026-11-04): no systematic momentum sleeve. Set systematic to idle-only, universe ["${IDLE_SYMBOL}"], topN 1, trendFilterDays null, weighting equal, defensive null, so everything not in a thesis sits in ${IDLE_SYMBOL}.`,
      `A new or larger thesis is funded by selling what's over target (usually ${IDLE_SYMBOL}), however small the gap, so a fully invested account can always buy it.`,
      "So is a systematic buy the spare cash can't cover. Each time, get_activity shows a rebalance.buys_funded event: a sign the allocation may want a fresh look as a whole at your next run.",
    ],
    lifecycle: [
      "A thesis whose price closes at or below average cost × (1 − stopLossPct) is sold and stays stopped; re-entry needs a new id.",
      `A thesis not resubmitted for ${STALE_AFTER_MS / 86_400_000} days unwinds into the systematic sleeve. Resubmitting the strategy reaffirms every thesis in it.`,
      "reviewBy (optional, YYYY-MM-DD): the last market date a thesis stands without review. After it the thesis is overdue and unwinds into the systematic sleeve; resubmitting unchanged doesn't bring it back. A new or changed reviewBy must be after today; once a thesis has one it must keep one; and moving it later needs an evidence item dated (asOf) after every evidence date the thesis had before. preview_strategy reports these errors.",
    ],
    risk: {
      positionCapPct: LIMITS.positionCapPct,
      capExempt: { broadEtfs: LIMITS.broadEtfs, cashEquivalents: LIMITS.cashEquivalentEtfs },
      eligibility: `No leveraged/inverse funds, nothing under $${LIMITS.minPrice}, under $${LIMITS.minAvgDollarVolume}/day traded, under ${LIMITS.minHistoryDays} days listed, or non-fractionable.`,
      drawdownHaltPct: LIMITS.drawdownHaltPct,
      dailyLossPausePct: LIMITS.dailyLossPausePct,
      sameDayRoundTrips: LIMITS.sameDayRoundTrips
        ? "allowed"
        : "off: nothing bought today is sold today, and nothing sold today is bought back today (no day trades). Such a trade waits for the next trading day; a thesis bought today and stopped out today is sold tomorrow.",
      note: "Limits are owner-set; strategies can't change them. The kill switch blocks every order until the owner resumes. The drawdown halt blocks every buy and resize, but still sells whole a thesis that closed (stopped, stale, overdue) or that you removed from the strategy; the cash waits until the owner resumes. After a resume, the halt trips again 15% below the account's level then, until it regains its old peak (get_overview's guardrails.haltRule).",
    },
    watchlist: [
      `Your research memory across runs (#32). get_watchlist lists the open names, soonest revisit first; update_watchlist adds, updates or drops them (at most ${WATCHLIST_LIMITS.perCall} changes a call, ${WATCHLIST_LIMITS.open} open names).`,
      `A watch needs why (10–600 characters), a trigger (what would make it a thesis, 10–400) and revisitBy (after today, at most ${WATCHLIST_LIMITS.revisitMaxDays} days out). Watching a name again replaces its note. A drop needs why.`,
      "It has no trading effect: only submit_strategy reaches the market. The owner sees each change in the daily digest.",
    ],
    lessons: [
      `Post-mortems on closed theses (#28). A thesis is due one once it has left the strategy and its shares are all sold, however it ended; get_track_record lists them in lessonsDue. record_lesson writes up to ${LESSON_LIMITS.perCall} at a time, all or nothing: thesisId, expected, happened and lesson, ${LESSON_LIMITS.minChars}–${LESSON_LIMITS.maxChars} characters each.`,
      "The outcome it's judged against (ending, days held, return vs VTI) is stored with it as the track record has it now. A later lesson on the same thesis replaces it.",
      `Read back on get_track_record's closed rows (lesson) and on check_eligibility for the same symbol (pastLessons, the latest ${LESSON_LIMITS.perSymbol}). A hold of days is weak evidence: separate judgement from luck.`,
      "It has no trading effect. The owner sees each lesson in the daily digest.",
    ],
    earnings: [
      "get_holdings (each held thesis) and check_eligibility (each symbol) give nextEarnings: the next scheduled report on or after today, with inDays, timeOfDay (pre- or post-market, when known) and the consensus EPS estimate. Null means no date is announced yet: the calendar lists a report once the company announces it, usually two to four weeks ahead. Then expect the next report about three months after the last one (check_eligibility's signals.lastEarnings), and confirm on the company's investor-relations page if it matters.",
      `The calendar is Alpha Vantage's, fetched once a day. get_holdings' earningsCalendar says when, and a note says when it's missing or over ${STALE_AFTER_DAYS} days old: then check report dates yourself.`,
      `A held thesis reporting within ${EARNINGS_SOON_DAYS} days is flagged earnings_soon. That isn't a sell signal: decide on purpose whether to hold through the report.`,
    ],
    filings: [
      "Code reads SEC EDGAR about hourly for every thesis and open watchlist name (#105): Form 4 insider trades, Form 144 sale notices, 8-Ks, Schedule 13D/13G and 10-Q/10-K. get_holdings gives each held thesis's filings since its first buy, and get_watchlist each name's since it went on the list, newest first, each with a plain summary and its sec.gov link. Form 4s that aren't open-market trades (awards, option exercises, tax withholding) are left out.",
      "Two are sell signals, and flag the thesis: insider_selling (an officer or director sold on the open market, not under a 10b5-1 plan) and executive_departure (an 8-K item 5.02 that mentions someone resigning, retiring or leaving). The owner is emailed about either at once. Open the filing before acting: the summaries are parsed, not read.",
      `filingsCheck says when the last check finished; a note says when it's missing or over ${FILINGS_LIMITS.staleAfterHours} hours old. Then read the names' recent filings on EDGAR yourself. A name the check didn't find has no tracked filings in the last ${FILINGS_LIMITS.lookbackDays} days; news that isn't in a filing still needs your own search.`,
    ],
    estimates: [
      `Analysts' EPS estimates (#105): get_holdings gives each held thesis's estimates, and get_watchlist each name's, for the next fiscal quarter and the fiscal year: the consensus, its change over 30 and 90 days, how many analysts raised and cut in the last 30 days, and how many cover it. Code refreshes each name about every ${ESTIMATES.refreshDays} days, so asOf can be a week old. Null means none fetched yet, or none published.`,
      `A held thesis is flagged estimates_falling when either consensus fell ${ESTIMATES.fallingPct.replace("-", "")}% or more in 30 days. Weigh it as a sign the business is turning against the thesis, especially beside other flags. It hasn't been backtested here, so it isn't a sell signal by itself. Rising estimates are context, not a reason to buy.`,
    ],
    withdrawals: [
      "The owner can request a withdrawal (dashboard or CLI). While it's open, its outstanding amount is held back: targets are built on equity minus it, and buys can't use it.",
      "Your next strategy after the request is its funding plan: shrink or drop what you'd rather sell, keep what you'd rather hold. preview_strategy shows each sell's realized gain and wash-sale effect.",
      "If you don't submit by get_overview's capital.withdrawal.planBy (your run + 60 minutes), a fallback version keeps every thesis's dollars and sells VTI and the systematic sleeve. It doesn't reaffirm your theses.",
      "While trading is halted, the owner's withdrawal sells only what it needs (besides any closed thesis, which the halt also lets out).",
    ],
    execution: `Rebalance steps every 15 minutes, ${WINDOW_OPEN}–${WINDOW_CLOSE} ET on trading days: sells first, then buys on a later step; nothing while orders are open. A submitted strategy takes effect at the next step.`,
  };
}

/** Validate a draft and show exactly what the next rebalance step would do with it. Records and orders nothing. */
export async function previewStrategy({ db, broker, env, now }: ToolDeps, document: unknown) {
  const parsed = validateStrategy(document);
  if (!parsed.ok) return { valid: false, errors: parsed.errors };
  const errors = await submissionErrors(db, parsed.strategy, now, EXIT_RULES, { requireBearCase: true, requireLedger: true });
  if (errors.length) return { valid: false, errors };
  const missing = parsed.strategy.conviction.filter((t) => !t.plainSummary).map((t) => t.id);
  const noBear = parsed.strategy.conviction.filter((t) => !t.bearCase).map((t) => t.id);
  const warnings = [
    ...(missing.length ? [`No plainSummary on ${missing.join(", ")}: the owner reads it first, so add 2–4 plain sentences to each.`] : []),
    ...(noBear.length ? [`No bearCase on ${noBear.join(", ")}: write the strongest case against each and why it doesn't win, and drop any you can't answer.`] : []),
  ];
  // Outside the session the mirror is hours old and risk would reject every
  // trade for staleness alone. Preview on the last-synced data instead and say
  // so: the real step runs after a fresh sync and re-checks the age.
  const [account] = await db.select({ syncedAt: brokerAccount.syncedAt }).from(brokerAccount);
  const ageMin = account?.syncedAt ? Math.floor((now.getTime() - account.syncedAt.getTime()) / 60_000) : null;
  const stale = ageMin !== null && ageMin > LIMITS.maxDataAgeMinutes;
  const limits = stale ? { ...LIMITS, maxDataAgeMinutes: Number.MAX_SAFE_INTEGER } : LIMITS;
  const plan = await runRebalance(db, broker, env, now, { force: true, dryRun: true, strategyOverride: parsed.strategy, limits });
  if (plan.status === "skipped") return { valid: true, warnings, nextStep: plan.reason };
  const { lots, held } = await holdingsWithLots(db);
  const price = new Map(held.map((p) => [p.symbol, p.currentPrice]));
  return {
    valid: true,
    warnings,
    nextStep: {
      phase: plan.phase,
      dataNote: stale
        ? `Broker data is ${ageMin} minutes old (last sync; the market is closed or between syncs). Prices and risk verdicts use it; the real step re-checks risk on fresh data.`
        : undefined,
      note: plan.phase === "sell" ? "Sells go first; buys are planned on a later step once the sells fill." : undefined,
      trades: plan.trades.map(({ trade, decision }) => ({
        side: trade.proposal.side,
        symbol: trade.proposal.symbol,
        sleeve: trade.proposal.sleeve,
        size: trade.proposal.side === "buy" ? `$${decision?.notional ?? trade.proposal.notional}` : `${decision?.qty ?? trade.proposal.qty} shares`,
        why: trade.reason,
        risk: decision?.verdict ?? "unknown",
        riskReasons: decision?.reasons ?? [],
        ...(trade.proposal.side === "sell" ? { tax: saleTax(lots.open, trade.proposal.symbol, decision?.qty ?? trade.proposal.qty, price.get(trade.proposal.symbol), now) } : {}),
      })),
      notes: plan.notes,
    },
  };
}

/**
 * The tax view of a planned sell (SPEC-capital): what it would realize,
 * first-in first-out, split short- and long-term, and the wash-sale window a
 * loss opens (ADR-010). An estimate at the last price, not a 1099.
 */
function saleTax(open: Parameters<typeof estimateSale>[0], symbol: string, qty: string, lastPrice: string | undefined, now: Date) {
  if (!lastPrice) return null;
  const e = estimateSale(open, symbol, qty, lastPrice, now);
  const r = (v: string) => round(v, 2, "half-even");
  const loss = compare(e.gain, "0") < 0;
  const until = marketDate(new Date(now.getTime() + WASH_SALE_DAYS * 86_400_000));
  return {
    realizedGain: r(e.gain),
    shortTermGain: r(e.shortTermGain),
    longTermGain: r(e.longTermGain),
    washSale: loss ? `Realizes a $${r(sub("0", e.gain))} loss: buying ${symbol} back before ${until} (or having bought it in the 30 days before) can disallow it.` : null,
  };
}

/** Store a validated draft as the next version (actor "claude"). The owner is emailed either way. */
export async function submitStrategyTool({ db, now }: ToolDeps, document: unknown): Promise<SubmitStrategyResult> {
  return submitStrategy(db, document, "claude", now, { requireBearCase: true, requireLedger: true });
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

/** The open research watchlist (#32), soonest revisit first, each marked if it's already a thesis; and recent drops. */
export async function getWatchlist({ db, now }: DbDeps) {
  const { open, recentlyDropped } = await readWatchlist(db, now);
  const theses = new Set((await activeStrategy(db, now)).strategy.conviction.map((t) => t.symbol));
  // Filings since each name went on the list, at most a lookback's worth (#105).
  const floor = marketDate(new Date(now.getTime() - FILINGS_LIMITS.lookbackDays * 86_400_000));
  const filings = await filingsSince(db, new Map(open.map((e) => [e.symbol, maxDate(marketDate(new Date(e.watchedSince)), floor)])));
  const estimates = await estimatesFor(db, open.map((e) => e.symbol));
  return {
    limits: WATCHLIST_LIMITS,
    open: open.map((e) => ({ ...e, ...(theses.has(e.symbol) ? { nowThesis: true } : {}), filings: filings.get(e.symbol) ?? [], estimates: estimates.get(e.symbol) ?? null })),
    recentlyDropped,
    filingsCheck: await filingsStatus(db, now),
  };
}

/** Add, update or drop watchlist names (#32). Claude's research notes: no trading effect. */
export async function updateWatchlistTool({ db, now }: DbDeps, changes: unknown): Promise<UpdateWatchlistResult> {
  return updateWatchlist(db, changes, "claude", now);
}

/** record_lesson (#28): post-mortems on closed theses, actor `claude`. No trading effect. */
export async function recordLessonTool({ db, now }: DbDeps, lessons: unknown): Promise<RecordLessonsResult> {
  return recordLessons(db, lessons, "claude", now);
}
