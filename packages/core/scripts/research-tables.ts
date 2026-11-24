/**
 * Report tables and CUSIP mapping shared by the filing studies
 * (research:13f, research:13d): event-level and cohort-level tables, the
 * promotion verdicts, year by year, and OpenFIGI's mapping API, cached.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type CohortStats, type EventOutcome, LONG_HORIZONS, type LongHorizon, bucketStats, cohortStats, promotion } from "../src/research/backtest.js";
import { type Figi, parseFigi } from "../src/research/thirteen-f.js";
import { log, pct, sleep } from "./research-common.js";

export type Scored<E> = EventOutcome<E, LongHorizon>;
export type Groups<E> = [string, Scored<E>[]][];

export interface Cohorts<E> {
  /** The cohort an event belongs to: its quarter, its month. */
  of: (o: Scored<E>) => string;
  /** The column heading for a count of cohorts: "Quarters", "Months". */
  label: string;
  inSample: (o: Scored<E>) => boolean;
}

export const se = (x: number | null) => pct(x).replace(/^[+−]/, "");
export const share = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

export function eventTable<E>(groups: Groups<E>): string {
  const lines = ["| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean | 250d mean |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [label, rows] of groups) {
    const [s20, s60, s120, s250] = LONG_HORIZONS.map((h) => bucketStats(rows, h));
    lines.push(`| ${label} | ${s60!.n} | ${pct(s20!.mean)} | ${pct(s60!.mean)} ± ${se(s60!.stdError)} | ${pct(s60!.median)} | ${share(s60!.beatShare)} | ${pct(s120!.mean)} | ${pct(s250!.mean)} |`);
  }
  return lines.join("\n");
}

export function cohortTable<E>(groups: Groups<E>, cohorts: Cohorts<E>): string {
  const cell = (s: CohortStats) => `${pct(s.mean)} ± ${se(s.stdError)}`;
  const unit = cohorts.label.toLowerCase();
  const lines = [`| Bucket | ${cohorts.label} | 20d | 60d | 60d ${unit} beat VTI | 120d | 250d |`, "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [label, rows] of groups) {
    const [s20, s60, s120, s250] = LONG_HORIZONS.map((h) => cohortStats(rows, cohorts.of, h));
    lines.push(`| ${label} | ${s60!.cohorts} | ${cell(s20!)} | ${cell(s60!)} | ${share(s60!.beatShare)} | ${cell(s120!)} | ${cell(s250!)} |`);
  }
  return lines.join("\n");
}

export function promotionTable<E>(groups: Groups<E>, cohorts: Cohorts<E>): { table: string; passed: string[] } {
  const unit = cohorts.label.toLowerCase();
  const lines = [`| Bucket | In-sample 60d (${unit}) | Held-out 60d (${unit}) | In-sample 120d | Verdict |`, "|---|---:|---:|---:|---|"];
  const passed: string[] = [];
  for (const [label, rows] of groups) {
    const ins = rows.filter(cohorts.inSample);
    const out = rows.filter((o) => !cohorts.inSample(o));
    const x = { inSample60: cohortStats(ins, cohorts.of, 60), heldOut60: cohortStats(out, cohorts.of, 60), inSample120: cohortStats(ins, cohorts.of, 120) };
    const verdict = promotion(x);
    if (verdict.pass) passed.push(label);
    lines.push(
      `| ${label} | ${pct(x.inSample60.mean)} ± ${se(x.inSample60.stdError)} (${x.inSample60.cohorts}) | ${pct(x.heldOut60.mean)} ± ${se(x.heldOut60.stdError)} (${x.heldOut60.cohorts}) | ${pct(x.inSample120.mean)} | ${verdict.pass ? "**passes**" : `fails: ${verdict.failed.join(", ")}`} |`,
    );
  }
  return { table: lines.join("\n"), passed };
}

export function yearTable<E>(groups: Groups<E>, filedOn: (o: Scored<E>) => string): string {
  const years = [...new Set(groups.flatMap(([, rows]) => rows.map((o) => filedOn(o).slice(0, 4))))].sort();
  const lines = [`| Bucket | ${years.join(" | ")} |`, `|---|${years.map(() => "---:").join("|")}|`];
  for (const [label, rows] of groups) {
    const cells = years.map((y) => {
      const s = bucketStats(rows.filter((o) => filedOn(o).startsWith(y)), 60);
      return s.n ? `${pct(s.mean)} (${s.n})` : "–";
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

/** CUSIP → ticker through OpenFIGI's free mapping API (no key: 25 requests a minute, 10 jobs each), cached in `file`. */
export async function mapCusips(cusips: string[], file: string): Promise<Map<string, Figi>> {
  const cache: Record<string, Figi> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const missing = cusips.filter((c) => !(c in cache));
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch("https://api.openfigi.com/v3/mapping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch.map((c) => ({ idType: "ID_CUSIP", idValue: c }))),
      });
      if (res.status === 429 && attempt < 5) {
        log("OpenFIGI rate limit; waiting 60s");
        await sleep(60_000);
        continue;
      }
      if (!res.ok) throw new Error(`OpenFIGI: HTTP ${res.status}`);
      const results = (await res.json()) as Parameters<typeof parseFigi>[0][];
      batch.forEach((c, j) => {
        cache[c] = parseFigi(results[j] ?? {});
      });
      break;
    }
    if ((i / 10) % 25 === 0) {
      writeFileSync(file, JSON.stringify(cache));
      log(`OpenFIGI: ${Math.min(i + 10, missing.length)}/${missing.length} mapped`);
    }
    await sleep(2_500);
  }
  writeFileSync(file, JSON.stringify(cache));
  return new Map(cusips.map((c) => [c, cache[c]!]));
}
