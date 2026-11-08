/**
 * The momentum backtest (#49, tasks/momentum-quality-plan.md): month-end
 * deciles by past return among the tradable stocks with cached bars, each
 * against VTI, in-sample (to 2023) and held out (2024 on). Offline: it reads
 * the bars research:insiders and research:earnings cached. Read-only.
 *
 *   npm run research:momentum -w @trader/core -- [--report docs/research/….md]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BENCHMARK } from "../src/broker/benchmark-closes.js";
import type { DailyBar, Horizon } from "../src/research/backtest.js";
import {
  type FormationRow,
  HELD_OUT_FROM,
  type MonthlyMean,
  SPECS,
  assignDeciles,
  formationRows,
  monthEnds,
  monthlyDecileMeans,
  period,
  seriesStats,
  topMinusBottom,
} from "../src/research/momentum.js";
import { CACHE, TRADABILITY, log, pct, writeReport } from "./research-common.js";

const { values } = parseArgs({ options: { report: { type: "string" } } });

/** The assumed round-trip cost in the promotion rule (fixed in the plan before any results). */
const ROUND_TRIP = 0.002;
const FROM = "2018-07-01";
const TO = "2026-05-31";

const symbols = readdirSync(join(CACHE, "bars"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .filter((s) => s !== BENCHMARK);
log(`${symbols.length} symbols with cached bars`);
// One symbol at a time: all of them at once would be millions of bars in memory.
const cached = (s: string): DailyBar[] =>
  (JSON.parse(readFileSync(join(CACHE, "bars", `${s}.json`), "utf8")) as [string, number, number][]).map(([date, close, volume]) => ({ date, close, volume }));
const vti = cached(BENCHMARK);
const dates = monthEnds(vti.map((b) => b.date), FROM, TO);
log(`${dates.length} month-end formations, ${dates[0]} to ${dates.at(-1)}`);

const stats = (series: MonthlyMean[], when: "in-sample" | "held-out", h: Horizon) => seriesStats(series.filter((m) => period(m.date) === when).map((m) => m.mean[h]));
const cell = (s: ReturnType<typeof seriesStats>, withSe = true) =>
  s.mean === null ? "–" : `${pct(s.mean, 2)}${withSe ? ` ± ${pct(s.stdError, 2).replace(/^[+−]/, "")}` : ""}`;
const share = (s: ReturnType<typeof seriesStats>) => (s.positiveShare === null ? "–" : `${Math.round(s.positiveShare * 100)}%`);

const sections: string[] = [
  `**Data:** ${symbols.length.toLocaleString()} symbols with cached Alpaca bars (mostly companies trading today, plus the insider-event names from #29); ${dates.length} month-end formations from ${dates[0]} to ${dates.at(-1)}. **In-sample:** formations before ${HELD_OUT_FROM}. **Held out:** from ${HELD_OUT_FROM}.`,
  "Each month-end, the stocks that pass risk's filters at the next close are ranked by the signal into deciles (10 = highest). A decile's result is the mean, over its stocks, of the return minus VTI's from the first close after formation. The statistics run over the **monthly series** of those means: the mean, its standard error, and the share of months the decile beat VTI. 60-day windows from consecutive months overlap, so their standard errors understate the uncertainty.",
  `**Promotion rule (fixed before any results):** the top decile's mean 20-day excess must beat VTI in-sample, and on the held-out months after a ${pct(ROUND_TRIP, 1).replace("+", "")} round-trip cost.`,
];

const rowsBySpec = new Map(SPECS.map((spec) => [spec, [] as FormationRow[]]));
for (const [n, s] of symbols.entries()) {
  if (n % 2000 === 0) log(`scoring: ${n}/${symbols.length}`);
  const b = cached(s);
  for (const spec of SPECS) rowsBySpec.get(spec)!.push(...formationRows(s, b, vti, dates, spec, TRADABILITY));
}

for (const spec of SPECS) {
  const rows = rowsBySpec.get(spec)!;
  const deciles = assignDeciles(rows);
  const means = monthlyDecileMeans(rows, deciles);
  const spread = topMinusBottom(means);
  log(`${spec.name}: ${rows.length.toLocaleString()} stock-months`);

  const top = means.filter((m) => m.decile === 10);
  const inTop = stats(top, "in-sample", 20);
  const outTop = stats(top, "held-out", 20);
  const passes = inTop.mean !== null && outTop.mean !== null && inTop.mean > 0 && outTop.mean - ROUND_TRIP > 0;

  const lines = [
    "| Decile | In-sample 20d ± SE | beat VTI (months) | In-sample 60d | Held-out 20d ± SE | beat VTI (months) | Held-out 60d |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (let d = 1; d <= 10; d++) {
    const series = means.filter((m) => m.decile === d);
    const i20 = stats(series, "in-sample", 20);
    const o20 = stats(series, "held-out", 20);
    lines.push(`| ${d}${d === 10 ? " (top)" : d === 1 ? " (bottom)" : ""} | ${cell(i20)} | ${share(i20)} | ${cell(stats(series, "in-sample", 60), false)} | ${cell(o20)} | ${share(o20)} | ${cell(stats(series, "held-out", 60), false)} |`);
  }
  const si = stats(spread, "in-sample", 20);
  const so = stats(spread, "held-out", 20);
  lines.push(`| Top minus bottom | ${cell(si)} | ${share(si)} | ${cell(stats(spread, "in-sample", 60), false)} | ${cell(so)} | ${share(so)} | ${cell(stats(spread, "held-out", 60), false)} |`);

  const years = [...new Set(top.map((m) => m.date.slice(0, 4)))].sort();
  const byYear = ["| Year | Top decile 20d (mean of months) | Top minus bottom 20d | Stocks per month |", "|---|---:|---:|---:|"];
  for (const y of years) {
    const t = seriesStats(top.filter((m) => m.date.startsWith(y)).map((m) => m.mean[20]));
    const sp = seriesStats(spread.filter((m) => m.date.startsWith(y)).map((m) => m.mean[20]));
    const n = Math.round(rows.filter((r) => r.date.startsWith(y)).length / Math.max(1, new Set(rows.filter((r) => r.date.startsWith(y)).map((r) => r.date)).size));
    byYear.push(`| ${y}${y >= HELD_OUT_FROM.slice(0, 4) ? " (held out)" : ""} | ${cell(t, false)} | ${cell(sp, false)} | ${n.toLocaleString()} |`);
  }

  sections.push(
    `## ${spec.name}`,
    `${rows.length.toLocaleString()} stock-months. **Promotion rule: ${passes ? "PASSES" : "fails"}** (top decile 20d: in-sample ${cell(inTop, false)}, held out ${cell(outTop, false)} before costs).`,
    lines.join("\n"),
    byYear.join("\n"),
  );
}

writeReport(values.report, "research:momentum", sections.join("\n\n"));
