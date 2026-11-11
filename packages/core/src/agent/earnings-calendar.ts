import { and, desc, eq, gte, inArray, lt, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { earningsCalendar } from "../db/schema.js";
import { marketDate } from "../time.js";

/**
 * Upcoming earnings dates (#30), so the routine decides on purpose whether to
 * hold, trim or wait through a report. The source is Alpha Vantage's earnings
 * calendar (Scott's choice, 2026-11-11): one request returns every US
 * company's reports for the next three months. The earnings-calendar job
 * stores a snapshot a day, and the tools read the latest one.
 */

export interface EarningsDate {
  symbol: string;
  reportDate: string;
  fiscalDateEnding: string | null;
  estimate: string | null;
  currency: string | null;
  timeOfDay: string | null;
}

export interface EarningsCalendarPort {
  /** Every scheduled report in the next three months. Throws if the source can't be read. */
  upcoming(): Promise<EarningsDate[]>;
}

/** How many daily snapshots the job keeps. */
export const KEEP_SNAPSHOTS_DAYS = 7;
/** A snapshot older than this is reported stale. */
export const STALE_AFTER_DAYS = 3;
/** Within this many calendar days, a held thesis is flagged earnings_soon. */
export const EARNINGS_SOON_DAYS = 7;

const DAY_MS = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** One CSV line, honouring double quotes (company names can hold commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const blank = (v: string | undefined) => (v === undefined || v === "" || v === "None" || v === "-" ? null : v.trim());

/**
 * Alpha Vantage's EARNINGS_CALENDAR CSV, read by header name so a reordered
 * or added column doesn't break it. Rows without a symbol or a real report
 * date are skipped. A JSON body (its rate-limit or bad-key notice) is an error.
 */
export function parseEarningsCsv(body: string): EarningsDate[] {
  const text = body.trim();
  if (text.startsWith("{")) {
    const note = (() => {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        return String(j.Information ?? j.Note ?? j["Error Message"] ?? "an unexpected JSON reply");
      } catch {
        return "an unreadable reply";
      }
    })();
    throw new Error(`Alpha Vantage returned no calendar: ${note}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iSymbol, iReport] = [col("symbol"), col("reportDate")];
  if (iSymbol < 0 || iReport < 0) throw new Error(`Alpha Vantage's calendar has no symbol or reportDate column (header: ${header.join(",")})`);
  const [iFiscal, iEstimate, iCurrency, iTime] = [col("fiscalDateEnding"), col("estimate"), col("currency"), col("timeOfTheDay")];
  const out: EarningsDate[] = [];
  for (const line of lines.slice(1)) {
    const v = splitCsvLine(line);
    const symbol = blank(v[iSymbol])?.toUpperCase();
    const reportDate = blank(v[iReport]);
    if (!symbol || !reportDate || !isoDate.test(reportDate)) continue;
    const fiscal = iFiscal >= 0 ? blank(v[iFiscal]) : null;
    const estimate = iEstimate >= 0 ? blank(v[iEstimate]) : null;
    out.push({
      symbol,
      reportDate,
      fiscalDateEnding: fiscal && isoDate.test(fiscal) ? fiscal : null,
      estimate: estimate && /^-?\d+(\.\d+)?$/.test(estimate) ? estimate : null,
      currency: iCurrency >= 0 ? blank(v[iCurrency]) : null,
      timeOfDay: iTime >= 0 ? blank(v[iTime]) : null,
    });
  }
  return out;
}

/** The calendar from Alpha Vantage. The key is sent only to Alpha Vantage, and never logged. */
export class AlphaVantageCalendar implements EarningsCalendarPort {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upcoming(): Promise<EarningsDate[]> {
    const url = new URL("https://www.alphavantage.co/query");
    url.search = new URLSearchParams({ function: "EARNINGS_CALENDAR", horizon: "3month", apikey: this.apiKey }).toString();
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpha Vantage's calendar failed: HTTP ${res.status}`);
    return parseEarningsCsv(await res.text());
  }
}

export type RefreshResult = { status: "refreshed"; fetchedOn: string; rows: number; pruned: number } | { status: "skipped"; reason: string };

/**
 * Store today's snapshot, once a day: a second call the same market date is a
 * no-op, so the job can run on every tick and spend one request a day (the
 * free tier allows 25). Keeps KEEP_SNAPSHOTS_DAYS of snapshots.
 */
export async function refreshEarningsCalendar(db: Db, port: EarningsCalendarPort, now: Date): Promise<RefreshResult> {
  const today = marketDate(now);
  const [have] = await db.select({ n: earningsCalendar.symbol }).from(earningsCalendar).where(eq(earningsCalendar.fetchedOn, today)).limit(1);
  if (have) return { status: "skipped", reason: `already fetched for ${today}` };
  const rows = await port.upcoming();
  if (rows.length === 0) throw new Error("Alpha Vantage's calendar was empty");
  const unique = new Map(rows.map((r) => [`${r.symbol}|${r.reportDate}`, r]));
  const values = [...unique.values()].map((r) => ({ fetchedOn: today, ...r }));
  for (let i = 0; i < values.length; i += 1000) await db.insert(earningsCalendar).values(values.slice(i, i + 1000)).onConflictDoNothing();
  const cutoff = marketDate(new Date(now.getTime() - KEEP_SNAPSHOTS_DAYS * DAY_MS));
  const pruned = await db.delete(earningsCalendar).where(lt(earningsCalendar.fetchedOn, cutoff)).returning({ s: earningsCalendar.symbol });
  return { status: "refreshed", fetchedOn: today, rows: values.length, pruned: pruned.length };
}

export interface NextEarnings {
  date: string;
  /** Calendar days from today's market date. */
  inDays: number;
  timeOfDay: string | null;
  estimate: string | null;
  fiscalDateEnding: string | null;
}

export interface CalendarView {
  /** When the snapshot read was fetched; null if there's none. */
  asOf: string | null;
  stale: boolean;
  /** Each symbol's next report on or after today, from the latest snapshot. A symbol it doesn't list has no date announced yet: the calendar covers three months, but a company appears once it announces its date, usually two to four weeks ahead. */
  next: Map<string, NextEarnings>;
}

/** The next earnings report of each symbol, from the latest snapshot. */
export async function nextEarnings(db: Db, symbols: string[], now: Date): Promise<CalendarView> {
  const today = marketDate(now);
  const [latest] = await db.select({ on: max(earningsCalendar.fetchedOn) }).from(earningsCalendar);
  const asOf = latest?.on ?? null;
  const next = new Map<string, NextEarnings>();
  if (!asOf || symbols.length === 0) return { asOf, stale: asOf === null || days(asOf, today) > STALE_AFTER_DAYS, next };
  const rows = await db
    .select()
    .from(earningsCalendar)
    .where(and(eq(earningsCalendar.fetchedOn, asOf), inArray(earningsCalendar.symbol, symbols), gte(earningsCalendar.reportDate, today)))
    .orderBy(desc(earningsCalendar.reportDate));
  for (const r of rows) {
    // Ordered latest first, so the last write per symbol is its soonest report.
    next.set(r.symbol, { date: r.reportDate, inDays: days(today, r.reportDate), timeOfDay: r.timeOfDay, estimate: r.estimate, fiscalDateEnding: r.fiscalDateEnding });
  }
  return { asOf, stale: days(asOf, today) > STALE_AFTER_DAYS, next };
}

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
