import { asc, desc, gte, inArray } from "drizzle-orm";
import { buildLots } from "../broker/lots.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { auditEvents, brokerAccount, brokerActivities, orders, positions, rebalancePlans, riskState } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { compare } from "../money.js";
import { benchmarkSince } from "../portfolio/benchmark.js";
import { WASH_SALE_DAYS, washSaleWindow } from "../portfolio/planner.js";
import { WINDOW_CLOSE, WINDOW_OPEN, runRebalance } from "../portfolio/rebalance.js";
import { type SubmitStrategyResult, activeStrategy, stoppedThesisIds, submitStrategy } from "../portfolio/store.js";
import { EVIDENCE_KINDS, validateStrategy } from "../portfolio/strategy.js";
import { IDLE_SYMBOL } from "../portfolio/systematic.js";
import { STALE_AFTER_MS, thesisStates } from "../portfolio/theses.js";
import { assetFacts, ineligibleReasons } from "../risk/eligibility.js";
import { loadSnapshot } from "../risk/gate.js";
import { LIMITS, capExempt } from "../risk/limits.js";
import { marketDate } from "../time.js";

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
}

const MAX_SYMBOLS = 25;
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
export async function getStrategy({ db, now }: ToolDeps, version?: number) {
  const active = await activeStrategy(db, now);
  if (version !== undefined && version !== active.version) {
    return { error: `Only the active strategy (v${active.version}) is served; history is in get_activity.` };
  }
  const { lots, held } = await holdingsWithLots(db);
  const states = thesisStates({ active, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose: Object.fromEntries(held.map((p) => [p.symbol, p.currentPrice])), now });
  const daysSince = Math.floor((now.getTime() - active.createdAt.getTime()) / 86_400_000);
  return {
    version: active.version,
    authoredBy: active.authoredBy,
    createdAt: active.createdAt.toISOString(),
    daysSinceReaffirmed: daysSince,
    staleAfterDays: STALE_AFTER_MS / 86_400_000,
    document: active.strategy,
    theses: states.map((s) => ({ id: s.thesis.id, symbol: s.thesis.symbol, state: s.state, ...(s.state === "active" ? {} : { reason: s.reason }) })),
  };
}

/** Positions, lots, wash-sale windows and stopped thesis ids. */
export async function getHoldings({ db, now }: ToolDeps) {
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
  "strategy.activated", "strategy.rejected", "thesis.stopped_out", "thesis.stale",
];

/** What happened recently: rebalance steps with reasons, fills, risk decisions, strategy submissions. */
export async function getActivity({ db, now }: ToolDeps, days = 14) {
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
export async function checkEligibility({ broker, now }: ToolDeps, symbols: string[]) {
  const { ok, error } = cleanSymbols(symbols);
  if (error) return { error };
  const bars = await broker.getDailyBars(ok, new Date(now.getTime() - 120 * 86_400_000), now);
  const out = [];
  for (const symbol of ok) {
    const facts = assetFacts(symbol, await broker.getAsset(symbol), bars[symbol] ?? [], now, LIMITS);
    const reasons = ineligibleReasons(symbol, facts, LIMITS);
    out.push({ symbol, eligible: reasons.length === 0, reasons, capExempt: capExempt(symbol, LIMITS), lastClose: facts?.lastClose ?? null });
  }
  return out;
}

/** The contract strategies are written against. */
export function getRules() {
  return {
    strategySchema: {
      conviction: `Theses: id (lowercase slug; a stopped id can never be reused), symbol, targetWeightPct (0 < w ≤ ${LIMITS.positionCapPct}, % of equity), thesis (prose), evidence (≥ 1; kinds: ${EVIDENCE_KINDS.join(", ")}), stopLossPct (5–50, required). Total ≤ 100%.`,
      systematic: "universe (1–100 symbols), lookbackDays (21–252), skipRecentDays (0–21, < lookback), topN (1–20, ≤ universe), trendFilterDays (50–250 or null), weighting (equal | inverse_volatility), volatilityDays (20–126), defensive (symbol or null).",
      drift: "relativePct (1–100), minTradeUsd (1–1000): a holding is traded back to target only when off by more than max(relativePct × target, minTradeUsd).",
    },
    allocation: [
      "Conviction theses get their weight of equity first; the systematic sleeve gets the rest.",
      `A systematic name over the ${LIMITS.positionCapPct}% per-name cap is held at the cap; the excess goes down the ranking, then to ${IDLE_SYMBOL}. topN means at least N names.`,
      `Idle money sits in ${IDLE_SYMBOL}, never cash (no cash buffer). Trend-filtered slots go to 'defensive', or ${IDLE_SYMBOL}.`,
      "Systematic picks sold at a loss in the last 30 days are skipped (wash sales); conviction buys are not, so weigh them yourself.",
    ],
    lifecycle: [
      "A thesis whose price closes at or below average cost × (1 − stopLossPct) is sold and stays stopped; re-entry needs a new id.",
      `A thesis not resubmitted for ${STALE_AFTER_MS / 86_400_000} days unwinds into the systematic sleeve. Resubmitting the strategy reaffirms every thesis in it.`,
    ],
    risk: {
      positionCapPct: LIMITS.positionCapPct,
      capExempt: { broadEtfs: LIMITS.broadEtfs, cashEquivalents: LIMITS.cashEquivalentEtfs },
      eligibility: `No leveraged/inverse funds, nothing under $${LIMITS.minPrice}, under $${LIMITS.minAvgDollarVolume}/day traded, under ${LIMITS.minHistoryDays} days listed, or non-fractionable.`,
      drawdownHaltPct: LIMITS.drawdownHaltPct,
      dailyLossPausePct: LIMITS.dailyLossPausePct,
      note: "Limits are owner-set; strategies can't change them. A halt or kill switch blocks every order until the owner resumes.",
    },
    execution: `Rebalance steps every 15 minutes, ${WINDOW_OPEN}–${WINDOW_CLOSE} ET on trading days: sells first, then buys on a later step; nothing while orders are open. A submitted strategy takes effect at the next step.`,
  };
}

/** Validate a draft and show exactly what the next rebalance step would do with it. Records and orders nothing. */
export async function previewStrategy({ db, broker, env, now }: ToolDeps, document: unknown) {
  const parsed = validateStrategy(document);
  if (!parsed.ok) return { valid: false, errors: parsed.errors };
  const stopped = await stoppedThesisIds(db);
  const reused = parsed.strategy.conviction.flatMap((t, i) => (stopped.has(t.id) ? [`conviction[${i}].id: "${t.id}" was stopped out; re-entering needs a new thesis id`] : []));
  if (reused.length) return { valid: false, errors: reused };
  // Outside the session the mirror is hours old and risk would reject every
  // trade for staleness alone. Preview on the last-synced data instead and say
  // so: the real step runs after a fresh sync and re-checks the age.
  const [account] = await db.select({ syncedAt: brokerAccount.syncedAt }).from(brokerAccount);
  const ageMin = account?.syncedAt ? Math.floor((now.getTime() - account.syncedAt.getTime()) / 60_000) : null;
  const stale = ageMin !== null && ageMin > LIMITS.maxDataAgeMinutes;
  const limits = stale ? { ...LIMITS, maxDataAgeMinutes: Number.MAX_SAFE_INTEGER } : LIMITS;
  const plan = await runRebalance(db, broker, env, now, { force: true, dryRun: true, strategyOverride: parsed.strategy, limits });
  if (plan.status === "skipped") return { valid: true, nextStep: plan.reason };
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
      })),
      notes: plan.notes,
    },
  };
}

/** Store a validated draft as the next version (actor "claude"). The owner is emailed either way. */
export async function submitStrategyTool({ db, now }: ToolDeps, document: unknown): Promise<SubmitStrategyResult> {
  return submitStrategy(db, document, "claude", now);
}
