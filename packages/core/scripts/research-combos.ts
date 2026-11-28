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
import { type DailyBar, LONG_HORIZONS, cohortStats, outcomeAfter, outcomeAt, promotion } from "../src/research/backtest.js";
import { EVENT_KINDS, type EventKind, type SignalEvent, type SignalTimeline, activeSignals, buildTimeline, countSlope, daysBetween, eventActive, firstAnchors, freshCrash, pairEntries, qualityPercentile, screened } from "../src/research/combos.js";
import { HELD_OUT_FROM, SPECS, aboveAverage, assignDeciles, formationRows, momentumSignal, monthEnds } from "../src/research/momentum.js";
import { type FrameRow, type YearFrames, aprilFormation, frameRows, fundamentalsAt, percentileRanks, qualityMetrics } from "../src/research/quality.js";
import { CACHE, TRADABILITY, log, pct, writeReport } from "./research-common.js";
import { type Cohorts, type Groups, type Scored as ScoredOf, cohortTable, eventTable, promotionTable, yearTable } from "./research-tables.js";

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

// --- scoring and the five tests --------------------------------------------------------------
type Anchor = { symbol: string; date: string; kind?: EventKind; test: string; group: string };
type Scored = ScoredOf<Anchor>;

const barCache = new Map<string, DailyBar[] | null>();
const barsOf = (s: string) => {
  if (!barCache.has(s)) barCache.set(s, bars(s));
  return barCache.get(s)!;
};
/** Entered at the first close after the anchor became public, if tradable then and the bars aren't stale (as the 13D study). */
function score(a: Anchor): Scored | null {
  const b = barsOf(a.symbol);
  if (!b) return null;
  const o = outcomeAfter(a, a.date, b, vti, TRADABILITY, LONG_HORIZONS);
  if ("skip" in o) return null;
  return daysBetween(a.date, o.entryDate) > 7 ? null : o;
}
const indexOn = (b: DailyBar[], date: string) => {
  let i = -1;
  for (let k = b.length - 1; k >= 0; k--) if (b[k]!.date <= date) { i = k; break; }
  return i;
};

const COHORTS: Cohorts<Anchor> = { of: (o) => o.event.date.slice(0, 7), label: "Months", inSample: (o) => o.event.date < HELD_OUT_FROM };
const MIN_STD_ERRORS = 3;
const MIN_MONTHS = 8;
const LABEL: Record<EventKind, string> = { insider: "Insider cluster", thirteenF: "13F big new position", earnings: "Positive earnings reaction", stake: "Concentrated 13D/13G" };

/** A judged group's verdict: the promotion rule at 3 SE, or too few months to judge. */
function verdict(rows: Scored[]): string {
  const ins = rows.filter(COHORTS.inSample);
  const out = rows.filter((o) => !COHORTS.inSample(o));
  const x = { inSample60: cohortStats(ins, COHORTS.of, 60), heldOut60: cohortStats(out, COHORTS.of, 60), inSample120: cohortStats(ins, COHORTS.of, 120) };
  if (x.inSample60.cohorts < MIN_MONTHS) return `too few months to judge (${x.inSample60.cohorts} in-sample)`;
  const v = promotion(x, { minStdErrors: MIN_STD_ERRORS });
  return v.pass ? "**passes**" : `fails: ${v.failed.join(", ")}`;
}
const scoreAll = (anchors: Anchor[]) => anchors.map(score).filter((o): o is Scored => o !== null);
const byGroup = (rows: Scored[], order: string[]): Groups<Anchor> => order.map((g) => [g, rows.filter((o) => o.event.group === g)]);
const fromStart = (list: SignalEvent[]) => list.filter((e) => e.date >= FROM);
const slopeLine = (label: string, sl: ReturnType<typeof countSlope>) =>
  `${label}: ${sl.slope === null ? "–" : `${pct(sl.slope, 2)} per additional signal`} ± ${sl.stdError === null ? "–" : pct(sl.stdError, 2).replace(/^[+−]/, "")} (${sl.months} months${sl.slope !== null && sl.stdError ? `, ${(sl.slope / sl.stdError).toFixed(1)} SE` : ""})`;

function study(): void {
  const all: Scored[] = [];
  const sections: string[] = [];
  const judged: [string, string, string][] = [];
  const tables = (groups: Groups<Anchor>) =>
    [promotionTable(groups, COHORTS, { minStdErrors: MIN_STD_ERRORS }).table, "By month:", cohortTable(groups, COHORTS), "By event:", eventTable(groups), "Year by year (60-day mean, events):", yearTable(groups, (o) => o.event.date)].join("\n\n");

  // 1. Signal count: the first anchor per stock per 90 days, by how many other signals were active then.
  const countLabel = (n: number) => (n >= 3 ? "3+ other signals" : `${n} other signal${n === 1 ? "" : "s"}`);
  const t1 = scoreAll(
    firstAnchors(fromStart(events)).map((e) => {
      const n = activeSignals(timeline, e.symbol, e.date, e.kind).length;
      return { symbol: e.symbol, date: e.date, kind: e.kind, test: "1", group: countLabel(n), count: Math.min(n, 3) } as Anchor & { count: number };
    }),
  );
  all.push(...t1);
  const slopeRows = (rows: Scored[]) => rows.filter((o) => o.excess[60] !== null).map((o) => ({ month: COHORTS.of(o), count: (o.event as Anchor & { count: number }).count, value: o.excess[60]! }));
  const slopeIn = countSlope(slopeRows(t1.filter(COHORTS.inSample)));
  const slopeOut = countSlope(slopeRows(t1.filter((o) => !COHORTS.inSample(o))));
  const twoPlus = t1.filter((o) => (o.event as Anchor & { count: number }).count >= 2);
  const slopePasses = slopeIn.slope !== null && slopeIn.stdError !== null && slopeIn.slope >= MIN_STD_ERRORS * slopeIn.stdError && slopeIn.slope > 0 && (slopeOut.slope ?? -1) > 0;
  const twoPlusVerdict = verdict(twoPlus);
  judged.push(["1. Signal count", "slope across the count, and the 2+ group", slopePasses && twoPlusVerdict === "**passes**" ? "**passes**" : `fails (slope ${slopePasses ? "passes" : "fails"}; 2+ group: ${twoPlusVerdict})`]);
  sections.push(
    "## 1. Signal count (the headline)",
    "Each event signal is an anchor, counted by how many *other* signals were active on the stock then: events in the prior 90 days, momentum and quality as of their latest formation. One anchor per stock per 90 days.",
    `**The dose-response slope** (each month's slope of group means against the count, averaged; SE across months):\n- ${slopeLine("In-sample", slopeIn)}\n- ${slopeLine("Held out", slopeOut)}`,
    tables([...byGroup(t1, ["0 other signals", "1 other signal", "2 other signals", "3+ other signals"]), ["2+ other signals (judged)", twoPlus]]),
  );

  // 2. Two informed buyers: an insider cluster and a 13F big new position or a concentrated 13D/13G within 90 days, entered on the later.
  const pairs = firstAnchors([...pairEntries(timeline, "insider", "thirteenF"), ...pairEntries(timeline, "insider", "stake")].filter((p) => p.date >= FROM));
  const t2 = scoreAll([
    ...pairs.map((p) => ({ symbol: p.symbol, date: p.date, test: "2", group: "Insider cluster + 13F or 13D/13G (judged)" })),
    ...(["insider", "thirteenF", "stake"] as const).flatMap((k) => firstAnchors(fromStart(events.filter((e) => e.kind === k))).map((e) => ({ symbol: e.symbol, date: e.date, kind: k, test: "2", group: `${LABEL[k]}, all events` }))),
  ]);
  all.push(...t2.filter((o) => o.event.group.endsWith("(judged)")));
  judged.push(["2. Two informed buyers", "insider cluster + 13F or 13D/13G", verdict(t2.filter((o) => o.event.group.endsWith("(judged)")))]);
  sections.push(
    "## 2. Two informed buyers",
    `An insider cluster and a 13F big new position or a concentrated 13D/13G on the same stock within 90 days, entered when the second became public: ${pairs.length} pairs before tradability. Compared with each signal on its own (all its events, paired or not).`,
    tables(byGroup(t2, ["Insider cluster + 13F or 13D/13G (judged)", "Insider cluster, all events", "13F big new position, all events", "Concentrated 13D/13G, all events"])),
  );

  // 3. Insiders buying strength, not dips.
  const t3 = scoreAll(
    firstAnchors(fromStart(insider)).map((e) => {
      const b = barsOf(e.symbol) ?? [];
      const i = indexOn(b, e.date);
      const dip = i >= 60 && b[i]!.close / b[i - 60]!.close - 1 <= -0.2;
      const strength = eventActive(timeline, e.symbol, "earnings", e.date) || (i >= 0 && aboveAverage(b, i) === true);
      return { symbol: e.symbol, date: e.date, kind: "insider" as const, test: "3", group: dip ? "After a 20%+ drop (the dip)" : strength ? "After strength (judged)" : "Neither" };
    }),
  );
  all.push(...t3);
  judged.push(["3. Insiders buying strength", "insider clusters after strength", verdict(t3.filter((o) => o.event.group === "After strength (judged)"))]);
  sections.push(
    "## 3. Insiders buying strength, not dips",
    "Insider clusters split by what came just before: a 20%+ drop in the prior 60 sessions (the dip), else a positive earnings reaction within 90 days or a close above the 200-day average (strength), else neither. The groups don't overlap.",
    tables(byGroup(t3, ["After strength (judged)", "After a 20%+ drop (the dip)", "Neither"])),
  );

  // 4. Informed buyer plus quality.
  const t4 = scoreAll(
    firstAnchors(fromStart(events.filter((e) => e.kind !== "earnings"))).map((e) => {
      const q = qualityPercentile(timeline, e.symbol, e.date);
      return { symbol: e.symbol, date: e.date, kind: e.kind, test: "4", group: q === null ? "No quality data" : q >= 0.7 ? "Top 30% by gross profitability (judged)" : "Bottom 70%" };
    }),
  );
  all.push(...t4);
  judged.push(["4. Informed buyer plus quality", "top 30% by gross profitability", verdict(t4.filter((o) => o.event.group.endsWith("(judged)")))]);
  sections.push(
    "## 4. Informed buyer plus quality",
    "An insider cluster, 13F big new position or concentrated 13D/13G, by the stock's gross-profitability percentile at the latest April formation. The comparison is with stocks known to be in the bottom 70%; events with no quality data (smaller companies without the SEC figures, and January–April 2019) are their own row.",
    tables(byGroup(t4, ["Top 30% by gross profitability (judged)", "Bottom 70%", "No quality data"])),
  );

  // 5. Every signal with the warning screens applied.
  const flagged = (a: { symbol: string; date: string }) => bigLoser(a.symbol, a.date) || freshCrash(crashDates.get(a.symbol) ?? [], sessions, a.date);
  const t5: Scored[] = [];
  for (const k of EVENT_KINDS) {
    const anchors = firstAnchors(fromStart(events.filter((e) => e.kind === k)));
    t5.push(...scoreAll(anchors.map((e) => ({ symbol: e.symbol, date: e.date, kind: k, test: "5", group: `${LABEL[k]}, all` }))));
    const kept = scoreAll(screened(anchors, flagged).map((e) => ({ symbol: e.symbol, date: e.date, kind: k, test: "5", group: `${LABEL[k]}, screened (judged)` })));
    t5.push(...kept);
    judged.push([`5. ${LABEL[k]}, screened`, "without recent big losers and fresh earnings crashes", verdict(kept)]);
  }
  all.push(...t5.filter((o) => o.event.group.endsWith("(judged)")));
  sections.push(
    "## 5. Every signal with the warning screens applied",
    "Each event signal again, without recent big losers (a 12-1 month return of −30% or worse) and fresh earnings crashes (−10% or worse vs VTI within the last 10 sessions), next to the unscreened version.",
    tables(byGroup(t5, EVENT_KINDS.flatMap((k) => [`${LABEL[k]}, screened (judged)`, `${LABEL[k]}, all`]))),
  );

  const head = [
    `**Data:** the earlier studies' caches, offline. Anchors from ${FROM} to ${TO}. **In-sample:** events before ${HELD_OUT_FROM}; **held out:** from it. A month is one cohort: its events' mean counts once, so the standard error is across months.`,
    `**Promotion rule (fixed before any result, tasks/signal-combos-spec.md):** after a 0.2% round trip, the 60-day month-level excess over VTI is above zero in-sample at **${MIN_STD_ERRORS} standard errors or more** and above zero held out, and the in-sample 120-day mean doesn't reverse it. A group with fewer than ${MIN_MONTHS} in-sample months is reported but not judged. The headline also needs the dose-response slope positive at ${MIN_STD_ERRORS} SE in-sample and positive held out.`,
    "## Verdicts",
    ["| Test | Judged group | Verdict |", "|---|---|---|", ...judged.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`)].join("\n"),
  ];
  writeReport(values.report, "research:combos", [...head, ...sections].join("\n\n"));
  if (values.events) {
    const lines = ["test\tgroup\tsymbol\tdate\tentry\texcess20\texcess60\texcess120", ...all.map((o) => [o.event.test, o.event.group, o.event.symbol, o.event.date, o.entryDate, o.excess[20] ?? "", o.excess[60] ?? "", o.excess[120] ?? ""].join("\t"))];
    writeFileSync(values.events, `${lines.join("\n")}\n`);
    log(`wrote ${all.length} scored anchors to ${values.events}`);
  }
}

if (values["counts-only"]) counts();
else study();
