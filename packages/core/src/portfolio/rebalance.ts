import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import { buildLots } from "../broker/lots.js";
import { OPEN_ORDER_LOOKBACK_MS, OPEN_ORDER_STATES, submitOrder } from "../broker/orders.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import { brokerAccount, brokerActivities, orders, positions, rebalancePlans, thesisEvents } from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import type { JobFn } from "../jobs.js";
import { loadSnapshot, riskGate } from "../risk/gate.js";
import { loadReserve } from "../risk/reserve.js";
import { getRiskState } from "../risk/state.js";
import { LIMITS, type Limits } from "../risk/limits.js";
import { evaluateOrders } from "../risk/rules.js";
import type { Decision, Sleeve } from "../risk/types.js";
import { compare, round } from "../money.js";
import { marketDate, marketTimeToUtc } from "../time.js";
import { type PlannedTrade, planTrades, washSaleWindow, withdrawalSells } from "./planner.js";
import { activeStrategy, stoppedThesisIds } from "./store.js";
import type { Strategy } from "./strategy.js";
import { IDLE_SYMBOL, type DailyClose, rankUniverse, requiredHistory } from "./systematic.js";
import { buildTargets } from "./targets.js";
import { thesisStates } from "./theses.js";

/**
 * The daily check's window, New York time (SPEC-portfolio). Opens at 9:45,
 * 15 minutes after the open, so the 9:30 sync has run (Scott, 2026-11-01;
 * originally 10:30), and closes 30 minutes before the close.
 */
export const WINDOW_OPEN = "09:45";
export const WINDOW_CLOSE = "15:30";
const LAST_STEP_BEFORE_CLOSE_MS = 30 * 60_000;

export type RebalanceResult =
  | { status: "skipped"; reason: string }
  | {
      status: "planned";
      phase: "sell" | "buy" | "none";
      strategyVersion: number;
      planId: string | null;
      trades: { trade: PlannedTrade; decision?: Decision; submitted?: string }[];
      notes: string[];
    };

export interface RebalanceOptions {
  /** Ignore the trading window (operator use on paper). */
  force?: boolean;
  /** Plan and evaluate through risk without recording, gating or ordering anything. */
  dryRun?: boolean;
  /** Plan with this (already validated) strategy instead of the active one: preview_strategy. Requires dryRun. */
  strategyOverride?: Strategy;
  limits?: Limits;
}

/**
 * One step of the daily check (SPEC-portfolio): targets from the active
 * strategy, a sells-first plan, risk's gate, then orders. At most one phase
 * per step; the next step (15 minutes later, after sync-broker) sees the fills.
 */
export async function runRebalance(db: Db, broker: BrokerAdapter, env: TradingEnv, now: Date, opts: RebalanceOptions = {}): Promise<RebalanceResult> {
  const limits = opts.limits ?? LIMITS;
  const today = marketDate(now);

  if (!opts.force) {
    const session = (await broker.getCalendar(today, today)).find((d) => d.date === today);
    if (!session) return { status: "skipped", reason: "not a trading day" };
    const open = marketTimeToUtc(today, WINDOW_OPEN).getTime();
    const close = Math.min(marketTimeToUtc(today, WINDOW_CLOSE).getTime(), session.close.getTime() - LAST_STEP_BEFORE_CLOSE_MS);
    if (now.getTime() < open || now.getTime() > close) return { status: "skipped", reason: "outside the trading window" };
  }

  if (opts.strategyOverride && !opts.dryRun) throw new Error("strategyOverride is preview-only (dryRun)");

  const inFlight = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.status, OPEN_ORDER_STATES), gte(orders.createdAt, new Date(now.getTime() - OPEN_ORDER_LOOKBACK_MS))));
  // A preview still plans (on current holdings); a real step waits for fills.
  if (inFlight.length > 0 && !opts.dryRun) return { status: "skipped", reason: `waiting for ${inFlight.length} open order(s) to fill` };

  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  if (!account) return { status: "skipped", reason: "the broker has never been synced" };

  const active = opts.strategyOverride
    ? { version: -1, authoredBy: "claude" as const, createdAt: now, reaffirmedAt: now, strategy: opts.strategyOverride }
    : await activeStrategy(db, now);
  const { strategy } = active;
  const activityRows = await db.select().from(brokerActivities).orderBy(asc(brokerActivities.at), asc(brokerActivities.id));
  const lots = buildLots(activityRows.map((r) => ({ ...r, side: r.side === "buy" || r.side === "sell" ? r.side : null })));
  const held = await db.select().from(positions);

  // One bars request: universe, theses, holdings, VTI and the defensive symbol.
  const symbols = new Set<string>([...strategy.systematic.universe, ...strategy.conviction.map((t) => t.symbol), ...held.map((p) => p.symbol), IDLE_SYMBOL]);
  if (strategy.systematic.defensive) symbols.add(strategy.systematic.defensive);
  const historyDays = Math.ceil(requiredHistory(strategy.systematic) * 1.5) + 10;
  const raw = await broker.getDailyBars([...symbols], new Date(now.getTime() - historyDays * 86_400_000), now);
  const bars: Record<string, DailyClose[]> = Object.fromEntries(Object.entries(raw).map(([s, b]) => [s, b.map((x) => ({ t: x.t, c: x.c }))]));
  const lastClose = Object.fromEntries(Object.entries(bars).flatMap(([s, b]) => (b.length ? [[s, b.at(-1)!.c]] : [])));

  const states = thesisStates({ active: { strategy, createdAt: active.createdAt, reaffirmedAt: active.reaffirmedAt }, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose, now });
  const convictionSymbols = new Set(strategy.conviction.map((t) => t.symbol));
  const ranking = rankUniverse(bars, strategy.systematic, convictionSymbols);
  // Cash for an open withdrawal is left out of the targets, and sells raise it (SPEC-capital).
  const reserve = await loadReserve(db, account.equity, account.cash);
  const { targets, notes } = buildTargets({
    states,
    ranking,
    params: strategy.systematic,
    skip: washSaleWindow(lots.closed, now),
    equity: account.equity,
    reserved: reserve.outstanding,
    limits,
  });
  if (compare(reserve.outstanding, "0") > 0) notes.push(`$${reserve.outstanding} held for a withdrawal (${compare(reserve.unfunded, "0") > 0 ? `$${round(reserve.unfunded, 2, "up")} still to raise` : "covered by cash"})`);

  const exitReasons: Record<string, string> = {};
  for (const s of states) if (s.state !== "active") exitReasons[s.thesis.symbol] = `thesis ${s.thesis.id}: ${s.reason}`;
  const sleeveOf = (symbol: string): Sleeve => (convictionSymbols.has(symbol) ? "conviction" : "systematic");

  const planId = opts.dryRun ? "dry-run" : crypto.randomUUID();
  const holdings = held.map((p) => ({ symbol: p.symbol, qty: p.qty, marketValue: p.marketValue, currentPrice: p.currentPrice }));
  let plan = planTrades({ planId, targets, holdings, drift: strategy.drift, exitReasons, sleeveOf, raiseCash: compare(reserve.unfunded, "0") > 0 });

  // Halted, with a withdrawal to fund: only the sells it needs (SPEC-capital decision 2).
  // The kill switch is absolute, so it gets the normal path, where risk rejects everything.
  const guard = await getRiskState(db);
  if (guard.halted && !guard.killSwitch && compare(reserve.unfunded, "0") > 0) {
    const trades = withdrawalSells(plan.trades, holdings, reserve.unfunded);
    if (trades.length === 0) return { status: "skipped", reason: "halted; nothing in the plan raises the withdrawal's cash" };
    plan = { phase: "sell", trades };
    notes.push(`trading is halted: selling only the $${round(reserve.unfunded, 2, "up")} your withdrawal needs`);
  }

  if (opts.dryRun) {
    const snapshot = await loadSnapshot(db, broker, plan.trades.map((t) => t.proposal), now, limits, sleeveOf);
    const decisions = evaluateOrders(snapshot, plan.trades.map((t) => t.proposal), limits);
    return {
      status: "planned",
      phase: plan.phase,
      strategyVersion: active.version,
      planId: null,
      trades: plan.trades.map((trade, i) => ({ trade, decision: decisions[i] })),
      notes: [...notes, ...states.flatMap((s) => (s.state === "active" ? [] : [`thesis ${s.thesis.id}: ${s.reason}`]))],
    };
  }

  await recordThesisTransitions(db, states, active.version, now);
  if (plan.phase === "none") return { status: "skipped", reason: "on target" };

  const gate = await riskGate(db, broker, plan.trades.map((t) => t.proposal), now, { sleeveOf, limits });
  const results: { trade: PlannedTrade; decision?: Decision; submitted?: string }[] = [];
  for (const [i, trade] of plan.trades.entries()) {
    const decision = gate.decisions[i];
    if (!decision || decision.verdict === "rejected") {
      results.push({ trade, decision });
      continue;
    }
    const p = trade.proposal;
    const sizing = p.side === "buy" ? { notional: decision.notional ?? p.notional } : { qty: decision.qty ?? p.qty };
    const submitted = await submitOrder(db, broker, env, { key: p.key, symbol: p.symbol, side: p.side, strategyRef: `v${active.version}`, ...sizing }, now);
    results.push({ trade, decision, submitted: submitted.status });
  }

  await db.insert(rebalancePlans).values({
    id: planId,
    tradingDate: today,
    strategyVersion: active.version,
    phase: plan.phase,
    targets: targets as unknown[],
    trades: results.map((r) => ({ ...r.trade, verdict: r.decision?.verdict, reasons: r.decision?.reasons, submitted: r.submitted })) as unknown[],
    notes,
    gateRunId: gate.gateRunId,
  });
  await recordEvent(db, {
    actor: "system",
    kind: "rebalance.planned",
    subject: `v${active.version}`,
    payload: {
      planId,
      phase: plan.phase,
      trades: results.length,
      submitted: results.filter((r) => r.submitted === "submitted").length,
      rejected: results.filter((r) => r.decision?.verdict === "rejected").length,
    },
  });
  return { status: "planned", phase: plan.phase, strategyVersion: active.version, planId, trades: results, notes };
}

/** Record each newly stopped or stale thesis once (thesis_events + an urgent audit event). */
async function recordThesisTransitions(db: Db, states: ReturnType<typeof thesisStates>, version: number, now: Date): Promise<void> {
  for (const s of states) {
    if (s.state === "stopped" && s.newlyStopped) {
      await db.insert(thesisEvents).values({ thesisId: s.thesis.id, symbol: s.thesis.symbol, kind: "stopped", strategyVersion: version, price: s.price ?? null, averageCost: s.averageCost ?? null, reason: s.reason, at: now });
      await recordEvent(db, { actor: "system", kind: "thesis.stopped_out", subject: s.thesis.symbol, payload: { thesisId: s.thesis.id, reason: s.reason, price: s.price, averageCost: s.averageCost } });
    }
    if (s.state === "stale") {
      const seen = await db
        .select({ id: thesisEvents.id })
        .from(thesisEvents)
        .where(and(eq(thesisEvents.thesisId, s.thesis.id), eq(thesisEvents.kind, "stale"), eq(thesisEvents.strategyVersion, version)));
      if (seen.length > 0) continue;
      await db.insert(thesisEvents).values({ thesisId: s.thesis.id, symbol: s.thesis.symbol, kind: "stale", strategyVersion: version, reason: s.reason, at: now });
      await recordEvent(db, { actor: "system", kind: "thesis.stale", subject: s.thesis.symbol, payload: { thesisId: s.thesis.id, reason: s.reason } });
    }
  }
}

/** The `rebalance` job (its own schedule, SPEC-portfolio). */
export const rebalanceJob: JobFn = async ({ db, env, broker, now }) => {
  const result = await runRebalance(db, broker, env, now());
  if (result.status === "skipped") return { status: "skipped", reason: result.reason };
  return {
    status: "succeeded",
    detail: { phase: result.phase, strategyVersion: result.strategyVersion, planId: result.planId, trades: result.trades.length },
  };
};
