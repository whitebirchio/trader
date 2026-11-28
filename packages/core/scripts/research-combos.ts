/**
 * The signal-combination study (#140, tasks/signal-combos-spec.md): do signals
 * that agree beat VTI? Offline from the earlier studies' caches:
 * - insider and earnings events (.cache/*-outcomes.json);
 * - 13F and 13D/13G events (.cache/combos/);
 * - daily bars (.cache/bars/), and the SEC frames and raw April closes the
 *   quality study cached.
 * Read-only: no database, no orders.
 *
 *   npm run research:combos -w @trader/core -- --counts-only
 *   npm run research:combos -w @trader/core -- [--report ../../docs/research/signal-combos-vs-vti-2026-11.md] [--events file.tsv]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { SYMBOL } from "../src/portfolio/strategy.js";
import { type DailyBar, outcomeAt } from "../src/research/backtest.js";
import { type SignalEvent, type SignalTimeline, buildTimeline } from "../src/research/combos.js";
import { SPECS, assignDeciles, formationRows, momentumSignal, monthEnds } from "../src/research/momentum.js";
import { type FrameRow, type YearFrames, aprilFormation, frameRows, fundamentalsAt, percentileRanks, qualityMetrics } from "../src/research/quality.js";
import { CACHE, TRADABILITY, log } from "./research-common.js";

const { values } = parseArgs({ options: { "counts-only": { type: "boolean" }, report: { type: "string" }, events: { type: "string" } } });

/** Anchors from 2019 (quality's first formation); events from mid-2018 still count as active signals. */
export const FROM = "2019-01-01";
const LOOKBACK_FROM = "2018-07-01";
const TO = "2026-10-31";
const COMBOS = join(CACHE, "combos");

// --- bars --------------------------------------------------------------------------------
const barsFile = (s: string) => join(CACHE, "bars", `${s}.json`);
export const bars = (s: string): DailyBar[] | null =>
  existsSync(barsFile(s)) ? (JSON.parse(readFileSync(barsFile(s), "utf8")) as [string, number, number][]).map(([date, close, volume]) => ({ date, close, volume })) : null;
const vti = bars(BENCHMARK)!;
const sessions = vti.map((b) => b.date);

// --- the four event signals ----------------------------------------------------------------
interface InsiderOutcome { event: { ticker: string | null; lastFiled: string; buyers: number } }
interface EarningsOutcome { event: { ticker: string | null; reactionDate: string; reaction: number } }
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(CACHE, f), "utf8")) as T;
const tsv = (f: string): Record<string, string>[] => {
  const [head, ...lines] = readFileSync(join(COMBOS, f), "utf8").trim().split("\n");
  const cols = head!.split("\t");
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i]!, v])));
};
const inRange = (d: string) => d >= LOOKBACK_FROM && d <= TO;

const insider: SignalEvent[] = readJson<InsiderOutcome[]>("insider-outcomes.json")
  .filter((o) => o.event.ticker && o.event.buyers >= 2 && inRange(o.event.lastFiled))
  .map((o) => ({ symbol: o.event.ticker!, kind: "insider", date: o.event.lastFiled }));
const earningsAll = readJson<EarningsOutcome[]>("earnings-outcomes.json").filter((o) => o.event.ticker && inRange(o.event.reactionDate));
const earnings: SignalEvent[] = earningsAll.filter((o) => o.event.reaction >= 0.05).map((o) => ({ symbol: o.event.ticker!, kind: "earnings", date: o.event.reactionDate }));
/** Fresh-crash dates by symbol: an earnings-day return of −10% or worse vs VTI (a warning screen, not a signal). */
export const crashDates = new Map<string, string[]>();
for (const o of earningsAll) if (o.event.reaction <= -0.1) crashDates.set(o.event.ticker!, [...(crashDates.get(o.event.ticker!) ?? []), o.event.reactionDate].sort());
const thirteenF: SignalEvent[] = tsv("13f-events.tsv")
  .filter((r) => r.group === "rule" && r.kind === "newTop5" && r.ticker && inRange(r.filedOn!))
  .map((r) => ({ symbol: r.ticker!, kind: "thirteenF", date: r.filedOn! }));
const stake: SignalEvent[] = tsv("13d-13g-events.tsv")
  .filter((r) => r.concentrated === "yes" && r.ticker && inRange(r.filedOn!))
  .map((r) => ({ symbol: r.ticker!, kind: "stake", date: r.filedOn! }));
const events = [...insider, ...earnings, ...thirteenF, ...stake];

// --- momentum: the top decile of the 12-1 month return at each month-end ----------------------
const MOMENTUM_CACHE = join(COMBOS, "momentum-top.json");
function momentumTops(): SignalTimeline["momentum"] {
  if (existsSync(MOMENTUM_CACHE)) {
    const saved = JSON.parse(readFileSync(MOMENTUM_CACHE, "utf8")) as Record<string, string[]>;
    return { dates: Object.keys(saved).sort(), top: new Map(Object.entries(saved).map(([d, s]) => [d, new Set(s)])) };
  }
  const spec = SPECS[0]!; // 12-1 month, as the momentum study's headline
  const dates = monthEnds(sessions, LOOKBACK_FROM, TO);
  const symbols = readdirSync(join(CACHE, "bars")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((s) => s !== BENCHMARK);
  const rows = [];
  for (const [n, s] of symbols.entries()) {
    if (n % 2000 === 0) log(`momentum: ${n}/${symbols.length}`);
    rows.push(...formationRows(s, bars(s)!, vti, dates, spec, TRADABILITY));
  }
  const deciles = assignDeciles(rows);
  const top = new Map<string, Set<string>>(dates.map((d) => [d, new Set<string>()]));
  for (const [r, d] of deciles) if (d === 10) top.get(r.date)!.add(r.symbol);
  mkdirSync(COMBOS, { recursive: true });
  writeFileSync(MOMENTUM_CACHE, JSON.stringify(Object.fromEntries([...top].map(([d, s]) => [d, [...s]]))));
  return { dates, top };
}

// --- quality: gross-profitability percentile at each April formation ---------------------------
const frame = (concept: string): FrameRow[] => {
  const f = join(CACHE, "edgar-frames", `${concept.replaceAll("/", "_")}.json`);
  return existsSync(f) ? frameRows(JSON.parse(readFileSync(f, "utf8"))) : [];
};
const yearFrames = (y: number): YearFrames => ({
  grossProfit: frame(`us-gaap/GrossProfit/USD/CY${y}`),
  revenues: [frame(`us-gaap/Revenues/USD/CY${y}`), frame(`us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax/USD/CY${y}`)],
  costOfRevenue: [frame(`us-gaap/CostOfRevenue/USD/CY${y}`), frame(`us-gaap/CostOfGoodsAndServicesSold/USD/CY${y}`)],
  netIncome: frame(`us-gaap/NetIncomeLoss/USD/CY${y}`),
  assets: frame(`us-gaap/Assets/USD/CY${y}Q4I`),
  equity: frame(`us-gaap/StockholdersEquity/USD/CY${y}Q4I`),
  shares: [frame(`us-gaap/CommonStockSharesOutstanding/shares/CY${y}Q4I`), frame(`dei/EntityCommonStockSharesOutstanding/shares/CY${y + 1}Q1I`)],
});
function qualityPercentiles(): SignalTimeline["quality"] {
  const tickerByCik = new Map<number, string>();
  for (const r of Object.values(JSON.parse(readFileSync(join(CACHE, "edgar-submissions", "company_tickers.json"), "utf8")) as Record<string, { cik_str: number; ticker: string }>)) {
    const t = r.ticker.toUpperCase().replace("-", ".");
    if (!tickerByCik.has(r.cik_str) && SYMBOL.test(t)) tickerByCik.set(r.cik_str, t);
  }
  const dates: string[] = [];
  const pct = new Map<string, Map<string, number>>();
  for (let y = 2019; y <= Number(TO.slice(0, 4)); y++) {
    const formation = aprilFormation(sessions, y);
    if (!formation || formation > TO) continue;
    // As the quality study: tradable at the next close, gross profitability from the prior year's frames.
    const scored: { symbol: string; gp: number }[] = [];
    for (const [cik, f] of fundamentalsAt(yearFrames(y - 1), formation)) {
      const symbol = tickerByCik.get(cik);
      const b = symbol ? bars(symbol) : null;
      if (!symbol || !b) continue;
      let i = -1;
      for (let k = b.length - 1; k >= 0; k--) if (b[k]!.date <= formation) { i = k; break; }
      if (i < 0 || Date.parse(`${formation}T00:00:00Z`) - Date.parse(`${b[i]!.date}T00:00:00Z`) > 7 * 86_400_000) continue;
      if ("skip" in outcomeAt(null, b, i + 1, vti, TRADABILITY)) continue;
      const gp = qualityMetrics(f, null).grossProfitability;
      if (gp !== null) scored.push({ symbol, gp });
    }
    const ranks = percentileRanks(scored.map((s) => s.gp));
    pct.set(formation, new Map(scored.map((s, k) => [s.symbol, ranks[k]!])));
    dates.push(formation);
    log(`quality ${y} (formation ${formation}): ${scored.length} tradable companies ranked`);
  }
  return { dates, pct };
}

export const timeline = buildTimeline(events, momentumTops(), qualityPercentiles());
/** The recent-big-loser screen: a 12-1 month return of −30% or worse at the date (momentum.ts's signal). */
export function bigLoser(symbol: string, date: string): boolean {
  const b = bars(symbol);
  if (!b) return false;
  let i = -1;
  for (let k = b.length - 1; k >= 0; k--) if (b[k]!.date <= date) { i = k; break; }
  const r = i < 0 ? null : momentumSignal(b, i, 252, 21);
  return r !== null && r <= -0.3;
}

// --- the counts checkpoint ---------------------------------------------------------------
function counts(): void {
  const anchors = events.filter((e) => e.date >= FROM);
  const years = [...new Set(anchors.map((e) => e.date.slice(0, 4)))].sort();
  const lines = [`| Signal | ${years.join(" | ")} | Total | With cached bars |`, `|---|${years.map(() => "---:").join("|")}|---:|---:|`];
  for (const kind of ["insider", "thirteenF", "earnings", "stake"] as const) {
    const list = anchors.filter((e) => e.kind === kind);
    const withBars = list.filter((e) => existsSync(barsFile(e.symbol))).length;
    lines.push(`| ${kind} | ${years.map((y) => list.filter((e) => e.date.startsWith(y)).length).join(" | ")} | ${list.length} | ${withBars} (${Math.round((withBars / Math.max(1, list.length)) * 100)}%) |`);
  }
  console.log(lines.join("\n"));
  const mDates = timeline.momentum.dates;
  const perMonth = mDates.map((d) => timeline.momentum.top.get(d)!.size);
  console.log(`\nmomentum: ${mDates.length} month-ends (${mDates[0]} to ${mDates.at(-1)}); top decile ${Math.min(...perMonth)}–${Math.max(...perMonth)} stocks a month`);
  console.log(`quality: ${timeline.quality.dates.map((d) => `${d} ${timeline.quality.pct.get(d)!.size}`).join(", ")}`);
  const qualityKnown = anchors.filter((e) => {
    const asOf = timeline.quality.dates.filter((d) => d <= e.date).at(-1);
    return asOf && timeline.quality.pct.get(asOf)!.has(e.symbol);
  }).length;
  console.log(`quality known for ${qualityKnown} of ${anchors.length} event anchors (${Math.round((qualityKnown / anchors.length) * 100)}%); before the first April formation, none is`);
  console.log(`crash screen: ${[...crashDates.values()].reduce((a, d) => a + d.length, 0)} earnings-day crashes on ${crashDates.size} symbols`);
}

if (values["counts-only"]) counts();
