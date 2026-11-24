/**
 * The 13D/13G backtest, Part 2 (#138, tasks/13f-backtest-plan.md): initial
 * Schedule 13D and 13G filings by investment managers (CIKs that file 13Fs),
 * from EDGAR's daily indexes, scored against VTI from the first close after
 * the filing, split by whether the filer was one of Part 1's concentrated
 * managers at the time. Read-only: no database, no orders.
 *
 *   npm run research:13d -w @trader/core -- [--from 2018-01] [--to 2026-10] [--report ../../docs/research/….md] [--events file.tsv] [--clean]
 *
 * Needs Part 1's cache (.cache/edgar13f: filers.json, manager-sets.json, and
 * figi.json and ftd-symbols.json for mapping): run research:13f first.
 * Everything else stays under packages/core/.cache/edgar13d/ (git-ignored):
 * - each day's index (about 1.2 MB) is fetched, reduced to its 13D/13G rows
 *   (days/YYYYMMDD.json) and never written whole;
 * - a filing's header (about 1.5 KB) only when the index can't tell the
 *   investor from the company: both file 13Fs, or it lists one (headers.json);
 * - a cover page only when it's needed, reduced to its fields (covers.json):
 *   every kept filing from Dec 2024 (small XML), and before that 13Ds,
 *   concentrated managers' 13Gs and any filing whose company has no ticker
 *   in SEC's company_tickers.json (the full submission, about 50–80 KB).
 * A re-run reuses all of it. --clean deletes .cache/edgar13d.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { type DailyBar, LONG_HORIZONS, outcomeAfter } from "../src/research/backtest.js";
import { HELD_OUT_FROM } from "../src/research/momentum.js";
import {
  type Cover,
  type Header,
  type OwnershipFiling,
  type Party,
  filingLagDays,
  latestPublicPeriod,
  ownershipFilings,
  padCik,
  parseCoverText,
  parseCoverXml,
  parseHeader,
  parseIndex,
  resolveFromHeader,
  resolveParties,
  sameGroup,
} from "../src/research/ownership-filings.js";
import { FUND_NAME, type FtdSymbol, resolveTicker } from "../src/research/thirteen-f.js";
import { CACHE, SecRefused, TRADABILITY, barsFor, inParallel, log, secGet, secText, writeReport } from "./research-common.js";
import { type Cohorts, type Groups, type Scored as ScoredOf, cohortTable, eventTable, mapCusips, median, promotionTable, yearTable } from "./research-tables.js";

const { values } = parseArgs({
  options: { from: { type: "string" }, to: { type: "string" }, report: { type: "string" }, events: { type: "string" }, clean: { type: "boolean" } },
});

const ROOT = join(CACHE, "edgar13d");
const DAYS = join(ROOT, "days");
const PART1 = join(CACHE, "edgar13f");
const ARCHIVES = "https://www.sec.gov/Archives/edgar";
/** Feb 5, 2024: the 13D deadline went from 10 days after crossing 5% to 5 business days. */
const DEADLINE_CHANGE = "2024-02-05";
const MAX_ENTRY_GAP_DAYS = 7;
/** Parallel SEC requests: latency overlaps while secFetch keeps the pace at 5 a second. */
const WORKERS = 6;

const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const accNoDashes = (acc: string) => acc.replace(/-/g, "");
const cikPath = (cik: string) => String(Number(cik));

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

/** Months from `from` to `to` (YYYY-MM), inclusive. */
function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym > to) return out;
    out.push(ym);
    if (++m === 13) {
      m = 1;
      y++;
    }
  }
}

/** The day-index file names (master.YYYYMMDD.idx) in a quarter's directory listing. */
async function quarterDays(year: number, q: number): Promise<string[]> {
  const now = new Date();
  const current = year === now.getUTCFullYear() && q === Math.ceil((now.getUTCMonth() + 1) / 3);
  const listing = await secText(`${ARCHIVES}/daily-index/${year}/QTR${q}/index.json`, join(ROOT, "daily-index", `${year}Q${q}.json`), current ? 1 : Number.POSITIVE_INFINITY);
  const items = (JSON.parse(listing) as { directory: { item: { name: string }[] } }).directory.item;
  return items.map((i) => i.name).filter((n) => /^master\.\d{8}\.idx$/.test(n));
}

/** One day's 13D/13G filings, from the cache or the index (reduced, never stored whole). */
async function dayFilings(year: number, q: number, name: string): Promise<OwnershipFiling[]> {
  const file = join(DAYS, name.replace(/^master\.(\d{8})\.idx$/, "$1.json"));
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as OwnershipFiling[];
  const filings = ownershipFilings(parseIndex(await secGet(`${ARCHIVES}/daily-index/${year}/QTR${q}/${name}`)));
  mkdirSync(DAYS, { recursive: true });
  writeFileSync(file, JSON.stringify(filings));
  return filings;
}

/** A cache of parsed SEC documents keyed by accession, saved every `every` additions. */
function store<T>(name: string, every = 100) {
  const file = join(ROOT, name);
  const cache = readJson<Record<string, T | null>>(file, {});
  let unsaved = 0;
  return {
    has: (k: string) => k in cache,
    get: (k: string) => cache[k] ?? null,
    set(k: string, v: T | null) {
      cache[k] = v;
      if (++unsaved >= every) this.save();
    },
    save() {
      writeFileSync(file, JSON.stringify(cache));
      unsaved = 0;
    },
  };
}

const headers = store<Header>("headers.json");
const covers = store<Cover>("covers.json");

async function headerFor(f: OwnershipFiling): Promise<Header | null> {
  if (headers.has(f.accession)) return headers.get(f.accession);
  const cik = cikPath(f.parties[0]!.cik);
  let header: Header | null = null;
  try {
    header = parseHeader(await secGet(`${ARCHIVES}/data/${cik}/${accNoDashes(f.accession)}/${f.accession}.hdr.sgml`));
  } catch (e) {
    if (e instanceof SecRefused) throw e;
  }
  headers.set(f.accession, header);
  return header;
}

async function coverFor(f: OwnershipFiling, cik: string): Promise<Cover | null> {
  if (covers.has(f.accession)) return covers.get(f.accession);
  let cover: Cover | null = null;
  try {
    cover = f.xml
      ? parseCoverXml(await secGet(`${ARCHIVES}/data/${cikPath(cik)}/${accNoDashes(f.accession)}/primary_doc.xml`))
      : parseCoverText(await secGet(`${ARCHIVES}/data/${cikPath(cik)}/${f.accession}.txt`));
  } catch (e) {
    if (e instanceof SecRefused) throw e;
  }
  covers.set(f.accession, cover);
  return cover;
}

interface Stake {
  accession: string;
  form: "13D" | "13G";
  filedOn: string;
  subject: Party;
  filers: Party[];
  concentrated: boolean;
  period: string;
  ticker: string | null;
  tickerSource: "company_tickers" | "openfigi" | "fails data" | null;
  fund: boolean;
  cover: Cover | null;
}

type Scored = ScoredOf<Stake>;
type Skip = "unmapped" | "fund or ETF" | "no bars" | "no entry" | "untradable" | "no VTI" | "stale bars";

function score(s: Stake, bars: Map<string, DailyBar[]>, vti: DailyBar[]): Scored | Skip {
  if (!s.ticker) return "unmapped";
  if (s.fund) return "fund or ETF";
  const o = outcomeAfter(s, s.filedOn, bars.get(s.ticker) ?? [], vti, TRADABILITY, LONG_HORIZONS);
  if ("skip" in o) return o.skip;
  return days(s.filedOn, o.entryDate) > MAX_ENTRY_GAP_DAYS ? "stale bars" : o;
}

const COHORTS: Cohorts<Stake> = { of: (o) => o.event.filedOn.slice(0, 7), label: "Months", inSample: (o) => o.event.filedOn < HELD_OUT_FROM };
const filedOnOf = (o: Scored) => o.event.filedOn;
const BUCKETS: [string, (s: Stake) => boolean][] = [
  ["13D, concentrated manager", (s) => s.form === "13D" && s.concentrated],
  ["13D, other manager", (s) => s.form === "13D" && !s.concentrated],
  ["13G, concentrated manager", (s) => s.form === "13G" && s.concentrated],
  ["13G, other manager", (s) => s.form === "13G" && !s.concentrated],
];

async function main() {
  if (values.clean) {
    rmSync(ROOT, { recursive: true, force: true });
    log(`deleted ${ROOT}`);
    return;
  }
  for (const f of ["filers.json", "manager-sets.json"]) if (!existsSync(join(PART1, f))) throw new Error(`${join(PART1, f)} is missing: run research:13f first (Part 1)`);
  const managers = new Set(readJson<string[]>(join(PART1, "filers.json"), []));
  const sets = new Map(Object.entries(readJson<Record<string, string[]>>(join(PART1, "manager-sets.json"), {})).map(([q, ciks]) => [q, new Set(ciks)]));

  const from = values.from ?? "2018-01";
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)).toISOString().slice(0, 7);
  const to = values.to ?? lastMonth;
  const span = months(from, to);
  log(`${span[0]} to ${span.at(-1)}: reading the daily indexes`);

  // 1. Every 13D/13G filing in the span, from the daily indexes.
  const filings: OwnershipFiling[] = [];
  const quarters = [...new Set(span.map((m) => `${m.slice(0, 4)}Q${Math.ceil(Number(m.slice(5)) / 3)}`))];
  for (const yq of quarters) {
    const [year, q] = [Number(yq.slice(0, 4)), Number(yq.slice(5))];
    const names = (await quarterDays(year, q)).filter((n) => span.includes(`${n.slice(7, 11)}-${n.slice(11, 13)}`));
    for (const n of names) filings.push(...(await dayFilings(year, q, n)));
    log(`${yq}: ${names.length} days, ${filings.length.toLocaleString()} filings so far`);
  }
  const initial = filings.filter((f) => !f.amendment);
  const amendments = { "13D": filings.filter((f) => f.amendment && f.form === "13D").length, "13G": filings.filter((f) => f.amendment && f.form === "13G").length };

  // 2. Investor vs company, and the ticker.
  const tickersJson = JSON.parse(await secText("https://www.sec.gov/files/company_tickers.json", join(ROOT, "company_tickers.json"), 7)) as Record<string, { cik_str: number; ticker: string; title: string }>;
  const tickerOf = new Map<string, string>();
  for (const t of Object.values(tickersJson)) if (!tickerOf.has(padCik(String(t.cik_str)))) tickerOf.set(padCik(String(t.cik_str)), t.ticker);

  // The index alone settles most filings; a header is fetched only when both parties file 13Fs, or the index lists one.
  // (No issuer check here: a company missing from company_tickers.json gets its cover fetched below, which names the issuer's CUSIP.)
  const status = new Map<string, number>();
  const count = (k: string) => status.set(k, (status.get(k) ?? 0) + 1);
  const first = initial.map((f) => ({ f, r: resolveParties(f, managers) }));
  const unclear = first.filter((x) => x.r.status === "needs header" && !headers.has(x.f.accession)).map((x) => x.f);
  log(`parties: ${unclear.length.toLocaleString()} headers to fetch`);
  await inParallel(unclear, WORKERS, async (f, i) => {
    await headerFor(f);
    if (i % 500 === 499) log(`headers: ${i + 1}/${unclear.length}`);
  });
  headers.save();
  const resolved: { f: OwnershipFiling; subject: Party; filers: Party[] }[] = [];
  for (const { f, r: fromIndex } of first) {
    let r: ReturnType<typeof resolveFromHeader> = fromIndex;
    if (r.status === "needs header") {
      const h = headers.get(f.accession);
      r = h ? resolveFromHeader(h, managers) : r;
    }
    if (r.status === "self") count("the company on itself");
    else if (r.status === "no manager") count("no 13F filer");
    else if (r.status === "needs header") count("parties unclear");
    else if (r.filers.some((p) => sameGroup(p.name, r.subject.name))) count("filer in the company's group");
    else resolved.push({ f, subject: r.subject, filers: r.filers });
  }

  const stakes: Stake[] = resolved.map(({ f, subject, filers }) => {
    const period = latestPublicPeriod(f.filedOn);
    const set = sets.get(period);
    const concentrated = set ? filers.some((p) => set.has(p.cik)) : false;
    const listed = tickerOf.get(subject.cik) ?? null;
    return { accession: f.accession, form: f.form, filedOn: f.filedOn, subject, filers, concentrated, period, ticker: listed, tickerSource: listed ? "company_tickers" : null, fund: FUND_NAME.test(subject.name), cover: null };
  });
  const byAccession = new Map(resolved.map(({ f }) => [f.accession, f]));
  const needCover = stakes.filter((s) => byAccession.get(s.accession)!.xml || s.form === "13D" || s.concentrated || !s.ticker);
  const toFetch = needCover.filter((s) => !covers.has(s.accession));
  log(`covers: ${needCover.length.toLocaleString()} needed, ${toFetch.length.toLocaleString()} to fetch`);
  await inParallel(toFetch, WORKERS, async (s, i) => {
    await coverFor(byAccession.get(s.accession)!, s.filers[0]!.cik);
    if (i % 1000 === 999) {
      covers.save();
      log(`covers: ${i + 1}/${toFetch.length}`);
    }
  });
  covers.save();
  for (const s of needCover) s.cover = covers.get(s.accession);

  // Companies without a current ticker: the cover's CUSIP through OpenFIGI, then SEC's fails data (Part 1's caches).
  const unmapped = stakes.filter((s) => !s.ticker && s.cover?.cusip);
  const cusips = [...new Set(unmapped.map((s) => s.cover!.cusip!))].sort();
  const figi = await mapCusips(cusips, join(ROOT, "figi.json"));
  const ftd = new Map(Object.entries(readJson<{ latest: Record<string, FtdSymbol> }>(join(PART1, "ftd-symbols.json"), { latest: {} }).latest));
  for (const s of unmapped) {
    const t = resolveTicker(figi.get(s.cover!.cusip!), ftd.get(s.cover!.cusip!));
    if (t.ticker) {
      s.ticker = t.ticker;
      s.tickerSource = t.source;
      s.fund ||= t.excluded;
    }
  }

  // 3. Score.
  const symbols = [...new Set(stakes.filter((s) => s.ticker && !s.fund).map((s) => s.ticker!))].sort();
  log(`fetching bars for ${symbols.length} symbols …`);
  const bars = await barsFor([...symbols, BENCHMARK]);
  const vti = bars.get(BENCHMARK) ?? [];
  const skips = new Map<string, number>();
  const scored: Scored[] = [];
  for (const s of stakes) {
    const o = score(s, bars, vti);
    if (typeof o === "string") skips.set(o, (skips.get(o) ?? 0) + 1);
    else scored.push(o);
  }

  // 4. Report.
  const groups: Groups<Stake> = BUCKETS.map(([label, keep]): [string, Scored[]] => [label, scored.filter((o) => keep(o.event))]);
  const { table: promo, passed } = promotionTable(groups, COHORTS);
  const pick = (label: string, keep: (o: Scored) => boolean): [string, Scored[]] => [label, scored.filter(keep)];
  const byStake = (["13D", "13G"] as const).flatMap((form) => [
    pick(`${form}, stake 5–10%`, (o) => o.event.form === form && o.event.cover?.percentOfClass != null && o.event.cover.percentOfClass < 10),
    pick(`${form}, stake 10%+`, (o) => o.event.form === form && o.event.cover?.percentOfClass != null && o.event.cover.percentOfClass >= 10),
    pick(`${form}, stake unknown`, (o) => o.event.form === form && o.event.cover?.percentOfClass == null),
  ]);
  const byPrior = (["13D", "13G"] as const).flatMap((form) => [
    pick(`${form}, after a 20%+ drop`, (o) => o.event.form === form && o.prior60 !== null && o.prior60 <= -0.2),
    pick(`${form}, no such drop`, (o) => o.event.form === form && o.prior60 !== null && o.prior60 > -0.2),
  ]);
  const switched = [pick("13D after the filer's 13G (passive turned active)", (o) => o.event.form === "13D" && o.event.cover?.fromThirteenG === true), pick("Other 13Ds", (o) => o.event.form === "13D" && o.event.cover?.fromThirteenG !== true)];
  const lagRows = (["13D", "13G"] as const).flatMap((form) =>
    [
      ["before", (s: Stake) => s.filedOn < DEADLINE_CHANGE],
      ["from", (s: Stake) => s.filedOn >= DEADLINE_CHANGE],
    ].map(([when, keep]) => {
      const lags = stakes
        .filter((s) => s.form === form && (keep as (s: Stake) => boolean)(s))
        .map((s) => filingLagDays(s.cover?.eventDate ?? null, s.filedOn))
        .filter((d): d is number => d !== null && d >= 0 && d < 400);
      const all = stakes.filter((s) => s.form === form && (keep as (s: Stake) => boolean)(s)).length;
      return `| ${form} | ${when} ${DEADLINE_CHANGE} | ${all.toLocaleString()} | ${lags.length.toLocaleString()} | ${median(lags) ?? "–"} |`;
    }),
  );
  const sources = stakes.reduce((m, s) => m.set(s.tickerSource ?? "unmapped", (m.get(s.tickerSource ?? "unmapped") ?? 0) + 1), new Map<string, number>());
  const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ") || "none";

  const body = [
    `**Data:** EDGAR's daily indexes, ${span[0]} to ${span.at(-1)}: ${filings.length.toLocaleString()} Schedule 13D and 13G filings, ${initial.length.toLocaleString()} of them initial (amendments, not scored: ${amendments["13D"].toLocaleString()} 13D, ${amendments["13G"].toLocaleString()} 13G). **Kept** ${stakes.length.toLocaleString()} initial filings by investment managers (a filer that also files 13Fs). **Dropped:** ${list(status)}.`,
    "",
    `**Concentrated** means a filer was in Part 1's concentrated-manager set (30 or fewer positions, $1B or more, 4+ prior filings, low turnover) for the latest quarter whose 13Fs were due by the filing date: ${stakes.filter((s) => s.concentrated).length.toLocaleString()} of the kept filings. Related filers were collapsed in Part 1, so a filing under a group's other CIK can be counted as not concentrated.`,
    "",
    `**Scored:** ${scored.length.toLocaleString()} filings. **Left out:** ${list(skips)}. Companies were mapped to tickers by SEC's company_tickers.json (${(sources.get("company_tickers") ?? 0).toLocaleString()}), or by the cover's CUSIP through OpenFIGI (${(sources.get("openfigi") ?? 0).toLocaleString()}) or SEC's fails-to-deliver data (${(sources.get("fails data") ?? 0).toLocaleString()}); ${(sources.get("unmapped") ?? 0).toLocaleString()} stayed unmapped (mostly delisted or merged companies: the survivorship gap).`,
    "",
    `Excess return = the stock's return minus VTI's over the same trading days, from the first close after the filing date. In-sample: filings before ${HELD_OUT_FROM}; held out: from it (after the 13D deadline change, so partly a new regime). A month is one cohort: its filings' mean counts once, so the standard error is across months. 120- and 250-day windows overlap from one month to the next, so their standard errors understate the uncertainty.`,
    "",
    "## Promotion rule",
    "",
    "Fixed before any results: after a 0.2% round trip, the 60-day month-level mean beats VTI in-sample and held out, the in-sample mean is at least 2 standard errors above zero, and the in-sample 120-day mean doesn't reverse it. Only these four buckets are scored.",
    "",
    promo,
    "",
    passed.length ? `**Passes:** ${passed.join(", ")}.` : "**No bucket passes.**",
    "",
    "## By month",
    "",
    cohortTable(groups, COHORTS),
    "",
    "## By filing",
    "",
    eventTable(groups),
    "",
    "### In-sample and held out (by filing)",
    "",
    eventTable([...groups.map(([l, r]): [string, Scored[]] => [`${l}, in-sample`, r.filter(COHORTS.inSample)]), ...groups.map(([l, r]): [string, Scored[]] => [`${l}, held out`, r.filter((o) => !COHORTS.inSample(o))])]),
    "",
    "### Year by year (60-day mean, filings)",
    "",
    yearTable(groups, filedOnOf),
    "",
    "## Breakdowns (descriptive, not promoted)",
    "",
    "Stake size from the cover page: structured from Dec 2024, read from the text cover before that (unknown where the cover wasn't fetched or couldn't be read).",
    "",
    eventTable(byStake),
    "",
    "The 60 trading days before entry:",
    "",
    eventTable(byPrior),
    "",
    "A 13D whose filer had reported the same stake on a 13G (the cover's box):",
    "",
    eventTable(switched),
    "",
    "## Filing lag",
    "",
    "Days from the event that requires the filing (the cover's date) to the filing. A 13D was due within 10 days before Feb 5, 2024 and 5 business days from it. An investment manager's 13G is often due 45 days after the quarter in which it crossed, so its lag is long by design.",
    "",
    "| Form | Filed | Filings | With an event date | Median days |",
    "|---|---|---:|---:|---:|",
    ...lagRows,
  ].join("\n");
  writeReport(values.report, "research:13d", body);

  if (values.events) {
    const header = ["accession", "form", "filedOn", "filer", "filerCik", "subject", "subjectCik", "ticker", "source", "concentrated", "percent", "eventDate", "fromThirteenG", "entry", "excess60", "url"];
    const rows = scored.map((o) => {
      const s = o.event;
      const url = `${ARCHIVES}/data/${cikPath(s.filers[0]!.cik)}/${accNoDashes(s.accession)}/`;
      return [s.accession, s.form, s.filedOn, s.filers.map((p) => p.name).join("; "), s.filers[0]!.cik, s.subject.name, s.subject.cik, s.ticker ?? "", s.tickerSource ?? "", s.concentrated ? "yes" : "no", s.cover?.percentOfClass ?? "", s.cover?.eventDate ?? "", s.cover?.fromThirteenG ?? "", o.entryDate, o.excess[60]?.toFixed(4) ?? "", url].join("\t");
    });
    writeFileSync(values.events, `${[header.join("\t"), ...rows].join("\n")}\n`);
    log(`wrote ${rows.length} filings to ${values.events}`);
  }
}

main().catch((e) => {
  headers.save();
  covers.save();
  if (e instanceof SecRefused) {
    log(e.message);
    process.exit(2);
  }
  throw e;
});
