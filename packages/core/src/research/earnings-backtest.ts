import type { DailyBar, EventOutcome } from "./backtest.js";
import type { InsiderEvent } from "./insider-backtest.js";

/**
 * The earnings-reaction backtest (tasks/done/earnings-backtest-plan.md): earnings
 * releases (8-K item 2.02) from SEC's per-company filing index, the market's
 * reaction to each against VTI, and what happened after (via backtest.ts).
 * Pure: the script fetches and caches.
 */

/** The columnar filing list in SEC's submissions JSON (`filings.recent`, or an older page itself). */
export interface FilingColumns {
  accessionNumber: string[];
  filingDate: string[];
  acceptanceDateTime: string[];
  form: string[];
  items: string[];
}

/** One earnings release: an original 8-K reporting item 2.02, Results of Operations. */
export interface EarningsRelease {
  accession: string;
  filedOn: string;
  /** When EDGAR accepted it (UTC). */
  acceptedAt: string;
}

/** Earnings releases in a filing list. 8-K/A amendments restate a release, so they're left out. */
export function earningsReleases(columns: FilingColumns): EarningsRelease[] {
  const out: EarningsRelease[] = [];
  for (let i = 0; i < columns.form.length; i++) {
    if (columns.form[i] !== "8-K" || !(columns.items[i] ?? "").split(",").includes("2.02")) continue;
    out.push({ accession: columns.accessionNumber[i]!, filedOn: columns.filingDate[i]!, acceptedAt: columns.acceptanceDateTime[i]! });
  }
  return out.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
}

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** New York date and minutes after midnight of an instant. */
function newYork(iso: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(NY.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const OPEN_MINUTES = 9 * 60 + 30;

// VTI's closes by date, built once per series (every event reads the same one).
const byDate = new WeakMap<DailyBar[], Map<string, number>>();
function closesByDate(bars: DailyBar[]): Map<string, number> {
  let m = byDate.get(bars);
  if (!m) byDate.set(bars, (m = new Map(bars.map((b) => [b.date, b.close]))));
  return m;
}

export interface EarningsEvent {
  cik: string;
  ticker: string;
  release: EarningsRelease;
  /** The first session that could trade on the release. */
  reactionDate: string;
  /** The stock's return minus VTI's from the close before the reaction day to its close. */
  reaction: number;
  /** An officer or director bought in the 90 days before the reaction day. */
  insiderBefore: boolean;
}

/**
 * The reaction to a release: accepted before 9:30 ET, the market trades on it
 * that day (or the next session, on a weekend or holiday); later, the next
 * session. Null without the bars around it. `bars` and `vti` are ascending.
 */
export function reactionEvent(cik: string, ticker: string, release: EarningsRelease, bars: DailyBar[], vti: DailyBar[]): Omit<EarningsEvent, "insiderBefore"> | null {
  const ny = newYork(release.acceptedAt);
  const i = ny.minutes < OPEN_MINUTES ? bars.findIndex((b) => b.date >= ny.date) : bars.findIndex((b) => b.date > ny.date);
  if (i < 1) return null;
  const day = bars[i]!;
  const before = bars[i - 1]!;
  const closes = closesByDate(vti);
  const vtiDay = closes.get(day.date);
  const vtiBefore = closes.get(before.date);
  if (vtiDay === undefined || vtiBefore === undefined) return null;
  return { cik, ticker, release, reactionDate: day.date, reaction: day.close / before.close - 1 - (vtiDay / vtiBefore - 1) };
}

const DAY_MS = 86_400_000;

/** Whether an officer or director bought `ticker` within `days` before `date` (filed in that window). */
export function insiderBought(ticker: string, date: string, insiderEvents: InsiderEvent[], days = 90): boolean {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  return insiderEvents.some((e) => e.ticker === ticker && e.insider && e.lastFiled >= from && e.lastFiled <= date);
}

/** The report's reaction buckets, fixed in advance. */
export function reactionBucket(reaction: number): string {
  if (reaction <= -0.1) return "a. Down 10%+";
  if (reaction <= -0.05) return "b. Down 5–10%";
  if (reaction < 0) return "c. Down 0–5%";
  if (reaction < 0.05) return "d. Up 0–5%";
  if (reaction < 0.1) return "e. Up 5–10%";
  return "f. Up 10%+";
}

/** The buckets the report breaks results into (null: not in this breakdown). */
export const EARNINGS_BREAKDOWNS: Record<string, (o: EventOutcome<EarningsEvent>) => string | null> = {
  "Reaction vs VTI on the reaction day": (o) => reactionBucket(o.event.reaction),
  "An insider bought in the 90 days before": (o) => (o.event.insiderBefore ? "Yes" : "No"),
  "Up 5%+ on earnings, by prior insider buying": (o) => (o.event.reaction >= 0.05 ? (o.event.insiderBefore ? "Up 5%+, insider bought before" : "Up 5%+, no insider buy") : null),
  "Down 5%+ on earnings, by prior insider buying": (o) => (o.event.reaction <= -0.05 ? (o.event.insiderBefore ? "Down 5%+, insider bought before" : "Down 5%+, no insider buy") : null),
  "Year of entry": (o) => o.entryDate.slice(0, 4),
};
