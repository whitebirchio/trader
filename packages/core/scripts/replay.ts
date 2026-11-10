/**
 * Replay a timeline through the real jobs and report on it (#57 T5): an
 * exported history (`replay:export`) or a timeline file, over cached market
 * data (`replay:data` fetches what's missing, with the paper key). Prints the
 * report and writes it, as text and JSON, to git-ignored
 * packages/core/.cache/replay/reports/. A history's report holds live
 * figures, so it stays local.
 *
 *   npm run replay -w @trader/core -- --timeline staging|production|<file> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--slippage-bps 10] [--compare-actual] [--variant stop=20]
 *
 * --compare-actual adds the fidelity check (T6): the replay set against what
 * the account actually did, from the timeline's `actual` (exported since T6),
 * written alongside as <name>-fidelity.txt.
 *
 * --variant kind=N (repeatable, applied in order; see src/replay/variants.ts)
 * also replays the timeline with every version transformed, on the same
 * market data, and prints the baseline-vs-variant diff (T7), written
 * alongside as <name>-<variant>-diff.txt with the variant's own report.
 *
 * --baseline-report <file.json> (with --variant) reads the baseline's report
 * from an earlier run instead of replaying it again: a long replay's
 * variants can then run side by side. A variant that finishes first waits
 * for the file.
 *
 * --rules insiders (T8, mode 2) replays a timeline written by a fixed rule
 * from the insider-buy backtest's cached events (`research:insiders` writes
 * .cache/insider-outcomes.json) instead of a recorded history: a weekly
 * version, $100,000 deposited at the start (--cash), halts resumed the next
 * session. Symbols with bars but no asset record, or a record Alpaca now
 * lists as inactive, are assumed listed.
 *
 * --from defaults to the timeline's first version (required with --rules),
 * --to to yesterday (the last session whose bars are complete).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadMarket } from "../src/replay/data.js";
import { replay } from "../src/replay/driver.js";
import { compareFidelity, formatFidelity } from "../src/replay/fidelity.js";
import { type ReplayReport, diffReports, formatDiff, formatReport, replayReport } from "../src/replay/report.js";
import { INSIDER_RULE, assumeListed, insiderSignals, insiderTimeline, matchesRule, weekStarts } from "../src/replay/rules.js";
import type { Timeline } from "../src/replay/timeline.js";
import { combineVariants, parseVariant } from "../src/replay/variants.js";
import { parseTimeline, readAccountHistory, timelineStart, timelineSymbols } from "../src/replay/timeline.js";
import { marketDate, marketTimeToUtc } from "../src/time.js";
import { CACHE } from "./research-common.js";
import { REPLAY_CACHE, paperMarketData } from "./replay-data.js";

const { values } = parseArgs({
  options: {
    timeline: { type: "string" },
    rules: { type: "string" },
    cash: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "slippage-bps": { type: "string" },
    "compare-actual": { type: "boolean" },
    variant: { type: "string", multiple: true },
    "baseline-report": { type: "string" },
  },
});
if (!values.timeline === !values.rules) throw new Error("pass one of --timeline staging|production|<file> or --rules insiders");
if (values.rules && values["compare-actual"]) throw new Error("--compare-actual needs a recorded history (--timeline), not --rules");
if (values.rules && values.rules !== "insiders") throw new Error(`unknown rules "${values.rules}"; expected insiders`);
if (values["baseline-report"] && !values.variant?.length) throw new Error("--baseline-report is for a --variant run");
if (values["baseline-report"] && values["compare-actual"]) throw new Error("--baseline-report skips the baseline replay that --compare-actual needs");
// Parsed before any replay runs, so an unknown variant fails fast.
const variant = values.variant?.length ? combineVariants(values.variant.map(parseVariant)) : null;
const slippageBps = values["slippage-bps"] === undefined ? 10 : Number(values["slippage-bps"]);
if (!Number.isInteger(slippageBps) || slippageBps < 0) throw new Error("--slippage-bps must be a whole number of basis points");
const to = values.to ?? marketDate(new Date(Date.now() - 86_400_000));
const loadOpts = { dir: REPLAY_CACHE, source: paperMarketData(), log: (m: string) => console.error(m) };

let file: string;
let timeline: Timeline;
let from: string;
let market: Awaited<ReturnType<typeof loadMarket>>["market"];
let missing: Awaited<ReturnType<typeof loadMarket>>["missing"];
/** The variant's timeline: a recorded one transformed, or a rule's written again with the variant's parameters. */
let variantVersions: (v: NonNullable<typeof variant>) => Timeline["versions"];
const warnings: string[] = [];
if (values.rules) {
  if (!values.from) throw new Error("--rules needs --from YYYY-MM-DD");
  from = values.from;
  file = `rules-${values.rules}`;
  const signals = insiderSignals(JSON.parse(readFileSync(join(CACHE, "insider-outcomes.json"), "utf8")) as unknown[]).filter((s) => matchesRule(s, INSIDER_RULE));
  const weekBefore = new Date(Date.parse(`${from}T12:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const symbols = ["VTI", ...new Set(signals.filter((s) => s.entryDate >= weekBefore && s.entryDate <= to).map((s) => s.ticker))];
  ({ market, missing } = await loadMarket(symbols, from, to, loadOpts));
  const listed = assumeListed(market);
  market = listed.market;
  if (listed.assumed.length) warnings.push(`${listed.assumed.length} symbol(s) with bars but no asset record, or one Alpaca now lists as inactive (delisted or renamed since), were assumed active, tradable and fractionable.`);
  if (missing.bars.length) warnings.push(`${missing.bars.length} signal symbol(s) have no bars at all and can't be bought: the survivorship gap, as in the backtest.`);
  const sessions = market.calendar.filter((d) => d.date >= from && d.date <= to).map((d) => d.date);
  const weeks = weekStarts(sessions);
  const versions = insiderTimeline(signals, weeks);
  variantVersions = (v) => insiderTimeline(signals, weeks, v.rule(INSIDER_RULE));
  timeline = { env: file, exportedAt: new Date().toISOString(), versions, transfers: [{ at: marketTimeToUtc(sessions[0]!, "08:00"), amount: values.cash ?? "100000" }] };
} else {
  file = values.timeline === "staging" || values.timeline === "production" ? join(REPLAY_CACHE, `timeline-${values.timeline}.json`) : values.timeline!;
  timeline = parseTimeline(readFileSync(file, "utf8"));
  if (values["compare-actual"] && !timeline.actual) throw new Error(`${file} has no actual history (exported before T6): run replay:export again`);
  const start = values.from ?? timelineStart(timeline);
  if (!start) throw new Error(`${file} has no strategy versions; pass --from`);
  from = start;
  ({ market, missing } = await loadMarket(timelineSymbols(timeline), from, to, loadOpts));
  variantVersions = (v) => v.apply(timeline.versions);
}
if (missing.bars.length || missing.assets.length) console.error(`missing bars: ${missing.bars.length}; missing assets: ${missing.assets.length}`);
/** A line every quarter or so, with the pace, so a multi-year replay shows where it is. */
const progress = (label: string) => {
  const t0 = Date.now();
  return (date: string, done: number, total: number) => {
    if (done % 63 === 0 || done === total) console.error(`${label}: ${date} (${done}/${total} sessions, ${Math.round((Date.now() - t0) / 1000)}s)`);
  };
};
// Rule-based replays resume after a halt (a crash would otherwise freeze every variant alike); recorded histories freeze, as live.
const autoResume = !!values.rules;
const started = Date.now();

const dir = join(REPLAY_CACHE, "reports");
mkdirSync(dir, { recursive: true });
const name = `${basename(file, ".json").replace(/^timeline-/, "")}-${from}-${to}-${slippageBps}bps`;
/** A fresh on-disk directory for one replay's database: in memory, a multi-year run takes several GB of RAM. Removed after. */
const dataDir = (label: string) => {
  const d = join(REPLAY_CACHE, "pgdata", `${name}-${label.replace(/[^a-z0-9.=-]+/gi, "_")}`);
  rmSync(d, { recursive: true, force: true }); // left by a run that crashed
  mkdirSync(d, { recursive: true });
  return d;
};
// With --baseline-report, the baseline is read once the variant has replayed (it may still be running when the variant starts).
let report: ReplayReport | null = null;
let fidelity: string | null = null;
if (!values["baseline-report"]) {
  const baseDir = dataDir("baseline");
  const result = await replay({ market, versions: timeline.versions, transfers: timeline.transfers, from, to, slippageBps, autoResume, dataDir: baseDir, onSession: progress("baseline") });
  report = await replayReport(result, { from, to, slippageBps });
  report.warnings.push(...warnings);
  console.error(`replayed ${result.sessions} sessions in ${Math.round((Date.now() - started) / 1000)}s`);
  const sessions = market.calendar.filter((d) => d.date >= from && d.date <= to).map((d) => d.date);
  if (values["compare-actual"]) fidelity = formatFidelity(compareFidelity({ live: timeline.actual!, replay: await readAccountHistory(result.db), flows: timeline.transfers, sessions, bars: market.bars }));
  await result.pglite.close();
  rmSync(baseDir, { recursive: true, force: true });
  const text = formatReport(report);
  writeFileSync(join(dir, `${name}.txt`), text);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(report, null, 2));
  console.log(text);
  console.log(`→ ${join(dir, `${name}.txt`)} (and .json)`);
}
if (variant) {
  const variantDir = dataDir(variant.name);
  const varied = await replay({ market, versions: variantVersions(variant), transfers: timeline.transfers, from, to, slippageBps, autoResume, dataDir: variantDir, onSession: progress(variant.name) });
  const variantReport = await replayReport(varied, { from, to, slippageBps });
  variantReport.warnings.push(...warnings);
  await varied.pglite.close();
  rmSync(variantDir, { recursive: true, force: true });
  const slug = variant.name.replace(/[^a-z0-9.=-]+/gi, "_");
  writeFileSync(join(dir, `${name}-${slug}.txt`), formatReport(variantReport));
  writeFileSync(join(dir, `${name}-${slug}.json`), JSON.stringify(variantReport, null, 2));
  if (!report) {
    const baseFile = values["baseline-report"]!;
    while (!existsSync(baseFile)) {
      console.error(`waiting for the baseline's report: ${baseFile}`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
    report = JSON.parse(readFileSync(baseFile, "utf8")) as ReplayReport;
  }
  const diff = formatDiff(diffReports(report, variantReport, variant.name));
  writeFileSync(join(dir, `${name}-${slug}-diff.txt`), diff);
  console.log(`\n${diff}`);
  console.log(`→ ${join(dir, `${name}-${slug}-diff.txt`)} (the variant's report: ${name}-${slug}.txt)`);
}
if (fidelity) {
  writeFileSync(join(dir, `${name}-fidelity.txt`), fidelity);
  console.log(`\n${fidelity}`);
  console.log(`→ ${join(dir, `${name}-fidelity.txt`)}`);
}
