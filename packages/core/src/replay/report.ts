import { asc } from "drizzle-orm";
import { loadActivities } from "../broker/activities.js";
import { buildLots, isLongTerm } from "../broker/lots.js";
import { performanceSeries } from "../dashboard/views.js";
import { equitySnapshots, riskDecisions, thesisEvents } from "../db/schema.js";
import { add, compare, div, mul, round, toBig } from "../money.js";
import { WASH_SALE_DAYS } from "../portfolio/planner.js";
import { type ScorecardRollUp, loadScorecard } from "../portfolio/scorecard.js";
import type { BenchmarkComparison } from "../portfolio/benchmark.js";
import type { Verdict } from "../risk/types.js";
import { marketDate } from "../time.js";
import { type ReplayResult, STEPS } from "./driver.js";

/**
 * The replay's report (#57 T5): what a replay did, read from its database
 * with the readers the dashboard, digest and weekly letter use
 * (performanceSeries, loadScorecard, the FIFO lots), so a replay's numbers
 * mean what the live ones do. It states its assumptions and flags samples
 * too small to read much into.
 */

export interface ReportOptions {
  from: string;
  to: string;
  slippageBps: number;
}

export interface ReportThesis {
  ids: string[];
  symbol: string;
  ending: string;
  daysHeld: number;
  /** Null when the scorecard couldn't score it. */
  returnPct: string | null;
  vtiPct: string | null;
  excessPct: string | null;
}

export interface ReplayReport {
  window: { from: string; to: string; sessions: number };
  assumptions: string[];
  /** Small samples and anything else that limits what the figures say. */
  warnings: string[];
  /** Flow-adjusted portfolio vs VTI over the replay; null with fewer than two snapshots. */
  performance: BenchmarkComparison | null;
  scorecard: { overall: ScorecardRollUp; theses: ReportThesis[] };
  trades: { fills: number; buys: number; sells: number; bought: string; sold: string; turnoverPct: string | null };
  realized: { shortTerm: string; longTerm: string };
  /** Buys of a symbol within 30 days after selling it at a loss: the loss is disallowed. */
  washSales: { symbol: string; soldAt: Date; loss: string; rebuyAt: Date }[];
  thesisExits: { kind: string; thesisId: string; symbol: string; at: Date }[];
  risk: { decisions: Record<Verdict, number>; reasons: { reason: string; count: number }[] };
  halts: ReplayResult["halts"];
  rejectedVersions: ReplayResult["rejectedVersions"];
  transferShortfalls: ReplayResult["transferShortfalls"];
  msPerSession: number;
}

const DAY_MS = 86_400_000;
const SMALL_SESSIONS = 63; // about a quarter
const SMALL_THESES = 10;

/** Dollars to two places, padded ("0.00", "-12.50"). */
const cents = (v: string) => toBig(round(v, 2, "half-even")).toFixed(2);
const usd = (v: string) => (v.startsWith("-") ? `-$${v.slice(1)}` : `$${v}`);

/** A risk reason with its figures masked, so the same rule's reasons group together. */
const reasonPattern = (reason: string) => reason.replace(/-?\$?\d[\d,]*(\.\d+)?%?/g, "#");

export async function replayReport(r: ReplayResult, opts: ReportOptions): Promise<ReplayReport> {
  const asOf = r.broker.now;
  const [perf, card, activities, snapshots, events, decisions] = await Promise.all([
    performanceSeries(r.db),
    loadScorecard(r.db, asOf),
    loadActivities(r.db),
    r.db.select({ equity: equitySnapshots.equity }).from(equitySnapshots),
    r.db.select().from(thesisEvents).orderBy(asc(thesisEvents.at)),
    r.db.select({ verdict: riskDecisions.verdict, reasons: riskDecisions.reasons }).from(riskDecisions),
  ]);

  const fills = activities.filter((a) => a.type === "FILL" && a.qty && a.price);
  const notional = (side: "buy" | "sell") => cents(fills.filter((f) => f.side === side).reduce((s, f) => add(s, mul(f.qty!, f.price!)), "0"));
  const sold = notional("sell");
  const funded = snapshots.filter((s) => compare(s.equity, "0") > 0);
  const averageEquity = funded.length ? div(funded.reduce((s, x) => add(s, x.equity), "0"), String(funded.length), 2, "half-even") : null;

  const lots = buildLots(activities);
  const gains = (long: boolean) => cents(lots.closed.filter((c) => isLongTerm(c.openedAt, c.closedAt) === long).reduce((s, c) => add(s, c.gain), "0"));
  const washSales = lots.closed
    .filter((c) => compare(c.gain, "0") < 0)
    .flatMap((c) => {
      const rebuy = fills.find((f) => f.side === "buy" && f.symbol === c.symbol && f.at > c.closedAt && f.at.getTime() - c.closedAt.getTime() <= WASH_SALE_DAYS * DAY_MS);
      return rebuy ? [{ symbol: c.symbol, soldAt: c.closedAt, loss: cents(c.gain), rebuyAt: rebuy.at }] : [];
    });

  const counts: Record<Verdict, number> = { approved: 0, clipped: 0, rejected: 0 };
  const reasons = new Map<string, number>();
  for (const d of decisions) {
    counts[d.verdict as Verdict] = (counts[d.verdict as Verdict] ?? 0) + 1;
    if (d.verdict !== "approved") for (const reason of d.reasons) reasons.set(reasonPattern(reason), (reasons.get(reasonPattern(reason)) ?? 0) + 1);
  }

  const scored = card.theses.filter((t) => t.money).length;
  const warnings = [
    ...(r.sessions < SMALL_SESSIONS ? [`Only ${r.sessions} sessions: too short for returns to say much about skill.`] : []),
    ...(scored < SMALL_THESES ? [`Only ${scored} scored theses: too few to compare thesis returns with VTI.`] : []),
    ...(r.rejectedVersions.length ? [`${r.rejectedVersions.length} version(s) today's code can't read were replayed as version 0 (all VTI).`] : []),
    ...(r.transferShortfalls.length ? [`${r.transferShortfalls.length} withdrawal(s) exceeded the replay's cash: holdings differ from history after them.`] : []),
  ];

  return {
    window: { from: opts.from, to: opts.to, sessions: r.sessions },
    assumptions: [
      `Orders fill at the session's open (daily bars hold no other intraday price), with ${opts.slippageBps} bps slippage against the trade.`,
      `Steps per session (ET): ${STEPS.map((s) => s.time).join(", ")}. Live runs every 15 minutes; a version after the last trading step waits for the next session.`,
      "Stops check the latest price, which in the replay is the session's open at every step (live: the latest trade, every 15 minutes). A move through a stop that recovers by the next open goes unseen.",
      "No dividends or corporate actions: adjusted bars stand in for them.",
      "Withdrawal requests aren't replayed, only completed transfers, so no cash is held back for an open request.",
    ],
    warnings,
    performance: perf.totals,
    scorecard: {
      overall: card.overall,
      theses: card.theses.map((t) => ({ ids: t.ids, symbol: t.symbol, ending: t.ending, daysHeld: t.daysHeld, returnPct: t.money?.returnPct ?? null, vtiPct: t.money?.vtiPct ?? null, excessPct: t.money?.excessPct ?? null })),
    },
    trades: {
      fills: fills.length,
      buys: fills.filter((f) => f.side === "buy").length,
      sells: fills.filter((f) => f.side === "sell").length,
      bought: notional("buy"),
      sold,
      turnoverPct: averageEquity && compare(averageEquity, "0") > 0 ? div(mul(sold, "100"), averageEquity, 1, "half-even") : null,
    },
    realized: { shortTerm: gains(false), longTerm: gains(true) },
    washSales,
    thesisExits: events.map((e) => ({ kind: e.kind, thesisId: e.thesisId, symbol: e.symbol, at: e.at })),
    risk: { decisions: counts, reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) },
    halts: r.halts,
    rejectedVersions: r.rejectedVersions,
    transferShortfalls: r.transferShortfalls,
    msPerSession: r.msPerSession,
  };
}

const signed = (pct: string) => (pct.startsWith("-") ? pct : `+${pct}`);

/** The report as plain text, for the terminal and the report file. */
export function formatReport(report: ReplayReport): string {
  const lines: string[] = [];
  const section = (title: string) => lines.push("", title);
  lines.push(`Replay ${report.window.from} → ${report.window.to}: ${report.window.sessions} sessions, ${report.msPerSession} ms per session`);

  section("Performance (flow-adjusted)");
  const p = report.performance;
  lines.push(p ? `  Portfolio ${signed(p.portfolioPct)}%  vs  VTI ${signed(p.benchmarkPct)}%  (${p.since} → ${p.through})` : "  Not enough snapshots to compare.");

  section("Theses vs the same dollars in VTI");
  const o = report.scorecard.overall;
  lines.push(`  ${o.theses} theses, ${o.scored} scored, ${o.closed} closed; excess ${o.excessPct === null ? "-" : `${signed(o.excessPct)}%`} of ${usd(cents(o.bought))} bought; beat VTI ${o.beatVtiPct ?? "-"}%; median ${o.medianDaysHeld ?? "-"} days held`);
  for (const t of report.scorecard.theses) {
    const money = t.returnPct === null ? "unscored" : `${signed(t.returnPct)}% vs VTI ${signed(t.vtiPct!)}% (excess ${signed(t.excessPct!)}%)`;
    lines.push(`  ${t.symbol.padEnd(6)} ${t.ending.padEnd(8)} ${String(t.daysHeld).padStart(4)}d  ${money}  ${t.ids.join(", ")}`);
  }

  section("Trading");
  const tr = report.trades;
  lines.push(`  ${tr.fills} fills (${tr.buys} buys, ${tr.sells} sells); bought ${usd(tr.bought)}, sold ${usd(tr.sold)}; turnover ${tr.turnoverPct ?? "-"}% of average equity`);
  lines.push(`  Realized: short-term ${usd(report.realized.shortTerm)}, long-term ${usd(report.realized.longTerm)}`);
  lines.push(`  Wash sales: ${report.washSales.length || "none"}`);
  for (const w of report.washSales) lines.push(`    ${w.symbol} sold at a ${usd(w.loss.slice(1))} loss on ${marketDate(w.soldAt)}, bought back ${marketDate(w.rebuyAt)}`);

  section("Thesis exits");
  if (report.thesisExits.length === 0) lines.push("  none");
  for (const e of report.thesisExits) lines.push(`  ${marketDate(e.at)}  ${e.kind.padEnd(8)} ${e.symbol.padEnd(6)} ${e.thesisId}`);

  section("Risk");
  const d = report.risk.decisions;
  lines.push(`  ${d.approved} approved, ${d.clipped} clipped, ${d.rejected} rejected`);
  for (const r of report.risk.reasons) lines.push(`  ${String(r.count).padStart(4)} × ${r.reason}`);
  lines.push(`  Halts: ${report.halts.length ? report.halts.map((h) => `${h.date} (${h.reason}${h.resumed ? "; resumed" : ""})`).join("; ") : "none"}`);

  if (report.rejectedVersions.length || report.transferShortfalls.length) {
    section("History the replay couldn't follow");
    for (const v of report.rejectedVersions) lines.push(`  v${v.version ?? "?"} (${marketDate(v.at)}) read as version 0: ${v.errors.slice(0, 3).join("; ")}`);
    for (const t of report.transferShortfalls) lines.push(`  ${marketDate(t.at)} withdrawal of ${usd(cents(t.amount.replace("-", "")))} short by ${usd(cents(t.shortfall))}`);
  }

  section("Assumptions");
  for (const a of report.assumptions) lines.push(`  - ${a}`);
  if (report.warnings.length) {
    section("Read with care");
    for (const w of report.warnings) lines.push(`  ! ${w}`);
  }
  return `${lines.join("\n")}\n`;
}
