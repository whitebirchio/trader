import { asc, eq, gte, inArray } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import {
  brokerAccount,
  brokerActivities,
  equitySnapshots,
  orders,
  positions,
  riskDecisions,
  riskGateRuns,
} from "../db/schema.js";
import { add, compare } from "../money.js";
import { marketDate } from "../time.js";
import { assetFacts } from "./eligibility.js";
import { FLOW_TYPES, type LiveIndex, buildIndex, flowsByDate, liveIndex } from "./equity-index.js";
import { LIMITS, type Limits, limitsVersion } from "./limits.js";
import { evaluateOrders } from "./rules.js";
import { getRiskState, latchHalt, markBuysPaused } from "./state.js";
import type { AssetFacts, Decision, Proposal, RiskSnapshot, Sleeve } from "./types.js";

/** Bars fetched for eligibility: enough for the 90-day history rule plus margin. */
const FACTS_LOOKBACK_DAYS = 120;

export interface GateResult {
  gateRunId: string;
  decisions: Decision[];
}

/**
 * The only way `portfolio` may reach `submitOrder` (SPEC-risk): load a fresh
 * snapshot, evaluate, persist the snapshot and every decision, and audit each
 * clip and rejection. Approvals are recorded in risk_decisions but not audited.
 *
 * `sleeveOf` attributes current holdings to a sleeve; unattributed holdings
 * count as conviction, the conservative side of the cap.
 */
export async function riskGate(
  db: Db,
  broker: BrokerAdapter,
  proposals: Proposal[],
  now: Date,
  opts: { sleeveOf?: (symbol: string) => Sleeve | undefined; limits?: Limits } = {},
): Promise<GateResult> {
  const limits = opts.limits ?? LIMITS;
  const snapshot = await loadSnapshot(db, broker, proposals, now, limits, opts.sleeveOf);
  const decisions = evaluateOrders(snapshot, proposals, limits);
  const version = await limitsVersion(limits);

  const [run] = await db
    .insert(riskGateRuns)
    .values({ limitsVersion: version, snapshot: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown> })
    .returning({ id: riskGateRuns.id });
  if (!run) throw new Error("risk_gate_runs insert returned no row");

  if (decisions.length > 0) {
    await db.insert(riskDecisions).values(
      decisions.map((d) => ({
        gateRunId: run.id,
        intentKey: d.proposal.key,
        symbol: d.proposal.symbol,
        side: d.proposal.side,
        sleeve: d.proposal.sleeve,
        requestedNotional: d.proposal.side === "buy" ? d.proposal.notional : null,
        requestedQty: d.proposal.side === "sell" ? d.proposal.qty : null,
        approvedNotional: d.notional ?? null,
        approvedQty: d.qty ?? null,
        verdict: d.verdict,
        reasons: d.reasons,
        limitsVersion: version,
      })),
    );
  }

  for (const d of decisions) {
    if (d.verdict === "approved") continue;
    await recordEvent(db, {
      actor: "system",
      kind: d.verdict === "clipped" ? "risk.order_clipped" : "risk.order_rejected",
      subject: d.proposal.symbol,
      payload: {
        gateRunId: run.id,
        key: d.proposal.key,
        side: d.proposal.side,
        sleeve: d.proposal.sleeve,
        requested: d.proposal.side === "buy" ? d.proposal.notional : d.proposal.qty,
        approved: d.notional ?? d.qty ?? null,
        reasons: d.reasons,
      },
    });
  }

  return { gateRunId: run.id, decisions };
}

/** Everything evaluateOrders needs, from the DB plus asset facts for the buys. */
export async function loadSnapshot(
  db: Db,
  broker: BrokerAdapter,
  proposals: Proposal[],
  now: Date,
  limits: Limits,
  sleeveOf?: (symbol: string) => Sleeve | undefined,
): Promise<RiskSnapshot> {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  const held = await db.select().from(positions);
  const state = await getRiskState(db);
  const index = await currentIndex(db, account?.equity ?? "0", account?.lastEquity ?? null, now);
  const today = await ordersToday(db, now);

  const buySymbols = [...new Set(proposals.filter((p) => p.side === "buy").map((p) => p.symbol))];
  const assets: Record<string, AssetFacts> = {};
  if (buySymbols.length > 0) {
    const start = new Date(now.getTime() - FACTS_LOOKBACK_DAYS * 86_400_000);
    const bars = await broker.getDailyBars(buySymbols, start, now);
    for (const symbol of buySymbols) {
      const facts = assetFacts(symbol, await broker.getAsset(symbol), bars[symbol] ?? [], now, limits);
      if (facts) assets[symbol] = facts;
    }
  }

  return {
    now,
    equity: account?.equity ?? "0",
    cash: account?.cash ?? "0",
    holdings: held.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      marketValue: p.marketValue,
      sleeve: sleeveOf?.(p.symbol) ?? "conviction",
    })),
    index,
    broker: {
      tradingAllowed: account?.tradingAllowed ?? false,
      blockedReasons: account?.blockedReasons ?? ["the broker has never been synced"],
      syncedAt: account?.syncedAt ?? null,
    },
    state: { killSwitch: state.killSwitch, killReason: state.killReason, halted: state.halted, haltReason: state.haltReason },
    today,
    assets,
  };
}

async function currentIndex(db: Db, equity: string, lastEquity: string | null, now: Date): Promise<LiveIndex> {
  const snaps = await db
    .select({ tradingDate: equitySnapshots.tradingDate, equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .orderBy(asc(equitySnapshots.tradingDate));
  const flowRows = await db.select().from(brokerActivities).where(inArray(brokerActivities.type, [...FLOW_TYPES]));
  const flows = flowsByDate(flowRows.map((r) => ({ ...r, side: null })));
  // Before Alpaca reports a prior close, measure the day from our own last snapshot.
  const base = lastEquity ?? snaps.at(-1)?.equity ?? equity;
  return liveIndex(buildIndex(snaps, flows), equity, flows, base, marketDate(now));
}

async function ordersToday(db: Db, now: Date): Promise<RiskSnapshot["today"]> {
  const today = marketDate(now);
  const recent = await db
    .select({ side: orders.side, notional: orders.notional, createdAt: orders.createdAt })
    .from(orders)
    .where(gte(orders.createdAt, new Date(now.getTime() - 2 * 86_400_000)));
  const todays = recent.filter((o) => marketDate(o.createdAt) === today);
  return {
    orderCount: todays.length,
    buyNotional: todays.filter((o) => o.side === "buy").reduce((sum, o) => add(sum, o.notional ?? "0"), "0"),
  };
}

export interface DrawdownCheck {
  drawdownPct: string;
  dailyChangePct: string;
  halted: "tripped" | "already" | "no";
  buysPaused: boolean;
}

/**
 * Run at the end of every successful broker sync, so a halt trips (and the
 * buys-paused email goes out) the moment a threshold is crossed, even on a
 * day nothing trades. Uses the account state the sync just wrote.
 */
export async function checkDrawdown(db: Db, now: Date, limits: Limits = LIMITS): Promise<DrawdownCheck> {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  if (!account) return { drawdownPct: "0", dailyChangePct: "0", halted: "no", buysPaused: false };
  const index = await currentIndex(db, account.equity, account.lastEquity, now);

  let halted: DrawdownCheck["halted"] = "no";
  if (compare(index.drawdownPct, limits.drawdownHaltPct) >= 0) {
    const result = await latchHalt(
      db,
      `the account is down ${index.drawdownPct}% from its peak (limit ${limits.drawdownHaltPct}%)`,
      { drawdownPct: index.drawdownPct, equity: account.equity },
      now,
    );
    halted = result.status === "halted" ? "tripped" : "already";
  }

  const buysPaused = compare(index.dailyChangePct, `-${limits.dailyLossPausePct}`) <= 0;
  const today = marketDate(now);
  const state = await getRiskState(db);
  if (buysPaused) {
    await markBuysPaused(db, true, today, { dailyChangePct: index.dailyChangePct, equity: account.equity }, now);
  } else if (state.buysPausedOn === today) {
    await markBuysPaused(db, false, today, { dailyChangePct: index.dailyChangePct }, now);
  }

  return { ...index, halted, buysPaused };
}
