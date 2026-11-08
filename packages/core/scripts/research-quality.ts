/**
 * The quality/value backtest (#49, tasks/done/momentum-quality-plan.md): each
 * April, deciles by gross profitability, earnings yield, book-to-market and a
 * quality-plus-value combination, from SEC's XBRL frames, each against VTI,
 * in-sample (2019–2023 cohorts) and held out (2024 on). Reads the cached
 * frames and adjusted bars; fetches unadjusted April closes from Alpaca
 * (market data, paper keys) for market values, cached. Read-only.
 *
 *   npm run research:quality -w @trader/core -- [--report docs/research/….md]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import { SYMBOL } from "../src/portfolio/strategy.js";
import { type DailyBar, closeOnOrBefore, outcomeAt } from "../src/research/backtest.js";
import { type FormationRow, assignDeciles, monthlyDecileMeans, seriesStats, topMinusBottom } from "../src/research/momentum.js";
import { type FrameRow, type YearFrames, aprilFormation, frameRows, fundamentalsAt, percentileRanks, qualityMetrics, rawCloseNear } from "../src/research/quality.js";
import { CACHE, TRADABILITY, log, pct, sleep, writeReport } from "./research-common.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({ options: { report: { type: "string" } } });

const ROUND_TRIP = 0.002;
const HELD_OUT_FROM = 2024;
const COHORTS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const LONG = 250;
const METRICS = ["Gross profitability", "Earnings yield", "Book-to-market", "Quality + value (profitability and earnings-yield ranks)"] as const;
type Metric = (typeof METRICS)[number];

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

/** SEC's current tickers by CIK, in Alpaca's form (the survivorship gap: today's companies only). */
const tickerByCik = (() => {
  const rows = Object.values(JSON.parse(readFileSync(join(CACHE, "edgar-submissions", "company_tickers.json"), "utf8")) as Record<string, { cik_str: number; ticker: string }>);
  const m = new Map<number, string>();
  for (const r of rows) {
    const t = r.ticker.toUpperCase().replace("-", ".");
    if (!m.has(r.cik_str) && SYMBOL.test(t)) m.set(r.cik_str, t);
  }
  return m;
})();

const adjusted = (s: string): DailyBar[] | null => {
  const f = join(CACHE, "bars", `${s}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as [string, number, number][]).map(([date, close, volume]) => ({ date, close, volume })) : null;
};
const vti = adjusted(BENCHMARK)!;
const sessions = vti.map((b) => b.date);
const formations = new Map(COHORTS.map((y) => [y, aprilFormation(sessions, y)!]));

// --- unadjusted April closes (market value = shares × the price that day) -------
const RAW = join(CACHE, "raw-april-closes");
mkdirSync(RAW, { recursive: true });
const env = readRepoEnv();
async function fetchRawAprils(symbols: string[]): Promise<void> {
  const missing = symbols.filter((s) => !existsSync(join(RAW, `${s}.json`)));
  log(`unadjusted April closes: ${missing.length} of ${symbols.length} to fetch`);
  for (let i = 0; i < missing.length; i += 20) {
    const batch = missing.slice(i, i + 20);
    const kept: Record<string, [string, number][]> = Object.fromEntries(batch.map((s) => [s, []]));
    let token: string | null = null;
    for (;;) {
      const qs = new URLSearchParams({ symbols: batch.join(","), timeframe: "1Day", start: "2019-04-01T00:00:00Z", end: "2026-05-08T00:00:00Z", adjustment: "raw", feed: "sip", limit: "10000" });
      if (token) qs.set("page_token", token);
      const res = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${qs}`, {
        headers: { "APCA-API-KEY-ID": env.require("STAGING_ALPACA_KEY_ID"), "APCA-API-SECRET-KEY": env.require("STAGING_ALPACA_SECRET_KEY") },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) {
        await sleep(60_000);
        continue;
      }
      if (res.status === 400) break; // a bad symbol in the batch: those stay without raw closes
      if (!res.ok) throw new Error(`Alpaca bars: HTTP ${res.status}`);
      const page = (await res.json()) as { bars?: Record<string, { t: string; c: number }[]>; next_page_token: string | null };
      for (const [s, list] of Object.entries(page.bars ?? {})) {
        for (const b of list) if (b.t.slice(5, 7) === "04") kept[s]!.push([b.t.slice(0, 10), b.c]);
      }
      token = page.next_page_token;
      if (!token) break;
    }
    for (const s of batch) writeFileSync(join(RAW, `${s}.json`), JSON.stringify(kept[s]));
    if (i % 400 === 0) log(`unadjusted April closes: ${Math.min(i + 20, missing.length)}/${missing.length}`);
    await sleep(300);
  }
}
const rawBars = (s: string): DailyBar[] => {
  const f = join(RAW, `${s}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as [string, number][]).map(([date, close]) => ({ date, close, volume: 0 })) : [];
};

// --- score every cohort ------------------------------------------------------------
const fundamentalsByYear = new Map(COHORTS.map((y) => [y, fundamentalsAt(yearFrames(y - 1), formations.get(y)!)]));
const universe = [...new Set([...fundamentalsByYear.values()].flatMap((m) => [...m.keys()]).map((cik) => tickerByCik.get(cik)).filter((t): t is string => !!t && existsSync(join(CACHE, "bars", `${t}.json`))))];
await fetchRawAprils(universe);

const rows = new Map<Metric, FormationRow[]>(METRICS.map((m) => [m, []]));
const long = new Map<FormationRow, number | null>();
for (const y of COHORTS) {
  const formation = formations.get(y)!;
  const scored: { symbol: string; gp: number | null; ey: number | null; bm: number | null; excess: FormationRow["excess"]; excessLong: number | null }[] = [];
  for (const [cik, f] of fundamentalsByYear.get(y)!) {
    const symbol = tickerByCik.get(cik);
    const bars = symbol ? adjusted(symbol) : null;
    if (!symbol || !bars) continue;
    let i = -1;
    for (let k = bars.length - 1; k >= 0; k--) if (bars[k]!.date <= formation) { i = k; break; }
    if (i < 0 || Date.parse(`${formation}T00:00:00Z`) - Date.parse(`${bars[i]!.date}T00:00:00Z`) > 7 * 86_400_000) continue;
    const o = outcomeAt(null, bars, i + 1, vti, TRADABILITY);
    if ("skip" in o) continue;
    const m = qualityMetrics(f, rawCloseNear(rawBars(symbol), formation));
    const exit = bars[i + 1 + LONG];
    const vEntry = closeOnOrBefore(vti, bars[i + 1]!.date);
    const vExit = exit ? closeOnOrBefore(vti, exit.date) : undefined;
    const excessLong = exit && vEntry !== undefined && vExit !== undefined ? exit.close / bars[i + 1]!.close - vExit / vEntry : null;
    scored.push({ symbol, gp: m.grossProfitability, ey: m.earningsYield, bm: m.bookToMarket, excess: o.excess, excessLong });
  }
  const add = (metric: Metric, symbol: string, signal: number, s: (typeof scored)[number]) => {
    const r: FormationRow = { symbol, date: formation, signal, excess: s.excess };
    rows.get(metric)!.push(r);
    long.set(r, s.excessLong);
  };
  for (const s of scored) {
    if (s.gp !== null) add("Gross profitability", s.symbol, s.gp, s);
    if (s.ey !== null) add("Earnings yield", s.symbol, s.ey, s);
    if (s.bm !== null) add("Book-to-market", s.symbol, s.bm, s);
  }
  const both = scored.filter((s) => s.gp !== null && s.ey !== null);
  const gpRank = percentileRanks(both.map((s) => s.gp!));
  const eyRank = percentileRanks(both.map((s) => s.ey!));
  both.forEach((s, k) => add("Quality + value (profitability and earnings-yield ranks)", s.symbol, (gpRank[k]! + eyRank[k]!) / 2, s));
  log(`${y} (formation ${formation}): ${scored.length} tradable companies with fundamentals`);
}

// --- the report ------------------------------------------------------------------
const heldOut = (date: string) => Number(date.slice(0, 4)) >= HELD_OUT_FROM;
const cell = (s: ReturnType<typeof seriesStats>, se = false) => (s.mean === null ? "–" : `${pct(s.mean, 1)}${se ? ` ± ${pct(s.stdError, 1).replace(/^[+−]/, "")}` : ""}`);
const sections: string[] = [
  `**Data:** SEC XBRL frames for fiscal data years ${COHORTS[0]! - 1}–${COHORTS.at(-1)! - 1}, scored at the last session of each April (${[...formations.values()].join(", ")}). Companies are matched to SEC's *current* ticker list (the survivorship gap). Market value uses Alpaca's unadjusted April close. **In-sample:** the 2019–2023 cohorts. **Held out:** 2024 on (2026's year isn't complete).`,
  "A figure counts for a formation only if its period ended at least 75 days before (so a fiscal year ending after formation is left out). Frames take each figure from the latest filing that reports it, usually a later 10-K's comparative column with the same value; a genuine restatement can leak a revised figure. (A rule requiring the accession's filing year to be no later than the formation year was tried first and dropped before reading any results: it removed 75–86% of real figures, the comparatives, leaving 1–300 companies per cohort.) Each cohort ranks the tradable companies (risk's filters at the next close) into deciles (10 = highest metric). A decile's result is the mean excess over its companies, and the statistics run over the **cohorts**, so there are only 5 in-sample and 2–3 held-out observations: read the standard errors with that in mind.",
  `**Promotion rule (fixed before any results):** the top decile's mean ${LONG}-day excess must beat VTI in-sample, and in the held-out 2024–2025 cohorts after a ${pct(ROUND_TRIP, 1).replace("+", "")} round-trip cost.`,
];
for (const metric of METRICS) {
  const r = rows.get(metric)!;
  const deciles = assignDeciles(r);
  const means = monthlyDecileMeans(r, deciles);
  const spread = topMinusBottom(means);
  const longMean = (date: string, d: number) => {
    const xs = r.filter((x) => x.date === date && deciles.get(x) === d).map((x) => long.get(x)).filter((v): v is number => v !== null && v !== undefined);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const dates = [...new Set(r.map((x) => x.date))].sort();
  const longSeries = (d: number, held: boolean) => seriesStats(dates.filter((dt) => heldOut(dt) === held).map((dt) => longMean(dt, d)));
  const longSpread = (held: boolean) => seriesStats(dates.filter((dt) => heldOut(dt) === held).map((dt) => { const t = longMean(dt, 10); const b = longMean(dt, 1); return t !== null && b !== null ? t - b : null; }));
  const inTop = longSeries(10, false);
  const outTop = longSeries(10, true);
  const passes = inTop.mean !== null && outTop.mean !== null && inTop.mean > 0 && outTop.mean - ROUND_TRIP > 0;

  const lines = ["| Decile | In-sample 60d | In-sample 120d | In-sample 250d ± SE | Held-out 60d | Held-out 120d | Held-out 250d |", "|---|---:|---:|---:|---:|---:|---:|"];
  const short = (series: typeof means, held: boolean, h: 60 | 120) => seriesStats(series.filter((m) => heldOut(m.date) === held).map((m) => m.mean[h]));
  for (let d = 1; d <= 10; d++) {
    const s = means.filter((m) => m.decile === d);
    lines.push(`| ${d}${d === 10 ? " (top)" : d === 1 ? " (bottom)" : ""} | ${cell(short(s, false, 60))} | ${cell(short(s, false, 120))} | ${cell(longSeries(d, false), true)} | ${cell(short(s, true, 60))} | ${cell(short(s, true, 120))} | ${cell(longSeries(d, true))} |`);
  }
  lines.push(`| Top minus bottom | ${cell(short(spread, false, 60))} | ${cell(short(spread, false, 120))} | ${cell(longSpread(false), true)} | ${cell(short(spread, true, 60))} | ${cell(short(spread, true, 120))} | ${cell(longSpread(true))} |`);
  const byCohort = ["| Cohort | Companies | Top decile 250d | Bottom decile 250d | Top minus bottom 250d |", "|---|---:|---:|---:|---:|"];
  for (const dt of dates) {
    const t = longMean(dt, 10);
    const b = longMean(dt, 1);
    byCohort.push(`| ${dt.slice(0, 4)}${heldOut(dt) ? " (held out)" : ""} | ${r.filter((x) => x.date === dt).length.toLocaleString()} | ${t === null ? "–" : pct(t, 1)} | ${b === null ? "–" : pct(b, 1)} | ${t !== null && b !== null ? pct(t - b, 1) : "–"} |`);
  }
  sections.push(`## ${metric}`, `**Promotion rule: ${passes ? "PASSES" : "fails"}** (top decile ${LONG}d: in-sample ${cell(inTop)}, held out ${cell(outTop)} before costs).`, lines.join("\n"), byCohort.join("\n"));
}
writeReport(values.report, "research:quality", sections.join("\n\n"));
