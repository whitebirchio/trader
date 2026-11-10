import { capitalSummary } from "../capital/shadow.js";
import { capitalOverview } from "../capital/overview.js";
import { OPEN_STATUSES } from "../capital/withdrawals.js";
import { and, asc, desc, eq, gte, inArray, like, lte } from "drizzle-orm";
import { BENCHMARK } from "../broker/benchmark-closes.js";
import { loadActivities } from "../broker/activities.js";
import { buildLots } from "../broker/lots.js";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  benchmarkCloses,
  brokerAccount,
  capitalCommandResults,
  capitalCommands,
  capitalFlows,
  positions,
  riskState,
  strategies,
  thesisCloses,
  thesisEvents,
  withdrawals,
} from "../db/schema.js";
import type { TradingEnv } from "../env.js";
import { add, compare, div, mul, sub } from "../money.js";
import { getActivity, getHoldings, getStrategy, getTrackRecord } from "../agent/tools.js";
import { type ChartRange, OVERVIEW_RANGES, type RangeOption, THESIS_RANGES, rangeFrom, rangeOptions, windowBase } from "./ranges.js";
import { compareToBenchmark } from "../portfolio/benchmark.js";
import { loadScorecard } from "../portfolio/scorecard.js";
import { activeStrategy, stoppedThesisIds } from "../portfolio/store.js";
import { type Thesis, VERSION_0, validateStrategy } from "../portfolio/strategy.js";
import { STALE_AFTER_MS, averageCost, thesisStates } from "../portfolio/theses.js";
import { buildIndex, drawdownFromPeak } from "../risk/equity-index.js";
import { currentIndex, loadIndexInputs } from "../risk/gate.js";
import { marketDate } from "../time.js";

/**
 * Read models for the dashboard (SPEC-dashboard). Database only: the
 * dashboard has no broker keys and a SELECT-only role, so nothing here calls
 * Alpaca or writes. Money stays as decimal strings.
 */

const DAY_MS = 86_400_000;
const pct = (num: string, den: string) => div(mul(sub(div(num, den, 12, "half-even"), "1"), "100"), "1", 2, "half-even");
const rebased = (value: string, base: string) => div(mul(value, "100"), base, 2, "half-even");
/** Whole days left before a version's theses go stale (0 once they have). */
const staleInDaysFrom = (createdAt: Date, now: Date) => Math.max(0, Math.ceil((createdAt.getTime() + STALE_AFTER_MS - now.getTime()) / DAY_MS));

export interface PerformancePoint {
  date: string;
  /** Flow-adjusted portfolio index, rebased to 100 at the first snapshot. */
  portfolio: string;
  /** VTI's adjusted close, rebased to 100 on the same day; null until a close is recorded. */
  benchmark: string | null;
}

type Totals = { since: string; through: string; portfolioPct: string; benchmarkPct: string } | null;

export interface PerformanceSeries {
  /** The selected range's points, both rebased to 100 at its first point. */
  points: PerformancePoint[];
  /** Totals over the whole series, the same numbers the digest reports; null with fewer than two snapshots. */
  totals: Totals;
  /** The range shown (a requested range the history doesn't reach falls back to "all"), its totals, and every range's availability (#59). */
  range: ChartRange;
  rangeTotals: Totals;
  ranges: RangeOption[];
}

/** The portfolio's flow-adjusted index against VTI over a range, from the daily snapshots and recorded closes. */
export async function performanceSeries(db: Db, requested: ChartRange = "all"): Promise<PerformanceSeries> {
  const { snapshots: snaps, flows } = await loadIndexInputs(db);
  if (snaps.length === 0) return { points: [], totals: null, range: "all", rangeTotals: null, ranges: rangeOptions(OVERVIEW_RANGES, [], "") };
  const index = buildIndex(snaps, flows);
  const closes = await db
    .select({ tradingDate: benchmarkCloses.tradingDate, close: benchmarkCloses.close })
    .from(benchmarkCloses)
    .where(eq(benchmarkCloses.symbol, BENCHMARK))
    .orderBy(asc(benchmarkCloses.tradingDate));
  const closeOn = (date: string) => [...closes].reverse().find((c) => c.tradingDate <= date)?.close ?? null;

  const dates = index.points.map((p) => p.tradingDate);
  const end = dates.at(-1)!;
  const ranges = rangeOptions(OVERVIEW_RANGES, dates, end);
  const range = ranges.find((r) => r.range === requested)?.available ? requested : "all";
  const window = index.points.slice(windowBase(dates, rangeFrom(range, end)) ?? 0);

  const first = window[0]!;
  const firstClose = closeOn(first.tradingDate);
  const points = window.map((p) => {
    const close = closeOn(p.tradingDate);
    return { date: p.tradingDate, portfolio: rebased(p.index, first.index), benchmark: close && firstClose ? rebased(close, firstClose) : null };
  });
  // Midday ET keeps marketDate() on the stored trading date.
  const bars = closes.map((c) => ({ t: new Date(`${c.tradingDate}T17:00:00Z`), c: c.close }));
  return { points, totals: compareToBenchmark(index.points, bars, marketDate), range, rangeTotals: compareToBenchmark(window, bars, marketDate), ranges };
}

/** The first screen: account, guardrails, strategy and performance (over `range`). */
export async function overviewView(db: Db, env: TradingEnv, now: Date, range: ChartRange = "all") {
  const [account] = await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1));
  const [state] = await db.select().from(riskState).where(eq(riskState.id, 1));
  const live = await currentIndex(db, account, now);
  const active = await activeStrategy(db, now);
  return {
    environment: env,
    asOf: now.toISOString(),
    lastSync: account?.syncedAt?.toISOString() ?? null,
    account: { equity: account?.equity ?? "0", cash: account?.cash ?? "0", todayPct: live.dailyChangePct, drawdownFromPeakPct: drawdownFromPeak(live) },
    guardrails: {
      killSwitch: state?.killSwitch ?? false,
      halted: state?.halted ?? false,
      haltReason: state?.haltReason ?? null,
      buysPausedToday: state?.buysPausedOn === marketDate(now),
      brokerTradingAllowed: account?.tradingAllowed ?? false,
      brokerBlockedReasons: account?.blockedReasons ?? ["the broker has never been synced"],
    },
    strategy: { version: active.version, authoredBy: active.authoredBy, createdAt: active.createdAt.toISOString(), summary: active.strategy.summary },
    performance: await performanceSeries(db, range),
    capital: await capitalSummary(db),
  };
}

export interface HoldingRow {
  symbol: string;
  qty: string;
  marketValue: string;
  price: string;
  averageCost: string;
  /** % of equity. */
  weightPct: string;
  /** Unrealized gain vs average cost, %. */
  gainPct: string;
  thesis: null | {
    id: string;
    state: "active" | "stopped" | "stale" | "overdue";
    targetPct: string;
    stopLossPct: string;
    /** The close at or below which the thesis is sold; null without open lots. */
    stopPrice: string | null;
    /** How far the price is above the stop, %. */
    toStopPct: string | null;
    staleInDays: number;
  };
}

/** Positions split by sleeve, with weights, gains and each thesis's distance to its stop. */
export async function holdingsView(db: Db, now: Date) {
  const [account] = await db.select({ equity: brokerAccount.equity }).from(brokerAccount).where(eq(brokerAccount.id, 1));
  const equity = account?.equity ?? "0";
  const held = await db.select().from(positions).orderBy(desc(positions.marketValue));
  const lots = buildLots(await loadActivities(db));
  const active = await activeStrategy(db, now);
  const states = thesisStates({ active, stoppedIds: await stoppedThesisIds(db), lots: lots.open, lastClose: Object.fromEntries(held.map((p) => [p.symbol, p.currentPrice])), now });
  const bySymbol = new Map(states.map((s) => [s.thesis.symbol, s]));
  const staleInDays = staleInDaysFrom(active.reaffirmedAt, now);

  const rows: HoldingRow[] = held.map((p) => {
    const t = bySymbol.get(p.symbol);
    const cost = averageCost(lots.open, p.symbol);
    const stopPrice = t && cost ? div(mul(cost, sub("1", div(t.thesis.stopLossPct, "100", 12, "half-even"))), "1", 2, "half-even") : null;
    return {
      symbol: p.symbol,
      qty: p.qty,
      marketValue: p.marketValue,
      price: p.currentPrice,
      averageCost: p.avgEntryPrice,
      weightPct: compare(equity, "0") > 0 ? div(mul(p.marketValue, "100"), equity, 2, "half-even") : "0",
      gainPct: compare(p.avgEntryPrice, "0") > 0 ? pct(p.currentPrice, p.avgEntryPrice) : "0",
      thesis: t
        ? {
            id: t.thesis.id,
            state: t.state,
            targetPct: t.thesis.targetWeightPct,
            stopLossPct: t.thesis.stopLossPct,
            stopPrice,
            toStopPct: stopPrice && compare(stopPrice, "0") > 0 ? pct(p.currentPrice, stopPrice) : null,
            staleInDays,
          }
        : null,
    };
  });
  const { washSaleWindows } = await getHoldings({ db, now });
  return {
    equity,
    conviction: rows.filter((r) => r.thesis),
    systematic: rows.filter((r) => !r.thesis),
    washSaleWindows,
  };
}

/** The active strategy with thesis states (as Claude sees it), plus how long until it goes stale. */
export async function strategyView(db: Db, now: Date) {
  const s = await getStrategy({ db, now });
  if ("error" in s) throw new Error(s.error); // only for a requested version; never here
  return { ...s, staleInDays: staleInDaysFrom(new Date(s.createdAt), now) };
}

/** Every stored version, newest first. Version 0 (VTI) is implicit and listed last. */
export async function strategyHistory(db: Db) {
  const rows = await db
    .select({ version: strategies.version, authoredBy: strategies.authoredBy, createdAt: strategies.createdAt, summary: strategies.summary })
    .from(strategies)
    .orderBy(desc(strategies.version));
  return [
    ...rows.map((r) => ({ version: r.version, authoredBy: r.authoredBy, createdAt: r.createdAt.toISOString(), summary: r.summary })),
    { version: 0, authoredBy: "system" as const, createdAt: null, summary: VERSION_0.summary },
  ];
}

/** One stored version's document, or null if there's no such version. */
export async function strategyVersion(db: Db, version: number) {
  if (version === 0) return { version: 0, authoredBy: "system" as const, createdAt: null, document: VERSION_0 };
  const [row] = await db.select().from(strategies).where(eq(strategies.version, version));
  if (!row) return null;
  const parsed = validateStrategy(row.document);
  return { version: row.version, authoredBy: row.authoredBy, createdAt: row.createdAt.toISOString(), document: parsed.ok ? parsed.strategy : row.document };
}

/** The activity timeline: the same feed Claude reads (get_activity), 1–90 days. */
export function activityView(db: Db, now: Date, days = 14) {
  return getActivity({ db, now }, days);
}

/** The Track record page: every thesis's return vs the same dollars in VTI (the same view Claude reads, get_track_record). */
export function trackRecordView(db: Db, now: Date) {
  return getTrackRecord({ db, now });
}

export interface ThesisVersion {
  version: number;
  createdAt: string;
  authoredBy: string;
  /** The thesis as this version lists it; null in the version that dropped it. */
  thesis: Thesis | null;
  /** What this version changed about the thesis ("added at 5%", "weight 6% → 8%", "reaffirmed", "removed"). */
  changes: string[];
}

/** What a version changed about a thesis, against the version before that listed it. */
export function thesisChanges(before: Thesis | null, after: Thesis | null): string[] {
  if (!after) return ["removed"];
  if (!before) return [`added at ${after.targetWeightPct}%`];
  const changes: string[] = [];
  if (before.id !== after.id) changes.push(`renamed ${before.id} → ${after.id}`);
  if (compare(before.targetWeightPct, after.targetWeightPct) !== 0) changes.push(`weight ${before.targetWeightPct}% → ${after.targetWeightPct}%`);
  if (compare(before.stopLossPct, after.stopLossPct) !== 0) changes.push(`stop ${before.stopLossPct}% → ${after.stopLossPct}%`);
  if (before.reviewBy !== after.reviewBy) changes.push(after.reviewBy ? `review by ${after.reviewBy}` : "review date dropped");
  if (JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)) changes.push("evidence updated");
  if (before.thesis !== after.thesis) changes.push("reasoning updated");
  if (before.plainSummary !== after.plainSummary) changes.push(after.plainSummary ? (before.plainSummary ? "plain summary updated" : "plain summary added") : "plain summary dropped");
  return changes.length ? changes : ["reaffirmed"];
}

/**
 * One thesis's page (#39): its track-record row, the price around it with
 * its fills, cost and stop, its reasoning and evidence, and every version
 * that listed it. Found by any id in its chain; null if no version lists it.
 * A thesis not bought yet has no row but still has its versions. The chart
 * covers `range` (#59), "since first held" by default.
 */
export async function thesisView(db: Db, id: string, now: Date, requested: ChartRange = "held") {
  const card = await loadScorecard(db, now);
  const row = card.theses.find((r) => r.ids.includes(id)) ?? null;
  const ids = new Set(row?.ids ?? [id]);

  // Past documents are read leniently, as the scorecard reads them.
  const versions = await db.select().from(strategies).orderBy(asc(strategies.version));
  const listed = (document: unknown) => {
    const conviction = (document as { conviction?: unknown } | null)?.conviction;
    return Array.isArray(conviction) ? ((conviction as Thesis[]).find((t) => typeof t?.id === "string" && ids.has(t.id)) ?? null) : null;
  };
  const history: ThesisVersion[] = [];
  let previous: Thesis | null = null;
  for (const v of versions) {
    const t = listed(v.document);
    if (!t && !previous) continue;
    history.push({ version: v.version, createdAt: v.createdAt.toISOString(), authoredBy: v.authoredBy, thesis: t, changes: thesisChanges(previous, t) });
    previous = t;
  }
  const latest = [...history].reverse().find((h) => h.thesis);
  if (!latest) return null;
  const thesis = latest.thesis!;
  const symbol = row?.symbol ?? thesis.symbol;

  const events = await db.select().from(thesisEvents).where(inArray(thesisEvents.thesisId, [...ids])).orderBy(asc(thesisEvents.at));
  const opened = row?.openedAt ?? new Date(history[0]!.createdAt);
  const end = row?.closedAt ?? now;
  // Enough closes for the longest range, or back to the first buy if that's earlier.
  const since = new Date(Math.min(opened.getTime(), end.getTime() - 380 * DAY_MS));
  const stored = await db
    .select({ date: thesisCloses.tradingDate, close: thesisCloses.close })
    .from(thesisCloses)
    .where(and(eq(thesisCloses.symbol, symbol), gte(thesisCloses.tradingDate, marketDate(since)), lte(thesisCloses.tradingDate, marketDate(end))))
    .orderBy(asc(thesisCloses.tradingDate));
  const dates = stored.map((c) => c.date);
  const heldFrom = marketDate(opened);
  const ranges = rangeOptions(THESIS_RANGES, dates, marketDate(end), heldFrom);
  const range = ranges.find((r) => r.range === requested)?.available ? requested : "held";
  const closes = stored.slice(windowBase(dates, rangeFrom(range, marketDate(end), heldFrom)) ?? 0);

  // Cost while held is the open lots' average (the stop's base, as holdings shows it); after, the average buy.
  const held = !!row && !row.closedAt;
  let cost: string | null = null;
  if (held) {
    cost = averageCost(buildLots(await loadActivities(db)).open, symbol);
  } else if (row) {
    const buys = row.fills.filter((f) => f.side === "buy");
    const qty = buys.reduce((sum, f) => add(sum, f.qty!), "0");
    cost = compare(qty, "0") > 0 ? div(buys.reduce((sum, f) => add(sum, mul(f.qty!, f.price!)), "0"), qty, 4, "half-even") : null;
  }
  const stopPrice = held && row.ending === "open" && cost ? div(mul(cost, sub("1", div(thesis.stopLossPct, "100", 12, "half-even"))), "1", 2, "half-even") : null;
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return {
    symbol,
    ids: row?.ids ?? [thesis.id],
    thesis,
    latestVersion: latest.version,
    score: row
      ? {
          primaryKind: row.primaryKind,
          ending: row.ending,
          openedAt: row.openedAt.toISOString(),
          leftAt: iso(row.leftAt),
          closedAt: iso(row.closedAt),
          daysHeld: row.daysHeld,
          qty: row.qty,
          money: row.money,
          unscored: row.unscored,
        }
      : null,
    markedAt: iso(card.markedAt),
    history: history.reverse(),
    events: events.map((e) => ({ kind: e.kind, thesisId: e.thesisId, reason: e.reason, at: e.at.toISOString() })),
    chart: {
      range,
      ranges,
      closes,
      fills: (row?.fills ?? []).map((f) => ({ at: f.at.toISOString(), date: marketDate(f.at), side: f.side!, qty: f.qty!, price: f.price! })),
      cost: cost === null ? null : div(cost, "1", 2, "half-even"),
      stopPrice,
      evidence: [...new Map(history.flatMap((h) => h.thesis?.evidence ?? []).filter((e) => e.asOf).map((e) => [`${e.asOf}|${e.summary}`, { date: e.asOf!, kind: e.kind, summary: e.summary }])).values()].sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

/**
 * The Money page (SPEC-capital): the ledger, the money-weighted comparison,
 * the open withdrawal with its timeline, and recent commands.
 */
export async function moneyView(db: Db, now: Date) {
  const account = (await db.select().from(brokerAccount).where(eq(brokerAccount.id, 1)))[0];
  const active = await activeStrategy(db, now);
  const equity = account?.equity ?? "0";
  const overview = await capitalOverview(db, { equity, cash: account?.cash ?? "0" }, active.reaffirmedAt);
  const ledger = await db.select().from(capitalFlows).orderBy(desc(capitalFlows.at)).limit(100);
  const open = overview?.withdrawal ? (await db.select().from(withdrawals).where(inArray(withdrawals.status, OPEN_STATUSES)).limit(1))[0] : undefined;
  const timeline = open
    ? await db.select().from(auditEvents).where(and(eq(auditEvents.subject, open.id), like(auditEvents.kind, "capital.%"))).orderBy(asc(auditEvents.at))
    : [];
  const commands = await db
    .select({ c: capitalCommands, r: capitalCommandResults })
    .from(capitalCommands)
    .leftJoin(capitalCommandResults, eq(capitalCommandResults.commandId, capitalCommands.id))
    .orderBy(desc(capitalCommands.at))
    .limit(10);
  const past = await db.select().from(withdrawals).where(inArray(withdrawals.status, ["withdrawn", "cancelled"])).orderBy(desc(withdrawals.requestedAt)).limit(10);
  return {
    equity,
    cash: account?.cash ?? "0",
    summary: overview?.summary ?? null,
    withdrawal: overview?.withdrawal ?? null,
    timeline: timeline.map((e) => ({ at: e.at.toISOString(), kind: e.kind, actor: e.actor, reason: typeof e.payload.reason === "string" ? e.payload.reason : null })),
    /** What the ready email said to withdraw (a few cents under the request when the sells came in short). */
    withdrawable: (() => {
      const ready = [...timeline].reverse().find((e) => e.kind === "capital.withdrawal_ready");
      return typeof ready?.payload.withdrawable === "string" ? ready.payload.withdrawable : (overview?.withdrawal?.outstanding ?? null);
    })(),
    ledger: ledger.map((f) => ({ at: f.at.toISOString(), amount: f.amount, kind: f.kind, status: f.status, approximate: f.timedBy === "booking_date" })),
    commands: commands.map(({ c, r }) => ({ at: c.at.toISOString(), kind: c.kind, amount: c.amount, requestedBy: c.requestedBy, outcome: r?.outcome ?? "pending", reason: r?.reason ?? null })),
    past: past.map((w) => ({ requestedAt: w.requestedAt.toISOString(), closedAt: w.closedAt?.toISOString() ?? null, amount: w.amount ?? "all", withdrawn: w.withdrawn, status: w.status })),
  };
}
