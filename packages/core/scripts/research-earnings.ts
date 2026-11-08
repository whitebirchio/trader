/**
 * The earnings-reaction backtest (tasks/done/earnings-backtest-plan.md): earnings
 * releases (8-K item 2.02) from SEC's per-company filing index, the market's
 * reaction against VTI, and the returns after it, with and without an insider
 * buy before. Read-only: no database, no orders. Downloads are cached under
 * packages/core/.cache/ (git-ignored); a re-run is offline.
 *
 *   npm run research:earnings -w @trader/core -- [--limit 50] [--report docs/research/….md]
 *
 * Needs the insider data sets cached by research:insiders (for the insider overlap).
 * --limit takes the first N companies, for a quick end-to-end check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { SYMBOL } from "../src/portfolio/strategy.js";
import { type EventOutcome, type OutcomeSkip, breakdown, outcomeAfter } from "../src/research/backtest.js";
import {
  EARNINGS_BREAKDOWNS,
  type EarningsEvent,
  type EarningsRelease,
  type FilingColumns,
  earningsReleases,
  insiderBought,
  reactionEvent,
} from "../src/research/earnings-backtest.js";
import { type InsiderPurchase, classifyRoutine, groupEvents, parseTsv, purchasesFrom } from "../src/research/insider-backtest.js";
import { CACHE, SEC_USER_AGENT, TRADABILITY, barsFor, log, sleep, table, writeReport } from "./research-common.js";

const { values } = parseArgs({ options: { limit: { type: "string" }, report: { type: "string" } } });

const FROM = "2018-01-01";
const TO = "2026-06-30";
const DIR = join(CACHE, "edgar-submissions");
mkdirSync(DIR, { recursive: true });

/** GET a JSON document from SEC, politely: ≤ about 4 requests/second, backing off on 403/429. Null on 404. */
async function secJson(url: string): Promise<unknown | null> {
  for (let attempt = 1; ; attempt++) {
    await sleep(250);
    const res = await fetch(url, { headers: { "user-agent": SEC_USER_AGENT, "accept-encoding": "gzip" }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if ((res.status === 403 || res.status === 429) && attempt < 4) {
      log(`SEC ${res.status} on ${url}; backing off ${attempt * 60}s`);
      await sleep(attempt * 60_000);
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

/** SEC's current ticker list, one ticker per company (the first listed), in Alpaca's form (BRK-B → BRK.B). */
async function companies(): Promise<{ cik: string; ticker: string }[]> {
  const file = join(DIR, "company_tickers.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(await secJson("https://www.sec.gov/files/company_tickers.json")));
  const rows = Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, { cik_str: number; ticker: string }>);
  const seen = new Set<string>();
  const out: { cik: string; ticker: string }[] = [];
  for (const r of rows) {
    const cik = String(r.cik_str).padStart(10, "0");
    const ticker = r.ticker.toUpperCase().replace("-", ".");
    if (seen.has(cik) || !SYMBOL.test(ticker)) continue;
    seen.add(cik);
    out.push({ cik, ticker });
  }
  return out;
}

/** A company's earnings releases from FROM on, from a compact cache or SEC's submissions JSON (and older pages when needed). */
async function releasesFor(cik: string): Promise<EarningsRelease[]> {
  const file = join(DIR, `CIK${cik}.releases.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as EarningsRelease[];
  const doc = (await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`)) as { filings: { recent: FilingColumns; files: { name: string; filingTo: string }[] } } | null;
  const releases: EarningsRelease[] = [];
  if (doc) {
    releases.push(...earningsReleases(doc.filings.recent));
    const oldest = doc.filings.recent.filingDate.at(-1) ?? "0000";
    if (oldest > FROM) {
      for (const page of doc.filings.files.filter((f) => f.filingTo >= FROM)) {
        const older = (await secJson(`https://data.sec.gov/submissions/${page.name}`)) as FilingColumns | null;
        if (older) releases.push(...earningsReleases(older));
      }
    }
  }
  const kept = releases.filter((r) => r.filedOn >= FROM).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  writeFileSync(file, JSON.stringify(kept));
  return kept;
}

/** Officer/director buy events from the insider data sets research:insiders cached. */
function insiderEvents() {
  const root = join(CACHE, "edgar");
  const quarters = existsSync(root) ? readdirSync(root).filter((q) => /^\d{4}q\d$/.test(q)).sort() : [];
  if (quarters.length === 0) throw new Error("no insider data sets cached: run research:insiders first");
  const purchases: InsiderPurchase[] = [];
  for (const q of quarters) {
    const read = (t: string) => parseTsv(readFileSync(join(root, q, t), "utf8"));
    purchases.push(...purchasesFrom({ submissions: read("SUBMISSION.tsv"), owners: read("REPORTINGOWNER.tsv"), transactions: read("NONDERIV_TRANS.tsv") }));
  }
  const historyFrom = purchases.reduce((min, p) => (p.filedOn < min ? p.filedOn : min), "9999");
  return groupEvents(classifyRoutine(purchases, historyFrom));
}

// ---------------------------------------------------------------------------

let list = await companies();
if (values.limit) list = list.slice(0, Number(values.limit));
log(`${list.length} companies in SEC's ticker list; fetching bars`);
const bars = await barsFor([BENCHMARK, ...list.map((c) => c.ticker)]);
const vti = bars.get(BENCHMARK)!;
const withBars = list.filter((c) => (bars.get(c.ticker) ?? []).some((b) => b.date >= FROM));
log(`${withBars.length} have Alpaca bars since ${FROM}; reading their filing indexes`);

const insiders = insiderEvents();
const insidersByTicker = new Map<string, typeof insiders>();
for (const e of insiders) {
  const list = insidersByTicker.get(e.ticker) ?? [];
  list.push(e);
  insidersByTicker.set(e.ticker, list);
}

let releaseCount = 0;
let noReaction = 0;
const scored: EventOutcome<EarningsEvent>[] = [];
const skipped: OutcomeSkip<EarningsEvent>[] = [];
for (const [n, c] of withBars.entries()) {
  if (n % 250 === 0) log(`filing indexes: ${n}/${withBars.length}`);
  const stock = bars.get(c.ticker)!;
  const seenDays = new Set<string>();
  for (const r of await releasesFor(c.cik)) {
    if (r.filedOn > TO) continue;
    releaseCount++;
    const base = reactionEvent(c.cik, c.ticker, r, stock, vti);
    if (!base || seenDays.has(base.reactionDate)) {
      if (!base) noReaction++;
      continue;
    }
    seenDays.add(base.reactionDate);
    const event: EarningsEvent = { ...base, insiderBefore: insiderBought(c.ticker, base.reactionDate, insidersByTicker.get(c.ticker) ?? []) };
    const o = outcomeAfter(event, event.reactionDate, stock, vti, TRADABILITY);
    if ("skip" in o) skipped.push(o);
    else scored.push(o);
  }
}
writeFileSync(join(CACHE, "earnings-outcomes.json"), JSON.stringify(scored));

// --- the report --------------------------------------------------------------

const count = (reason: OutcomeSkip<EarningsEvent>["skip"]) => skipped.filter((s) => s.skip === reason).length;
const without2020 = (rows: EventOutcome<EarningsEvent>[]) => rows.filter((o) => !o.entryDate.startsWith("2020"));
const reactionLabel = EARNINGS_BREAKDOWNS["Reaction vs VTI on the reaction day"]!;
const sections = [
  `**Data:** ${withBars.length.toLocaleString()} companies from SEC's current ticker list with Alpaca bars; ${releaseCount.toLocaleString()} earnings releases (8-K item 2.02) filed ${FROM} to ${TO}.`,
  `**Scored:** ${scored.length.toLocaleString()} releases. **Left out:** ${noReaction.toLocaleString()} without the bars around the reaction day, ${count("untradable").toLocaleString()} that failed risk's price/liquidity filters at entry, ${count("no entry").toLocaleString()} with no bar after the reaction day, ${count("no bars")} with no bars, ${count("no VTI")} without a VTI close. Companies that no longer trade aren't in SEC's current list at all (the survivorship gap).`,
  "Reaction = the stock's return minus VTI's on the first session that could trade on the release (the same day if accepted before 9:30 ET, else the next). Entry is the close of the session after the reaction day. Excess return = the stock's return minus VTI's from entry over the same trading days. Means are of per-release excess returns; SE is the standard error of the mean.",
  "## Overall",
  table(new Map([["All scored releases", scored]])),
  ...Object.entries(EARNINGS_BREAKDOWNS).flatMap(([name, label]) => [`## ${name}`, table(breakdown(scored, label))]),
  "## Reaction vs VTI, year by year (up 10%+ and down 10%+)",
  table(breakdown(scored.filter((o) => o.event.reaction >= 0.1), (o) => `Up 10%+, ${o.entryDate.slice(0, 4)}`)),
  table(breakdown(scored.filter((o) => o.event.reaction <= -0.1), (o) => `Down 10%+, ${o.entryDate.slice(0, 4)}`)),
  "## Without 2020",
  "The same reaction buckets without releases entered in 2020:",
  table(breakdown(without2020(scored), reactionLabel)),
];
writeReport(values.report, "research:earnings", sections.join("\n\n"));
