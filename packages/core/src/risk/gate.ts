import { asc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { recordEvent } from "../audit.js";
import type { BrokerAdapter } from "../broker/port.js";
import type { Db } from "../db/client.js";
import {
  brokerAccount,
  brokerActivities,
  capitalFlows,
  equitySnapshots,
  orders,
  positions,
  riskDecisions,
  riskGateRuns,
} from "../db/schema.js";
import { add, compare, sub } from "../money.js";
import { marketDate } from "../time.js";
import { assetFacts } from "./eligibility.js";
import { type DailyEquity, type IndexFlow, type LiveIndex, buildIndex, liveIndex } from "./equity-index.js";
import { LIMITS, type Limits, limitsVersion } from "./limits.js";
import { loadReserve, pendingTransferOut } from "./reserve.js";
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
  const index = await currentIndex(db, account, now);
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

  const withdrawal = await loadReserve(db, account?.equity ?? "0", account?.cash ?? "0");

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
    withdrawal,
    assets,
  };
}

/**
 * The index's inputs: post-close snapshots and the capital ledger's flows
 * (SPEC-capital). A flow Alpaca marks `canceled` is left out: it's taken as
 * money that never moved.
 */
export async function loadIndexInputs(db: Db): Promise<{ snapshots: DailyEquity[]; flows: IndexFlow[] }> {
  const snapshots = await db
    .select({ tradingDate: equitySnapshots.tradingDate, equity: equitySnapshots.equity, recordedAt: equitySnapshots.recordedAt })
    .from(equitySnapshots)
    .orderBy(asc(equitySnapshots.tradingDate));
  const flows = await db
    .select({ at: capitalFlows.at, amount: capitalFlows.amount })
    .from(capitalFlows)
    .where(or(isNull(capitalFlows.status), ne(capitalFlows.status, "canceled")));
  return { snapshots, flows };
}

export interface AccountEquity {
  equity: string;
  lastEquity: string | null;
  /** When the sync read this equity from the broker. */
  syncedAt: Date;
}

/** Today's flow-adjusted change and drawdown, from the snapshots plus the last synced equity. */
export async function currentIndex(db: Db, account: (AccountEquity & { cash?: string }) | undefined, now: Date): Promise<LiveIndex> {
  const { snapshots, flows: recorded } = await loadIndexInputs(db);
  const equity = account?.equity ?? "0";
  // A withdrawal's ACH that has left but not posted counts as money out now (risk/reserve.ts).
  const pending = account?.cash !== undefined ? await pendingTransferOut(db, account.cash) : "0";
  const flows = compare(pending, "0") > 0 ? [...recorded, { at: account?.syncedAt ?? now, amount: sub("0", pending) }] : recorded;
  // Before Alpaca reports a prior close, measure the day from our own last snapshot.
  const fallbackPriorClose = account?.lastEquity ?? snapshots.at(-1)?.equity ?? equity;
  return liveIndex(buildIndex(snapshots, flows), { equity, asOf: account?.syncedAt ?? now, flows, fallbackPriorClose });
}

async function ordersToday(db: Db, now: Date): Promise<RiskSnapshot["today"]> {
  const today = marketDate(now);
  const since = new Date(now.getTime() - 2 * 86_400_000);
  const recent = await db
    .select({ symbol: orders.symbol, side: orders.side, notional: orders.notional, status: orders.status, filledQty: orders.filledQty, createdAt: orders.createdAt })
    .from(orders)
    .where(gte(orders.createdAt, since));
  const todays = recent.filter((o) => marketDate(o.createdAt) === today);
  // Fills (ours or anyone's, e.g. a trade placed in Alpaca's app) plus our orders that may still fill.
  const fills = (await db.select({ symbol: brokerActivities.symbol, side: brokerActivities.side, at: brokerActivities.at }).from(brokerActivities).where(gte(brokerActivities.at, since)))
    .filter((a) => a.symbol && marketDate(a.at) === today);
  const mayFill = todays.filter((o) => o.status !== "rejected" && !(NO_FILL_ENDS.has(o.status) && compare(o.filledQty ?? "0", "0") <= 0));
  const traded = (side: "buy" | "sell") => {
    const symbols = new Set<string>();
    for (const f of fills) if (f.side === side) symbols.add(f.symbol!);
    for (const o of mayFill) if (o.side === side) symbols.add(o.symbol);
    return [...symbols].sort();
  };
  return {
    orderCount: todays.length,
    buyNotional: todays.filter((o) => o.side === "buy").reduce((sum, o) => add(sum, o.notional ?? "0"), "0"),
    bought: traded("buy"),
    sold: traded("sell"),
  };
}

/** Order states that end an order; with nothing filled, it never traded. */
const NO_FILL_ENDS = new Set(["canceled", "expired", "done_for_day", "replaced"]);

/** Symbols the same-day round-trip guard blocks today, per side (none when round trips are allowed). */
export async function roundTripBlocks(db: Db, now: Date, limits: Limits = LIMITS): Promise<{ sell: Set<string>; buy: Set<string> }> {
  if (limits.sameDayRoundTrips) return { sell: new Set(), buy: new Set() };
  const today = await ordersToday(db, now);
  return { sell: new Set(today.bought), buy: new Set(today.sold) };
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
  const index = await currentIndex(db, account, now);

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
