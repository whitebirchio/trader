/**
 * The insider-buy backtest (#29, tasks/insider-backtest-plan.md): download
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { BrokerHttpError } from "../src/broker/port.js";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { SYMBOL } from "../src/portfolio/strategy.js";
import {
  BREAKDOWNS,
  type DailyBar,
  type EventOutcome,
  HORIZONS,
  type InsiderPurchase,
  type OutcomeSkip,
  breakdown,
  bucketStats,
  classifyRoutine,
  eventOutcome,
  groupEvents,
  parseTsv,
  purchasesFrom,
} from "../src/research/insider-backtest.js";
import { LIMITS } from "../src/risk/limits.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({ options: { quarters: { type: "string" }, report: { type: "string" } } });

const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");
// SEC asks automated clients to name themselves; requests stay well under its 10/second.
const USER_AGENT = "Trader research (owner: scott.schmalz@gmail.com)";
const INDEX = "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets";
const TABLES = ["SUBMISSION.tsv", "REPORTINGOWNER.tsv", "NONDERIV_TRANS.tsv"];
const BARS_FROM = new Date("2017-06-01T00:00:00Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function allQuarters(): string[] {
  const out: string[] = [];
  for (let y = 2018; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (y < 2026 || q <= 2) out.push(`${y}q${q}`);
  return out;
}

/** The zip links from SEC's index page (their folder differs by quarter). */
async function zipLinks(): Promise<Map<string, string>> {
  const html = await (await fetch(INDEX, { headers: { "user-agent": USER_AGENT } })).text();
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
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
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

const env = readRepoEnv();
// Years of bars per request: a longer timeout than the engine's.
const broker = new AlpacaBroker({ env: "staging", keyId: env.require("STAGING_ALPACA_KEY_ID"), secretKey: env.require("STAGING_ALPACA_SECRET_KEY"), timeoutMs: 60_000 });
const BATCH = 20;

/** Bars for each symbol from the cache, fetching the missing ones in batches. Symbols Alpaca has no bars for cache as []. */
async function barsFor(symbols: string[]): Promise<Map<string, DailyBar[]>> {
  const dir = join(CACHE, "bars");
  mkdirSync(dir, { recursive: true });
  const file = (s: string) => join(dir, `${s}.json`);
  const missing = symbols.filter((s) => !existsSync(file(s)));
  const end = new Date();
  const fetchBatch = async (batch: string[]): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const got = await broker.getDailyBars(batch, BARS_FROM, end);
        for (const s of batch) writeFileSync(file(s), JSON.stringify((got[s] ?? []).map((b) => [b.t.toISOString().slice(0, 10), Number(b.c), Number(b.v)])));
        return;
      } catch (e) {
        if (e instanceof BrokerHttpError && e.status === 429) {
          log("rate limited; waiting 60s");
          await sleep(60_000);
        } else if (e instanceof BrokerHttpError && e.status === 400 && batch.length > 1) {
          for (const s of batch) await fetchBatch([s]); // one bad symbol fails the batch
          return;
        } else if (e instanceof BrokerHttpError && e.status === 400) {
          writeFileSync(file(batch[0]!), "[]");
          return;
        } else if (e instanceof Error && e.name === "TimeoutError" && attempt < 3) {
          log(`timed out on ${batch.length} symbols; retrying`);
          await sleep(5_000);
        } else throw e;
      }
    }
  };
  for (let i = 0; i < missing.length; i += BATCH) {
    await fetchBatch(missing.slice(i, i + BATCH));
    if (i % (BATCH * 10) === 0) log(`bars: ${Math.min(i + BATCH, missing.length)}/${missing.length} fetched`);
    await sleep(350);
  }
  return new Map(symbols.map((s) => [s, (JSON.parse(readFileSync(file(s), "utf8")) as [string, number, number][]).map(([date, close, volume]) => ({ date, close, volume }))]));
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

const tradability = { minPrice: Number(LIMITS.minPrice), minAvgDollarVolume: Number(LIMITS.minAvgDollarVolume), avgDollarVolumeDays: LIMITS.avgDollarVolumeDays };
const scored: EventOutcome[] = [];
const skipped: OutcomeSkip[] = [];
for (const e of events) {
  const o = eventOutcome(e, bars.get(e.ticker) ?? [], bars.get(BENCHMARK)!, tradability);
  if ("skip" in o) skipped.push(o);
  else scored.push(o);
}
writeFileSync(join(CACHE, "insider-outcomes.json"), JSON.stringify(scored.map((o) => ({ ...o, event: { ...o.event, purchases: o.event.purchases.length } }))));

// --- the report --------------------------------------------------------------

const live = scored.filter((o) => BREAKDOWNS["Like the live strategy"]!(o) === "2+ insiders after a 20%+ drop");
const without2020 = (rows: EventOutcome[]) => rows.filter((o) => !o.entryDate.startsWith("2020"));
const pct = (x: number | null, dp = 1) => (x === null ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)}%`);
const count = (reason: OutcomeSkip["skip"]) => skipped.filter((s) => s.skip === reason).length;

function table(groups: Map<string, EventOutcome[]>): string {
  const lines = ["| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [label, rows] of groups) {
    const [s20, s60, s120] = HORIZONS.map((h) => bucketStats(rows, h));
    lines.push(`| ${label} | ${s60!.n} | ${pct(s20!.mean)} | ${pct(s60!.mean)} ± ${pct(s60!.stdError).replace(/^[+−]/, "")} | ${pct(s60!.median)} | ${s60!.beatShare === null ? "–" : `${Math.round(s60!.beatShare * 100)}%`} | ${pct(s120!.mean)} |`);
  }
  return lines.join("\n");
}

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
const body = sections.join("\n\n");
// A hand-written summary above this line survives a re-run; the tables below are regenerated.
const MARKER = "<!-- generated by npm run research:insiders: everything below is regenerated -->";
if (values.report) {
  mkdirSync(dirname(values.report), { recursive: true });
  const previous = existsSync(values.report) ? readFileSync(values.report, "utf8") : "";
  const head = previous.includes(MARKER) ? previous.slice(0, previous.indexOf(MARKER)) : "";
  writeFileSync(values.report, `${head}${MARKER}\n\n${body}\n`);
  log(`wrote ${values.report}`);
} else {
  console.log(body);
}
