import { asc, desc, gte, inArray } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { buildLots, estimateSale } from "../broker/lots.js";
import { capitalOverview } from "../capital/overview.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { auditEvents, brokerAccount, brokerActivities, orders, positions, rebalancePlans, riskState } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { compare, round, sub } from "../money.js";
import { benchmarkSince } from "../portfolio/benchmark.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { WASH_SALE_DAYS, washSaleWindow } from "../portfolio/planner.js";
import { WINDOW_CLOSE, WINDOW_OPEN, runRebalance } from "../portfolio/rebalance.js";
import { type SubmitStrategyResult, activeStrategy, stoppedThesisIds, submissionErrors, submitStrategy } from "../portfolio/store.js";
import { EVIDENCE_KINDS, validateStrategy } from "../portfolio/strategy.js";
import { IDLE_SYMBOL } from "../portfolio/systematic.js";
import { STALE_AFTER_MS, thesisStates } from "../portfolio/theses.js";
import { assetFacts, ineligibleReasons } from "../risk/eligibility.js";
import { loadSnapshot } from "../risk/gate.js";
import { LIMITS, capExempt } from "../risk/limits.js";
import { marketDate } from "../time.js";
import { candidateSignals } from "./candidate.js";
import { CORRELATION_SESSIONS, SECTOR_FUNDS, exposureReport } from "./exposure.js";
import type { FilingsPort } from "./sec.js";

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
  const acts = await db.select().from(brokerActivities).orderBy(asc(brokerActivities.at), asc(brokerActivities.id));
  const lots = buildLots(acts.map((r) => ({ ...r, side: r.side === "buy" || r.side === "sell" ? r.side : null })));
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
    account: { equity: snapshot.equity, cash: snapshot.cash, todayPct: snapshot.index.dailyChangePct, drawdownFromPeakPct: snapshot.index.drawdownPct },
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
      buysPausedToday: state?.buysPausedOn === marketDate(now),
      brokerTradingAllowed: snapshot.broker.tradingAllowed,
      brokerBlockedReasons: snapshot.broker.blockedReasons,
      lastBrokerSync: snapshot.broker.syncedAt?.toISOString() ?? null,
    },
    strategy: { version: active.version, authoredBy: active.authoredBy, createdAt: active.createdAt.toISOString(), summary: active.strategy.summary },
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

/** Positions, lots, wash-sale windows and stopped thesis ids. */
export async function getHoldings({ db, now }: DbDeps) {
  const { lots, held } = await holdingsWithLots(db);
  const windowSymbols = washSaleWindow(lots.closed, now);
  const since = now.getTime() - WASH_SALE_DAYS * 86_400_000;
  return {
    positions: held.map((p) => ({ symbol: p.symbol, qty: p.qty, marketValue: p.marketValue, price: p.currentPrice, costBasis: p.costBasis })),
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
  "strategy.activated", "strategy.rejected", "thesis.stopped_out", "thesis.stale", "thesis.review_overdue",
];

/** What happened recently: rebalance steps with reasons, fills, risk decisions, strategy submissions. */
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
  return {
    since: since.toISOString(),
    rebalanceSteps: plans.map((p) => ({ at: p.createdAt.toISOString(), strategyVersion: p.strategyVersion, phase: p.phase, trades: p.trades, notes: p.notes })),
    orders: recentOrders.map((o) => ({ at: o.createdAt.toISOString(), symbol: o.symbol, side: o.side, notional: o.notional, qty: o.qty, status: o.status, filledQty: o.filledQty, filledAvgPrice: o.filledAvgPrice, strategyRef: o.strategyRef, rejectReason: o.rejectReason })),
    events: events.filter((e) => e.at >= since).map((e) => ({ at: e.at.toISOString(), kind: e.kind, actor: e.actor, subject: e.subject, payload: e.payload })),
  };
}

/**
 * Every thesis ever held: its return on the dollars bought vs the same dollars
 * held in VTI, rolled up overall and by primary evidence kind (SPEC-portfolio § Scorecard).
 */
export async function getTrackRecord({ db, now }: DbDeps) {
  const card = await loadScorecard(db, now);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    markedAt: iso(card.markedAt),
    overall: card.overall,
    byKind: card.byKind,
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
export async function checkEligibility({ broker, now, filings }: ToolDeps, symbols: string[]) {
  const { ok, error } = cleanSymbols(symbols);
  if (error) return { error };
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
      conviction: `Theses: id (lowercase slug; a stopped id can never be reused), symbol, targetWeightPct (0 < w ≤ ${LIMITS.positionCapPct}, % of equity), thesis (prose), evidence (≥ 1; kinds: ${EVIDENCE_KINDS.join(", ")}), stopLossPct (5–50, required), reviewBy (optional YYYY-MM-DD; see lifecycle). Total ≤ 100%.`,
      systematic: "universe (1–100 symbols), lookbackDays (21–252), skipRecentDays (0–21, < lookback), topN (1–20, ≤ universe), trendFilterDays (50–250 or null), weighting (equal | inverse_volatility), volatilityDays (20–126), defensive (symbol or null).",
      drift: "relativePct (1–100), minTradeUsd (1–1000): a holding is traded back to target only when off by more than max(relativePct × target, minTradeUsd).",
    },
    allocation: [
      "Conviction theses get their weight of equity first; the systematic sleeve gets the rest.",
      `A systematic name over the ${LIMITS.positionCapPct}% per-name cap is held at the cap; the excess goes down the ranking, then to ${IDLE_SYMBOL}. topN means at least N names.`,
      `Idle money sits in ${IDLE_SYMBOL}, never cash (no cash buffer). Trend-filtered slots go to 'defensive', or ${IDLE_SYMBOL}.`,
      "Systematic picks sold at a loss in the last 30 days are skipped (wash sales); conviction buys are not, so weigh them yourself.",
      `Owner's direction (2026-11-04): no systematic momentum sleeve. Set systematic to idle-only, universe ["${IDLE_SYMBOL}"], topN 1, trendFilterDays null, weighting equal, defensive null, so everything not in a thesis sits in ${IDLE_SYMBOL}.`,
      `A new or larger thesis is funded by selling what's over target (usually ${IDLE_SYMBOL}), however small the gap, so a fully invested account can always buy it.`,
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
      note: "Limits are owner-set; strategies can't change them. A halt or kill switch blocks every order until the owner resumes.",
    },
    withdrawals: [
      "The owner can request a withdrawal (dashboard or CLI). While it's open, its outstanding amount is held back: targets are built on equity minus it, and buys can't use it.",
      "Your next strategy after the request is its funding plan: shrink or drop what you'd rather sell, keep what you'd rather hold. preview_strategy shows each sell's realized gain and wash-sale effect.",
      "If you don't submit by get_overview's capital.withdrawal.planBy (your run + 60 minutes), a fallback version keeps every thesis's dollars and sells VTI and the systematic sleeve. It doesn't reaffirm your theses.",
      "While trading is halted, the owner's withdrawal is the one thing that sells, and only what it needs.",
    ],
    execution: `Rebalance steps every 15 minutes, ${WINDOW_OPEN}–${WINDOW_CLOSE} ET on trading days: sells first, then buys on a later step; nothing while orders are open. A submitted strategy takes effect at the next step.`,
  };
}

/** Validate a draft and show exactly what the next rebalance step would do with it. Records and orders nothing. */
export async function previewStrategy({ db, broker, env, now }: ToolDeps, document: unknown) {
  const parsed = validateStrategy(document);
  if (!parsed.ok) return { valid: false, errors: parsed.errors };
  const errors = await submissionErrors(db, parsed.strategy, now);
  if (errors.length) return { valid: false, errors };
  // Outside the session the mirror is hours old and risk would reject every
  // trade for staleness alone. Preview on the last-synced data instead and say
  // so: the real step runs after a fresh sync and re-checks the age.
  const [account] = await db.select({ syncedAt: brokerAccount.syncedAt }).from(brokerAccount);
  const ageMin = account?.syncedAt ? Math.floor((now.getTime() - account.syncedAt.getTime()) / 60_000) : null;
  const stale = ageMin !== null && ageMin > LIMITS.maxDataAgeMinutes;
  const limits = stale ? { ...LIMITS, maxDataAgeMinutes: Number.MAX_SAFE_INTEGER } : LIMITS;
  const plan = await runRebalance(db, broker, env, now, { force: true, dryRun: true, strategyOverride: parsed.strategy, limits });
  if (plan.status === "skipped") return { valid: true, nextStep: plan.reason };
  const { lots, held } = await holdingsWithLots(db);
  const price = new Map(held.map((p) => [p.symbol, p.currentPrice]));
  return {
    valid: true,
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
  return submitStrategy(db, document, "claude", now);
}
