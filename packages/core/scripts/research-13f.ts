/**
 * The 13F backtest, Part 1 (#138, tasks/13f-backtest-plan.md): download SEC's
 * Form 13F Data Sets, pick the concentrated managers each quarter, score their
 * filings' events against VTI, and write the report. Read-only: no database,
 * no orders.
 *
 *   npm run research:13f -w @trader/core -- [--from 2016q1] [--to 01jun2026-31aug2026] [--report ../../docs/research/….md] [--events file.tsv] [--extract-only] [--prune] [--clean]
 *
 * Everything stays on disk under packages/core/.cache/edgar13f/ (git-ignored):
 * each window's zip (about 45–100 MB) is downloaded straight to a file, its
 * tables are streamed out of it with `unzip -p`, and the filings that matter
 * are kept as compact per-quarter files (filings/<quarter>/<window>.json.gz).
 * A re-run reuses them and is offline apart from new bars and CUSIPs.
 *
 * CUSIPs are mapped to tickers through OpenFIGI, falling back to SEC's
 * fails-to-deliver data (one zip per half-month from 2018, each deleted once
 * read into .cache/edgar13f/ftd-symbols.json).
 *
 * --extract-only downloads and extracts, and stops before scoring.
 * --events writes every scored event (for spot checks against sec.gov).
 * --prune deletes the zips once their filings are extracted (a later
 * extraction would download them again). --clean deletes .cache/edgar13f
 * entirely: do that once Part 2 (research:13d), which reads the manager sets
 * written here, is done.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import {
  type DailyBar,
  LONG_HORIZONS,
  cohortStats,
  outcomeAfter,
} from "../src/research/backtest.js";
import { parseTsv } from "../src/research/insider-backtest.js";
import { HELD_OUT_FROM } from "../src/research/momentum.js";
import {
  type EventKind,
  type Filing,
  type FilingMeta,
  NAMED_MANAGERS,
  type ThirteenFEvent,
  consensusEvents,
  filingBuilder,
  managerSet,
  namedSet,
  type FtdSymbol,
  ftdLinks,
  ftdRow,
  noteSymbol,
  resolveTicker,
  positionEvents,
  quarterOf,
  shareRatios,
  windowLinks,
  windowMeta,
} from "../src/research/thirteen-f.js";
import { CACHE, SecRefused, TRADABILITY, barsFor, log, pct, secDownload, secText, writeReport } from "./research-common.js";
import { type Cohorts, type Scored as ScoredOf, cohortTable, eventTable, mapCusips, median, promotionTable, yearTable } from "./research-tables.js";

const { values } = parseArgs({
  options: { from: { type: "string" }, to: { type: "string" }, report: { type: "string" }, events: { type: "string" }, "extract-only": { type: "boolean" }, prune: { type: "boolean" }, clean: { type: "boolean" } },
});

const ROOT = join(CACHE, "edgar13f");
const ZIPS = join(ROOT, "zips");
const FILINGS = join(ROOT, "filings");
const DONE = join(ROOT, "done");
const PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
/** Filings with more table rows than this can't be concentrated (sub-manager splits add rows, so this is generous). */
const KEEP_ENTRIES = 300;
/** …and with more positions than this, after options and splits are dropped, aren't kept (they can't pass the rule). */
const KEEP_POSITIONS = 100;
/** Events are scored from filings made from this date: 2016–2017 give the first manager sets their history. */
const SCORE_FROM = "2018-01-01";
/** A filing period's last day to the first bar: more than this and the bars are some later listing's. */
const MAX_ENTRY_GAP_DAYS = 7;
const HISTORY_QUARTERS = 9;

const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

type Window = ReturnType<typeof windowLinks>[number];

/** Stream one table out of a zip, line by line, handing on rows whose accession is kept. */
async function streamRows(zip: string, table: string, keep: Map<string, FilingMeta>, onRow: (row: Record<string, string>) => void): Promise<number> {
  // stdin closed: unzip can otherwise sit waiting after it's done.
  const child = spawn("unzip", ["-p", zip, `*${table}.tsv`], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let header: string[] | null = null;
  let rows = 0;
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!header) {
      header = line.split("\t");
      continue;
    }
    rows++;
    if (!keep.has(line.slice(0, line.indexOf("\t")))) continue;
    const cells = line.split("\t");
    onRow(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  }
  const code = await closed;
  if (code !== 0) throw new Error(`unzip -p ${zip} ${table}: exit ${code}`);
  return rows;
}

interface WindowSummary {
  name: string;
  originals: number;
  kept: number;
  amendments: number;
  late: number;
  unitsCorrected: number;
  filers: string[];
}

type Compact = { a: string; c: string; m: string; p: string; f: string; u?: 1; h: [string, string, number, number][] };

/** Download a window's zip and extract the filings that matter into per-quarter files. */
async function extract(w: Window): Promise<void> {
  if (existsSync(join(DONE, w.name))) return;
  const zip = join(ZIPS, `${w.name}_form13f.zip`);
  if (!existsSync(zip)) log(`downloading ${w.name} …`);
  await secDownload(`https://www.sec.gov${w.path}`, zip);
  const small = (table: string) => parseTsv(execFileSync("unzip", ["-p", zip, `*${table}.tsv`], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }).toString("utf8"));
  const meta = windowMeta({ submissions: small("SUBMISSION"), covers: small("COVERPAGE"), summaries: small("SUMMARYPAGE") });
  const keep = new Map(meta.originals.filter((f) => f.entries <= KEEP_ENTRIES || NAMED_MANAGERS[f.cik]).map((f) => [f.accession, f]));
  const builder = filingBuilder(keep);
  const rows = await streamRows(zip, "INFOTABLE", keep, (row) => builder.add(row));
  const filings = builder.filings().filter((f) => f.positions.length > 0 && (f.positions.length <= KEEP_POSITIONS || NAMED_MANAGERS[f.cik]));

  const byQuarter = new Map<string, Compact[]>();
  for (const f of filings) {
    const q = quarterOf(f.period);
    const list = byQuarter.get(q) ?? [];
    list.push({ a: f.accession, c: f.cik, m: f.manager, p: f.period, f: f.filedOn, ...(f.unitsCorrected ? { u: 1 as const } : {}), h: f.positions.map((p) => [p.cusip, p.issuer, p.value, p.shares]) });
    byQuarter.set(q, list);
  }
  for (const [q, list] of byQuarter) {
    mkdirSync(join(FILINGS, q), { recursive: true });
    writeFileSync(join(FILINGS, q, `${w.name}.json.gz`), gzipSync(JSON.stringify(list)));
  }
  const summary: WindowSummary = {
    name: w.name,
    originals: meta.originals.length,
    kept: filings.length,
    amendments: meta.amendments,
    late: meta.late,
    unitsCorrected: filings.filter((f) => f.unitsCorrected).length,
    filers: meta.filers,
  };
  mkdirSync(join(ROOT, "windows"), { recursive: true });
  writeFileSync(join(ROOT, "windows", `${w.name}.json`), JSON.stringify(summary));
  mkdirSync(DONE, { recursive: true });
  writeFileSync(join(DONE, w.name), "");
  log(`${w.name}: ${rows.toLocaleString()} rows → ${filings.length} filings kept of ${meta.originals.length}`);
}

/** A quarter's filings from the selected windows; a manager's earliest-filed original wins. */
function loadQuarter(q: string, windows: Set<string>): Filing[] {
  const dir = join(FILINGS, q);
  if (!existsSync(dir)) return [];
  const byManager = new Map<string, Filing>();
  for (const file of readdirSync(dir).sort()) {
    if (!windows.has(file.replace(/\.json\.gz$/, ""))) continue;
    for (const c of JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString("utf8")) as Compact[]) {
      const f: Filing = { accession: c.a, cik: c.c, manager: c.m, period: c.p, filedOn: c.f, ...(c.u ? { unitsCorrected: true as const } : {}), positions: c.h.map(([cusip, issuer, value, shares]) => ({ cusip, issuer, value, shares })) };
      const had = byManager.get(f.cik);
      if (!had || f.filedOn < had.filedOn) byManager.set(f.cik, f);
    }
  }
  return [...byManager.values()];
}

type Group = "rule" | "named";
interface Tagged extends ThirteenFEvent {
  group: Group;
}

/** Each manager set and its events, quarter by quarter, holding only the recent history in memory. */
function findEvents(quarters: string[], windows: Set<string>) {
  const events: Tagged[] = [];
  const sets: Record<string, string[]> = {};
  const lags: number[] = [];
  let previous: Filing[] = [];
  const history = new Map<string, Filing[]>();
  for (const q of quarters) {
    const filings = loadQuarter(q, windows);
    const heldBefore = new Set(previous.flatMap((f) => f.positions.map((p) => p.cusip)));
    const ratios = shareRatios(filings, previous);
    const before = new Map(previous.map((f) => [f.cik, f]));
    const set = managerSet(filings, history);
    sets[q] = set.map((f) => f.cik).sort();
    const ruleEvents = set.flatMap((f) => positionEvents(f, before.get(f.cik), heldBefore, ratios));
    for (const f of set) lags.push(days(f.period, f.filedOn));
    events.push(...[...ruleEvents, ...consensusEvents(ruleEvents)].map((e) => ({ ...e, group: "rule" as const })));
    events.push(...namedSet(filings).flatMap((f) => positionEvents(f, before.get(f.cik), heldBefore, ratios)).map((e) => ({ ...e, group: "named" as const })));
    for (const f of filings) {
      const list = [...(history.get(f.cik) ?? []), f].slice(-HISTORY_QUARTERS);
      history.set(f.cik, list);
    }
    previous = filings;
    log(`${q}: ${filings.length} filings, ${set.length} concentrated managers, ${ruleEvents.length} events`);
  }
  return { events, sets, lags };
}

const FTD_PAGE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data";
const FTD_FROM = "cnsfails201801a";

/** Each CUSIP's latest symbol in SEC's fails-to-deliver data; each zip is streamed, then deleted. */
async function ftdSymbols(): Promise<Map<string, FtdSymbol>> {
  const file = join(ROOT, "ftd-symbols.json");
  const cache: { processed: string[]; latest: Record<string, FtdSymbol> } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { processed: [], latest: {} };
  const latest = new Map(Object.entries(cache.latest));
  const done = new Set(cache.processed);
  const links = ftdLinks(await secText(FTD_PAGE, join(ROOT, "ftd-index.html"), 1)).filter((l) => l.name >= FTD_FROM && !done.has(l.name));
  for (const [i, l] of links.entries()) {
    const zip = join(ROOT, "ftd", `${l.name}.zip`);
    await secDownload(`https://www.sec.gov${l.path}`, zip);
    const child = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
      const row = ftdRow(line);
      if (row) noteSymbol(latest, row);
    }
    if ((await closed) !== 0) throw new Error(`unzip -p ${zip}: failed`);
    rmSync(zip);
    done.add(l.name);
    if (i % 20 === 19 || i === links.length - 1) {
      writeFileSync(file, JSON.stringify({ processed: [...done].sort(), latest: Object.fromEntries(latest) }));
      log(`fails data: ${i + 1}/${links.length} files read`);
    }
  }
  return latest;
}

type Scored = ScoredOf<Tagged>;
type Skip = "unmapped" | "fund or ETF" | "no bars" | "no entry" | "untradable" | "no VTI" | "stale bars";

type Tickers = Map<string, ReturnType<typeof resolveTicker>>;

function score(e: Tagged, after: string, tickers: Tickers, bars: Map<string, DailyBar[]>, vti: DailyBar[]): Scored | Skip {
  const t = tickers.get(e.cusip);
  if (!t?.ticker) return "unmapped";
  if (t.excluded) return "fund or ETF";
  const o = outcomeAfter(e, after, bars.get(t.ticker) ?? [], vti, TRADABILITY, LONG_HORIZONS);
  if ("skip" in o) return o.skip;
  return days(after, o.entryDate) > MAX_ENTRY_GAP_DAYS ? "stale bars" : o;
}

const KINDS: [EventKind, string][] = [
  ["new", "New position"],
  ["add", "Large add (shares +25%)"],
  ["best", "Best idea (largest position)"],
  ["top3", "Top 3"],
  ["newTop5", "New in top 5 (5%+ of the book)"],
  ["consensus", "Consensus (2+ managers)"],
];
const cohortOf = (o: Scored) => quarterOf(o.event.period);
const inSample = (o: Scored) => o.event.filedOn < HELD_OUT_FROM;
const COHORTS: Cohorts<Tagged> = { of: cohortOf, label: "Quarters", inSample };
const filedOn = (o: Scored) => o.event.filedOn;

async function main() {
  if (values.clean) {
    rmSync(ROOT, { recursive: true, force: true });
    log(`deleted ${ROOT}`);
    return;
  }
  const all = windowLinks(await secText(PAGE, join(ROOT, "index.html"), 1));
  const from = values.from ?? "2016q1";
  const fromStart = all.find((w) => w.name === from)?.start;
  const toStart = values.to ? all.find((w) => w.name === values.to)?.start : all.at(-1)?.start;
  if (!fromStart || !toStart) throw new Error(`unknown window: ${!fromStart ? from : values.to} (see ${PAGE})`);
  const selected = all.filter((w) => w.start >= fromStart && w.start <= toStart);
  log(`${selected.length} windows, ${selected[0]!.name} to ${selected.at(-1)!.name}`);

  for (const w of selected) await extract(w);
  if (values.prune) {
    for (const w of selected) {
      const zip = join(ZIPS, `${w.name}_form13f.zip`);
      if (existsSync(join(DONE, w.name)) && existsSync(zip)) rmSync(zip);
    }
    log("pruned the extracted windows' zips");
  }
  if (values["extract-only"]) return;

  const names = new Set(selected.map((w) => w.name));
  const quarters = readdirSync(FILINGS)
    .filter((q) => /^\d{4}Q[1-4]$/.test(q) && readdirSync(join(FILINGS, q)).some((f) => names.has(f.replace(/\.json\.gz$/, ""))))
    .sort();
  const { events, sets, lags } = findEvents(quarters, names);
  writeFileSync(join(ROOT, "manager-sets.json"), JSON.stringify(sets));
  const summaries = selected.map((w) => JSON.parse(readFileSync(join(ROOT, "windows", `${w.name}.json`), "utf8")) as WindowSummary);
  writeFileSync(join(ROOT, "filers.json"), JSON.stringify([...new Set(summaries.flatMap((s) => s.filers))].sort()));

  const scoreable = events.filter((e) => e.filedOn >= SCORE_FROM);
  const cusips = [...new Set(scoreable.map((e) => e.cusip))].sort();
  const figi = await mapCusips(cusips, join(ROOT, "figi.json"));
  const ftd = await ftdSymbols();
  const tickers: Tickers = new Map(cusips.map((c) => [c, resolveTicker(figi.get(c), ftd.get(c))]));
  const symbols = [...new Set([...tickers.values()].filter((t) => t.ticker && !t.excluded).map((t) => t.ticker!))].sort();
  const sources = [...tickers.values()].reduce((m, t) => m.set(t.source ?? "unmapped", (m.get(t.source ?? "unmapped") ?? 0) + 1), new Map<string, number>());
  log(`fetching bars for ${symbols.length} symbols …`);
  const bars = await barsFor([...symbols, BENCHMARK]);
  const vti = bars.get(BENCHMARK) ?? [];

  const skips = new Map<string, number>();
  const scored = { filing: [] as Scored[], quarterEnd: [] as Scored[] };
  for (const e of scoreable) {
    const o = score(e, e.filedOn, tickers, bars, vti);
    if (typeof o === "string") skips.set(`${e.group}#${o}`, (skips.get(`${e.group}#${o}`) ?? 0) + 1);
    else scored.filing.push(o);
    const q = score(e, e.period, tickers, bars, vti);
    if (typeof q !== "string") scored.quarterEnd.push(q);
  }
  const groups = (rows: Scored[], group: Group): [string, Scored[]][] =>
    KINDS.map(([kind, label]): [string, Scored[]] => [label, rows.filter((o) => o.event.group === group && o.event.kind === kind)]).filter(([, r]) => r.length > 0);

  const ruleGroups = groups(scored.filing, "rule");
  const { table: promo, passed } = promotionTable(ruleGroups, COHORTS);
  const setSizes = Object.entries(sets).filter(([q]) => q >= "2017Q4");
  const byYear = new Map<string, number[]>();
  for (const [q, ciks] of setSizes) byYear.set(q.slice(0, 4), [...(byYear.get(q.slice(0, 4)) ?? []), ciks.length]);
  const skipLine = (group: Group) =>
    [...skips]
      .filter(([k]) => k.startsWith(`${group}#`))
      .map(([k, n]) => `${n.toLocaleString()} ${k.slice(group.length + 1)}`)
      .join(", ") || "none";
  const lagCost = KINDS.map(([kind, label]) => {
    const at = (rows: Scored[]) => cohortStats(rows.filter((o) => o.event.group === "rule" && o.event.kind === kind), cohortOf, 60);
    const f = at(scored.filing);
    const q = at(scored.quarterEnd);
    return f.cohorts ? `| ${label} | ${pct(q.mean)} | ${pct(f.mean)} | ${q.mean === null || f.mean === null ? "–" : pct(q.mean - f.mean)} |` : null;
  }).filter((l) => l !== null);

  const body = [
    `**Data:** ${selected.length} windows of SEC's Form 13F Data Sets (${selected[0]!.name} to ${selected.at(-1)!.name}): ${summaries.reduce((s, w) => s + w.originals, 0).toLocaleString()} original holdings reports, of which ${summaries.reduce((s, w) => s + w.kept, 0).toLocaleString()} were small enough to keep (${KEEP_POSITIONS} positions or fewer). Not scored: ${summaries.reduce((s, w) => s + w.amendments, 0).toLocaleString()} amendments and ${summaries.reduce((s, w) => s + w.late, 0).toLocaleString()} originals filed more than 120 days after their quarter. Units corrected (a filer that used the wrong unit for its era): ${summaries.reduce((s, w) => s + w.unitsCorrected, 0).toLocaleString()} filings.`,
    "",
    `**Concentrated managers per quarter** (30 or fewer positions, $1B or more, 4+ prior filings, the median position held 4+ quarters, related filers collapsed): ${[...byYear].map(([y, xs]) => `${y} ${Math.round(xs.reduce((s, x) => s + x, 0) / xs.length)}`).join(", ")}. Their median filing came ${median(lags) ?? "–"} days after the quarter's end.`,
    "",
    `**Scored** (filed ${SCORE_FROM} on): ${scored.filing.filter((o) => o.event.group === "rule").length.toLocaleString()} rule-based events and ${scored.filing.filter((o) => o.event.group === "named").length.toLocaleString()} named-list events. **Left out:** rule-based ${skipLine("rule")}; named list ${skipLine("named")}. CUSIPs were mapped to tickers by OpenFIGI (${sources.get("openfigi") ?? 0}) or, where it has no US listing, by SEC's fails-to-deliver data (${sources.get("fails data") ?? 0}); ${sources.get("unmapped") ?? 0} of ${cusips.length} stayed unmapped. "Unmapped" events are in those CUSIPs (mostly delisted, merged or renamed companies, and share classes the fails data can't name: the survivorship gap) and "stale bars" are symbols whose bars start long after the filing (the ticker belongs to a later listing).`,
    "",
    `Excess return = the stock's return minus VTI's over the same trading days, from the first close after the filing date. In-sample: filings before ${HELD_OUT_FROM}; held out: from it. A quarter is one cohort: its events' mean counts once, so the standard error is across quarters. 120- and 250-day windows overlap from one quarter to the next, so their standard errors understate the uncertainty.`,
    "",
    "## Promotion rule",
    "",
    "Fixed before any results: after a 0.2% round trip, the 60-day quarter-level mean beats VTI in-sample and held out, the in-sample mean is at least 2 standard errors above zero, and the in-sample 120-day mean doesn't reverse it. Only these six buckets are scored.",
    "",
    promo,
    "",
    passed.length ? `**Passes:** ${passed.join(", ")}.` : "**No bucket passes.**",
    "",
    "## Concentrated managers: by quarter",
    "",
    cohortTable(ruleGroups, COHORTS),
    "",
    "## Concentrated managers: by event",
    "",
    eventTable(ruleGroups),
    "",
    "### In-sample and held out (by event)",
    "",
    eventTable([...ruleGroups.map(([l, r]): [string, Scored[]] => [`${l}, in-sample`, r.filter(inSample)]), ...ruleGroups.map(([l, r]): [string, Scored[]] => [`${l}, held out`, r.filter((o) => !inSample(o))])]),
    "",
    "### Year by year (60-day mean, events)",
    "",
    yearTable(ruleGroups, filedOn),
    "",
    "## What the lag costs",
    "",
    "The same events entered at the first close after the quarter's end, which no one can trade on (the holdings aren't public yet), against entry after the filing. 60-day means, quarter level.",
    "",
    "| Bucket | Quarter-end entry | Filing entry | Lost to the lag |",
    "|---|---:|---:|---:|",
    ...lagCost,
    "",
    "## Named list (hindsight-biased: reported, never promoted)",
    "",
    `${[...new Set(Object.values(NAMED_MANAGERS))].join(" and ")}, every quarter, whatever the rule says.`,
    "",
    cohortTable(groups(scored.filing, "named"), COHORTS),
    "",
    eventTable(groups(scored.filing, "named")),
  ].join("\n");
  writeReport(values.report, "research:13f", body);
  if (values.events) {
    const header = ["group", "kind", "manager", "cik", "period", "filedOn", "cusip", "issuer", "ticker", "weight", "entry", "excess60"];
    const rows = scored.filing.map((o) => {
      const e = o.event;
      return [e.group, e.kind, e.manager, e.cik, e.period, e.filedOn, e.cusip, e.issuer, tickers.get(e.cusip)?.ticker ?? "", e.weight.toFixed(4), o.entryDate, o.excess[60]?.toFixed(4) ?? ""].join("\t");
    });
    writeFileSync(values.events, `${[header.join("\t"), ...rows].join("\n")}\n`);
    log(`wrote ${rows.length} events to ${values.events}`);
  }
}

main().catch((e) => {
  if (e instanceof SecRefused) {
    log(e.message);
    process.exit(2);
  }
  throw e;
});
