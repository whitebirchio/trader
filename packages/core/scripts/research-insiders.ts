/**
 * The insider-buy backtest (#29, tasks/done/insider-backtest-plan.md): download
 * SEC's quarterly Insider Transactions Data Sets, fetch daily bars from
 * Alpaca (paper keys; market data only), and write the report. Read-only:
 * no database, no orders. Everything downloaded is cached under
 * packages/core/.cache/ (git-ignored), so a re-run is offline.
 *
 *   npm run research:insiders -w @trader/core -- [--quarters 2025q4[,2026q1]] [--report docs/research/….md]
 *
 * Without --quarters it runs 2018q1–2026q2. Without --report it prints the tables.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { SYMBOL } from "../src/portfolio/strategy.js";
import {
  BREAKDOWNS,
  type EventOutcome,
  type InsiderPurchase,
  type OutcomeSkip,
  breakdown,
  classifyRoutine,
  eventOutcome,
  groupEvents,
  parseTsv,
  purchasesFrom,
} from "../src/research/insider-backtest.js";
import { CACHE, SEC_USER_AGENT, TRADABILITY, barsFor, log, sleep, table, writeReport } from "./research-common.js";

const { values } = parseArgs({ options: { quarters: { type: "string" }, report: { type: "string" } } });

const INDEX = "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets";
const TABLES = ["SUBMISSION.tsv", "REPORTINGOWNER.tsv", "NONDERIV_TRANS.tsv"];

function allQuarters(): string[] {
  const out: string[] = [];
  for (let y = 2018; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (y < 2026 || q <= 2) out.push(`${y}q${q}`);
  return out;
}

/** The zip links from SEC's index page (their folder differs by quarter). */
async function zipLinks(): Promise<Map<string, string>> {
  const html = await (await fetch(INDEX, { headers: { "user-agent": SEC_USER_AGENT } })).text();
  const links = new Map<string, string>();
  for (const m of html.matchAll(/href="(\/files\/[^"]*\/(\d{4}q\d)_form345\.zip)"/g)) links.set(m[2]!, `https://www.sec.gov${m[1]}`);
  return links;
}

/** A quarter's three tables, downloading and unzipping into its own cache directory if needed. */
async function quarterTables(quarter: string, links: () => Promise<Map<string, string>>) {
  const dir = join(CACHE, "edgar", quarter);
  if (!TABLES.every((t) => existsSync(join(dir, t)))) {
    const zip = join(dir, `${quarter}_form345.zip`);
    if (!existsSync(zip)) {
      const url = (await links()).get(quarter);
      if (!url) throw new Error(`no data set listed for ${quarter}`);
      log(`downloading ${quarter} …`);
      const res = await fetch(url, { headers: { "user-agent": SEC_USER_AGENT } });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      await sleep(500);
    }
    // stdin closed: unzip (like curl) can otherwise sit waiting after it's done.
    execFileSync("unzip", ["-o", "-q", zip, ...TABLES, "-d", dir], { stdio: ["ignore", "inherit", "inherit"] });
  }
  const read = (t: string) => parseTsv(readFileSync(join(dir, t), "utf8"));
  return { submissions: read("SUBMISSION.tsv"), owners: read("REPORTINGOWNER.tsv"), transactions: read("NONDERIV_TRANS.tsv") };
}

// ---------------------------------------------------------------------------

const quarters = values.quarters ? values.quarters.split(",").map((q) => q.trim()) : allQuarters();
let links: Map<string, string> | null = null;
const lazyLinks = async () => (links ??= await zipLinks());

const purchases: InsiderPurchase[] = [];
for (const q of quarters) {
  const found = purchasesFrom(await quarterTables(q, lazyLinks));
  log(`${q}: ${found.length} purchases`);
  purchases.push(...found);
}
const historyFrom = purchases.reduce((min, p) => (p.filedOn < min ? p.filedOn : min), "9999");
const events = groupEvents(classifyRoutine(purchases, historyFrom));
const symbols = [...new Set(events.map((e) => e.ticker))].filter((s) => SYMBOL.test(s));
log(`${purchases.length} purchases → ${events.length} events in ${symbols.length} symbols; fetching bars`);
const bars = await barsFor([BENCHMARK, ...symbols]);

const scored: EventOutcome[] = [];
const skipped: OutcomeSkip[] = [];
for (const e of events) {
  const o = eventOutcome(e, bars.get(e.ticker) ?? [], bars.get(BENCHMARK)!, TRADABILITY);
  if ("skip" in o) skipped.push(o);
  else scored.push(o);
}
writeFileSync(join(CACHE, "insider-outcomes.json"), JSON.stringify(scored.map((o) => ({ ...o, event: { ...o.event, purchases: o.event.purchases.length } }))));

// --- the report --------------------------------------------------------------

const live = scored.filter((o) => BREAKDOWNS["Like the live strategy"]!(o) === "2+ insiders after a 20%+ drop");
const without2020 = (rows: EventOutcome[]) => rows.filter((o) => !o.entryDate.startsWith("2020"));
const count = (reason: OutcomeSkip["skip"]) => skipped.filter((s) => s.skip === reason).length;

const sections = [
  `**Data:** ${quarters[0]}–${quarters.at(-1)} (${quarters.length} quarters of SEC Insider Transactions Data Sets): ${purchases.length.toLocaleString()} purchase filings → ${events.length.toLocaleString()} events.`,
  `**Scored:** ${scored.length.toLocaleString()} events. **Left out:** ${count("no bars").toLocaleString()} with no Alpaca bars (delisted, merged or renamed: the survivorship gap), ${count("untradable").toLocaleString()} that failed risk's price/liquidity filters at entry, ${count("no entry").toLocaleString()} with no bar after the filing, ${count("no VTI")} without a VTI close.`,
  "Routine buyers (Cohen, Malloy & Pomorski 2012) bought the same issuer in the same calendar month in each of the two prior years; the rest are opportunistic. Classifying needs two years of history, so those breakdowns start in 2020.",
  "Excess return = the stock's return minus VTI's over the same trading days, from the first close after the last filing. Means are of per-event excess returns; SE is the standard error of the mean.",
  "## Overall",
  table(new Map([["All scored events", scored]])),
  ...Object.entries(BREAKDOWNS).flatMap(([name, label]) => [`## ${name}`, table(breakdown(scored, label))]),
  "## The live strategy, year by year",
  "2+ officers or directors buying after a 20%+ drop over the prior 60 trading days.",
  table(breakdown(live, BREAKDOWNS["Year of entry"]!)),
  "## Without 2020",
  "2020's crash and rebound dominate the averages, so the same figures without events entered in 2020:",
  table(new Map([["All scored events", without2020(scored)], ["2+ insiders after a 20%+ drop", without2020(live)]])),
];
writeReport(values.report, "research:insiders", sections.join("\n\n"));
